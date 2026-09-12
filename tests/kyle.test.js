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

  // Gemini says trading is closed and nothing has been published: not settled.
  const closed = openEvent({ status: "closed", closeDate: new Date(NOW - 2 * HOUR).toISOString() })
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
  const stuck = openEvent({ status: "closed", closeDate: new Date(NOW - 3 * DAY).toISOString() })
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

test("exclusivity is never inferred from prices", () => {
  // The old heuristic summed contract prices. It read bestAsk, and in a real
  // book the asks sum above 1 because of the spread, so genuinely exclusive
  // markets read as "several can win" — wrong, and wrong systematically.
  const podium = {
    contracts: [
      { label: "Verstappen", prices: { lastTradePrice: "0.72" } },
      { label: "Norris", prices: { lastTradePrice: "0.55" } },
      { label: "Albon", prices: { lastTradePrice: "0.11" } },
    ],
  }
  const twoWayThinBook = {
    contracts: [
      { label: "Home", prices: { bestAsk: "0.72" } },
      { label: "Away", prices: { bestAsk: "0.66" } },
    ],
  }
  for (const [name, event] of [["podium", podium], ["thin two-way", twoWayThinBook]]) {
    assert.equal(kyle.kyleExclusive(event), null, `${name}: prices must not decide exclusivity`)
    const plain = kyle.kyleType(event).plain
    assert.doesNotMatch(plain, /only one of them can happen/i, `${name} must not claim exclusivity`)
    assert.doesNotMatch(plain, /several of them can pay out/i, `${name} must not deny exclusivity`)
    assert.match(plain, /contract terms/i, `${name} should send the agent to the terms`)
  }
})

test("an explicit exclusivity flag is honoured in both directions", () => {
  const two = [{ label: "A", prices: { lastTradePrice: "0.9" } }, { label: "B", prices: { lastTradePrice: "0.9" } }]
  assert.equal(kyle.kyleExclusive({ mutuallyExclusive: true, contracts: two }), true)
  assert.equal(kyle.kyleExclusive({ mutually_exclusive: false, contracts: two }), false)
  assert.match(kyle.kyleType({ mutuallyExclusive: true, contracts: two }).plain, /only one of them can happen/i)
})

test("a single yes/no contract is exclusive by construction", () => {
  assert.equal(kyle.kyleExclusive({ type: "binary", contracts: [{ label: "Yes" }] }), true)
  assert.equal(kyle.kyleType({ type: "binary", contracts: [{ label: "Yes" }] }).code, "binary")
})

test("a settled event's own resolution sides decide exclusivity, not its prices", () => {
  const podium = {
    status: "settled",
    contracts: [
      { label: "Verstappen", resolutionSide: "yes" },
      { label: "Norris", resolutionSide: "yes" },
      { label: "Piastri", resolutionSide: "yes" },
      { label: "Leclerc", resolutionSide: "no" },
    ],
  }
  assert.equal(kyle.kyleExclusive(podium), false, "three winners cannot be mutually exclusive")

  const raceWinner = {
    status: "settled",
    contracts: [
      { label: "Verstappen", resolutionSide: "yes" },
      { label: "Norris", resolutionSide: "no" },
      { label: "Piastri", resolutionSide: "no" },
    ],
  }
  assert.equal(kyle.kyleExclusive(raceWinner), true)
})

test("the headline states the outcome, not the status word", () => {
  const open = kyle.kyleBrief(openEvent(), NOW)
  assert.match(kyle.kyleHeadline(open, NOW), /reports this event as open/i)
  assert.match(kyle.kyleHeadline(open, NOW), /no contract has settled/i)

  const settled = kyle.kyleBrief(openEvent({
    status: "settled",
    resolvedAt: new Date(NOW - HOUR).toISOString(),
    contracts: [{ label: "Yes", resolutionSide: "yes" }],
  }), NOW)
  assert.match(kyle.kyleHeadline(settled, NOW), /Finished/)
  assert.match(kyle.kyleHeadline(settled, NOW), /settles at/i)

  // The ticket summary opens with the same sentence, in its absolute form.
  assert.ok(kyle.kyleSummaryText(settled, NOW).startsWith(kyle.kyleHeadline(settled, NOW, { relative: false })))
})

test("a long outcome field collapses but never hides a winner or the pasted contract", () => {
  const many = {
    ticker: "F1-ITAGP-POD-20260906",
    status: "settled",
    contracts: Array.from({ length: 22 }, (_, i) => ({
      label: `Driver ${i + 1}`,
      instrumentSymbol: `GEMI-F1-ITAGP-POD-20260906-D${i + 1}`,
      resolutionSide: i < 3 ? "yes" : "no",
    })),
  }
  const brief = kyle.kyleBrief(many, NOW, { focusSymbol: "GEMI-F1-ITAGP-POD-20260906-D20" })
  const html = kyle.kyleOutcomesHtml(brief)
  const beforeCollapse = html.split('id="kyleMoreOutcomes"')[0]
  for (const name of ["Driver 1", "Driver 2", "Driver 3", "Driver 20"]) {
    assert.ok(beforeCollapse.includes(name), `${name} must stay visible without expanding`)
  }
  assert.match(html, /Show \d+ more/)
})

test("the Kyle page ships four themes and never hardcodes a colour into the markup", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "kyle.html"), "utf8")
  for (const theme of ["gemini", "mars", "seas", "astro"]) {
    assert.ok(html.includes(`body[data-theme="${theme}"]`), `${theme} theme tokens are missing`)
    assert.ok(html.includes(`kyleSetTheme('${theme}')`), `${theme} has no picker button`)
  }
  // Every illustrated theme must degrade to a gradient if its artwork is absent.
  for (const theme of ["mars", "seas", "astro"]) {
    const marker = `body[data-theme="${theme}"]`
    // Slice past the marker itself, then stop at the next theme block.
    const after = html.slice(html.indexOf(marker) + marker.length)
    const block = after.split("body[data-theme=")[0]
    assert.match(block, /--k-art:\s*url\(/, `${theme} should load artwork`)
    assert.match(block, /--k-fallback:/, `${theme} must stay readable without its artwork`)
  }
  assert.ok(html.includes('data-theme="gemini"'), "the clean Gemini theme is the default")
})

// ── The raw API record ────────────────────────────────────────────────────────
// Agents open the upstream event JSON on essentially every ticket: it is the
// source Kyle itself reads, so it is what to quote when a customer disputes the
// page and what to attach when escalating.

test("the brief carries the upstream API URL for the event", () => {
  const brief = kyle.kyleBrief(openEvent({ ticker: "BTC2609082100" }), NOW)
  assert.equal(brief.links.api, "https://api.gemini.com/v1/prediction-markets/events/BTC2609082100")
})

test("the API URL is built from the resolved event, not from what was pasted", () => {
  // The agent pasted a contract symbol; the API link must point at the event
  // that was actually found, or it 404s exactly like the original lookup did.
  const event = {
    ticker: "F1-ITAGP-POD-20260906",
    title: "Italian Grand Prix Podium",
    status: "active",
    closeDate: new Date(NOW + DAY).toISOString(),
    contracts: [{ label: "Albon", instrumentSymbol: "GEMI-F1-ITAGP-POD-20260906-ALB", prices: { lastTradePrice: "0.11" } }],
  }
  const brief = kyle.kyleBrief(event, NOW, { focusSymbol: "GEMI-F1-ITAGP-POD-20260906-ALB" })
  assert.ok(brief.links.api.endsWith("/events/F1-ITAGP-POD-20260906"))
  assert.ok(!brief.links.api.includes("ALB"))
})

test("the API URL reaches the ticket, the page, and a copy button", () => {
  const brief = kyle.kyleBrief(openEvent({ ticker: "BTC2609082100" }), NOW)
  assert.match(kyle.kyleSummaryText(brief), /^API: https:\/\/api\.gemini\.com\/v1\/prediction-markets\/events\/BTC2609082100$/m)
  const html = kyle.kyleBriefHtml(brief)
  assert.match(html, /API response ↗/)
  assert.match(html, /id="kyleApiUrl"/)
  assert.match(html, /kyleCopyApiUrl\(\)/)
})

test("an event with no ticker offers no links rather than a broken one", () => {
  const brief = kyle.kyleBrief({ title: "Untitled", status: "active", contracts: [{ label: "Yes" }] }, NOW)
  assert.equal(brief.links.api, "")
  assert.doesNotMatch(kyle.kyleBriefHtml(brief), /API response/)
  assert.doesNotMatch(kyle.kyleSummaryText(brief), /^API:/m)
})

// ── Theme contrast ────────────────────────────────────────────────────────────
// A brand colour bright enough to read as the brand is rarely dark enough to
// carry white 12px text. Gemini blue #0093F5 with white is 3.2:1, against the
// 4.5:1 WCAG AA needs at that size — so the fill is a darkened variant and the
// brand colour is kept for chrome. This asserts the arithmetic, not the taste.
function contrast(a, b) {
  const lum = (hex) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)))
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
  }
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

test("every theme's button label clears WCAG AA against its fill", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "kyle.html"), "utf8")
  for (const theme of ["gemini", "mars", "seas", "astro"]) {
    const block = html.slice(html.indexOf(`body[data-theme="${theme}"]`))
    const fill = block.match(/--k-fill:\s*(#[0-9a-fA-F]{6})/)
    const onFill = block.match(/--k-on-fill:\s*(#[0-9a-fA-F]{6})/)
    assert.ok(fill && onFill, `${theme} is missing a fill/on-fill pair`)
    const ratio = contrast(fill[1], onFill[1])
    assert.ok(ratio >= 4.5, `${theme}: ${onFill[1]} on ${fill[1]} is ${ratio.toFixed(2)}:1, below AA 4.5:1`)
  }
})

test("the Gemini theme uses the brand blue on its chrome", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "kyle.html"), "utf8")
  const block = html.slice(html.indexOf('body[data-theme="gemini"]'), html.indexOf('body[data-theme="mars"]'))
  assert.match(block, /--orange:\s*#0093f5/i, "the brand blue should be the theme accent")
  assert.match(html, /\.k-swatch-gemini \{\s*background: #0093f5/i, "the picker swatch should be the blue disc")
})

test("nothing renders white text directly on the raw brand accent", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "kyle.html"), "utf8")
  const offenders = html.split("\n").filter((line) =>
    /background:\s*var\(--orange\)/.test(line) && /color:\s*(#fff|#ffffff|white)/i.test(line))
  assert.deepEqual(offenders, [], "filled elements must use --k-fill/--k-on-fill, not --orange with #fff")
})

// ── Single-word event tickers ─────────────────────────────────────────────────
// Most of the non-sports catalogue has no hyphen in its event ticker, so an
// instrument symbol for one is only two segments after the venue prefix. The
// candidate walk used to stop while two segments remained, which meant it never
// emitted the bare ticker and every one of those symbols dead-ended.
test("an instrument symbol reaches a single-word event ticker", () => {
  const candidates = kyle.kyleTickerCandidates("GEMI-USOPENM26-ALCARAZ")
  assert.equal(candidates[0], "GEMI-USOPENM26-ALCARAZ", "the pasted value is still tried first")
  assert.ok(candidates.includes("USOPENM26"), "the event ticker must be among the candidates")
})

test("hyphenated tickers still resolve, and a bare ticker costs one lookup", () => {
  assert.ok(kyle.kyleTickerCandidates("GEMI-F1-ITAGP-POD-20260906-ALB").includes("F1-ITAGP-POD-20260906"))
  assert.deepEqual(kyle.kyleTickerCandidates("USOPENM26"), ["USOPENM26"])
  assert.deepEqual(kyle.kyleTickerCandidates("FEDJUL26"), ["FEDJUL26"])
})

test("candidate stripping never produces an empty ticker", () => {
  for (const input of ["GEMI-ABC", "GEMI-", "A-B", "X"]) {
    for (const candidate of kyle.kyleTickerCandidates(input)) {
      assert.ok(candidate.length > 0, `"${input}" produced an empty candidate`)
      assert.doesNotMatch(candidate, /^-|-$/, `"${input}" produced a ragged candidate "${candidate}"`)
    }
  }
})

// ── Card order ────────────────────────────────────────────────────────────────
// The links belong with the identifiers an agent is acting on, not below a
// field of outcomes they have to scroll past.
test("the hand-off card sits directly under Details, above Outcomes", () => {
  const brief = kyle.kyleBrief(openEvent({ ticker: "USOPENM26" }), NOW)
  const html = kyle.kyleBriefHtml(brief)
  const details = html.indexOf(">Details<")
  const actions = html.indexOf('class="k-actions"')
  const outcomes = html.indexOf(">Outcomes")
  assert.ok(details < actions, "the hand-off must come after Details")
  assert.ok(actions < outcomes, "the hand-off must come before Outcomes")
})

test("the Gemini theme carries the brand blue across the page, not just the buttons", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "kyle.html"), "utf8")
  const marker = 'body[data-theme="gemini"]'
  const block = html.slice(html.indexOf(marker) + marker.length).split("body[data-theme=")[0]
  // The page itself is tinted rather than white or grey.
  const bg = block.match(/--bg:\s*(#[0-9a-fA-F]{6})/)[1].toLowerCase()
  assert.notEqual(bg, "#ffffff", "the Gemini page should be tinted, not white")
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16))
  assert.ok(b > r && b > g, `the page tint ${bg} should lean blue`)
  assert.match(block, /--k-fallback:\s*linear-gradient/, "the Gemini page should carry a brand wash")
})

// ══ Accuracy hardening ════════════════════════════════════════════════════════
// Kyle's output is read aloud to customers and pasted into emails by a public
// company. Each test below fixes a case where Kyle stated something it could
// not source. The rule they enforce together: Kyle reports what the API says,
// and names the gap everywhere else.

test("Gemini's status is never overruled by the agent's clock", () => {
  // Telling a customer trading has stopped, on the strength of a browser clock,
  // can cost them a position they wanted to exit.
  const stillOpen = openEvent({ status: "active", closeDate: new Date(NOW - 3 * HOUR).toISOString() })
  const status = kyle.kyleStatus(stillOpen, NOW)
  assert.equal(status.code, "conflict")
  assert.doesNotMatch(status.plain, /trading has stopped/i)
  assert.match(status.plain, /will not guess|confirm/i)
})

test("the status/close-time conflict raises a flag that can actually fire", () => {
  // The flag written for this case used to be unreachable: it was gated on a
  // status the clock override had already made impossible.
  const conflicted = openEvent({ status: "active", closeDate: new Date(NOW - 3 * HOUR).toISOString() })
  const issues = kyle.kyleIssues(conflicted, NOW)
  assert.ok(issues.some((i) => i.level === "alert" && /disagree/i.test(i.title)), "the conflict must be flagged")
})

test("settlement is described as what the contract does, never as a completed payout", () => {
  const settled = kyle.kyleBrief(openEvent({
    status: "settled",
    resolvedAt: new Date(NOW - HOUR).toISOString(),
    contracts: [{ label: "Yes", resolutionSide: "yes" }],
  }), NOW)
  const surfaces = [settled.status.plain, kyle.kyleHeadline(settled, NOW), kyle.kyleSummaryText(settled, NOW)]
  for (const text of surfaces) {
    assert.doesNotMatch(text, /have paid out|has been paid|were paid|paid \$1/i,
      "Kyle reads a resolution state, not an account credit")
  }
  assert.match(settled.status.plain, /cannot see whether an individual account has been credited/i)
})

test("`settlementValue` is never read as a payout — it is the measured value", () => {
  // This test used to assert the opposite, and the opposite was a live defect:
  // on a crypto market settlementValue carries the BTC price that decided the
  // outcome, so reading it as the payout made Kyle tell an agent "winning
  // contracts settle at $64,493.48 per contract". The name collides with a
  // parameter in lib/gemini.js that DOES mean the $1 payout; the API field does
  // not. No payout figure is invented from it.
  const crypto = {
    settlement: { value: "64493.48440000002" },
    contracts: [{ label: "Up", settlementValue: "64493.48440000002", strike: { type: "reference", value: "64527.43" } }],
  }
  const settlement = kyle.kyleSettlement(crypto)
  assert.equal(settlement.known, false, "no payout is published on this event")
  assert.match(settlement.each, /full settlement value/i)
  assert.doesNotMatch(settlement.each, /64,?493/, "the measured price must never be quoted as a payout")

  const brief = kyle.kyleBrief(crypto, NOW)
  for (const text of [brief.status.plain, kyle.kyleHeadline(brief, NOW), kyle.kyleSummaryText(brief, NOW)]) {
    assert.doesNotMatch(text, /settles at \$64/, "the measured price must not reach any payout sentence")
  }
})

test("a genuine payout field would still be honoured", () => {
  assert.equal(kyle.kyleSettlement({ contracts: [{ label: "Yes", payoutValue: 5 }] }).amount, "$5.00")
  assert.equal(kyle.kyleSettlement({ payoutValue: 1, contracts: [{ label: "Yes" }] }).amount, "$1.00")
})

test("an undecided market never displays 0% or 100%", () => {
  for (const price of ["0.9999", "0.996", "0.0001", "0.004"]) {
    const [yes, no] = kyle.kyleOutcomes({ type: "binary", contracts: [{ label: "Yes", prices: { lastTradePrice: price } }] })
    for (const row of [yes, no]) {
      assert.notEqual(row.pctLabel, "100%", `price ${price} rendered certainty`)
      assert.notEqual(row.pctLabel, "0%", `price ${price} rendered impossibility`)
      assert.match(row.pctLabel, /^(>99%|<1%|\d{1,2}%)$/)
    }
  }
  // An ordinary price is still shown plainly.
  const [mid] = kyle.kyleOutcomes({ type: "binary", contracts: [{ label: "Yes", prices: { lastTradePrice: "0.5" } }] })
  assert.equal(mid.pctLabel, "50%")
})

test("the derived NO side is marked as calculated, not quoted", () => {
  const [, no] = kyle.kyleOutcomes({ type: "binary", contracts: [{ label: "Yes", prices: { lastTradePrice: "0.42" } }] })
  assert.equal(no.derived, true)
  const html = kyle.kyleBriefHtml(kyle.kyleBrief(openEvent(), NOW))
  assert.match(html, /calculated/, "the calculated row must be labelled on the page")
})

test("the copied block carries its own provenance", () => {
  const brief = kyle.kyleBrief(openEvent({ ticker: "BTC2609082100" }), NOW)
  const text = kyle.kyleSummaryText(brief, NOW)
  assert.match(text, /Source: Gemini Prediction Markets API, read \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\./)
  assert.match(text, /not a statement of any customer's account, position, or payout/i)
  assert.match(text, /Confirm the current state on the event page/i)
  assert.match(text, /as reported by Gemini/i)
})

test("copied timestamps are absolute UTC, because relative ones go stale on send", () => {
  const brief = kyle.kyleBrief(openEvent({
    status: "settled",
    resolvedAt: new Date(NOW - HOUR).toISOString(),
  }), NOW)
  const text = kyle.kyleSummaryText(brief, NOW)
  assert.doesNotMatch(text, /\b(ago|in \d+ (minute|hour|day|month))/i, "no relative time may survive into copied text")
  assert.match(text, /\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/)
})

test("the brief records when it was read, and the page shows its age", () => {
  const brief = kyle.kyleBrief(openEvent(), NOW, { retrievedAt: NOW })
  assert.equal(brief.retrievedAt, new Date(NOW).toISOString())
  const html = kyle.kyleBriefHtml(brief)
  assert.match(html, /id="kyleFreshness"/)
  assert.match(html, /data-read="[^"]+"/)
  assert.match(html, /kyleRefresh\(\)/)
})

test("the disclaimer sits with the answer, not only in the page footer", () => {
  const html = kyle.kyleBriefHtml(kyle.kyleBrief(openEvent(), NOW))
  assert.match(html, /not a statement of any customer's account/i)
})

test("a voided event never describes how the trades were handled", () => {
  const voided = kyle.kyleBrief(openEvent({ status: "cancelled" }), NOW)
  for (const text of [voided.status.plain, kyle.kyleHeadline(voided, NOW), kyle.kyleSummaryText(voided, NOW)]) {
    assert.doesNotMatch(text, /unwound|refund(ed)? (is|are|will)/i, "refund mechanics are Gemini policy Kyle does not read")
  }
  assert.match(voided.status.plain, /cannot tell you how the trades/i)
})

test("a payload with no contracts describes no outcomes", () => {
  const listRow = { ticker: "USOPENM26", title: "US Open", status: "active" }
  const type = kyle.kyleType(listRow)
  assert.equal(type.code, "unlisted")
  assert.equal(type.outcomeCount, null)
  assert.doesNotMatch(type.label, /\b0\b/, "never claim zero outcomes")
  assert.doesNotMatch(type.plain, /\b0 separate contracts/)
  assert.deepEqual(kyle.kyleIssues(listRow, NOW).filter((i) => /Multiple outcomes/.test(i.title)), [])
})

test("'Listed' is not silently the record-creation time", () => {
  assert.equal(kyle.kyleDates({ openDate: "2026-01-01T00:00:00Z" }).listedLabel, "Listed")
  assert.equal(kyle.kyleDates({ createdAt: "2026-01-01T00:00:00Z" }).listedLabel, "Record created")
})

test("on-page timestamps show UTC alongside the agent's local time", () => {
  const brief = kyle.kyleBrief(openEvent(), NOW)
  assert.match(kyle.kyleFactsHtml(brief), /UTC/, "the customer sees UTC on gemini.com")
})

test("a conflicted event does not label its close time as already closed", () => {
  // The row label is derived from the clock; on a conflict it would otherwise
  // contradict the banner directly above it.
  const conflicted = kyle.kyleBrief(openEvent({ status: "active", closeDate: new Date(NOW - 3 * HOUR).toISOString() }), NOW)
  assert.equal(conflicted.status.code, "conflict")
  const facts = kyle.kyleFactsHtml(conflicted)
  assert.match(facts, /Published close time/)
  assert.doesNotMatch(facts, /Trading closed/)
  assert.match(kyle.kyleSummaryText(conflicted, NOW), /PUBLISHED CLOSE TIME:/)
})

// ══ Verified against a real Gemini response ═══════════════════════════════════
// tests/fixtures/gemini-settled-categorical.json is a trimmed but verbatim
// capture of F1-ITAGP-WIN-20260906. Until this landed, every field name in Kyle
// was inferred from what adapters.js happened to read. These tests pin Kyle to
// the one payload shape that has actually been observed.
const REAL_EVENT = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "gemini-settled-categorical.json"), "utf8")
)
const REAL_NOW = Date.parse("2026-09-08T18:00:00Z")

test("a real settled categorical event reports the right winner and state", () => {
  const brief = kyle.kyleBrief(REAL_EVENT, REAL_NOW)
  assert.equal(brief.status.code, "settled")
  assert.equal(brief.ticker, "F1-ITAGP-WIN-20260906")
  assert.equal(brief.title, "Italian Grand Prix Winner")
  assert.ok(brief.winner, "the winning contract must be identified")
  assert.equal(brief.winner.name, "Andrea Kimi Antonelli")
  // Exactly one contract carries resolutionSide "yes"; the rest are "no".
  assert.equal(brief.outcomes.filter((o) => o.result === "won").length, 1)
  assert.equal(kyle.kyleExclusive(REAL_EVENT), true)
})

test("the real payload's dates map to the right rows", () => {
  const { dates } = kyle.kyleBrief(REAL_EVENT, REAL_NOW)
  assert.equal(dates.tradingCloses, "2026-09-06T17:00:00.000Z", "event.expiryDate is the close")
  assert.equal(dates.resolved, "2026-09-06T21:01:16.212Z")
  assert.equal(dates.eventStart, "2026-09-06T13:00:00.000Z", "startTime is when the race began")
  assert.equal(dates.listedLabel, "Listed", "effectiveDate is a real listing date, not createdAt")
})

test("the sport is found even though the payload has no top-level sport field", () => {
  const brief = kyle.kyleBrief(REAL_EVENT, REAL_NOW)
  assert.equal(brief.sport, "F1", "subcategory.name carries the league")
  assert.equal(brief.category, "Sports")
  assert.notEqual(brief.sport, brief.category, "never print the same label twice")
})

test("the contract's own resolution wording is surfaced, with its source feed", () => {
  const criteria = kyle.kyleResolution(REAL_EVENT)
  assert.ok(criteria, "the criteria text must be extracted from the rich-text document")
  assert.match(criteria.text, /officially declared the winner/)
  assert.match(criteria.text, /Source Agencies/)
  assert.equal(criteria.isExample, true, "one contract's wording stands in for the event")
  assert.equal(criteria.agency, "statscore-rest-api")
  assert.doesNotMatch(criteria.text, /\]\(https?:/, "markdown link syntax must not reach the page")

  // Pasting a specific contract shows that contract's wording, not a stand-in.
  const focused = kyle.kyleResolution(REAL_EVENT, "GEMI-F1-ITAGP-WIN-20260906-ANT")
  assert.equal(focused.isExample, false)
  assert.match(focused.text, /Andrea Kimi Antonelli/)
})

test("the real payload publishes no settlement value, so no amount is invented", () => {
  // There is a `settlement` key, but it is an empty object — Kyle must not
  // print "$1" on the strength of a convention.
  assert.deepEqual(REAL_EVENT.settlement, {})
  const brief = kyle.kyleBrief(REAL_EVENT, REAL_NOW)
  assert.equal(brief.settlement.known, false)
  assert.doesNotMatch(kyle.kyleSummaryText(brief, REAL_NOW), /\$1\b/)
})

test("settled contracts show a result rather than a price, with an empty book", () => {
  // prices are {buy:{},sell:{}} on a settled event — no percentage may appear.
  const brief = kyle.kyleBrief(REAL_EVENT, REAL_NOW)
  for (const outcome of brief.outcomes) {
    assert.ok(outcome.result, "every contract on a settled event has a result")
  }
  const html = kyle.kyleBriefHtml(brief)
  assert.doesNotMatch(html, /k-outcome-pct">\s*\d/, "no price is shown for a settled contract")
})

test("an open event with an unreadable price book says so instead of showing dashes", () => {
  const live = JSON.parse(JSON.stringify(REAL_EVENT))
  live.status = "active"
  live.expiryDate = new Date(REAL_NOW + DAY).toISOString()
  delete live.resolvedAt
  live.contracts.forEach((c) => { delete c.resolutionSide; delete c.resolvedAt; c.prices = { buy: {}, sell: {} } })
  const issues = kyle.kyleIssues(live, REAL_NOW)
  assert.ok(issues.some((i) => /No prices returned/.test(i.title)), "an agent must not read blank rows as zero")
})

test("the whole brief renders from the real payload without a hole in it", () => {
  const html = kyle.kyleBriefHtml(kyle.kyleBrief(REAL_EVENT, REAL_NOW))
  for (const expected of ["Italian Grand Prix Winner", "Andrea Kimi Antonelli", "F1", "How this resolves"]) {
    assert.ok(html.includes(expected), `the brief is missing ${expected}`)
  }
  assert.doesNotMatch(html, /undefined|\[object Object\]|NaN/, "no unrendered value may reach the page")
})

// ══ Verified against a live book and a settled top-N event ════════════════════
const LIVE_EVENT = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "gemini-live-categorical.json"), "utf8")
)
const PODIUM_EVENT = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "gemini-settled-podium.json"), "utf8")
)

test("the percentage shown is the one gemini.com shows the customer", () => {
  // A live book carries bestAsk, bestBid and lastTradePrice at once. Gemini
  // displays the ask as the contract's "Yes %". Reading lastTradePrice first
  // showed 31% for a contract Gemini was showing at 37%.
  const byName = {}
  for (const o of kyle.kyleOutcomes(LIVE_EVENT)) byName[o.name] = o.pctLabel
  assert.equal(byName["Andrea Kimi Antonelli"], "37%", "must be bestAsk (0.37), not lastTradePrice (0.31)")
  assert.equal(byName["Lando Norris"], "21%", "must be bestAsk (0.21), not lastTradePrice (0.17)")
  assert.equal(byName["George Russell"], "15%")
  assert.equal(byName["Alexander Albon"], "2%")
})

test("a live event's prices are read at all, rather than flagged as missing", () => {
  const issues = kyle.kyleIssues(LIVE_EVENT, Date.parse("2026-09-08T18:00:00Z"))
  assert.ok(!issues.some((i) => /No prices returned/.test(i.title)), "prices.buy/bestAsk must be readable")
})

test("`type` cannot separate a winner market from a podium market", () => {
  // This is why the type field is not used for exclusivity: it is identical on
  // both, so trusting it would repeat the price-heuristic error.
  assert.equal(REAL_EVENT.type, "categorical")
  assert.equal(PODIUM_EVENT.type, "categorical")
  assert.notEqual(REAL_EVENT.template, PODIUM_EVENT.template, "template is the field that distinguishes them")
})

test("template 'categorical' means exactly one outcome can win", () => {
  assert.equal(kyle.kyleExclusive(LIVE_EVENT), true)
  assert.match(kyle.kyleType(LIVE_EVENT).plain, /only one of them can happen/i)
})

test("a LIVE top-N market is identified before it settles", () => {
  // Before this, exclusivity could only be answered once resolution sides
  // existed — which is exactly too late to help a customer holding a position.
  const livePodium = JSON.parse(JSON.stringify(PODIUM_EVENT))
  livePodium.status = "active"
  delete livePodium.resolvedAt
  livePodium.contracts.forEach((c) => { delete c.resolutionSide; delete c.resolvedAt })

  assert.equal(kyle.kyleExclusive(livePodium), false)
  const plain = kyle.kyleType(livePodium).plain
  assert.match(plain, /more than one/i)
  assert.doesNotMatch(plain, /only one of them can happen/i)
})

test("'binary' alone is not enough — the strikes must agree", () => {
  // A head-to-head market has not been observed. If those also carry template
  // "binary", template alone would wrongly call a two-team market non-exclusive,
  // so the per-contract strike is required as a second signal.
  const templateOnly = {
    template: "binary",
    contracts: [{ label: "Team A" }, { label: "Team B" }],
  }
  assert.equal(kyle.kyleExclusive(templateOnly), null, "abstain when only one signal is present")
  assert.match(kyle.kyleType(templateOnly).plain, /contract terms/i)

  const withStrikes = {
    template: "binary",
    contracts: [
      { label: "A", strike: { type: "under_or_equal", value: "3" } },
      { label: "B", strike: { type: "under_or_equal", value: "3" } },
    ],
  }
  assert.equal(kyle.kyleExclusive(withStrikes), false, "both signals agreeing is enough")
})

test("the settled podium still reports all three winners", () => {
  const brief = kyle.kyleBrief(PODIUM_EVENT, Date.parse("2026-09-08T18:00:00Z"))
  const won = brief.outcomes.filter((o) => o.result === "won").map((o) => o.name).sort()
  assert.deepEqual(won, ["Andrea Kimi Antonelli", "George Russell", "Max Verstappen"])
  assert.equal(brief.winner, null, "there is no single winner on a multi-winner event")
  assert.match(kyle.kyleSummaryText(brief, Date.parse("2026-09-08T18:00:00Z")), /WINNING OUTCOMES \(3\)/)
  assert.match(kyle.kyleResolution(PODIUM_EVENT).text, /finishes on the podium \(top 3\)/)
})

// ══ The customer's contract is the answer ═════════════════════════════════════
// An agent pasting a contract symbol is holding a customer's position. On a
// 22-driver podium that contract was the last row of a collapsed list while the
// headline talked about three winners the customer did not hold.

test("a pasted losing contract is answered first, not buried in the list", () => {
  const brief = kyle.kyleBrief(PODIUM_EVENT, REAL_NOW, { focusSymbol: "GEMI-F1-ITAGP-POD-20260906-ALB" })
  const answer = kyle.kyleFocusAnswer(brief, REAL_NOW)
  assert.equal(answer.verdict, "lost")
  assert.equal(answer.name, "Alexander Albon")
  assert.match(answer.line, /did not win/i)
  assert.match(answer.line, /settles at zero/i)

  const html = kyle.kyleBriefHtml(brief)
  // The contract's verdict must appear before the event's own result.
  assert.ok(html.indexOf("Alexander Albon") < html.indexOf("Andrea Kimi Antonelli"),
    "the customer's contract comes before the event's winners")
  assert.match(html, /k-focus-lost/)
})

test("a pasted winning contract says so, and still defers on the credit", () => {
  const brief = kyle.kyleBrief(PODIUM_EVENT, REAL_NOW, { focusSymbol: "GEMI-F1-ITAGP-POD-20260906-ANT" })
  const answer = kyle.kyleFocusAnswer(brief, REAL_NOW)
  assert.equal(answer.verdict, "won")
  assert.match(answer.line, /settles at/i)
  assert.doesNotMatch(answer.line, /has been paid|was paid/i)
  assert.match(answer.note, /confirm the credit/i)
})

test("a pasted contract on a live market reports its price, not a result", () => {
  const brief = kyle.kyleBrief(LIVE_EVENT, REAL_NOW, { focusSymbol: "GEMI-F1-MADGP-WIN-20260913-ANT" })
  const answer = kyle.kyleFocusAnswer(brief, REAL_NOW)
  assert.equal(answer.verdict, "open")
  assert.match(answer.line, /37%/, "the ask, matching gemini.com")
  assert.match(answer.line, /Nothing has been decided/i)
})

test("with no contract pasted, the event's own result is the answer", () => {
  const brief = kyle.kyleBrief(PODIUM_EVENT, REAL_NOW)
  assert.equal(kyle.kyleFocusAnswer(brief, REAL_NOW), null)
  const html = kyle.kyleBriefHtml(brief)
  assert.doesNotMatch(html, /k-focus-label/, "no contract card without a pasted contract")
  assert.match(html, /k-headline/)
})

test("the event line is not repeated at full length beside the contract card", () => {
  const brief = kyle.kyleBrief(PODIUM_EVENT, REAL_NOW, { focusSymbol: "GEMI-F1-ITAGP-POD-20260906-ALB" })
  const concise = kyle.kyleHeadline(brief, REAL_NOW, { concise: true })
  assert.doesNotMatch(concise, /Check the customer's account/i, "the contract card already says this")
  assert.match(concise, /3 outcomes won/)
  // The copied ticket text keeps the full wording — it travels without the page.
  assert.match(kyle.kyleSummaryText(brief, REAL_NOW), /Check the customer's account/i)
})

test("type labels stay short enough to sit on one line", () => {
  for (const event of [REAL_EVENT, PODIUM_EVENT, LIVE_EVENT, { type: "binary", contracts: [{ label: "Yes" }] }]) {
    const label = kyle.kyleType(event).label
    assert.ok(label.length <= 28, `"${label}" is too long for a fact cell`)
  }
  assert.equal(kyle.kyleType(PODIUM_EVENT).label, "Several can win")
  assert.equal(kyle.kyleType(REAL_EVENT).label, "Pick one — only one can win")
})

// ══ Threshold markets: crypto and weather ═════════════════════════════════════
// These resolve by comparing a measured value against a threshold, and publish
// both numbers plus the index they came from. That is the answer to "why did
// this resolve No?", which is what a customer disputing a result is asking.
const CRYPTO_EVENT = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "gemini-settled-crypto.json"), "utf8")
)

test("a crypto market shows the threshold, the measured value and the gap", () => {
  const reading = kyle.kyleSettlementReading(CRYPTO_EVENT)
  assert.equal(reading.thresholdText, "64,527.43", "the strike is the threshold")
  assert.equal(reading.measuredText, "64,493.48", "float noise is not shown to an agent")
  assert.equal(reading.difference.direction, "below")
  assert.equal(reading.difference.amount, "33.95")
  assert.equal(reading.index, "GRR-KAIKO_RFR_BTCUSD_60S")
  assert.equal(reading.agency, "Kaiko")
})

test("Kyle states the gap but never invents which side of it wins", () => {
  // The strike here is type "reference"; the contract terms, not the strike
  // type, say which direction resolves Yes.
  const html = kyle.kyleBriefHtml(kyle.kyleBrief(CRYPTO_EVENT, NOW))
  assert.match(html, /64,527\.43/)
  assert.match(html, /64,493\.48/)
  assert.match(html, /set by the contract terms/i)
  assert.doesNotMatch(html, /so it resolved|therefore resolved/i, "no synthesised causal claim")
})

test("the settlement figures reach the ticket text", () => {
  const text = kyle.kyleSummaryText(kyle.kyleBrief(CRYPTO_EVENT, NOW), NOW)
  assert.match(text, /THRESHOLD: 64,527\.43/)
  assert.match(text, /MEASURED: 64,493\.48 \(33\.95 below the threshold\)/)
  assert.match(text, /PRICE SOURCE: GRR-KAIKO_RFR_BTCUSD_60S \(Kaiko\)/)
})

test("a threshold not yet captured says so rather than showing nothing", () => {
  const pending = {
    contracts: [{ label: "Up", strike: { type: "reference", availableAt: "2026-09-10T00:50:00.000Z" } }],
    source: "GRR-KAIKO_RFR_BTCUSD_60S",
  }
  const reading = kyle.kyleSettlementReading(pending)
  assert.equal(reading.threshold, null)
  assert.ok(reading.pendingAt, "the capture time must be surfaced")
  assert.match(kyle.kyleBriefHtml(kyle.kyleBrief(pending, NOW)), /has not been published yet/i)
})

test("a non-price threshold is shown as what it is, not as money", () => {
  // A podium market's strike is a finishing position (top 3), not a price. It
  // is worth showing — "top 3" is the whole rule — but "3.00" reads as dollars,
  // and there is no price index to name on a sports event.
  const reading = kyle.kyleSettlementReading(PODIUM_EVENT)
  assert.equal(reading.thresholdText, "3", "a finishing position has no decimals")
  assert.equal(reading.measuredText, "", "no measured value is published")
  assert.equal(reading.index, "", "sourceDetails.index is a category here, not a price index")
  assert.match(reading.rule, /at or under the line/)
})

test("an event with no threshold and no index has no settlement figures", () => {
  assert.equal(kyle.kyleSettlementReading(REAL_EVENT), null, "the winner market has no strike")
  assert.doesNotMatch(kyle.kyleBriefHtml(kyle.kyleBrief(REAL_EVENT, REAL_NOW)), /How it settled/)
})

test("a losing contract is marked in red, a winning one in green", () => {
  const html = kyle.kyleBriefHtml(kyle.kyleBrief(PODIUM_EVENT, REAL_NOW))
  assert.match(html, /k-tag k-tag-won">WON</)
  assert.match(html, /k-tag k-tag-lost">LOST</)

  const lost = kyle.kyleBrief(PODIUM_EVENT, REAL_NOW, { focusSymbol: "GEMI-F1-ITAGP-POD-20260906-ALB" })
  assert.match(kyle.kyleBriefHtml(lost), /k-focus-lost/)
  const won = kyle.kyleBrief(PODIUM_EVENT, REAL_NOW, { focusSymbol: "GEMI-F1-ITAGP-POD-20260906-ANT" })
  assert.match(kyle.kyleBriefHtml(won), /k-focus-won/)
})

test("the win and loss colours are the ones the page defines for each", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "kyle.html"), "utf8")
  assert.match(css, /\.k-tag-won\s*\{[^}]*background:\s*#0f8a5e/, "won is green")
  assert.match(css, /\.k-tag-lost\s*\{[^}]*background:\s*#c73a2f/, "lost is red")
  assert.match(css, /\.k-focus-won\s*\{[^}]*#0f8a5e/)
  assert.match(css, /\.k-focus-lost\s*\{[^}]*#c73a2f/)
})
