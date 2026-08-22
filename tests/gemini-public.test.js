const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")

const { getGeminiPublic, geminiEventsToDiscoverCards, RESOURCE_NAMES } = require("../lib/gemini-public")

test("only public read-only resources are exposed", () => {
  const forbidden = ["orders", "positions", "payouts", "cancel", "settled-positions", "accept-terms"]
  for (const name of RESOURCE_NAMES) {
    assert.ok(!forbidden.includes(name), `authenticated resource "${name}" must not be proxied`)
  }
  assert.ok(RESOURCE_NAMES.includes("events"))
  assert.ok(RESOURCE_NAMES.includes("liquidity-rewards-events"))
})

test("unknown resources and malformed params are rejected before any upstream call", async () => {
  assert.equal((await getGeminiPublic("orders")).status, 400)
  assert.equal((await getGeminiPublic("volume", { date: "not-a-date" })).status, 400)
  assert.equal((await getGeminiPublic("volume", { date: "2026-01-01/../../secret" })).status, 400)
  assert.equal((await getGeminiPublic("strike", {})).status, 400)
  assert.equal((await getGeminiPublic("strike", { ticker: "BTC/../admin" })).status, 400)
  assert.equal((await getGeminiPublic("events", { category: "Sports<script>" })).status, 400)
})

// The events endpoint returns { data: [...] } with prices nested under each
// contract — reading data.events/last_price silently yielded zero cards.
test("discover cards read the live events response shape", () => {
  const cards = geminiEventsToDiscoverCards({
    data: [{
      title: "BMW Championship Winner",
      ticker: "GOLF-BMW-WIN-20260823",
      liquidity: "48210.5",
      contracts: [
        { abbreviatedName: "W.Clark", prices: { lastTradePrice: "0.31", bestBid: "0.29", bestAsk: "0.31" } },
        { abbreviatedName: "S.Scheffler", prices: { lastTradePrice: "0.44", bestBid: "0.43", bestAsk: "0.45" } },
      ],
    }],
    pagination: { total: 1 },
  })
  assert.equal(cards.length, 1)
  assert.equal(cards[0].topOutcome, "S.Scheffler")
  assert.equal(cards[0].topPct, 44)
  assert.equal(cards[0].volume, "48,211")
  assert.equal(cards[0].url, "https://www.gemini.com/predictions/GOLF-BMW-WIN-20260823")
})

test("discover cards fall back to best ask when a market has not traded", () => {
  const cards = geminiEventsToDiscoverCards({
    data: [{ title: "New market", ticker: "NEW", contracts: [{ label: "Yes", prices: { bestAsk: "0.07" } }] }],
  })
  assert.equal(cards[0].topOutcome, "Yes")
  assert.equal(cards[0].topPct, 7)
  assert.equal(cards[0].volume, "")
})

// The live order book subscribes per contract instrumentSymbol, so normalization
// has to carry those symbols through for open markets only.
test("normalizeGemini exposes instrument symbols for open markets only", () => {
  const context = vm.createContext({
    console, window: {}, Date, Math, Number, String, URL, parseFloat, parseInt, isNaN, Set,
  })
  ;["utils.js", "components.js", "renderers.js", "adapters.js"].forEach((file) => {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context, { filename: file })
  })

  const event = (status) => ({
    title: "Oil (WTI) price on August 21?",
    ticker: "WTI2608212100",
    status,
    type: "binary",
    category: "Commodities",
    contracts: [{
      label: "Up",
      instrumentSymbol: "GEMI-WTI2608212100-UP",
      prices: { lastTradePrice: "0.55", bestBid: "0.54", bestAsk: "0.56" },
      expiryDate: "2026-08-21T21:00:00Z",
    }],
  })

  const open = context.normalizeGemini(event("active"))
  // Structural compare: the adapter runs in a separate vm realm, so its objects
  // are not reference-equal to plain ones here.
  assert.deepEqual(JSON.parse(JSON.stringify(open.geminiLive)), {
    ticker: "WTI2608212100",
    category: "Commodities",
    contracts: [{ label: "Up", symbol: "GEMI-WTI2608212100-UP" }],
  })
  assert.match(open.rewardsHtml, /id="gemEventRewards"/)

  const settled = context.normalizeGemini(event("settled"))
  assert.equal(settled.geminiLive, null)
})
