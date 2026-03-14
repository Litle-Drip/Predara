const http = require("http")
const https = require("https")
const crypto = require("crypto")
const fs = require("fs")
const path = require("path")
const url = require("url")

const PORT = 3000
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

    const normalizedKey = privateKey.replace(/\\n/g, "\n")
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

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`)
})
