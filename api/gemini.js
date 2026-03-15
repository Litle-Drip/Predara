const https = require("https")

const REQUEST_TIMEOUT_MS = 10000

function isSafeParam(str) {
  return typeof str === "string" && /^[A-Za-z0-9_\-\.]+$/.test(str)
}

module.exports = (req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type")
    return res.status(204).end()
  }

  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Content-Type", "application/json")

  const ticker = req.query.ticker
  if (!ticker || !isSafeParam(ticker)) {
    return res.status(400).json({ error: "Missing or invalid ticker" })
  }

  const target = `https://api.gemini.com/v1/prediction-markets/events/${encodeURIComponent(ticker)}`

  let responded = false
  const proxyReq = https.get(target, (apiRes) => {
    let body = ""
    apiRes.on("data", (chunk) => { body += chunk })
    apiRes.on("end", () => {
      if (responded) return
      responded = true
      if (apiRes.statusCode !== 200) {
        if (apiRes.statusCode === 404) {
          return res.status(404).json({ error: `Ticker "${ticker}" not found on Gemini. Make sure you have the full ticker (e.g. TPC2026T5, not TPC2026T).` })
        }
        return res.status(apiRes.statusCode).json({ error: `Gemini API returned ${apiRes.statusCode}` })
      }
      res.status(200).send(body)
    })
  })

  proxyReq.setTimeout(REQUEST_TIMEOUT_MS, () => {
    proxyReq.destroy()
    if (responded) return
    responded = true
    res.status(504).json({ error: "Gemini API request timed out" })
  })

  proxyReq.on("error", (err) => {
    if (responded) return
    responded = true
    res.status(502).json({ error: err.message })
  })
}
