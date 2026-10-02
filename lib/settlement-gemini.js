// Gemini settlement lookup that accepts a contract symbol as well as an event
// ticker. Shared by server.js and api/settlement-review.js so the two
// entrypoints cannot drift.
//
// A contract symbol (GEMI-{event}-{outcome}, e.g. GEMI-F1-BELGP-WIN-20260719-ALB)
// names one outcome of an event, not the event, so looking it up as an event
// 404s. Customers copy the symbol off their own position, so the desk resolves
// it to the parent event and reports on that outcome specifically.

// Event tickers to try, in order. Anything that is not a GEMI- symbol is
// looked up exactly as pasted (one request, as before). A symbol is never an
// event ticker itself, so its candidates are the symbol minus the prefix and
// the outcome segment, then minus two segments for outcome codes that contain
// a hyphen, then minus the prefix alone — at most three requests.
function geminiEventCandidates(identifier) {
  const raw = String(identifier || "").trim()
  if (!/^GEMI-/i.test(raw)) return raw ? [raw] : []
  const base = raw.slice(5).replace(/^-+|-+$/g, "")
  const parts = base.split("-").filter(Boolean)
  const out = []
  const push = (t) => { if (t && !out.includes(t)) out.push(t) }
  if (parts.length > 1) push(parts.slice(0, -1).join("-"))
  if (parts.length > 2) push(parts.slice(0, -2).join("-"))
  push(base)
  return out
}

// Fetch the event behind an input. `fetcher(url)` resolves to { status, body }.
// Stops at the first success, and at the first failure that is not a 404 — a
// 5xx or a timeout is an outage, not a wrong guess, and is reported as such.
async function fetchGeminiSettlementEvent(identifier, fetcher) {
  const candidates = geminiEventCandidates(identifier)
  const isSymbol = /^GEMI-/i.test(String(identifier || ""))
  let last = { status: 404, body: "" }
  for (const ticker of candidates) {
    const res = await fetcher(`https://api.gemini.com/v1/prediction-markets/events/${encodeURIComponent(ticker)}`)
    if (res.status === 200) {
      return { status: 200, body: res.body, eventTicker: ticker, focusSymbol: isSymbol ? String(identifier).toUpperCase() : "" }
    }
    last = res
    if (res.status !== 404) break
  }
  return { status: last.status, body: last.body, eventTicker: "", focusSymbol: "" }
}

function contractResult(c) {
  const side = String((c && (c.resolutionSide || c.result)) || "").toLowerCase()
  if (side === "yes") return "won"
  if (side) return "lost"
  return "unsettled"
}

// The contract a pasted symbol points at, if the event lists it.
function findFocusContract(contracts, symbol) {
  if (!symbol) return null
  const want = String(symbol).toUpperCase()
  const match = (contracts || []).find((c) =>
    [c.instrumentSymbol, c.symbol, c.ticker].some((v) => v && String(v).toUpperCase() === want))
  if (!match) return null
  return {
    symbol: want,
    label: match.label || match.displayName || match.abbreviatedName || want,
    result: contractResult(match),
  }
}

// The settlement summary inputs for a Gemini event payload — unchanged from
// what both entrypoints computed inline, plus the focus contract.
function geminiWinnersData(eventData, identifier, focusSymbol) {
  const contracts = Array.isArray(eventData.contracts) ? eventData.contracts : []
  const winners = contracts.filter(c => c.resolutionSide === "yes" || c.result === "yes")
    .map(c => ({ label: c.label || c.displayName || "", resolvedAt: c.resolvedAt || "" }))
  const losers = contracts.filter(c => (c.resolutionSide || c.result) && c.resolutionSide !== "yes" && c.result !== "yes")
    .map(c => ({ label: c.label || c.displayName || "", status: c.status || "" }))
  return {
    title: eventData.title || identifier,
    ticker: eventData.ticker || identifier,
    status: eventData.status || "",
    resolvedAt: eventData.resolvedAt || "",
    winners,
    losers,
    contracts: contracts.length,
    platformName: "Gemini",
    focus: findFocusContract(contracts, focusSymbol),
  }
}

// One plain fact for the contract the customer asked about.
function focusFact(focus) {
  if (!focus) return ""
  const outcome = { won: "won", lost: "did not win", unsettled: "has no result yet" }[focus.result]
  return `Contract asked about: ${focus.label} (${focus.symbol}) ${outcome}`
}

module.exports = {
  geminiEventCandidates,
  fetchGeminiSettlementEvent,
  findFocusContract,
  geminiWinnersData,
  focusFact,
}
