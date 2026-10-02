// A customer copies the contract symbol off their own position
// (GEMI-{event}-{outcome}). Looked up as an event it 404s; the desk resolves it
// to the parent event and answers for that outcome.

const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const gem = require("../lib/settlement-gemini")

const EVENT = {
  ticker: "F1-BELGP-WIN-20260719",
  title: "Belgian Grand Prix winner",
  status: "settled",
  contracts: [
    { label: "Oscar Piastri", instrumentSymbol: "GEMI-F1-BELGP-WIN-20260719-PIA", resolutionSide: "yes", resolvedAt: "2026-07-19T18:31:35.392Z" },
    { label: "Alexander Albon", instrumentSymbol: "GEMI-F1-BELGP-WIN-20260719-ALB", resolutionSide: "no" },
  ],
}

function fakeFetcher(ok = {}, other = {}) {
  const calls = []
  const fetcher = async (url) => {
    const ticker = decodeURIComponent(url.split("/events/")[1])
    calls.push(ticker)
    if (other[ticker]) return { status: other[ticker], body: "" }
    if (ok[ticker]) return { status: 200, body: JSON.stringify(ok[ticker]) }
    return { status: 404, body: "" }
  }
  return { fetcher, calls }
}

test("an event ticker is looked up exactly as pasted, in one request", async () => {
  const { fetcher, calls } = fakeFetcher({ "F1-BELGP-WIN-20260719": EVENT })
  const res = await gem.fetchGeminiSettlementEvent("F1-BELGP-WIN-20260719", fetcher)
  assert.equal(res.status, 200)
  assert.deepEqual(calls, ["F1-BELGP-WIN-20260719"])
  assert.equal(res.focusSymbol, "")
})

test("a contract symbol resolves to its parent event", async () => {
  const { fetcher, calls } = fakeFetcher({ "F1-BELGP-WIN-20260719": EVENT })
  const res = await gem.fetchGeminiSettlementEvent("GEMI-F1-BELGP-WIN-20260719-ALB", fetcher)
  assert.equal(res.status, 200)
  assert.equal(res.eventTicker, "F1-BELGP-WIN-20260719")
  assert.deepEqual(calls, ["F1-BELGP-WIN-20260719"], "the likeliest event ticker is tried first")
  assert.equal(res.focusSymbol, "GEMI-F1-BELGP-WIN-20260719-ALB")
})

test("a single-word event ticker and a hyphenated outcome code both resolve, in at most three requests", async () => {
  assert.deepEqual(gem.geminiEventCandidates("GEMI-USOPENM26-ALCARAZ"), ["USOPENM26", "USOPENM26-ALCARAZ"])
  assert.deepEqual(gem.geminiEventCandidates("GEMI-FED-JUL26-CUT-25"), ["FED-JUL26-CUT", "FED-JUL26", "FED-JUL26-CUT-25"])
  const { fetcher, calls } = fakeFetcher({})
  const res = await gem.fetchGeminiSettlementEvent("GEMI-FED-JUL26-CUT-25", fetcher)
  assert.equal(res.status, 404)
  assert.equal(calls.length, 3)
})

test("an upstream outage stops the search rather than being read as a wrong guess", async () => {
  const { fetcher, calls } = fakeFetcher({}, { "F1-BELGP-WIN-20260719": 503 })
  const res = await gem.fetchGeminiSettlementEvent("GEMI-F1-BELGP-WIN-20260719-ALB", fetcher)
  assert.equal(res.status, 503)
  assert.equal(calls.length, 1)
})

test("the pasted contract is found on the event and its outcome reported", () => {
  const data = gem.geminiWinnersData(EVENT, "F1-BELGP-WIN-20260719", "GEMI-F1-BELGP-WIN-20260719-ALB")
  assert.deepEqual(data.focus, { symbol: "GEMI-F1-BELGP-WIN-20260719-ALB", label: "Alexander Albon", result: "lost" })
  assert.equal(gem.focusFact(data.focus), "Contract asked about: Alexander Albon (GEMI-F1-BELGP-WIN-20260719-ALB) did not win")
  // The event-level result is unchanged.
  assert.deepEqual(data.winners.map(w => w.label), ["Oscar Piastri"])
  assert.equal(data.contracts, 2)
  assert.equal(gem.geminiWinnersData(EVENT, "x", "").focus, null, "no symbol pasted, no focus")
})

test("an unsettled contract is never reported as won or lost", () => {
  const live = { ...EVENT, contracts: [{ label: "Albon", instrumentSymbol: "GEMI-X-ALB" }] }
  assert.equal(gem.findFocusContract(live.contracts, "gemi-x-alb").result, "unsettled")
})

test("both review entrypoints use the shared lookup", () => {
  for (const f of ["server.js", path.join("api", "settlement-review.js")]) {
    const src = fs.readFileSync(path.join(__dirname, "..", f), "utf8")
    assert.match(src, /require\("\.\.?\/lib\/settlement-gemini"\)/, f)
    assert.match(src, /fetchGeminiSettlementEvent\(identifier,/, f)
    assert.ok(!/api\.gemini\.com\/v1\/prediction-markets\/events\/\$\{encodeURIComponent\(identifier\)\}/.test(src), `${f} still looks the raw input up directly`)
  }
})

test("the desk shows the pasted contract's outcome first and keeps it in Export", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "settlement.html"), "utf8")
  assert.match(html, /focus:\s+data\.focus \|\| null/)
  assert.match(html, /The contract you pasted, <strong>/)
  assert.match(html, /contractAskedAbout: c\.focus \|\| null/)
})
