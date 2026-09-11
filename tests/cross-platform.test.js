const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

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

// ── Not offering the wrong event ──────────────────────────────────────────────

test("a cycling race is not offered as a match for a Formula 1 Grand Prix", async () => {
  // Reported from production. "Grand Prix Cycliste de Montreal 2026: Winner"
  // finishes the same day as the Spanish GP and shares "grand", "prix" and
  // "winner" — enough to score LIKELY on the titles alone. The riders and the
  // drivers share no name, which settles it.
  const { results } = await findCrossPlatform({
    platform: "kalshi",
    title: "Spanish Grand Prix Winner",
    date: "2026-09-13",
    outcomes: ["Lando Norris", "Max Verstappen", "Lewis Hamilton"],
  }, {
    signedGet: null,
    searchGemini: async () => [],
    searchPolymarket: async () => [{
      platform: "polymarket",
      title: "Grand Prix Cycliste de Montreal 2026: Winner",
      date: "2026-09-13",
      outcomes: ["Tadej Pogacar", "Remco Evenepoel"],
      url: "https://polymarket.com/event/gp-montreal",
      ref: "gp-montreal",
    }],
  })

  const pm = results.find(r => r.platform === "polymarket")
  assert.deepEqual(pm.candidates, [], "shared words and a shared date are not a shared event")
})

test("a Yes and a No are not two events agreeing about anything", async () => {
  // Every binary market ever written has both, so counting them as overlap made
  // unrelated questions look alike.
  const m = require("../lib/match")
  assert.equal(m.outcomeKeys(["Yes", "No"]).size, 0)
  assert.equal(m.outcomeKeys(["Lando Norris", "Other"]).size, 1)
})

test("an empty result says which half of the search came up short", async () => {
  // "No matching event found" cannot tell "nothing is listed under these words"
  // from "plenty is, none of it this event" — and whoever reports the problem
  // should not need to know the difference to describe it.
  // Searches are cached by their terms, so this uses a fixture no other test
  // produces the same terms for.
  const nothingListed = await findCrossPlatform({
    platform: "kalshi", title: "Interlagos Grand Prix Winner",
    date: "2026-07-26", outcomes: ["Gabriel Bortoleto"],
  }, { signedGet: null, searchGemini: async () => [], searchPolymarket: async () => [] })

  const empty = nothingListed.results.find(r => r.platform === "gemini")
  assert.equal(empty.listingsFound, 0)
  assert.ok(empty.searched.includes("bortoleto"), "the card can name the words it tried")

  const allRejected = await findCrossPlatform({
    platform: "kalshi", title: "Hungarian Grand Prix Winner",
    date: "2026-08-02", outcomes: ["Lando Norris", "Max Verstappen"],
  }, {
    signedGet: null,
    searchGemini: async () => [{
      platform: "gemini", title: "Grand Prix Cycliste Winner", date: "2026-08-02",
      outcomes: ["Tadej Pogacar", "Remco Evenepoel"], url: "https://g.example/x", ref: "x",
    }],
    searchPolymarket: async () => [],
  })
  const rejected = allRejected.results.find(r => r.platform === "gemini")
  assert.equal(rejected.listingsFound, 1, "something was found, and then judged")
  assert.deepEqual(rejected.candidates, [])
})

test("a competitor's name leads the search rather than being cut off by the cap", async () => {
  // It was sorted in behind the title's words and dropped by the limit on
  // exactly the markets it helps most: the ones with long descriptive titles.
  const m = require("../lib/match")
  const terms = m.searchTerms({
    title: "Who will win the Spanish Grand Prix Formula One race",
    outcomes: ["Max Verstappen"],
  })
  assert.equal(terms[0], "verstappen")
})

// ── Reading Gemini's own payload ──────────────────────────────────────────────

test("a Gemini listing is read with competitors' names, not their three-letter codes", () => {
  // Checked against a real capture rather than against assumptions. Gemini
  // carries both `label` ("Andrea Kimi Antonelli") and `abbreviatedName`
  // ("ANT"); reading the code first left every Gemini listing sharing no name
  // with any other venue, so the rule meant to reject a cycling race threw away
  // the correct Grand Prix instead.
  const { geminiEventToCandidate } = require("../lib/cross-platform")
  const payload = require("./fixtures/gemini-settled-categorical.json")
  const event = Array.isArray(payload) ? payload[0] : payload

  const candidate = geminiEventToCandidate(event)
  assert.ok(candidate.outcomes.includes("Andrea Kimi Antonelli"))
  assert.ok(!candidate.outcomes.includes("ANT"), "the code is not a name anything can be matched on")
  assert.equal(candidate.date, "2026-09-06", "the date comes off the event, not the ticker guess")

  // And the whole point: it now matches a Kalshi listing of the same race.
  const m = require("../lib/match")
  const scored = m.scoreMatch({
    title: "Italian Grand Prix Winner",
    date: "2026-09-06",
    outcomes: ["Andrea Kimi Antonelli", "Max Verstappen", "Lando Norris"],
  }, candidate)
  assert.equal(scored.confidence, "strong")
})

// ── Same sport, different market ──────────────────────────────────────────────

test("a season championship is not a match for one race in that season", async () => {
  // Reported from production against the Spanish Grand Prix: "F1 Drivers'
  // Champion" and "F1: Action of the Year" were both offered, each matching
  // 90-100% of the drivers. Every market in a sport lists that sport's
  // entrants, so a full outcome overlap says "same sport", not "same event".
  // A race no other test in this file generates the same search terms for —
  // searches are cached by their terms.
  const drivers = ["Andrea Kimi Antonelli", "Lando Norris", "Lewis Hamilton", "Max Verstappen"]
  const { results } = await findCrossPlatform({
    platform: "kalshi", title: "Brazilian Grand Prix Winner",
    date: "2026-11-08", outcomes: drivers,
  }, {
    signedGet: null,
    searchGemini: async () => [],
    searchPolymarket: async () => [
      { platform: "polymarket", title: "F1 Drivers' Champion", date: "2026-12-06",
        outcomes: drivers, url: "https://polymarket.com/event/f1-champ", ref: "f1-champ" },
      { platform: "polymarket", title: "F1: Action of the Year", date: "2026-12-31",
        outcomes: drivers, url: "https://polymarket.com/event/f1-action", ref: "f1-action" },
    ],
  })

  const pm = results.find(r => r.platform === "polymarket")
  assert.deepEqual(pm.candidates, [])
  assert.equal(pm.listingsFound, 2, "they were found and then judged, and the card can say so")
})

test("agreeing on the day is enough when the titles share nothing", () => {
  // The rule above must not reject two venues that genuinely name one event
  // differently. Sharing no word is survivable; sharing no word AND no date is
  // not.
  const m = require("../lib/match")
  const scored = m.scoreMatch(
    { title: "NYC Mayoral Race", date: "2026-11-03", outcomes: ["Mamdani", "Cuomo"] },
    { title: "Who becomes New York City mayor?", date: "2026-11-03", outcomes: ["Mamdani", "Cuomo"] })
  assert.notEqual(scored.confidence, "none")
})

test("the day is the same day within the tolerance the matcher already grants", () => {
  // dateScore absorbs a one-day skew on purpose: a close timestamp is UTC and
  // an event date is local, so one venue can land either side of midnight.
  // Requiring an exact match in the title-shares-nothing rule contradicted that
  // and rejected genuine pairs.
  const m = require("../lib/match")
  const sameEventNextDay = m.scoreMatch(
    { title: "NYC Mayoral Race", date: "2026-11-03", outcomes: ["Mamdani", "Cuomo"] },
    { title: "Who becomes New York City mayor?", date: "2026-11-04", outcomes: ["Mamdani", "Cuomo"] })
  assert.notEqual(sameEventNextDay.confidence, "none", "one day apart is the same day here")

  // And the season-long market it exists to reject is months away, not a day.
  const seasonAward = m.scoreMatch(
    { title: "Spanish Grand Prix Winner", date: "2026-09-13", outcomes: ["Norris", "Verstappen"] },
    { title: "F1 Drivers' Champion", date: "2026-12-06", outcomes: ["Norris", "Verstappen"] })
  assert.equal(seasonAward.confidence, "none")
})

test("the search term list is not truncated a second time by its caller", () => {
  // searchTerms() decides how many terms are worth sending; a second cap at the
  // call site silently dropped the last one once the competitor's name was
  // added at the front.
  const source = fs.readFileSync(path.join(__dirname, "..", "lib", "cross-platform.js"), "utf8")
  assert.match(source, /match\.searchTerms\(source\)/)
})

test("an empty result names some of what it checked, not just how much", async () => {
  // Counting rejections cannot separate "the right event was never in the pool"
  // from "it was there and the scoring rejected it", which is the difference
  // between a retrieval bug and a scoring bug. The titles say which.
  const { results } = await findCrossPlatform({
    platform: "kalshi", title: "Suzuka Grand Prix Winner",
    date: "2026-04-12", outcomes: ["Yuki Tsunoda"],
  }, {
    signedGet: null,
    searchPolymarket: async () => [],
    searchGemini: async () => [
      { platform: "gemini", title: "Tour de France Winner", date: "2026-07-26",
        outcomes: ["Tadej Pogacar", "Jonas Vingegaard"], url: "https://g.example/a", ref: "a" },
      { platform: "gemini", title: "Giro d'Italia Winner", date: "2026-06-01",
        outcomes: ["Primoz Roglic", "Juan Ayuso"], url: "https://g.example/b", ref: "b" },
    ],
  })

  const gem = results.find(r => r.platform === "gemini")
  assert.deepEqual(gem.candidates, [])
  assert.deepEqual(gem.checkedTitles, ["Tour de France Winner", "Giro d'Italia Winner"])
})

test("both spellings of an abbreviated name are asked for", async () => {
  // Kalshi writes "Grand Prix"; another venue may write "GP", which shares no
  // searchable word with it. Whichever spelling the venue uses, one of the
  // queries reaches it.
  const m = require("../lib/match")
  const terms = m.searchTerms({ title: "Spanish Grand Prix Winner", outcomes: ["Andrea Kimi Antonelli"] })
  assert.ok(terms.includes("grand"))
  assert.ok(terms.includes("gp"), "the abbreviation the other venue may have used")
  assert.ok(terms.indexOf("antonelli") < terms.indexOf("gp"),
    "alternates go behind the words the source venue actually used")
})

test("a listing titled with the abbreviation is recognised locally too", () => {
  // The fallback path and the Kalshi index filter titles in-process, so a term
  // that is sent upstream but discarded locally only works half the time.
  const m = require("../lib/match")
  assert.ok(m.searchTokens("F1: Madrid GP").includes("gp"))
  assert.ok(!m.searchTokens("Grand Prix Cycliste de Montreal").includes("de"), "real noise still goes")
})

test("the Polymarket fallback pages instead of reading only the biggest markets", () => {
  // One page ordered by volume asks whether the event is among the hundred
  // biggest markets on the venue, which for a motor race it is not — so the
  // race was never in the pool that got rejected.
  const source = fs.readFileSync(path.join(__dirname, "..", "lib", "cross-platform.js"), "utf8")
  assert.match(source, /offset=\$\{page \* POLYMARKET_PAGE_SIZE\}/)
  assert.match(source, /POLYMARKET_FALLBACK_PAGES = [2-9]/)
})

test("a long title does not lose its abbreviation queries to the cap", () => {
  // Aliases were appended and then truncated, so a title with enough words to
  // fill the cap on its own silently disabled the abbreviation search — on
  // exactly the long descriptive titles most likely to need it.
  const m = require("../lib/match")
  const terms = m.searchTerms({
    title: "Formula One Spanish Grand Prix Race Winner Market",
    outcomes: ["Andrea Kimi Antonelli"],
  })
  assert.ok(terms.includes("gp"), "the abbreviation another venue may have used")
  assert.ok(terms.includes("antonelli"), "and the competitor's name is still first")
  assert.equal(terms[0], "antonelli")
})

test("aliases never crowd out the source venue's own words entirely", () => {
  const m = require("../lib/match")
  const terms = m.searchTerms({ title: "Grand Prix", outcomes: [] })
  const raw = terms.filter(t => ["grand", "prix"].includes(t))
  assert.ok(raw.length >= 2, "the words actually used come first and stay")
})

test("a search cut short reports that, rather than a confident absence", async () => {
  // A rate limit partway through leaves the rest of the venue unread. Reporting
  // "none of them is this event" for an event that may sit on a page never
  // fetched is a wrong answer stated confidently.
  const partial = []
  partial.incomplete = "Polymarket returned 429 partway through — some listings were not checked"

  const { results } = await findCrossPlatform({
    platform: "kalshi", title: "Zandvoort Grand Prix Winner",
    date: "2026-08-30", outcomes: ["Nico Hulkenberg"],
  }, {
    signedGet: null,
    searchGemini: async () => [],
    searchPolymarket: async () => partial,
  })

  const pm = results.find(r => r.platform === "polymarket")
  assert.match(pm.incomplete, /429/)
  assert.deepEqual(pm.candidates, [])
})

test("a complete search carries no incompleteness marker", async () => {
  const { results } = await findCrossPlatform({
    platform: "kalshi", title: "Imola Grand Prix Winner",
    date: "2026-05-17", outcomes: ["Kimi Raikkonen"],
  }, { signedGet: null, searchGemini: async () => [], searchPolymarket: async () => [] })

  assert.ok(results.every(r => r.incomplete === null))
})
