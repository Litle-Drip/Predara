// ── Gemini Predictions data access ────────────────────────────────────────────
// Single source of truth for talking to Gemini's public prediction-markets API.
// Both entrypoints use it: api/gemini.js (Vercel serverless, production) and
// server.js (local dev server). Transport-agnostic — every exported call returns
// a plain { status, data } or { status, error } so each caller serializes it in
// whatever response style it already uses.
//
// Read-only by design. Order entry, positions, terms acceptance and the
// WebSocket streams are deliberately not implemented here: Predara analyzes
// markets, it does not trade them.

const https = require("https")

const REQUEST_TIMEOUT_MS = 10000
const API_BASE = "https://api.gemini.com/v1/prediction-markets"

// Builder.io API key embedded in all Gemini predictions pages
const BUILDER_API_KEY = "1b77ce3a269a43e985e77f3d65f715ba"

// ── Input validation ──────────────────────────────────────────────────────────

// Event tickers (FEDJAN26) and instrumentSymbols (GEMI-FEDJAN26-DN25) both fit.
function isSafeParam(str) {
  return typeof str === "string" && /^[A-Za-z0-9_\-\.]+$/.test(str)
}

function isSafeUrl(str) {
  if (typeof str !== "string") return false
  try {
    const u = new URL(str)
    return (u.protocol === "https:" || u.protocol === "http:") &&
           u.hostname.endsWith("gemini.com")
  } catch { return false }
}

// ── Transport ─────────────────────────────────────────────────────────────────

function fetchJson(url, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { "Accept": "application/json" },
    }, (apiRes) => {
      let body = ""
      apiRes.on("data", (chunk) => { body += chunk })
      apiRes.on("end", () => resolve({ status: apiRes.statusCode, body }))
    })
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error("timeout")) })
    req.on("error", reject)
  })
}

// Fetch + parse + map upstream failures onto a { status, error } shape.
// `label` names the resource in the error text ("event", "combo list", ...).
async function fetchUpstream(url, label) {
  let result
  try {
    result = await fetchJson(url)
  } catch (err) {
    return { status: 502, error: err.message }
  }
  if (result.status !== 200) {
    return { status: result.status, error: `Gemini API returned ${result.status} for ${label}` }
  }
  try {
    return { status: 200, data: JSON.parse(result.body) }
  } catch {
    return { status: 502, error: "Invalid response from Gemini API" }
  }
}

// ── Prices ────────────────────────────────────────────────────────────────────
// Gemini returns every price and quantity as a decimal string and the docs are
// explicit that the precision should be preserved rather than round-tripped
// through binary floating point. These helpers keep the raw string available so
// callers can display exactly what Gemini sent, while still exposing a Number
// for the arithmetic Predara's analytics need.

// Parse a Gemini decimal string to a Number, or null if it isn't numeric.
// Accepts a Number too, so it is safe to call on mixed payloads.
function toNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed || !/^-?\d*\.?\d+$/.test(trimmed)) return null
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : null
}

// Public order-book depth is normalized in YES space. The NO side of the same
// price level is the complement — see "Price as market-implied probability".
function complementPrice(yesPrice) {
  const n = toNumber(yesPrice)
  if (n === null) return null
  return Number((1 - n).toFixed(4))
}

// A binary contract settles at $1.00, so price doubles as implied probability.
// Returned as a percentage for display, or null when the price is unusable.
function impliedProbability(price, settlementValue = 1) {
  const p = toNumber(price)
  const s = toNumber(settlementValue)
  if (p === null || s === null || s === 0) return null
  return Number(((p / s) * 100).toFixed(2))
}

// ── Ticker parsing ────────────────────────────────────────────────────────────
// Automated markets use deterministic ticker formats that encode event metadata,
// so a symbol can be read for expiry, teams, or the underlying asset without an
// extra request. Markets with manual resolution (politics, custom predictions)
// have unstructured identifiers — those return { kind: "other" } and callers
// must fall back to the event payload. Never build a symbol from these parts:
// the docs require using the instrumentSymbol Gemini returned, verbatim.

const LEAGUES = ["MLB", "NBA", "NFL", "NHL", "NCAAF", "NCAAB", "MLS", "EPL", "UFC"]

// GEMI-{League}-{DateTime}-{Away}-{Home}-{Type}-{Contract}
function parseSportsTicker(parts) {
  if (parts.length < 6) return null
  const [league, dateTime, away, home, type, ...rest] = parts
  return {
    kind: "sports",
    league,
    dateTime,
    away,
    home,
    marketType: type,
    contract: rest.join("-") || null,
  }
}

// GEMI-{EventType}-{Location}-{Expiry}-{Contract}
function parseWeatherTicker(parts) {
  if (parts.length < 3) return null
  const [eventType, location, expiry, ...rest] = parts
  return {
    kind: "weather",
    eventType,
    location,
    expiry: expiry || null,
    contract: rest.join("-") || null,
  }
}

// GEMI-CMB-{MMYY}-{HASH12} — combos are content-addressable, so the hash is the
// identity of the leg set and carries no readable metadata of its own.
function parseComboTicker(parts) {
  const [, period, hash] = parts
  return {
    kind: "combo",
    period: period || null,
    hash: hash || null,
  }
}

// Crypto and commodities share GEMI-{Asset|Commodity}{Expiry}-{Contract}, where
// the asset and its expiry are run together in one segment (BTC05M2606011000).
// Short-dated series carry a duration between the two — the "05M" in BTC05M is
// the 5-minute series, not part of the expiry — so it is split out separately.
// The expiry is also seen dashed off instead of joined (GEMI-ETH-EOY26-HI5000),
// so both spellings are accepted.
//
// This is the last fallback, and unstructured markets (politics, custom
// predictions) reach it too — "PRES2028" would otherwise read as asset PRES
// expiring 2028 and produce confidently wrong copy. So a match is only claimed
// when something corroborates the structured reading: a series interval, or a
// contract suffix after the expiry. Anything less falls through to `other`,
// where callers use the event payload instead.
function parseAssetTicker(parts) {
  const [head, ...rest] = parts

  // Joined:  {Asset}{Interval?}{Expiry}-{Contract}
  const joined = head.match(/^([A-Z]+?)(\d{1,2}[MHDW])?(\d+)$/)
  if (joined) {
    if (!joined[2] && !rest.length) return null
    return {
      kind: "asset",
      asset: joined[1],
      interval: joined[2] || null,
      expiry: joined[3],
      contract: rest.join("-") || null,
    }
  }

  // Dashed:  {Asset}-{Expiry}-{Contract}
  if (/^[A-Z]+$/.test(head) && rest.length >= 2 && /\d/.test(rest[0])) {
    return {
      kind: "asset",
      asset: head,
      interval: null,
      expiry: rest[0],
      contract: rest.slice(1).join("-") || null,
    }
  }

  return null
}

const WEATHER_TYPES = ["TEMP", "HIGH", "LOW", "RAIN", "SNOW", "HURRICANE", "WEATHER"]

// Parse an instrumentSymbol or event ticker into whatever metadata its format
// encodes. Always returns an object; `kind: "other"` means unstructured.
function parseTicker(symbol) {
  if (typeof symbol !== "string" || !symbol) return { kind: "other", symbol }

  const raw = symbol.trim()
  const hadPrefix = raw.startsWith("GEMI-")
  const parts = (hadPrefix ? raw.slice(5) : raw).split("-")
  const base = { symbol: raw, hasPrefix: hadPrefix }

  if (!parts.length || !parts[0]) return { ...base, kind: "other" }

  let parsed = null
  if (parts[0] === "CMB")                     parsed = parseComboTicker(parts)
  else if (LEAGUES.includes(parts[0]))        parsed = parseSportsTicker(parts)
  else if (WEATHER_TYPES.includes(parts[0]))  parsed = parseWeatherTicker(parts)
  else                                        parsed = parseAssetTicker(parts)

  return parsed ? { ...base, ...parsed } : { ...base, kind: "other" }
}

// ── Contract terms discovery ──────────────────────────────────────────────────

// Walk a Builder.io content tree and collect all cdn.builder.io asset URLs.
// Checks both JSON object properties (href/url/src) and URLs embedded inside
// HTML strings (e.g. rich-text blocks with <a href="cdn.builder.io/assets/...">).
function collectBuilderAssets(node, results = []) {
  if (!node || typeof node !== "object") return results
  for (const [key, val] of Object.entries(node)) {
    if (typeof val === "string") {
      // Direct link fields
      if ((key === "href" || key === "url" || key === "src") && val.includes("cdn.builder.io")) {
        results.push(val)
      }
      // URLs embedded in HTML strings (rich-text "terms & conditions" links)
      const embedded = val.match(/https:\/\/cdn\.builder\.io\/assets[^\s"'<>)\\]+/g)
      if (embedded) results.push(...embedded)
    } else if (Array.isArray(val)) {
      val.forEach(v => collectBuilderAssets(v, results))
    } else if (val && typeof val === "object") {
      collectBuilderAssets(val, results)
    }
  }
  return results
}

// Fetch the Builder.io page content for a Gemini predictions URL and
// return the first CDN asset URL that looks like contract terms.
async function fetchBuilderContractUrl(pageUrl) {
  try {
    const parsed = new URL(pageUrl)
    // Use the path without query/hash as the Builder.io page URL key
    const pagePath = parsed.pathname
    const apiUrl = `https://cdn.builder.io/api/v3/content/page` +
      `?apiKey=${BUILDER_API_KEY}` +
      `&url=${encodeURIComponent(pagePath)}` +
      `&limit=1&fields=data`
    const r = await fetchJson(apiUrl)
    if (r.status !== 200) return null
    const json = JSON.parse(r.body)
    const assets = collectBuilderAssets(json)
    return assets.length ? assets[0] : null
  } catch (_) { return null }
}

function richTextToPlain(node) {
  if (!node) return ""
  if (typeof node === "string") return node
  if (node.value) return node.value
  if (Array.isArray(node.content)) return node.content.map(richTextToPlain).join("")
  return ""
}

function mdUrl(text) {
  const m = text && text.match(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/)
  return m ? m[2] : null
}

// Resolve the contract terms URL: event.termsLink, then
// contract.termsAndConditionsUrl (may be empty string), then the markdown link
// embedded in contract description text, then the Builder.io scraping fallback.
function attachContractUrl(data, builderUrl) {
  const contracts = Array.isArray(data && data.contracts) ? data.contracts : []
  const firstContract = contracts[0] || {}
  const descText = richTextToPlain(firstContract.description)
  const directTerms = (data && data.termsLink)
    || (firstContract.termsAndConditionsUrl || "")   // may be ""
    || mdUrl(descText)
    || null
  if (directTerms) data._contract_url = directTerms
  else if (builderUrl) data._contract_url = builderUrl
  return data
}

// ── Query building ────────────────────────────────────────────────────────────

// Build a query string from defined, non-empty values only, so an absent filter
// is omitted rather than sent as an empty parameter.
function buildQuery(params) {
  const qs = new URLSearchParams()
  for (const [key, val] of Object.entries(params)) {
    if (val === undefined || val === null || val === "") continue
    qs.set(key, String(val))
  }
  const str = qs.toString()
  return str ? `?${str}` : ""
}

// Clamp a caller-supplied pagination value into a sane range.
function clampInt(value, { min, max, fallback }) {
  const n = toNumber(value)
  if (n === null) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

// ── Public API calls ──────────────────────────────────────────────────────────

// GET /v1/prediction-markets/events/{ticker}
// The authoritative event definition, its contracts array, and — when Gemini
// includes them — per-contract `prices` and `contractOrderbooks`.
async function getEvent(ticker, pageUrl) {
  if (!ticker || !isSafeParam(ticker)) {
    return { status: 400, error: "Missing or invalid ticker" }
  }
  if (pageUrl && !isSafeUrl(pageUrl)) {
    return { status: 400, error: "Invalid pageUrl" }
  }

  const target = `${API_BASE}/events/${encodeURIComponent(ticker)}`

  // Fetch Gemini event API + Builder.io contract URL in parallel
  let eventResult, builderUrl
  try {
    ;[eventResult, builderUrl] = await Promise.all([
      fetchJson(target),
      pageUrl ? fetchBuilderContractUrl(pageUrl).catch(() => null) : Promise.resolve(null),
    ])
  } catch (err) {
    return { status: 502, error: err.message }
  }

  if (eventResult.status !== 200) {
    if (eventResult.status === 404) {
      return {
        status: 404,
        error: `Ticker "${ticker}" not found on Gemini. Make sure you have the full ticker (e.g. TPC2026T5, not TPC2026T).`,
      }
    }
    return { status: eventResult.status, error: `Gemini API returned ${eventResult.status}` }
  }

  let data
  try { data = JSON.parse(eventResult.body) } catch {
    return { status: 502, error: "Invalid response from Gemini API" }
  }
  if (!data || typeof data !== "object" ||
      (!(Array.isArray(data.contracts) && data.contracts.length > 0) && !data.ticker && !data.title)) {
    return { status: 502, error: "Upstream returned an empty or invalid payload" }
  }

  return { status: 200, data: attachContractUrl(data, builderUrl) }
}

// GET /v1/prediction-markets/events/{eventTicker}/strike
// Strike or threshold information for an event. For crypto Up/Down contracts
// the strike is not captured until `availableAt` (roughly 5 minutes before
// expiry on 5M contracts), so `value` is legitimately null before then — that
// is a pending strike, not an error, and `_pending` marks the difference.
async function getEventStrike(eventTicker) {
  if (!eventTicker || !isSafeParam(eventTicker)) {
    return { status: 400, error: "Missing or invalid event ticker" }
  }
  const target = `${API_BASE}/events/${encodeURIComponent(eventTicker)}/strike`
  const result = await fetchUpstream(target, `strike for "${eventTicker}"`)
  if (result.status !== 200) return result

  const strike = result.data || {}
  strike._pending = strike.value == null
  strike._comparison = describeStrikeType(strike.type)
  return result
}

// Plain-English reading of a strike `type`, for the "what's the bet" copy.
// The enum mixes reference strikes with inequality thresholds, and the strict
// vs inclusive distinction (over vs over_or_equal) decides ties — so it changes
// who wins and is worth stating explicitly rather than glossing as "above".
const STRIKE_TYPES = {
  reference:      { symbol: null,  text: "reference price captured at the start of the observation window" },
  above:          { symbol: ">",   text: "settles YES above the threshold" },
  spread:         { symbol: null,  text: "handicap spread line" },
  over:           { symbol: ">",   text: "settles YES strictly over the line (an exact tie loses)" },
  over_or_equal:  { symbol: ">=",  text: "settles YES at or over the line (an exact tie wins)" },
  under:          { symbol: "<",   text: "settles YES strictly under the line (an exact tie loses)" },
  under_or_equal: { symbol: "<=",  text: "settles YES at or under the line (an exact tie wins)" },
}

function describeStrikeType(type) {
  if (!type) return null
  return STRIKE_TYPES[String(type).toLowerCase()] || null
}

// GET /v1/prediction-markets/events
// Paginated event discovery. `status`, `category` and `search` are optional
// filters; `limit`/`offset` page through results.
async function listEvents({ status, category, search, limit, offset } = {}) {
  if (status && !isSafeParam(status)) {
    return { status: 400, error: "Invalid status filter" }
  }
  if (category && !isSafeParam(category)) {
    return { status: 400, error: "Invalid category filter" }
  }
  if (search !== undefined && search !== null && typeof search !== "string") {
    return { status: 400, error: "Invalid search term" }
  }

  const query = buildQuery({
    status,
    category,
    search: search ? String(search).slice(0, 200) : undefined,
    limit: clampInt(limit, { min: 1, max: 100, fallback: 50 }),
    offset: clampInt(offset, { min: 0, max: 100000, fallback: 0 }),
  })

  return fetchUpstream(`${API_BASE}/events${query}`, "event list")
}

// GET /v1/prediction-markets/combos
// Active combo contracts with their leg breakdowns.
async function listCombos({ limit, offset } = {}) {
  const query = buildQuery({
    limit: clampInt(limit, { min: 1, max: 100, fallback: 50 }),
    offset: clampInt(offset, { min: 0, max: 100000, fallback: 0 }),
  })
  return fetchUpstream(`${API_BASE}/combos${query}`, "combo list")
}

// GET /v1/prediction-markets/combos/{instrumentSymbol}
// Resolves a combo ticker to its full leg specification and per-leg resolution
// status. Enriched with the independence-implied fair value (see comboFairValue).
async function getCombo(instrumentSymbol) {
  if (!instrumentSymbol || !isSafeParam(instrumentSymbol)) {
    return { status: 400, error: "Missing or invalid combo instrumentSymbol" }
  }
  const target = `${API_BASE}/combos/${encodeURIComponent(instrumentSymbol)}`
  const result = await fetchUpstream(target, `combo "${instrumentSymbol}"`)
  if (result.status !== 200) return result

  const fair = comboFairValue(result.data)
  if (fair) result.data._fair_value = fair
  return result
}

// ── Combo analytics ───────────────────────────────────────────────────────────

// A combo settles YES only if every leg settles YES, and the payoff is the
// product of the leg outcomes. Under independence its fair value is therefore
// the product of the leg prices. The traded price departs from this anchor when
// the market prices correlation between legs, so the gap is a real signal rather
// than noise — that is the number Predara should surface.
function comboFairValue(combo) {
  const legs = Array.isArray(combo && combo.legs) ? combo.legs : []
  if (legs.length < 2) return null

  let product = 1
  for (const leg of legs) {
    // A leg can be taken on either side; a NO leg contributes its complement.
    const raw = leg.price != null ? leg.price
      : leg.prices && leg.prices.lastTradePrice != null ? leg.prices.lastTradePrice
      : leg.prices && leg.prices.bestAsk != null ? leg.prices.bestAsk
      : null
    const yesPrice = toNumber(raw)
    if (yesPrice === null) return null

    const side = String(leg.outcome || leg.side || "yes").toLowerCase()
    const legPrice = side === "no" ? 1 - yesPrice : yesPrice
    if (!(legPrice > 0)) return null
    product *= legPrice
  }

  const fair = Number(product.toFixed(4))
  const marketRaw = combo.price != null ? combo.price
    : combo.prices && combo.prices.lastTradePrice != null ? combo.prices.lastTradePrice
    : null
  const market = toNumber(marketRaw)

  return {
    fairValue: fair,
    legCount: legs.length,
    marketPrice: market,
    // Positive edge means the combo trades below its independence anchor.
    edge: market === null ? null : Number((fair - market).toFixed(4)),
  }
}

module.exports = {
  API_BASE,
  REQUEST_TIMEOUT_MS,
  isSafeParam,
  isSafeUrl,
  fetchJson,
  toNumber,
  complementPrice,
  impliedProbability,
  parseTicker,
  collectBuilderAssets,
  fetchBuilderContractUrl,
  richTextToPlain,
  mdUrl,
  attachContractUrl,
  buildQuery,
  clampInt,
  getEvent,
  getEventStrike,
  describeStrikeType,
  listEvents,
  listCombos,
  getCombo,
  comboFairValue,
}
