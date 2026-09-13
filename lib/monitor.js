// ── Prediction Markets Monitor ────────────────────────────────────────────────
// Platform-wide book-quality metrics for Gemini's prediction markets: quote
// coverage, bid-ask spread, event overround and dutch books, 24h volume, and
// per-category rollups.
//
// Every metric here comes from the PUBLIC event feed. `GET /events` returns each
// event with its `contracts` array and each contract's top-of-book `prices`, so
// one paginated sweep (100 events a page) answers the whole dashboard without a
// per-event fetch.
//
// What this deliberately does NOT compute, and why:
//
//   • Order-book DEPTH, and everything built on it — bid/ask depth in dollars,
//     depth imbalance, and the drought/one-sided/skewed/thin signals. The public
//     feed carries top-of-book PRICES with no sizes attached, and multi-level
//     `contractOrderbooks` appear only on the per-event endpoint (see
//     lib/gemini.js getEvent), which would be one call per event with nowhere to
//     persist the result. A depth figure cannot be derived from a price, so none
//     is reported.
//   • A trade or quote tape. That needs the WebSocket streams lib/gemini.js
//     deliberately does not implement, plus a process that outlives a serverless
//     invocation.
//
// The rule throughout: a metric that cannot be computed is returned as null
// alongside the reason it is null. It is never filled in with a plausible
// substitute, because a made-up book-quality number is worse than a blank one.

const { listEvents, toNumber } = require("./gemini")
const { getGeminiPublic } = require("./gemini-public")
const { cached } = require("./guard")

const PAGE_SIZE = 100          // upstream's own maximum for /events
const MAX_PAGES = 12           // 1200 events; bounds one sweep's upstream cost
const SNAPSHOT_CACHE_MS = 60 * 1000
const VOLUME_CACHE_MS = 30 * 60 * 1000
const DEFAULT_ROW_LIMIT = 1500
const MAX_ROW_LIMIT = 5000
const DEFAULT_HISTORY_DAYS = 7
const MAX_HISTORY_DAYS = 14

// A contract in one of these states is no longer quotable, so counting it as
// "listed but unquoted" would drag coverage down for markets that have simply
// finished. Anything unrecognized is treated as live — a new status string
// should not silently delete contracts from the denominator.
const DEAD_STATUSES = new Set([
  "settled", "closed", "cancelled", "canceled", "expired", "voided", "resolved",
])

// Only a one-winner event has an overround. See eventOverround below.
const ONE_WINNER_TEMPLATE = "categorical"

// An overround outside ±100% would mean the outcomes of a one-winner market
// collectively cost either more than $2.00 or less than $0.00 for a basket that
// returns exactly $1.00. No venue runs a margin like that, so a value out here
// is far more likely a market whose legs are not actually mutually exclusive
// (a `template` that does not match the market's real payout rule) than a real
// margin. Such events are counted and surfaced as a data-quality flag rather
// than averaged in: one mislabelled 20-leg market would otherwise drag the
// headline platform average to a number nobody could defend.
const OVERROUND_PLAUSIBLE_LIMIT = 1

// An average over a handful of events does not describe a platform, and against
// live data that is the normal case rather than the edge: at 71% quote coverage
// almost every multi-leg market has at least one unquoted leg, so a sweep of 976
// events produced ONE eligible event and the dashboard still printed its
// overround as a platform figure ("+57.0%"). Below this many eligible events the
// average is withheld and the exclusion breakdown is shown instead — a blank
// with a reason is worth more than a number nobody should quote.
const OVERROUND_MIN_SAMPLE = 10

// Why an event was left out of the overround average. Reported as counts so the
// page can say what happened instead of only how few survived.
function overroundExclusionKey(summary) {
  if (summary.overroundPlausible) return null
  if (summary.overroundEligible) return "implausible"
  const reason = summary.overroundReason || ""
  if (reason.includes("single-winner")) return "notSingleWinner"
  if (reason.includes("not every outcome")) return "legUnquoted"
  if (reason.includes("fewer than two")) return "tooFewContracts"
  return "other"
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function round(n, places) {
  if (n === null || !Number.isFinite(n)) return null
  const f = 10 ** places
  return Math.round(n * f) / f
}

// Upstream sends "no quote" three ways: the field is absent, `prices.buy`/`sell`
// come back as empty objects, or the price is zero. Zero is not a real quote —
// you cannot bid nothing — so all three collapse to null here.
function positivePrice(value) {
  const n = toNumber(value)
  return n !== null && n > 0 ? n : null
}

function isLive(entity) {
  return !DEAD_STATUSES.has(String((entity && entity.status) || "").toLowerCase())
}

function contractsOf(event) {
  return Array.isArray(event && event.contracts) ? event.contracts : []
}

// The events feed has been seen both as a bare array and wrapped in `{ data }`,
// which is why lib/gemini-public.js tolerates both. Same tolerance here.
function eventsOf(payload) {
  if (Array.isArray(payload)) return payload
  if (payload && Array.isArray(payload.data)) return payload.data
  if (payload && Array.isArray(payload.events)) return payload.events
  return []
}

function parseTime(value) {
  if (value === null || value === undefined) return null
  const t = typeof value === "number" ? value : Date.parse(String(value))
  return Number.isFinite(t) ? t : null
}

// ── Per-contract quote ────────────────────────────────────────────────────────

// Reads one contract's top of book. `bestBid`/`bestAsk` are the YES side; the NO
// side is their exact complement (see lib/gemini.js complementPrice), so the
// "cost to buy both sides" of a single contract is arithmetically identical to
// its spread and is not reported as a separate metric.
function readQuote(contract) {
  const prices = (contract && contract.prices) || {}
  const bid = positivePrice(prices.bestBid)
  const ask = positivePrice(prices.bestAsk)
  const twoSided = bid !== null && ask !== null
  return {
    bid,
    ask,
    last: positivePrice(prices.lastTradePrice),
    quoted: bid !== null || ask !== null,
    twoSided,
    // Only a two-sided book has a spread. Filling the missing side in with 0 or
    // 1 would report a spread no trader could ever cross, and would quietly
    // make the platform average depend on how many books are half-empty.
    // A negative value is kept as-is: that is a crossed book, which is signal.
    spread: twoSided ? round(ask - bid, 4) : null,
  }
}

// ── Event overround ───────────────────────────────────────────────────────────
//
// Overround is the bookmaker's margin: buy every outcome at its ask and you pay
// `Σ ask` for a basket that is certain to return exactly $1.00. So
// `Σ ask − 1` is the margin, and a NEGATIVE value is a dutch book — a risk-free
// profit sitting on the public feed.
//
// That arithmetic only holds when exactly one of the event's contracts can win,
// and Gemini's own payloads distinguish the two cases in `template`, not `type`:
// the F1 race-winner market and the F1 podium market are BOTH
// `type: "categorical"`, but the winner market is `template: "categorical"`
// (one winner across all contracts) while the podium is `template: "binary"` —
// 22 independent yes/no contracts, three of which pay out. Summing asks across a
// podium would report a ~200% "overround" that means nothing, and would pull the
// platform average with it. See tests/fixtures/gemini-settled-podium.json.
//
// So only `template: "categorical"` events are eligible, and every leg must be
// offered: a missing ask read as zero would understate the sum and invent a
// dutch book that is not there. A false arbitrage signal is the one error this
// metric must never make, because someone would act on it.
function eventOverround(event) {
  const contracts = contractsOf(event).filter(isLive)
  if (contracts.length < 2) {
    return { value: null, eligible: false, reason: "fewer than two live contracts" }
  }

  const template = String((event && event.template) || "").toLowerCase()
  if (template !== ONE_WINNER_TEMPLATE) {
    return {
      value: null,
      eligible: false,
      reason: `template "${template || "unknown"}" is not a single-winner market`,
    }
  }

  let sum = 0
  for (const contract of contracts) {
    const { ask } = readQuote(contract)
    if (ask === null) {
      return { value: null, eligible: false, reason: "not every outcome is offered" }
    }
    sum += ask
  }

  return { value: round(sum - 1, 4), eligible: true, reason: null, legs: contracts.length }
}

// ── Event volume ──────────────────────────────────────────────────────────────

// `volume24h` is the figure the dashboard wants. `volume` (cumulative) is
// accepted as a labelled fallback so a feed without the 24h field still shows
// something true. `liquidity` is NOT used: it measures resting size, not traded
// notional, and substituting it would report a volume number that is not volume.
function eventVolume(event) {
  const v24 = toNumber(event && event.volume24h)
  if (v24 !== null) return { value: v24, field: "volume24h" }
  const total = toNumber(event && event.volume)
  if (total !== null) return { value: total, field: "volume" }
  return { value: null, field: null }
}

// ── Summarizing one event ─────────────────────────────────────────────────────

function summarizeEvent(event, now) {
  const allContracts = contractsOf(event)
  const contracts = allContracts.filter(isLive)
  const quotes = contracts.map((c) => ({ contract: c, quote: readQuote(c) }))

  const quoted = quotes.filter((q) => q.quote.quoted).length
  const spreads = quotes.map((q) => q.quote.spread).filter((s) => s !== null)
  const overround = eventOverround(event)
  const volume = eventVolume(event)
  const expiry = parseTime(event && event.expiryDate)

  return {
    ticker: (event && event.ticker) || null,
    title: (event && event.title) || (event && event.ticker) || "Untitled",
    category: (event && event.category) || "Uncategorized",
    subcategory: (event && event.subcategory) || null,
    template: (event && event.template) || null,
    type: (event && event.type) || null,
    status: (event && event.status) || null,
    live: isLive(event) && contracts.length > 0,
    contractsListed: contracts.length,
    contractsSettled: allContracts.length - contracts.length,
    contractsQuoted: quoted,
    contractsTwoSided: spreads.length,
    // A bid above the ask. Counted here rather than derived from the capped
    // contract rows, so the figure covers the whole sweep.
    crossed: spreads.filter((s) => s < 0).length,
    // The unrounded sum travels alongside the mean so a consumer can re-roll
    // these events into any grouping and get the same number the platform
    // average has — averaging the per-event averages would not.
    spreadSum: spreads.length ? spreads.reduce((a, b) => a + b, 0) : 0,
    avgSpread: spreads.length ? round(spreads.reduce((a, b) => a + b, 0) / spreads.length, 4) : null,
    overround: overround.value,
    overroundEligible: overround.eligible,
    overroundReason: overround.reason,
    // Eligible and inside the plausible band — the average uses only these.
    overroundPlausible: overround.eligible && overround.value !== null &&
      Math.abs(overround.value) <= OVERROUND_PLAUSIBLE_LIMIT,
    dutchBook: overround.eligible && overround.value !== null &&
      overround.value < 0 && Math.abs(overround.value) <= OVERROUND_PLAUSIBLE_LIMIT,
    volume: volume.value,
    volumeField: volume.field,
    expiry: expiry ? new Date(expiry).toISOString() : null,
    expiringSoon: expiry !== null && expiry > now && expiry - now <= 86400000,
    quotes,
  }
}

// ── Rollups ───────────────────────────────────────────────────────────────────

function blankRollup(name) {
  return {
    category: name,
    events: 0,
    liveEvents: 0,
    contractsListed: 0,
    contractsQuoted: 0,
    contractsTwoSided: 0,
    crossed: 0,
    _spreadSum: 0,
    _overroundSum: 0,
    overroundEligibleEvents: 0,
    overroundImplausibleEvents: 0,
    overroundExcluded: { notSingleWinner: 0, legUnquoted: 0, tooFewContracts: 0, implausible: 0, other: 0 },
    // Field size matters for reading the number: on a 100-runner market the sum
    // of asks is dominated by longshots sitting at the minimum tick, so a large
    // "margin" there is a granularity artefact rather than a spread the venue
    // is charging. The page shows the field size alongside the figure.
    overroundMaxLegs: 0,
    dutchBooks: 0,
    volume: 0,
    volumeEvents: 0,
    expiring24h: 0,
  }
}

function finishRollup(r) {
  const { _spreadSum, _overroundSum, ...rest } = r
  return {
    ...rest,
    coverage: r.contractsListed ? round(r.contractsQuoted / r.contractsListed, 4) : null,
    avgSpread: r.contractsTwoSided ? round(_spreadSum / r.contractsTwoSided, 4) : null,
    avgOverround: r.overroundEligibleEvents
      ? round(_overroundSum / r.overroundEligibleEvents, 4)
      : null,
    // Published so an API consumer inherits the judgment rather than having to
    // remember to check the sample size themselves.
    overroundRepresentative: r.overroundEligibleEvents >= OVERROUND_MIN_SAMPLE,
    volume: r.volumeEvents ? round(r.volume, 2) : null,
  }
}

function accumulate(target, summary, spreadSum) {
  target.events += 1
  if (summary.live) target.liveEvents += 1
  target.contractsListed += summary.contractsListed
  target.contractsQuoted += summary.contractsQuoted
  target.contractsTwoSided += summary.contractsTwoSided
  target.crossed += summary.crossed
  target._spreadSum += spreadSum
  if (summary.overroundPlausible) {
    target._overroundSum += summary.overround
    target.overroundEligibleEvents += 1
    target.overroundMaxLegs = Math.max(target.overroundMaxLegs, summary.contractsListed)
    if (summary.dutchBook) target.dutchBooks += 1
  } else {
    if (summary.overroundEligible && summary.overround !== null) target.overroundImplausibleEvents += 1
    const key = overroundExclusionKey(summary)
    if (key) target.overroundExcluded[key] += 1
  }
  if (summary.volume !== null) {
    target.volume += summary.volume
    target.volumeEvents += 1
  }
  if (summary.expiringSoon) target.expiring24h += 1
}

// Turns a list of raw events into the whole dashboard payload. Pure — every
// number the UI shows is computed here so it can be tested without a network.
function summarize(rawEvents, { rowLimit = DEFAULT_ROW_LIMIT, now = Date.now() } = {}) {
  const limit = Math.max(0, Math.min(MAX_ROW_LIMIT, rowLimit))
  const platform = blankRollup("__platform__")
  const byCategory = new Map()
  const events = []
  const dutchBooks = []
  let contractRowsTotal = 0
  const candidateRows = []
  // Which volume field the totals came from. Mixing cumulative volume into a
  // "24h" number would be a silent lie, so a mixed feed reports the weaker of
  // the two and says so.
  const volumeFields = new Set()

  for (const raw of rawEvents) {
    const summary = summarizeEvent(raw, now)

    accumulate(platform, summary, summary.spreadSum)
    if (!byCategory.has(summary.category)) byCategory.set(summary.category, blankRollup(summary.category))
    accumulate(byCategory.get(summary.category), summary, summary.spreadSum)

    if (summary.volumeField) volumeFields.add(summary.volumeField)
    if (summary.dutchBook) {
      dutchBooks.push({
        ticker: summary.ticker,
        title: summary.title,
        category: summary.category,
        overround: summary.overround,
        legs: summary.contractsListed,
      })
    }

    contractRowsTotal += summary.contractsListed
    for (const { contract, quote } of summary.quotes) {
      candidateRows.push({
        event: summary.title,
        eventTicker: summary.ticker,
        category: summary.category,
        contract: contract.abbreviatedName || contract.label || contract.ticker || "—",
        symbol: contract.instrumentSymbol || contract.ticker || null,
        bid: quote.bid,
        ask: quote.ask,
        last: quote.last,
        spread: quote.spread,
        expiry: summary.expiry,
        eventVolume: summary.volume,
        // Sort key: the widest spread on the busiest event is what an operator
        // wants at the top, and an unquoted contract is itself worth seeing.
        _rank: (summary.volume || 0) * 1e-6 + (quote.spread === null ? 1 : quote.spread),
      })
    }

    const { quotes, ...eventOut } = summary
    events.push(eventOut)
  }

  candidateRows.sort((a, b) => b._rank - a._rank)
  const rows = candidateRows.slice(0, limit).map(({ _rank, ...row }) => row)

  const finished = finishRollup(platform)
  const categories = [...byCategory.values()]
    .map(finishRollup)
    .sort((a, b) => (b.volume || 0) - (a.volume || 0) || b.contractsListed - a.contractsListed)

  return {
    generatedAt: new Date(now).toISOString(),
    totals: {
      events: finished.events,
      liveEvents: finished.liveEvents,
      contractsListed: finished.contractsListed,
      contractsQuoted: finished.contractsQuoted,
      contractsTwoSided: finished.contractsTwoSided,
      crossed: finished.crossed,
      coverage: finished.coverage,
      avgSpread: finished.avgSpread,
      avgOverround: finished.avgOverround,
      overroundEligibleEvents: finished.overroundEligibleEvents,
      overroundImplausibleEvents: finished.overroundImplausibleEvents,
      overroundRepresentative: finished.overroundRepresentative,
      overroundExcluded: finished.overroundExcluded,
      overroundMaxLegs: finished.overroundMaxLegs,
      dutchBooks: finished.dutchBooks,
      volume: finished.volume,
      volumeEvents: finished.volumeEvents,
      // "volume24h" when every contributing event reported the 24h field;
      // "volume" when any fell back to cumulative. The UI labels it from here
      // rather than assuming.
      volumeField: volumeFields.has("volume") ? "volume" : (volumeFields.has("volume24h") ? "volume24h" : null),
      expiring24h: finished.expiring24h,
    },
    categories,
    events,
    dutchBooks: dutchBooks.sort((a, b) => a.overround - b.overround),
    rows,
    rowsTotal: contractRowsTotal,
    rowsShown: rows.length,
  }
}

// ── Upstream sweep ────────────────────────────────────────────────────────────

// Pages through /events until a short page says the feed is exhausted. A page
// that fails mid-sweep returns what it has with `complete: false` and the error
// attached — a partial sweep understates every count, so the caller has to be
// able to say so rather than presenting the shortfall as the platform's state.
//
// `fetchPage` is injectable so the partial-sweep and page-cap paths can be
// tested without a network. Production always uses lib/gemini.js listEvents.
async function fetchAllEvents({ maxPages = MAX_PAGES, status, fetchPage = listEvents } = {}) {
  const events = []
  const warnings = []
  let pages = 0

  for (let page = 0; page < maxPages; page++) {
    const result = await fetchPage({ status, limit: PAGE_SIZE, offset: page * PAGE_SIZE })
    if (result.error) {
      warnings.push(`Event feed failed after ${pages} page(s): ${result.error}`)
      return { events, pages, complete: false, warnings }
    }

    const batch = eventsOf(result.data)
    pages += 1
    events.push(...batch)

    if (batch.length < PAGE_SIZE) return { events, pages, complete: true, warnings }
  }

  warnings.push(
    `Stopped at the ${maxPages}-page sweep cap (${events.length} events). Totals below ` +
    "cover only what was fetched.")
  return { events, pages, complete: false, warnings }
}

// ── Rolling volume history ────────────────────────────────────────────────────

// `periodStart` is what the live endpoint actually sends. It was missing from
// this list, so every row's hour was unreadable and the chart fell back to
// inventing one — see normalizeHour.
const HOUR_KEYS = ["periodStart", "hour", "hourStartTime", "hourStart", "timestamp", "time", "startTime", "date"]
const VOLUME_KEYS = ["volume", "notional", "totalVolume", "total", "value", "amount", "quoteVolume"]

function firstNumeric(obj, keys) {
  for (const key of keys) {
    if (obj[key] !== undefined) {
      const n = toNumber(obj[key])
      if (n !== null) return n
    }
  }
  return null
}

function firstDefined(obj, keys) {
  for (const key of keys) if (obj[key] !== undefined) return obj[key]
  return undefined
}

// The hourly volume endpoint's exact response shape is not pinned down by a
// captured fixture, so this reads it structurally rather than by a guessed
// schema: any array of objects carrying an hour-ish key and a volume-ish key,
// or a plain { "00": 1234 } map. Anything it cannot read becomes `available:
// false` with a reason, so the chart says "unavailable" instead of plotting a
// shape that happened to parse.
// The hourly volume rows are a NESTED HIERARCHY, not a flat list. Each row
// carries a `categoryPath`, and a parent row already contains its children:
//
//   ["Sports"]                       43915.83   <- the rollup
//   ["Sports","Pro Football"]         4261.52
//   ["Sports","Pro Baseball"]        14321.95
//   ["Sports","College Football"]     7666.87
//   ["Sports","Tennis"]              15800.61
//   ["Sports","Tennis","US Open"]    15800.61   <- already inside Tennis
//   ["Sports","Soccer"]               1284.00
//   ["Sports","MMA"]                   580.88
//
// The depth-2 rows sum to exactly the depth-1 total, and the depth-3 row is
// already inside its depth-2 parent. Summing every row therefore double- and
// triple-counts: 2.36x on this one hour of one category. That is how the panel
// reported $21.84M over seven days while the events feed showed $1.49M a day.
//
// So only the shallowest depth present is summed — those are the top-level
// totals — and the deeper rows are kept as the per-category breakdown, which
// the chart stacks. Taking the minimum depth observed rather than hardcoding 1
// means a response that starts deeper still totals correctly.
function categoryPathOf(entry) {
  const path = entry && entry.categoryPath
  if (Array.isArray(path)) return path.map((p) => String(p))
  // A flat response carries no hierarchy, so every row is a top-level row.
  if (typeof path === "string" && path) return [path]
  return null
}

function parseHourlyVolume(payload, date) {
  const container = Array.isArray(payload)
    ? payload
    : (payload && (payload.hourly || payload.data || payload.hours || payload.buckets)) || null

  // Rows carrying a readable hour and a volume, paired with their nesting depth.
  const parsed = []
  let unresolved = 0

  if (Array.isArray(container)) {
    const rows = container.filter((e) => e && typeof e === "object" && firstNumeric(e, VOLUME_KEYS) !== null)
    rows.forEach((entry, i) => {
      const hour = normalizeHour(firstDefined(entry, HOUR_KEYS), date, i, rows.length)
      if (hour === null) { unresolved += 1; return }
      const path = categoryPathOf(entry)
      parsed.push({ hour, volume: firstNumeric(entry, VOLUME_KEYS), path, depth: path ? path.length : 1 })
    })
  } else if (container && typeof container === "object") {
    // A plain { "00": 1234 } map: no hierarchy, one row per hour.
    const rows = Object.entries(container).filter(([, v]) => toNumber(v) !== null)
    rows.forEach(([key, value], i) => {
      const hour = normalizeHour(key, date, i, rows.length)
      if (hour === null) { unresolved += 1; return }
      parsed.push({ hour, volume: toNumber(value), path: null, depth: 1 })
    })
  }

  if (!parsed.length) return null

  // Only the shallowest rows are totals; anything deeper is already inside one.
  const minDepth = Math.min(...parsed.map((r) => r.depth))
  const totals = parsed.filter((r) => r.depth === minDepth)
  const nested = parsed.length - totals.length

  const byHour = new Map()
  for (const row of totals) {
    if (!byHour.has(row.hour)) byHour.set(row.hour, { volume: 0, byCategory: {} })
    const bucket = byHour.get(row.hour)
    bucket.volume += row.volume
    if (row.path) {
      const name = row.path[row.path.length - 1]
      bucket.byCategory[name] = round((bucket.byCategory[name] || 0) + row.volume, 2)
    }
  }

  const buckets = [...byHour.entries()]
    .map(([hour, b]) => ({ hour, volume: round(b.volume, 2), byCategory: b.byCategory }))
    .sort((a, b) => a.hour - b.hour)

  return {
    date,
    buckets,
    total: round(buckets.reduce((a, b) => a + b.volume, 0), 2),
    // All surfaced rather than swallowed, so the page can say what it left out
    // and a reader can audit the total against the raw feed.
    unresolved,
    nestedRowsSkipped: nested,
    depthUsed: minDepth,
  }
}

// Resolves an hour to an epoch millisecond, or null when it cannot be resolved.
//
// Returning null matters. This used to fall back to `dayStart + index * 1h`,
// which reads as harmless until a day's container holds more than 24 entries —
// a per-category breakdown, say. Then the index runs past 23 and invents hours
// days into the future: seven requested days stretched across a ~33-day axis,
// and the chart plotted a real-looking series on fabricated timestamps. A made-
// up x-axis is worse than a missing chart, so an unresolvable hour is dropped
// and counted rather than guessed.
//
// The positional fallback survives only where position genuinely implies the
// hour: a container of exactly 24 entries, one per hour of the day.
function normalizeHour(raw, date, index, total) {
  const dayStart = Date.parse(`${date}T00:00:00Z`)
  const dayEnd = dayStart + 24 * 3600000

  const asInt = toNumber(raw)
  if (asInt !== null && Number.isInteger(asInt) && asInt >= 0 && asInt <= 23) {
    return dayStart + asInt * 3600000
  }

  // An explicit timestamp is trusted only if it actually falls inside the day
  // that was requested — anything else means the field was misread.
  const parsed = parseTime(raw)
  if (parsed !== null) return parsed >= dayStart && parsed < dayEnd ? parsed : null

  if (raw === undefined && total === 24) return dayStart + index * 3600000
  return null
}

// The most recent COMPLETED UTC days, oldest first. Today is excluded: upstream
// answers 404 for a day still in progress (see lib/gemini-public.js).
function completedUtcDays(count, now = Date.now()) {
  const days = []
  for (let i = count; i >= 1; i--) {
    days.push(new Date(now - i * 86400000).toISOString().slice(0, 10))
  }
  return days
}

async function fetchVolumeHistory({ days = DEFAULT_HISTORY_DAYS, now = Date.now() } = {}) {
  const wanted = Math.max(1, Math.min(MAX_HISTORY_DAYS, days))
  const dates = completedUtcDays(wanted, now)

  const settled = await Promise.all(dates.map(async (date) => {
    try {
      const { status, json } = await getGeminiPublic("volume", { date, hourly: "1" })
      if (status !== 200) return { date, error: `upstream ${status}` }
      const parsed = parseHourlyVolume(json, date)
      return parsed ? { date, ...parsed } : { date, error: "unrecognized response shape" }
    } catch (err) {
      return { date, error: err.message }
    }
  }))

  const usable = settled.filter((d) => !d.error)
  const failures = settled.filter((d) => d.error)

  if (!usable.length) {
    return {
      available: false,
      reason: failures.length
        ? `no hourly volume could be read (${failures[0].error})`
        : "no days requested",
      days: [],
      buckets: [],
    }
  }

  const buckets = usable.flatMap((d) => d.buckets).sort((a, b) => a.hour - b.hour)
  const unresolved = usable.reduce((n, d) => n + (d.unresolved || 0), 0)

  // Top-level categories, ordered by total volume across the window, so the
  // chart can stack them in a stable order rather than by whatever each hour
  // happened to contain.
  const categoryTotals = new Map()
  for (const bucket of buckets) {
    for (const [name, volume] of Object.entries(bucket.byCategory || {})) {
      categoryTotals.set(name, (categoryTotals.get(name) || 0) + volume)
    }
  }
  const categories = [...categoryTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, total]) => ({ name, total: round(total, 2) }))

  return {
    available: true,
    days: usable.map(({ date, total }) => ({ date, total })),
    // The axis is drawn from the requested window, not from whatever timestamps
    // came back, so a misread hour field can never stretch the time axis again.
    window: { start: `${dates[0]}T00:00:00.000Z`, end: new Date(Date.parse(`${dates[dates.length - 1]}T00:00:00Z`) + 24 * 3600000).toISOString() },
    buckets,
    categories,
    total: round(buckets.reduce((a, b) => a + b.volume, 0), 2),
    unresolved,
    nestedRowsSkipped: usable.reduce((n, d) => n + (d.nestedRowsSkipped || 0), 0),
    missingDays: failures.map(({ date, error }) => ({ date, error })),
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

// One cached snapshot serves every viewer for a minute. The sweep is 8+ upstream
// calls, so without this each reader would spend Predara's whole rate-limit
// budget on data identical to what the last reader just fetched.
async function getMonitorSnapshot({ rowLimit, historyDays, status, now = Date.now() } = {}) {
  const rows = Math.max(0, Math.min(MAX_ROW_LIMIT, toNumber(rowLimit) ?? DEFAULT_ROW_LIMIT))
  const history = Math.max(1, Math.min(MAX_HISTORY_DAYS, toNumber(historyDays) ?? DEFAULT_HISTORY_DAYS))
  const key = `monitor:${rows}:${history}:${status || "all"}`

  const { value, fromCache } = await cached(key, SNAPSHOT_CACHE_MS, async () => {
    const [sweep, volumeHistory] = await Promise.all([
      fetchAllEvents({ status }),
      cached(`monitor-volume:${history}`, VOLUME_CACHE_MS,
        () => fetchVolumeHistory({ days: history, now })).then((r) => r.value),
    ])

    if (!sweep.events.length) {
      const reason = sweep.warnings[0] || "the event feed returned nothing"
      const err = new Error(`Monitor snapshot unavailable: ${reason}`)
      err.status = 502
      throw err
    }

    const snapshot = summarize(sweep.events, { rowLimit: rows, now })
    return {
      ...snapshot,
      complete: sweep.complete,
      pagesFetched: sweep.pages,
      warnings: sweep.warnings,
      volumeHistory,
      // Stated in the payload rather than only in the UI, so anything consuming
      // this API inherits the same caveats.
      notes: {
        source: "Gemini public Prediction Markets API (/events, /volume) — no authenticated or internal data",
        depth: "Order-book depth, depth imbalance and the thin/one-sided/skewed signals are not available from the public feed and are not estimated",
        overround: `Overround and dutch books cover single-winner (template: categorical) events only; multi-winner and single-contract events are excluded, as are events with any unquoted leg and events whose overround falls outside ±100% (see overroundExcluded for the breakdown). avgOverround is only a platform figure when overroundRepresentative is true, meaning at least ${OVERROUND_MIN_SAMPLE} eligible events; below that read the per-event values, not the average. Note also that on a large field the sum of asks is inflated by longshots resting at the minimum tick, so a big margin there is a granularity artefact — overroundMaxLegs gives the largest field in the sample`,
        spread: "Average spread covers two-sided books only",
        volumeHistory: "The hourly volume feed is a nested category hierarchy in which a parent row already contains its children; only the shallowest rows are summed, so the total is not inflated by double-counting. volumeHistory.categories carries the per-category breakdown",
      },
    }
  })

  return { status: 200, data: { ...value, cached: fromCache } }
}

async function handleMonitorRequest(query = {}) {
  try {
    return await getMonitorSnapshot({
      rowLimit: query.rows,
      historyDays: query.days,
      status: query.status,
    })
  } catch (err) {
    return { status: err.status || 502, error: err.message }
  }
}

module.exports = {
  getMonitorSnapshot,
  handleMonitorRequest,
  // Exported for tests — the metric definitions are the part that has to be right.
  readQuote,
  eventOverround,
  eventVolume,
  summarizeEvent,
  summarize,
  fetchAllEvents,
  fetchVolumeHistory,
  parseHourlyVolume,
  categoryPathOf,
  completedUtcDays,
  normalizeHour,
  PAGE_SIZE,
  MAX_PAGES,
  DEFAULT_ROW_LIMIT,
  MAX_ROW_LIMIT,
  OVERROUND_PLAUSIBLE_LIMIT,
  OVERROUND_MIN_SAMPLE,
  overroundExclusionKey,
}
