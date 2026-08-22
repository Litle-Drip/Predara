// The /api routes proxy upstreams that cost Predara money and rate limit; the
// Kalshi ones are signed with Predara's own key. These are the checks that stop
// them being used as a free public backend.
const test = require("node:test")
const assert = require("node:assert/strict")

const guard = require("../lib/guard")
const notify = require("../lib/notify")
const history = require("../lib/history")

// ── Origin allowlist ──────────────────────────────────────────────────────────

test("only Predara's own origins may call the proxy routes", () => {
  assert.equal(guard.isAllowedOrigin("https://predara.org"), true)
  assert.equal(guard.isAllowedOrigin("https://www.predara.org"), true)
  assert.equal(guard.isAllowedOrigin("http://localhost:5000"), true)
  assert.equal(guard.isAllowedOrigin("https://predara-git-main.vercel.app"), true)
  assert.equal(guard.isAllowedOrigin("https://evil.com"), false)
  // A lookalike must not pass on a suffix match alone.
  assert.equal(guard.isAllowedOrigin("https://notpredara.org.evil.com"), false)
})

test("a same-origin request with no Origin header is allowed", () => {
  // Browsers omit Origin on same-origin GETs; the header is only present in
  // exactly the cross-site case this check exists to block.
  assert.equal(guard.isAllowedOrigin(undefined), true)
  assert.equal(guard.isAllowedOrigin(""), true)
})

test("a malformed Origin is rejected rather than parsed loosely", () => {
  assert.equal(guard.isAllowedOrigin("not-a-url"), false)
})

test("CORS never echoes a disallowed origin back", () => {
  const headers = guard.corsHeadersFor("https://evil.com")
  assert.equal(headers["Access-Control-Allow-Origin"], "https://predara.org")
  assert.notEqual(headers["Access-Control-Allow-Origin"], "*")
  assert.equal(headers.Vary, "Origin")
})

test("CORS echoes an allowed origin so the allowlist actually binds", () => {
  assert.equal(
    guard.corsHeadersFor("https://predara.org")["Access-Control-Allow-Origin"],
    "https://predara.org",
  )
})

// ── Rate limit ────────────────────────────────────────────────────────────────

test("a client is throttled once it exceeds the window", () => {
  const req = { headers: { "x-forwarded-for": "203.0.113.9" }, socket: {} }
  let last
  for (let i = 0; i < 11; i++) last = guard.rateLimit(req, { max: 10, windowMs: 60000 })
  assert.equal(last.allowed, false)
  assert.ok(last.retryAfter > 0, "a throttled client must be told when to retry")
})

test("clients are throttled independently of each other", () => {
  const a = { headers: { "x-forwarded-for": "198.51.100.1" }, socket: {} }
  const b = { headers: { "x-forwarded-for": "198.51.100.2" }, socket: {} }
  for (let i = 0; i < 6; i++) guard.rateLimit(a, { max: 5, windowMs: 60000 })
  assert.equal(guard.rateLimit(b, { max: 5, windowMs: 60000 }).allowed, true)
})

test("the forwarded chain is read left to right, so a client cannot append a fake IP", () => {
  const req = { headers: { "x-forwarded-for": "203.0.113.50, 10.0.0.1" }, socket: {} }
  assert.equal(guard.clientKey(req), "203.0.113.50")
})

// ── Cache ─────────────────────────────────────────────────────────────────────

test("a cached value is produced once per TTL window", async () => {
  let calls = 0
  const producer = async () => { calls++; return { n: calls } }
  const first = await guard.cached("test-key", 60000, producer)
  const second = await guard.cached("test-key", 60000, producer)
  assert.equal(calls, 1, "the second reader must be served from cache")
  assert.equal(second.fromCache, true)
  assert.deepEqual(second.value, first.value)
})

test("an expired entry is refetched", async () => {
  let calls = 0
  const producer = async () => { calls++; return calls }
  await guard.cached("ttl-key", 1, producer)
  await new Promise((r) => setTimeout(r, 5))
  const again = await guard.cached("ttl-key", 1, producer)
  assert.equal(calls, 2)
  assert.equal(again.fromCache, false)
})

test("a failing producer is not cached", async () => {
  let calls = 0
  const producer = async () => { calls++; throw new Error("upstream down") }
  await assert.rejects(() => guard.cached("err-key", 60000, producer))
  await assert.rejects(() => guard.cached("err-key", 60000, producer))
  assert.equal(calls, 2, "a transient failure must not stick in the cache")
})

// ── Webhook relay ─────────────────────────────────────────────────────────────

test("the relay only posts to the three services the UI offers", () => {
  assert.doesNotThrow(() => notify.destinationFor({ kind: "discord", url: "https://discord.com/api/webhooks/1/x" }, "hi"))
  assert.doesNotThrow(() => notify.destinationFor({ kind: "slack", url: "https://hooks.slack.com/services/A/B/C" }, "hi"))
  // Anything else would make Predara an open SSRF relay and spam cannon.
  assert.throws(() => notify.destinationFor({ kind: "discord", url: "https://evil.com/hook" }, "hi"), /not supported/)
  assert.throws(() => notify.destinationFor({ kind: "discord", url: "http://discord.com/api/webhooks/1/x" }, "hi"), /https/)
  assert.throws(() => notify.destinationFor({ kind: "discord", url: "https://127.0.0.1/admin" }, "hi"), /not supported/)
})

test("Discord and Slack get the payload shape each expects", () => {
  assert.deepEqual(notify.destinationFor({ kind: "discord", url: "https://discord.com/api/webhooks/1/x" }, "hi").body, { content: "hi" })
  assert.deepEqual(notify.destinationFor({ kind: "slack", url: "https://hooks.slack.com/services/A/B/C" }, "hi").body, { text: "hi" })
})

test("a Telegram config splits on the LAST colon, because bot tokens contain one", () => {
  const d = notify.destinationFor({ kind: "telegram", token: "123456:ABC-def_ghi:-1009876" }, "hi")
  assert.equal(d.url.pathname, "/bot123456:ABC-def_ghi/sendMessage")
  assert.equal(d.body.chat_id, "-1009876")
})

test("a malformed Telegram config is rejected", () => {
  assert.throws(() => notify.destinationFor({ kind: "telegram", token: "nocolon" }, "hi"), /bot_token/)
  assert.throws(() => notify.destinationFor({ kind: "telegram", token: "tok:notanumber" }, "hi"), /malformed/)
})

test("an empty message or target list is refused before any outbound request", async () => {
  await assert.rejects(() => notify.relay([{ kind: "discord", url: "https://discord.com/api/webhooks/1/x" }], "   "), /empty/)
  await assert.rejects(() => notify.relay([], "hello"), /No notification targets/)
})

// ── Price history ─────────────────────────────────────────────────────────────

test("a Kalshi candle prefers the last trade and falls back to the midpoint", () => {
  assert.equal(history.kalshiCandleCents({ price: { close: 62 } }), 62)
  assert.equal(history.kalshiCandleCents({ price: { close: 0 }, yes_bid: { close: 60 }, yes_ask: { close: 64 } }), 62)
})

test("a candle with no trade and no book is dropped, not drawn as zero", () => {
  assert.equal(history.kalshiCandleCents({ price: { close: null } }), null)
  assert.equal(history.kalshiCandleCents({}), null)
})

test("an unknown history window falls back to a sane default", () => {
  assert.equal(history.normalizeWindow("1m"), "1m")
  assert.equal(history.normalizeWindow("'; DROP TABLE"), "1w")
  assert.equal(history.normalizeWindow(undefined), "1w")
})

test("a non-numeric Polymarket token id is refused before any outbound request", async () => {
  await assert.rejects(() => history.fetchPolymarketSeries("../../etc/passwd", "1w"), /Invalid Polymarket token id/)
})
