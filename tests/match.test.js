const test = require("node:test")
const assert = require("node:assert/strict")

const match = require("../lib/match")

// The event this whole feature exists for. One race, three venues, no shared
// substring between any two tickers, and two different countries in the titles.
const SPANISH_GP = {
  platform: "kalshi",
  title: "Spanish Grand Prix Winner",
  date: "2026-09-13",
  outcomes: ["Andrea Kimi Antonelli", "Lando Norris", "Lewis Hamilton", "Max Verstappen"],
}

test("a date is read out of an ISO string, a Polymarket slug or a Gemini ticker", () => {
  assert.equal(match.extractDate("2026-09-13T14:00:00Z"), "2026-09-13")
  assert.equal(match.extractDate("f1-thsgp-2026-09-13-w"), "2026-09-13")
  assert.equal(match.extractDate("F1-MADGP-WIN-20260913"), "2026-09-13")
  assert.equal(match.extractDate(""), "")
})

test("a Kalshi two-digit ticker year is not mistaken for a date", () => {
  // KXF1RACE-SPAGP26 says 2026 and nothing about the day. Returning a date here
  // would let a whole season of races score as the same close date.
  assert.equal(match.extractDate("KXF1RACE-SPAGP26"), "")
})

test("the same race on two venues under two city names still matches", () => {
  const gemini = {
    title: "Madrid Grand Prix Winner",
    date: "2026-09-13",
    outcomes: ["Kimi Antonelli", "Norris", "Verstappen"],
  }
  const result = match.scoreMatch(SPANISH_GP, gemini)
  assert.equal(result.confidence, "strong")
  assert.ok(result.reasons.includes("same close date"))
})

test("a driver is the same driver however completely the venue names them", () => {
  assert.equal(match.outcomeKey("Andrea Kimi Antonelli"), "antonelli")
  assert.equal(match.outcomeKey("Antonelli"), "antonelli")
})

test("the podium market is not the winner market, however well everything else lines up", () => {
  // Same race, same date, same twenty drivers — and a completely different bet.
  const podium = {
    title: "Madrid Grand Prix Podium",
    date: "2026-09-13",
    outcomes: SPANISH_GP.outcomes,
  }
  const result = match.scoreMatch(SPANISH_GP, podium)
  assert.equal(result.confidence, "none")
  assert.match(result.disqualified, /different market type/)
})

test("last week's race is never a confident match for this week's", () => {
  // Every race of the season shares a driver list and most of a title, so
  // title and outcome overlap alone would rank this as strong.
  const lastWeek = {
    title: "Italian Grand Prix Winner",
    date: "2026-09-06",
    outcomes: SPANISH_GP.outcomes,
  }
  const result = match.scoreMatch(SPANISH_GP, lastWeek)
  assert.equal(result.confidence, "weak")
  assert.ok(result.reasons.some(r => /7 days apart/.test(r)))
})

test("sharing nothing but a date is not evidence of anything", () => {
  const unrelated = { title: "Will Bitcoin reach $200k?", date: "2026-09-13", outcomes: ["Yes", "No"] }
  const result = match.scoreMatch(SPANISH_GP, unrelated)
  assert.equal(result.score, 0)
  assert.match(result.disqualified, /nothing in common but the date/)
})

test("a venue that publishes no outcome list is not scored as if its outcomes disagreed", () => {
  // Kalshi's event listing carries a title and never an outcome list. Counting
  // the absent list as a mismatch would bury every Kalshi candidate.
  const titleOnly = { title: "Spanish Grand Prix Winner", date: "2026-09-13", outcomes: [] }
  const result = match.scoreMatch(SPANISH_GP, titleOnly)
  assert.equal(result.confidence, "strong")
})

test("ranking drops the disqualified and keeps the best first", () => {
  const ranked = match.rankCandidates(SPANISH_GP, [
    { title: "Madrid Grand Prix Podium", date: "2026-09-13", outcomes: SPANISH_GP.outcomes },
    { title: "Italian Grand Prix Winner", date: "2026-09-06", outcomes: SPANISH_GP.outcomes },
    { title: "F1 Spanish GP Winner", date: "2026-09-13", outcomes: ["Antonelli", "Norris"] },
    { title: "Will Bitcoin reach $200k?", date: "2026-09-13", outcomes: ["Yes", "No"] },
  ], 3)

  assert.equal(ranked.length, 2)
  assert.equal(ranked[0].title, "F1 Spanish GP Winner")
  assert.equal(ranked[0].confidence, "strong")
  assert.equal(ranked[1].confidence, "weak")
})

test("search terms drop stopwords, years and duplicates", () => {
  const terms = match.searchTerms({ title: "Who will be the 2026 Spanish Grand Prix winner?" })
  assert.ok(terms.includes("spanish"))
  assert.ok(terms.includes("winner"))
  assert.ok(!terms.includes("2026"))
  assert.ok(!terms.includes("the"))
})

test("Grand Prix and GP are the same words", () => {
  assert.equal(match.normalizeTitle("Spanish Grand Prix"), "spanish gp")
})
