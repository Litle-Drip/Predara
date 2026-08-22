// Relays a price alert to the user's own Discord / Slack / Telegram webhook.
// Thin HTTP shell — the delivery and the destination allowlist live in
// lib/notify.js so server.js runs the same code path locally.

const { applyGuard } = require("../lib/guard")
const { relay } = require("../lib/notify")

function readBody(req) {
  if (req.body && typeof req.body === "object") return Promise.resolve(req.body)
  return new Promise((resolve, reject) => {
    let raw = ""
    req.on("data", (c) => {
      raw += c
      if (raw.length > 16000) { req.destroy(); reject(new Error("Payload too large")) }
    })
    req.on("end", () => {
      try { resolve(JSON.parse(raw || "{}")) } catch { reject(new Error("Invalid JSON body")) }
    })
    req.on("error", reject)
  })
}

module.exports = async (req, res) => {
  // Relaying costs Predara an outbound request per call, and the destinations
  // are third-party services, so this is throttled harder than the read routes.
  if (!applyGuard(req, res, { methods: "POST, OPTIONS", rate: { max: 20, windowMs: 60000 } })) return
  res.setHeader("Content-Type", "application/json")

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed. Use POST." })

  let body
  try { body = await readBody(req) } catch (err) { return res.status(400).json({ error: err.message }) }

  try {
    // Targets are supplied per request and never stored: Predara holds no copy
    // of anyone's webhook URL or bot token.
    const result = await relay(body.targets, body.message)
    return res.status(200).json(result)
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message })
  }
}
