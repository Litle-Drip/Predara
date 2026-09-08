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
  const push = (t) => { if (t && !out.includes(t)) out.push(t) }
  push(ticker)
  const base = String(ticker).replace(/^GEMI-/i, "")
  push(base)
  const parts = base.split("-")
  for (let drop = 1; drop <= 2 && parts.length - drop >= 2; drop++) {
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

  if (/cancel|void/.test(raw)) {
    return {
      code: "voided", label: "VOIDED", short: "VOIDED", tone: "bad",
      plain: "Gemini cancelled this event. It did not settle to a result — trades on a voided event are unwound rather than paid out. Send the customer to the settlement team for the refund position.",
    }
  }
  if (/settl|resolv|paid/.test(raw) || resolvedIso || hasSide) {
    return {
      code: "settled", label: "SETTLED", short: "SETTLED", tone: "done",
      plain: "This event is finished. The result is final and the winning contracts have paid out at $1 each; the losing contracts are worth nothing.",
    }
  }

  const closeIso = kyleDates(event).tradingCloses
  const closeT = _kTime(closeIso)
  const closedByClock = closeT !== null && closeT <= now

  if (/closed|expired|inactive|pending/.test(raw) || closedByClock) {
    return {
      code: "closed", label: "CLOSED — AWAITING RESULT", short: "CLOSED", tone: "warn",
      plain: "Trading has stopped but Gemini has not published the result yet. Nobody has been paid out and no position can be opened or closed. This is normal for a short window after an event ends.",
    }
  }
  if (/active|approved|open|live|trading/.test(raw)) {
    return {
      code: "open", label: "OPEN", short: "OPEN", tone: "good",
      plain: "This event is live. The customer can still buy and sell contracts, and no result exists yet — nothing has been decided or paid out.",
    }
  }
  return {
    code: "unknown", label: raw ? raw.toUpperCase() : "UNKNOWN", short: "UNKNOWN", tone: "warn",
    plain: "Gemini did not return a state Kyle recognises for this event. Do not tell the customer whether it is open or settled — check the event page before replying.",
  }
}

// Can more than one outcome pay out? A race winner market has exactly one
// winner; a podium market pays every driver who finishes top three, and a
// support agent told "only one of these can win" about a podium market will
// give the customer a wrong answer.
//
// Gemini does not consistently publish an exclusivity flag, so when there is no
// flag the prices decide: contracts that are mutually exclusive are priced as
// shares of one outcome and sum to roughly 100%, while independent yes/no
// contracts on the same event sum well past it (a three-place podium field sums
// near 300%). Returns true, false, or null when neither the flag nor enough
// prices are available — null means Kyle says nothing rather than guessing.
function kyleExclusive(event) {
  const e = event || {}
  for (const key of ["mutuallyExclusive", "mutually_exclusive", "isMutuallyExclusive", "exclusive"]) {
    if (typeof e[key] === "boolean") return e[key]
  }
  const contracts = _kContracts(e)
  if (e.type === "binary" || contracts.length === 1) return true

  const prices = contracts
    .map((c) => _kNum(_kFirst((c.prices || {}).lastTradePrice, (c.prices || {}).bestAsk, (c.prices || {}).bestBid)))
    .filter((p) => p !== null)
  // Too few priced contracts to read a total from — a thin or settled book.
  if (prices.length < contracts.length || prices.length < 2) return null
  const sum = prices.reduce((a, b) => a + b, 0)
  if (sum > 1.3) return false
  if (sum >= 0.7) return true
  return null
}

// Binary (one yes/no question) vs pick-one-of-many. This is the single thing
// support agents most often get wrong when reading a ticket back to a customer.
function kyleType(event) {
  const contracts = _kContracts(event)
  const n = contracts.length
  const isBinary = (event && event.type === "binary") || n === 1
  if (isBinary) {
    return {
      code: "binary", outcomeCount: 2, exclusive: true, label: "Yes / No question",
      plain: "One question with two sides. A customer holding YES is paid $1 per contract if it happens; a customer holding NO is paid $1 per contract if it does not. Only one side can be right.",
    }
  }

  const exclusive = kyleExclusive(event)
  const ask = ` Ask the customer WHICH outcome they hold — "I bet on this event" is not enough to look up their position.`

  if (n === 2 && exclusive === true) {
    return {
      code: "head2head", outcomeCount: 2, exclusive: true, label: "Head-to-head (2 outcomes)",
      plain: "Two possible results, usually two teams or two candidates. The one that actually happens pays $1 per contract; the other pays nothing.",
    }
  }
  if (exclusive === true) {
    return {
      code: "multi", outcomeCount: n, exclusive: true, label: `Pick one of ${n} outcomes`,
      plain: `${n} possible results, and only one of them can happen. That one pays $1 per contract; every other one pays nothing.` + ask,
    }
  }
  if (exclusive === false) {
    return {
      code: "multi", outcomeCount: n, exclusive: false, label: `${n} separate outcomes (more than one can win)`,
      plain: `${n} separate yes/no contracts on the same event — a podium or top-N market, where several of them can pay out at once. Each one pays $1 per contract if that outcome happens, independently of the others, so a customer can hold a losing contract on an event that had several winners.` + ask,
    }
  }
  return {
    code: "multi", outcomeCount: n, exclusive: null, label: `${n} outcomes`,
    plain: `${n} separate contracts, each paying $1 per contract if its outcome happens. Kyle cannot tell from this event's data whether only one of them can pay out or several can, so do not tell the customer that the others must have lost — check the event page if their question turns on it.` + ask,
  }
}

function kyleDates(event) {
  const e = event || {}
  const contracts = _kContracts(e)
  const c0 = contracts[0] || {}
  return {
    listed: _kFirst(e.openDate, e.startDate, e.effectiveDate, e.createdAt),
    eventStart: _kFirst(e.startTime, e.eventStartTime, e.gameTime),
    tradingCloses: _kFirst(e.closeDate, e.expiryDate, e.endDate, c0.closeDate, c0.expiryDate, c0.endDate),
    resolved: _kFirst(e.resolvedAt, e.settledAt, e.resolutionDate),
  }
}

// Sports events carry a league; everything else carries a category. Agents
// route tickets by this, so both are surfaced under one "type" line.
function kyleSubject(event) {
  const e = event || {}
  const ticker = String(_kFirst(e.ticker, e.event_ticker, e.eventTicker) || "")
  const leagues = ["MLB", "NBA", "NFL", "NHL", "NCAAF", "NCAAB", "MLS", "EPL", "UFC"]
  const fromTicker = leagues.find((l) => new RegExp(`(^|-)${l}(-|$)`, "i").test(ticker)) || ""
  return {
    sport: _kFirst(e.sport, e.league, fromTicker),
    category: _kFirst(e.category, e.categoryName, Array.isArray(e.tags) ? e.tags[0] : ""),
  }
}

function kyleOutcomes(event) {
  const contracts = _kContracts(event)
  const type = kyleType(event)
  const rows = contracts.map((c, i) => {
    const p = (c && c.prices) || {}
    const price = _kNum(_kFirst(p.lastTradePrice, p.bestAsk, p.bestBid, c.lastPrice, c.price))
    const side = String((c && c.resolutionSide) || "").toLowerCase()
    return {
      name: String(_kContractName(c, `Outcome ${i + 1}`)),
      symbol: String(_kFirst(c.instrumentSymbol, c.instrument_symbol, c.ticker, "")),
      pct: price === null ? null : Math.round(price * 100),
      result: side === "yes" ? "won" : side === "no" ? "lost" : null,
    }
  })
  // On a binary event the single contract IS the YES side; spell out the NO side
  // so an agent looking at a customer who "bet no" sees their side listed.
  if (type.code === "binary" && rows.length === 1) {
    const yes = rows[0]
    return [
      { ...yes, name: "YES — " + yes.name },
      {
        name: "NO — the opposite",
        symbol: "",
        pct: yes.pct === null ? null : 100 - yes.pct,
        result: yes.result === "won" ? "lost" : yes.result === "lost" ? "won" : null,
      },
    ]
  }
  return rows.sort((a, b) => (b.pct === null ? -1 : b.pct) - (a.pct === null ? -1 : a.pct))
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
      body: "Do not quote a result. Voided events are unwound, so the customer's question is a refund question — escalate to settlement." })
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

  if (status.code === "open" && closeT !== null && closeT <= now) {
    issues.push({ level: "alert", title: "Data conflict: listed as open but the close time has passed",
      body: "The event still reports an open state although its close time is in the past. Treat the state as unconfirmed and check the event page before answering." })
  }

  if (!dates.tradingCloses) {
    issues.push({ level: "warn", title: "No close date published",
      body: "This event does not publish an end date, so Kyle cannot tell the customer when trading stops or when it resolves." })
  }

  if (status.code !== "settled" && type.code === "multi") {
    issues.push({ level: "info", title: "Multiple outcomes — get the specific one",
      body: `This event has ${type.outcomeCount} separate contracts${type.exclusive === false ? ", and more than one of them can pay out" : ""}. A position lookup needs the exact outcome the customer holds, not just the event name.` })
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
      ? { known: true, text: `Resolved ${_kDateTime(dates.resolved)} (${_kRelative(dates.resolved, now)})` }
      : status.code === "settled"
        ? { known: false, text: "Marked settled, but no resolution timestamp was published." }
        : dates.tradingCloses
          ? { known: false, text: `Not resolved yet. Trading ${_kTense(dates.tradingCloses, now)} ${_kDateTime(dates.tradingCloses)} (${_kRelative(dates.tradingCloses, now)}) and the result is published after that.` }
          : { known: false, text: "Not resolved yet, and no close date is published — Kyle cannot say when it will resolve." },
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
      terms: String(_kFirst(e.termsLink, e._contract_url, contracts[0] && contracts[0].termsAndConditionsUrl) || ""),
    },
  }
}

// Plain text an agent pastes straight into the ticket. No markup, no emoji —
// it gets read by the next agent and sometimes by the customer.
function kyleSummaryText(brief) {
  const b = brief || {}
  const lines = [
    `EVENT: ${b.title}`,
    b.ticker ? `TICKER: ${b.ticker}` : "",
    `STATUS: ${b.status && b.status.label}`,
    `TYPE: ${b.type && b.type.label}${b.sport ? ` — ${b.sport}` : ""}${b.category ? ` — ${b.category}` : ""}`,
    b.dates && b.dates.tradingCloses ? `TRADING ${_kTense(b.dates.tradingCloses).toUpperCase()}: ${_kDateTime(b.dates.tradingCloses)}` : "",
    b.dates && b.dates.resolved ? `RESOLVED: ${_kDateTime(b.dates.resolved)}` : "",
    b.resolution ? `RESOLUTION: ${b.resolution.text}` : "",
    (() => {
      const won = (b.outcomes || []).filter((o) => o.result === "won")
      if (!won.length) return ""
      return won.length === 1
        ? `WINNING OUTCOME: ${won[0].name}`
        : `WINNING OUTCOMES (${won.length}): ${won.map((o) => o.name).join(", ")}`
    })(),
    (b.outcomes || []).filter((o) => o.focus).map((o) => `CONTRACT ASKED ABOUT: ${o.name}${o.result ? ` (${o.result === "won" ? "won — paid $1" : "did not win — paid $0"})` : ""}`).join("\n"),
    b.links && b.links.event ? `EVENT PAGE: ${b.links.event}` : "",
  ].filter(Boolean)

  const issues = (b.issues || []).filter((i) => i.level !== "info")
  if (issues.length) {
    lines.push("FLAGS:")
    issues.forEach((i) => lines.push(`  - ${i.title}`))
  }
  return lines.join("\n")
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

function _kRow(label, value, hint) {
  if (!value) return ""
  return `<div class="k-row">
    <div class="k-row-key">${_kEsc(label)}</div>
    <div class="k-row-val">${_kEsc(value)}${hint ? `<span class="k-row-hint">${_kEsc(hint)}</span>` : ""}</div>
  </div>`
}

function kyleBriefHtml(brief) {
  const b = brief
  const issues = (b.issues || []).map((i) => `
    <div class="k-issue k-issue-${_kEsc(i.level)}">
      <div class="k-issue-title">${_kEsc(i.title)}</div>
      <div class="k-issue-body">${_kEsc(i.body)}</div>
    </div>`).join("")

  const outcomes = (b.outcomes || []).map((o) => `
    <div class="k-outcome${o.focus ? " k-outcome-focus" : ""}${o.result === "won" ? " k-outcome-won" : o.result === "lost" ? " k-outcome-lost" : ""}">
      <div class="k-outcome-name">${_kEsc(o.name)}${o.focus ? `<span class="k-tag k-tag-focus">the contract you pasted</span>` : ""}${o.result === "won" ? `<span class="k-tag k-tag-won">WON</span>` : o.result === "lost" ? `<span class="k-tag">did not win</span>` : ""}</div>
      <div class="k-outcome-pct">${o.result ? "" : o.pct === null ? "—" : _kEsc(o.pct + "%")}</div>
    </div>`).join("")

  const stats = [
    b.stats.volume ? `Total traded ${b.stats.volume}` : "",
    b.stats.liquidity ? `Liquidity ${b.stats.liquidity}` : "",
    b.stats.openInterest ? `Open interest ${b.stats.openInterest}` : "",
  ].filter(Boolean).map((s) => `<span>${_kEsc(s)}</span>`).join("")

  return `
  <div class="k-brief">
    <div class="k-status k-${_kEsc(b.status.tone)}">
      <div class="k-status-head">
        <span class="k-pill k-${_kEsc(b.status.tone)}">${_kEsc(b.status.label)}</span>
        <span class="k-status-ticker">${_kEsc(b.ticker)}</span>
      </div>
      <h1 class="k-title">${_kEsc(b.title)}</h1>
      <p class="k-status-plain">${_kEsc(b.status.plain)}</p>
    </div>

    <div class="k-card">
      <div class="k-card-label">What this event is</div>
      <p class="k-lede">${_kEsc(b.description || b.title)}</p>
      <p class="k-plain">${_kEsc(b.type.plain)}</p>
    </div>

    ${issues ? `<div class="k-card k-card-flag">
      <div class="k-card-label">Before you reply</div>
      ${issues}
    </div>` : ""}

    <div class="k-card">
      <div class="k-card-label">The facts</div>
      ${_kRow("Event", b.title)}
      ${_kRow("Ticker", b.ticker, "paste this into the ticket")}
      ${_kRow("Type", b.type.label)}
      ${_kRow("Sport", b.sport)}
      ${_kRow("Category", b.category)}
      ${_kRow("Listed", _kDate(b.dates.listed))}
      ${_kRow("Event starts", _kDateTime(b.dates.eventStart))}
      ${_kRow(_kTense(b.dates.tradingCloses) === "closed" ? "Trading closed" : "Trading closes", _kDateTime(b.dates.tradingCloses), _kRelative(b.dates.tradingCloses))}
      ${_kRow("Resolved", _kDateTime(b.dates.resolved), _kRelative(b.dates.resolved))}
      ${_kRow("Resolution", b.resolution.text)}
      ${b.winner ? _kRow("Winning outcome", b.winner.name, "paid $1 per contract") : ""}
    </div>

    <div class="k-card">
      <div class="k-card-label">Outcomes ${b.status.code === "settled" ? "and result" : "and what the market currently thinks"}</div>
      ${b.status.code === "settled" ? "" : `<p class="k-plain">A percentage here is the price traders are paying, read as a chance. It is not Gemini's prediction and it is not advice — do not quote it to a customer as the odds of anything.</p>`}
      ${outcomes || `<p class="k-plain">No outcomes were returned for this event.</p>`}
      ${stats ? `<div class="k-stats">${stats}</div>` : ""}
    </div>

    <div class="k-card">
      <div class="k-card-label">Hand-off</div>
      <div class="k-actions">
        <button class="k-btn" onclick="kyleCopySummary()">Copy summary for the ticket</button>
        ${b.links.event ? `<a class="k-btn k-btn-quiet" href="${_kEsc(b.links.event)}" target="_blank" rel="noopener">Open event on Gemini ↗</a>` : ""}
        ${b.links.terms ? `<a class="k-btn k-btn-quiet" href="${_kEsc(b.links.terms)}" target="_blank" rel="noopener">Contract terms ↗</a>` : ""}
      </div>
      <pre class="k-summary" id="kyleSummary">${_kEsc(kyleSummaryText(b))}</pre>
    </div>
  </div>`
}

// ── DOM wiring (browser only) ─────────────────────────────────────────────────

const KYLE_HAS_DOM = typeof document !== "undefined"
let _kyleBrief = null
let _kyleSeq = 0

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
      _kyleBrief = kyleBrief(event, Date.now(), { focusSymbol: ticker })
      _kSet(kyleBriefHtml(_kyleBrief))
      const input = document.getElementById("kyleInput")
      if (input) input.value = _kyleBrief.ticker || candidate
      window.scrollTo({ top: 0, behavior: "smooth" })
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

function kyleCopySummary() {
  if (!_kyleBrief) return
  const text = kyleSummaryText(_kyleBrief)
  const done = () => {
    const el = document.querySelector(".k-actions .k-btn")
    if (!el) return
    const original = el.textContent
    el.textContent = "Copied ✓"
    setTimeout(() => { el.textContent = original }, 1600)
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => {})
  }
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
    kyleOutcomes, kyleWinner, kyleIssues, kyleBrief, kyleSummaryText,
    kyleResultsHtml, kyleBriefHtml,
  }
}
