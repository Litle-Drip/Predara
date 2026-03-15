const PLATFORMS = {
  kalshi:     { label: "KALSHI",     accent: "#00C805" },
  polymarket: { label: "POLYMARKET", accent: "#7B3FE4" },
  gemini:     { label: "GEMINI",     accent: "#00DCFA" },
  coinbase:   { label: "COINBASE",   accent: "#1652F0" },
}

const GLOSSARY = {
  "VOLUME TRADED":    "Total dollars that have changed hands since this market opened.",
  "24H VOLUME":       "Dollars traded in the last 24 hours — measures current activity.",
  "LIQUIDITY":        "How easy it is to enter or exit without moving the price.",
  "OPEN INTEREST":    "Total value of all outstanding positions not yet settled.",
  "COMMENTS":         "Number of comments from traders discussing this market.",
  "BREAK-EVEN":       "The minimum win probability needed to profit at the current ask price.",
  "EXPECTED VALUE":   "Average profit per $1 bet. Positive = good value vs market price.",
  "EV":               "Average profit per $1 bet. Positive = good value vs market price.",
  "KELLY CRITERION":  "Optimal bet size as % of bankroll to maximize long-term growth.",
  "KELLY":            "Optimal bet size as % of bankroll to maximize long-term growth.",
  "SPREAD QUALITY":   "Bid-ask gap as % of midpoint. Lower = cheaper to trade.",
  "SPREAD":           "Gap between the bid and ask price. Tighter spread = more liquid market.",
  "MONEYLINE":        "American odds format. -150 means bet $150 to win $100. +200 means bet $100 to win $200.",
  "BID / ASK":        "Bid = highest price a buyer will pay. Ask = lowest price a seller will accept.",
  "PROJECTED PAYOUT": "If the current leader wins, how much each contract pays. Kalshi contracts always pay $1 on a win — profit depends on what you paid.",
}

function esc(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function tip(text, key) {
  const def = GLOSSARY[key || text]
  if (!def) return esc(text)
  return `<span class="tip" tabindex="0" data-tip="${esc(def)}">${esc(text)}</span>`
}

function toMoneyline(pct) {
  if (pct <= 0 || pct >= 100) return "—"
  return pct >= 50
    ? `-${Math.round(pct / (100 - pct) * 100)}`
    : `+${Math.round((100 - pct) / pct * 100)}`
}

function fmtDate(iso) {
  if (!iso || typeof iso !== "string" || iso.startsWith("0001")) return "—"
  const d = new Date(iso)
  if (isNaN(d)) return "—"
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/New_York" })
}

function fmtDateTime(iso) {
  if (!iso || typeof iso !== "string" || iso.startsWith("0001")) return "—"
  const d = new Date(iso)
  if (isNaN(d)) return "—"
  return d.toLocaleString("en-US", {
    month: "long", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", timeZone: "America/New_York", timeZoneName: "short"
  })
}

function categoryColor(cat) {
  const c = (cat || "").toLowerCase()
  if (/politi|election|govern|democrat|republican|senate|congress|president/.test(c)) return "#3b82f6"
  if (/sport|golf|pga|nfl|nba|mlb|nhl|soccer|tennis|football|basketball|baseball|hockey|ufc|fight/.test(c)) return "#22c55e"
  if (/financ|econom|gdp|inflation|fed|rate|stock|market|bond|yield/.test(c)) return "#f59e0b"
  if (/crypto|bitcoin|btc|ethereum|eth|web3|token|coin/.test(c)) return "#6366f1"
  if (/tech|science|space|ai|software|computer/.test(c)) return "#06b6d4"
  if (/entertain|culture|celebrity|award|movie|music|tv|film|oscar|grammy/.test(c)) return "#a855f7"
  if (/health|medical|covid|drug|pharma|disease/.test(c)) return "#ec4899"
  if (/business|company|corporate|ceo|merger|ipo/.test(c)) return "#f97316"
  return "#6b7280"
}

// Shared outcome color palette used by both Kalshi and Polymarket renderers
const OUTCOME_COLORS = ["#22c55e", "#60a5fa", "#f59e0b", "#a78bfa", "#34d399", "#fb923c", "#38bdf8", "#f472b6"]

// volume_fp unit detection: Kalshi event-level fp fields can be in cents (very large, >1e8) or dollars.
// Market-level m.volume_fp is consistently cents — callers divide by 100 directly.
function parseEventFP(val) {
  const n = parseFloat(val || 0)
  return n > 1e8 ? n / 100 : n
}

// Shared resolve-text cleaner used in both plainEnglishRules and betExplainer derivation
function applyResolveText(text) {
  return text
    .replace(/the market (?:will )?resolve[sd]? (?:to )?"?Yes"?\.?/gi, "you win")
    .replace(/the market (?:will )?resolve[sd]? (?:to )?"?No\.?"?\.?/gi, "you lose")
    .replace(/this market (?:will )?resolve[sd]? (?:to )?"?Yes"?\.?/gi, "you win")
    .replace(/this market (?:will )?resolve[sd]? (?:to )?"?No\.?"?\.?/gi, "you lose")
    .replace(/the market (?:will )?resolve[sd]? 50-50/gi, "your bet is returned (50-50 split)")
}

function fmtNum(val) {
  const n = Math.round(parseFloat(val || 0))
  return n > 0 ? n.toLocaleString() : null
}

function fmtTimeRemaining(iso) {
  if (!iso || typeof iso !== "string" || iso.startsWith("0001")) return null
  const d = new Date(iso)
  if (isNaN(d)) return null
  const ms = d - Date.now()
  if (ms <= 0) return { text: "CLOSED", urgency: "high" }
  const hrs = Math.floor(ms / 3600000)
  const days = Math.floor(hrs / 24)
  const remHrs = hrs % 24
  let text
  if (days > 0) text = `CLOSES IN ${days} DAY${days > 1 ? "S" : ""}${remHrs > 0 ? ` ${remHrs} HR${remHrs > 1 ? "S" : ""}` : ""}`
  else if (hrs > 0) text = `CLOSES IN ${hrs} HR${hrs > 1 ? "S" : ""}`
  else text = `CLOSES IN < 1 HR`
  const urgency = days >= 7 ? "low" : days >= 1 ? "med" : "high"
  return { text, urgency }
}

function plainEnglishRules(rulesText) {
  if (!rulesText || typeof rulesText !== "string") return []
  return rulesText
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 15)
    .filter(s => !s.toLowerCase().startsWith("kalshi is not affiliated"))
    .filter(s => !s.toLowerCase().startsWith("kalshi reserves"))
    .filter(s => !s.toLowerCase().includes("for more information"))
    .map(s => applyResolveText(s)
      .replace(/^If /i, "If ")
      .replace(/^The following market refers to /i, "This bet is about ")
      .replace(/,\s*then you win\.?$/i, ", you win.")
      .replace(/\.$/, "")
    )
    .filter(s => s.length > 10)
}

function whatsTheBetCard(text) {
  if (!text) return ""
  return `
    <div class="mi-card bet-explainer">
      <div class="section-label">WHAT'S THE BET?</div>
      <div class="bet-explainer-body">${esc(text)}</div>
    </div>`
}

function betSimulatorHtml(pctYes) {
  if (!pctYes || pctYes <= 0 || pctYes >= 100) return ""
  const prob = pctYes / 100
  const defaultBet = window._simMarket ? window._simMarket.amount : 10
  const winPayout = (defaultBet / prob).toFixed(2)
  const profit = (winPayout - defaultBet).toFixed(2)
  return `
    <div class="mi-card bet-sim-card">
      <div class="section-label">BET CALCULATOR</div>
      <div class="bet-sim-body">
        <div class="bet-sim-input-row">
          <span class="bet-sim-label">If you bet</span>
          <span class="bet-sim-dollar">$</span>
          <input type="number" class="bet-sim-input" id="betSimInput" value="${defaultBet}" min="1" max="100000" step="1"
            oninput="updateBetSim()" />
          <span class="bet-sim-label">on the leading outcome at <strong>${pctYes}%</strong></span>
        </div>
        <div class="bet-sim-results" id="betSimResults">
          <div class="bet-sim-win">If you <strong>win</strong>: collect <strong>$${winPayout}</strong> <span class="val-green">(+$${profit} profit)</span></div>
          <div class="bet-sim-lose">If you <strong>lose</strong>: lose your <strong>$${defaultBet.toFixed(2)}</strong></div>
        </div>
      </div>
    </div>`
}

window._simMarket = { amount: 10, pct: 0, platform: "" }
function updateBetSim() {
  const input = document.getElementById("betSimInput")
  const results = document.getElementById("betSimResults")
  if (!input || !results) return
  const bet = Math.max(0, parseFloat(input.value) || 0)
  window._simMarket.amount = bet
  const prob = window._simMarket.pct / 100
  if (prob <= 0 || prob >= 1 || bet <= 0) {
    results.innerHTML = `<div class="bet-sim-win" style="color:var(--muted)">Enter a bet amount above</div>`
    return
  }
  const winPayout = (bet / prob).toFixed(2)
  const profit = (winPayout - bet).toFixed(2)
  results.innerHTML = `
    <div class="bet-sim-win">If you <strong>win</strong>: collect <strong>$${winPayout}</strong> <span class="val-green">(+$${profit} profit)</span></div>
    <div class="bet-sim-lose">If you <strong>lose</strong>: lose your <strong>$${bet.toFixed(2)}</strong></div>
  `
}

function calcAnalyticsRow(label, prob, ask, bid) {
  if (!Number.isFinite(prob) || prob <= 0 || prob >= 1) return null
  if (!Number.isFinite(ask) || ask <= 0 || ask >= 1) return null
  const round1 = n => Math.round(n * 10) / 10
  const breakEven = round1(ask * 100)
  const ev = round1((prob - ask) / ask * 100)
  const mid = Number.isFinite(bid) ? (bid + ask) / 2 : ask
  const spread = mid > 0 && Number.isFinite(bid) ? round1((ask - bid) / mid * 100) : null
  let kelly = null
  const b = (1 - ask) / ask
  if (b > 0) {
    const k = (prob * b - (1 - prob)) / b
    kelly = Math.min(Math.max(round1(k * 100), 0), 25)
  }
  return { label, breakEven, ev, spread, kelly }
}

function analyticsCard(rows, timeLeft) {
  if ((!rows || !rows.length) && !timeLeft) return ""
  const multiRow = rows.length > 1
  const lines = rows.map(r => {
    const parts = []
    parts.push(`<div class="info-row"><span class="info-key">${tip("BREAK-EVEN")}</span><span class="info-val val-muted">${r.breakEven}%</span></div>`)
    const evClass = r.ev > 0 ? "val-green" : r.ev < 0 ? "val-red" : "val-muted"
    parts.push(`<div class="info-row"><span class="info-key">${tip("EXPECTED VALUE")}</span><span class="info-val ${evClass}">${r.ev > 0 ? "+" : ""}${r.ev}%</span></div>`)
    if (r.kelly !== null) {
      parts.push(`<div class="info-row"><span class="info-key">${tip("KELLY CRITERION")}</span><span class="info-val val-muted">${r.kelly}%</span></div>`)
    }
    if (r.spread !== null) {
      const spClass = r.spread < 3 ? "val-green" : r.spread < 8 ? "val-amber" : "val-red"
      parts.push(`<div class="info-row"><span class="info-key">${tip("SPREAD QUALITY")}</span><span class="info-val ${spClass}">${r.spread}%</span></div>`)
    }
    if (multiRow) {
      return `<div class="info-row" style="border-bottom:none;padding-bottom:4px"><span class="info-key" style="color:#d8d6cc;font-weight:600">${esc(r.label)}</span></div>` + parts.join("")
    }
    return parts.join("")
  }).join("")
  const timeRow = timeLeft
    ? `<div class="info-row"><span class="info-key">TIME REMAINING</span><span class="info-val urgency-text-${timeLeft.urgency}">⏱ ${esc(timeLeft.text)}</span></div>`
    : ""
  return `
    <div class="mi-card">
      <div class="section-label">TRADER ANALYTICS</div>
      ${timeRow}
      ${lines}
    </div>`
}

function statCard(label, value) {
  const inner = value
    ? `<div class="stat-value">${value}</div>`
    : `<div class="stat-dash"></div>`
  return `<div class="stat-card"><div class="stat-label">${tip(label)}</div>${inner}</div>`
}

// Only render a timeline row if the value is a real date (not "—")
function infoRow(key, val) {
  if (!val || val === "—") return ""
  return `<div class="info-row"><span class="info-key">${esc(key)}</span><span class="info-val">${esc(val)}</span></div>`
}

function numList(sentences) {
  return sentences.map((s, i) => `
    <div class="num-row">
      <span class="num-idx">${String(i + 1).padStart(2, "0")}</span>
      <span class="num-text">${s}</span>
    </div>`).join("")
}

function outcomeRow(label, sub, pct, color, delta = null, extras = {}) {
  const ml = toMoneyline(pct)
  const deltaHtml = delta !== null && delta !== 0
    ? `<span class="outcome-delta ${delta > 0 ? 'delta-up' : 'delta-dn'}">${delta > 0 ? '▲' : '▼'} ${Math.abs(delta)}</span>`
    : ""
  const metaParts = []
  if (Number.isFinite(extras.bid) && Number.isFinite(extras.ask)) {
    metaParts.push(`${tip("Bid", "BID / ASK")} ${Math.round(extras.bid * 100)}¢ · ${tip("Ask", "BID / ASK")} ${Math.round(extras.ask * 100)}¢`)
  }
  if (extras.vol) metaParts.push(`Vol $${extras.vol}`)
  if (extras.oi) metaParts.push(`OI $${extras.oi}`)
  const metaHtml = metaParts.length
    ? `<div class="outcome-meta">${metaParts.map(p => `<span>${p}</span>`).join("")}</div>`
    : ""
  return `
    <div class="outcome-row">
      <div class="outcome-top">
        <div>
          <div class="outcome-name" style="color:${color}">${esc(label)}</div>
          ${sub ? `<div class="outcome-sub">${esc(sub)}</div>` : ""}
        </div>
        <div class="outcome-right">
          <span class="outcome-ml">${tip(ml, "MONEYLINE")}</span>
          <span class="outcome-pct" style="color:${color}">${pct}%</span>
          ${deltaHtml}
        </div>
      </div>
      <div class="bar-wrap">
        <div class="bar-fill" style="width:${pct}%; background:${color}"></div>
      </div>
      ${metaHtml}
    </div>`
}

// Paginated show-more: reveals PAGE_SIZE rows at a time
const PAGE_SIZE = 5
window._outcomePages = {}

function showMoreOutcomes(uid) {
  const pool = window._outcomePages[uid]
  if (!pool || !pool.length) return
  const batch = pool.splice(0, PAGE_SIZE)
  const row = document.getElementById(uid + "_smr")
  const tmp = document.createElement("div")
  tmp.innerHTML = batch.join("")
  while (tmp.firstChild) row.parentNode.insertBefore(tmp.firstChild, row)
  const btn = row.querySelector("button")
  if (!pool.length) {
    row.remove()
    delete window._outcomePages[uid]
  } else {
    btn.textContent = `+ ${pool.length} MORE  ↓`
  }
}

function buildOutcomesHtml(rows) {
  if (rows.length <= PAGE_SIZE) return rows.join("")
  const uid = "op" + Math.random().toString(36).slice(2, 8)
  window._outcomePages[uid] = rows.slice(PAGE_SIZE)
  return rows.slice(0, PAGE_SIZE).join("") + `
    <div class="show-more-row" id="${uid}_smr">
      <button class="show-more-btn" onclick="showMoreOutcomes('${uid}')">
        + ${rows.length - PAGE_SIZE} MORE  ↓
      </button>
    </div>`
}

function renderKalshiEvent(ev, accent) {
  // markets = outcomes shown to user (may be filtered to a specific sub-market)
  // allMarkets = full event market list, used for aggregate stats (volume, OI, liquidity, start date)
  const markets    = (ev.markets || []).filter(m => m.yes_sub_title)
  const allMarkets = (ev._allMarkets || ev.markets || []).filter(m => m.yes_sub_title)
  if (!markets.length) return `<div class="mi-error">No outcome data available for this market.</div>`
  const first = markets[0] || {}

  // Sort highest probability first
  const sorted = [...markets].sort((a, b) =>
    parseFloat(b.last_price_dollars || 0) - parseFloat(a.last_price_dollars || 0))

  // Event meta
  const status     = first.status || "active"
  const statusDot  = status === "active" ? "dot-green" : status === "closed" ? "dot-red" : "dot-muted"
  const statusText = status.toUpperCase()
  const category   = ev.product_metadata?.competition || ev.category || "Markets"

  const catColor = categoryColor(category)

  // Clean event title — strip trailing punctuation (?, !, .)
  const eventTitle = (ev.title || ev.event_ticker || "").replace(/[?!.]+$/, "").trim()
  const eventSubTitle = ev.sub_title || ""

  // Resolution — show banner only when winner found (yes), or market is closed/finalized with a no result
  // In multi-outcome markets, individual outcomes get result:"no" while the market is still live — ignore those
  const isFinished = status === "finalized" || status === "closed"
  const resolvedMarket = sorted.find(m => m.result === "yes") ||
    (isFinished ? sorted.find(m => m.result === "no") : null)
  const resolution  = resolvedMarket?.result || ""
  const expValue    = resolvedMarket?.expiration_value || first.expiration_value || ""
  const resolvedBanner = resolution
    ? `<div class="resolved-banner resolved-${resolution}">✓ RESOLVED · ${resolution.toUpperCase()}${expValue ? " · " + expValue : ""}</div>`
    : ""

  const isMultiOutcome = markets.length > 2

  // Outcomes — paginated via buildOutcomesHtml
  const allRows = sorted.map((m, i) => {
    const lastPrice = parseFloat(m.last_price_dollars || 0)
    const yesBid    = parseFloat(m.yes_bid_dollars || 0)
    const yesAsk    = parseFloat(m.yes_ask_dollars || 0)
    const pct = lastPrice > 0
      ? Math.round(lastPrice * 100)
      : yesAsk > 0 ? Math.round((yesBid + yesAsk) / 2 * 100) : Math.round(yesBid * 100)

    const prevDollars = parseFloat(m.previous_price_dollars || (m.previous_price != null ? m.previous_price / 100 : 0))
    const prevPct = prevDollars > 0 ? Math.round(prevDollars * 100) : null
    const delta = prevPct !== null ? pct - prevPct : null

    const label = isMultiOutcome ? m.yes_sub_title : `${m.yes_sub_title} to win`
    const sub = isMultiOutcome ? "" : (m.rules_primary || "")
      .replace(/^If /, "").replace(/, then the market resolves to Yes\.?$/, "")

    const extras = { bid: yesBid, ask: yesAsk }
    if (isMultiOutcome) {
      const mVol = parseFloat(m.volume_fp || 0) / 100
      const mOI  = parseFloat(m.open_interest_fp || 0) / 100
      if (mVol > 0) extras.vol = Math.round(mVol).toLocaleString()
      if (mOI > 0)  extras.oi  = Math.round(mOI).toLocaleString()
    }
    return outcomeRow(label, sub, pct, OUTCOME_COLORS[i % OUTCOME_COLORS.length], delta, extras)
  })
  const outcomesHtml = buildOutcomesHtml(allRows)

  // Aggregate stats — always use allMarkets (full event) not filtered display markets
  // parseEventFP handles event-level fp inconsistency (see module-scope definition above)
  const totalVol   = fmtNum(ev.volume_fp != null
    ? parseEventFP(ev.volume_fp)
    : allMarkets.reduce((s, m) => s + parseFloat(m.volume_fp || 0), 0) / 100)
  const totalVol24 = fmtNum(ev.volume_24h_fp != null
    ? parseEventFP(ev.volume_24h_fp)
    : allMarkets.reduce((s, m) => {
        if (m.volume_24h_fp) return s + parseFloat(m.volume_24h_fp) / 100
        return s + parseFloat(m.volume_24h || 0)
      }, 0))
  // FIX: liquidity field name is unconfirmed — Kalshi may return liquidity_dollars, liquidity_fp (cents),
  // or liquidity (cents). Trying all known variants; if all are 0 the card will be blank.
  const totalLiq   = fmtNum(allMarkets.reduce((s, m) => {
    if (m.liquidity_dollars != null) return s + parseFloat(m.liquidity_dollars)
    if (m.liquidity_fp      != null) return s + parseFloat(m.liquidity_fp) / 100
    if (m.liquidity         != null) return s + parseFloat(m.liquidity) / 100
    return s
  }, 0))
  const totalOI    = fmtNum(allMarkets.reduce((s, m) => s + parseFloat(m.open_interest_fp || 0), 0) / 100)

  // Timeline — use event-level open_time; fall back to earliest market open_time across all markets
  const eventOpenTime = ev.open_time ||
    allMarkets.reduce((earliest, m) => {
      if (!m.open_time) return earliest
      return !earliest || m.open_time < earliest ? m.open_time : earliest
    }, null)
  const startDate     = fmtDate(eventOpenTime)
  const endDate       = fmtDateTime(first.close_time)
  const expDate       = fmtDateTime(first.expected_expiration_time)
  const canCloseEarly = first.can_close_early
  const earlyCloseText = first.early_close_condition || (canCloseEarly ? "Possible" : "")

  const timelineRows  = [
    infoRow("Start date", startDate),
    infoRow("End / expiry", endDate),
    infoRow("Resolution date", expDate),
    earlyCloseText ? `<div class="info-row"><span class="info-key">${esc("Early close")}</span><span class="info-val">${esc(earlyCloseText)}</span></div>` : "",
  ].join("")

  const rulesRaw = first.rules_secondary || (!isMultiOutcome ? first.rules_primary : "") || ""
  const ruleSentences = plainEnglishRules(rulesRaw)

  const exclusiveTag = ev.mutually_exclusive
    ? `<span class="tag-exclusive">WINNER TAKES ALL</span>` : ""

  let betExplainerText = ""
  if (!isMultiOutcome && markets.length === 2) {
    // Two-sided matchup (e.g. team A vs team B) — explain both options clearly
    const labelA = sorted[0]?.yes_sub_title || "one outcome"
    const labelB = sorted[1]?.yes_sub_title || "the other outcome"
    betExplainerText = `Pick a side: bet YES on ${labelA} if you think they win, or YES on ${labelB} if you think they win. Each contract pays $1 — only one side can resolve YES.`
  } else if (!isMultiOutcome && first.rules_primary) {
    betExplainerText = first.rules_primary
      .split(/[.!?]\s/)[0]
      .replace(/^If /i, "You win if ")
      .replace(/,\s*then the market resolves to Yes$/i, "")
      .replace(/,\s*then you win$/i, "")
      .trim()
    if (betExplainerText && !betExplainerText.endsWith(".")) betExplainerText += "."
    const noText = first.rules_primary.match(/otherwise[^.]*resolves? to "?No"?/i)
    if (noText) {
      betExplainerText += " Otherwise, you lose your bet."
    } else {
      betExplainerText += " You lose if it doesn't happen."
    }
  } else if (isMultiOutcome) {
    const eventName = (ev.title || ev.event_ticker || "this event").replace(/[?!.]+$/, "").trim()
    const sampleOutcome = (sorted[0]?.yes_sub_title || "").replace(/[.!?]+$/, "")
    betExplainerText = sampleOutcome
      ? `Bet on which outcome will happen for ${eventName} — for example, "${sampleOutcome}." You win if your chosen outcome is correct.${ev.mutually_exclusive ? " Only one outcome can win — winner takes all." : ""}`
      : `Bet on which outcome will happen for ${eventName}. You win if your chosen outcome is correct.${ev.mutually_exclusive ? " Only one outcome can win — winner takes all." : ""}`
  }

  const timeLeft = fmtTimeRemaining(first.close_time)
  const urgencyHtml = timeLeft
    ? `<div class="urgency-banner urgency-${timeLeft.urgency}">⏱ ${esc(timeLeft.text)}</div>`
    : ""

  let leadPct = 0
  if (sorted[0]) {
    const lp = parseFloat(sorted[0].last_price_dollars || 0)
    const yb = parseFloat(sorted[0].yes_bid_dollars || 0)
    const ya = parseFloat(sorted[0].yes_ask_dollars || 0)
    leadPct = lp > 0 ? Math.round(lp * 100)
      : ya > 0 ? Math.round((yb + ya) / 2 * 100) : Math.round(yb * 100)
  }
  window._simMarket = { amount: window._simMarket?.amount || 10, pct: leadPct, platform: "kalshi" }
  const betSimHtml = betSimulatorHtml(leadPct)

  const analyticsRows = (isMultiOutcome ? sorted.slice(0, 3) : sorted.slice(0, 1)).map(m => {
    const lp  = parseFloat(m.last_price_dollars || 0)
    const bid = parseFloat(m.yes_bid_dollars || 0)
    let ask   = parseFloat(m.yes_ask_dollars || 0)
    // Match the same fallback chain used for outcome probability display
    const prob = lp > 0 ? lp : (ask > 0 ? (bid + ask) / 2 : bid)
    if (!Number.isFinite(ask) || ask <= 0) {
      ask = Number.isFinite(bid) && bid > 0 ? (bid + prob) / 2 : prob
    }
    return calcAnalyticsRow(m.yes_sub_title || "YES", prob, ask, bid)
  }).filter(Boolean)
  const analyticsHtml = analyticsCard(analyticsRows, timeLeft)

  return `
    <div class="mi-card">
      <div class="event-head">
        <div class="event-tags">
          <span class="tag-platform" style="background:${accent}">${esc(PLATFORMS.kalshi.label)}</span>
          <span class="tag-cat" style="color:${catColor};border-color:${catColor};background:${catColor}1a">${esc(category.toUpperCase())}</span>
          ${exclusiveTag}
          <span class="tag-status">
            <span class="${statusDot}">●</span> ${esc(statusText)}
          </span>
        </div>
        ${resolvedBanner}
        <div class="event-title">${esc(eventTitle || eventSubTitle)}${eventTitle && eventSubTitle ? " — " + esc(eventSubTitle) : ""}</div>
        ${urgencyHtml}
      </div>
    </div>

    ${whatsTheBetCard(betExplainerText)}

    ${timelineRows ? `
    <div class="mi-card">
      <div class="section-label">TIMELINE</div>
      ${timelineRows}
    </div>` : ""}

    <div class="mi-card">
      <div class="section-label">OUTCOMES &amp; PROBABILITY</div>
      ${outcomesHtml}
    </div>

    <div class="stats-grid">
      ${statCard("VOLUME TRADED", totalVol ? `$${totalVol}` : null)}
      ${statCard("24H VOLUME", totalVol24 ? `$${totalVol24}` : null)}
      ${statCard("LIQUIDITY", totalLiq ? `$${totalLiq}` : null)}
      ${statCard("OPEN INTEREST", totalOI ? `$${totalOI}` : null)}
    </div>

    ${ruleSentences.length ? `
    <div class="mi-card">
      <div class="section-label">HOW IT RESOLVES</div>
      <div class="num-list">${numList(ruleSentences)}</div>
    </div>` : ""}

    ${betSimHtml}

    ${analyticsHtml}
  `
}

function renderGeminiEvent(event, accent) {
  const status = (event.status || "").toLowerCase()
  const isOpen = status === "active"
  const statusDot  = isOpen ? "dot-green" : "dot-red"
  const statusText = isOpen ? "OPEN" : status.toUpperCase() || "CLOSED"

  const contracts = Array.isArray(event.contracts) ? event.contracts : []
  const isBinary = event.type === "binary"

  // Build outcome rows from contracts
  const allRows = []
  const analyticsCandidates = []

  if (isBinary && contracts.length === 1) {
    // Binary: show YES and NO from a single contract price
    const c = contracts[0]
    const cp    = c.prices || {}
    const price = parseFloat(cp.lastTradePrice || cp.bestAsk || cp.bestBid || c.lastPrice || c.price || c.bestAsk || 0)
    const bid   = parseFloat(cp.bestBid || c.bestBid || c.bid || price)
    const ask   = parseFloat(cp.bestAsk || c.bestAsk || c.ask || price)
    const pctYes = Math.round(price * 100)
    const pctNo  = 100 - pctYes
    const extras = Number.isFinite(bid) && Number.isFinite(ask) && ask > 0
      ? { bid, ask }
      : {}
    allRows.push(outcomeRow("YES", "", pctYes, OUTCOME_COLORS[0], null, extras))
    allRows.push(outcomeRow("NO",  "", pctNo,  OUTCOME_COLORS[1], null, {}))
    if (ask > 0) analyticsCandidates.push({ prob: price, label: "YES", ask, bid: bid || price })
  } else {
    contracts.forEach((c, idx) => {
      const rawName = String(c.title || c.description || c.name || c.instrumentSymbol || `Outcome ${idx + 1}`)
      // Extract human-readable name from contract symbols like GEMI-TPC2026WIN-ABERG
      let name = rawName
      const symbolMatch = rawName.match(/^[A-Z]+-[A-Z0-9]+-(.+)$/)
      if (symbolMatch) {
        name = symbolMatch[1].charAt(0).toUpperCase() + symbolMatch[1].slice(1).toLowerCase()
      }
      // Gemini nests prices under c.prices.{lastTradePrice,bestBid,bestAsk}
      const cp    = c.prices || {}
      const price = parseFloat(cp.lastTradePrice || cp.bestAsk || cp.bestBid || c.lastPrice || c.midpoint || c.mid || c.price || c.bestAsk || 0)
      const bid   = parseFloat(cp.bestBid || c.bestBid || c.bid || price)
      const ask   = parseFloat(cp.bestAsk || c.bestAsk || c.ask || price)
      const pct   = Math.round(price * 100)
      const extras = {}
      if (Number.isFinite(bid) && Number.isFinite(ask) && ask > 0) {
        extras.bid = bid
        extras.ask = ask
      }
      if (c.volume || c.notionalVolume) extras.vol = fmtNum(parseFloat(c.volume || c.notionalVolume))
      if (c.openInterest) extras.oi = fmtNum(parseFloat(c.openInterest))
      allRows.push(outcomeRow(name, "", pct, OUTCOME_COLORS[idx % OUTCOME_COLORS.length], null, extras))
      if (price > 0 && ask > 0) {
        analyticsCandidates.push({ prob: price, label: String(name), ask, bid: bid || price })
      }
    })
  }

  if (!allRows.length) return `<div class="mi-error">No outcome data found for this event.</div>`
  const outcomesHtml = buildOutcomesHtml(allRows)

  // Stats
  const totalVol = fmtNum(parseFloat(event.volume || event.notionalVolume || 0))
  const totalLiq = fmtNum(parseFloat(event.liquidity || event.openInterest || 0))
  const totalOI  = fmtNum(parseFloat(event.openInterest || 0))

  // Tags
  let tags = event.tags || []
  if (!Array.isArray(tags)) tags = []
  const cat = event.category || ""
  if (cat && !tags.includes(cat)) tags = [cat, ...tags]
  const tagsHtml = tags
    .filter(t => t != null)
    .map(t => {
      const col = categoryColor(String(t))
      return `<span class="tag-cat" style="color:${col};border-color:${col};background:${col}1a">${esc(String(t).toUpperCase())}</span>`
    }).join("")

  // Urgency
  const expiryIso = event.closeDate || event.expiryDate || event.endDate || event.resolvedAt || ""
  const timeLeft = fmtTimeRemaining(expiryIso)
  const urgencyHtml = timeLeft
    ? `<div class="urgency-banner urgency-${timeLeft.urgency}">⏱ ${esc(timeLeft.text)}</div>`
    : ""

  // Analytics
  analyticsCandidates.sort((a, b) => b.prob - a.prob)
  const analyticsRows = analyticsCandidates.slice(0, 3)
    .map(c => calcAnalyticsRow(c.label, c.prob, c.ask, c.bid))
    .filter(Boolean)
  const analyticsHtml = analyticsCard(analyticsRows, timeLeft)

  // Bet explainer from description
  const desc = event.description || ""
  let betExplainerText = ""
  if (desc) {
    betExplainerText = applyResolveText(desc)
      .split(/(?<=[.!?])\s+/)
      .filter(s => s.trim().length > 10)
      .slice(0, 3)
      .join(" ")
  }

  // Resolution rules
  const ruleSentences = desc ? plainEnglishRules(desc).slice(0, 8) : []

  // Bet sim
  const leadPct = analyticsCandidates.length ? Math.round(analyticsCandidates[0].prob * 100) : 0
  window._simMarket = { amount: window._simMarket?.amount || 10, pct: leadPct, platform: "gemini" }
  const betSimHtml = betSimulatorHtml(leadPct)

  return `
    <div class="mi-card">
      <div class="event-head">
        <div class="event-tags">
          <span class="tag-platform" style="background:${accent}">${esc(PLATFORMS.gemini.label)}</span>
          ${tagsHtml}
          <span class="tag-status"><span class="${statusDot}">●</span> ${esc(statusText)}</span>
        </div>
        <div class="event-title">${esc(event.title || "Gemini Prediction Market")}</div>
        ${urgencyHtml}
      </div>
    </div>

    ${whatsTheBetCard(betExplainerText)}

    ${(event.effectiveDate || expiryIso) ? `
    <div class="mi-card">
      <div class="section-label">TIMELINE</div>
      ${infoRow("Start date", fmtDate(event.openDate || event.startDate || event.effectiveDate || event.createdAt))}
      ${infoRow("End date", fmtDate(expiryIso))}
      ${event.resolvedAt ? infoRow("Resolved", fmtDateTime(event.resolvedAt)) : ""}
    </div>` : ""}

    <div class="mi-card">
      <div class="section-label">OUTCOMES &amp; PROBABILITY</div>
      ${outcomesHtml}
    </div>

    <div class="stats-grid">
      ${statCard("VOLUME TRADED", totalVol ? `$${totalVol}` : null)}
      ${statCard("LIQUIDITY", totalLiq ? `$${totalLiq}` : null)}
      ${statCard("OPEN INTEREST", totalOI ? `$${totalOI}` : null)}
      ${statCard("RUNNERS", contracts.length > 0 ? String(contracts.length) : null)}
    </div>

    ${ruleSentences.length ? `
    <div class="mi-card">
      <div class="section-label">HOW IT RESOLVES</div>
      <div class="num-list">${numList(ruleSentences)}</div>
    </div>` : ""}

    ${betSimHtml}

    ${analyticsHtml}
  `
}

function renderPolymarketEvent(event, markets, accent) {
  const statusDot  = event.closed ? "dot-red" : "dot-green"
  const statusText = event.closed ? "CLOSED" : "OPEN"

  const allPolyRows = []
  const polyAnalyticsCandidates = []
  markets.forEach((market, idx) => {
    let outcomes, prices
    try {
      outcomes = typeof market.outcomes === "string" ? JSON.parse(market.outcomes) : market.outcomes
      prices   = typeof market.outcomePrices === "string" ? JSON.parse(market.outcomePrices) : market.outcomePrices
    } catch (e) {
      return
    }
    if (!prices || !Array.isArray(prices)) return
    const rawAsk = parseFloat(market.bestAsk)
    const rawBid = parseFloat(market.bestBid)
    const bestAsk = Number.isFinite(rawAsk) ? rawAsk : null
    const bestBid = Number.isFinite(rawBid) ? rawBid : null
    ;(outcomes || []).forEach((name, i) => {
      const pct = Math.round(parseFloat(prices[i] || 0) * 100)
      const extras = {}
      if (bestBid != null && bestAsk != null) {
        extras.bid = bestBid
        extras.ask = bestAsk
      }
      allPolyRows.push(outcomeRow(name, "", pct, OUTCOME_COLORS[(idx + i) % OUTCOME_COLORS.length], null, extras))

      const prob = parseFloat(prices[i])
      if (!Number.isFinite(prob) || prob <= 0) return
      let ask = bestAsk != null ? bestAsk : prob
      if (ask <= 0) ask = prob
      const bid = bestBid != null ? bestBid : prob
      polyAnalyticsCandidates.push({ prob, label: name ? String(name) : market.question || "YES", ask, bid })
    })
  })
  if (!allPolyRows.length) return `<div class="mi-error">No outcome data found for this market.</div>`
  const outcomesHtml = buildOutcomesHtml(allPolyRows)

  const first = markets[0] || {}
  const totalVol  = fmtNum(parseFloat(event.volume || 0))
  const totalLiq  = fmtNum(parseFloat(event.liquidity || first.liquidity || 0))
  const totalVol24 = fmtNum(parseFloat(event.volume24hr || first.volume24hr || 0))
  const commentCount = parseInt(event.commentCount || 0, 10)

  let tags = event.tags || []
  if (typeof tags === "string") { try { tags = JSON.parse(tags) } catch(e) { tags = [] } }
  if (!Array.isArray(tags)) tags = []
  const tagsHtml = tags
    .filter(t => t != null)
    .map(t => {
      const col = categoryColor(String(t))
      return `<span class="tag-cat" style="color:${col};border-color:${col};background:${col}1a">${esc(String(t).toUpperCase())}</span>`
    }).join("")

  const timeLeft = fmtTimeRemaining(event.endDate)
  const urgencyHtml = timeLeft
    ? `<div class="urgency-banner urgency-${timeLeft.urgency}">⏱ ${esc(timeLeft.text)}</div>`
    : ""

  polyAnalyticsCandidates.sort((a, b) => b.prob - a.prob)
  const polyAnalytics = polyAnalyticsCandidates.slice(0, 3).map(c =>
    calcAnalyticsRow(c.label, c.prob, c.ask, c.bid)
  ).filter(Boolean)
  const analyticsHtml = analyticsCard(polyAnalytics, timeLeft)

  let betExplainerText = ""
  const firstDesc = first.description || first.question || event.description || ""
  if (firstDesc) {
    betExplainerText = applyResolveText(firstDesc)
      .split(/(?<=[.!?])\s+/)
      .filter(s => s.trim().length > 10)
      .slice(0, 3)
      .join(" ")
  }
  if (!betExplainerText && markets.length > 1) {
    betExplainerText = `Pick which outcome you think will happen. You win if your chosen outcome is correct.`
  }

  const polyRuleSentences = []
  const seenTexts = new Set()
  const seenSentences = new Set()
  markets.forEach(m => {
    const desc = m.description || ""
    const q = m.question || ""
    ;[desc, q].forEach(text => {
      if (!text || seenTexts.has(text)) return
      seenTexts.add(text)
      plainEnglishRules(text).forEach(s => {
        if (!seenSentences.has(s)) {
          seenSentences.add(s)
          polyRuleSentences.push(s)
        }
      })
    })
  })
  const polyRulesLimited = polyRuleSentences.slice(0, 8)
  let resSource = ""
  for (const m of markets) {
    if (m.resolutionSource && typeof m.resolutionSource === "string") {
      try {
        const u = new URL(m.resolutionSource)
        if (u.protocol === "http:" || u.protocol === "https:") {
          resSource = m.resolutionSource
          break
        }
      } catch(e) {}
    }
  }
  const resSourceHtml = resSource
    ? `<div class="info-row" style="border-bottom:none"><span class="info-key">Resolution source</span><span class="info-val"><a href="${esc(resSource)}" target="_blank" rel="noopener" style="color:var(--orange)">${esc(resSource.replace(/^https?:\/\//, "").split("/")[0])}</a></span></div>`
    : ""

  const leadPctPoly = polyAnalyticsCandidates.length ? Math.round(polyAnalyticsCandidates[0].prob * 100) : 0
  window._simMarket = { amount: window._simMarket?.amount || 10, pct: leadPctPoly, platform: "polymarket" }
  const betSimHtml = betSimulatorHtml(leadPctPoly)

  return `
    <div class="mi-card">
      <div class="event-head">
        <div class="event-tags">
          <span class="tag-platform" style="background:${accent}">${esc(PLATFORMS.polymarket.label)}</span>
          ${tagsHtml}
          <span class="tag-status"><span class="${statusDot}">●</span> ${esc(statusText)}</span>
        </div>
        <div class="event-title">${esc(event.title)}</div>
        ${urgencyHtml}
      </div>
    </div>

    ${whatsTheBetCard(betExplainerText)}

    ${event.endDate ? `
    <div class="mi-card">
      <div class="section-label">TIMELINE</div>
      ${infoRow("Start date", fmtDate(event.startDate))}
      ${infoRow("End date", fmtDate(event.endDate))}
    </div>` : ""}

    <div class="mi-card">
      <div class="section-label">OUTCOMES &amp; PROBABILITY</div>
      ${outcomesHtml}
    </div>

    <div class="stats-grid">
      ${statCard("VOLUME TRADED", totalVol ? `$${totalVol}` : null)}
      ${statCard("24H VOLUME", totalVol24 ? `$${totalVol24}` : null)}
      ${statCard("LIQUIDITY", totalLiq ? `$${totalLiq}` : null)}
      ${commentCount > 0 ? statCard("COMMENTS", commentCount.toLocaleString()) : ""}
    </div>

    ${polyRulesLimited.length || resSourceHtml ? `
    <div class="mi-card">
      <div class="section-label">HOW IT RESOLVES</div>
      ${polyRulesLimited.length ? `<div class="num-list">${numList(polyRulesLimited)}</div>` : ""}
      ${resSourceHtml}
    </div>` : ""}

    ${betSimHtml}

    ${analyticsHtml}
  `
}

function showError(msg) {
  document.getElementById("result").innerHTML =
    `<div class="mi-error"><span>${esc(msg)}</span><button class="retry-btn" onclick="document.getElementById('urlInput').select();document.getElementById('urlInput').focus()">TRY AGAIN ↺</button></div>`
}

let _analyzing = false

async function analyze() {
  if (_analyzing) return

  const url = document.getElementById("urlInput").value.trim()
  const result = document.getElementById("result")
  const btn = document.querySelector(".search-row button")

  if (!url) {
    showError("Paste a Kalshi or Polymarket URL to analyze.")
    return
  }

  _analyzing = true
  window._outcomePages = {}
  btn.disabled = true
  btn.textContent = "ANALYZING\u2026"
  btn.style.opacity = "0.6"
  btn.style.cursor = "not-allowed"

  result.innerHTML = `<div class="mi-loading">ANALYZING</div>`

  function resetBtn() {
    _analyzing = false
    btn.disabled = false
    btn.textContent = "ANALYZE \u2197"
    btn.style.opacity = ""
    btn.style.cursor = ""
  }

  const lowerUrl = url.toLowerCase()
  let platform = "unknown"
  if      (lowerUrl.includes("kalshi"))     platform = "kalshi"
  else if (lowerUrl.includes("polymarket")) platform = "polymarket"
  else if (lowerUrl.includes("gemini"))     platform = "gemini"
  else if (lowerUrl.includes("coinbase"))   platform = "coinbase"

  const accent = (PLATFORMS[platform] || {}).accent || "#555"

  if (platform === "polymarket") {
    try {
      const eventPart = url.split("/event/")[1]
      if (!eventPart) throw new Error("Invalid Polymarket URL. Expected: polymarket.com/event/<slug>")
      const slug = eventPart.split("?")[0].split("#")[0].replace(/\/$/, "")

      const res = await fetch(`/api/polymarket?slug=${encodeURIComponent(slug)}`)
      if (!res.ok) throw new Error(`API error ${res.status}`)
      const data = await res.json()

      const event = Array.isArray(data) ? data[0] : data
      if (!event) throw new Error("No event found.")
      const markets = event.markets || []
      if (!markets.length) throw new Error("No market data found.")

      result.innerHTML = renderPolymarketEvent(event, markets, accent)
    } catch (err) {
      console.error(err)
      showError(`ERROR: ${err.message}`)
    } finally {
      resetBtn()
    }

  } else if (platform === "kalshi") {
    try {
      if (!url.includes("/markets/") && !url.includes("/events/")) {
        throw new Error("Invalid Kalshi URL.")
      }
      const cleanPath = url.split("?")[0].split("#")[0].replace(/\/$/, "")
      const pathParts = cleanPath.split("/")
      const marketsIdx = pathParts.findIndex(p => p === "markets" || p === "events")
      // For /markets/{eventTicker}/{slug}/{marketTicker}, prefer the event ticker
      // so we always show the full event status, not just a single sub-market
      const eventTicker = marketsIdx !== -1 && pathParts[marketsIdx + 1]
        ? pathParts[marketsIdx + 1].toUpperCase()
        : null
      const ticker = pathParts[pathParts.length - 1].toUpperCase()

      // Try event ticker first (gives full event with all markets and correct status)
      let data = null
      if (eventTicker && eventTicker !== ticker) {
        const eventRes = await fetch(`/api/kalshi?ticker=${encodeURIComponent(eventTicker)}`)
        if (eventRes.ok) data = await eventRes.json()
      }

      // Fall back to the specific market/event ticker in the URL
      if (!data || (!data.event && !data.market)) {
        const res = await fetch(`/api/kalshi?ticker=${encodeURIComponent(ticker)}`)
        if (!res.ok) {
          const err = await res.json()
          throw new Error(err.error || `API error ${res.status}`)
        }
        data = await res.json()
      }

      if (data.event) {
        // Save full market list before any filtering — needed for aggregate stats
        // (volume, OI, liquidity, start date, true leader)
        data.event._allMarkets = [...(data.event.markets || [])]

        // When URL specifies a specific sub-market, filter outcomes display to that market
        // to avoid showing resolved/closed status from other unrelated markets in the event.
        // Do NOT filter winner-takes-all events — all candidates belong to the same question.
        if (ticker !== eventTicker && data.event.markets && !data.event.mutually_exclusive) {
          const specific = data.event.markets.filter(m => m.ticker?.toUpperCase() === ticker)
          if (specific.length > 0) data.event.markets = specific
        }
        result.innerHTML = renderKalshiEvent(data.event, accent)
      } else if (data.market) {
        const m = data.market
        const fakeEvent = {
          title: m.title,
          sub_title: "",
          category: "Markets",
          markets: [m],
          product_metadata: {},
        }
        result.innerHTML = renderKalshiEvent(fakeEvent, accent)
      } else {
        throw new Error("Unexpected API response.")
      }
    } catch (err) {
      console.error(err)
      showError(`ERROR: ${err.message}`)
    } finally {
      resetBtn()
    }

  } else if (platform === "gemini") {
    try {
      const cleanPath = url.split("?")[0].split("#")[0].replace(/\/$/, "")
      const pathParts = cleanPath.split("/").filter(Boolean)
      const predictionsIdx = pathParts.findIndex(p => p.toLowerCase() === "predictions")
      const ticker = predictionsIdx !== -1 ? pathParts[predictionsIdx + 1] : pathParts[pathParts.length - 1]
      if (!ticker) throw new Error("Invalid Gemini URL — could not find event ticker.")

      const res = await fetch(`/api/gemini?ticker=${encodeURIComponent(ticker)}`)
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || `API error ${res.status}`)
      }
      const data = await res.json()
      if (!data || !data.title) throw new Error("No event data returned.")

      result.innerHTML = renderGeminiEvent(data, accent)
    } catch (err) {
      console.error(err)
      showError(`ERROR: ${err.message}`)
    } finally {
      resetBtn()
    }

  } else {
    showError("Unrecognized URL · Paste a Kalshi, Polymarket, or Gemini link.")
    resetBtn()
  }
}
