// Vercel serverless function — Gemini event lookup by ticker.
// All Gemini logic lives in lib/gemini.js so this file and server.js cannot
// drift apart; this is only the HTTP shell.

const { getEvent } = require("../lib/gemini")
const { applyGuard } = require("../lib/guard")

module.exports = async (req, res) => {
  // Origin allowlist + rate limit: this route proxies an upstream that costs
  // Predara its share of a shared rate limit, so it must not serve as a free
  // public API. See lib/guard.js.
  if (!applyGuard(req, res)) return
  res.setHeader("Content-Type", "application/json")

  const { status, data, error } = await getEvent(req.query.ticker, req.query.pageUrl)
  return res.status(status).json(error ? { error } : data)
}
