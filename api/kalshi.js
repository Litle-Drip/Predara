const https = require("https")
const crypto = require("crypto")

function kalshiRequest(path, keyId, normalizedKey) {
  return new Promise((resolve, reject) => {
    const timestamp = Date.now().toString()
    const basePath = path.split("?")[0]
    const msgString = timestamp + "GET" + basePath
    let signature
    try {
      signature = crypto.createSign("SHA256").update(msgString).sign(normalizedKey, "base64")
    } catch (err) {
      return reject(new Error(`Failed to sign request: ${err.message}`))
    }

    const options = {
      hostname: "api.elections.kalshi.com",
      path,
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
      apiRes.on("end", () => resolve({ status: apiRes.statusCode, body }))
    }).on("error", reject).end()
  })
}

module.exports = async (req, res) => {
  const keyId = process.env.KALSHI_API_KEY_ID
  const privateKey = process.env.KALSHI_PRIVATE_KEY

  if (!keyId || !privateKey) {
    res.status(503).json({ error: "Kalshi API credentials not configured. Add KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY to Vercel environment variables." })
    return
  }

  const ticker = req.query.ticker
  if (!ticker) {
    res.status(400).json({ error: "Missing ticker" })
    return
  }

  const normalizedKey = privateKey.replace(/\\n/g, "\n")

  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Content-Type", "application/json")

  try {
    // Try the market endpoint first
    const marketPath = `/trade-api/v2/markets/${encodeURIComponent(ticker)}`
    const marketRes = await kalshiRequest(marketPath, keyId, normalizedKey)

    if (marketRes.status === 200) {
      return res.status(200).send(marketRes.body)
    }

    // Fall back to the event endpoint (Kalshi game URLs often use the event ticker)
    const eventPath = `/trade-api/v2/events/${encodeURIComponent(ticker)}?with_nested_markets=true`
    const eventRes = await kalshiRequest(eventPath, keyId, normalizedKey)

    if (eventRes.status === 200) {
      return res.status(200).send(eventRes.body)
    }

    // Both failed — return the event endpoint error (more informative for game markets)
    return res.status(eventRes.status).json({ error: eventRes.body.trim() })

  } catch (err) {
    res.status(502).json({ error: err.message })
  }
}
