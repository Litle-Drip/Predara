const https = require("https")

module.exports = (req, res) => {
  const slug = req.query.slug

  if (!slug) {
    res.status(400).json({ error: "Missing slug" })
    return
  }

  const target = `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`

  https.get(target, (apiRes) => {
    let body = ""
    apiRes.on("data", (chunk) => { body += chunk })
    apiRes.on("end", () => {
      res.setHeader("Access-Control-Allow-Origin", "*")
      res.status(apiRes.statusCode).send(body)
    })
  }).on("error", (err) => {
    res.status(502).json({ error: err.message })
  })
}
