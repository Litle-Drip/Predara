// Browser-side tests for the "same event on other platforms" card and the
// ticker handling it sits alongside. Loaded through vm the same way the other
// UI tests load the front-end files, since none of them are CommonJS modules.

const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")

function loadUiContext(files) {
  const context = vm.createContext({
    console, window: {}, Date, Math, Number, String, URL, Map, Set,
    parseFloat, parseInt, isNaN, encodeURIComponent, URLSearchParams,
    document: { querySelectorAll: () => [], querySelector: () => null, getElementById: () => null },
  })
  files.forEach((file) => {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context, { filename: file })
  })
  return context
}

test("an instrument symbol resolves to its event ticker, not a 404", () => {
  // GEMI-F1-MADGP-WIN-20260913-ANT is what a customer copies off their own
  // position. Sent to the API verbatim it 404s on a market that is trading.
  const ctx = loadUiContext(["utils.js"])
  assert.equal(
    ctx.geminiUrlFromTicker("GEMI-F1-MADGP-WIN-20260913-ANT"),
    "https://www.gemini.com/predictions/F1-MADGP-WIN-20260913")
})

test("a bare event ticker is accepted as it stands", () => {
  const ctx = loadUiContext(["utils.js"])
  assert.equal(
    ctx.geminiUrlFromTicker("f1-madgp-win-20260913"),
    "https://www.gemini.com/predictions/F1-MADGP-WIN-20260913")
})

test("a URL is not a ticker and is handed back untouched for the caller to route", () => {
  const ctx = loadUiContext(["utils.js"])
  assert.equal(ctx.geminiUrlFromTicker("https://kalshi.com/markets/kxf1race"), "")
  assert.equal(ctx.geminiUrlFromTicker(""), "")
})

test("the compare view expands an instrument symbol the same way analyze does", () => {
  // The two used to carry separate copies of this, and only one of them was
  // right — which is what produced the 'ticker not found' in the compare card.
  const source = fs.readFileSync(path.join(__dirname, "..", "compare.js"), "utf8")
  assert.match(source, /geminiUrlFromTicker/)
  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8")
  assert.match(app, /geminiUrlFromTicker/)
})

test("a polymarket.us link is fetched against the US venue", () => {
  for (const file of ["app.js", "compare.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8")
    assert.match(source, /polymarket\\\.us/, `${file} must detect the .us venue`)
    assert.match(source, /venue=\$\{pmVenue\}/, `${file} must pass the venue upstream`)
  }
})

test("the compare view reports the upstream's own error rather than a bare status", () => {
  // "Polymarket API 502" for a slug that simply does not exist sent readers
  // looking for an outage instead of at their URL.
  const source = fs.readFileSync(path.join(__dirname, "..", "compare.js"), "utf8")
  assert.match(source, /e\.error \|\| `Polymarket API \$\{res\.status\}`/)
})

test("the match card renders nothing when there is no analyzed market to match", () => {
  const ctx = loadUiContext(["utils.js", "crossmatch.js"])
  assert.equal(ctx.crossMatchCardHtml(), "")
})

test("candidate URLs are held out of the markup, not interpolated into onclick", () => {
  // Candidate titles and URLs come from another exchange's API. Putting them in
  // an attribute is how a quote in a market title becomes markup.
  const source = fs.readFileSync(path.join(__dirname, "..", "crossmatch.js"), "utf8")
  assert.match(source, /window\._xmatchCandidates\[id\] = c\.url/)
  assert.match(source, /onclick="xmatchAdd\('\$\{esc\(id\)\}'\)"/)
  assert.ok(!/onclick="xmatchAdd\('\$\{c\.url\}/.test(source))
})

test("the card is published as a cached asset so returning readers get it", () => {
  const sw = fs.readFileSync(path.join(__dirname, "..", "sw.js"), "utf8")
  assert.match(sw, /"\/crossmatch\.js"/)
  // Assets are cache-first: without a bumped cache name a returning reader
  // keeps the old bundle and never sees the feature.
  assert.match(sw, /CACHE_NAME = "predara-v4"/)
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8")
  assert.match(html, /<script src="crossmatch\.js/)
})
