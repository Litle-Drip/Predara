// ── "Where else is this event listed?" ────────────────────────────────────────
// Takes one event the reader is already looking at and finds the same event on
// the other venues, so a comparison is one click instead of three hand-pasted
// URLs. The scoring half — which candidates are actually the same event — is
// pure and lives in lib/match.js; this file is only the fetching.
//
// Three rules hold the design together:
//
//   1. Every venue is searched independently and failures are isolated. One
//      venue being down, unconfigured, or rate limited must leave the other
//      two answering, because a partial answer is the whole point of the
//      feature. Failures are reported per venue rather than swallowed.
//   2. Nothing is auto-selected. Candidates come back ranked and labelled with
//      a confidence and the reasons behind it; the reader picks. Silently
//      comparing the wrong event is worse than not finding it.
//   3. The top candidates are re-fetched in full before being ranked a second
//      time. A search result usually carries a title and little else, and a
//      title alone cannot separate this week's Grand Prix from last week's.

const { cached, cacheGet, cacheSet } = require("./guard")
const { getGeminiPublic } = require("./gemini-public")
// Plain HTTPS GET returning { status, body } — not Gemini-specific despite
// where it lives, and reused here rather than copied a third time.
const { fetchJson } = require("./gemini")
const { makeSignedGet } = require("./kalshi-auth")
const match = require("./match")

const SEARCH_CACHE_MS = 60 * 1000
const KALSHI_INDEX_CACHE_MS = 5 * 60 * 1000
// Kalshi publishes no text search, so its open events are paged into a local
// index. The cap bounds a cold build at ~12 signed calls, shared by every
// reader for the cache lifetime.
const KALSHI_INDEX_PAGES = 12
const KALSHI_PAGE_SIZE = 200
// A wall-clock stop as well as a page cap. The page cap bounds the number of
// calls; this bounds a cold build behind a slow upstream, which is what would
// otherwise eat the whole function timeout and return nothing at all. A partial
// index is a usable index — it is only ever used to filter titles.
const KALSHI_INDEX_BUDGET_MS = 12000
const KALSHI_PARTIAL_CACHE_MS = 30 * 1000
const ENRICH_TOP_N = 4

const PLATFORMS = ["kalshi", "polymarket", "gemini"]

function parseJson(body) {
  try { return JSON.parse(body) } catch { return null }
}

function jsonList(value, key) {
  if (Array.isArray(value)) return value
  if (value && Array.isArray(value[key])) return value[key]
  if (value && Array.isArray(value.data)) return value.data
  return []
}

// Polymarket serializes a market's outcomes as a JSON string inside JSON.
function parseEmbedded(value) {
  if (Array.isArray(value)) return value
  if (typeof value !== "string") return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

// ── Gemini ────────────────────────────────────────────────────────────────────
// The only venue of the three with a real text search on its public API, and
// the only searcher here whose upstream shape is exercised elsewhere in the
// codebase (lib/gemini-public.js, api/gemini-markets.js).
async function searchGemini(terms) {
  const { status, json } = await getGeminiPublic("events", {
    search: terms.join(" "),
    status: "active",
    limit: "24",
  })
  if (status !== 200) throw new Error(`Gemini search returned ${status}`)
  const events = jsonList(json, "events")
  return events.map(e => ({
    platform: "gemini",
    title: e.title || e.ticker || "",
    subtitle: e.subtitle || "",
    date: match.extractDate(e.expiryDate, e.closeTime, e.ticker),
    outcomes: (Array.isArray(e.contracts) ? e.contracts : [])
      .map(c => c.abbreviatedName || c.label || c.name || c.ticker || "")
      .filter(Boolean),
    url: `https://www.gemini.com/predictions/${e.ticker || ""}`,
    ref: e.ticker || "",
  })).filter(c => c.ref && c.title)
}

// ── Polymarket ────────────────────────────────────────────────────────────────
// public-search is the endpoint polymarket.com's own search box calls. It is
// not part of the documented gamma surface, so a failure there falls back to
// the documented event listing filtered locally — slower and shallower, but it
// uses only what api/polymarket.js already proves works.
async function searchPolymarket(terms) {
  const query = encodeURIComponent(terms.join(" "))
  let events = null
  try {
    const r = await fetchJson(
      `https://gamma-api.polymarket.com/public-search?q=${query}&limit_per_type=12&events_status=active`)
    if (r.status === 200) {
      const parsed = parseJson(r.body)
      const found = jsonList(parsed, "events")
      if (found.length) events = found
    }
  } catch { /* fall through to the documented listing */ }

  if (!events) {
    const r = await fetchJson(
      "https://gamma-api.polymarket.com/events?closed=false&active=true&order=volume&ascending=false&limit=100")
    if (r.status !== 200) throw new Error(`Polymarket search returned ${r.status}`)
    const all = jsonList(parseJson(r.body), "events")
    const wanted = new Set(terms)
    events = all.filter(e => match.titleTokens(e.title || "").some(t => wanted.has(t)))
  }

  return events.map(e => {
    const markets = Array.isArray(e.markets) ? e.markets : []
    const outcomes = []
    for (const m of markets) {
      const names = parseEmbedded(m.outcomes)
      // A multi-market event names each outcome in its own market question
      // ("Will Norris win?"); a single binary market names them inline.
      if (markets.length > 1 && m.groupItemTitle) outcomes.push(m.groupItemTitle)
      else outcomes.push(...names)
    }
    return {
      platform: "polymarket",
      title: e.title || "",
      subtitle: "",
      date: match.extractDate(e.endDate, e.slug, e.closedTime),
      outcomes: outcomes.filter(Boolean),
      url: `https://polymarket.com/event/${e.slug || ""}`,
      ref: e.slug || "",
    }
  }).filter(c => c.ref && c.title)
}

// ── Kalshi ────────────────────────────────────────────────────────────────────
// Kalshi's trade API has no text search, so open events are paged into a local
// index and filtered here. Signed calls are expensive, so the index is built
// once per cache window for all readers rather than once per search.
async function kalshiIndex(signedGet) {
  const KEY = "kalshi:open-events"
  const hit = cacheGet(KEY)
  if (hit) return hit

  const events = []
  const deadline = Date.now() + KALSHI_INDEX_BUDGET_MS
  let cursor = ""
  let complete = false
  for (let page = 0; page < KALSHI_INDEX_PAGES; page++) {
    if (Date.now() > deadline) break
    const qs = `status=open&limit=${KALSHI_PAGE_SIZE}&with_nested_markets=false` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "")
    const r = await signedGet(`/trade-api/v2/events?${qs}`)
    if (!r || r.status !== 200) break
    const data = parseJson(r.body)
    const batch = jsonList(data, "events")
    if (!batch.length) { complete = true; break }
    for (const e of batch) {
      events.push({
        event_ticker: e.event_ticker,
        title: e.title || "",
        sub_title: e.sub_title || "",
        strike_date: e.strike_date || "",
      })
    }
    cursor = (data && data.cursor) || ""
    if (!cursor) { complete = true; break }
  }
  if (!events.length) throw new Error("Kalshi returned no open events")

  // A build cut short by the deadline or the page cap is cached briefly rather
  // than for the full window: it is missing events, and a reader searching for
  // one of them should not be told "not found" for the next five minutes.
  cacheSet(KEY, events, complete ? KALSHI_INDEX_CACHE_MS : KALSHI_PARTIAL_CACHE_MS)
  return events
}

async function searchKalshi(terms, signedGet) {
  if (!signedGet) throw new Error("Kalshi credentials not configured")
  const index = await kalshiIndex(signedGet)
  const wanted = new Set(terms)
  return index
    .filter(e => match.titleTokens(`${e.title} ${e.sub_title}`).some(t => wanted.has(t)))
    .map(e => ({
      platform: "kalshi",
      title: e.title,
      subtitle: e.sub_title,
      date: match.extractDate(e.strike_date),
      outcomes: [],
      url: `https://kalshi.com/markets/${String(e.event_ticker || "").toLowerCase()}`,
      ref: e.event_ticker,
    }))
    .filter(c => c.ref && c.title)
}

// ── Enrichment ────────────────────────────────────────────────────────────────
// A Kalshi search result carries a title and, if the venue published one, a
// strike date — never an outcome list. Ranking on a title alone puts every race
// of the season in a tie, so the leading candidates are fetched in full and
// scored again with real data. Best-effort by design: a candidate that fails to
// enrich keeps its title-only score rather than disappearing.
async function enrichKalshi(candidates, signedGet) {
  await Promise.all(candidates.slice(0, ENRICH_TOP_N).map(async (c) => {
    try {
      const r = await signedGet(
        `/trade-api/v2/events/${encodeURIComponent(c.ref)}?with_nested_markets=true`)
      if (!r || r.status !== 200) return
      const event = (parseJson(r.body) || {}).event
      if (!event) return
      const markets = Array.isArray(event.markets) ? event.markets : []
      c.outcomes = markets.map(m => m.yes_sub_title || m.subtitle || "").filter(Boolean)
      c.date = match.extractDate(event.strike_date, markets[0] && markets[0].close_time) || c.date
    } catch { /* keep the unenriched candidate */ }
  }))
  return candidates
}

// ── Entry point ───────────────────────────────────────────────────────────────
// `source` describes the event the reader is already looking at:
//   { platform, title, subtitle, date, outcomes: string[] }
// Returns one entry per other venue, each either candidates or an error — never
// a thrown exception, so one dead venue cannot blank the whole card.
async function findCrossPlatform(source, deps = {}) {
  const terms = match.searchTerms(source, 4)
  if (!terms.length) {
    return { terms: [], results: PLATFORMS.filter(p => p !== source.platform)
      .map(platform => ({ platform, candidates: [], error: "Not enough to search on in this market's title" })) }
  }

  const signedGet = deps.signedGet !== undefined ? deps.signedGet : makeSignedGet()
  const searchers = {
    kalshi:     deps.searchKalshi     || (t => searchKalshi(t, signedGet)),
    polymarket: deps.searchPolymarket || searchPolymarket,
    gemini:     deps.searchGemini     || searchGemini,
  }
  // Coinbase is not searched: it resells Kalshi and Polymarket markets rather
  // than listing its own, so a Coinbase row would duplicate one of the others.
  const targets = PLATFORMS.filter(p => p !== source.platform)

  const settled = await Promise.all(targets.map(async (platform) => {
    const key = `xplat:${platform}:${terms.join("+")}`
    try {
      const { value } = await cached(key, SEARCH_CACHE_MS, () => searchers[platform](terms))
      let candidates = match.rankCandidates(source, value, 6)
      if (platform === "kalshi" && signedGet && candidates.length) {
        await enrichKalshi(candidates, signedGet)
        candidates = match.rankCandidates(source, candidates, 3)
      } else {
        candidates = candidates.slice(0, 3)
      }
      return { platform, candidates, error: null }
    } catch (err) {
      return { platform, candidates: [], error: err.message || "Search failed" }
    }
  }))

  return { terms, results: settled }
}

// ── Request shell ─────────────────────────────────────────────────────────────
// The caller already has the analyzed event on screen, so it describes the
// source in the query string rather than making the server fetch it twice.
// Shared by api/match.js and server.js so the two entrypoints cannot drift.

const SOURCE_PLATFORMS = ["kalshi", "polymarket", "gemini", "coinbase"]
const MAX_TITLE = 160
const MAX_OUTCOMES = 16
const MAX_OUTCOME_LEN = 64

function parseMatchQuery(query = {}) {
  const platform = String(query.platform || "").toLowerCase()
  if (!SOURCE_PLATFORMS.includes(platform)) {
    return { error: `platform must be one of ${SOURCE_PLATFORMS.join(", ")}` }
  }
  const title = String(query.title || "").slice(0, MAX_TITLE).trim()
  if (!title) return { error: "Missing title" }

  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(query.date || "")) ? String(query.date) : ""
  const outcomes = String(query.outcomes || "")
    .split("|")
    .map(o => o.slice(0, MAX_OUTCOME_LEN).trim())
    .filter(Boolean)
    .slice(0, MAX_OUTCOMES)

  return {
    source: {
      platform,
      title,
      subtitle: String(query.subtitle || "").slice(0, MAX_TITLE).trim(),
      date,
      outcomes,
    },
  }
}

async function handleMatchRequest(query, deps) {
  const parsed = parseMatchQuery(query)
  if (parsed.error) return { status: 400, error: parsed.error }
  const found = await findCrossPlatform(parsed.source, deps)
  return { status: 200, data: { source: parsed.source, ...found } }
}

module.exports = {
  findCrossPlatform,
  parseMatchQuery,
  handleMatchRequest,
  SOURCE_PLATFORMS,
  searchGemini,
  searchPolymarket,
  searchKalshi,
  kalshiIndex,
  enrichKalshi,
  PLATFORMS,
}
