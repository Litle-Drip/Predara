const http = require("http")
const https = require("https")
const crypto = require("crypto")
const fs = require("fs")
const path = require("path")
const url = require("url")
const gemini = require("./lib/gemini")
const { getGeminiPublic, geminiEventsToDiscoverCards } = require("./lib/gemini-public")

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
  "Access-Control-Allow-Headers": "Content-Type, x-anthropic-api-key",
}

// ── Bring-your-own Anthropic key ──
// The caller's own key via the x-anthropic-api-key header is the ONLY key this
// endpoint will ever use. Predara holds no Anthropic key of its own and reads no
// ANTHROPIC_API_KEY from the environment, so AI analysis is never billed to
// Predara. The key is used for that single request: never logged, never
// persisted, never echoed back.
const USER_KEY_HEADER = "x-anthropic-api-key"
const ANTHROPIC_KEY_RE = /^sk-ant-[A-Za-z0-9_-]{20,250}$/

function readUserApiKey(req) {
  const raw = req.headers ? req.headers[USER_KEY_HEADER] : ""
  const key = typeof raw === "string" ? raw.trim() : ""
  if (!key) return { key: "" }
  if (!ANTHROPIC_KEY_RE.test(key)) {
    return { key: "", error: 'That does not look like an Anthropic API key. Keys start with "sk-ant-".' }
  }
  return { key }
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

  // ── Gemini proxies (read-only) ──
  // Shared with the Vercel functions via lib/gemini.js — see api/gemini*.js.
  const geminiRoutes = {
    "/api/gemini":        (q) => gemini.getEvent(q.ticker, q.pageUrl),
    "/api/gemini-events": (q) => gemini.listEvents(q),
    "/api/gemini-strike": (q) => gemini.getEventStrike(q.ticker),
    "/api/gemini-combos": (q) => q.symbol ? gemini.getCombo(q.symbol) : gemini.listCombos(q),
    // One browsable entrypoint for the resources the UI picks by name (event
    // feeds, categories, volume, reward programs), cached in lib/gemini-public.
    "/api/gemini-markets": ({ resource, ...query }) =>
      getGeminiPublic(resource, query).then(({ status, json }) => ({ status, data: json })),
  }

  if (geminiRoutes[parsed.pathname]) {
    geminiRoutes[parsed.pathname](parsed.query)
      .then(({ status, data, error }) => {
        res.writeHead(status, { "Content-Type": "application/json", ...CORS_HEADERS })
        res.end(JSON.stringify(error ? { error } : data))
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

    const KALSHI_HOSTS = [
      "trading-api.kalshi.com",
      "api.elections.kalshi.com",
    ]

    function kalshiGet(hostname, apiPath) {
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
          hostname,
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

    async function kalshiLookup() {
      const paths = [
        `/trade-api/v2/markets/${encodeURIComponent(ticker)}`,
        `/trade-api/v2/events/${encodeURIComponent(ticker)}?with_nested_markets=true`,
      ]
      for (const hostname of KALSHI_HOSTS) {
        for (const p of paths) {
          const r = await kalshiGet(hostname, p)
          if (r.status === 200) return r
        }
      }
      return null
    }

    kalshiLookup()
      .then(async (found) => {
        if (!found) {
          res.writeHead(404, { "Content-Type": "application/json", ...CORS_HEADERS })
          return res.end(JSON.stringify({ error: `Kalshi event or market "${ticker}" not found` }))
        }
        let data
        try { data = JSON.parse(found.body) } catch (_) { data = null }
        if (!data || typeof data !== "object" ||
            (!(data.market && data.market.ticker) && !(data.event && data.event.event_ticker))) {
          res.writeHead(502, { "Content-Type": "application/json", ...CORS_HEADERS })
          return res.end(JSON.stringify({ error: "Upstream returned an empty or invalid payload" }))
        }

        // Enrich event responses: fetch full market listing to capture all markets
        if (data.event) {
          const eventTicker = data.event.event_ticker || ticker
          for (const hostname of KALSHI_HOSTS) {
            try {
              const mr = await kalshiGet(
                hostname,
                `/trade-api/v2/markets?event_ticker=${encodeURIComponent(eventTicker)}&limit=200`,
              )
              if (mr.status === 200) {
                const md = JSON.parse(mr.body)
                if (Array.isArray(md.markets) && md.markets.length > 0) {
                  const nested = new Map((data.event.markets || []).map(m => [m.ticker, m]))
                  data.event.markets = md.markets.map(m => nested.get(m.ticker) || m)
                }
                break
              }
            } catch (_) { /* best-effort */ }
          }
        }

        // Enrich with active liquidity/volume incentive programs for this event's markets.
        // Best-effort: one list call (status=active), filtered client-side to our tickers.
        try {
          const tickerSet = new Set([
            ...((data.event && data.event.markets) || []).map(m => m.ticker).filter(Boolean),
            ...(data.market ? [data.market.ticker] : []),
          ])
          if (tickerSet.size > 0) {
            for (const hostname of KALSHI_HOSTS) {
              const ir = await kalshiGet(hostname, `/trade-api/v2/incentive_programs?status=active`)
              if (ir.status === 200) {
                const idata = JSON.parse(ir.body)
                const programs = (Array.isArray(idata.incentive_programs) ? idata.incentive_programs : [])
                  .filter(p => tickerSet.has(p.market_ticker))
                if (programs.length > 0) {
                  if (data.event) data.event._incentive_programs = programs
                  if (data.market) data.market._incentive_programs = programs.filter(p => p.market_ticker === data.market.ticker)
                }
                break
              }
            }
          }
        } catch (_) { /* incentive programs are best-effort */ }

        // Enrich with series contract_url for "View full rules"
        const seriesTicker = (data.event || data.market || {}).series_ticker
          || ((data.event && data.event.markets && data.event.markets[0]) || {}).series_ticker
          || (data.event || data.market || {}).event_ticker
          || ((data.event && data.event.markets && data.event.markets[0]) || {}).event_ticker
        if (seriesTicker) {
          for (const hostname of KALSHI_HOSTS) {
            try {
              const sr = await kalshiGet(
                hostname,
                `/trade-api/v2/series/${encodeURIComponent(seriesTicker)}`,
              )
              if (sr.status === 200) {
                const sd = JSON.parse(sr.body)
                const contractUrl = (sd.series || {}).contract_url
                if (contractUrl) {
                  if (data.event) data.event._contract_url = contractUrl
                  if (data.market) data.market._contract_url = contractUrl
                }
                break
              }
            } catch (_) { /* series fetch is best-effort */ }
          }
        }

        res.writeHead(200, headers)
        res.end(JSON.stringify(data))
      })
      .catch((err) => {
        res.writeHead(502, { "Content-Type": "application/json", ...CORS_HEADERS })
        res.end(JSON.stringify({ error: err.message }))
      })

    return
  }

  // ── Kalshi live incentive programs (Rewards tab) ──
  // Lists all currently active liquidity/volume incentive programs, across every
  // market — not tied to a single ticker lookup like /api/kalshi above.
  if (parsed.pathname === "/api/kalshi-incentives") {
    const keyId = process.env.KALSHI_API_KEY_ID
    const privateKey = process.env.KALSHI_PRIVATE_KEY
    if (!keyId || !privateKey) {
      res.writeHead(503, { "Content-Type": "application/json", ...CORS_HEADERS })
      return res.end(JSON.stringify({ error: "Kalshi credentials not configured." }))
    }

    if (!_normalizedKey) _normalizedKey = normalizePem(privateKey)
    const normalizedKey = _normalizedKey
    const headers = { "Content-Type": "application/json", ...CORS_HEADERS }

    const KALSHI_HOSTS = [
      "trading-api.kalshi.com",
      "api.elections.kalshi.com",
    ]

    function kalshiGet(hostname, apiPath) {
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
          hostname,
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

    ;(async () => {
      try {
        for (const hostname of KALSHI_HOSTS) {
          const r = await kalshiGet(hostname, `/trade-api/v2/incentive_programs?status=active`)
          if (r.status === 200) {
            let data
            try { data = JSON.parse(r.body) } catch { continue }
            res.writeHead(200, headers)
            return res.end(JSON.stringify({ incentive_programs: Array.isArray(data.incentive_programs) ? data.incentive_programs : [] }))
          }
        }
        res.writeHead(502, { "Content-Type": "application/json", ...CORS_HEADERS })
        res.end(JSON.stringify({ error: "Kalshi incentive programs unavailable" }))
      } catch (err) {
        res.writeHead(502, { "Content-Type": "application/json", ...CORS_HEADERS })
        res.end(JSON.stringify({ error: err.message }))
      }
    })()

    return
  }

  // ── Discovery / trending markets ──
  if (parsed.pathname === "/api/discover") {
    const results = { platforms: [] }

    async function fetchPolymarketTrending() {
      try {
        const { status, body } = await httpsGetWithTimeout(
          "https://gamma-api.polymarket.com/events?active=true&closed=false&order=volume&ascending=false&limit=8",
          REQUEST_TIMEOUT_MS,
        )
        if (status !== 200) return []
        const events = JSON.parse(body)
        return (Array.isArray(events) ? events : []).map((e) => {
          const markets = e.markets || []
          const firstMarket = markets[0] || {}
          const outcomes = typeof firstMarket.outcomes === "string" ? JSON.parse(firstMarket.outcomes || "[]") : firstMarket.outcomes || []
          const prices = typeof firstMarket.outcomePrices === "string" ? JSON.parse(firstMarket.outcomePrices || "[]") : firstMarket.outcomePrices || []
          const topIdx = prices.length ? prices.reduce((best, p, i) => parseFloat(p) > parseFloat(prices[best]) ? i : best, 0) : -1
          return {
            title: e.title || firstMarket.question || "Untitled",
            url: `https://polymarket.com/event/${e.slug || ""}`,
            volume: e.volume ? Math.round(parseFloat(e.volume)).toLocaleString() : "",
            topOutcome: topIdx >= 0 && outcomes[topIdx] ? outcomes[topIdx] : "",
            topPct: topIdx >= 0 && prices[topIdx] ? Math.round(parseFloat(prices[topIdx]) * 100) : "",
          }
        })
      } catch { return [] }
    }

    async function fetchGeminiTrending() {
      try {
        const { status, json } = await getGeminiPublic("events", { status: "active", limit: "24" })
        if (status !== 200) return []
        return geminiEventsToDiscoverCards(json, 8)
      } catch { return [] }
    }

    Promise.allSettled([fetchPolymarketTrending(), fetchGeminiTrending()])
      .then(([polyResult, geminiResult]) => {
        const polyMarkets = polyResult.status === "fulfilled" ? polyResult.value : []
        const geminiMarkets = geminiResult.status === "fulfilled" ? geminiResult.value : []
        if (polyMarkets.length) results.platforms.push({ name: "polymarket", markets: polyMarkets })
        if (geminiMarkets.length) results.platforms.push({ name: "gemini", markets: geminiMarkets })
        res.writeHead(200, { "Content-Type": "application/json", ...CORS_HEADERS })
        res.end(JSON.stringify(results))
      })
      .catch(() => {
        res.writeHead(200, { "Content-Type": "application/json", ...CORS_HEADERS })
        res.end(JSON.stringify(results))
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
    // The caller's key is the only key. There is no server-side fallback.
    // A missing key is only fatal on the slow path, so it is not checked here —
    // API-confirmed settlements still resolve with no key at all.
    const userKey = readUserApiKey(req)
    if (userKey.error) {
      res.writeHead(400, { "Content-Type": "application/json", ...CORS_HEADERS })
      return res.end(JSON.stringify({ verdict: "error", summary: userKey.error, needsKey: true }))
    }
    const userApiKey = userKey.key

    let rawBody = ""
    req.on("data", chunk => { rawBody += chunk })
    req.on("end", async () => {
      const sendError = (summary) => {
        res.writeHead(200, { "Content-Type": "application/json", ...CORS_HEADERS })
        res.end(JSON.stringify({ verdict: "error", summary }))
      }
      const sendJson = (obj) => {
        res.writeHead(200, { "Content-Type": "application/json", ...CORS_HEADERS })
        res.end(JSON.stringify(obj))
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
        return res.end(JSON.stringify({ verdict: "error", summary: "No input provided. Paste a ticker or market URL from Gemini, Kalshi, Polymarket, or Coinbase." }))
      }

      // ── Platform detection ──
      const lower = input.toLowerCase()
      let platform = "gemini"
      if      (lower.includes("polymarket.com"))               platform = "polymarket"
      else if (lower.includes("predict.coinbase.com"))         platform = "coinbase-poly"
      else if (lower.includes("coinbase.com/predictions/event")) platform = "coinbase-kalshi"
      else if (lower.includes("coinbase.com"))                 platform = "coinbase-poly"
      else if (lower.includes("kalshi.com"))                   platform = "kalshi"
      else if (lower.includes("gemini.com"))                   platform = "gemini"
      else if (/^[a-z][a-z0-9-]{4,}$/.test(input))            platform = "polymarket"

      // ── Identifier extraction ──
      let identifier = input
      try {
        const u = new URL(input)
        const segs = u.pathname.split("/").filter(Boolean)
        identifier = segs[segs.length - 1] || input
      } catch {
        identifier = input.replace(/[_-](Y|N)$/i, "").trim()
      }

      if (!identifier || !isSafeParam(identifier)) {
        res.writeHead(400, { "Content-Type": "application/json", ...CORS_HEADERS })
        return res.end(JSON.stringify({ verdict: "error", summary: `Could not extract a valid identifier from: "${input.slice(0, 80)}"` }))
      }

      // ── Fetch event data & extract winners ──
      let winnersData
      try {
        if (platform === "kalshi" || platform === "coinbase-kalshi") {
          const keyId = process.env.KALSHI_API_KEY_ID
          const privateKey = process.env.KALSHI_PRIVATE_KEY
          if (!keyId || !privateKey) return sendError("Kalshi credentials not configured — cannot audit Kalshi/Coinbase markets on this server.")
          if (!_normalizedKey) _normalizedKey = normalizePem(privateKey)
          const nk = _normalizedKey

          const kalshiGet = (apiPath) => new Promise((resolve, reject) => {
            const basePath = apiPath.split("?")[0]
            const ts = Date.now().toString()
            let sig
            try { sig = crypto.createSign("SHA256").update(ts + "GET" + basePath).sign(nk, "base64") }
            catch (e) { return reject(e) }
            const r = https.request({
              hostname: "api.elections.kalshi.com", path: apiPath, method: "GET",
              headers: { "KALSHI-ACCESS-KEY": keyId, "KALSHI-ACCESS-TIMESTAMP": ts, "KALSHI-ACCESS-SIGNATURE": sig, "Content-Type": "application/json" },
            }, (apiRes) => {
              let body = ""
              apiRes.on("data", c => { body += c })
              apiRes.on("end", () => resolve({ status: apiRes.statusCode, body }))
            })
            r.setTimeout(REQUEST_TIMEOUT_MS, () => { r.destroy(); reject(new Error("Kalshi API timed out")) })
            r.on("error", reject).end()
          })

          const mktRes = await kalshiGet(`/trade-api/v2/markets/${encodeURIComponent(identifier)}`)
          let raw
          if (mktRes.status === 200) {
            raw = JSON.parse(mktRes.body)
          } else {
            const evtRes = await kalshiGet(`/trade-api/v2/events/${encodeURIComponent(identifier)}?with_nested_markets=true`)
            if (evtRes.status !== 200) return sendError(`Could not fetch Kalshi data for "${identifier}" (HTTP ${evtRes.status}).`)
            raw = JSON.parse(evtRes.body)
          }

          if (raw.market) {
            const m = raw.market
            const resolvedAt = m.close_time || ""
            const winners = m.result === "yes" ? [{ label: "Yes", resolvedAt }]
                          : m.result === "no"  ? [{ label: "No",  resolvedAt }] : []
            const losers  = m.result === "yes" ? [{ label: "No",  status: m.status || "" }]
                          : m.result === "no"  ? [{ label: "Yes", status: m.status || "" }] : []
            winnersData = { title: m.subtitle || m.title || identifier, ticker: m.event_ticker || identifier, status: m.status || "", resolvedAt, winners, losers, contracts: 2, platformName: "Kalshi" }
          } else if (raw.event) {
            const e = raw.event
            const markets = raw.markets || []
            const winners = markets.filter(m => m.result === "yes").map(m => ({ label: m.subtitle || m.title || m.ticker, resolvedAt: m.close_time || "" }))
            const losers  = markets.filter(m => m.result !== "yes").map(m => ({ label: m.subtitle || m.title || m.ticker, status: m.status || "" }))
            winnersData = { title: e.title || identifier, ticker: e.event_ticker || identifier, status: e.status || "", resolvedAt: e.close_time || "", winners, losers, contracts: markets.length, platformName: "Kalshi" }
          } else {
            return sendError("Kalshi API returned an unrecognized response shape.")
          }

        } else if (platform === "polymarket" || platform === "coinbase-poly") {
          const { status: pmStatus, body: pmBody } = await httpsGetWithTimeout(
            `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(identifier)}`,
            REQUEST_TIMEOUT_MS
          )
          if (pmStatus !== 200) return sendError(`Could not fetch Polymarket data for "${identifier}" (HTTP ${pmStatus}).`)
          const pmData = JSON.parse(pmBody)
          const event = Array.isArray(pmData) ? pmData[0] : pmData
          if (!event) return sendError(`No Polymarket event found for slug "${identifier}".`)

          const pmMarkets = event.markets || []
          const winners = [], losers = []
          for (const m of pmMarkets) {
            const outcomes = m.outcomes ? (typeof m.outcomes === "string" ? JSON.parse(m.outcomes) : m.outcomes) : []
            const prices   = m.outcomePrices ? (typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices) : []
            for (let i = 0; i < outcomes.length; i++) {
              const price = parseFloat(prices[i] || "0")
              if (price >= 0.99) winners.push({ label: outcomes[i], resolvedAt: m.endDate || event.endDate || "" })
              else if (m.closed) losers.push({ label: outcomes[i], status: "settled" })
            }
          }
          const totalOutcomes = pmMarkets.reduce((n, m) => {
            const o = m.outcomes ? (typeof m.outcomes === "string" ? JSON.parse(m.outcomes) : m.outcomes) : []
            return n + o.length
          }, 0)
          winnersData = { title: event.title || identifier, ticker: event.slug || identifier, status: event.closed ? "settled" : (event.active ? "active" : "unknown"), resolvedAt: event.endDate || "", winners, losers, contracts: totalOutcomes, platformName: "Polymarket" }

        } else {
          // Gemini (default)
          const { status: gemStatus, body: gemBody } = await httpsGetWithTimeout(
            `https://api.gemini.com/v1/prediction-markets/events/${encodeURIComponent(identifier)}`,
            REQUEST_TIMEOUT_MS
          )
          if (gemStatus !== 200) return sendError(`Could not fetch Gemini event data for "${identifier}" (HTTP ${gemStatus}). Verify the ticker is correct.`)
          const eventData = JSON.parse(gemBody)
          const contracts = Array.isArray(eventData.contracts) ? eventData.contracts : []
          const winners = contracts.filter(c => c.resolutionSide === "yes" || c.result === "yes")
            .map(c => ({ label: c.label || c.displayName || "", resolvedAt: c.resolvedAt || "" }))
          const losers  = contracts.filter(c => c.resolutionSide !== "yes" && c.result !== "yes")
            .map(c => ({ label: c.label || c.displayName || "", status: c.status || "" }))
          winnersData = { title: eventData.title || identifier, ticker: eventData.ticker || identifier, status: eventData.status || "", resolvedAt: eventData.resolvedAt || "", winners, losers, contracts: contracts.length, platformName: "Gemini" }
        }
      } catch (err) {
        return sendError(`Failed to fetch settlement data: ${err.message}`)
      }

      const { title, ticker, status, resolvedAt, winners, losers, contracts, platformName } = winnersData

      // ── Fast path: winner clearly identified by API — no Claude call needed ──
      if (winners.length > 0) {
        const winnerLabels = winners.map(w => w.label).filter(Boolean)
        const settledAt = winners[0]?.resolvedAt || resolvedAt || ""
        const settledDate = settledAt ? new Date(settledAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "unknown date"
        return sendJson({
          ticker, title, status,
          resolvedSide: winnerLabels.join(", "),
          verdict: "confirmed",
          summary: `${platformName}'s API confirms ${winnerLabels.join(" and ")} as the winner, settled on ${settledDate}. ${losers.length > 0 ? `All ${losers.length} other outcome${losers.length !== 1 ? "s" : ""} resolved against.` : ""} Settlement data is clean and unambiguous.`,
          keyFacts: [
            `Winner: ${winnerLabels.join(", ")}`,
            `Settlement timestamp: ${settledAt || "N/A"}`,
            `${winners.length} of ${contracts} outcome${contracts !== 1 ? "s" : ""} resolved YES`,
          ],
          recommendation: "No action needed. Settlement is confirmed directly by the platform's API data.",
        })
      }

      // ── Slow path: no clear winner in API data — ask Claude ──
      if (!userApiKey) {
        return sendJson({
          ticker, title, status,
          verdict: "error",
          needsKey: true,
          summary: "This market has no clear winner in the platform's API data, so it needs AI analysis. Add your Anthropic API key to continue — it stays in your browser and is billed to your own Anthropic account.",
          keyFacts: [],
          recommendation: "Open \u201cYour Anthropic API key\u201d and paste a key from console.anthropic.com.",
        })
      }

      const trimmed = { ticker, title, status, resolvedAt, platform: platformName, winners, losers, totalContracts: contracts }

      const systemPrompt = `You are a settlement auditor for prediction markets (Gemini, Kalshi, Polymarket, Coinbase). The API data contains no clear winner signal. Analyze the available data and use your knowledge of the real-world event to determine whether settlement appears correct.

Your final response must be a single raw JSON object — no markdown, no code fences, no commentary. First character must be { and last must be }. Schema:
{"ticker":string,"title":string,"status":string,"resolvedSide":string,"verdict":"confirmed"|"discrepancy"|"needs_review","summary":"2-3 sentence explanation of your finding","keyFacts":["short fact","short fact","short fact"],"recommendation":"1-2 sentences: what a support agent should do next"}

Use "confirmed" if settlement looks correct, "discrepancy" if something appears wrong, "needs_review" if data is truly insufficient.`

      let claudeText
      try {
        const { status: aiStatus, body: aiBody } = await httpsPostJson(
          "api.anthropic.com",
          "/v1/messages",
          { "x-api-key": userApiKey, "anthropic-version": "2023-06-01" },
          { model: "claude-haiku-4-5", max_tokens: 512, system: systemPrompt, messages: [{ role: "user", content: `Input: ${input}\n\nEvent data:\n${JSON.stringify(trimmed, null, 2)}` }] },
          20000
        )
        const aiJson = JSON.parse(aiBody)
        if (aiStatus === 401 || aiStatus === 403) {
          return sendJson({
            ticker, title, status,
            verdict: "error",
            needsKey: true,
            summary: "Anthropic rejected your API key (HTTP " + aiStatus + ") — it may be expired, revoked, or mistyped.",
            keyFacts: [],
            recommendation: "Check the key at console.anthropic.com, then paste a working one under \u201cYour Anthropic API key\u201d.",
          })
        }
        if (aiStatus === 429) {
          return sendJson({
            ticker, title, status,
            verdict: "error",
            needsKey: false,
            summary: "Your Anthropic account is rate limited or out of credit (HTTP 429). Check your plan and billing at console.anthropic.com, then try again.",
            keyFacts: [],
            recommendation: "Wait a moment and re-submit, or top up credit on your Anthropic account.",
          })
        }
        if (aiStatus !== 200) return sendError(`AI analysis failed: ${aiJson?.error?.message || "Anthropic API returned " + aiStatus}`)
        claudeText = aiJson?.content?.[0]?.text || ""
      } catch (err) {
        return sendError(`AI analysis failed: ${err.message}`)
      }

      const firstBrace = claudeText.indexOf("{")
      const lastBrace = claudeText.lastIndexOf("}")
      if (firstBrace === -1 || lastBrace <= firstBrace) return sendError("AI returned an unrecognized response format. Please try again.")

      let verdict
      try {
        verdict = JSON.parse(claudeText.slice(firstBrace, lastBrace + 1))
      } catch {
        return sendError("AI returned malformed JSON. Please try again.")
      }

      const VALID_VERDICTS = new Set(["confirmed", "discrepancy", "needs_review"])
      if (!VALID_VERDICTS.has(verdict.verdict)) verdict.verdict = "needs_review"
      if (!verdict.ticker) verdict.ticker = ticker
      if (!verdict.title) verdict.title = title || ticker
      if (!verdict.status) verdict.status = status || "unknown"
      if (!verdict.resolvedSide) verdict.resolvedSide = "unknown"
      if (!Array.isArray(verdict.keyFacts)) verdict.keyFacts = []
      if (!verdict.summary) verdict.summary = "No summary provided."
      if (!verdict.recommendation) verdict.recommendation = "Review manually."

      sendJson(verdict)
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
