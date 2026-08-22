// ── Kalshi request signing ────────────────────────────────────────────────────
// Kalshi authenticates with an RSA-signed timestamp header. The signing and PEM
// normalization were already duplicated between `api/kalshi.js` and
// `server.js`; this is the shared copy that new routes use, so a third
// divergent implementation does not appear.

const https = require("https")
const crypto = require("crypto")

const REQUEST_TIMEOUT_MS = 10000

const KALSHI_HOSTS = [
  "trading-api.kalshi.com",     // main trading API (all markets)
  "api.elections.kalshi.com",   // legacy elections-specific endpoint
]

// Accepts a key however the secret store mangled it — escaped newlines, no
// newlines at all, PKCS#1 or PKCS#8 headers.
function normalizePem(raw) {
  const pem = String(raw).replace(/\\n/g, "\n").trim()
  const headerMatch = pem.match(/-----BEGIN ([^-]+)-----/)
  const keyType = headerMatch ? headerMatch[1] : "RSA PRIVATE KEY"
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "")
  const body = (b64.match(/.{1,64}/g) || []).join("\n")
  return `-----BEGIN ${keyType}-----\n${body}\n-----END ${keyType}-----`
}

// Kalshi signs timestamp + METHOD + path WITHOUT the query string.
function signedGet(hostname, apiPath, keyId, normalizedKey) {
  return new Promise((resolve, reject) => {
    const timestamp = Date.now().toString()
    const basePath = apiPath.split("?")[0]
    let signature
    try {
      signature = crypto.createSign("SHA256").update(timestamp + "GET" + basePath).sign(normalizedKey, "base64")
    } catch {
      return reject(new Error("Failed to sign Kalshi request"))
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
      apiRes.on("data", (c) => { body += c })
      apiRes.on("end", () => resolve({ status: apiRes.statusCode, body }))
    })
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy()
      reject(new Error("Kalshi API request timed out"))
    })
    req.on("error", reject).end()
  })
}

// Returns a `(path) => Promise<{status, body}>` that tries each known Kalshi
// host, falling through on anything that is not a 200. Credentials are read
// once, here, rather than by every caller.
function makeSignedGet() {
  const keyId = process.env.KALSHI_API_KEY_ID
  const privateKey = process.env.KALSHI_PRIVATE_KEY
  if (!keyId || !privateKey) return null
  const normalizedKey = normalizePem(privateKey)
  return async (apiPath) => {
    let last = null
    for (const hostname of KALSHI_HOSTS) {
      last = await signedGet(hostname, apiPath, keyId, normalizedKey)
      if (last.status === 200) return last
    }
    return last
  }
}

module.exports = { normalizePem, signedGet, makeSignedGet, KALSHI_HOSTS }
