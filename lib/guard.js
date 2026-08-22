// ── Proxy guard: origin allowlist, response cache, rate limit ─────────────────
//
// Predara's /api routes proxy upstreams that cost us something: the Kalshi
// routes are signed with Predara's own RSA key, and every route consumes a
// shared rate limit. They shipped with `Access-Control-Allow-Origin: *`, no
// cache and no throttle, which made them a free public API anyone could point
// their own app at.
//
// This module is deliberately dependency-free and process-local. On Vercel each
// serverless instance keeps its own cache and counters, so this is a cost
// dampener and an abuse speed bump, not a distributed quota.

// Browsers send no Origin on same-origin GETs, so an absent Origin is allowed —
// the check is here to stop *other sites'* pages from using us as a backend,
// which is exactly the case where the browser does send one.
const ALLOWED_HOST_SUFFIXES = [
  "predara.org",
  "localhost",
  "127.0.0.1",
  "vercel.app",   // preview deployments
]

function extraAllowedOrigins() {
  return String(process.env.PREDARA_ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

function isAllowedOrigin(origin) {
  if (!origin) return true
  let host
  try { host = new URL(origin).hostname } catch { return false }
  if (extraAllowedOrigins().some((o) => o === origin || o === host)) return true
  return ALLOWED_HOST_SUFFIXES.some((s) => host === s || host.endsWith("." + s))
}

// Echo the caller's origin rather than "*" so the allowlist actually binds; a
// wildcard would let any page read the response regardless of what we checked.
function corsHeadersFor(origin) {
  return {
    "Access-Control-Allow-Origin": origin && isAllowedOrigin(origin) ? origin : "https://predara.org",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-anthropic-api-key",
    "Vary": "Origin",
  }
}

// ── TTL cache ─────────────────────────────────────────────────────────────────
// Market data is identical for every viewer for a few seconds at a time, so one
// upstream call can serve a burst of readers. This also makes the app faster.
const _cache = new Map()
const CACHE_MAX_ENTRIES = 500

function cacheGet(key) {
  const hit = _cache.get(key)
  if (!hit) return null
  if (Date.now() > hit.expires) { _cache.delete(key); return null }
  return hit.value
}

function cacheSet(key, value, ttlMs) {
  if (_cache.size >= CACHE_MAX_ENTRIES) {
    // Cheap bound: drop the oldest insertion. Map preserves insertion order.
    const oldest = _cache.keys().next().value
    if (oldest !== undefined) _cache.delete(oldest)
  }
  _cache.set(key, { value, expires: Date.now() + ttlMs })
  return value
}

// Run `producer` at most once per key per TTL window. Errors are never cached,
// so a transient upstream failure does not stick around.
async function cached(key, ttlMs, producer) {
  const hit = cacheGet(key)
  if (hit !== null) return { value: hit, fromCache: true }
  const value = await producer()
  cacheSet(key, value, ttlMs)
  return { value, fromCache: false }
}

// ── Rate limit ────────────────────────────────────────────────────────────────
// Fixed window per client, keyed by forwarded IP. Generous enough that a real
// user browsing quickly never notices, tight enough that a scraper does.
const RATE_LIMIT_WINDOW_MS = 60000
const RATE_LIMIT_MAX = 60
const _buckets = new Map()

function clientKey(req) {
  const fwd = req.headers && (req.headers["x-forwarded-for"] || req.headers["x-real-ip"])
  const first = String(fwd || "").split(",")[0].trim()
  return first || (req.socket && req.socket.remoteAddress) || "unknown"
}

function rateLimit(req, { max = RATE_LIMIT_MAX, windowMs = RATE_LIMIT_WINDOW_MS } = {}) {
  const key = clientKey(req)
  const now = Date.now()
  const b = _buckets.get(key)
  if (!b || now >= b.reset) {
    _buckets.set(key, { count: 1, reset: now + windowMs })
    if (_buckets.size > 5000) {
      for (const [k, v] of _buckets) { if (now >= v.reset) _buckets.delete(k) }
    }
    return { allowed: true, remaining: max - 1, retryAfter: 0 }
  }
  b.count += 1
  if (b.count > max) {
    return { allowed: false, remaining: 0, retryAfter: Math.ceil((b.reset - now) / 1000) }
  }
  return { allowed: true, remaining: max - b.count, retryAfter: 0 }
}

// Applies CORS, the origin allowlist and rate limiting to a Vercel-style
// handler in one call. Returns false when it has already answered the request
// (preflight, rejected origin, throttled) and the caller must stop.
function applyGuard(req, res, { methods = "GET, OPTIONS", rate } = {}) {
  const origin = req.headers && req.headers.origin
  const headers = { ...corsHeadersFor(origin), "Access-Control-Allow-Methods": methods }
  Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v))
  if (req.method === "OPTIONS") { res.status(204).end(); return false }
  if (!isAllowedOrigin(origin)) { res.status(403).json({ error: "Origin not allowed" }); return false }
  const limit = rateLimit(req, rate)
  if (!limit.allowed) {
    res.setHeader("Retry-After", String(limit.retryAfter))
    res.status(429).json({ error: "Rate limit exceeded. Try again shortly." })
    return false
  }
  return true
}

module.exports = {
  applyGuard,
  isAllowedOrigin,
  corsHeadersFor,
  cached,
  cacheGet,
  cacheSet,
  rateLimit,
  clientKey,
  ALLOWED_HOST_SUFFIXES,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
}
