const https = require("https")
const crypto = require("crypto")
const { applyGuard } = require("../lib/guard")

const REQUEST_TIMEOUT_MS = 10000

function normalizePem(raw) {
  let pem = raw.replace(/\\n/g, "\n").trim()
  const headerMatch = pem.match(/-----BEGIN ([^-]+)-----/)
  const keyType = headerMatch ? headerMatch[1] : "RSA PRIVATE KEY"
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "")
  const body = b64.match(/.{1,64}/g).join("\n")
  return `-----BEGIN ${keyType}-----\n${body}\n-----END ${keyType}-----`
}

const KALSHI_HOSTS = [
  "trading-api.kalshi.com",
  "api.elections.kalshi.com",
]

function kalshiRequest(hostname, apiPath, keyId, normalizedKey) {
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
      hostname,
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

// Lists all currently active Kalshi liquidity/volume incentive programs, across
// every market — powers the Rewards tab's live table. Unlike api/kalshi.js this
// isn't tied to a single ticker lookup.
module.exports = async (req, res) => {
  // Origin allowlist + rate limit: this route is signed with Predara's own
  // Kalshi API key, so it must never serve as a free public API. See
  // lib/guard.js.
  if (!applyGuard(req, res)) return

  res.setHeader("Content-Type", "application/json")

  const keyId = process.env.KALSHI_API_KEY_ID
  const privateKey = process.env.KALSHI_PRIVATE_KEY
  if (!keyId || !privateKey) {
    return res.status(503).json({ error: "Kalshi API credentials not configured." })
  }

  const normalizedKey = normalizePem(privateKey)

  try {
    for (const hostname of KALSHI_HOSTS) {
      const r = await kalshiRequest(hostname, `/trade-api/v2/incentive_programs?status=active`, keyId, normalizedKey)
      if (r.status === 200) {
        let data
        try { data = JSON.parse(r.body) } catch { continue }
        return res.status(200).json({ incentive_programs: Array.isArray(data.incentive_programs) ? data.incentive_programs : [] })
      }
    }
    return res.status(502).json({ error: "Kalshi incentive programs unavailable" })
  } catch (err) {
    return res.status(502).json({ error: err.message })
  }
}
