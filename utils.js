const PLATFORMS = {
  kalshi:     { label: "KALSHI",     accent: "#00C805" },
  polymarket: { label: "POLYMARKET", accent: "#0070f3" },
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

const KNOWN_SOURCES = [
  { name: "Associated Press", url: "https://apnews.com" },
  { name: "Fox News",         url: "https://www.foxnews.com" },
  { name: "NBC News",         url: "https://www.nbcnews.com" },
  { name: "NBC",              url: "https://www.nbcnews.com" },
  { name: "CNN",              url: "https://www.cnn.com" },
  { name: "ABC News",         url: "https://abcnews.go.com" },
  { name: "ABC",              url: "https://abcnews.go.com" },
  { name: "CBS News",         url: "https://www.cbsnews.com" },
  { name: "CBS",              url: "https://www.cbsnews.com" },
  { name: "MSNBC",            url: "https://www.msnbc.com" },
  { name: "Reuters",          url: "https://www.reuters.com" },
  { name: "Bloomberg",        url: "https://www.bloomberg.com" },
  { name: "ESPN",             url: "https://www.espn.com" },
  { name: "BBC",              url: "https://www.bbc.com" },
  { name: "The New York Times", url: "https://www.nytimes.com" },
  { name: "New York Times",   url: "https://www.nytimes.com" },
  { name: "The Washington Post", url: "https://www.washingtonpost.com" },
  { name: "Washington Post",  url: "https://www.washingtonpost.com" },
  { name: "Wall Street Journal", url: "https://www.wsj.com" },
  { name: "WSJ",              url: "https://www.wsj.com" },
  { name: "Axios",            url: "https://www.axios.com" },
  { name: "Politico",         url: "https://www.politico.com" },
  { name: "USA Today",        url: "https://www.usatoday.com" },
  { name: "The Guardian",     url: "https://www.theguardian.com" },
  { name: "AP",               url: "https://apnews.com" },
]

// Scans a plain-text rule sentence and hyperlinks any known news/data source names.
// Returns an HTML string when substitutions were made, or null if none matched.
// Uses a single-pass replacement with alternation ordered longest-first so
// "NBC News" is preferred over "NBC" and we never wrap the same text twice
// (which previously produced nested <a> tags and broken HTML).
function linkKnownSources(sentence) {
  if (!sentence || typeof sentence !== "string") return null
  const sorted = [...KNOWN_SOURCES].sort((a, b) => b.name.length - a.name.length)
  const urlByName = new Map(sorted.map(s => [s.name, s.url]))
  const escapedText = esc(sentence)
  const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const alternation = sorted.map(s => escapeRe(esc(s.name))).join("|")
  if (!alternation) return null
  const re = new RegExp(`(?<![\\w])(${alternation})(?![\\w])`, "g")
  let changed = false
  const result = escapedText.replace(re, (match) => {
    const url = urlByName.get(match)
    if (!url) return match
    changed = true
    return `<a href="${esc(url)}" target="_blank" rel="noopener" style="color:var(--orange)">${match}</a>`
  })
  return changed ? result : null
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

// ── Country flag colors ────────────────────────────────────────────────────────
const COUNTRY_COLORS = {
  // Americas
  "united states": "#B22234", "usa": "#B22234", "us election": "#B22234", "us": "#B22234",
  "brazil": "#009c3b", "brasil": "#009c3b",
  "canada": "#FF0000",
  "mexico": "#006847",
  "argentina": "#74ACDF",
  "colombia": "#FCD116",
  "chile": "#D52B1E",
  "peru": "#D91023",
  "venezuela": "#CF142B",
  // Europe
  "united kingdom": "#012169", "uk": "#012169", "britain": "#012169", "england": "#CF142B",
  "france": "#002395",
  "germany": "#FFCE00",
  "italy": "#009246",
  "spain": "#AA151B",
  "ukraine": "#005BBB",
  "russia": "#D52B1E",
  "netherlands": "#AE1C28",
  "sweden": "#006AA7",
  "norway": "#EF2B2D",
  "switzerland": "#FF0000",
  "poland": "#DC143C",
  "portugal": "#006600",
  "greece": "#0D5EAF",
  "turkey": "#E30A17",
  // Asia
  "china": "#DE2910",
  "japan": "#BC002D",
  "india": "#FF9933",
  "south korea": "#CD2E3A", "korea": "#CD2E3A",
  "taiwan": "#003F87",
  "iran": "#239f40",
  "israel": "#0038b8",
  "saudi arabia": "#006C35",
  "pakistan": "#01411C",
  "indonesia": "#CE1126",
  "philippines": "#0038A8",
  "vietnam": "#DA251D",
  "thailand": "#A51931",
  // Africa / Oceania
  "south africa": "#007A4D",
  "nigeria": "#008751",
  "egypt": "#CE1126",
  "kenya": "#006600",
  "australia": "#00008B",
  "new zealand": "#00247D",
}

function countryColor(label) {
  const lower = (label || "").toLowerCase().trim()
  for (const [key, color] of Object.entries(COUNTRY_COLORS)) {
    if (lower === key || lower.startsWith(key + " ") || lower.endsWith(" " + key)) return color
  }
  return null
}

// ── Category / topic colors ────────────────────────────────────────────────────
function categoryColor(cat) {
  const c = (cat || "").toLowerCase()

  // Country check first
  const cc = countryColor(c)
  if (cc) return cc

  // Topics — consistent across all platforms
  if (/politi|election|govern|democrat|republican|senate|congress|president|primar|ballot|vote/.test(c)) return "#3b82f6"
  if (/sport|golf|pga|nfl|nba|mlb|nhl|soccer|tennis|football|basketball|baseball|hockey|ufc|fight|esport|dota|league of legends|chess|cricket|rugby/.test(c)) return "#22c55e"
  if (/financ|econom|gdp|inflation|fed|rate|stock|market|bond|yield|trade|tariff|deficit/.test(c)) return "#f59e0b"
  if (/crypto|bitcoin|btc|ethereum|eth|web3|token|coin|defi|nft/.test(c)) return "#6366f1"
  if (/tech|science|space|ai|artificial intel|software|computer|nasa|rocket/.test(c)) return "#06b6d4"
  if (/entertain|culture|celebrity|award|movie|music|tv|film|oscar|grammy|emmy/.test(c)) return "#a855f7"
  if (/health|medical|covid|drug|pharma|disease|fda|vaccine/.test(c)) return "#ec4899"
  if (/business|company|corporate|ceo|merger|ipo|acquisition/.test(c)) return "#f97316"
  if (/geopolit|war|conflict|military|sanction|nato|iran|nuclear/.test(c)) return "#ef4444"
  if (/weather|climate|hurricane|earthquake|natural/.test(c)) return "#0ea5e9"
  if (/legal|court|law|trial|verdict|justice|supreme/.test(c)) return "#a16207"
  if (/world election|global election/.test(c)) return "#3b82f6"
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
    .replace(/\bif (?:\w+\s+){0,6}resolve[sd]?\s+"?Yes"?\.?/gi, (m) => m.replace(/resolve[sd]?\s+"?Yes"?\.?/i, "resolves YES → you win"))
    .replace(/\bif (?:\w+\s+){0,6}resolve[sd]?\s+"?No\.?"?\.?/gi, (m) => m.replace(/resolve[sd]?\s+"?No\.?"?\.?/i, "resolves NO → you lose"))
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
  const totalMins = Math.max(1, Math.ceil(ms / 60000))
  const days = Math.floor(totalMins / 1440)
  const remMins = totalMins % 1440
  const hrs = Math.floor(remMins / 60)
  const mins = remMins % 60
  const parts = []
  if (days > 0) parts.push(`${days} day${days === 1 ? "" : "s"}`)
  if (hrs > 0) parts.push(`${hrs} hr${hrs === 1 ? "" : "s"}`)
  if (mins > 0) parts.push(`${mins} min${mins === 1 ? "" : "s"}`)
  let text
  if (parts.length) text = `CLOSES IN ${parts.join(" ")}`
  else text = `CLOSES IN < 1 MIN`
  const urgency = days >= 7 ? "low" : days >= 1 ? "med" : "high"
  return { text, urgency }
}

function plainEnglishRules(rulesText) {
  if (!rulesText || typeof rulesText !== "string") return []
  // Split on paragraph breaks first so paragraphs starting with a capital letter
  // after "No." (e.g. resolution source paragraphs) are treated as separate
  // sentences rather than being appended to the preceding sentence.
  const sentences = []
  for (const para of rulesText.split(/\n\n+/)) {
    para.split(/(?<=[.!?])\s+/).forEach(s => sentences.push(s.trim()))
  }
  return sentences
    .filter(s => s.length >= 10)
    .filter(s => !s.toLowerCase().startsWith("kalshi is not affiliated"))
    .filter(s => !s.toLowerCase().startsWith("kalshi reserves"))
    .filter(s => !s.toLowerCase().includes("for more information"))
    .filter(s => !/https?:\/\//.test(s))
    .filter(s =>
      /\b(will|is|are|was|were|resolve|win|lose|happen|occur|end|result|score|cover|pay|expire|remain|cancel|postpone|settle|counts?\s+toward|based\s+on|determined|measured|reported|awarded|declared|announced|certified|confirmed|qualified|exceeded|reached|achieved)\b/i.test(s)
      || /\b(YES|NO)\b/i.test(s)
    )
    .map(s => applyResolveText(s)
      .replace(/^If /i, "If ")
      .replace(/^The following market refers to /i, "This bet is about ")
      .replace(/,\s*then you win\.?$/i, ", you win.")
      .replace(/\.$/, "")
    )
    .filter(s => s.length >= 10)
}
