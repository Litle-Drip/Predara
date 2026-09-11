// Vercel serverless function — Polymarket event lookup.
// GET /api/polymarket?slug=<event-slug>&venue=us|com
//
// The lookup itself lives in lib/polymarket.js so server.js runs the same code
// path locally, including the venue fallback and the 404-not-502 distinction.

const { applyGuard, cacheGet, cacheSet } = require("../lib/guard")
const { fetchEventBySlug, venueFor } = require("../lib/polymarket")

const MARKET_CACHE_TTL_MS = 15000

module.exports = async (req, res) => {
  // Origin allowlist + rate limit: this route proxies an upstream that costs
  // Predara its share of a shared rate limit, so it must not serve as a free
  // public API. See lib/guard.js.
  if (!applyGuard(req, res)) return
  res.setHeader("Content-Type", "application/json")

  const slug = req.query.slug
  const venue = venueFor(req.query.venue)

  // Prices move on the order of seconds, so a short cache is invisible to the
  // reader and collapses a burst on a trending market into one upstream call.
  const cacheKey = `polymarket:${venue}:${slug}`
  const hit = cacheGet(cacheKey)
  if (hit) return res.status(200).send(hit)

  const { status, body, error } = await fetchEventBySlug(slug, venue)
  if (error) return res.status(status).json({ error })

  cacheSet(cacheKey, body, MARKET_CACHE_TTL_MS)
  return res.status(200).send(body)
}
