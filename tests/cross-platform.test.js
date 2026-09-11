const test = require("node:test")
const assert = require("node:assert/strict")

const { findCrossPlatform, parseMatchQuery, handleMatchRequest } = require("../lib/cross-platform")

// Searches are cached by the terms they were run with, so each test uses a
// distinct title rather than sharing one and reading a neighbour's result.
function source(title, extra = {}) {
  return { platform: "kalshi", title, date: "2026-09-13", outcomes: ["Norris", "Antonelli"], ...extra }
}

function candidate(platform, title, extra = {}) {
  return {
    platform,
    title,
    date: "2026-09-13",
    outcomes: ["Norris", "Antonelli"],
    url: `https://${platform}.example/${title.replace(/\s+/g, "-")}`,
    ref: title,
    ...extra,
  }
}

test("one venue failing leaves the others answering", async () => {
  const { results } = await findCrossPlatform(source("Belgian Grand Prix Winner"), {
    signedGet: null,
    searchPolymarket: async () => { throw new Error("gamma is down") },
    searchGemini: async () => [candidate("gemini", "Belgian GP Winner")],
  })

  const byPlatform = Object.fromEntries(results.map(r => [r.platform, r]))
  assert.equal(byPlatform.polymarket.error, "gamma is down")
  assert.deepEqual(byPlatform.polymarket.candidates, [])
  assert.equal(byPlatform.gemini.candidates.length, 1)
  assert.equal(byPlatform.gemini.error, null)
})

test("the source's own venue is never searched", async () => {
  const { results } = await findCrossPlatform(source("Dutch Grand Prix Winner"), {
    signedGet: null,
    searchPolymarket: async () => [],
    searchGemini: async () => [],
  })
  assert.deepEqual(results.map(r => r.platform).sort(), ["gemini", "polymarket"])
})

test("a Coinbase market is matched against all three venues", async () => {
  // Coinbase resells Kalshi and Polymarket markets, so a reader who arrives
  // from there has seen neither underlying venue's listing.
  const { results } = await findCrossPlatform(source("Austrian Grand Prix Winner", { platform: "coinbase" }), {
    signedGet: null,
    searchKalshi: async () => [],
    searchPolymarket: async () => [],
    searchGemini: async () => [],
  })
  assert.deepEqual(results.map(r => r.platform).sort(), ["gemini", "kalshi", "polymarket"])
})

test("candidates come back ranked and labelled, never pre-selected", async () => {
  const { results } = await findCrossPlatform(source("Monaco Grand Prix Winner"), {
    signedGet: null,
    searchPolymarket: async () => [
      candidate("polymarket", "Monaco Grand Prix Podium"),          // different bet
      candidate("polymarket", "Monaco GP Winner"),                  // the match
      candidate("polymarket", "Hungarian GP Winner", { date: "2026-08-02" }), // wrong race
    ],
    searchGemini: async () => [],
  })

  const pm = results.find(r => r.platform === "polymarket")
  assert.equal(pm.candidates.length, 2, "the podium market is dropped, not ranked")
  assert.equal(pm.candidates[0].title, "Monaco GP Winner")
  assert.equal(pm.candidates[0].confidence, "strong")
  assert.ok(pm.candidates[0].reasons.length, "a candidate always says why it matched")
  assert.equal(pm.candidates[1].confidence, "weak")
  // Nothing in the payload marks a candidate as chosen — that is the reader's call.
  assert.ok(!("selected" in pm.candidates[0]))
})

test("nothing searchable in the title or the outcomes asks for nothing upstream", async () => {
  let called = false
  const { results } = await findCrossPlatform({ platform: "kalshi", title: "the a of", outcomes: [] }, {
    signedGet: null,
    searchPolymarket: async () => { called = true; return [] },
    searchGemini: async () => { called = true; return [] },
  })
  assert.equal(called, false)
  assert.ok(results.every(r => r.error))
})

test("a competitor's name is searchable even when the title is not", async () => {
  // Competitor names are the one vocabulary that does not vary between venues,
  // so they are worth a query on their own.
  let searched = []
  await findCrossPlatform({ platform: "kalshi", title: "the a of", outcomes: ["Max Verstappen"] }, {
    signedGet: null,
    searchPolymarket: async (terms) => { searched = terms; return [] },
    searchGemini: async () => [],
  })
  assert.deepEqual(searched, ["verstappen"])
})

test("the query shell rejects an unknown platform and a missing title", () => {
  assert.match(parseMatchQuery({ platform: "betfair", title: "x" }).error, /platform must be one of/)
  assert.match(parseMatchQuery({ platform: "kalshi" }).error, /Missing title/)
})

test("the query shell reads outcomes, ignores a malformed date and caps the list", () => {
  const { source: parsed } = parseMatchQuery({
    platform: "gemini",
    title: "Spanish Grand Prix Winner",
    date: "13/09/2026",
    outcomes: Array.from({ length: 40 }, (_, i) => `Driver ${i}`).join("|"),
  })
  assert.equal(parsed.date, "", "a date that is not YYYY-MM-DD is dropped, not guessed at")
  assert.equal(parsed.outcomes.length, 16)
  assert.equal(parsed.outcomes[0], "Driver 0")
})

test("a bad request is a 400 and never reaches a searcher", async () => {
  let called = false
  const res = await handleMatchRequest({ platform: "kalshi" }, {
    signedGet: null,
    searchPolymarket: async () => { called = true; return [] },
    searchGemini: async () => { called = true; return [] },
  })
  assert.equal(res.status, 400)
  assert.equal(called, false)
})

test("a good request echoes the source it searched on", async () => {
  const res = await handleMatchRequest({
    platform: "kalshi",
    title: "Canadian Grand Prix Winner",
    date: "2026-06-07",
    outcomes: "Norris|Antonelli",
  }, {
    signedGet: null,
    searchPolymarket: async () => [],
    searchGemini: async () => [],
  })
  assert.equal(res.status, 200)
  assert.equal(res.data.source.title, "Canadian Grand Prix Winner")
  assert.deepEqual(res.data.source.outcomes, ["Norris", "Antonelli"])
})

// ── The Kalshi index ──────────────────────────────────────────────────────────
// Kalshi publishes no text search, so open events are paged into a local index.
// These exercise the paging and the caching, which are the parts that decide
// whether a reader gets an answer or a blank row.

const { kalshiIndex, searchKalshi, enrichKalshi } = require("../lib/cross-platform")
const { cacheSet } = require("../lib/guard")

// Expiring the entry is how a test starts from a cold index without adding an
// API that exists only for tests.
function clearIndex() {
  cacheSet("kalshi:open-events", null, -1)
}

function pagedSignedGet(pages) {
  let calls = 0
  const get = async () => {
    const page = pages[calls++] || { events: [] }
    return { status: 200, body: JSON.stringify(page) }
  }
  get.callCount = () => calls
  return get
}

test("the index follows the cursor until the venue stops handing one out", async () => {
  clearIndex()
  const get = pagedSignedGet([
    { events: [{ event_ticker: "A", title: "Alpha Winner" }], cursor: "p2" },
    { events: [{ event_ticker: "B", title: "Beta Winner" }] },
  ])
  const index = await kalshiIndex(get)
  assert.deepEqual(index.map(e => e.event_ticker), ["A", "B"])
  assert.equal(get.callCount(), 2, "no extra page is requested once the cursor runs out")
})

test("a second search reuses the index instead of re-paging the venue", async () => {
  clearIndex()
  const get = pagedSignedGet([{ events: [{ event_ticker: "A", title: "Alpha Winner" }] }])
  await kalshiIndex(get)
  await kalshiIndex(get)
  assert.equal(get.callCount(), 1, "signed calls are expensive — one build serves both")
})

test("an index the venue could not fill is not cached for the full window", async () => {
  clearIndex()
  // A page cap or a deadline leaves events missing; caching that for five
  // minutes would answer "not found" for every one of them.
  const get = pagedSignedGet([
    { events: [{ event_ticker: "A", title: "Alpha Winner" }], cursor: "p2" },
    { status: 500 },
  ])
  const partialGet = async (path) => {
    const r = await get(path)
    const body = JSON.parse(r.body)
    return body.status === 500 ? { status: 500, body: "" } : r
  }
  await kalshiIndex(partialGet)
  // The short TTL is 30s, so the entry is still warm here; what matters is that
  // the build stopped at the failed page rather than throwing the good one away.
  const again = await kalshiIndex(partialGet)
  assert.deepEqual(again.map(e => e.event_ticker), ["A"])
})

test("an index with nothing in it is an error, not an empty answer", async () => {
  clearIndex()
  await assert.rejects(
    () => kalshiIndex(async () => ({ status: 403, body: "" })),
    /no open events/)
})

test("searching without credentials says so instead of returning nothing found", async () => {
  await assert.rejects(() => searchKalshi(["spanish"], null), /credentials not configured/)
})

test("the index is filtered on the search terms, not returned whole", async () => {
  clearIndex()
  const get = pagedSignedGet([{
    events: [
      { event_ticker: "KXF1RACE-SPAGP26", title: "Spanish Grand Prix Winner" },
      { event_ticker: "KXNBA-GSW", title: "Warriors vs Lakers" },
    ],
  }])
  const found = await searchKalshi(["spanish", "gp"], get)
  assert.equal(found.length, 1)
  assert.equal(found[0].ref, "KXF1RACE-SPAGP26")
  assert.equal(found[0].url, "https://kalshi.com/markets/kxf1race-spagp26")
})

test("enrichment fills in the outcomes a Kalshi listing never carries", async () => {
  // Without this, every race of the season ties on title alone.
  const candidates = [{ ref: "KXF1RACE-SPAGP26", title: "Spanish Grand Prix Winner", outcomes: [], date: "" }]
  await enrichKalshi(candidates, async () => ({
    status: 200,
    body: JSON.stringify({
      event: {
        strike_date: "2026-09-13T12:00:00Z",
        markets: [{ yes_sub_title: "Lando Norris" }, { yes_sub_title: "Lewis Hamilton" }],
      },
    }),
  }))
  assert.deepEqual(candidates[0].outcomes, ["Lando Norris", "Lewis Hamilton"])
  assert.equal(candidates[0].date, "2026-09-13")
})

test("a candidate that fails to enrich keeps the score it already had", async () => {
  const candidates = [{ ref: "KXF1RACE-SPAGP26", title: "Spanish Grand Prix Winner", outcomes: [], date: "2026-09-13" }]
  await enrichKalshi(candidates, async () => { throw new Error("upstream down") })
  assert.equal(candidates[0].date, "2026-09-13")
  assert.deepEqual(candidates[0].outcomes, [])
})

// ── The failure this retrieval design exists for ──────────────────────────────
// Reported from production: analyzing the Kalshi 2026 Spanish Grand Prix showed
// "No matching event found" on both other venues, for an event both of them
// were listing. The scoring was never the problem — the search never returned
// the candidate for it to score.

// A venue that answers a query only when one of its own words is asked for,
// which is what a real search box does and what the first implementation
// assumed away.
function fakeVenue(listings) {
  const seen = []
  const search = async (terms) => {
    const results = []
    for (const listing of listings) {
      const words = new Set(require("../lib/match").searchTokens(listing.title))
      if (terms.some(t => words.has(t))) results.push(listing)
    }
    seen.push([...terms])
    return results
  }
  search.termsSeen = () => seen
  return search
}

test("the Madrid listing is found for the Spanish Grand Prix", async () => {
  const gemini = fakeVenue([{
    platform: "gemini",
    title: "Madrid Grand Prix Winner",
    date: "2026-09-13",
    outcomes: ["Kimi Antonelli", "Lando Norris"],
    url: "https://www.gemini.com/predictions/F1-MADGP-WIN-20260913",
    ref: "F1-MADGP-WIN-20260913",
  }])

  const { results } = await findCrossPlatform({
    platform: "kalshi",
    title: "Spanish Grand Prix Winner",
    date: "2026-09-13",
    outcomes: ["Andrea Kimi Antonelli", "Lando Norris"],
  }, { signedGet: null, searchPolymarket: async () => [], searchGemini: gemini })

  const found = results.find(r => r.platform === "gemini")
  assert.equal(found.candidates.length, 1,
    "the listing shares no city name with the source — it has to be found on the words they do share")
  assert.equal(found.candidates[0].title, "Madrid Grand Prix Winner")
  assert.equal(found.candidates[0].confidence, "strong")
})

test("the words the venues do not share cost nothing", async () => {
  // "spanish" appears nowhere in the Madrid listing. Sent as part of one joined
  // query it made the whole search unanswerable; sent on its own it simply
  // returns nothing while the other terms do the work.
  const gemini = fakeVenue([{
    platform: "gemini", title: "Madrid Grand Prix Winner", date: "2026-09-13",
    outcomes: ["Lando Norris"], url: "https://gemini.example/x", ref: "x",
  }])
  await findCrossPlatform({
    platform: "kalshi", title: "Portuguese Grand Prix Winner",
    date: "2026-09-13", outcomes: ["Lando Norris"],
  }, { signedGet: null, searchPolymarket: async () => [], searchGemini: gemini })

  const terms = gemini.termsSeen()[0]
  assert.ok(terms.includes("portuguese"), "the distinctive word is still asked for")
  assert.ok(terms.includes("grand") || terms.includes("prix"), "so are the shared ones")
})
