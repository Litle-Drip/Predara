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

// app.js reaches for rather more of the browser than the pure UI files do.
function loadAppContext(inputValue = "") {
  // resetToHome() styles the input as well as clearing it.
  const input = { value: inputValue, classList: { add() {}, remove() {} } }
  const context = vm.createContext({
    console, window: {}, Date, Math, Number, String, URL, Map, Set,
    parseFloat, parseInt, isNaN, encodeURIComponent, URLSearchParams, setTimeout,
    document: {
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementById: (id) => (id === "urlInput" ? input : null),
      addEventListener: () => {},
    },
    localStorage: { getItem: () => null, setItem: () => {} },
    location: { pathname: "/", search: "" },
    history: { pushState: () => {} },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    navigator: {},
  })
  ;["utils.js", "app.js"].forEach((file) => {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context, { filename: file })
  })
  return context
}

test("an analyzed Gemini ticker still knows which venue it came from", () => {
  // GEMI- is not "gemini", and a bare event ticker names no venue at all, so
  // reading the input box returned "" for a market that had loaded fine — which
  // blanked the platform on its history entry and stopped the match card from
  // rendering at all. The resolved URL is what answers this.
  const ctx = loadAppContext("GEMI-F1-MADGP-WIN-20260913-ANT")
  assert.equal(ctx._currentPlatform(), "", "the raw symbol names no venue — this is the trap")

  ctx.window._analyzedUrl = "https://www.gemini.com/predictions/F1-MADGP-WIN-20260913"
  assert.equal(ctx._currentPlatform(), "gemini")
})

test("the input box is still read when nothing has been analyzed yet", () => {
  const ctx = loadAppContext("https://kalshi.com/markets/kxf1race-spagp26")
  assert.equal(ctx._currentPlatform(), "kalshi")
})

test("clearing the page forgets the analyzed venue", () => {
  const ctx = loadAppContext("")
  ctx.window._analyzedUrl = "https://www.gemini.com/predictions/F1-MADGP-WIN-20260913"
  ctx.resetToHome()
  assert.equal(ctx._currentPlatform(), "", "a stale venue would mislabel the next market")
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
  // Assets are cache-first, so the shell needs a version to invalidate on.
  // Pinning the number here only breaks the next legitimate bump — that the
  // bump actually happened is what review is for. tests/asset-versions.test.js
  // covers the ?v= side, which is the part that silently ships nothing.
  assert.match(sw, /CACHE_NAME = "predara-v\d+"/)
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8")
  assert.match(html, /<script src="crossmatch\.js/)
})

test("a polymarket.us link is not called unrecognized by the input hint", () => {
  // The hint matched "polymarket.com" while analyze() matches "polymarket", so
  // the same URL was called an unsupported platform and then analyzed anyway.
  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8")
  assert.match(app, /lower\.includes\("polymarket\.com"\) \|\| lower\.includes\("polymarket\.us"\)/)
})

test("a polymarket.us paste does not auto-fire an analysis that cannot succeed", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8")
  const gate = app.split("function _isRecognizedMarketUrl")[1].split("function onUrlPaste")[0]
  assert.ok(!/polymarket\.us"/.test(gate),
    "auto-analyzing a venue with no readable API only produces an error the reader did not ask for")
})
