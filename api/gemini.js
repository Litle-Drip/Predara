// Vercel serverless function — Gemini event lookup by ticker.
// All Gemini logic lives in lib/gemini.js so this file and server.js cannot
// drift apart; this is only the HTTP shell.

const { getEvent } = require("../lib/gemini")

module.exports = async (req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type")
    return res.status(204).end()
  }

  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Content-Type", "application/json")

  const { status, data, error } = await getEvent(req.query.ticker, req.query.pageUrl)
  return res.status(status).json(error ? { error } : data)
}
