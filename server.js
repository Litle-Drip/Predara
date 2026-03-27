const http = require("http")
const https = require("https")
const crypto = require("crypto")
const fs = require("fs")
const path = require("path")
const url = require("url")

const PORT = process.env.PORT || 5000
const STATIC_ROOT = __dirname
const REQUEST_TIMEOUT_MS = 10000

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".webp": "image/webp",
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
}

function normalizePem(raw) {
  let pem = raw.replace(/\\n/g, "\n").trim()
  const headerMatch = pem.match(/-----BEGIN ([^-]+)-----/)
  const keyType = headerMatch ? headerMatch[1] : "RSA PRIVATE KEY"
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "")
  const body = b64.match(/.{1,64}/g).join("\n")
  return `-----BEGIN ${keyType}-----\n${body}\n-----END ${keyType}-----`
}

let _normalizedKey = null

// Only allow alphanumeric, hyphen, underscore, dot in tickers/slugs
function isSafeParam(str) {
  return typeof str === "string" && /^[A-Za-z0-9_\-\.]+$/.test(str)
}

function httpsGetWithTimeout(targetUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(targetUrl, (apiRes) => {
      let body = ""
      apiRes.on("data", (chunk) => { body += chunk })
      apiRes.on("end", () => resolve({ status: apiRes.statusCode, body }))
    })
    req.setTimeout(timeoutMs, () => {
      req.destroy()
      reject(new Error("Upstream request timed out"))
    })
    req.on("error", reject)
  })
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true)

  // Handle CORS preflight for all API routes
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS)
    return res.end()
  }

  // ── Polymarket proxy ──
  if (parsed.pathname === "/api/polymarket") {
    const slug = parsed.query.slug
    if (!slug || !isSafeParam(slug)) {
      res.writeHead(400, { "Content-Type": "application/json", ...CORS_HEADERS })
      return res.end(JSON.stringify({ error: "Missing or invalid slug" }))
    }

    const target = `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`

    httpsGetWithTimeout(target, REQUEST_TIMEOUT_MS)
      .then(({ status, body }) => {
        res.writeHead(status, { "Content-Type": "application/json", ...CORS_HEADERS })
        res.end(body)
      })
      .catch((err) => {
        res.writeHead(502, { "Content-Type": "application/json", ...CORS_HEADERS })
        res.end(JSON.stringify({ error: err.message }))
      })

    return
  }

  // ── Gemini proxy ──
  if (parsed.pathname === "/api/gemini") {
    const ticker  = parsed.query.ticker
    const pageUrl = parsed.query.pageUrl

    if (!ticker || !isSafeParam(ticker)) {
      res.writeHead(400, { "Content-Type": "application/json", ...CORS_HEADERS })
      return res.end(JSON.stringify({ error: "Missing or invalid ticker" }))
    }

    // Validate optional pageUrl (must be a gemini.com HTTPS URL)
    if (pageUrl) {
      try {
        const u = new URL(pageUrl)
        if (!((u.protocol === "https:" || u.protocol === "http:") && u.hostname.endsWith("gemini.com"))) {
          res.writeHead(400, { "Content-Type": "application/json", ...CORS_HEADERS })
          return res.end(JSON.stringify({ error: "Invalid pageUrl" }))
        }
      } catch {
        res.writeHead(400, { "Content-Type": "application/json", ...CORS_HEADERS })
        return res.end(JSON.stringify({ error: "Invalid pageUrl" }))
      }
    }

    const BUILDER_API_KEY = "1b77ce3a269a43e985e77f3d65f715ba"
    const target = `https://api.gemini.com/v1/prediction-markets/events/${encodeURIComponent(ticker)}`

    // Helper: walk Builder.io JSON tree and collect CDN asset URLs
    function collectBuilderAssets(node, results = []) {
      if (!node || typeof node !== "object") return results
      for (const [key, val] of Object.entries(node)) {
        if (typeof val === "string") {
          if ((key === "href" || key === "url" || key === "src") && val.includes("cdn.builder.io")) results.push(val)
          const embedded = val.match(/https:\/\/cdn\.builder\.io\/assets[^\s"'<>)\\]+/g)
          if (embedded) results.push(...embedded)
        } else if (Array.isArray(val)) {
          val.forEach(v => collectBuilderAssets(v, results))
        } else if (val && typeof val === "object") {
          collectBuilderAssets(val, results)
        }
      }
      return results
    }

    // Fetch Builder.io page content to find contract terms URL
    function fetchBuilderContractUrl(pUrl) {
      return new Promise((resolve) => {
        try {
          const parsedPage = new URL(pUrl)
          const apiUrl = `https://cdn.builder.io/api/v3/content/page?apiKey=${BUILDER_API_KEY}&url=${encodeURIComponent(parsedPage.pathname)}&limit=1&fields=data`
          httpsGetWithTimeout(apiUrl, REQUEST_TIMEOUT_MS)
            .then(({ status, body }) => {
              if (status !== 200) return resolve(null)
              try {
                const json = JSON.parse(body)
                const assets = collectBuilderAssets(json)
                resolve(assets.length ? assets[0] : null)
              } catch { resolve(null) }
            })
            .catch(() => resolve(null))
        } catch { resolve(null) }
      })
    }

    Promise.all([
      httpsGetWithTimeout(target, REQUEST_TIMEOUT_MS),
      pageUrl ? fetchBuilderContractUrl(pageUrl) : Promise.resolve(null),
    ])
      .then(([{ status, body }, contractUrl]) => {
        if (status !== 200) {
          if (status === 404) {
            res.writeHead(404, { "Content-Type": "application/json", ...CORS_HEADERS })
            return res.end(JSON.stringify({ error: `Ticker "${ticker}" not found on Gemini.` }))
          }
          res.writeHead(status, { "Content-Type": "application/json", ...CORS_HEADERS })
          return res.end(JSON.stringify({ error: `Gemini API returned ${status}` }))
        }
        let data
        try { data = JSON.parse(body) } catch {
          res.writeHead(502, { "Content-Type": "application/json", ...CORS_HEADERS })
          return res.end(JSON.stringify({ error: "Invalid response from Gemini API" }))
        }
        // Enrich with contract terms URL (same logic as api/gemini.js)
        function richTextToPlain(node) {
          if (!node) return ""
          if (typeof node === "string") return node
          if (node.value) return node.value
          if (Array.isArray(node.content)) return node.content.map(richTextToPlain).join("")
          return ""
        }
        function mdUrl(text) {
          const m = text && text.match(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/)
          return m ? m[2] : null
        }
        const contracts = Array.isArray(data && data.contracts) ? data.contracts : []
        const firstContract = contracts[0] || {}
        const descText = richTextToPlain(firstContract.description)
        const directTerms = (data && data.termsLink)
          || (firstContract.termsAndConditionsUrl || "")
          || mdUrl(descText)
          || null
        if (directTerms) data._contract_url = directTerms
        else if (contractUrl) data._contract_url = contractUrl

        res.writeHead(200, { "Content-Type": "application/json", ...CORS_HEADERS })
        res.end(JSON.stringify(data))
      })
      .catch((err) => {
        res.writeHead(502, { "Content-Type": "application/json", ...CORS_HEADERS })
        res.end(JSON.stringify({ error: err.message }))
      })

    return
  }

  // ── Kalshi proxy ──
  if (parsed.pathname === "/api/kalshi") {
    const keyId = process.env.KALSHI_API_KEY_ID
    const privateKey = process.env.KALSHI_PRIVATE_KEY
    if (!keyId || !privateKey) {
      res.writeHead(503, { "Content-Type": "application/json", ...CORS_HEADERS })
      return res.end(JSON.stringify({ error: "Kalshi credentials not configured. Set KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY." }))
    }

    const ticker = parsed.query.ticker
    if (!ticker || !isSafeParam(ticker)) {
      res.writeHead(400, { "Content-Type": "application/json", ...CORS_HEADERS })
      return res.end(JSON.stringify({ error: "Missing or invalid ticker" }))
    }

    if (!_normalizedKey) _normalizedKey = normalizePem(privateKey)
    const normalizedKey = _normalizedKey
    const headers = { "Content-Type": "application/json", ...CORS_HEADERS }

    function kalshiGet(apiPath) {
      return new Promise((resolve, reject) => {
        const basePath = apiPath.split("?")[0]
        const timestamp = Date.now().toString()
        const msgString = timestamp + "GET" + basePath
        let signature
        try {
          signature = crypto.createSign("SHA256").update(msgString).sign(normalizedKey, "base64")
        } catch (err) {
          return reject(err)
        }
        const req = https.request({
          hostname: "api.elections.kalshi.com",
          path: apiPath,
          method: "GET",
          headers: {
            "KALSHI-ACCESS-KEY": keyId,
            "KALSHI-ACCESS-TIMESTAMP": timestamp,
            "KALSHI-ACCESS-SIGNATURE": signature,
            "Content-Type": "application/json",
          },
        }, (apiRes) => {
          let body = ""
          apiRes.on("data", (chunk) => { body += chunk })
          apiRes.on("end", () => resolve({ status: apiRes.statusCode, body }))
        })
        req.setTimeout(REQUEST_TIMEOUT_MS, () => {
          req.destroy()
          reject(new Error("Kalshi API request timed out"))
        })
        req.on("error", reject).end()
      })
    }

    Promise.resolve()
      .then(() => kalshiGet(`/trade-api/v2/markets/${encodeURIComponent(ticker)}`))
      .then((r) => {
        if (r.status === 200) return r
        return kalshiGet(`/trade-api/v2/events/${encodeURIComponent(ticker)}?with_nested_markets=true`)
      })
      .then((r) => {
        if (r.status === 200) {
          res.writeHead(200, headers)
          res.end(r.body)
        } else {
          res.writeHead(r.status, headers)
          res.end(JSON.stringify({ error: `API returned ${r.status}` }))
        }
      })
      .catch((err) => {
        res.writeHead(502, { "Content-Type": "application/json", ...CORS_HEADERS })
        res.end(JSON.stringify({ error: err.message }))
      })

    return
  }

  // ── Static file server (path traversal safe) ──
  let reqPath = parsed.pathname === "/" ? "/index.html" : parsed.pathname
  const filePath = path.resolve(STATIC_ROOT, "." + reqPath)

  // Reject anything that escapes the static root
  if (!filePath.startsWith(STATIC_ROOT + path.sep) && filePath !== STATIC_ROOT) {
    res.writeHead(403, { "Content-Type": "text/plain" })
    return res.end("Forbidden")
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" })
      return res.end("Not found")
    }
    const ext = path.extname(filePath).toLowerCase()
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" })
    res.end(data)
  })
})

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running at http://0.0.0.0:${PORT}`)
})

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Please stop the other process and try again.`)
  } else {
    console.error("Server error:", err)
  }
  process.exit(1)
})
