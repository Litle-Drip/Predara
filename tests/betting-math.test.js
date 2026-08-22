// The bet calculator, the fee model and the analytics card are the functions
// that hand a user a number they may act on. They had no coverage at all.
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")

function loadUiContext() {
  const context = vm.createContext({
    console, Date, Math, Number, String, URL, Map, Set,
    parseFloat, parseInt, isNaN,
    window: { _simMarket: { amount: 10, pct: 0, platform: "" } },
  })
  ;["utils.js", "components.js", "renderers.js", "adapters.js"].forEach((file) => {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context, { filename: file })
  })
  return context
}

// ── Fee model ─────────────────────────────────────────────────────────────────

test("Kalshi fee follows the published 0.07 * C * P * (1-P) formula", () => {
  const ctx = loadUiContext()
  // Kalshi's own worked example: 100 contracts at 50c costs $1.75.
  assert.equal(ctx.feeFor("kalshi", { contracts: 100, price: 0.5 }).amount, 1.75)
})

test("Kalshi fee is highest at 50c and falls toward the extremes", () => {
  const ctx = loadUiContext()
  const at50 = ctx.feeFor("kalshi", { contracts: 100, price: 0.5 }).amount
  const at90 = ctx.feeFor("kalshi", { contracts: 100, price: 0.9 }).amount
  const at10 = ctx.feeFor("kalshi", { contracts: 100, price: 0.1 }).amount
  assert.ok(at50 > at90, "fee should peak in the middle of the book")
  assert.ok(at50 > at10)
  // The old model charged 2% of profit, which at 50c is $2.00 on a $100 stake
  // and would have been LOWER than reality at the midpoint after rounding.
  assert.notEqual(at50, 2)
})

test("Kalshi fee rounds up to the next cent", () => {
  const ctx = loadUiContext()
  // 1 contract at 50c is 1.75c of fee, which Kalshi bills as 2c.
  assert.equal(ctx.feeFor("kalshi", { contracts: 1, price: 0.5 }).amount, 0.02)
})

test("venues without a published fee formula report unknown rather than guessing", () => {
  const ctx = loadUiContext()
  for (const platform of ["gemini", "coinbase"]) {
    const fee = ctx.feeFor(platform, { contracts: 100, price: 0.5 })
    assert.equal(fee.known, false, `${platform} must not invent a fee rate`)
    assert.equal(fee.amount, 0)
    assert.ok(fee.note.length > 0, "an unknown fee has to explain itself")
  }
})

// ── Execution price ───────────────────────────────────────────────────────────

test("YES is priced at the ask, not the midpoint", () => {
  const ctx = loadUiContext()
  const r = ctx.executionPrice({ pct: 60, bid: 0.58, ask: 0.62 }, "yes")
  assert.equal(r.price, 0.62)
  assert.equal(r.isEstimate, false)
})

test("NO is priced at 1 - bid, not 1 - midpoint", () => {
  const ctx = loadUiContext()
  const r = ctx.executionPrice({ pct: 60, bid: 0.58, ask: 0.62 }, "no")
  // 1 - 0.58 = 0.42. Pricing off the midpoint would have said 0.40 and
  // understated the cost of the NO side by half the spread.
  assert.ok(Math.abs(r.price - 0.42) < 1e-9, `expected 0.42, got ${r.price}`)
  assert.notEqual(Math.round(r.price * 100), 40)
})

test("a market with no published book falls back to the midpoint and says so", () => {
  const ctx = loadUiContext()
  const r = ctx.executionPrice({ pct: 60 }, "yes")
  assert.equal(r.price, 0.6)
  assert.equal(r.isEstimate, true)
})

// ── Bet calculator ────────────────────────────────────────────────────────────

test("the bet calculator sizes the position off the ask, not the midpoint", () => {
  const ctx = loadUiContext()
  const r = ctx.computeBetResult(100, { pct: 60, bid: 0.58, ask: 0.62 }, "kalshi", "yes")
  // $100 / $0.62 = 161.29 contracts. Off the midpoint it would have claimed
  // 166.67, overstating the payout by more than five dollars.
  assert.ok(Math.abs(r.count - 161.29) < 0.01, `expected ~161.29 contracts, got ${r.count}`)
  assert.ok(r.winPayout < 162 && r.winPayout > 161)
})

test("the entry fee is subtracted from a win AND added to a loss", () => {
  const ctx = loadUiContext()
  const r = ctx.computeBetResult(100, { pct: 50, bid: 0.49, ask: 0.5 }, "kalshi", "yes")
  assert.equal(r.fee.known, true)
  assert.ok(r.fee.amount > 0)
  const html = ctx.betSimResultHtml(100, { pct: 50, bid: 0.49, ask: 0.5 }, "kalshi", "yes")
  // The loss line has to show more than the stake, because the fee was charged
  // when the trade filled regardless of the outcome.
  const lossMatch = html.match(/you are out <strong>\$([0-9.]+)<\/strong>/)
  assert.ok(lossMatch, "loss line should be rendered")
  assert.ok(parseFloat(lossMatch[1]) > 100, `loss should exceed the stake, got ${lossMatch[1]}`)
})

test("an estimated price is flagged in the calculator output", () => {
  const ctx = loadUiContext()
  const withBook = ctx.betSimResultHtml(100, { pct: 60, bid: 0.58, ask: 0.62 }, "kalshi", "yes")
  const noBook = ctx.betSimResultHtml(100, { pct: 60 }, "kalshi", "yes")
  assert.equal(withBook.includes("bet-sim-est"), false)
  assert.ok(noBook.includes("bet-sim-est"), "a midpoint fallback must be marked estimated")
})

test("a venue with no fee model says so instead of showing a fake net", () => {
  const ctx = loadUiContext()
  const html = ctx.betSimResultHtml(100, { pct: 60, bid: 0.58, ask: 0.62 }, "gemini", "yes")
  assert.ok(html.includes("not included"), "unmodeled fees must be disclosed")
})

// ── Analytics ─────────────────────────────────────────────────────────────────

test("analytics rows no longer compute EV or Kelly from the market's own price", () => {
  const ctx = loadUiContext()
  const row = ctx.calcAnalyticsRow("YES", 0.6, 0.62, 0.58, "#22c55e")
  // Measuring EV against the price you pay makes it minus half the spread on
  // every market, and Kelly zero. Both now require the user's estimate.
  assert.equal(row.ev, undefined, "EV must not be derived from the market midpoint")
  assert.equal(row.kelly, undefined, "Kelly must not be derived from the market midpoint")
  assert.equal(row.breakEven, 62, "break-even is a property of the market and stays")
  assert.ok(row.spread > 0, "spread is objective and stays")
  assert.equal(row.ask, 0.62, "the ask is carried so the edge slot can use it")
})

test("the analytics card renders an edge slot rather than a filled-in EV", () => {
  const ctx = loadUiContext()
  const html = ctx.analyticsCard([ctx.calcAnalyticsRow("YES", 0.6, 0.62, 0.58, "#22c55e")], null, null)
  assert.ok(html.includes("analytics-edge-slot"), "EV/Kelly are filled from the user's estimate")
  assert.ok(html.includes("BREAK-EVEN"))
})

// ── Kelly ─────────────────────────────────────────────────────────────────────

test("Kelly is positive only when your estimate beats the price you pay", () => {
  const ctx = loadUiContext()
  assert.ok(ctx.kellyFraction(0.6, 0.5) > 0, "60% belief at a 50c price is an edge")
  assert.ok(ctx.kellyFraction(0.5, 0.5) <= 0, "no edge at a fair price")
  assert.ok(ctx.kellyFraction(0.4, 0.5) < 0, "betting into a worse price is negative")
})

test("fees shrink the recommended Kelly stake", () => {
  const ctx = loadUiContext()
  const gross = ctx.kellyFraction(0.6, 0.5)
  const net = ctx.kellyFractionAfterFees(0.6, 0.5, "kalshi")
  assert.ok(net.fraction < gross, "an entry fee must reduce the recommended stake")
  assert.ok(net.effectivePrice > 0.5, "the fee raises the effective cost per share")
  assert.equal(net.feeKnown, true)
})

test("Kelly on an unmodeled venue is reported as before-fees, not as net", () => {
  const ctx = loadUiContext()
  const net = ctx.kellyFractionAfterFees(0.6, 0.5, "gemini")
  assert.equal(net.feeKnown, false)
  assert.equal(net.effectivePrice, 0.5)
})
