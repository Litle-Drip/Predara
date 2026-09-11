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
const PARTIAL_SEARCH_CACHE_MS = 10 * 1000
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
// A venue's own search may reject a query shorter than this outright.
const MIN_QUERY_TERM_LEN = 3
// The documented listing is the fallback when public-search does not answer.
// One page ordered by volume only reaches the venue's biggest markets, which an
// ordinary sports market is not — so it pages.
const POLYMARKET_PAGE_SIZE = 100
const POLYMARKET_FALLBACK_PAGES = 6

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

// Runs each term as its own query and unions the results by identity.
//
// One joined query asks the venue for a listing containing *every* word the
// other venue used, which is precisely the thing cross-venue matching cannot
// assume. Separate queries ask for any of them, and the scoring downstream
// throws away whatever does not hold up — retrieval broad, scoring strict.
//
// One term failing never loses what the others found; every term failing still
// raises, or a dead endpoint would read as "no matches".
async function unionSearches(terms, run, identify) {
  // Very short terms are not sent upstream. "gp" and "f1" earn their place in
  // the term list for the *local* filters — the Kalshi index and the Polymarket
  // fallback both match titles in-process — but a venue's own search may reject
  // a two-character query outright. Gemini answers 400 to one, and before the
  // aliases were added no term was ever that short, which is why this worked
  // until it did not.
  const queryable = terms.filter(t => t.length >= MIN_QUERY_TERM_LEN)
  const asked = queryable.length ? queryable : terms
  // Callers guard this today, but the all-failed branch below reads
  // failures[0] and would throw a TypeError rather than say anything useful.
  if (!asked.length) return []

  const settled = await Promise.all(asked.map(t => run(t).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }))))

  // One term failing must never lose the results the others found. A search is
  // failed only when every term failed — anything less is a partial answer,
  // and a partial answer is the entire point of searching term by term.
  // Gemini used to throw on the first failure, so a single rejected query
  // turned a working venue into "Gemini search returned 400".
  const failures = settled.filter(r => !r.ok)
  if (failures.length === asked.length) throw failures[0].error

  const byId = new Map()
  for (const result of settled) {
    if (!result.ok) continue
    for (const item of result.value) {
      const id = identify(item)
      if (id && !byId.has(id)) byId.set(id, item)
    }
  }
  return [...byId.values()]
}

// ── Gemini ────────────────────────────────────────────────────────────────────
// The only venue of the three with a real text search on its public API, and
// the only searcher here whose upstream shape is exercised elsewhere in the
// codebase (lib/gemini-public.js, api/gemini-markets.js).
async function searchGemini(terms) {
  const events = await unionSearches(terms, async (term) => {
    const { status, json } = await getGeminiPublic("events", {
      search: term,
      status: "active",
      limit: "24",
    })
    if (status !== 200) throw new Error(`Gemini search returned ${status}`)
    return jsonList(json, "events")
  }, e => e.ticker)

  return events.map(geminiEventToCandidate).filter(c => c.ref && c.title)
}

// Kept separate so it can be tested against a real captured payload rather
// than against what this file assumes Gemini returns — which is how the field
// below came to be read in the wrong order.
function geminiEventToCandidate(e) {
  return {
    platform: "gemini",
    title: e.title || e.ticker || "",
    subtitle: e.subtitle || "",
    date: match.extractDate(e.expiryDate, e.closeTime, e.ticker),
    // `label` is the competitor's actual name ("Andrea Kimi Antonelli");
    // `abbreviatedName` is a three-letter code ("ANT"). Reading the code first
    // meant a Gemini listing shared no name with any other venue's, so the
    // "no competitor in common" rule threw away the correct match instead of
    // the wrong ones.
    outcomes: (Array.isArray(e.contracts) ? e.contracts : [])
      .map(c => c.label || c.name || c.abbreviatedName || c.ticker || "")
      .filter(Boolean),
    url: `https://www.gemini.com/predictions/${e.ticker || ""}`,
    ref: e.ticker || "",
  }
}

// ── Polymarket ────────────────────────────────────────────────────────────────
// public-search is the endpoint polymarket.com's own search box calls. It is
// not part of the documented gamma surface, so a failure there falls back to
// the documented event listing filtered locally — slower and shallower, but it
// uses only what api/polymarket.js already proves works.
async function searchPolymarket(terms) {
  // public-search is not part of the documented gamma surface, so every query
  // against it failing is the case the fallback below exists for — not a reason
  // to give up. Letting that throw made the fallback unreachable in precisely
  // the situation it was written for: an endpoint that is not there at all.
  let events = []
  try {
    events = await unionSearches(terms, async (term) => {
      const r = await fetchJson(
        `https://gamma-api.polymarket.com/public-search?q=${encodeURIComponent(term)}` +
        "&limit_per_type=12&events_status=active")
      if (r.status !== 200) throw new Error(`Polymarket search returned ${r.status}`)
      return jsonList(parseJson(r.body), "events")
    }, e => e.slug)
  } catch { events = [] }

  if (!events.length) {
    // Fall back to the documented listing and filter it here on the same terms.
    //
    // This used to read one page of 100 ordered by volume, which is not a
    // search at all: it asks whether the event is among the hundred biggest
    // markets on the venue. A Formula 1 race is not, so the race was never in
    // the pool to be considered and the card could only report that it had
    // checked some listings and rejected them. Paging goes deep enough for an
    // ordinary sports market to be reachable.
    const wanted = new Set(terms)
    const collected = []
    let cutShort = null
    for (let page = 0; page < POLYMARKET_FALLBACK_PAGES; page++) {
      const r = await fetchJson(
        "https://gamma-api.polymarket.com/events?closed=false&active=true" +
        `&order=volume&ascending=false&limit=${POLYMARKET_PAGE_SIZE}&offset=${page * POLYMARKET_PAGE_SIZE}`)
      if (r.status !== 200) {
        // A page that fails part-way through leaves the rest of the venue
        // unread. Stopping quietly here reported "none of them is this event"
        // for an event that may well sit on a page never fetched — a rate limit
        // rendered as a confident absence. The first page failing means there
        // is no search at all; a later one means the answer is incomplete and
        // has to say so.
        if (!page) throw new Error(`Polymarket search returned ${r.status}`)
        cutShort = `Polymarket returned ${r.status} partway through — some listings were not checked`
        break
      }
      const batch = jsonList(parseJson(r.body), "events")
      if (!batch.length) break
      for (const e of batch) {
        if (match.searchTokens(e.title || "").some(t => wanted.has(t))) collected.push(e)
      }
    }
    events = collected
    if (cutShort) events.incomplete = cutShort
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
    .filter(e => match.searchTokens(`${e.title} ${e.sub_title}`).some(t => wanted.has(t)))
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
// Polymarket search results do not reliably carry an outcome list, and without
// one the "no competitor in common" rule cannot fire — which is how a cycling
// race was offered as a match for a Formula 1 Grand Prix. The documented
// /events?slug= lookup returns the full event, so the leading candidates are
// filled in before the final ranking. Best-effort: a candidate that fails to
// enrich keeps the score it already had.
async function enrichPolymarket(candidates) {
  await Promise.all(candidates.slice(0, ENRICH_TOP_N).map(async (c) => {
    // Listings are cached and enriched in place, so a second search over the
    // same terms must not re-fetch what is already there.
    if ((c.outcomes || []).length) return
    try {
      const r = await fetchJson(
        `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(c.ref)}`)
      if (r.status !== 200) return
      const event = jsonList(parseJson(r.body), "events")[0]
      if (!event) return
      const markets = Array.isArray(event.markets) ? event.markets : []
      const outcomes = []
      for (const m of markets) {
        if (markets.length > 1 && m.groupItemTitle) outcomes.push(m.groupItemTitle)
        else outcomes.push(...parseEmbedded(m.outcomes))
      }
      if (outcomes.length) c.outcomes = outcomes.filter(Boolean)
      c.date = match.extractDate(event.endDate, event.slug) || c.date
    } catch { /* keep the unenriched candidate */ }
  }))
  return candidates
}

async function enrichKalshi(candidates, signedGet) {
  await Promise.all(candidates.slice(0, ENRICH_TOP_N).map(async (c) => {
    if ((c.outcomes || []).length) return
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
  // No cap of its own: searchTerms() decides how many terms are worth sending,
  // and a second number here silently truncated the list — the competitor's
  // name pushed everything down one and "prix" fell off the end.
  const terms = match.searchTerms(source)
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
      // Not `cached()`: a search cut short by a rate limit must not sit in the
      // cache for the full window claiming the venue does not list the event.
      let listings = cacheGet(key)
      if (!listings) {
        listings = await searchers[platform](terms)
        cacheSet(key, listings, listings.incomplete ? PARTIAL_SEARCH_CACHE_MS : SEARCH_CACHE_MS)
      }

      // Enrich the listings themselves, before anything is scored.
      //
      // This used to rank first and enrich the survivors, which was wrong twice
      // over. rankCandidates() returns copies, so the enrichment never reached
      // the listings that closestTitles() reads, leaving every Kalshi listing at
      // outcomes: [] and the "closest" sample ordered by title alone. And only
      // survivors were enriched at all — so a correct match carrying neither a
      // shared title word nor a strike date was disqualified for lacking
      // exactly the facts the enrichment would have supplied. The data has to
      // arrive before the judgement, not after it.
      const toEnrich = topByCloseness(source, listings, ENRICH_TOP_N)
      if (toEnrich.length) {
        if (platform === "kalshi" && signedGet) await enrichKalshi(toEnrich, signedGet)
        if (platform === "polymarket" && !deps.searchPolymarket) await enrichPolymarket(toEnrich)
      }
      const candidates = match.rankCandidates(source, listings, 3)

      // What the search actually did, carried back so an empty result can say
      // which half of the job came up short. "Nothing listed under these words"
      // and "plenty listed, none of them this event" are different problems
      // with different fixes, and without this they render identically as
      // "no matching event found" — which is how three rounds of reporting
      // went by without anyone being able to tell them apart.
      return {
        platform,
        candidates,
        error: null,
        searched: terms,
        listingsFound: listings.length,
        incomplete: listings.incomplete || null,
        // Naming a few of the listings that were checked and rejected turns
        // "none of them is this event" from a dead end into something anyone
        // can act on: either the right event is in the list and the scoring is
        // wrong, or it is absent and the search is. Counting them was not
        // enough to tell those apart.
        //
        // The *closest* ones, not the first three the venue happened to return.
        // An arbitrary sample reported "Saanich, BC Mayoral Election Winner"
        // next to a Formula 1 race — true, since it did match the word
        // "winner", and useless. The near misses are what say whether the
        // event is missing from the venue or being misjudged.
        checkedTitles: closestTitles(source, listings, 3),
      }
    } catch (err) {
      return {
        platform,
        candidates: [],
        error: err.message || "Search failed",
        searched: terms,
        listingsFound: 0,
        checkedTitles: [],
      }
    }
  }))

  return { terms, results: settled }
}

// The listings that came nearest, scored but not filtered — a disqualified
// candidate is exactly the interesting one here, because it says what the venue
// does carry in place of the event being looked for.
// The listings that came nearest, as references rather than copies, so
// enriching them is visible to everything downstream.
function topByCloseness(source, listings, limit) {
  return (listings || [])
    .map(l => ({ listing: l, near: closeness(source, l) }))
    .sort((a, b) => b.near - a.near)
    .slice(0, limit)
    .map(x => x.listing)
}

function closestTitles(source, listings, limit) {
  return (listings || [])
    .filter(l => l.title)
    .map(l => ({ title: l.title, near: closeness(source, l) }))
    .sort((a, b) => b.near - a.near)
    .slice(0, limit)
    .map(l => l.title)
}

// Raw similarity, deliberately ignoring every disqualifier that scoreMatch()
// applies. Ranking rejects by their score cannot order them at all: a
// disqualified candidate scores zero whether it was the season championship for
// the right sport or a municipal election that happened to contain the word
// "winner". Both were reported as equally close, which is how the mayoral
// election ended up named next to a Formula 1 race.
//
// Shared competitors weigh heaviest: a listing naming the same people is about
// the same subject even when it is a different market about it, which is
// exactly what a reader needs to see.
function closeness(source, listing) {
  const titleOverlap = match.overlapRatio(
    new Set(match.titleTokens(`${source.title || ""} ${source.subtitle || ""}`)),
    new Set(match.titleTokens(`${listing.title || ""} ${listing.subtitle || ""}`))) || 0
  const outcomeOverlap = match.overlapRatio(
    match.outcomeKeys(source.outcomes),
    match.outcomeKeys(listing.outcomes)) || 0
  return outcomeOverlap * 0.6 + titleOverlap * 0.4
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
  unionSearches,
  topByCloseness,
  geminiEventToCandidate,
  enrichPolymarket,
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
