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
  "TRADING OPENS":    "When this market first became available for trading — not necessarily when the real-world event starts.",
  "BETTING CLOSES":   "The deadline to place or exit bets. After this time, no more trading is allowed. This is not necessarily when the real-world event happens.",
  "EXPECTED RESOLUTION": "When the market is expected to be settled and payouts distributed, based on the exchange's schedule.",
  "START DATE":       "When this market or event was created on the platform.",
  "END DATE":         "The scheduled end date for this event on the platform — trading may close before or after the real-world event.",
  "PROJECTED PAYOUT": "If the current leader wins, how much each contract pays. Kalshi contracts always pay $1 on a win — profit depends on what you paid.",
  "VOLUME":           "Total dollars that have changed hands since this market opened.",
  "BEST SPREAD":      "The tightest bid-ask gap across all outcomes. Lower means cheaper to enter and exit positions.",
  "OVERROUND":        "Sum of all outcome probabilities. 100% is fair; 103% means the exchange takes 3% — lower is better for traders.",
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

// Returns amber banner if last trade was > 1 hour ago, else empty string
function staleWarningHtml(lastTradeIso) {
  if (!lastTradeIso || typeof lastTradeIso !== "string") return ""
  const d = new Date(lastTradeIso)
  if (isNaN(d)) return ""
  const ageMins = Math.floor((Date.now() - d.getTime()) / 60000)
  if (ageMins < 60) return ""
  const ageText = ageMins < 120 ? "1 hour"
    : ageMins < 1440 ? `${Math.floor(ageMins / 60)} hours`
    : `${Math.floor(ageMins / 1440)} days`
  return `<div class="stale-warning">⚠ PRICES MAY BE STALE · Last trade ${ageText} ago</div>`
}

function fmtDate(iso) {
  if (!iso || typeof iso !== "string" || iso.startsWith("0001")) return "—"
  // Date-only strings (YYYY-MM-DD) are parsed as UTC midnight by JS spec, which shifts them
  // one day back in any negative-offset timezone (all of the Americas). Append local noon
  // so the date renders correctly regardless of the user's timezone.
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso + "T12:00:00" : iso
  const d = new Date(normalized)
  if (isNaN(d)) return "—"
  return d.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })
}

function fmtDateTime(iso) {
  if (!iso || typeof iso !== "string" || iso.startsWith("0001")) return "—"
  const d = new Date(iso)
  if (isNaN(d)) return "—"
  return d.toLocaleString(undefined, {
    month: "long", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short"
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

// Shared outcome color palette used by all renderers
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
