const https = require("https")
const crypto = require("crypto")

const REQUEST_TIMEOUT_MS = 10000

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
}

function isSafeParam(str) {
  return typeof str === "string" && /^[A-Za-z0-9_\-\.]+$/.test(str)
}

function kalshiRequest(apiPath, keyId, normalizedKey) {
  return new Promise((resolve, reject) => {
    const timestamp = Date.now().toString()
    const basePath = apiPath.split("?")[0]
    const msgString = timestamp + "GET" + basePath
    let signature
    try {
      signature = crypto.createSign("SHA256").update(msgString).sign(normalizedKey, "base64")
    } catch (err) {
      return reject(new Error("Failed to sign request"))
    }

    const req = https.request({
      hostname: "api.elections.kalshi.com",
      path: apiPath,
      method: "GET",
      headers: {
        "KALSHI-ACCESS-KEY": keyId,
        "KALSHI-ACCESS-TIMESTAMP": timestamp,
        "KALSHI-ACCESS-SIGNATURE": signature,
        "Content-Type": "application/json",
      },
    }, (apiRes) => {
      let body = ""
      apiRes.on("data", (chunk) => { body += chunk })
      apiRes.on("end", () => resolve({ status: apiRes.statusCode, body }))
    })

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy()
      reject(new Error("Kalshi API request timed out"))
    })
    req.on("error", reject).end()
  })
}

module.exports = async (req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS)
    return res.end()
  }

  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Content-Type", "application/json")

  const keyId = process.env.KALSHI_API_KEY_ID
  const privateKey = process.env.KALSHI_PRIVATE_KEY
  if (!keyId || !privateKey) {
    return res.status(503).json({ error: "Kalshi API credentials not configured. Add KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY to Vercel environment variables." })
  }

  const ticker = req.query.ticker
  if (!ticker || !isSafeParam(ticker)) {
    return res.status(400).json({ error: "Missing or invalid ticker" })
  }

  const normalizedKey = privateKey.replace(/\\n/g, "\n")

  try {
    // Try market endpoint first
    const marketRes = await kalshiRequest(
      `/trade-api/v2/markets/${encodeURIComponent(ticker)}`,
      keyId, normalizedKey
    )

    if (marketRes.status === 200) {
      // Validate it's JSON before forwarding
      try { JSON.parse(marketRes.body) } catch {
        return res.status(502).json({ error: "Invalid response from Kalshi API" })
      }
      return res.status(200).send(marketRes.body)
    }

    // Fall back to event endpoint
    const eventRes = await kalshiRequest(
      `/trade-api/v2/events/${encodeURIComponent(ticker)}?with_nested_markets=true`,
      keyId, normalizedKey
    )

    if (eventRes.status === 200) {
      try { JSON.parse(eventRes.body) } catch {
        return res.status(502).json({ error: "Invalid response from Kalshi API" })
      }
      return res.status(200).send(eventRes.body)
    }

    return res.status(eventRes.status).json({ error: `Kalshi API returned ${eventRes.status}` })

  } catch (err) {
    return res.status(502).json({ error: err.message })
  }
}
