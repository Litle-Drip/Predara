// Shared read-only access to Gemini's public Prediction Markets REST API.
// Spec: https://developer.gemini.com/specs/openapi/prediction-markets.yaml
//
// Only the public, unauthenticated surface is exposed here. The authenticated
// trading/positions/payout endpoints are deliberately not proxied: Predara is a
// read-only analyzer and never holds a user's API keys or places orders.
//
// Used by both api/gemini-markets.js (Vercel) and server.js (local/Replit).
//
// Transport, ticker validation and pagination clamping come from lib/gemini.js;
// this module adds the resources the browser browses by name (event feeds,
// categories, volume, reward programs) plus a short-lived response cache.

const gemini = require("./gemini")

const BASE = gemini.API_BASE

// Volume and reward-program data changes slowly; events change constantly.
const CACHE_TTL_MS = {
  categories: 10 * 60 * 1000,
  volume: 30 * 60 * 1000,
  "maker-rebate-rates": 30 * 60 * 1000,
  "liquidity-rewards-config": 30 * 60 * 1000,
  "liquidity-rewards-events": 2 * 60 * 1000,
  terms: 60 * 60 * 1000,
}
const DEFAULT_CACHE_TTL_MS = 20 * 1000
const CACHE_MAX_ENTRIES = 200

const _cache = new Map()

function isIsoDate(v) {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)
}
// Category/status/sort values are human-readable labels ("Fun/Culture", "daily_pool_desc")
function isLabel(v) {
  return typeof v === "string" && v.length > 0 && v.length <= 64 && /^[A-Za-z0-9 _\-\.,/&']+$/.test(v)
}
function isSearchText(v) {
  return typeof v === "string" && v.length <= 100 && !/[<>"\\]/.test(v)
}
function clampInt(v, min, max, fallback) {
  return gemini.clampInt(v, { min, max, fallback })
}

// Repeated filters use OR semantics upstream, so a param may arrive as an array
// (?category=A&category=B) or as a single value.
function asList(v) {
  if (v == null) return []
  return (Array.isArray(v) ? v : [v]).filter((x) => x !== "")
}

function appendList(sp, name, values, validate) {
  for (const v of values) {
    if (!validate(v)) throw new BadRequest(`Invalid ${name}: ${String(v).slice(0, 40)}`)
    sp.append(name, v)
  }
}

class BadRequest extends Error {}

// Shared query builder for the four event-list endpoints. `events` additionally
// supports free-text search and status filtering.
function eventListQuery(q, { withSearch }) {
  const sp = new URLSearchParams()
  appendList(sp, "category", asList(q.category), isLabel)
  appendList(sp, "sport", asList(q.sport), isLabel)
  if (withSearch) {
    appendList(sp, "status", asList(q.status), isLabel)
    if (q.search) {
      if (!isSearchText(q.search)) throw new BadRequest("Invalid search text")
      sp.set("search", q.search)
    }
  }
  sp.set("limit", String(clampInt(q.limit, 1, 100, 24)))
  sp.set("offset", String(clampInt(q.offset, 0, 10000, 0)))
  return sp
}

const RESOURCES = {
  // ── Markets ──
  events: (q) => `${BASE}/events?${eventListQuery(q, { withSearch: true })}`,
  "newly-listed": (q) => `${BASE}/events/newly-listed?${eventListQuery(q, { withSearch: false })}`,
  upcoming: (q) => `${BASE}/events/upcoming?${eventListQuery(q, { withSearch: false })}`,
  "recently-settled": (q) => `${BASE}/events/recently-settled?${eventListQuery(q, { withSearch: false })}`,
  categories: (q) => {
    const sp = new URLSearchParams()
    appendList(sp, "status", asList(q.status), isLabel)
    return `${BASE}/categories${sp.toString() ? `?${sp}` : ""}`
  },

  // ── Volume ──
  // Only completed UTC days are available upstream; today returns 404.
  volume: (q) => {
    if (!isIsoDate(q.date)) throw new BadRequest("date must use YYYY-MM-DD")
    return `${BASE}/volume/${q.date}${q.hourly === "1" ? "/hourly" : ""}`
  },

  // ── Rewards ──
  "maker-rebate-rates": (q) => {
    const sp = new URLSearchParams()
    if (q.category) {
      if (!isLabel(q.category)) throw new BadRequest("Invalid category")
      sp.set("category", q.category)
    }
    return `${BASE}/maker-rebate/rates${sp.toString() ? `?${sp}` : ""}`
  },
  "liquidity-rewards-config": () => `${BASE}/liquidity-rewards/config`,
  "liquidity-rewards-events": (q) => {
    const sp = new URLSearchParams()
    if (q.category) {
      // Upstream takes a single comma-separated list here, unlike /events.
      for (const c of String(q.category).split(",")) {
        if (c.trim() && !isLabel(c.trim())) throw new BadRequest("Invalid category")
      }
      sp.set("category", q.category)
    }
    if (q.search) {
      if (!isSearchText(q.search)) throw new BadRequest("Invalid search text")
      sp.set("search", q.search)
    }
    if (q.sort) {
      if (!isLabel(q.sort)) throw new BadRequest("Invalid sort")
      sp.set("sort", q.sort)
    }
    sp.set("limit", String(clampInt(q.limit, 1, 100, 50)))
    sp.set("offset", String(clampInt(q.offset, 0, 10000, 0)))
    return `${BASE}/liquidity-rewards/events?${sp}`
  },

  // ── Terms (public so clients can show them before an account accepts) ──
  terms: () => `${BASE}/terms`,
}

// Resources lib/gemini.js already implements, including the enrichment the
// browser wants (`_pending`/`_comparison` on a strike, `_fair_value` on a
// combo) — proxied through rather than re-fetched here.
const DELEGATES = {
  strike: (q) => gemini.getEventStrike(q.ticker),
  combos: (q) => (q.instrumentSymbol
    ? gemini.getCombo(q.instrumentSymbol)
    : gemini.listCombos({ limit: q.limit, offset: q.offset })),
}

function cacheGet(key) {
  const hit = _cache.get(key)
  if (!hit) return null
  if (Date.now() > hit.expires) { _cache.delete(key); return null }
  return hit.value
}

function cacheSet(key, ttl, value) {
  if (_cache.size >= CACHE_MAX_ENTRIES) _cache.clear()
  _cache.set(key, { expires: Date.now() + ttl, value })
}

// Resolves to { status, json } — never throws for upstream failures, so both
// callers can pass the result straight through to the client.
async function getGeminiPublic(resource, query = {}) {
  const delegate = DELEGATES[resource]
  if (delegate) {
    const { status, data, error } = await delegate(query)
    return { status, json: error ? { error } : data }
  }

  const build = RESOURCES[resource]
  if (!build) {
    return { status: 400, json: { error: `Unknown resource "${String(resource).slice(0, 40)}"` } }
  }

  let reqPath
  try {
    reqPath = build(query)
  } catch (err) {
    if (err instanceof BadRequest) return { status: 400, json: { error: err.message } }
    throw err
  }

  const cached = cacheGet(reqPath)
  if (cached) return { status: 200, json: cached }

  let res
  try {
    res = await gemini.fetchJson(reqPath)
  } catch (err) {
    return { status: 502, json: { error: err.message } }
  }

  let json
  try {
    json = JSON.parse(res.body)
  } catch {
    return { status: 502, json: { error: "Invalid response from Gemini API" } }
  }

  if (res.status !== 200) {
    // Reward programs answer 503 when a program is switched off — that's a
    // normal state for the UI, not an outage.
    return { status: res.status, json: json && typeof json === "object" ? json : { error: `Gemini API returned ${res.status}` } }
  }

  cacheSet(reqPath, CACHE_TTL_MS[resource] || DEFAULT_CACHE_TTL_MS, json)
  return { status: 200, json }
}

// Reduce an EventsResponse to the shape the Discover tab renders. The events
// list nests prices under contracts[].prices, so the top outcome is whichever
// contract has the highest last traded (or best ask) price.
function geminiEventsToDiscoverCards(payload, limit = 8) {
  const events = Array.isArray(payload) ? payload : (payload && payload.data) || []
  return events.slice(0, limit).map((e) => {
    const contracts = Array.isArray(e.contracts) ? e.contracts : []
    let top = null
    let topPrice = -1
    for (const c of contracts) {
      const p = c.prices || {}
      const price = parseFloat(p.lastTradePrice || p.bestAsk || p.bestBid || "")
      if (!isNaN(price) && price > topPrice) { topPrice = price; top = c }
    }
    const liquidity = parseFloat(e.liquidity)
    return {
      title: e.title || e.ticker || "Untitled",
      url: `https://www.gemini.com/predictions/${e.ticker || ""}`,
      volume: isNaN(liquidity) ? "" : Math.round(liquidity).toLocaleString("en-US"),
      topOutcome: top ? (top.abbreviatedName || top.label || top.ticker || "") : "",
      topPct: top && topPrice >= 0 ? Math.round(topPrice * 100) : "",
    }
  })
}

module.exports = {
  getGeminiPublic,
  geminiEventsToDiscoverCards,
  RESOURCE_NAMES: [...Object.keys(RESOURCES), ...Object.keys(DELEGATES)],
}
