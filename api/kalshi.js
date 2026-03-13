const https = require("https")
const crypto = require("crypto")

module.exports = (req, res) => {
  const keyId = process.env.KALSHI_API_KEY_ID
  const privateKey = process.env.KALSHI_PRIVATE_KEY

  if (!keyId || !privateKey) {
    res.status(503).json({ error: "Kalshi API credentials not configured. Add KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY to Vercel environment variables." })
    return
  }

  const ticker = req.query.ticker
  const type = req.query.type  // "market" or "event" — passed explicitly from the frontend

  if (!ticker) {
    res.status(400).json({ error: "Missing ticker" })
    return
  }

  const isMarket = type === "market"

  // Path without query string is used for signing
  const basePath = isMarket
    ? `/trade-api/v2/markets/${encodeURIComponent(ticker)}`
    : `/trade-api/v2/events/${encodeURIComponent(ticker)}`

  const apiPath = isMarket ? basePath : `${basePath}?with_nested_markets=true`

  // Normalize newlines in case Vercel stored the PEM key with literal \n
  const normalizedKey = privateKey.replace(/\\n/g, "\n")

  // Sign: timestamp + "GET" + path — use SHA256 to support both RSA and EC keys
  const timestamp = Date.now().toString()
  const msgString = timestamp + "GET" + basePath
  let signature
  try {
    signature = crypto.createSign("SHA256").update(msgString).sign(normalizedKey, "base64")
  } catch (err) {
    res.status(500).json({ error: `Failed to sign request: ${err.message}` })
    return
  }

  const options = {
    hostname: "trading-api.kalshi.com",
    path: apiPath,
    method: "GET",
    headers: {
      "KALSHI-ACCESS-KEY": keyId,
      "KALSHI-ACCESS-TIMESTAMP": timestamp,
      "KALSHI-ACCESS-SIGNATURE": signature,
      "Content-Type": "application/json",
    },
  }

  https.request(options, (apiRes) => {
    let body = ""
    apiRes.on("data", (chunk) => { body += chunk })
    apiRes.on("end", () => {
      res.setHeader("Access-Control-Allow-Origin", "*")
      res.setHeader("Content-Type", "application/json")
      // If Kalshi returns non-JSON (e.g. plain-text error), wrap it so the browser doesn't crash
      if (apiRes.statusCode !== 200) {
        res.status(apiRes.statusCode).json({ error: body.trim() })
      } else {
        res.status(200).send(body)
      }
    })
  }).on("error", (err) => {
    res.status(502).json({ error: err.message })
  }).end()
}
