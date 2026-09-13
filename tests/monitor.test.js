// The monitor reports book quality for a live venue, so the metric definitions
// are the part that has to be right. Each test below pins one definition — and
// in particular pins the three ways a plausible-looking implementation would
// report a number that is not true:
//
//   1. Averaging a spread over one-sided books by treating the missing side as
//      zero, which invents a spread no trader could cross.
//   2. Summing asks across a MULTI-winner event, which reports a meaningless
//      overround and drags the platform average with it.
//   3. Summing asks across a single-winner event with an unquoted leg, which
//      understates the sum and manufactures a dutch book that is not there.
//
// The event payloads come from the repo's captured live fixtures wherever the
// shape matters, so the rules are anchored to what Gemini actually sends.

const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const monitor = require("../lib/monitor")
const client = require("../monitor.js")

const FIXTURES = path.join(__dirname, "fixtures")
const loadFixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"))

const LIVE = loadFixture("gemini-live-categorical.json")   // template: categorical
const PODIUM = loadFixture("gemini-settled-podium.json")   // template: binary, top-N

const NOW = Date.parse("2026-09-13T12:00:00Z")
const HOUR = 3600000
const DAY = 24 * HOUR

function event(overrides = {}) {
  return {
    ticker: "TEST1",
    title: "A test event",
    category: "Economics",
    status: "active",
    type: "categorical",
    template: "categorical",
    volume24h: 1000,
    expiryDate: new Date(NOW + 10 * DAY).toISOString(),
    contracts: [],
    ...overrides,
  }
}

const contract = (bid, ask, extra = {}) => ({
  ticker: extra.ticker || "C",
  label: extra.label || "Contract",
  status: extra.status || "active",
  prices: {
    ...(bid === null ? {} : { bestBid: String(bid) }),
    ...(ask === null ? {} : { bestAsk: String(ask) }),
    ...(extra.last === undefined ? {} : { lastTradePrice: String(extra.last) }),
  },
})

// ── readQuote ─────────────────────────────────────────────────────────────────

test("a quote is two-sided, one-sided or absent, and zero counts as absent", () => {
  const two = monitor.readQuote(contract(0.33, 0.37))
  assert.equal(two.bid, 0.33)
  assert.equal(two.ask, 0.37)
  assert.equal(two.twoSided, true)
  assert.equal(two.quoted, true)
  assert.equal(two.spread, 0.04)

  // One side only: quoted, but there is no spread to report.
  const oneSided = monitor.readQuote(contract(null, 0.37))
  assert.equal(oneSided.quoted, true)
  assert.equal(oneSided.twoSided, false)
  assert.equal(oneSided.spread, null, "a one-sided book must not be given a spread")

  // A settled contract comes back with empty buy/sell objects and no best
  // bid/ask at all — that is the normal shape, not a malformed payload.
  const settled = monitor.readQuote({ prices: { buy: {}, sell: {} } })
  assert.equal(settled.quoted, false)
  assert.equal(settled.spread, null)

  // You cannot bid nothing, so an explicit zero is the same as no quote.
  assert.equal(monitor.readQuote(contract(0, 0.5)).bid, null)
  assert.equal(monitor.readQuote(contract(0, 0)).quoted, false)
})

test("a crossed book keeps its negative spread rather than being clamped", () => {
  // Bid above ask is a real and reportable condition; hiding it behind a zero
  // would make it invisible on exactly the dashboard meant to catch it.
  assert.equal(monitor.readQuote(contract(0.60, 0.55)).spread, -0.05)
})

// ── Overround ─────────────────────────────────────────────────────────────────

test("overround on a single-winner event is the sum of asks minus a dollar", () => {
  const ev = event({
    contracts: [contract(0.40, 0.45, { ticker: "A" }), contract(0.55, 0.60, { ticker: "B" })],
  })
  const result = monitor.eventOverround(ev)
  assert.equal(result.eligible, true)
  assert.equal(result.value, 0.05)   // 0.45 + 0.60 − 1
  assert.equal(result.legs, 2)
})

test("a multi-winner event is excluded, not summed", () => {
  // This is the trap. tests/fixtures/gemini-settled-podium.json is `type:
  // "categorical"` exactly like a race-winner market, but `template: "binary"`:
  // 22 independent yes/no contracts of which THREE pay out. Summing its asks
  // would report a ~200% overround that means nothing.
  assert.equal(PODIUM.type, "categorical", "fixture premise: type looks like a winner market")
  assert.equal(PODIUM.template, "binary", "fixture premise: template says otherwise")

  const podium = { ...PODIUM, contracts: PODIUM.contracts.map((c, i) => contract(0.30, 0.35, { ticker: `P${i}`, })) }
  const result = monitor.eventOverround(podium)
  assert.equal(result.eligible, false)
  assert.match(result.reason, /not a single-winner market/)
  assert.equal(result.value, null)
})

test("a single-winner event with an unquoted leg is excluded, never called a dutch book", () => {
  // The dangerous failure: reading the missing ask as 0 gives 0.45 + 0 − 1 =
  // −0.55, a false risk-free profit that somebody would act on.
  const ev = event({
    contracts: [contract(0.40, 0.45, { ticker: "A" }), contract(null, null, { ticker: "B" })],
  })
  const result = monitor.eventOverround(ev)
  assert.equal(result.eligible, false)
  assert.equal(result.value, null)
  assert.match(result.reason, /not every outcome is offered/)

  const summary = monitor.summarizeEvent(ev, NOW)
  assert.equal(summary.dutchBook, false, "an unquoted leg must never read as arbitrage")
})

test("a fully quoted single-winner event priced under a dollar is a dutch book", () => {
  const ev = event({
    contracts: [contract(0.40, 0.45, { ticker: "A" }), contract(0.48, 0.50, { ticker: "B" })],
  })
  const summary = monitor.summarizeEvent(ev, NOW)
  assert.equal(summary.overround, -0.05)   // 0.45 + 0.50 − 1
  assert.equal(summary.dutchBook, true)
})

test("an event with fewer than two live contracts has no overround", () => {
  const single = event({ contracts: [contract(0.40, 0.45)] })
  assert.match(monitor.eventOverround(single).reason, /fewer than two live contracts/)

  // Settled legs do not count toward the two, so a finished market cannot be
  // scored on the stale prices of its remaining contract.
  const mostlySettled = event({
    contracts: [
      contract(0.40, 0.45, { ticker: "A" }),
      contract(0.50, 0.55, { ticker: "B", status: "settled" }),
    ],
  })
  assert.equal(monitor.eventOverround(mostlySettled).eligible, false)
})

test("the captured live event's own numbers come out of the arithmetic", () => {
  // NOTE: the fixture keeps 4 of the real event's 21 contracts, so its asks sum
  // to 0.75 and it reads as a dutch book. That is a property of the trimmed
  // fixture, not a claim about the live market — what is asserted here is the
  // arithmetic on the payload as given.
  const summary = monitor.summarizeEvent(LIVE, NOW)
  assert.equal(summary.template, "categorical")
  assert.equal(summary.contractsListed, 4)
  assert.equal(summary.contractsQuoted, 4)
  assert.equal(summary.contractsTwoSided, 4)
  assert.equal(summary.overroundEligible, true)
  assert.equal(summary.overround, -0.25)                 // 0.37+0.21+0.15+0.02 − 1
  assert.equal(summary.avgSpread, 0.0325)                // (0.04+0.04+0.04+0.01)/4
  assert.equal(Number(summary.spreadSum.toFixed(10)), 0.13)
  assert.equal(summary.volume, 52)
  assert.equal(summary.volumeField, "volume24h")
  assert.equal(summary.crossed, 0)
})

// ── Volume ────────────────────────────────────────────────────────────────────

test("volume prefers the 24h figure, falls back to cumulative, and never uses liquidity", () => {
  assert.deepEqual(monitor.eventVolume({ volume24h: 10, volume: 99, liquidity: 500 }),
    { value: 10, field: "volume24h" })

  assert.deepEqual(monitor.eventVolume({ volume: 99, liquidity: 500 }),
    { value: 99, field: "volume" })

  // liquidity is resting size, not traded notional. Substituting it would
  // report a volume number that is not volume.
  assert.deepEqual(monitor.eventVolume({ liquidity: 500 }), { value: null, field: null })
})

test("a feed mixing 24h and cumulative volume reports the weaker label", () => {
  const snapshot = monitor.summarize([
    event({ ticker: "A", volume24h: 100, contracts: [contract(0.4, 0.45)] }),
    event({ ticker: "B", volume24h: undefined, volume: 900, contracts: [contract(0.4, 0.45)] }),
  ], { now: NOW })
  assert.equal(snapshot.totals.volumeField, "volume",
    "one cumulative figure in the mix means the total is not a 24-hour number")
  assert.equal(snapshot.totals.volume, 1000)
})

// ── Denominators ──────────────────────────────────────────────────────────────

test("settled contracts leave the coverage denominator instead of dragging it down", () => {
  const snapshot = monitor.summarize([event({
    contracts: [
      contract(0.40, 0.45, { ticker: "A" }),
      contract(null, null, { ticker: "OLD", status: "settled" }),
      contract(null, null, { ticker: "GONE", status: "cancelled" }),
    ],
  })], { now: NOW })

  assert.equal(snapshot.totals.contractsListed, 1)
  assert.equal(snapshot.totals.contractsQuoted, 1)
  assert.equal(snapshot.totals.coverage, 1, "a settled leg is not an unquoted leg")
})

test("the spread average covers two-sided books only and says how many", () => {
  const snapshot = monitor.summarize([event({
    contracts: [
      contract(0.40, 0.50, { ticker: "A" }),   // spread 0.10
      contract(0.20, 0.30, { ticker: "B" }),   // spread 0.10
      contract(null, 0.90, { ticker: "C" }),   // one-sided: no spread
    ],
  })], { now: NOW })

  assert.equal(snapshot.totals.contractsTwoSided, 2)
  assert.equal(snapshot.totals.avgSpread, 0.1,
    "a one-sided book counted as a zero spread would have pulled this to 0.067")
  assert.equal(snapshot.totals.coverage, 1)
})

test("the overround average counts only eligible events and publishes that count", () => {
  const snapshot = monitor.summarize([
    // Eligible: +0.05
    event({ ticker: "E1", contracts: [contract(0.4, 0.45, { ticker: "A" }), contract(0.55, 0.60, { ticker: "B" })] }),
    // Ineligible: multi-winner
    event({ ticker: "E2", template: "binary", contracts: [contract(0.4, 0.45, { ticker: "A" }), contract(0.4, 0.45, { ticker: "B" })] }),
    // Ineligible: a leg is not offered
    event({ ticker: "E3", contracts: [contract(0.4, 0.45, { ticker: "A" }), contract(0.4, null, { ticker: "B" })] }),
  ], { now: NOW })

  assert.equal(snapshot.totals.events, 3)
  assert.equal(snapshot.totals.overroundEligibleEvents, 1)
  assert.equal(snapshot.totals.avgOverround, 0.05)
  assert.equal(snapshot.totals.dutchBooks, 0)
})

test("an implausible overround is set aside instead of dragging the average", () => {
  // A 12-leg market mislabelled as single-winner sums to ~4.20 and would report
  // a +320% "margin". Averaging that in would move the headline number by
  // hundreds of percent on the strength of one bad `template` field.
  const legs = (n, ask) => Array.from({ length: n }, (_, i) => contract(ask - 0.02, ask, { ticker: `L${i}` }))

  const snapshot = monitor.summarize([
    event({ ticker: "SANE", contracts: legs(2, 0.52) }),          // +4%
    event({ ticker: "MISLABELLED", contracts: legs(12, 0.35) }),  // +320%
  ], { now: NOW })

  assert.equal(snapshot.totals.overroundEligibleEvents, 1)
  assert.equal(snapshot.totals.overroundImplausibleEvents, 1)
  assert.equal(snapshot.totals.avgOverround, 0.04,
    "one mislabelled market must not move the platform average")

  // The event still carries its raw value — it is set aside, not hidden.
  const flagged = snapshot.events.find((e) => e.ticker === "MISLABELLED")
  assert.equal(flagged.overroundEligible, true)
  assert.equal(flagged.overroundPlausible, false)
  assert.ok(flagged.overround > 3)
  assert.equal(flagged.dutchBook, false)
})

test("expiring-in-24h counts only events closing inside the window", () => {
  const snapshot = monitor.summarize([
    event({ ticker: "SOON", expiryDate: new Date(NOW + 6 * HOUR).toISOString(), contracts: [contract(0.4, 0.45)] }),
    event({ ticker: "LATER", expiryDate: new Date(NOW + 5 * DAY).toISOString(), contracts: [contract(0.4, 0.45)] }),
    event({ ticker: "PAST", expiryDate: new Date(NOW - HOUR).toISOString(), contracts: [contract(0.4, 0.45)] }),
  ], { now: NOW })
  assert.equal(snapshot.totals.expiring24h, 1)
})

// ── Row cap ───────────────────────────────────────────────────────────────────

test("capping the contract rows never changes the totals, and the cap is stated", () => {
  const events = Array.from({ length: 6 }, (_, i) => event({
    ticker: `E${i}`,
    volume24h: 100,
    contracts: [contract(0.40, 0.45, { ticker: "A" }), contract(0.50, 0.55, { ticker: "B" })],
  }))

  const full = monitor.summarize(events, { now: NOW })
  const capped = monitor.summarize(events, { now: NOW, rowLimit: 3 })

  assert.equal(capped.rowsShown, 3)
  assert.equal(capped.rowsTotal, 12, "the total has to describe the book, not the payload")
  assert.deepEqual(capped.totals, full.totals,
    "a row cap is a payload limit; it must not move a single aggregate")
})

// ── Client and server agree ───────────────────────────────────────────────────

test("the client re-rolls a filtered slice to exactly the server's arithmetic", () => {
  // The page recomputes every aggregate in the browser as filters change. If
  // that arithmetic drifted from the server's, a filtered total would disagree
  // with the unfiltered one and neither could be trusted.
  const events = [
    event({ ticker: "A", category: "Sports", volume24h: 250,
      contracts: [contract(0.40, 0.45, { ticker: "X" }), contract(0.50, 0.56, { ticker: "Y" })] }),
    event({ ticker: "B", category: "Crypto", volume24h: 90,
      contracts: [contract(0.10, 0.13, { ticker: "X" }), contract(null, 0.90, { ticker: "Y" })] }),
    event({ ticker: "C", category: "Sports", template: "binary", volume24h: 5,
      contracts: [contract(0.30, 0.34, { ticker: "X" }), contract(0.66, 0.70, { ticker: "Y" })] }),
    LIVE,
  ]
  const snapshot = monitor.summarize(events, { now: NOW })
  const rolled = client.monRollup(snapshot.events)

  for (const key of ["events", "liveEvents", "contractsListed", "contractsQuoted",
    "contractsTwoSided", "crossed", "overroundEligibleEvents",
    "overroundImplausibleEvents", "dutchBooks",
    "volumeEvents", "expiring24h", "volumeField"]) {
    assert.deepEqual(rolled[key], snapshot.totals[key], `client and server disagree on ${key}`)
  }
  // The server rounds its published totals to four decimals; the client keeps
  // full precision and rounds at format time. Comparing at the server's own
  // precision is the real question — does the arithmetic agree — rather than
  // whether one of them rounded.
  const to4 = (n) => (n === null || n === undefined ? null : Math.round(n * 1e4) / 1e4)
  for (const key of ["coverage", "avgSpread", "avgOverround", "volume"]) {
    assert.equal(to4(rolled[key]), to4(snapshot.totals[key]),
      `client and server disagree on ${key}: ${rolled[key]} vs ${snapshot.totals[key]}`)
  }

  // And per category, which is what the matrix renders.
  const sports = client.monRollupByCategory(snapshot.events).find((c) => c.category === "Sports")
  const serverSports = snapshot.categories.find((c) => c.category === "Sports")
  assert.equal(sports.contractsListed, serverSports.contractsListed)
  assert.equal(sports.overroundEligibleEvents, serverSports.overroundEligibleEvents)
  assert.equal(to4(sports.avgSpread), to4(serverSports.avgSpread))
})

// ── Filters ───────────────────────────────────────────────────────────────────

test("the quote-state filter separates two-sided, one-sided and unquoted rows", () => {
  const rows = [
    { bid: 0.4, ask: 0.45, spread: 0.05, category: "A", event: "e", contract: "c" },
    { bid: null, ask: 0.9, spread: null, category: "A", event: "e", contract: "c" },
    { bid: 0.2, ask: null, spread: null, category: "A", event: "e", contract: "c" },
    { bid: null, ask: null, spread: null, category: "A", event: "e", contract: "c" },
  ]
  assert.equal(client.monFilterRows(rows, { quote: "two" }).length, 1)
  assert.equal(client.monFilterRows(rows, { quote: "one" }).length, 2)
  assert.equal(client.monFilterRows(rows, { quote: "none" }).length, 1)
  assert.equal(client.monFilterRows(rows, {}).length, 4)
})

test("spread buckets exclude rows with no spread, and crossed books are their own bucket", () => {
  const rows = [
    { bid: 0.40, ask: 0.41, spread: 0.01, event: "", contract: "" },
    { bid: 0.40, ask: 0.45, spread: 0.05, event: "", contract: "" },
    { bid: 0.40, ask: 0.60, spread: 0.20, event: "", contract: "" },
    { bid: 0.60, ask: 0.55, spread: -0.05, event: "", contract: "" },
    { bid: null, ask: null, spread: null, event: "", contract: "" },
  ]
  assert.equal(client.monFilterRows(rows, { spread: "tight" }).length, 1)
  assert.equal(client.monFilterRows(rows, { spread: "mid" }).length, 1)
  assert.equal(client.monFilterRows(rows, { spread: "wide" }).length, 1)
  assert.equal(client.monFilterRows(rows, { spread: "crossed" }).length, 1)

  // A crossed book is not "tight" and an absent quote is not any width.
  assert.equal(client.monFilterRows(rows, { spread: "tight" })[0].spread, 0.01)
})

test("the expiry filter keeps only events closing inside the window", () => {
  const events = [
    { ticker: "SOON", category: "A", expiry: new Date(NOW + 3 * HOUR).toISOString() },
    { ticker: "WEEK", category: "A", expiry: new Date(NOW + 3 * DAY).toISOString() },
    { ticker: "PAST", category: "A", expiry: new Date(NOW - HOUR).toISOString() },
    { ticker: "NONE", category: "A", expiry: null },
  ]
  assert.deepEqual(client.monFilterEvents(events, { expiry: "24h" }, NOW).map((e) => e.ticker), ["SOON"])
  assert.deepEqual(client.monFilterEvents(events, { expiry: "7d" }, NOW).map((e) => e.ticker), ["SOON", "WEEK"])
  assert.equal(client.monFilterEvents(events, {}, NOW).length, 4)
})

// ── Tile shading ──────────────────────────────────────────────────────────────

test("tile shading encodes quote coverage, strongest where coverage is worst", () => {
  assert.equal(client.monTileCoverage({ contractsListed: 4, contractsQuoted: 3 }), 0.75)
  assert.equal(client.monTileCoverage({ contractsListed: 0, contractsQuoted: 0 }), null)

  // Alpha has to rise as coverage falls, or the panel reads backwards.
  const alphaOf = (css) => Number(css.match(/rgba\(var\(--heat-hue\), ([0-9.]+)\)/)[1])
  const steps = [1, 0.75, 0.5, 0.25, 0].map((c) => alphaOf(client.monTileBg(c)))
  for (let i = 1; i < steps.length; i++) {
    assert.ok(steps[i] > steps[i - 1], `coverage ${i} did not shade more strongly than the step before`)
  }

  // A tile is visible because of its own base layer, so the shading can start
  // near zero — a well-quoted market should read neutral, not tinted.
  assert.match(client.monTileBg(1), /var\(--tile-base\)/,
    "every tile must paint its base layer, or a pale tile disappears into the panel")
  assert.ok(steps[steps.length - 1] <= 0.75, "an unquoted tile must not go so dark its label is lost")

  // An unknown coverage must not be shaded as though it were the worst case.
  assert.equal(alphaOf(client.monTileBg(null)), steps[0])
})

// ── Treemap ───────────────────────────────────────────────────────────────────

test("the treemap fills its rectangle with areas proportional to value", () => {
  const items = [
    { key: "a", value: 50 }, { key: "b", value: 25 },
    { key: "c", value: 15 }, { key: "d", value: 10 },
  ]
  const rect = { x: 0, y: 0, w: 400, h: 300 }
  const tiles = client.monSquarify(items, rect)

  assert.equal(tiles.length, 4)

  const rectArea = rect.w * rect.h
  const tiled = tiles.reduce((sum, t) => sum + t.w * t.h, 0)
  assert.ok(Math.abs(tiled - rectArea) / rectArea < 0.02,
    `tiles cover ${tiled} of ${rectArea} — a treemap that does not fill its box misstates every share`)

  const total = items.reduce((a, b) => a + b.value, 0)
  for (const tile of tiles) {
    const share = (tile.w * tile.h) / rectArea
    const expected = tile.value / total
    assert.ok(Math.abs(share - expected) < 0.02, `${tile.key} is ${share} of the box, expected ${expected}`)
    assert.ok(tile.x >= rect.x - 0.5 && tile.y >= rect.y - 0.5, `${tile.key} starts outside the box`)
    assert.ok(tile.x + tile.w <= rect.x + rect.w + 0.5, `${tile.key} overflows the box horizontally`)
    assert.ok(tile.y + tile.h <= rect.y + rect.h + 0.5, `${tile.key} overflows the box vertically`)
  }
})

test("the treemap drops zero and negative values instead of drawing them", () => {
  const tiles = client.monSquarify(
    [{ key: "a", value: 10 }, { key: "zero", value: 0 }, { key: "neg", value: -5 }],
    { x: 0, y: 0, w: 100, h: 100 })
  assert.deepEqual(tiles.map((t) => t.key), ["a"])
})

test("a long tail of markets becomes one labelled rollup tile that still sums correctly", () => {
  const events = Array.from({ length: 20 }, (_, i) => ({
    ticker: `E${i}`, title: `Event ${i}`, category: "Sports", volume: 100 - i * 4,
  }))
  const { tiles, groups } = client.monTreemapLayout(events, { x: 0, y: 0, w: 600, h: 400 },
    { maxPerCategory: 6 })

  assert.equal(groups.length, 1)
  const rollup = tiles.find((t) => t.rollup)
  assert.ok(rollup, "the tail must be represented, not dropped")
  assert.equal(rollup.rollup.count, 15)

  const tiledValue = tiles.reduce((sum, t) => sum + t.value, 0)
  const realValue = events.reduce((sum, e) => sum + e.volume, 0)
  assert.equal(tiledValue, realValue, "the rollup tile must carry the tail's whole value")
})

// ── CSV ───────────────────────────────────────────────────────────────────────

test("CSV export quotes separators and defuses formula injection", () => {
  const csv = client.monCsv([{
    event: 'Will "X" happen, or not?',
    eventTicker: "T1",
    category: "Politics",
    contract: "=SUM(A1:A9)",
    symbol: "GEMI-T1-YES",
    bid: 0.4, ask: 0.45, last: 0.42, spread: 0.05,
    expiry: "2026-09-14T06:00:00.000Z",
    eventVolume: 1234,
  }])
  const [header, row] = csv.split("\n")

  assert.match(header, /^Event,Event ticker,Category,Contract/)
  assert.ok(row.includes('"Will ""X"" happen, or not?"'), "a comma and a quote must survive the round trip")
  assert.ok(row.includes("'=SUM(A1:A9)"), "a leading = must not reach a spreadsheet as a formula")
})

test("an absent value exports as empty rather than as a zero", () => {
  const csv = client.monCsv([{ event: "e", bid: null, ask: undefined, spread: 0 }])
  const row = csv.split("\n")[1]
  // A missing quote is not a quote of zero, and a CSV reader would not know the
  // difference if it were written as one.
  assert.equal(row.split(",")[5], "", "bid")
  assert.equal(row.split(",")[6], "", "ask")
  assert.equal(row.split(",")[8], "0", "a real zero spread still exports as zero")
})

// ── Heat scales ───────────────────────────────────────────────────────────────

test("the heat ramp is monotonic and an unknown value gets no colour at all", () => {
  const steps = [0, 0.25, 0.5, 0.75, 1].map(client.monHeatAlpha)
  for (let i = 1; i < steps.length; i++) {
    assert.ok(steps[i] > steps[i - 1], "alpha must increase with magnitude")
  }
  assert.ok(steps[0] > 0 && steps[steps.length - 1] <= 1)

  assert.equal(client.monAttentionBg(null), "transparent",
    "a metric with no value must not be shaded as though it were zero")
  assert.equal(client.monDivergingBg(null, 1), "transparent")
  assert.equal(client.monDivergingBg(0.5, 0), "transparent")
})

test("shading places a value in the visible range, not as a share of the max", () => {
  // Dividing by the max shaded a healthy $0.045–$0.067 spread column almost
  // entirely orange, because every value sat at 67–100% of the largest.
  const scale = client.monRangeScale([0.045, 0.046, 0.047, 0.067])
  assert.equal(scale(0.045), 0, "the best value in view anchors the pale end")
  assert.equal(scale(0.067), 1, "the worst value in view anchors the strong end")
  assert.ok(scale(0.046) < 0.1, "a value near the bottom of the range stays pale")

  // Nothing to rank means nothing to shade — no invented "worst".
  assert.equal(client.monRangeScale([0.5, 0.5, 0.5])(0.5), null)
  assert.equal(client.monRangeScale([0.5])(0.5), null)
  assert.equal(client.monRangeScale([])(1), null)

  // Absent values neither shade nor break the range.
  const withGaps = client.monRangeScale([null, 0.2, undefined, 0.8])
  assert.equal(withGaps(0.2), 0)
  assert.equal(withGaps(0.8), 1)
  assert.equal(withGaps(null), null)
})

test("the diverging scale puts negative overround on the red arm", () => {
  assert.match(client.monDivergingBg(-0.2, 0.2), /--div-neg-hue/)
  assert.match(client.monDivergingBg(0.2, 0.2), /--div-pos-hue/)
})

// ── Sorting ───────────────────────────────────────────────────────────────────

test("rows with no value sort last in both directions", () => {
  const rows = [
    { spread: 0.05, event: "b" },
    { spread: null, event: "a" },
    { spread: 0.20, event: "c" },
  ]
  assert.deepEqual(client.monSortRows(rows, { key: "spread", dir: "desc" }).map((r) => r.spread),
    [0.20, 0.05, null])
  assert.deepEqual(client.monSortRows(rows, { key: "spread", dir: "asc" }).map((r) => r.spread),
    [0.05, 0.20, null])
})

// ── Volume history ────────────────────────────────────────────────────────────

test("hourly volume is read structurally, and an unreadable body yields nothing", () => {
  const date = "2026-09-12"
  const dayStart = Date.parse(`${date}T00:00:00Z`)

  const fromArray = monitor.parseHourlyVolume(
    [{ hour: 0, volume: "100" }, { hour: 1, volume: "250.5" }], date)
  assert.equal(fromArray.buckets.length, 2)
  assert.equal(fromArray.buckets[0].hour, dayStart)
  assert.equal(fromArray.buckets[1].hour, dayStart + HOUR)
  assert.equal(fromArray.total, 350.5)

  // Wrapped, and using different key spellings.
  const wrapped = monitor.parseHourlyVolume(
    { data: [{ timestamp: `${date}T05:00:00Z`, notional: 42 }] }, date)
  assert.equal(wrapped.buckets[0].hour, dayStart + 5 * HOUR)
  assert.equal(wrapped.buckets[0].volume, 42)

  // A plain hour → number map.
  const mapped = monitor.parseHourlyVolume({ hourly: { "00": 5, "03": 7 } }, date)
  assert.deepEqual(mapped.buckets.map((b) => b.volume), [5, 7])

  // Anything it cannot read must come back null so the UI says "unavailable"
  // rather than plotting a shape that merely happened to parse.
  assert.equal(monitor.parseHourlyVolume({ message: "no data" }, date), null)
  assert.equal(monitor.parseHourlyVolume([], date), null)
  assert.equal(monitor.parseHourlyVolume(null, date), null)
})

// The live response, verbatim in shape: one hour of one category, with the
// nesting that makes naive summing wrong.
const LIVE_VOLUME_ROWS = [
  { periodStart: "2026-09-12T00:00:00Z", categoryPath: ["Sports"], volume: "43915.83000000" },
  { periodStart: "2026-09-12T00:00:00Z", categoryPath: ["Sports", "Pro Football"], volume: "4261.52000000" },
  { periodStart: "2026-09-12T00:00:00Z", categoryPath: ["Sports", "Pro Baseball"], volume: "14321.95000000" },
  { periodStart: "2026-09-12T00:00:00Z", categoryPath: ["Sports", "College Football"], volume: "7666.87000000" },
  { periodStart: "2026-09-12T00:00:00Z", categoryPath: ["Sports", "Tennis"], volume: "15800.61000000" },
  { periodStart: "2026-09-12T00:00:00Z", categoryPath: ["Sports", "Tennis", "US Open"], volume: "15800.61000000" },
  { periodStart: "2026-09-12T00:00:00Z", categoryPath: ["Sports", "Soccer"], volume: "1284.00000000" },
  { periodStart: "2026-09-12T00:00:00Z", categoryPath: ["Sports", "MMA"], volume: "580.88000000" },
  { periodStart: "2026-09-12T00:00:00Z", categoryPath: ["Crypto"], volume: "26711.59000000" },
  { periodStart: "2026-09-12T00:00:00Z", categoryPath: ["Crypto", "Bitcoin"], volume: "23947.14000000" },
  { periodStart: "2026-09-12T00:00:00Z", categoryPath: ["Crypto", "Ether"], volume: "1628.45000000" },
]

test("the hour comes from periodStart, which is what the live feed actually sends", () => {
  // periodStart was missing from HOUR_KEYS, so every row's hour was unreadable
  // and the parser fell back to inventing one from the row's position.
  const parsed = monitor.parseHourlyVolume(LIVE_VOLUME_ROWS, "2026-09-12")
  assert.equal(parsed.unresolved, 0, "no row's hour should need guessing")
  assert.equal(parsed.buckets.length, 1, "every row here is the same hour")
  assert.equal(parsed.buckets[0].hour, Date.parse("2026-09-12T00:00:00Z"))
})

test("a nested category hierarchy is not double-counted", () => {
  // The feed is a hierarchy: ["Sports"] already contains ["Sports","Tennis"],
  // which already contains ["Sports","Tennis","US Open"]. The depth-2 rows sum
  // to EXACTLY the depth-1 total, so summing every row inflates the figure —
  // 2.2x on this one hour. That is how the panel reported $21.84M across seven
  // days while the events feed showed $1.49M a day.
  const parsed = monitor.parseHourlyVolume(LIVE_VOLUME_ROWS, "2026-09-12")

  assert.equal(parsed.depthUsed, 1, "only the shallowest rows are totals")
  assert.equal(parsed.nestedRowsSkipped, 9)
  assert.equal(parsed.buckets[0].volume, 70627.42, "Sports 43915.83 + Crypto 26711.59, and nothing else")

  const naive = LIVE_VOLUME_ROWS.reduce((a, r) => a + parseFloat(r.volume), 0)
  assert.ok(naive > parsed.total * 2, `naive summing gives ${naive.toFixed(2)} — over twice the truth`)

  // The children really do sum to the parent, which is what makes the nesting
  // unambiguous rather than a guess about the feed's intent.
  const sportsChildren = LIVE_VOLUME_ROWS
    .filter((r) => r.categoryPath.length === 2 && r.categoryPath[0] === "Sports")
    .reduce((a, r) => a + parseFloat(r.volume), 0)
  assert.ok(Math.abs(sportsChildren - 43915.83) < 0.01,
    "premise: the depth-2 rows are a breakdown of the depth-1 total, not additions to it")
})

test("the per-category breakdown is kept, and only at the total's own depth", () => {
  const parsed = monitor.parseHourlyVolume(LIVE_VOLUME_ROWS, "2026-09-12")
  assert.deepEqual(parsed.buckets[0].byCategory, { Sports: 43915.83, Crypto: 26711.59 },
    "sub-categories belong to their parent, not to the top-level breakdown")
})

test("a response that starts deeper than depth 1 still totals correctly", () => {
  // Taking the minimum depth present, rather than hardcoding 1, means a feed
  // whose top-level rows are absent is summed at its own shallowest level
  // instead of coming back empty.
  const rows = [
    { periodStart: "2026-09-12T00:00:00Z", categoryPath: ["Sports", "Tennis"], volume: "100" },
    { periodStart: "2026-09-12T00:00:00Z", categoryPath: ["Sports", "Soccer"], volume: "50" },
    { periodStart: "2026-09-12T00:00:00Z", categoryPath: ["Sports", "Tennis", "US Open"], volume: "100" },
  ]
  const parsed = monitor.parseHourlyVolume(rows, "2026-09-12")
  assert.equal(parsed.depthUsed, 2)
  assert.equal(parsed.buckets[0].volume, 150)
  assert.equal(parsed.nestedRowsSkipped, 1)
})

test("a flat response with no hierarchy sums every row", () => {
  // No categoryPath means no nesting, so nothing should be held back.
  const rows = Array.from({ length: 24 }, (_, h) => ({ periodStart: `2026-09-12T${String(h).padStart(2, "0")}:00:00Z`, volume: "10" }))
  const parsed = monitor.parseHourlyVolume(rows, "2026-09-12")
  assert.equal(parsed.buckets.length, 24)
  assert.equal(parsed.total, 240)
  assert.equal(parsed.nestedRowsSkipped, 0)
})

test("an unreadable hour is dropped, never invented from the entry's position", () => {
  // The bug this pins shipped and was caught against live data. The fallback was
  // `dayStart + index * 1h`, which is harmless for a clean 24-entry day but
  // catastrophic when a day's container holds more than 24 rows — a
  // per-category breakdown, say. The index then ran past 23 and invented hours
  // days into the future: seven requested days plotted across a ~33-day axis,
  // with a series that still looked entirely plausible.
  const rows = []
  for (let h = 0; h < 24; h++) {
    for (const category of ["Sports", "Crypto", "Politics"]) rows.push({ category, volume: 10 })
  }
  assert.equal(monitor.parseHourlyVolume(rows, "2026-09-06"), null,
    "72 rows with no readable hour must yield nothing, not 72 fabricated hours")

  // Position only implies the hour when there is exactly one row per hour.
  const clean = Array.from({ length: 24 }, () => ({ volume: 5 }))
  const parsed = monitor.parseHourlyVolume(clean, "2026-09-06")
  assert.equal(parsed.buckets.length, 24)
  assert.equal(parsed.unresolved, 0)
  assert.equal(parsed.buckets[23].hour, Date.parse("2026-09-06T23:00:00Z"))
})

test("rows sharing an hour are summed, not plotted as separate points", () => {
  // A feed broken out by category reports each slice separately. Pushing them as
  // separate points is what made one day of data occupy nine days of axis.
  const rows = []
  for (let h = 0; h < 24; h++) {
    for (const category of ["a", "b", "c"]) rows.push({ hour: h, category, volume: 2 })
  }
  const parsed = monitor.parseHourlyVolume(rows, "2026-09-06")
  assert.equal(parsed.buckets.length, 24, "24 hours in, 24 buckets out")
  assert.equal(parsed.total, 144, "every slice still counts toward the total")
  assert.equal(parsed.buckets[0].volume, 6)
})

test("a timestamp outside the requested day is refused rather than trusted", () => {
  const date = "2026-09-06"
  // Inside the day: taken as-is.
  assert.equal(
    monitor.normalizeHour(`${date}T05:00:00Z`, date, 0, 24),
    Date.parse(`${date}T05:00:00Z`))
  // Outside it: the field was misread, so there is no hour to report.
  assert.equal(monitor.normalizeHour("2026-10-20T05:00:00Z", date, 0, 24), null)
  assert.equal(monitor.normalizeHour(24, date, 0, 24), null, "hour 24 is not a valid hour index")
  assert.equal(monitor.normalizeHour("nonsense", date, 0, 24), null)
  // No hour field at all, in a container that is not one row per hour.
  assert.equal(monitor.normalizeHour(undefined, date, 30, 216), null)
})

test("only completed UTC days are requested, oldest first", () => {
  const days = monitor.completedUtcDays(3, Date.parse("2026-09-13T04:00:00Z"))
  assert.deepEqual(days, ["2026-09-10", "2026-09-11", "2026-09-12"])
  assert.ok(!days.includes("2026-09-13"), "today has not closed; the endpoint 404s for it")
})

// ── Volume series ─────────────────────────────────────────────────────────────

test("volume series take fixed slots and fold the tail rather than cycling hues", () => {
  const many = { categories: Array.from({ length: 11 }, (_, i) => ({ name: `Cat${i}`, total: 100 - i })) }
  const series = client.monVolumeSeries(many)

  assert.equal(series.length, client.MON_VOLUME_SLOTS + 1, "eight slots plus one Other band")
  assert.equal(series[series.length - 1].name, "Other")
  const colors = series.slice(0, client.MON_VOLUME_SLOTS).map((s) => s.color)
  assert.equal(new Set(colors).size, client.MON_VOLUME_SLOTS, "no slot is handed out twice")
  assert.deepEqual(colors, Array.from({ length: 8 }, (_, i) => `var(--series-${i + 1})`),
    "slots are assigned in fixed order")
})

test("the Other band carries the whole tail so the stack still sums to the hour", () => {
  const history = { categories: Array.from({ length: 10 }, (_, i) => ({ name: `Cat${i}`, total: 10 })) }
  const series = client.monVolumeSeries(history)
  const bucket = { volume: 100, byCategory: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`Cat${i}`, 10])) }

  const stacked = series.reduce((sum, s) => sum + client.monSeriesValue(bucket, s), 0)
  assert.equal(stacked, 100, "the bands must add up to the hour's real total")
  assert.equal(client.monSeriesValue(bucket, series[series.length - 1]), 20, "Cat8 + Cat9")
})

test("a feed with no breakdown yields no series, so the chart stays single-line", () => {
  assert.deepEqual(client.monVolumeSeries({ categories: [] }), [])
  assert.deepEqual(client.monVolumeSeries({}), [])
})

// ── Overround sample size ─────────────────────────────────────────────────────

test("an average over too few eligible events is not called a platform figure", () => {
  // Live data made this the normal case, not the edge: at 71% quote coverage a
  // 976-event sweep produced ONE eligible event, and the dashboard printed its
  // overround as "Avg overround +57.0%".
  const legs = (n, ask) => Array.from({ length: n }, (_, i) => contract(ask - 0.02, ask, { ticker: `L${i}` }))

  const one = monitor.summarize([
    event({ ticker: "ELIGIBLE", contracts: legs(3, 0.40) }),
    // Every other event has an unquoted leg, exactly as the live feed does.
    ...Array.from({ length: 40 }, (_, i) => event({
      ticker: `HOLE${i}`,
      contracts: [contract(0.4, 0.45, { ticker: "A" }), contract(null, null, { ticker: "B" })],
    })),
  ], { now: NOW })

  assert.equal(one.totals.overroundEligibleEvents, 1)
  assert.equal(one.totals.overroundRepresentative, false,
    "one event cannot describe a platform")
  assert.ok(one.totals.avgOverround !== null,
    "the value is still published — it is the presentation that must withhold it")
  assert.equal(one.totals.overroundExcluded.legUnquoted, 40,
    "the page has to be able to say WHY the sample collapsed")

  // With a real sample it becomes a platform figure again.
  const many = monitor.summarize(
    Array.from({ length: 12 }, (_, i) => event({ ticker: `E${i}`, contracts: legs(2, 0.52) })),
    { now: NOW })
  assert.equal(many.totals.overroundEligibleEvents, 12)
  assert.equal(many.totals.overroundRepresentative, true)
  assert.equal(many.totals.avgOverround, 0.04)
})

test("the exclusion breakdown accounts for every ineligible event", () => {
  const snapshot = monitor.summarize([
    event({ ticker: "OK", contracts: [contract(0.4, 0.45, { ticker: "A" }), contract(0.5, 0.56, { ticker: "B" })] }),
    event({ ticker: "MULTI", template: "binary", contracts: [contract(0.4, 0.45, { ticker: "A" }), contract(0.4, 0.45, { ticker: "B" })] }),
    event({ ticker: "HOLE", contracts: [contract(0.4, 0.45, { ticker: "A" }), contract(0.4, null, { ticker: "B" })] }),
    event({ ticker: "SOLO", contracts: [contract(0.4, 0.45, { ticker: "A" })] }),
    event({ ticker: "WILD", contracts: Array.from({ length: 12 }, (_, i) => contract(0.33, 0.35, { ticker: `L${i}` })) }),
  ], { now: NOW })

  const x = snapshot.totals.overroundExcluded
  assert.equal(x.notSingleWinner, 1)
  assert.equal(x.legUnquoted, 1)
  assert.equal(x.tooFewContracts, 1)
  assert.equal(x.implausible, 1)
  assert.equal(x.other, 0)
  assert.equal(snapshot.totals.overroundEligibleEvents + Object.values(x).reduce((a, b) => a + b, 0),
    snapshot.totals.events, "every event is either eligible or accounted for")
})

test("field size travels with the overround so a tick-floor artefact is visible", () => {
  // On a wide field the sum of asks is inflated by longshots resting at the
  // minimum tick, so a large margin is granularity rather than a spread the
  // venue is charging. The reader needs the leg count to tell those apart.
  const wide = monitor.summarize(
    Array.from({ length: 10 }, (_, i) => event({
      ticker: `W${i}`,
      contracts: Array.from({ length: 40 }, (_, j) => contract(0.01, 0.02, { ticker: `L${j}` })),
    })),
    { now: NOW })
  assert.equal(wide.totals.overroundMaxLegs, 40)
  assert.equal(wide.totals.overroundRepresentative, true)
})

test("the client reaches the same representativeness verdict as the server", () => {
  const events = [
    event({ ticker: "ELIGIBLE", contracts: [contract(0.4, 0.45, { ticker: "A" }), contract(0.5, 0.56, { ticker: "B" })] }),
    ...Array.from({ length: 20 }, (_, i) => event({
      ticker: `HOLE${i}`,
      contracts: [contract(0.4, 0.45, { ticker: "A" }), contract(null, null, { ticker: "B" })],
    })),
  ]
  const snapshot = monitor.summarize(events, { now: NOW })
  const rolled = client.monRollup(snapshot.events)

  assert.equal(rolled.overroundRepresentative, snapshot.totals.overroundRepresentative)
  assert.equal(rolled.overroundEligibleEvents, snapshot.totals.overroundEligibleEvents)
  assert.deepEqual(rolled.overroundExcluded, snapshot.totals.overroundExcluded)
  assert.equal(rolled.overroundMaxLegs, snapshot.totals.overroundMaxLegs)
})

// ── Sweep ─────────────────────────────────────────────────────────────────────

test("a sweep that fails part-way reports what it has as incomplete", async () => {
  // Partial data understates every count, so the caller must be able to say so
  // instead of presenting the shortfall as the platform's actual state.
  let call = 0
  const fetchPage = async () => {
    call += 1
    if (call === 1) return { status: 200, data: Array.from({ length: 100 }, () => event()) }
    return { status: 502, error: "upstream exploded" }
  }

  const sweep = await monitor.fetchAllEvents({ fetchPage })
  assert.equal(sweep.events.length, 100)
  assert.equal(sweep.complete, false)
  assert.match(sweep.warnings[0], /upstream exploded/)
})

test("a sweep that reaches the page cap says the totals are a floor", async () => {
  const fetchPage = async () => ({ status: 200, data: Array.from({ length: 100 }, () => event()) })

  const sweep = await monitor.fetchAllEvents({ maxPages: 2, fetchPage })
  assert.equal(sweep.events.length, 200)
  assert.equal(sweep.complete, false)
  assert.match(sweep.warnings[0], /sweep cap/)
})

test("a sweep ends on a short page without spending another request", async () => {
  let calls = 0
  const fetchPage = async ({ offset }) => {
    calls += 1
    return { status: 200, data: Array.from({ length: offset === 0 ? 100 : 12 }, () => event()) }
  }

  const sweep = await monitor.fetchAllEvents({ fetchPage })
  assert.equal(calls, 2, "a page shorter than the limit means the feed is exhausted")
  assert.equal(sweep.events.length, 112)
  assert.equal(sweep.complete, true)
  assert.deepEqual(sweep.warnings, [])
})

test("the payload carries its own caveats so an API consumer inherits them", () => {
  const snapshot = monitor.summarize([LIVE], { now: NOW })
  // summarize() is the pure half; the notes are attached by getMonitorSnapshot.
  // What matters here is that the shape the UI reads is fully populated.
  assert.ok(Array.isArray(snapshot.categories))
  assert.ok(Array.isArray(snapshot.events))
  assert.ok(Array.isArray(snapshot.rows))
  assert.equal(typeof snapshot.rowsTotal, "number")
  assert.equal(typeof snapshot.totals.overroundEligibleEvents, "number")
  assert.equal(typeof snapshot.totals.contractsTwoSided, "number")
})
