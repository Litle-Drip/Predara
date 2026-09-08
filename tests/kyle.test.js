const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const kyle = require("../kyle.js")

const HOUR = 3600000
const DAY = 24 * HOUR
const NOW = Date.parse("2026-06-15T12:00:00Z")

function openEvent(overrides = {}) {
  return {
    ticker: "FEDJUL26",
    title: "Will the Fed cut rates in July?",
    status: "active",
    type: "binary",
    category: "Economics",
    closeDate: new Date(NOW + 10 * DAY).toISOString(),
    contracts: [{ label: "Yes", instrumentSymbol: "GEMI-FEDJUL26-YES", prices: { lastTradePrice: "0.34" } }],
    ...overrides,
  }
}

test("a pasted Gemini link, a ticker and a customer's words are told apart", () => {
  assert.equal(kyle.kyleParseQuery("https://www.gemini.com/predictions/TPC2026T5").kind, "ticker")
  assert.equal(kyle.kyleParseQuery("FEDJAN26").kind, "ticker")
  assert.equal(kyle.kyleParseQuery("  will the fed cut rates  ").kind, "search")
  assert.equal(kyle.kyleParseQuery("").kind, "empty")
})

test("status separates open, closed-awaiting-result, settled and voided", () => {
  assert.equal(kyle.kyleStatus(openEvent(), NOW).code, "open")

  // Trading time has passed but nothing has been published: not settled.
  const closed = openEvent({ closeDate: new Date(NOW - 2 * HOUR).toISOString() })
  assert.equal(kyle.kyleStatus(closed, NOW).code, "closed")

  const settled = openEvent({
    status: "settled",
    resolvedAt: new Date(NOW - DAY).toISOString(),
    contracts: [{ label: "Yes", resolutionSide: "yes", prices: { lastTradePrice: "1" } }],
  })
  assert.equal(kyle.kyleStatus(settled, NOW).code, "settled")

  assert.equal(kyle.kyleStatus(openEvent({ status: "cancelled" }), NOW).code, "voided")
})

test("a settled event names the winning outcome and the payout line", () => {
  const brief = kyle.kyleBrief(openEvent({
    status: "settled",
    resolvedAt: "2026-06-14T12:00:00Z",
    contracts: [{ label: "Yes", resolutionSide: "yes", prices: { lastTradePrice: "1" } }],
  }), NOW)
  assert.ok(brief.winner, "a settled binary event must expose its winning side")
  assert.match(brief.winner.name, /YES/)
  assert.equal(brief.resolution.known, true)
  assert.match(kyle.kyleSummaryText(brief), /WINNING OUTCOME/)
})

test("an event stuck unresolved a day after close is flagged for escalation", () => {
  const stuck = openEvent({ closeDate: new Date(NOW - 3 * DAY).toISOString() })
  const issues = kyle.kyleIssues(stuck, NOW)
  assert.ok(issues.some((i) => i.level === "alert" && /after trading closed/i.test(i.title)))
})

test("settled with no published winner is an alert, never a guess", () => {
  const ambiguous = openEvent({ status: "settled", resolvedAt: new Date(NOW - HOUR).toISOString() })
  const brief = kyle.kyleBrief(ambiguous, NOW)
  assert.equal(brief.winner, null)
  assert.ok(brief.issues.some((i) => i.level === "alert" && /no winning outcome/i.test(i.title)))
})

test("an open event carries no resolution date and says so", () => {
  const brief = kyle.kyleBrief(openEvent(), NOW)
  assert.equal(brief.resolution.known, false)
  assert.match(brief.resolution.text, /Not resolved yet/)
  assert.equal(brief.status.code, "open")
})

test("a binary event shows the customer's NO side, not just the YES contract", () => {
  const outcomes = kyle.kyleOutcomes(openEvent())
  assert.equal(outcomes.length, 2)
  assert.match(outcomes[0].name, /^YES/)
  assert.match(outcomes[1].name, /^NO/)
  assert.equal(outcomes[0].pct + outcomes[1].pct, 100)
})

test("a multi-outcome event tells the agent to ask which contract", () => {
  const multi = openEvent({
    type: "multi",
    contracts: [
      { label: "Team A", prices: { lastTradePrice: "0.5" } },
      { label: "Team B", prices: { lastTradePrice: "0.3" } },
      { label: "Team C", prices: { lastTradePrice: "0.2" } },
    ],
  })
  const brief = kyle.kyleBrief(multi, NOW)
  assert.equal(brief.type.code, "multi")
  assert.ok(brief.issues.some((i) => /which/i.test(i.title) || /WHICH/.test(brief.type.plain)))
})

test("the ticket summary is plain text with the identifiers support needs", () => {
  const text = kyle.kyleSummaryText(kyle.kyleBrief(openEvent(), NOW))
  assert.match(text, /EVENT: Will the Fed cut rates in July\?/)
  assert.match(text, /TICKER: FEDJUL26/)
  assert.match(text, /STATUS: OPEN/)
  assert.doesNotMatch(text, /[<>]/)
})

test("event titles from the API are escaped before they reach the page", () => {
  const brief = kyle.kyleBrief(openEvent({ title: '<img src=x onerror="alert(1)">' }), NOW)
  const html = kyle.kyleBriefHtml(brief)
  assert.ok(!html.includes("<img src=x"), "an event title must never render as markup")
  assert.match(html, /&lt;img src=x/)
})

test("Kyle is reachable from every page's nav", () => {
  const root = path.join(__dirname, "..")
  for (const page of ["index.html", "settlement.html", "kyle.html"]) {
    const html = fs.readFileSync(path.join(root, page), "utf8")
    assert.ok(html.includes('href="/kyle.html"'), `${page} is missing the Kyle tab`)
  }
})

test("the Kyle page loads its logic and reads from the read-only Gemini routes", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "kyle.html"), "utf8")
  assert.match(html, /src="kyle\.js/)
  const js = fs.readFileSync(path.join(__dirname, "..", "kyle.js"), "utf8")
  assert.match(js, /\/api\/gemini\?ticker=/)
  assert.match(js, /resource=events&search=/)
})

// ── Regressions: the two inputs a support agent actually has to hand ──────────
// A customer sends the link out of their browser, or the instrument symbol off
// their position. Both used to dead-end while only the bare event ticker worked.

test("a Gemini link keeps its ticker when the URL carries a slug and a query", () => {
  const parsed = kyle.kyleParseQuery(
    "https://www.gemini.com/predictions/F1-ITAGP-POD-20260906/italian-grand-prix-podium?categoryPath=sports%2Csports_motorsports&status=active"
  )
  assert.equal(parsed.kind, "ticker")
  assert.equal(parsed.value, "F1-ITAGP-POD-20260906", "the slug must not be mistaken for the ticker")
})

test("a link with no slug still resolves, and a non-event gemini link is searched", () => {
  assert.equal(kyle.kyleParseQuery("https://www.gemini.com/predictions/TPC2026T5").value, "TPC2026T5")
  assert.equal(kyle.kyleParseQuery("https://www.gemini.com/about/our-story").kind, "search")
})

test("an instrument symbol offers its event ticker as a lookup candidate", () => {
  const candidates = kyle.kyleTickerCandidates("GEMI-F1-ITAGP-POD-20260906-ALB")
  assert.equal(candidates[0], "GEMI-F1-ITAGP-POD-20260906-ALB", "the pasted value is tried first")
  assert.ok(candidates.includes("F1-ITAGP-POD-20260906"), "the event ticker must be among the candidates")
})

test("an event ticker that already resolves is looked up once, not stripped first", () => {
  assert.equal(kyle.kyleTickerCandidates("F1-ITAGP-POD-20260906")[0], "F1-ITAGP-POD-20260906")
  assert.deepEqual(kyle.kyleTickerCandidates("FEDJUL26"), ["FEDJUL26"])
})

test("pasting a contract symbol marks that contract as the one asked about", () => {
  const event = {
    ticker: "F1-ITAGP-POD-20260906",
    title: "Italian Grand Prix — podium finish",
    status: "active",
    closeDate: new Date(NOW + 2 * DAY).toISOString(),
    contracts: [
      { label: "Verstappen", instrumentSymbol: "GEMI-F1-ITAGP-POD-20260906-VER", prices: { lastTradePrice: "0.72" } },
      { label: "Albon", instrumentSymbol: "GEMI-F1-ITAGP-POD-20260906-ALB", prices: { lastTradePrice: "0.11" } },
    ],
  }
  const brief = kyle.kyleBrief(event, NOW, { focusSymbol: "GEMI-F1-ITAGP-POD-20260906-ALB" })
  const focused = brief.outcomes.filter((o) => o.focus)
  assert.equal(focused.length, 1)
  assert.equal(focused[0].name, "Albon")
  assert.match(kyle.kyleSummaryText(brief), /CONTRACT ASKED ABOUT: Albon/)
  assert.match(kyle.kyleBriefHtml(brief), /k-outcome-focus/)
})

// ── A podium market is not a "pick one" market ────────────────────────────────
// Several contracts settle YES on a top-N event. Telling an agent "only one of
// these can win" about one of those produces a wrong answer to the customer.

test("independent top-N contracts are not described as mutually exclusive", () => {
  const podium = {
    ticker: "F1-ITAGP-POD-20260906",
    title: "Italian Grand Prix — podium finish",
    status: "active",
    closeDate: new Date(NOW + DAY).toISOString(),
    contracts: [
      { label: "Verstappen", prices: { lastTradePrice: "0.72" } },
      { label: "Norris", prices: { lastTradePrice: "0.55" } },
      { label: "Albon", prices: { lastTradePrice: "0.11" } },
    ],
  }
  assert.equal(kyle.kyleExclusive(podium), false)
  const type = kyle.kyleType(podium)
  assert.equal(type.exclusive, false)
  assert.doesNotMatch(type.plain, /only one/i)
  assert.match(type.plain, /several of them can pay out/i)
})

test("a field priced as shares of one outcome stays a pick-one market", () => {
  const raceWinner = {
    contracts: [
      { label: "Verstappen", prices: { lastTradePrice: "0.55" } },
      { label: "Norris", prices: { lastTradePrice: "0.30" } },
      { label: "Albon", prices: { lastTradePrice: "0.15" } },
    ],
  }
  assert.equal(kyle.kyleExclusive(raceWinner), true)
  assert.match(kyle.kyleType(raceWinner).plain, /only one of them can happen/i)

  const headToHead = {
    contracts: [
      { label: "Yankees", prices: { lastTradePrice: "0.6" } },
      { label: "Red Sox", prices: { lastTradePrice: "0.4" } },
    ],
  }
  assert.equal(kyle.kyleType(headToHead).code, "head2head")
})

test("an explicit exclusivity flag beats the price heuristic", () => {
  const flagged = {
    mutuallyExclusive: true,
    contracts: [
      { label: "A", prices: { lastTradePrice: "0.9" } },
      { label: "B", prices: { lastTradePrice: "0.9" } },
    ],
  }
  assert.equal(kyle.kyleExclusive(flagged), true)
})

test("with no flag and no prices Kyle says it cannot tell, rather than guessing", () => {
  const unpriced = { contracts: [{ label: "A" }, { label: "B" }, { label: "C" }] }
  assert.equal(kyle.kyleExclusive(unpriced), null)
  assert.match(kyle.kyleType(unpriced).plain, /cannot tell/i)
})

test("a settled top-N event reports every winning outcome", () => {
  const settled = {
    ticker: "F1-ITAGP-POD-20260906",
    title: "Italian Grand Prix — podium finish",
    status: "settled",
    resolvedAt: new Date(NOW - HOUR).toISOString(),
    closeDate: new Date(NOW - 2 * HOUR).toISOString(),
    contracts: [
      { label: "Verstappen", resolutionSide: "yes" },
      { label: "Norris", resolutionSide: "yes" },
      { label: "Albon", resolutionSide: "no" },
    ],
  }
  const brief = kyle.kyleBrief(settled, NOW)
  assert.equal(brief.winner, null, "there is no single winner on a multi-winner event")
  assert.match(kyle.kyleSummaryText(brief), /WINNING OUTCOMES \(2\): Verstappen, Norris/)
  assert.ok(
    !brief.issues.some((i) => /no winning outcome/i.test(i.title)),
    "two published winners must not trip the missing-winner alert"
  )
})
