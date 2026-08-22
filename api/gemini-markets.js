const { getGeminiPublic } = require("../lib/gemini-public")

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type")
    return res.status(204).end()
  }

  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Content-Type", "application/json")

  const { resource, ...query } = req.query || {}
  const { status, json } = await getGeminiPublic(resource, query)
  return res.status(status).json(json)
}
