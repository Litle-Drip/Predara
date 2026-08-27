const test = require("node:test")
const assert = require("node:assert/strict")

const {
  getDiscoveryFeed,
  polymarketEventsToDiscoverCards,
} = require("../lib/discover")

test("Polymarket discovery cards expose the leading outcome and readable volume", () => {
  const cards = polymarketEventsToDiscoverCards([{
    title: "Will rates fall this year?",
    slug: "rates-fall",
    volume: "123456.7",
    markets: [{
      outcomes: JSON.stringify(["Yes", "No"]),
      outcomePrices: JSON.stringify(["0.63", "0.37"]),
    }],
  }])

  assert.deepEqual(cards, [{
    title: "Will rates fall this year?",
    url: "https://polymarket.com/event/rates-fall",
    volume: "123,457",
    topOutcome: "Yes",
    topPct: 63,
  }])
})

test("Polymarket discovery cards tolerate malformed market arrays", () => {
  const cards = polymarketEventsToDiscoverCards([{
    title: "Incomplete event",
    slug: "incomplete",
    markets: [{ outcomes: "[", outcomePrices: "not-json" }],
  }])

  assert.equal(cards[0].topOutcome, "")
  assert.equal(cards[0].topPct, "")
})

test("discovery feed returns the public payload without the cache envelope", async () => {
  const feed = await getDiscoveryFeed({
    limit: 1,
    fetchPolymarket: async () => [{
      title: "Test market",
      slug: "test-market",
      markets: [],
    }],
    fetchGemini: async () => ({ status: 503, json: {} }),
  })

  assert.equal(feed.value, undefined)
  assert.equal(feed.platforms[0].name, "polymarket")
  assert.equal(feed.platforms[0].markets[0].title, "Test market")
})
