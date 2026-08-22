// Real price history for the PRICE HISTORY chart.
// Thin HTTP shell — the fetching and normalization live in lib/history.js so
// server.js runs the same code path locally.

const { fetchPolymarketSeries, fetchKalshiSeries, normalizeWindow } = require("../lib/history")
const { makeSignedGet } = require("../lib/kalshi-auth")
const { corsHeadersFor, isAllowedOrigin, cached, rateLimit } = require("../lib/guard")

// History moves slowly relative to how often a page is opened, so a short cache
// absorbs most of the traffic without the chart ever looking stale.
const CACHE_TTL_MS = 60000

async function loadSeries(query) {
  const platform = String(query.platform || "")
  const windowKey = normalizeWindow(query.window)

  if (platform === "polymarket" || platform === "coinbase") {
    const points = await fetchPolymarketSeries(query.token, windowKey)
    return { source: "Polymarket CLOB", window: windowKey, points }
  }
  if (platform === "kalshi") {
    const signedGet = makeSignedGet()
    if (!signedGet) {
      const err = new Error("Kalshi credentials not configured")
      err.status = 503
      throw err
    }
    const points = await fetchKalshiSeries(signedGet, {
      seriesTicker: query.series,
      ticker: query.ticker,
      window: windowKey,
    })
    return { source: "Kalshi candlesticks", window: windowKey, points }
  }
  const err = new Error(`No public price history for platform "${platform}"`)
  err.status = 400
  throw err
}

module.exports = async (req, res) => {
  const origin = req.headers && req.headers.origin
  const headers = corsHeadersFor(origin)
  Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v))

  if (req.method === "OPTIONS") return res.status(204).end()
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" })
  if (!isAllowedOrigin(origin)) return res.status(403).json({ error: "Origin not allowed" })

  const limit = rateLimit(req)
  if (!limit.allowed) {
    res.setHeader("Retry-After", String(limit.retryAfter))
    return res.status(429).json({ error: "Rate limit exceeded. Try again shortly." })
  }

  res.setHeader("Content-Type", "application/json")

  const q = req.query || {}
  const key = ["hist", q.platform, q.token, q.series, q.ticker, normalizeWindow(q.window)].join("|")
  try {
    const { value } = await cached(key, CACHE_TTL_MS, () => loadSeries(q))
    return res.status(200).json(value)
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message })
  }
}
