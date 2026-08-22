// ── Webhook relay ─────────────────────────────────────────────────────────────
// The notification settings panel used to collect a Discord URL, a Telegram bot
// token and a Slack URL, write them to localStorage, and then never send
// anything anywhere. This is the delivery half.
//
// It has to be a server-side relay rather than a fetch from the page because
// Slack's incoming webhooks reject cross-origin browser requests outright.
//
// Predara stores none of this: the destination arrives with the request, is used
// for one POST, and is never logged or persisted.

const https = require("https")

const REQUEST_TIMEOUT_MS = 8000
const MAX_MESSAGE_BYTES = 2000

// A relay that will POST anywhere is an SSRF hole and an open spam cannon. Only
// the three services the UI actually offers are reachable, by exact host.
const ALLOWED_HOSTS = new Set([
  "discord.com",
  "discordapp.com",
  "hooks.slack.com",
  "api.telegram.org",
])

function destinationFor(target, message) {
  if (target.kind === "discord" || target.kind === "slack") {
    let parsedUrl
    try { parsedUrl = new URL(target.url) } catch { throw badRequest("Malformed webhook URL") }
    if (parsedUrl.protocol !== "https:") throw badRequest("Webhook URL must be https")
    if (!ALLOWED_HOSTS.has(parsedUrl.hostname)) throw badRequest(`Webhook host "${parsedUrl.hostname}" is not supported`)
    // Discord and Slack take the same {"content"|"text": "..."} shape.
    const body = target.kind === "discord" ? { content: message } : { text: message }
    return { url: parsedUrl, body }
  }
  if (target.kind === "telegram") {
    // The panel asks for "bot_token:chat_id", but a bot token itself contains a
    // colon ("123456:ABC-def"), so the chat id is the LAST segment and the token
    // is everything before it.
    const raw = String(target.token || "")
    const idx = raw.lastIndexOf(":")
    if (idx <= 0) throw badRequest('Telegram config must look like "bot_token:chat_id"')
    const token = raw.slice(0, idx)
    const chatId = raw.slice(idx + 1)
    if (!token || !chatId) throw badRequest('Telegram config must look like "bot_token:chat_id"')
    if (!/^[A-Za-z0-9:_-]+$/.test(token) || !/^-?[0-9]+$/.test(chatId)) {
      throw badRequest("Telegram bot token or chat id looks malformed")
    }
    return {
      url: new URL(`https://api.telegram.org/bot${token}/sendMessage`),
      body: { chat_id: chatId, text: message },
    }
  }
  throw badRequest(`Unknown notification target "${target.kind}"`)
}

function badRequest(msg) {
  const err = new Error(msg)
  err.status = 400
  return err
}

function postJson(parsedUrl, bodyObj) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(bodyObj)
    const req = https.request({
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    }, (res) => {
      let body = ""
      res.on("data", (c) => { body += c })
      res.on("end", () => resolve({ status: res.statusCode, body }))
    })
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy()
      reject(new Error("Webhook request timed out"))
    })
    req.on("error", reject)
    req.end(payload)
  })
}

// `targets` is [{ kind, url? , token? }]. Delivery is per-target and
// independent: one bad Discord URL must not silence a working Slack hook.
// The response never echoes a URL or token back.
async function relay(targets, message) {
  const text = String(message || "").slice(0, MAX_MESSAGE_BYTES)
  if (!text.trim()) throw badRequest("Message is empty")
  if (!Array.isArray(targets) || !targets.length) throw badRequest("No notification targets configured")
  const results = await Promise.all(targets.map(async (t) => {
    try {
      const { url, body } = destinationFor(t, text)
      const r = await postJson(url, body)
      return { kind: t.kind, ok: r.status >= 200 && r.status < 300, status: r.status }
    } catch (err) {
      return { kind: t.kind, ok: false, error: err.message }
    }
  }))
  return { delivered: results.filter((r) => r.ok).length, results }
}

module.exports = { relay, destinationFor, ALLOWED_HOSTS, MAX_MESSAGE_BYTES }
