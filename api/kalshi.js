const https = require("https")
const crypto = require("crypto")
const { applyGuard, cacheGet, cacheSet } = require("../lib/guard")

const REQUEST_TIMEOUT_MS = 10000
const MARKET_CACHE_TTL_MS = 15000

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

function isSafeParam(str) {
  return typeof str === "string" && /^[A-Za-z0-9_\-\.]+$/.test(str)
}

const KALSHI_HOSTS = [
  "trading-api.kalshi.com",     // main trading API (all markets)
  "api.elections.kalshi.com",   // legacy elections-specific endpoint
]

function kalshiRequest(hostname, apiPath, keyId, normalizedKey) {
  return new Promise((resolve, reject) => {
    const timestamp = Date.now().toString()
    const basePath = apiPath.split("?")[0]
    const msgString = timestamp + "GET" + basePath
    let signature
    try {
      signature = crypto.createSign("SHA256").update(msgString).sign(normalizedKey, "base64")
    } catch (err) {
      return reject(new Error("Failed to sign request"))
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

// Try market then event across all known Kalshi API hostnames.
async function kalshiLookup(ticker, keyId, normalizedKey) {
  const paths = [
    `/trade-api/v2/markets/${encodeURIComponent(ticker)}`,
    `/trade-api/v2/events/${encodeURIComponent(ticker)}?with_nested_markets=true`,
  ]
  for (const hostname of KALSHI_HOSTS) {
    for (const path of paths) {
      const r = await kalshiRequest(hostname, path, keyId, normalizedKey)
      if (r.status === 200) return r
    }
  }
  return null
}

module.exports = async (req, res) => {
  // Origin allowlist + rate limit: this route is signed with Predara's own
  // Kalshi key, so it must not serve as a free public API. See lib/guard.js.
  if (!applyGuard(req, res)) return

  res.setHeader("Content-Type", "application/json")

  const keyId = process.env.KALSHI_API_KEY_ID
  const privateKey = process.env.KALSHI_PRIVATE_KEY
  if (!keyId || !privateKey) {
    return res.status(503).json({ error: "Kalshi API credentials not configured. Add KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY to Vercel environment variables." })
  }

  const ticker = req.query.ticker
  if (!ticker || !isSafeParam(ticker)) {
    return res.status(400).json({ error: "Missing or invalid ticker" })
  }

  const normalizedKey = normalizePem(privateKey)

  // A market lookup fans out to four signed upstream calls. Prices move on the
  // order of seconds, so a short cache is invisible to the reader and cuts a
  // burst on a trending market down to one round trip.
  const cacheKey = "kalshi:" + ticker
  const hit = cacheGet(cacheKey)
  if (hit) return res.status(200).json(hit)

  try {
    const found = await kalshiLookup(ticker, keyId, normalizedKey)
    if (!found) {
      return res.status(404).json({ error: `Kalshi event or market "${ticker}" not found` })
    }
    let data
    try { data = JSON.parse(found.body) } catch {
      return res.status(502).json({ error: "Invalid response from Kalshi API" })
    }
    if (!data || typeof data !== "object" ||
        (!(data.market && data.market.ticker) && !(data.event && data.event.event_ticker))) {
      return res.status(502).json({ error: "Upstream returned an empty or invalid payload" })
    }

    // For event responses, supplement nested markets with a direct /markets?event_ticker
    // query so we capture all markets — including longer-duration ones added later —
    // regardless of any default pagination limit on with_nested_markets=true.
    if (data.event) {
      const eventTicker = data.event.event_ticker || ticker
      for (const hostname of KALSHI_HOSTS) {
        try {
          const mr = await kalshiRequest(
            hostname,
            `/trade-api/v2/markets?event_ticker=${encodeURIComponent(eventTicker)}&limit=200`,
            keyId,
            normalizedKey,
          )
          if (mr.status === 200) {
            const md = JSON.parse(mr.body)
            if (Array.isArray(md.markets) && md.markets.length > 0) {
              // Merge: keep all markets from the direct listing, but overlay any
              // richer nested-market data from with_nested_markets=true.
              const nested = new Map((data.event.markets || []).map(m => [m.ticker, m]))
              data.event.markets = md.markets.map(m => nested.get(m.ticker) || m)
            }
            break
          }
        } catch (_) { /* best-effort */ }
      }
    }

    // Enrich with active liquidity/volume incentive programs for this event's markets.
    // Best-effort: one list call (status=active), filtered client-side to our tickers —
    // avoids a per-market call regardless of how many markets the event has.
    try {
      const tickerSet = new Set([
        ...((data.event && data.event.markets) || []).map(m => m.ticker).filter(Boolean),
        ...(data.market ? [data.market.ticker] : []),
      ])
      if (tickerSet.size > 0) {
        for (const hostname of KALSHI_HOSTS) {
          const ir = await kalshiRequest(hostname, `/trade-api/v2/incentive_programs?status=active`, keyId, normalizedKey)
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

    // Enrich with series contract_url so the front-end can surface "View full rules"
    // series_ticker lives on market objects, not always on the event itself — fall back to first nested market
    const seriesTicker = (data.event || data.market || {}).series_ticker
      || (data.event?.markets?.[0] || {}).series_ticker
      || (data.event || data.market || {}).event_ticker
      || (data.event?.markets?.[0] || {}).event_ticker
    if (seriesTicker) {
      try {
        for (const hostname of KALSHI_HOSTS) {
          const sr = await kalshiRequest(
            hostname,
            `/trade-api/v2/series/${encodeURIComponent(seriesTicker)}`,
            keyId,
            normalizedKey,
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
        }
      } catch (_) { /* series fetch is best-effort */ }
    }

    cacheSet(cacheKey, data, MARKET_CACHE_TTL_MS)
    return res.status(200).json(data)
  } catch (err) {
    return res.status(502).json({ error: err.message })
  }
}
