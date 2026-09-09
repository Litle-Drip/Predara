// ── Kyle — customer-support event brief ───────────────────────────────────────
//
// Kyle answers one question for a Gemini support agent who has never traded a
// prediction market: "a customer is asking about this event — what IS it, is it
// still running, and has it paid out yet?"
//
// It is deliberately NOT the Analyze page. No edge, no Kelly, no fee model, no
// trading language: an agent reading this is about to type a reply to a
// customer, so every number is either an identifier they can paste into a
// ticket or a fact about the event's state. Where the data does not say
// something, Kyle says it does not say it rather than guessing — a support
// agent repeating an invented settlement date to a customer is worse than one
// saying "I need to check".
//
// Data comes from the same read-only Gemini endpoints the rest of the app uses
// (/api/gemini for one event, /api/gemini-markets?resource=events for search),
// so Kyle adds no new upstream surface.
//
// Everything above the DOM section is pure so tests/ can exercise it directly.

const KYLE_EVENT_URL = (ticker) => `https://www.gemini.com/predictions/${ticker}`

// The upstream record for an event, unstyled and complete. Agents open this on
// every ticket — it is the source Kyle itself reads, so it is the thing to
// quote when a customer disputes what the page says, and the thing to attach
// when escalating. Built from the same ticker Kyle resolved, so it is always
// the event actually on screen rather than whatever the agent pasted.
const KYLE_API_URL = (ticker) => `https://api.gemini.com/v1/prediction-markets/events/${ticker}`
const KYLE_SEARCH_LIMIT = 12

// ── Formatting ────────────────────────────────────────────────────────────────

function _kEsc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;")
}

function _kNum(v) {
  const n = typeof v === "number" ? v : parseFloat(v)
  return Number.isFinite(n) ? n : null
}

function _kMoney(v) {
  const n = _kNum(v)
  if (n === null || n <= 0) return ""
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(1) + "B"
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M"
  if (n >= 1e3) return "$" + Math.round(n / 1e3) + "K"
  return "$" + Math.round(n)
}

function _kTime(iso) {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

// Dates are shown in the agent's own timezone with the zone spelled out: a CS
// agent in Manila reading a UTC timestamp as local time will quote the customer
// a settlement date that is off by a day.
function _kDateTime(iso) {
  const t = _kTime(iso)
  if (t === null) return ""
  try {
    return new Date(t).toLocaleString(undefined, {
      year: "numeric", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit", timeZoneName: "short",
    })
  } catch { return new Date(t).toISOString() }
}

// Absolute UTC, for anything that leaves the tool. The page may show the
// agent's local time, but a timestamp pasted into a customer email must match
// what the customer sees on gemini.com, and must not drift as it is forwarded.
function _kDateTimeUtc(iso) {
  const t = _kTime(iso)
  if (t === null) return ""
  const d = new Date(t)
  const pad = (n) => String(n).padStart(2, "0")
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
}

function _kDate(iso) {
  const t = _kTime(iso)
  if (t === null) return ""
  try {
    return new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
  } catch { return new Date(t).toISOString().slice(0, 10) }
}

// "3 days ago" / "in 4 hours". Agents reason in elapsed time ("has this been
// stuck?"), not in timestamps.
function _kRelative(iso, now = Date.now()) {
  const t = _kTime(iso)
  if (t === null) return ""
  const diff = t - now
  const abs = Math.abs(diff)
  const mins = Math.round(abs / 60000)
  let unit
  if (mins < 1) return diff < 0 ? "just now" : "any moment"
  if (mins < 60) unit = `${mins} minute${mins === 1 ? "" : "s"}`
  else if (mins < 1440) { const h = Math.round(mins / 60); unit = `${h} hour${h === 1 ? "" : "s"}` }
  else if (mins < 43200) { const d = Math.round(mins / 1440); unit = `${d} day${d === 1 ? "" : "s"}` }
  else { const mo = Math.round(mins / 43200); unit = `${mo} month${mo === 1 ? "" : "s"}` }
  return diff < 0 ? `${unit} ago` : `in ${unit}`
}

// "closes" before the fact, "closed" after it.
function _kTense(iso, now = Date.now()) {
  const t = _kTime(iso)
  return t !== null && t <= now ? "closed" : "closes"
}

// ── What did the agent paste in? ──────────────────────────────────────────────
// Customers send all of these: a gemini.com link, a bare event ticker, the
// instrument symbol off their position, or a description in their own words
// ("the Fed cut thing in January").

// An ID (F1-ITAGP-POD-20260906) versus a human-readable slug
// (italian-grand-prix-podium): the ID shouts or is numeric, the slug does not.
function _kLooksLikeTicker(seg) {
  return /^[A-Za-z0-9_\-\.]{2,64}$/.test(seg) && (/[A-Z]/.test(seg) || /^[0-9]+$/.test(seg))
}

// A Gemini event URL is /predictions/{TICKER}, optionally followed by a slug and
// a query string: /predictions/F1-ITAGP-POD-20260906/italian-grand-prix-podium
// ?categoryPath=... Taking the last path segment grabs the slug instead of the
// ticker, which is why a link that a customer copied out of their browser used
// to fail where the bare ticker worked.
function _kTickerFromUrl(u) {
  const parts = u.pathname.split("/").filter(Boolean).map((seg) => {
    try { return decodeURIComponent(seg) } catch { return seg }
  })
  const marker = parts.findIndex((seg) => /^predictions?$|^prediction-markets$/i.test(seg))
  if (marker >= 0 && parts[marker + 1]) return parts[marker + 1]
  // Unrecognised path shape: take the last segment that reads as an ID.
  for (let i = parts.length - 1; i >= 0; i--) if (_kLooksLikeTicker(parts[i])) return parts[i]
  return ""
}

// An instrument symbol names one contract inside an event: the venue prefix and
// the contract code wrap the event ticker, so GEMI-F1-ITAGP-POD-20260906-ALB is
// the ALB contract of event F1-ITAGP-POD-20260906. Only the event has an API
// record, so an agent pasting the symbol off a customer's position needs these
// candidates tried in order rather than a dead end. Nothing is derived blindly —
// each candidate is a real lookup, and the first one that exists wins.
function kyleTickerCandidates(ticker) {
  const out = []
  // Trim stray separators: stripping a prefix or a suffix off a malformed
  // symbol ("GEMI-") can otherwise leave a candidate that is all separator.
  const push = (t) => {
    const clean = String(t || "").replace(/^-+|-+$/g, "")
    if (clean && !out.includes(clean)) out.push(clean)
  }
  push(ticker)
  const base = String(ticker).replace(/^GEMI-/i, "")
  push(base)
  const parts = base.split("-")
  // Stop before emptying the ticker, not before the last segment: an event
  // ticker is frequently a single word, so GEMI-USOPENM26-ALCARAZ has to be
  // allowed to reach USOPENM26. Requiring two segments to remain quietly
  // excluded every event whose ticker has no hyphen in it — which is most of
  // the non-sports catalogue.
  for (let drop = 1; drop <= 2 && parts.length - drop >= 1; drop++) {
    push(parts.slice(0, parts.length - drop).join("-"))
  }
  return out
}

function kyleParseQuery(raw) {
  const q = String(raw == null ? "" : raw).trim()
  if (!q) return { kind: "empty", value: "" }

  if (/^https?:\/\//i.test(q)) {
    let ticker = ""
    try { ticker = _kTickerFromUrl(new URL(q)) }
    catch { /* not a parseable URL — fall through to a text search */ }
    if (ticker && /^[A-Za-z0-9_\-\.]+$/.test(ticker)) return { kind: "ticker", value: ticker }
    return { kind: "search", value: q }
  }

  // A ticker is one word from this character set, and it looks like an ID
  // rather than a word: shouted (FEDJAN26), numbered, or hyphenated. Anything
  // with a space is a description of the event, not its ID. A single lowercase
  // word ("yankees") is searched, and a ticker that guesses wrong falls back to
  // a search in kyleOpen() rather than dead-ending the agent.
  if (/^[A-Za-z0-9_\-\.]{3,64}$/.test(q) &&
      ((q === q.toUpperCase() && /[A-Z]/.test(q)) || /[0-9]/.test(q) || q.includes("-"))) {
    return { kind: "ticker", value: q }
  }
  return { kind: "search", value: q }
}

// ── Event shape ───────────────────────────────────────────────────────────────

function _kContracts(event) {
  return Array.isArray(event && event.contracts) ? event.contracts : []
}

function _kContractName(c, fallback) {
  return (c && (c.label || c.title || c.name || c.abbreviatedName || c.ticker || c.instrumentSymbol)) || fallback
}

function _kFirst(...vals) {
  for (const v of vals) if (v !== undefined && v !== null && v !== "") return v
  return ""
}

// Is this event still trading, done trading, paid out, or voided?
// Gemini spells the state several ways across payloads, so the status string,
// the resolution timestamp and the per-contract resolutionSide all get a vote.
function kyleStatus(event, now = Date.now()) {
  const raw = String((event && event.status) || "").toLowerCase()
  const contracts = _kContracts(event)
  const resolvedIso = _kFirst(event && event.resolvedAt, event && event.settledAt, event && event.resolutionDate)
  const hasSide = contracts.some((c) => !!(c && c.resolutionSide))

  const settle = kyleSettlement(event)

  if (/cancel|void/.test(raw)) {
    return {
      code: "voided", label: "VOIDED", short: "VOIDED", tone: "bad",
      // How a cancelled event is unwound is Gemini policy, and Kyle reads none
      // of it. Describing a refund here would put a policy statement Kyle
      // cannot source into a customer's inbox.
      plain: "Gemini cancelled this event, so it has no result. Kyle cannot tell you how the trades on it were handled — that is a settlement question. Escalate rather than describing a refund to the customer.",
    }
  }
  if (/settl|resolv|paid/.test(raw) || resolvedIso || hasSide) {
    return {
      code: "settled", label: "SETTLED", short: "SETTLED", tone: "done",
      // Kyle reads a resolution state. It has no visibility into whether an
      // account has been credited, so it describes what the contract does, not
      // what has already happened to the customer's balance.
      plain: `This event is finished and the result is final. Winning contracts settle at ${settle.each}; losing contracts settle at zero. Kyle cannot see whether an individual account has been credited yet — check the customer's account before confirming a payout.`,
    }
  }

  const closeIso = kyleDates(event).tradingCloses
  const closeT = _kTime(closeIso)
  const closedByClock = closeT !== null && closeT <= now

  if (/closed|expired|inactive|pending/.test(raw)) {
    return {
      code: "closed", label: "CLOSED — AWAITING RESULT", short: "CLOSED", tone: "warn",
      plain: "Gemini reports trading as closed and has not published a result yet. No position can be opened or closed, and no contract has settled. This is normal for a short window after an event ends.",
    }
  }
  if (/active|approved|open|live|trading/.test(raw)) {
    // The close time passing does NOT make Kyle overrule Gemini. Telling a
    // customer trading has stopped, on the strength of the agent's own browser
    // clock, is how someone gets told they cannot exit a position that is in
    // fact still tradeable. The disagreement is surfaced instead of resolved.
    if (closedByClock) {
      return {
        code: "conflict", label: "OPEN — BUT PAST ITS CLOSE TIME", short: "CHECK", tone: "warn",
        plain: "Gemini still reports this event as open, but the close time it publishes has already passed. Kyle will not guess which is right. Do not tell the customer either that trading is open or that it has stopped — open the event page and confirm before you reply.",
      }
    }
    return {
      code: "open", label: "OPEN", short: "OPEN", tone: "good",
      plain: "Gemini reports this event as open. Nothing has been decided and no contract has settled.",
    }
  }
  return {
    code: "unknown", label: raw ? raw.toUpperCase() : "UNKNOWN", short: "UNKNOWN", tone: "warn",
    plain: "Gemini did not return a state Kyle recognises for this event. Do not tell the customer whether it is open or settled — check the event page before replying.",
  }
}

// Can more than one outcome pay out? A race-winner market has exactly one
// winner; a podium market pays every driver who finishes top three. Telling a
// support agent the wrong one produces a wrong statement to a customer about
// whether their contract could still have won.
//
// This is answered ONLY from facts. It used to fall back to summing contract
// prices, which was unsound by construction: the price fallback reads bestAsk,
// and in any real order book the asks sum to more than 1 because of the spread,
// so a genuinely mutually exclusive market read as "several can win" — a
// systematic error, not an edge case, on ordinary two-way sports markets.
// Returns null when nothing states the answer, and the copy then points at the
// contract terms instead of asserting.
function kyleExclusive(event) {
  const e = event || {}
  for (const key of ["mutuallyExclusive", "mutually_exclusive", "isMutuallyExclusive", "exclusive"]) {
    if (typeof e[key] === "boolean") return e[key]
  }
  const contracts = _kContracts(e)
  // A single yes/no contract is exclusive by construction: YES and NO are the
  // two sides of one question.
  if (e.type === "binary" || contracts.length === 1) return true

  // A settled event has already answered it. More than one contract settling
  // YES proves the outcomes were never mutually exclusive; exactly one YES with
  // every other contract resolved NO proves they were.
  const sides = contracts.map((c) => String((c && c.resolutionSide) || "").toLowerCase())
  const yes = sides.filter((v) => v === "yes").length
  if (yes > 1) return false
  if (yes === 1 && sides.every((v) => v === "yes" || v === "no")) return true

  // `template` — NOT `type`. Both a race-winner market and a podium market
  // carry type "categorical", so `type` cannot tell them apart and using it
  // would reintroduce the exact error the price heuristic made. `template`
  // does distinguish them:
  //
  //   winner market   template "categorical"   no strikes        1 winner
  //   podium market   template "binary"        strike on each    3 winners
  //
  // "categorical" means one categorical answer, so exactly one contract can be
  // it. That direction is taken on the template alone.
  const template = String(e.template || "").toLowerCase()
  if (template === "categorical") return true

  // The other direction is held to a higher bar. A head-to-head market has not
  // been observed, and if those also carry template "binary" then template
  // alone would wrongly call a two-team market non-exclusive. So "binary" is
  // only believed when every contract also carries its own strike — the
  // threshold that makes each one an independent bet, which is the top-N
  // signature and is not what a head-to-head would look like. With one signal
  // and not the other, Kyle abstains.
  const everyContractHasAStrike = contracts.every((c) => c && c.strike && c.strike.value != null)
  if (template === "binary" && everyContractHasAStrike) return false

  return null
}

// Binary (one yes/no question) vs pick-one-of-many. This is the single thing
// support agents most often get wrong when reading a ticket back to a customer.
function kyleType(event) {
  const contracts = _kContracts(event)
  const n = contracts.length
  const settle = kyleSettlement(event)

  // A list payload carries no contracts. Saying "0 outcomes" states something
  // about the market that the payload never said.
  if (n === 0 && !(event && event.type === "binary")) {
    return {
      code: "unlisted", outcomeCount: null, exclusive: null, label: "Outcomes not listed",
      plain: "This view did not return the event's contracts, so Kyle cannot describe its outcomes. Open the event itself before answering anything about what a customer holds.",
    }
  }

  const isBinary = (event && event.type === "binary") || n === 1
  if (isBinary) {
    return {
      code: "binary", outcomeCount: 2, exclusive: true, label: "Yes / No",
      plain: `One question with two sides. A customer holding YES collects ${settle.each} if it happens; a customer holding NO collects ${settle.each} if it does not. Only one side can be right.`,
    }
  }

  const exclusive = kyleExclusive(event)
  const ask = ` Ask the customer WHICH outcome they hold — "I bet on this event" is not enough to look up their position.`

  if (n === 2 && exclusive === true) {
    return {
      code: "head2head", outcomeCount: 2, exclusive: true, label: "Head-to-head",
      plain: `Two possible results, and only one of them can happen. The one that does settles at ${settle.each}; the other settles at zero.`,
    }
  }
  if (exclusive === true) {
    return {
      code: "multi", outcomeCount: n, exclusive: true, label: "Pick one — only one can win",
      plain: `${n} possible results, and only one of them can happen. That one settles at ${settle.each}; every other one settles at zero.` + ask,
    }
  }
  if (exclusive === false) {
    return {
      code: "multi", outcomeCount: n, exclusive: false, label: "Several can win",
      plain: `${n} separate contracts on the same event, and this one settled with more than one of them winning — a podium or top-N market. Each winning contract settles at ${settle.each} independently of the others, so a customer can hold a losing contract on an event that had several winners.` + ask,
    }
  }
  // Nothing in the payload states whether these are mutually exclusive, and it
  // is not safe to infer from prices. Say so and point at the terms.
  return {
    code: "multi", outcomeCount: n, exclusive: null, label: "Multiple outcomes",
    plain: `${n} separate contracts, each settling at ${settle.each} if its outcome happens. Whether only one of them can win is set by the contract terms and this event's data does not state it — read the terms before telling a customer anything about the other outcomes.` + ask,
  }
}

function kyleDates(event) {
  const e = event || {}
  const contracts = _kContracts(e)
  const c0 = contracts[0] || {}
  // createdAt is when the record was created, which is not when trading opened.
  // It is still the best available hint, so it is kept — under an honest label.
  const opened = _kFirst(e.openDate, e.startDate, e.effectiveDate)
  return {
    listed: opened || _kFirst(e.createdAt),
    listedLabel: opened ? "Listed" : "Record created",
    eventStart: _kFirst(e.startTime, e.eventStartTime, e.gameTime),
    tradingCloses: _kFirst(e.closeDate, e.expiryDate, e.endDate, c0.closeDate, c0.expiryDate, c0.endDate),
    resolved: _kFirst(e.resolvedAt, e.settledAt, e.resolutionDate),
  }
}

// ── B4: the settlement value is read, never assumed ───────────────────────────
// A winning contract pays its settlement value. That is $1 for a standard
// binary contract, but lib/gemini.js carries a settlementValue parameter, so $1
// is a default rather than a guarantee — and every payout figure Kyle prints
// rests on it. When the payload publishes a value Kyle quotes that value; when
// it does not, Kyle says "its full settlement value" rather than inventing a
// number to put in a customer's email.
function kyleSettlement(event) {
  const e = event || {}
  const c0 = _kContracts(e)[0] || {}
  const raw = _kFirst(
    e.settlementValue, e.settlement_value, e.payoutValue,
    c0.settlementValue, c0.settlement_value, c0.payoutValue,
  )
  const value = _kNum(raw)
  if (value === null) {
    return { value: null, known: false, amount: "its full settlement value", each: "its full settlement value" }
  }
  const amount = "$" + (Number.isInteger(value) ? value.toFixed(2) : String(value))
  return { value, known: true, amount, each: amount + " per contract" }
}

// Sports events carry a league; everything else carries a category. Agents
// route tickets by this, so both are surfaced under one "type" line.
function kyleSubject(event) {
  const e = event || {}
  const ticker = String(_kFirst(e.ticker, e.event_ticker, e.eventTicker) || "")
  const leagues = ["MLB", "NBA", "NFL", "NHL", "NCAAF", "NCAAB", "MLS", "EPL", "UFC", "F1", "NASCAR", "PGA", "ATP", "WTA"]
  const fromTicker = leagues.find((l) => new RegExp(`(^|-)${l}(-|$)`, "i").test(ticker)) || ""
  // Real payloads carry no top-level `sport`. The league lives in subcategory
  // ("F1"), in tags, or under sportsMarket.sport ("motorsports") — checked in
  // that order because the most specific label is the one an agent routes on.
  const sub = e.subcategory || {}
  const sportsMarket = e.sportsMarket || {}
  const tag = Array.isArray(e.tags) && e.tags.length ? String(e.tags[0]) : ""
  const category = _kFirst(e.category, e.categoryName,
    Array.isArray(sub.path) && sub.path.length ? sub.path[0] : "")
  const sport = _kFirst(e.sport, e.league, sub.name, tag, fromTicker, sportsMarket.sport)
  return {
    // Do not print the category twice when the only "sport" we found is it.
    sport: String(sport) === String(category) ? "" : sport,
    category,
  }
}

// ── Resolution criteria ───────────────────────────────────────────────────────
// Every contract carries the text that decides it — what has to happen, and
// which source agencies are consulted, in order. That is the single most useful
// paragraph on the page for an agent facing "why did this resolve that way?",
// and Kyle was throwing it away. Gemini sends it as a rich-text document, so it
// is flattened here; a plain string is accepted too.
function _kRichText(node) {
  if (!node) return ""
  if (typeof node === "string") return node.trim()
  if (Array.isArray(node)) return node.map(_kRichText).filter(Boolean).join(" ")
  if (typeof node === "object") {
    if (typeof node.value === "string" && node.value.trim()) return node.value.trim()
    if (node.content) return _kRichText(node.content)
  }
  return ""
}

// Markdown links in that text ("[terms & conditions](https://…)") read as noise
// once the page already links the terms, so the label is kept and the URL cut.
function _kStripMdLinks(text) {
  return String(text || "").replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1")
}

function kyleResolution(event, focusSymbol = "") {
  const contracts = _kContracts(event)
  if (!contracts.length) return null
  const wanted = String(focusSymbol || "").toUpperCase()
  const match = contracts.find((c) => String(c.instrumentSymbol || "").toUpperCase() === wanted)
  const source = match || contracts[0]
  const text = _kStripMdLinks(_kRichText(source && source.description)).trim()
  if (!text) return null
  return {
    text,
    contract: String(_kContractName(source, "")),
    // Only one contract's wording is shown; say whose, so an agent does not
    // read a per-driver criterion as the whole event's rule.
    isExample: !match && contracts.length > 1,
    agency: String(_kFirst(
      (event.sourceDetails || {}).agency,
      (event.settlement || {}).source,
    ) || ""),
  }
}

// A price of 0.9999 rounds to "100%", which reads as certainty on a market
// where nothing has been decided — and an agent will repeat it that way. Only
// a settled contract is allowed to show 0 or 100.
function _kPctLabel(price) {
  if (price === null) return "—"
  const pct = Math.round(price * 100)
  if (pct >= 100 && price < 1) return ">99%"
  if (pct <= 0 && price > 0) return "<1%"
  return pct + "%"
}

function kyleOutcomes(event) {
  const contracts = _kContracts(event)
  const type = kyleType(event)
  const rows = contracts.map((c, i) => {
    const p = (c && c.prices) || {}
    // ASK FIRST, and this order is not cosmetic. A live book carries bestAsk,
    // bestBid and lastTradePrice at once, and gemini.com displays the ask as
    // the contract's "Yes %" — the cost to buy a YES contract. Reading
    // lastTradePrice first showed 31% for a contract Gemini was showing at 37%,
    // a six-point gap an agent would have quoted straight to a customer. The
    // whole point of this page is that it agrees with what the customer is
    // looking at. adapters.js makes the same choice for the same reason.
    //
    // prices.buy.yes is the same number as bestAsk in every observed payload
    // and is kept as a fallback; prices.sell.yes is the bid side.
    const buy = p.buy || {}
    const sell = p.sell || {}
    const yes = p.yes || p.YES || {}
    const price = _kNum(_kFirst(
      p.bestAsk, buy.yes, buy.bestAsk, buy.ask, yes.bestAsk, yes.ask,
      p.lastTradePrice, yes.lastTradePrice, buy.lastTradePrice,
      p.bestBid, sell.yes, sell.bestBid, sell.bid,
      c.lastPrice, c.price,
    ))
    const side = String((c && c.resolutionSide) || "").toLowerCase()
    return {
      name: String(_kContractName(c, `Outcome ${i + 1}`)),
      symbol: String(_kFirst(c.instrumentSymbol, c.instrument_symbol, c.ticker, "")),
      pct: price === null ? null : Math.round(price * 100),
      pctLabel: _kPctLabel(price),
      _price: price,
      derived: false,
      result: side === "yes" ? "won" : side === "no" ? "lost" : null,
    }
  })
  // On a binary event the single contract IS the YES side; spell out the NO side
  // so an agent looking at a customer who "bet no" sees their side listed.
  if (type.code === "binary" && rows.length === 1) {
    const yes = rows[0]
    // Gemini publishes one book for the YES contract. The NO figure here is
    // 100 minus that — arithmetic, not a quote off the NO book — so it is
    // marked derived and the UI labels it. An agent quoting it as the NO price
    // would be quoting a number no one is trading at.
    const yesRow = { ...yes, name: "YES — " + yes.name }
    delete yesRow._price
    return [
      yesRow,
      {
        name: "NO — the opposite",
        symbol: "",
        pct: yes.pct === null ? null : 100 - yes.pct,
        // Complement the RAW price, not the rounded percentage: 1 - round(0.996)
        // is exactly 0 and would print "0%", reintroducing the false certainty
        // the label exists to prevent.
        pctLabel: yes._price === null ? "—" : _kPctLabel(1 - yes._price),
        derived: true,
        result: yes.result === "won" ? "lost" : yes.result === "lost" ? "won" : null,
      },
    ]
  }
  rows.sort((a, b) => (b.pct === null ? -1 : b.pct) - (a.pct === null ? -1 : a.pct))
  rows.forEach((r) => { delete r._price })
  return rows
}

// The single winning outcome. On an event where several contracts can settle
// YES there is no such thing, so this returns null and the outcome list — which
// tags every winner — is the answer instead.
function kyleWinner(event) {
  const won = kyleOutcomes(event).filter((o) => o.result === "won")
  return won.length === 1 ? won[0] : null
}

// ── Things the agent must not miss ────────────────────────────────────────────
// Each issue is a state a customer is likely to be writing in about. They are
// worded as what to DO, because the reader is mid-ticket.
function kyleIssues(event, now = Date.now()) {
  const issues = []
  const status = kyleStatus(event, now)
  const dates = kyleDates(event)
  const type = kyleType(event)
  const closeT = _kTime(dates.tradingCloses)
  const resolvedT = _kTime(dates.resolved)
  const winner = kyleWinner(event)

  if (status.code === "voided") {
    issues.push({ level: "alert", title: "Event was voided",
      body: "Do not quote a result, and do not describe how the trades were handled — Kyle reads no refund or unwind policy. Escalate to settlement." })
  }

  if (status.code === "closed" && closeT !== null) {
    const hoursSince = (now - closeT) / 3600000
    if (hoursSince > 24) {
      const days = Math.round(hoursSince / 24)
      issues.push({ level: "alert", title: `Unresolved ${days} day${days === 1 ? "" : "s"} after trading closed`,
        body: "Trading ended more than a day ago and no result has been published. If the customer is asking where their payout is, this is a genuine settlement delay — escalate rather than telling them to wait." })
    } else {
      issues.push({ level: "warn", title: "Waiting on the result",
        body: `Trading closed ${_kRelative(dates.tradingCloses, now)}. Settlement normally follows shortly after. Tell the customer the result has not been published yet; do not promise a time.` })
    }
  }

  const anyWinner = kyleOutcomes(event).some((o) => o.result === "won")
  if (status.code === "settled" && !anyWinner) {
    issues.push({ level: "alert", title: "Settled, but no winning outcome published",
      body: "Gemini marks this event as settled but the data does not say which outcome won. Do not tell the customer who won from this page — confirm on the event page or with settlement first." })
  }

  if (status.code === "open" && closeT !== null && closeT - now < 24 * 3600000 && closeT > now) {
    issues.push({ level: "warn", title: "Closes within 24 hours",
      body: `Trading stops ${_kRelative(dates.tradingCloses, now)}. If the customer wants to exit a position, they need to do it before then.` })
  }

  if (status.code === "conflict") {
    issues.push({ level: "alert", title: "Gemini's status and its close time disagree",
      body: "Gemini reports this event as open while the close time it publishes has already passed. Kyle will not pick a side, because telling a customer trading has stopped when it has not can cost them a position they wanted to exit. Confirm on the event page before you reply." })
  }

  const priced = kyleOutcomes(event).filter((o) => !o.derived && o.pct !== null)
  if ((status.code === "open" || status.code === "conflict") && _kContracts(event).length && !priced.length) {
    issues.push({ level: "warn", title: "No prices returned for this event",
      body: "Gemini returned contracts but no readable price for any of them, so Kyle is showing no percentages. Do not quote a price from this page — read it off the event page instead." })
  }

  if (!dates.tradingCloses) {
    issues.push({ level: "warn", title: "No close date published",
      body: "This event does not publish an end date, so Kyle cannot tell the customer when trading stops or when it resolves." })
  }

  if (status.code !== "settled" && type.code === "multi" && type.outcomeCount) {
    issues.push({ level: "info", title: "Multiple outcomes — get the specific one",
      body: `This event has ${type.outcomeCount} separate contracts${type.exclusive === false ? ", and more than one of them can win" : ""}. A position lookup needs the exact outcome the customer holds, not just the event name.` })
  }

  if (resolvedT !== null && closeT !== null && resolvedT < closeT) {
    issues.push({ level: "warn", title: "Resolved before its close time",
      body: "The event settled earlier than its scheduled close. That is normal when the real-world result arrives early, but double-check the dates if the customer is disputing a close time." })
  }

  return issues
}

// ── The brief ─────────────────────────────────────────────────────────────────

function kyleBrief(event, now = Date.now(), options = {}) {
  const e = event || {}
  const focusSymbol = String(options.focusSymbol || "").toUpperCase()
  const contracts = _kContracts(e)
  const ticker = String(_kFirst(e.ticker, e.event_ticker, e.eventTicker) || "")
  const status = kyleStatus(e, now)
  const dates = kyleDates(e)
  const winner = kyleWinner(e)
  const subject = kyleSubject(e)

  return {
    // When this event was read from Gemini. Prices and status are a snapshot,
    // and a tab left open all afternoon is quoting the morning's market — so
    // the brief carries its own age rather than looking equally fresh forever.
    retrievedAt: new Date(options.retrievedAt || now).toISOString(),
    settlement: kyleSettlement(e),
    ticker,
    title: String(_kFirst(e.title, e.name, ticker, "Untitled event")),
    description: String(_kFirst(e.description, e.subtitle, "")),
    status,
    type: kyleType(e),
    sport: subject.sport,
    category: subject.category,
    dates,
    // "when will it resolve" is the single most asked support question, so it
    // gets its own answered-or-not field rather than being inferred from dates.
    resolution: status.code === "settled" && dates.resolved
      ? { known: true, text: `Resolved ${_kDateTimeUtc(dates.resolved)}` }
      : status.code === "settled"
        ? { known: false, text: "Marked settled, but no resolution timestamp was published." }
        : dates.tradingCloses
          ? { known: false, text: `Not resolved yet. Trading ${_kTense(dates.tradingCloses, now)} ${_kDateTimeUtc(dates.tradingCloses)} and the result is published after that.` }
          : { known: false, text: "Not resolved yet, and no close date is published — Kyle cannot say when it will resolve." },
    criteria: kyleResolution(e, options.focusSymbol || ""),
    outcomes: kyleOutcomes(e).map((o) => (
      focusSymbol && o.symbol && o.symbol.toUpperCase() === focusSymbol ? { ...o, focus: true } : o
    )),
    winner,
    issues: kyleIssues(e, now),
    stats: {
      contracts: contracts.length,
      volume: _kMoney(_kFirst(e.volume, e.notionalVolume)),
      liquidity: _kMoney(_kFirst(e.liquidity, e.notionalLiquidity)),
      openInterest: _kMoney(_kFirst(e.openInterest, e.notionalOpenInterest)),
    },
    links: {
      event: ticker ? KYLE_EVENT_URL(ticker) : "",
      api: ticker ? KYLE_API_URL(ticker) : "",
      terms: String(_kFirst(e.termsLink, e._contract_url, contracts[0] && contracts[0].termsAndConditionsUrl) || ""),
    },
  }
}

// ── The answer ────────────────────────────────────────────────────────────────
// One sentence, written the way the agent will say it. A support agent should
// not have to assemble this from a status pill and a date row: the whole point
// of the page is that the answer is the first thing on it.
// `relative` renders "3 hours ago" for the screen. Copied text must not use it:
// "It settled 1 hour ago", pasted into an email sent tomorrow, is false.
function kyleHeadline(brief, now = Date.now(), { relative = true, concise = false } = {}) {
  const b = brief || {}
  const dates = b.dates || {}
  const code = (b.status && b.status.code) || "unknown"
  const won = (b.outcomes || []).filter((o) => o.result === "won")
  const pay = (b.settlement && b.settlement.each) || "its full settlement value"
  const when = (iso, phrase) => {
    if (!iso) return ""
    return relative ? ` ${phrase} ${_kRelative(iso, now)}.` : ` ${phrase} ${_kDateTimeUtc(iso)}.`
  }

  if (code === "voided") {
    return "Gemini cancelled this event, so it has no result. How the trades were handled is a settlement question Kyle cannot answer — escalate rather than describing a refund."
  }
  if (code === "settled") {
    // Kyle reads a resolution state, never an account balance. It says what the
    // contract does, not that the customer has been credited.
    const at = when(dates.resolved, relative ? "It settled" : "Settled")
    if (won.length === 1) {
      return concise
        ? `${won[0].name} won.${at}`
        : `Finished — ${won[0].name} won.${at} That contract settles at ${pay}; every other contract settles at zero. Check the customer's account to confirm the credit.`
    }
    if (won.length > 1) {
      const names = won.map((o) => o.name).join(", ")
      return concise
        ? `${won.length} outcomes won: ${names}.${at}`
        : `Finished — ${won.length} outcomes won: ${names}.${at} Each of those settles at ${pay}; every other contract settles at zero. Check the customer's account to confirm the credit.`
    }
    return `Finished, but the data does not say which outcome won.${at} Confirm the result on the event page before telling the customer anything about their payout.`
  }
  if (code === "conflict") {
    return `Gemini reports this event as open, but its published close time${when(dates.tradingCloses, relative ? "passed" : "was")} Kyle will not guess which is right — confirm on the event page before telling the customer whether they can still trade.`
  }
  if (code === "closed") {
    const at = when(dates.tradingCloses, relative ? "Trading stopped" : "Trading closed")
    return `Gemini reports trading as closed, and no result has been published.${at} No contract has settled and no position can be opened or closed.`
  }
  if (code === "open") {
    const at = when(dates.tradingCloses, "Trading closes")
    return concise
      ? `Open.${at}`.trim()
      : `Gemini reports this event as open — nothing has been decided and no contract has settled.${at}`
  }
  return "Gemini did not return a state Kyle recognises. Do not tell the customer whether this is open or settled — check the event page first."
}

// ── The customer's contract ───────────────────────────────────────────────────
// When the agent pastes a contract symbol, they are holding a customer's
// position, and the answer is about THAT contract — not about the event. On a
// 22-driver podium the pasted contract was the 22nd row of a collapsed list
// while the headline talked about three winners the customer did not hold.
function kyleFocusAnswer(brief, now = Date.now()) {
  const b = brief || {}
  const focus = (b.outcomes || []).find((o) => o.focus)
  if (!focus) return null
  const pay = (b.settlement && b.settlement.each) || "its full settlement value"
  const code = (b.status && b.status.code) || "unknown"

  if (focus.result === "won") {
    return { verdict: "won", name: focus.name,
      line: `This contract won. It settles at ${pay}.`,
      note: "Confirm the credit in the customer's account before you tell them it has been paid." }
  }
  if (focus.result === "lost") {
    return { verdict: "lost", name: focus.name,
      line: "This contract did not win. It settles at zero.",
      note: "The customer holding it receives nothing for it, whatever else happened on the event." }
  }
  if (code === "settled") {
    return { verdict: "unknown", name: focus.name,
      line: "The event has settled, but this contract's result is not published.",
      note: "Do not tell the customer whether it won — confirm on the event page first." }
  }
  return { verdict: "open", name: focus.name,
    line: focus.pctLabel && focus.pctLabel !== "—"
      ? `Still trading at ${focus.pctLabel}. Nothing has been decided.`
      : "Still trading. Nothing has been decided.",
    note: "The customer can still buy or sell it until trading closes." }
}

// Plain text an agent pastes straight into the ticket. No markup, no emoji —
// it gets read by the next agent and sometimes by the customer.
// The block an agent pastes into a ticket or a customer email. This is the only
// part of Kyle that leaves the building, so it carries its own provenance: what
// it is, where it came from, when it was read, and that it is not a statement
// of the customer's account. Every timestamp is absolute UTC — a relative one
// ("settled 1 hour ago") becomes false the moment the text is forwarded.
function kyleSummaryText(brief, now = Date.now()) {
  const b = brief || {}
  const pay = (b.settlement && b.settlement.each) || "its full settlement value"
  const focus = kyleFocusAnswer(b, now)
  const lines = [
    focus ? `CONTRACT ASKED ABOUT: ${focus.name} — ${focus.line}` : "",
    `EVENT: ${b.title}`,
    b.ticker ? `TICKER: ${b.ticker}` : "",
    `STATUS: ${b.status && b.status.label} (as reported by Gemini)`,
    `TYPE: ${b.type && b.type.label}${b.sport ? ` — ${b.sport}` : ""}${b.category ? ` — ${b.category}` : ""}`,
    b.dates && b.dates.tradingCloses
      ? `${b.status && b.status.code === "conflict" ? "PUBLISHED CLOSE TIME" : "TRADING " + _kTense(b.dates.tradingCloses, now).toUpperCase()}: ${_kDateTimeUtc(b.dates.tradingCloses)}`
      : "",
    b.dates && b.dates.resolved ? `RESOLVED: ${_kDateTimeUtc(b.dates.resolved)}` : "",
    b.resolution ? `RESOLUTION: ${b.resolution.text}` : "",
    (() => {
      const won = (b.outcomes || []).filter((o) => o.result === "won")
      if (!won.length) return ""
      return won.length === 1
        ? `WINNING OUTCOME: ${won[0].name}`
        : `WINNING OUTCOMES (${won.length}): ${won.map((o) => o.name).join(", ")}`
    })(),
    b.links && b.links.event ? `EVENT PAGE: ${b.links.event}` : "",
    b.links && b.links.api ? `API: ${b.links.api}` : "",
  ].filter(Boolean)

  const issues = (b.issues || []).filter((i) => i.level !== "info")
  if (issues.length) {
    lines.push("FLAGS:")
    issues.forEach((i) => lines.push(`  - ${i.title}`))
  }

  const readAt = _kDateTimeUtc(b.retrievedAt) || _kDateTimeUtc(new Date(now).toISOString())
  return [
    kyleHeadline(b, now, { relative: false }),
    "",
    lines.join("\n"),
    "",
    `Source: Gemini Prediction Markets API, read ${readAt}.`,
    "Event data only — not a statement of any customer's account, position, or payout.",
    "Confirm the current state on the event page before quoting it to a customer.",
  ].join("\n")
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function kyleResultsHtml(events, query) {
  const list = Array.isArray(events) ? events : []
  if (!list.length) {
    return `<div class="k-empty">
      <div class="k-empty-title">No Gemini event matches “${_kEsc(query)}”</div>
      <div class="k-empty-body">Try fewer words, or the customer's own words for the thing being predicted (a team, a person, a price). If the customer sent a link, paste the whole link instead.</div>
    </div>`
  }
  const rows = list.map((e) => {
    const b = kyleBrief(e)
    const close = b.dates.tradingCloses
      ? `${_kTense(b.dates.tradingCloses) === "closed" ? "Closed" : "Closes"} ${_kDate(b.dates.tradingCloses)}`
      : ""
    const meta = [b.ticker, b.sport || b.category, b.type.label, close].filter(Boolean)
      .map((m) => `<span>${_kEsc(m)}</span>`).join("")
    return `<button type="button" class="k-result" data-ticker="${_kEsc(b.ticker)}" onclick="kyleOpen(this.dataset.ticker)">
      <span class="k-pill k-${b.status.tone}">${_kEsc(b.status.short || b.status.label)}</span>
      <span class="k-result-body">
        <span class="k-result-title">${_kEsc(b.title)}</span>
        <span class="k-result-meta">${meta}</span>
      </span>
    </button>`
  }).join("")
  return `<div class="k-results">
    <div class="k-results-head">${list.length} matching event${list.length === 1 ? "" : "s"} — pick the one the customer means</div>
    ${rows}
  </div>`
}

function _kFact(label, value, hint) {
  if (!value) return ""
  return `<div class="k-fact">
    <div class="k-fact-key">${_kEsc(label)}</div>
    <div class="k-fact-val">${_kEsc(value)}${hint ? `<span class="k-fact-hint">${_kEsc(hint)}</span>` : ""}</div>
  </div>`
}

// Fields worth a row are the ones an agent would otherwise have to go and find.
// The event title and ticker are already in the header, so repeating them in a
// table is just more page between the reader and the answer.
function kyleFactsHtml(b) {
  const conflicted = b.status && b.status.code === "conflict"
  const closedAlready = _kTense(b.dates.tradingCloses) === "closed"
  // Every timestamp shows UTC underneath the agent's local rendering. Gemini
  // publishes UTC and that is what the customer sees on the event page, so an
  // agent reading local time alone will quote a different day than the customer
  // is looking at.
  // UTC is the primary rendering: it is what the customer sees on gemini.com,
  // and printing local time, UTC and a relative age for one moment was three
  // ways of saying the same thing in a row.
  const stamp = (label, iso) => _kFact(label, _kDateTimeUtc(iso), iso ? _kRelative(iso) : "")
  return [
    _kFact("Type", b.type.label),
    _kFact("Sport", b.sport),
    _kFact("Category", b.category),
    _kFact(b.dates.listedLabel || "Listed", _kDate(b.dates.listed)),
    stamp("Event starts", b.dates.eventStart),
    stamp(conflicted ? "Published close time" : closedAlready ? "Trading closed" : "Trading closes", b.dates.tradingCloses),
    stamp("Resolved", b.dates.resolved),
    _kFact("Contracts", b.stats.contracts ? String(b.stats.contracts) : ""),
    // Only shown when Gemini published it — a blank row is honest, an assumed
    // "$1" is not.
    _kFact("Winning contract settles at", b.settlement && b.settlement.known ? b.settlement.amount : ""),
    _kFact("Total traded", b.stats.volume),
  ].filter(Boolean).join("")
}

// A 22-driver field should not push the answer off the screen. Winners, the
// contract the agent pasted, and the leaders stay visible; the tail is one
// click away.
const KYLE_OUTCOMES_SHOWN = 6

function _kOutcomeHtml(o) {
  const cls = [
    "k-outcome",
    o.focus ? "k-outcome-focus" : "",
    o.result === "won" ? "k-outcome-won" : "",
    o.result === "lost" ? "k-outcome-lost" : "",
  ].filter(Boolean).join(" ")
  const tags = [
    o.focus ? `<span class="k-tag k-tag-focus">pasted</span>` : "",
    o.result === "won" ? `<span class="k-tag k-tag-won">WON</span>` : "",
    o.result === "lost" ? `<span class="k-tag">lost</span>` : "",
    o.derived && !o.result ? `<span class="k-tag" title="Calculated as 100% minus the YES price, not quoted off a NO book">calculated</span>` : "",
  ].join("")
  return `<div class="${cls}">
    <span class="k-outcome-name">${_kEsc(o.name)}${tags}</span>
    <span class="k-outcome-pct">${o.result ? "" : _kEsc(o.pctLabel || "—")}</span>
  </div>`
}

function kyleOutcomesHtml(b) {
  const all = b.outcomes || []
  if (!all.length) return `<p class="k-note">No outcomes were returned for this event.</p>`
  // Anything the agent is looking for stays above the fold regardless of price.
  const pinned = all.filter((o) => o.focus || o.result === "won")
  const rest = all.filter((o) => !pinned.includes(o))
  const shown = pinned.concat(rest.slice(0, Math.max(0, KYLE_OUTCOMES_SHOWN - pinned.length)))
  const hidden = all.filter((o) => !shown.includes(o))
  return shown.map(_kOutcomeHtml).join("") + (hidden.length
    ? `<div id="kyleMoreOutcomes" class="k-more" hidden>${hidden.map(_kOutcomeHtml).join("")}</div>
       <button type="button" class="k-link-btn" id="kyleMoreBtn" onclick="kyleToggleOutcomes()">Show ${hidden.length} more</button>`
    : "")
}

function kyleBriefHtml(brief) {
  const b = brief
  const focus = kyleFocusAnswer(b)

  const issues = (b.issues || []).map((i) => `
    <div class="k-issue k-issue-${_kEsc(i.level)}">
      <span class="k-issue-title">${_kEsc(i.title)}</span>
      <span class="k-issue-body">${_kEsc(i.body)}</span>
    </div>`).join("")

  const priceNote = b.status.code === "settled" || b.status.code === "voided"
    ? ""
    : `<p class="k-note">A percentage is the price traders are paying, not Gemini's prediction — do not quote it to a customer as the odds of anything.</p>`

  // The event sentence is the answer when no contract was named, and the
  // supporting context when one was.
  const eventLine = _kEsc(kyleHeadline(b, Date.now(), { concise: !!focus }))

  return `
  <div class="k-brief">
    <section class="k-answer k-${_kEsc(b.status.tone)}">
      <div class="k-answer-head">
        <span class="k-pill k-${_kEsc(b.status.tone)}">${_kEsc(b.status.label)}</span>
        <span class="k-answer-ticker">${_kEsc(b.ticker)}</span>
      </div>
      <h1 class="k-title">${_kEsc(b.title)}</h1>

      ${focus ? `
      <div class="k-focus k-focus-${_kEsc(focus.verdict)}">
        <div class="k-focus-label">The contract you asked about</div>
        <div class="k-focus-name">${_kEsc(focus.name)}</div>
        <p class="k-focus-line">${_kEsc(focus.line)}</p>
        <p class="k-focus-note">${_kEsc(focus.note)}</p>
      </div>
      <p class="k-eventline"><span class="k-eventline-label">The event</span>${eventLine}</p>`
      : `<p class="k-headline">${eventLine}</p>`}

      ${b.description && b.description !== b.title ? `<p class="k-desc">${_kEsc(b.description)}</p>` : ""}

      <div class="k-meta">
        <span class="k-freshness" id="kyleFreshness" data-read="${_kEsc(b.retrievedAt)}">
          <span id="kyleFreshnessText">Read from Gemini just now</span>
        </span>
        <button type="button" class="k-copy" onclick="kyleRefresh()">Re-read</button>
      </div>
    </section>

    ${issues ? `<section class="k-card k-card-flag">
      <h2 class="k-card-label">Before you reply</h2>
      ${issues}
    </section>` : ""}

    <section class="k-card">
      <h2 class="k-card-label">Details</h2>
      <div class="k-facts">${kyleFactsHtml(b)}</div>
      <div class="k-disclosures">
        <details class="k-explain">
          <summary>What kind of market is this?</summary>
          <p>${_kEsc(b.type.plain)}</p>
        </details>
        ${b.criteria ? `<details class="k-explain">
          <summary>How this resolves${b.criteria.isExample ? ` — wording for ${_kEsc(b.criteria.contract)}` : ""}</summary>
          <p>${_kEsc(b.criteria.text)}</p>
          ${b.criteria.isExample ? `<p class="k-note">Every contract carries its own wording naming its own outcome; the rest of the rule is the same.</p>` : ""}
          ${b.criteria.agency ? `<p class="k-note">Result feed: ${_kEsc(b.criteria.agency)}.</p>` : ""}
        </details>` : ""}
      </div>
    </section>

    <section class="k-card">
      <h2 class="k-card-label">Hand-off</h2>
      <div class="k-actions">
        <button class="k-btn" onclick="kyleCopySummary()">Copy for the ticket</button>
        ${b.links.event ? `<a class="k-btn k-btn-quiet" href="${_kEsc(b.links.event)}" target="_blank" rel="noopener">Event on Gemini ↗</a>` : ""}
        ${b.links.api ? `<a class="k-btn k-btn-quiet" href="${_kEsc(b.links.api)}" target="_blank" rel="noopener">API response ↗</a>` : ""}
        ${b.links.terms ? `<a class="k-btn k-btn-quiet" href="${_kEsc(b.links.terms)}" target="_blank" rel="noopener">Contract terms ↗</a>` : ""}
      </div>
      ${b.links.api ? `<div class="k-apirow">
        <code class="k-apiurl" id="kyleApiUrl">${_kEsc(b.links.api)}</code>
        <button type="button" class="k-copy" id="kyleApiCopy" onclick="kyleCopyApiUrl()" title="Copy the API URL">Copy</button>
      </div>` : ""}
      <div class="k-disclosures">
        <details class="k-explain">
          <summary>Preview what gets copied</summary>
          <pre class="k-summary" id="kyleSummary">${_kEsc(kyleSummaryText(b))}</pre>
        </details>
      </div>
      <p class="k-disclaimer">Event data as published by Gemini. Not a statement of any customer's account, position, or payout, and not advice — confirm balances in the customer's account before you write to them.</p>
    </section>

    <section class="k-card">
      <h2 class="k-card-label">${b.status.code === "settled" ? "Outcomes and result" : "Outcomes"}</h2>
      ${kyleOutcomesHtml(b)}
      ${priceNote}
    </section>
  </div>`
}

// ── DOM wiring (browser only) ─────────────────────────────────────────────────

const KYLE_HAS_DOM = typeof document !== "undefined"
let _kyleBrief = null
let _kyleSeq = 0
let _kyleFreshnessTimer = null

function _kSet(html) {
  const el = document.getElementById("kyleResult")
  if (el) el.innerHTML = html
}

function _kBusy(on, text) {
  const btn = document.getElementById("kyleBtn")
  if (btn) { btn.disabled = !!on; btn.textContent = on ? "Looking…" : "Look up ↗" }
  if (on) _kSet(`<div class="k-empty"><div class="k-empty-title">${_kEsc(text || "Looking this up…")}</div></div>`)
}

function _kError(message) {
  _kSet(`<div class="k-empty k-empty-err">
    <div class="k-empty-title">Kyle could not load this event</div>
    <div class="k-empty-body">${_kEsc(message)}</div>
  </div>`)
}

async function _kJson(url) {
  const res = await fetch(url)
  let json = null
  try { json = await res.json() } catch { /* upstream sent a non-JSON error body */ }
  if (!res.ok) {
    const err = new Error((json && json.error) || `Gemini lookup failed (${res.status})`)
    err.status = res.status
    throw err
  }
  return json
}

async function kyleSubmit() {
  const input = document.getElementById("kyleInput")
  const parsed = kyleParseQuery(input ? input.value : "")
  if (parsed.kind === "empty") {
    _kSet(`<div class="k-empty"><div class="k-empty-title">Type what the customer is asking about</div><div class="k-empty-body">An event name, a ticker, or the Gemini link they sent you.</div></div>`)
    return
  }
  if (parsed.kind === "ticker") return kyleOpen(parsed.value)
  return kyleSearch(parsed.value)
}

async function kyleSearch(text) {
  const seq = ++_kyleSeq
  _kBusy(true, `Searching Gemini events for “${text}”…`)
  try {
    const data = await _kJson(`/api/gemini-markets?resource=events&search=${encodeURIComponent(text)}&limit=${KYLE_SEARCH_LIMIT}`)
    if (seq !== _kyleSeq) return
    const events = Array.isArray(data) ? data : (data.events || data.results || data.data || [])
    _kSet(kyleResultsHtml(events, text))
  } catch (err) {
    if (seq === _kyleSeq) _kError(err.message)
  } finally {
    if (seq === _kyleSeq) _kBusy(false)
  }
}

async function kyleOpen(ticker) {
  if (!ticker) return
  const seq = ++_kyleSeq
  _kBusy(true, `Loading ${ticker}…`)
  let lastErr = null
  try {
    // An instrument symbol resolves through its event ticker, so try each
    // candidate until one exists. Only a "no such event" answer moves on to the
    // next; a timeout or a 500 is reported rather than hidden behind a retry.
    for (const candidate of kyleTickerCandidates(ticker)) {
      let data
      try {
        data = await _kJson(`/api/gemini?ticker=${encodeURIComponent(candidate)}`)
      } catch (err) {
        lastErr = err
        if (err.status === 404 || /not found/i.test(err.message)) continue
        throw err
      }
      if (seq !== _kyleSeq) return
      const event = (data && data.event) || data
      // When the agent pasted a contract symbol, that contract is the customer's
      // position — mark it rather than leaving them to match it up by eye.
      _kyleBrief = kyleBrief(event, Date.now(), { focusSymbol: ticker, retrievedAt: Date.now() })
      _kSet(kyleBriefHtml(_kyleBrief))
      const input = document.getElementById("kyleInput")
      if (input) input.value = _kyleBrief.ticker || candidate
      window.scrollTo({ top: 0, behavior: "smooth" })
      kyleTickFreshness()
      if (_kyleFreshnessTimer) clearInterval(_kyleFreshnessTimer)
      _kyleFreshnessTimer = setInterval(kyleTickFreshness, 30000)
      return
    }
    if (seq !== _kyleSeq) return
    // Nothing matched as an ID. It was probably a name, not a ticker.
    _kSet(`<div class="k-empty"><div class="k-empty-title">No Gemini event with the ID “${_kEsc(ticker)}”</div><div class="k-empty-body">Searching for it by name instead…</div></div>`)
    return kyleSearch(ticker)
  } catch (err) {
    if (seq === _kyleSeq) _kError((err && err.message) || (lastErr && lastErr.message) || "Lookup failed")
  } finally {
    if (seq === _kyleSeq) _kBusy(false)
  }
}

// Prices and status are a snapshot. A tab left open all afternoon looks exactly
// as authoritative as one opened a second ago, so the age is stated, and past a
// few minutes it stops being a quiet note and starts telling the agent to
// re-read before quoting anything.
const KYLE_STALE_AFTER_MS = 5 * 60 * 1000

function kyleTickFreshness() {
  const el = document.getElementById("kyleFreshness")
  const text = document.getElementById("kyleFreshnessText")
  if (!el || !text) return
  const read = Date.parse(el.dataset.read || "")
  if (!Number.isFinite(read)) return
  const age = Date.now() - read
  const stale = age >= KYLE_STALE_AFTER_MS
  el.classList.toggle("k-stale", stale)
  text.textContent = stale
    ? `Read from Gemini ${_kRelative(new Date(read).toISOString())} — re-read before quoting this to a customer`
    : `Read from Gemini ${age < 60000 ? "just now" : _kRelative(new Date(read).toISOString())}`
}

function kyleRefresh() {
  if (_kyleBrief && _kyleBrief.ticker) kyleOpen(_kyleBrief.ticker)
}

function kyleToggleOutcomes() {
  const more = document.getElementById("kyleMoreOutcomes")
  const btn = document.getElementById("kyleMoreBtn")
  if (!more || !btn) return
  more.hidden = !more.hidden
  btn.textContent = more.hidden ? `Show ${more.children.length} more` : "Show fewer"
}

function _kCopy(text, button) {
  const flash = (message) => {
    if (!button) return
    const original = button.dataset.label || button.textContent
    button.dataset.label = original
    button.textContent = message
    setTimeout(() => { button.textContent = button.dataset.label }, 1600)
  }
  if (!navigator.clipboard || !navigator.clipboard.writeText) {
    flash("Select and copy")
    return
  }
  navigator.clipboard.writeText(text).then(() => flash("Copied ✓")).catch(() => flash("Select and copy"))
}

function kyleCopySummary() {
  if (!_kyleBrief) return
  _kCopy(kyleSummaryText(_kyleBrief), document.querySelector(".k-actions .k-btn"))
}

function kyleCopyApiUrl() {
  if (!_kyleBrief || !_kyleBrief.links.api) return
  _kCopy(_kyleBrief.links.api, document.getElementById("kyleApiCopy"))
}

if (KYLE_HAS_DOM) {
  window.addEventListener("DOMContentLoaded", () => {
    // ?event=TICKER lets an agent share a brief straight into a ticket thread.
    const params = new URLSearchParams(window.location.search)
    const preset = params.get("event") || params.get("ticker") || ""
    const input = document.getElementById("kyleInput")
    if (preset && input) { input.value = preset; kyleSubmit() }
    else if (input) input.focus()
  })
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    kyleParseQuery, kyleTickerCandidates, kyleStatus, kyleType, kyleExclusive, kyleDates, kyleSubject,
    kyleOutcomes, kyleWinner, kyleIssues, kyleBrief, kyleHeadline, kyleFocusAnswer, kyleSummaryText, kyleResolution,
    kyleResultsHtml, kyleBriefHtml, kyleFactsHtml, kyleOutcomesHtml, kyleSettlement,
  }
}
