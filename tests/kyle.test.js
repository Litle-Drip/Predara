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
  assert.match(kyle.kyleHeadline(open, NOW), /Still trading/)
  assert.match(kyle.kyleHeadline(open, NOW), /nothing has paid out/)

  const settled = kyle.kyleBrief(openEvent({
    status: "settled",
    resolvedAt: new Date(NOW - HOUR).toISOString(),
    contracts: [{ label: "Yes", resolutionSide: "yes" }],
  }), NOW)
  assert.match(kyle.kyleHeadline(settled, NOW), /Finished/)
  assert.match(kyle.kyleHeadline(settled, NOW), /paid \$1/)

  // The ticket summary opens with the same sentence the agent just read.
  assert.ok(kyle.kyleSummaryText(settled).startsWith(kyle.kyleHeadline(settled)))
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
