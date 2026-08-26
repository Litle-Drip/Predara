const https = require("https")
const { getGeminiPublic, geminiEventsToDiscoverCards } = require("./gemini-public")
const { cached } = require("./guard")

const REQUEST_TIMEOUT_MS = 10000
const DISCOVERY_CACHE_MS = 60000

function fetchJson(targetUrl, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const req = https.get(targetUrl, (res) => {
      let body = ""
      res.on("data", (chunk) => { body += chunk })
      res.on("end", () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Upstream returned ${res.statusCode}`))
        }
        try {
          resolve(JSON.parse(body))
        } catch {
          reject(new Error("Upstream returned invalid JSON"))
        }
      })
    })
    req.setTimeout(timeoutMs, () => {
      req.destroy()
      reject(new Error("Upstream request timed out"))
    })
    req.on("error", reject)
  })
}

function polymarketEventsToDiscoverCards(payload, limit = 8) {
  const events = Array.isArray(payload) ? payload : []
  return events.slice(0, limit).map((event) => {
    const firstMarket = Array.isArray(event.markets) ? event.markets[0] || {} : {}
    let outcomes = firstMarket.outcomes || []
    let prices = firstMarket.outcomePrices || []
    try {
      if (typeof outcomes === "string") outcomes = JSON.parse(outcomes)
      if (typeof prices === "string") prices = JSON.parse(prices)
    } catch {
      outcomes = []
      prices = []
    }
    const numericPrices = prices.map((price) => parseFloat(price))
    const topIdx = numericPrices.reduce((best, price, i) => {
      if (!Number.isFinite(price)) return best
      if (best < 0 || price > numericPrices[best]) return i
      return best
    }, -1)
    const volume = parseFloat(event.volume)
    return {
      title: event.title || firstMarket.question || "Untitled",
      url: `https://polymarket.com/event/${event.slug || ""}`,
      volume: Number.isFinite(volume) ? Math.round(volume).toLocaleString("en-US") : "",
      topOutcome: topIdx >= 0 && outcomes[topIdx] ? outcomes[topIdx] : "",
      topPct: topIdx >= 0 && prices[topIdx]
        ? Math.round(parseFloat(prices[topIdx]) * 100)
        : "",
    }
  })
}

async function getDiscoveryFeed({ limit = 8 } = {}) {
  const safeLimit = Math.min(12, Math.max(1, parseInt(limit, 10) || 8))
  return cached(`discovery:${safeLimit}`, DISCOVERY_CACHE_MS, async () => {
    const polymarketUrl =
      `https://gamma-api.polymarket.com/events?active=true&closed=false&order=volume&ascending=false&limit=${safeLimit}`

    const [polymarketResult, geminiResult] = await Promise.allSettled([
      fetchJson(polymarketUrl).then((data) =>
        polymarketEventsToDiscoverCards(data, safeLimit)),
      getGeminiPublic("events", { status: "active", limit: String(Math.max(24, safeLimit)) })
        .then(({ status, json }) =>
          status === 200 ? geminiEventsToDiscoverCards(json, safeLimit) : []),
    ])

    const platforms = []
    const polymarketMarkets = polymarketResult.status === "fulfilled"
      ? polymarketResult.value
      : []
    const geminiMarkets = geminiResult.status === "fulfilled"
      ? geminiResult.value
      : []
    if (polymarketMarkets.length) {
      platforms.push({ name: "polymarket", markets: polymarketMarkets })
    }
    if (geminiMarkets.length) {
      platforms.push({ name: "gemini", markets: geminiMarkets })
    }

    return {
      generatedAt: new Date().toISOString(),
      platforms,
    }
  })
}

module.exports = {
  getDiscoveryFeed,
  polymarketEventsToDiscoverCards,
}
