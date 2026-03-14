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

  const slug = req.query.slug
  if (!slug || !isSafeParam(slug)) {
    return res.status(400).json({ error: "Missing or invalid slug" })
  }

  const target = `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`

  const proxyReq = https.get(target, (apiRes) => {
    let body = ""
    apiRes.on("data", (chunk) => { body += chunk })
    apiRes.on("end", () => {
      if (apiRes.statusCode !== 200) {
        return res.status(apiRes.statusCode).json({ error: `Polymarket API returned ${apiRes.statusCode}` })
      }
      res.status(200).send(body)
    })
  })

  proxyReq.setTimeout(REQUEST_TIMEOUT_MS, () => {
    proxyReq.destroy()
    res.status(504).json({ error: "Polymarket API request timed out" })
  })

  proxyReq.on("error", (err) => {
    res.status(502).json({ error: err.message })
  })
}
