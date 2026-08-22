const test = require("node:test")
const assert = require("node:assert/strict")

const gemini = require("../lib/gemini")

// ── parseTicker ───────────────────────────────────────────────────────────────

test("parseTicker reads the crypto series interval separately from the expiry", () => {
  // "BTC05M" is the 5-minute series, so the 05M must not be swallowed into expiry.
  const t = gemini.parseTicker("GEMI-BTC05M2606011000-UP")
  assert.equal(t.kind, "asset")
  assert.equal(t.asset, "BTC")
  assert.equal(t.interval, "05M")
  assert.equal(t.expiry, "2606011000")
  assert.equal(t.contract, "UP")
})

test("parseTicker handles both joined and dashed expiry spellings", () => {
  const joined = gemini.parseTicker("GEMI-FEDJAN26-DN25")
  assert.equal(joined.asset, "FEDJAN")
  assert.equal(joined.contract, "DN25")

  // Combo legs in the docs use the dashed form.
  const dashed = gemini.parseTicker("GEMI-ETH-EOY26-HI5000")
  assert.equal(dashed.kind, "asset")
  assert.equal(dashed.asset, "ETH")
  assert.equal(dashed.expiry, "EOY26")
  assert.equal(dashed.contract, "HI5000")
})

test("parseTicker splits a sports ticker into league, teams and market type", () => {
  const t = gemini.parseTicker("GEMI-MLB-2606011905-NYY-BOS-ML-NYY")
  assert.equal(t.kind, "sports")
  assert.equal(t.league, "MLB")
  assert.equal(t.away, "NYY")
  assert.equal(t.home, "BOS")
  assert.equal(t.marketType, "ML")
})

test("parseTicker reads a combo ticker's period and leg-set hash", () => {
  const t = gemini.parseTicker("GEMI-CMB-0526-A7F3B2C1D4E5")
  assert.equal(t.kind, "combo")
  assert.equal(t.period, "0526")
  assert.equal(t.hash, "A7F3B2C1D4E5")
})

test("parseTicker refuses to invent structure for unstructured tickers", () => {
  // Politics and custom markets have no ticker format. Reading "PRES2028" as an
  // asset expiring in 2028 would produce confidently wrong UI copy.
  assert.equal(gemini.parseTicker("PRES2028").kind, "other")
  assert.equal(gemini.parseTicker("TPC2026T5").kind, "other")
})

test("parseTicker never throws on absent or malformed input", () => {
  for (const bad of [null, undefined, "", 42, {}, "-", "GEMI-"]) {
    assert.equal(gemini.parseTicker(bad).kind, "other")
  }
})

// ── Prices ────────────────────────────────────────────────────────────────────

test("toNumber parses Gemini's decimal strings and rejects junk", () => {
  assert.equal(gemini.toNumber("0.42"), 0.42)
  assert.equal(gemini.toNumber(" 0.42 "), 0.42)
  assert.equal(gemini.toNumber(0.42), 0.42)
  for (const bad of ["", "abc", "0.4.2", null, undefined, NaN, Infinity, {}]) {
    assert.equal(gemini.toNumber(bad), null, `expected null for ${String(bad)}`)
  }
})

test("complementPrice derives the NO side from YES-space depth", () => {
  // Public order-book depth is normalized in YES space; NO is 1 - yesPrice.
  assert.equal(gemini.complementPrice("0.42"), 0.58)
  assert.equal(gemini.complementPrice("0.01"), 0.99)
  assert.equal(gemini.complementPrice("nope"), null)
})

test("impliedProbability reads price as market-implied probability", () => {
  // The docs' worked example: $0.65 on a $1 contract ≈ 65%.
  assert.equal(gemini.impliedProbability("0.65"), 65)
  assert.equal(gemini.impliedProbability("0.65", 1), 65)
  assert.equal(gemini.impliedProbability("abc"), null)
  // A zero settlement value must not divide by zero.
  assert.equal(gemini.impliedProbability("0.65", 0), null)
})

// ── Combos ────────────────────────────────────────────────────────────────────

test("comboFairValue multiplies leg prices, matching the documented example", () => {
  // Docs: legs at $0.60 and $0.70 have a fair value of $0.42 under independence.
  const fair = gemini.comboFairValue({
    legs: [{ price: "0.60", outcome: "yes" }, { price: "0.70", outcome: "yes" }],
  })
  assert.equal(fair.fairValue, 0.42)
  assert.equal(fair.legCount, 2)
  assert.equal(fair.marketPrice, null)
  assert.equal(fair.edge, null)
})

test("comboFairValue reports edge against the traded price", () => {
  const fair = gemini.comboFairValue({
    price: "0.38",
    legs: [{ price: "0.60", outcome: "yes" }, { price: "0.70", outcome: "yes" }],
  })
  assert.equal(fair.fairValue, 0.42)
  assert.equal(fair.marketPrice, 0.38)
  // Trading below the independence anchor is positive edge.
  assert.equal(fair.edge, 0.04)
})

test("comboFairValue uses the complement for a NO leg", () => {
  // A NO leg contributes 1 - yesPrice: 0.40 * 0.70 = 0.28.
  const fair = gemini.comboFairValue({
    legs: [{ price: "0.60", outcome: "no" }, { price: "0.70", outcome: "yes" }],
  })
  assert.equal(fair.fairValue, 0.28)
})

test("comboFairValue falls back through the leg price fields", () => {
  const fair = gemini.comboFairValue({
    legs: [
      { prices: { lastTradePrice: "0.50" } },
      { prices: { bestAsk: "0.50" } },
    ],
  })
  assert.equal(fair.fairValue, 0.25)
})

test("comboFairValue returns null rather than guessing at bad input", () => {
  // Fewer than two legs is not a combo.
  assert.equal(gemini.comboFairValue({ legs: [{ price: "0.60" }] }), null)
  assert.equal(gemini.comboFairValue({ legs: [] }), null)
  assert.equal(gemini.comboFairValue({}), null)
  assert.equal(gemini.comboFairValue(null), null)
  // An unpriced or zero-priced leg makes the product meaningless.
  assert.equal(gemini.comboFairValue({ legs: [{ price: "0.60" }, {}] }), null)
  assert.equal(gemini.comboFairValue({ legs: [{ price: "0.60" }, { price: "0" }] }), null)
})

// ── Strike ────────────────────────────────────────────────────────────────────

test("describeStrikeType distinguishes strict from inclusive thresholds", () => {
  // over vs over_or_equal decides an exact tie, so it changes who wins.
  assert.equal(gemini.describeStrikeType("over").symbol, ">")
  assert.equal(gemini.describeStrikeType("over_or_equal").symbol, ">=")
  assert.equal(gemini.describeStrikeType("under").symbol, "<")
  assert.equal(gemini.describeStrikeType("under_or_equal").symbol, "<=")
  assert.equal(gemini.describeStrikeType("reference").symbol, null)
  assert.equal(gemini.describeStrikeType("nonsense"), null)
  assert.equal(gemini.describeStrikeType(null), null)
})

// ── Query building and validation ─────────────────────────────────────────────

test("buildQuery omits absent filters instead of sending empty parameters", () => {
  assert.equal(gemini.buildQuery({ status: "active", category: "" }), "?status=active")
  assert.equal(gemini.buildQuery({ a: undefined, b: null, c: "" }), "")
  assert.equal(gemini.buildQuery({ limit: 0 }), "?limit=0")
})

test("clampInt keeps caller-supplied pagination in range", () => {
  assert.equal(gemini.clampInt("500", { min: 1, max: 100, fallback: 50 }), 100)
  assert.equal(gemini.clampInt("-5", { min: 0, max: 100, fallback: 50 }), 0)
  assert.equal(gemini.clampInt("abc", { min: 1, max: 100, fallback: 50 }), 50)
  assert.equal(gemini.clampInt(undefined, { min: 1, max: 100, fallback: 50 }), 50)
  assert.equal(gemini.clampInt("7.9", { min: 1, max: 100, fallback: 50 }), 7)
})

test("isSafeParam accepts real tickers and rejects injection attempts", () => {
  assert.ok(gemini.isSafeParam("GEMI-FEDJAN26-DN25"))
  assert.ok(gemini.isSafeParam("BTC05M2603271950"))
  for (const bad of ["../../etc", "a b", "a?b=c", "a&b", "a/b", "", null]) {
    assert.ok(!gemini.isSafeParam(bad), `expected reject: ${String(bad)}`)
  }
})

test("isSafeUrl only accepts gemini.com pages", () => {
  assert.ok(gemini.isSafeUrl("https://www.gemini.com/predictions/FEDJAN26"))
  for (const bad of [
    "https://evil.com/x",
    "https://gemini.com.evil.com/x",
    "javascript:alert(1)",
    "not a url",
    null,
  ]) {
    assert.ok(!gemini.isSafeUrl(bad), `expected reject: ${String(bad)}`)
  }
})

// ── Request validation (no network) ───────────────────────────────────────────

test("read-only calls reject bad input before making a request", async () => {
  assert.equal((await gemini.getEvent("")).status, 400)
  assert.equal((await gemini.getEvent("bad ticker!")).status, 400)
  assert.equal((await gemini.getEvent("OK", "https://evil.com")).status, 400)
  assert.equal((await gemini.getEventStrike("bad!")).status, 400)
  assert.equal((await gemini.getCombo("bad!")).status, 400)
  assert.equal((await gemini.listEvents({ status: "bad!" })).status, 400)
  assert.equal((await gemini.listEvents({ category: "bad!" })).status, 400)
  assert.equal((await gemini.listEvents({ search: 123 })).status, 400)
})
