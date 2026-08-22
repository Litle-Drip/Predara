// ── Real price history ────────────────────────────────────────────────────────
// Predara used to draw its "PRICE HISTORY" chart from localStorage snapshots
// taken whenever the user happened to have the page open, so the chart was a
// record of the reader's browsing rather than of the market. Both Kalshi and
// Polymarket publish real time series; this module fetches and normalizes them.
//
// Everything here is transport + normalization only, so `server.js` and the
// Vercel function in `api/` run identical code.

const https = require("https")

const REQUEST_TIMEOUT_MS = 10000
const POLYMARKET_CLOB_HOST = "clob.polymarket.com"

// Kalshi candlestick period, in minutes. The API accepts 1, 60 and 1440; asking
// for a finer grain than the window needs just returns thousands of points.
const KALSHI_PERIODS = { "1d": 60, "1w": 60, "1m": 1440, "all": 1440 }
const WINDOW_SECONDS = { "1d": 86400, "1w": 604800, "1m": 2592000, "all": 31536000 }

function normalizeWindow(w) {
  return Object.prototype.hasOwnProperty.call(WINDOW_SECONDS, w) ? w : "1w"
}

function httpsGetJson(targetUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(targetUrl, (res) => {
      let body = ""
      res.on("data", (c) => { body += c })
      res.on("end", () => {
        let parsed = null
        try { parsed = JSON.parse(body) } catch { /* upstream sent non-JSON */ }
        resolve({ status: res.statusCode, data: parsed })
      })
    })
    req.setTimeout(timeoutMs || REQUEST_TIMEOUT_MS, () => {
      req.destroy()
      reject(new Error("Upstream request timed out"))
    })
    req.on("error", reject)
  })
}

// ── Polymarket ────────────────────────────────────────────────────────────────
// GET /prices-history?market=<clobTokenId> returns [{ t: unixSeconds, p: 0..1 }]
// for the YES token. The price IS the probability, so no conversion is needed.
async function fetchPolymarketSeries(tokenId, windowKey) {
  if (!/^[0-9]+$/.test(String(tokenId || ""))) throw new Error("Invalid Polymarket token id")
  const w = normalizeWindow(windowKey)
  const endTs = Math.floor(Date.now() / 1000)
  const startTs = endTs - WINDOW_SECONDS[w]
  const fidelity = w === "1d" ? 5 : w === "1w" ? 60 : 1440
  const target = `https://${POLYMARKET_CLOB_HOST}/prices-history`
    + `?market=${encodeURIComponent(tokenId)}`
    + `&startTs=${startTs}&endTs=${endTs}&fidelity=${fidelity}`
  const { status, data } = await httpsGetJson(target)
  if (status !== 200 || !data) throw new Error(`Polymarket price history unavailable (${status})`)
  const raw = Array.isArray(data.history) ? data.history : []
  const points = raw
    .map((p) => ({ t: Number(p.t) * 1000, pct: Math.round(Number(p.p) * 1000) / 10 }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.pct))
  return points
}

// ── Kalshi ────────────────────────────────────────────────────────────────────
// Candlesticks are authenticated, so the caller injects a signed GET rather than
// this module reimplementing request signing a third time.
//
// Prices come back in CENTS. `price.close` is the last trade and can be null on
// a period with no trades, so we fall back to the bid/ask midpoint, which is
// what the rest of Predara treats as the market's probability.
async function fetchKalshiSeries(signedGet, { seriesTicker, ticker, window: windowKey }) {
  if (!seriesTicker || !ticker) throw new Error("Kalshi history needs a series and market ticker")
  const w = normalizeWindow(windowKey)
  const endTs = Math.floor(Date.now() / 1000)
  const startTs = endTs - WINDOW_SECONDS[w]
  const path = `/trade-api/v2/series/${encodeURIComponent(seriesTicker)}`
    + `/markets/${encodeURIComponent(ticker)}/candlesticks`
    + `?start_ts=${startTs}&end_ts=${endTs}&period_interval=${KALSHI_PERIODS[w]}`
  const r = await signedGet(path)
  if (!r || r.status !== 200) throw new Error(`Kalshi candlesticks unavailable (${r ? r.status : "no response"})`)
  let data = null
  try { data = JSON.parse(r.body) } catch { throw new Error("Invalid response from Kalshi candlesticks") }
  const candles = Array.isArray(data && data.candlesticks) ? data.candlesticks : []
  const points = candles.map((c) => {
    const t = Number(c.end_period_ts) * 1000
    const cents = kalshiCandleCents(c)
    if (!Number.isFinite(t) || cents === null) return null
    return { t, pct: Math.round(cents * 10) / 10 }
  }).filter(Boolean)
  return points
}

// Last trade if the period had one, otherwise the bid/ask midpoint. A period
// with neither is a real gap in the data and is dropped rather than drawn as 0.
function kalshiCandleCents(c) {
  const close = c && c.price && Number(c.price.close)
  if (Number.isFinite(close) && close > 0) return close
  const bid = c && c.yes_bid && Number(c.yes_bid.close)
  const ask = c && c.yes_ask && Number(c.yes_ask.close)
  const hasBid = Number.isFinite(bid) && bid > 0
  const hasAsk = Number.isFinite(ask) && ask > 0
  if (hasBid && hasAsk) return (bid + ask) / 2
  if (hasAsk) return ask
  if (hasBid) return bid
  return null
}

module.exports = {
  fetchPolymarketSeries,
  fetchKalshiSeries,
  kalshiCandleCents,
  normalizeWindow,
  WINDOW_SECONDS,
  KALSHI_PERIODS,
}
