const https = require("https")
const { applyGuard, cacheGet, cacheSet } = require("../lib/guard")

const REQUEST_TIMEOUT_MS = 10000
const MARKET_CACHE_TTL_MS = 15000

function isSafeParam(str) {
  return typeof str === "string" && /^[A-Za-z0-9_\-\.]+$/.test(str)
}

module.exports = (req, res) => {
  // Origin allowlist + rate limit: this route proxies an upstream that costs
  // Predara its share of a shared rate limit, so it must not serve as a free
  // public API. See lib/guard.js.
  if (!applyGuard(req, res)) return
  res.setHeader("Content-Type", "application/json")

  const slug = req.query.slug
  if (!slug || !isSafeParam(slug)) {
    return res.status(400).json({ error: "Missing or invalid slug" })
  }

  // Prices move on the order of seconds, so a short cache is invisible to the
  // reader and collapses a burst on a trending market into one upstream call.
  const cacheKey = "polymarket:" + slug
  const hit = cacheGet(cacheKey)
  if (hit) return res.status(200).send(hit)

  const target = `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`

  let responded = false
  const proxyReq = https.get(target, (apiRes) => {
    let body = ""
    apiRes.on("data", (chunk) => { body += chunk })
    apiRes.on("end", () => {
      if (responded) return
      responded = true
      if (apiRes.statusCode !== 200) {
        return res.status(apiRes.statusCode).json({ error: `Polymarket API returned ${apiRes.statusCode}` })
      }
      let parsed
      try { parsed = JSON.parse(body) } catch (_) { parsed = null }
      if (!Array.isArray(parsed) || parsed.length === 0) {
        return res.status(502).json({ error: "Upstream returned an empty or invalid payload" })
      }
      cacheSet(cacheKey, body, MARKET_CACHE_TTL_MS)
      res.status(200).send(body)
    })
  })

  proxyReq.setTimeout(REQUEST_TIMEOUT_MS, () => {
    proxyReq.destroy()
    if (responded) return
    responded = true
    res.status(504).json({ error: "Polymarket API request timed out" })
  })

  proxyReq.on("error", (err) => {
    if (responded) return
    responded = true
    res.status(502).json({ error: err.message })
  })
}
