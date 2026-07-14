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
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

function httpsPostJson(hostname, reqPath, extraHeaders, bodyObj, timeoutMs) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(bodyObj)
    const req = https.request({
      hostname,
      path: reqPath,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyStr),
        ...extraHeaders,
      },
    }, (apiRes) => {
      let body = ""
      apiRes.on("data", chunk => { body += chunk })
      apiRes.on("end", () => resolve({ status: apiRes.statusCode, body }))
    })
    req.setTimeout(timeoutMs || 15000, () => {
      req.destroy()
      reject(new Error("Request timed out"))
    })
    req.on("error", reject)
    req.write(bodyStr)
    req.end()
  })
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
        if (status === 200) {
          let parsed
          try { parsed = JSON.parse(body) } catch (_) { parsed = null }
          if (!Array.isArray(parsed) || parsed.length === 0) {
            res.writeHead(502, { "Content-Type": "application/json", ...CORS_HEADERS })
            return res.end(JSON.stringify({ error: "Upstream returned an empty or invalid payload" }))
          }
        }
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
        if (!data || typeof data !== "object" ||
            (!(Array.isArray(data.contracts) && data.contracts.length > 0) && !data.ticker && !data.title)) {
          res.writeHead(502, { "Content-Type": "application/json", ...CORS_HEADERS })
          return res.end(JSON.stringify({ error: "Upstream returned an empty or invalid payload" }))
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
          let parsed
          try { parsed = JSON.parse(r.body) } catch (_) { parsed = null }
          if (!parsed || typeof parsed !== "object" ||
              (!(parsed.market && parsed.market.ticker) && !(parsed.event && parsed.event.event_ticker))) {
            res.writeHead(502, { "Content-Type": "application/json", ...CORS_HEADERS })
            return res.end(JSON.stringify({ error: "Upstream returned an empty or invalid payload" }))
          }
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

  // ── MLB schedule proxy ──
  if (parsed.pathname === "/api/mlb") {
    const date = parsed.query.date
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.writeHead(400, { "Content-Type": "application/json", ...CORS_HEADERS })
      return res.end(JSON.stringify({ error: "date param required (YYYY-MM-DD)" }))
    }
    const [yr, mo, dy] = date.split("-")
    const target = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&hydrate=team&date=${mo}/${dy}/${yr}`
    httpsGetWithTimeout(target, REQUEST_TIMEOUT_MS)
      .then(({ status, body }) => {
        if (status !== 200) {
          res.writeHead(status, { "Content-Type": "application/json", ...CORS_HEADERS })
          return res.end(JSON.stringify({ error: `MLB API returned ${status}` }))
        }
        try {
          const data = JSON.parse(body)
          if (!data || typeof data !== "object" || !Array.isArray(data.dates)) {
            res.writeHead(502, { "Content-Type": "application/json", ...CORS_HEADERS })
            return res.end(JSON.stringify({ error: "MLB API returned an unexpected response shape" }))
          }
          const games = data.dates.flatMap(d => d.games || [])
          const toSlug = n => (n || "").toLowerCase().replace(/\s+/g, "-")
          const simplified = games.map(g => ({
            gamePk:   g.gamePk,
            awayAbbr: g.teams?.away?.team?.abbreviation || "",
            awaySlug: toSlug(g.teams?.away?.team?.teamName || g.teams?.away?.team?.name || ""),
            homeAbbr: g.teams?.home?.team?.abbreviation || "",
            homeSlug: toSlug(g.teams?.home?.team?.teamName || g.teams?.home?.team?.name || ""),
          }))
          res.writeHead(200, { "Content-Type": "application/json", ...CORS_HEADERS })
          res.end(JSON.stringify({ games: simplified }))
        } catch {
          res.writeHead(500, { "Content-Type": "application/json", ...CORS_HEADERS })
          res.end(JSON.stringify({ error: "Failed to parse MLB response" }))
        }
      })
      .catch(err => {
        res.writeHead(502, { "Content-Type": "application/json", ...CORS_HEADERS })
        res.end(JSON.stringify({ error: err.message }))
      })
    return
  }

  // ── Settlement review ──
  if (parsed.pathname === "/api/settlement-review" && req.method === "POST") {
    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
    if (!ANTHROPIC_API_KEY) {
      res.writeHead(503, { "Content-Type": "application/json", ...CORS_HEADERS })
      return res.end(JSON.stringify({ verdict: "error", summary: "Settlement review is not configured. Set the ANTHROPIC_API_KEY environment variable." }))
    }

    let rawBody = ""
    req.on("data", chunk => { rawBody += chunk })
    req.on("end", async () => {
      const sendError = (summary) => {
        res.writeHead(200, { "Content-Type": "application/json", ...CORS_HEADERS })
        res.end(JSON.stringify({ verdict: "error", summary }))
      }

      let input
      try {
        const parsed_body = JSON.parse(rawBody)
        input = (typeof parsed_body.input === "string" ? parsed_body.input : "").trim()
      } catch {
        res.writeHead(400, { "Content-Type": "application/json", ...CORS_HEADERS })
        return res.end(JSON.stringify({ verdict: "error", summary: "Invalid request body — expected JSON with an `input` field." }))
      }

      if (!input) {
        res.writeHead(400, { "Content-Type": "application/json", ...CORS_HEADERS })
        return res.end(JSON.stringify({ verdict: "error", summary: "No input provided. Paste a Gemini ticker, instrument symbol, or event URL." }))
      }

      // Extract event ticker from raw input
      let ticker = input
      try {
        const u = new URL(input)
        const segments = u.pathname.split("/").filter(Boolean)
        const predIdx = segments.indexOf("predictions")
        ticker = (predIdx !== -1 && segments[predIdx + 1])
          ? segments[predIdx + 1]
          : (segments[segments.length - 1] || input)
      } catch {
        // Not a URL — strip trailing instrument suffix (-Y / -N) to get event ticker
        ticker = input.replace(/[_-](Y|N)$/i, "").trim()
      }

      if (!ticker || !isSafeParam(ticker)) {
        res.writeHead(400, { "Content-Type": "application/json", ...CORS_HEADERS })
        return res.end(JSON.stringify({ verdict: "error", summary: `Could not extract a valid ticker from: "${input.slice(0, 80)}"` }))
      }

      // Fetch Gemini event data (same upstream as /api/gemini)
      let eventData
      try {
        const { status: gemStatus, body: gemBody } = await httpsGetWithTimeout(
          `https://api.gemini.com/v1/prediction-markets/events/${encodeURIComponent(ticker)}`,
          REQUEST_TIMEOUT_MS
        )
        if (gemStatus !== 200) {
          res.writeHead(200, { "Content-Type": "application/json", ...CORS_HEADERS })
          return res.end(JSON.stringify({ verdict: "error", summary: `Could not fetch event data for ticker "${ticker}" — Gemini API returned ${gemStatus}. Verify the ticker is correct.` }))
        }
        eventData = JSON.parse(gemBody)
      } catch (err) {
        return sendError(`Failed to fetch Gemini event data: ${err.message}`)
      }

      // Trim to minimal settlement fields only
      const contracts = Array.isArray(eventData.contracts) ? eventData.contracts : []

      // Separate winners from losers — only send winners in full to keep the
      // prompt lean even for large fields (e.g. MASTERS26 has 86 contracts).
      const trimContract = c => ({
        label: c.label || c.displayName || "",
        status: c.status || "",
        resolutionSide: c.resolutionSide || "",
        result: c.result || "",
        resolvedAt: c.resolvedAt || "",
        lastTradePrice: c.lastTradePrice != null ? c.lastTradePrice : (c.prices?.lastTradePrice ?? null),
      })
      const winners = contracts.filter(c => c.resolutionSide === "yes" || c.result === "yes")
      const losers  = contracts.filter(c => c.resolutionSide !== "yes" && c.result !== "yes")

      const trimmed = {
        ticker: eventData.ticker || ticker,
        title: eventData.title || "",
        status: eventData.status || "",
        resolvedSide: eventData.resolvedSide || "",
        resolvedAt: eventData.resolvedAt || "",
        totalContracts: contracts.length,
        winners: winners.map(trimContract),
        // For losers just include label + status so Claude has full picture without bloat
        losers: losers.map(c => ({ label: c.label || c.displayName || "", status: c.status || "" })),
      }

      // ── Fast path: winner clearly identified by API — no Claude call needed ──
      if (winners.length > 0) {
        const winnerLabels = winners.map(w => w.label).filter(Boolean)
        const settledAt = winners[0]?.resolvedAt || eventData.resolvedAt || ""
        const settledDate = settledAt ? new Date(settledAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "unknown date"
        const verdict = {
          ticker: trimmed.ticker,
          title: trimmed.title,
          status: trimmed.status,
          resolvedSide: winnerLabels.join(", "),
          verdict: "confirmed",
          summary: `Gemini's API confirms ${winnerLabels.join(" and ")} as the winner with resolutionSide set to "yes", settled on ${settledDate}. All ${losers.length} other contract${losers.length !== 1 ? "s" : ""} resolved to "no". Settlement data is clean and unambiguous.`,
          keyFacts: [
            `Winner: ${winnerLabels.join(", ")}`,
            `Settlement timestamp: ${settledAt || "N/A"}`,
            `${winners.length} of ${contracts.length} contracts resolved YES`,
          ],
          recommendation: "No action needed. Settlement is confirmed directly by Gemini's API data.",
        }
        res.writeHead(200, { "Content-Type": "application/json", ...CORS_HEADERS })
        return res.end(JSON.stringify(verdict))
      }

      // ── Slow path: no clear winner in API data — ask Claude ──
      const systemPrompt = `You are a settlement auditor for Gemini prediction markets. You receive structured event data from Gemini's API. The API contains no clear winner signal (no resolutionSide:"yes" or result:"yes" on any contract). Analyze the available data and use your knowledge of the underlying real-world event to determine whether settlement appears correct.

Your final response must be a single raw JSON object — no markdown, no code fences, no commentary. First character must be { and last must be }. Schema:
{"ticker":string,"title":string,"status":string,"resolvedSide":string,"verdict":"confirmed"|"discrepancy"|"needs_review","summary":"2-3 sentence explanation of your finding","keyFacts":["short fact","short fact","short fact"],"recommendation":"1-2 sentences: what a support agent should do next"}

Use "confirmed" if settlement looks correct, "discrepancy" if something appears wrong, "needs_review" if data is truly insufficient.`

      const userMessage = `Input: ${input}\n\nGemini event data:\n${JSON.stringify(trimmed, null, 2)}`

      let claudeText
      try {
        const { status: aiStatus, body: aiBody } = await httpsPostJson(
          "api.anthropic.com",
          "/v1/messages",
          { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
          { model: "claude-haiku-4-5", max_tokens: 512, system: systemPrompt, messages: [{ role: "user", content: userMessage }] },
          20000
        )
        const aiJson = JSON.parse(aiBody)
        if (aiStatus !== 200) {
          return sendError(`AI analysis failed: ${aiJson?.error?.message || "Anthropic API returned " + aiStatus}`)
        }
        claudeText = aiJson?.content?.[0]?.text || ""
      } catch (err) {
        return sendError(`AI analysis failed: ${err.message}`)
      }

      // Extract outermost {...} to guard against preamble text
      const firstBrace = claudeText.indexOf("{")
      const lastBrace = claudeText.lastIndexOf("}")
      if (firstBrace === -1 || lastBrace <= firstBrace) {
        return sendError("AI returned an unrecognized response format. Please try again.")
      }

      let verdict
      try {
        verdict = JSON.parse(claudeText.slice(firstBrace, lastBrace + 1))
      } catch {
        return sendError("AI returned malformed JSON. Please try again.")
      }

      // Validate and fill safe defaults for any missing required fields
      const VALID_VERDICTS = new Set(["confirmed", "discrepancy", "needs_review"])
      if (!VALID_VERDICTS.has(verdict.verdict)) verdict.verdict = "needs_review"
      if (!verdict.ticker) verdict.ticker = trimmed.ticker
      if (!verdict.title) verdict.title = trimmed.title || ticker
      if (!verdict.status) verdict.status = trimmed.status || "unknown"
      if (!verdict.resolvedSide) verdict.resolvedSide = trimmed.resolvedSide || "unknown"
      if (!Array.isArray(verdict.keyFacts)) verdict.keyFacts = []
      if (!verdict.summary) verdict.summary = "No summary provided."
      if (!verdict.recommendation) verdict.recommendation = "Review manually."

      res.writeHead(200, { "Content-Type": "application/json", ...CORS_HEADERS })
      res.end(JSON.stringify(verdict))
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
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("Warning: ANTHROPIC_API_KEY not set — /api/settlement-review will return errors until configured")
  }
})

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Please stop the other process and try again.`)
  } else {
    console.error("Server error:", err)
  }
  process.exit(1)
})
