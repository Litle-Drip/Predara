const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")

function loadUiContext() {
  const context = vm.createContext({
    console,
    window: { _simMarket: { amount: 10, pct: 0, platform: "" } },
    Date,
    Math,
    Number,
    String,
    URL,
    Map,
    parseFloat,
    parseInt,
    isNaN,
    Set,
  })
  ;["utils.js", "components.js", "renderers.js", "adapters.js", "compare.js"].forEach((file) => {
    const fullPath = path.join(__dirname, "..", file)
    const code = fs.readFileSync(fullPath, "utf8")
    vm.runInContext(code, context, { filename: file })
  })
  return context
}

test("linkKnownSources does not produce nested <a> tags for overlapping names (NBC / NBC News)", () => {
  const ctx = loadUiContext()
  const html = ctx.linkKnownSources("According to NBC News and NBC, the market will resolve.")
  assert.ok(html, "Expected at least one source to be linked")
  // One anchor for "NBC News" and a separate one for "NBC" — never a nested pair.
  assert.equal(/<a[^>]*>[^<]*<a /.test(html), false, "no nested anchor tags")
  assert.ok(html.includes(">NBC News</a>"))
  assert.ok(/>NBC<\/a>/.test(html))
})

test("plainEnglishRules keeps sentences whose verbs are conjugated (resolves/settles/ended)", () => {
  const ctx = loadUiContext()
  const raw = [
    "This market resolves YES if Team A wins the championship.",
    "The contract settled based on the closing price on December 31, 2024.",
    "Trading ended when the event was officially called.",
  ].join(" ")
  const sentences = ctx.plainEnglishRules(raw)
  assert.ok(sentences.length >= 3, `expected 3+ sentences, got ${sentences.length}: ${JSON.stringify(sentences)}`)
})

test("Kalshi binary NO outcome omits bid/ask when YES has no quote (no bogus 0¢/0¢)", () => {
  const ctx = loadUiContext()
  const norm = ctx.normalizeKalshi({
    title: "Example binary market",
    category: "Markets",
    markets: [{
      ticker: "KX-EXAMPLE",
      title: "Example binary market",
      yes_sub_title: "Yes",
      status: "active",
      last_price_dollars: "0.37",
      yes_bid_dollars: "0",
      yes_ask_dollars: "0",
      volume_fp: 0,
      volume_24h_fp: 0,
      open_interest_fp: 0,
    }],
    product_metadata: {},
  })
  assert.equal(norm.outcomes.length, 2, "binary should expand to YES + NO")
  const no = norm.outcomes[1]
  assert.equal(no.label, "NO")
  assert.equal(no.bid, undefined, "NO bid should be undefined when YES ask missing")
  assert.equal(no.ask, undefined, "NO ask should be undefined when YES bid missing")
})

test("Kalshi binary NO outcome still derives bid/ask from valid YES quotes", () => {
  const ctx = loadUiContext()
  const norm = ctx.normalizeKalshi({
    title: "Example binary market",
    category: "Markets",
    markets: [{
      ticker: "KX-EXAMPLE",
      title: "Example binary market",
      yes_sub_title: "Yes",
      status: "active",
      last_price_dollars: "0.40",
      yes_bid_dollars: "0.39",
      yes_ask_dollars: "0.41",
      volume_fp: 0,
      volume_24h_fp: 0,
      open_interest_fp: 0,
    }],
    product_metadata: {},
  })
  const no = norm.outcomes[1]
  // NO_bid = 1 - YES_ask = 0.59 ; NO_ask = 1 - YES_bid = 0.61
  assert.ok(Math.abs(no.bid - 0.59) < 1e-9, `no.bid should be ~0.59 got ${no.bid}`)
  assert.ok(Math.abs(no.ask - 0.61) < 1e-9, `no.ask should be ~0.61 got ${no.ask}`)
})

test("compare.js overround is ~100% for a single-market binary Kalshi event (not 50%)", () => {
  const ctx = loadUiContext()
  const meta = ctx.extractTopOutcomes("kalshi", {
    event: {
      title: "Example binary market",
      markets: [{
        ticker: "KX-EXAMPLE",
        title: "Example binary market",
        yes_sub_title: "Yes",
        yes_bid_dollars: "0.49",
        yes_ask_dollars: "0.51",
        last_price_dollars: "0.50",
        volume_fp: 0,
        volume_24h_fp: 0,
        open_interest_fp: 0,
      }],
    },
  })
  const overroundStat = meta.stats.find(s => s.label === "Overround")
  assert.ok(overroundStat, "overround stat should exist")
  // Expect round-trip cost: YES_ask + NO_ask = 0.51 + (1 - 0.49) = 1.02 → 102%
  const pct = parseInt(overroundStat.value, 10)
  assert.ok(pct >= 95 && pct <= 110, `overround should be ~100% for binary, got ${overroundStat.value}`)
})

test("resolutionConfidenceScore does not penalise the month name 'May' used in a date", () => {
  const ctx = loadUiContext()
  const withMayDate = "This market resolves YES if the official report published by the government on May 15, 2024 shows inflation above 3%."
  const withModal = "This market may be resolved at the sole discretion of the platform if data is unavailable."
  const confA = ctx._resolutionConfidenceScore(withMayDate)
  const confB = ctx._resolutionConfidenceScore(withModal)
  assert.ok(confA, "expected a confidence score")
  assert.ok(confB, "expected a confidence score")
  assert.ok(
    confA.score > confB.score,
    `date-only 'May' should not be penalised like a modal 'may be' — got ${confA.score} vs ${confB.score}`,
  )
})

test("outcomeRow wraps label text in .outcome-name-text so arrows can be excluded from snapshots", () => {
  const ctx = loadUiContext()
  const html = ctx.outcomeRow("Team A", "", 60, "#22c55e", 3)
  assert.ok(html.includes(`<span class="outcome-name-text">Team A</span>`))
  // The momentum arrow should live outside the label-text span
  assert.ok(/outcome-name-text">Team A<\/span>\s*<span class="momentum-arrow/.test(html))
})

test("findSimilarMarketsCard 'Search Polymarket' link points to /search?q= (the homepage silently ignores ?q=)", () => {
  const ctx = loadUiContext()
  const html = ctx.findSimilarMarketsCard("kalshi", "Will the Fed cut rates in December 2025")
  // /search?q=… 301-redirects to /predictions?_q=… and actually filters; the homepage's ?q=… is ignored.
  assert.ok(/href="https:\/\/polymarket\.com\/search\?q=[^"]+"/.test(html), "Search Polymarket link should hit /search?q=, not /?q=")
  assert.ok(!/href="https:\/\/polymarket\.com\/\?q=/.test(html), "Search Polymarket link should not point to the homepage with ?q=")
})

test("findSimilarMarketsCard 'Browse Gemini' link points to /predictions (not /prediction-markets, which is the JSON API)", () => {
  const ctx = loadUiContext()
  const html = ctx.findSimilarMarketsCard("kalshi", "Crypto price market for the next quarter")
  // /prediction-markets returns Content-Type: application/json — clicking it lands the user on a raw JSON dump.
  assert.ok(/href="https:\/\/www\.gemini\.com\/predictions"/.test(html), "Browse Gemini link should point to /predictions")
  assert.ok(!/href="https:\/\/www\.gemini\.com\/prediction-markets"/.test(html), "Browse Gemini link should not point to the JSON API endpoint")
})

test("compare.js Coinbase footnote no longer exclusively claims 'Powered by Kalshi' (Coinbase has both Kalshi and Polymarket-backed products)", () => {
  // Top-level `const` declarations in vm.runInContext don't surface on the context object,
  // so read the footnotes table directly from the source file.
  const src = fs.readFileSync(path.join(__dirname, "..", "compare.js"), "utf8")
  const tableMatch = src.match(/const PLATFORM_FOOTNOTES\s*=\s*\{([\s\S]*?)\}/)
  assert.ok(tableMatch, "PLATFORM_FOOTNOTES table should be defined in compare.js")
  const coinbaseLine = tableMatch[1].split("\n").find(l => /^\s*coinbase\s*:/.test(l)) || ""
  assert.ok(coinbaseLine, "coinbase footnote line should exist in PLATFORM_FOOTNOTES")
  // Both backings must be acknowledged: predict.coinbase.com/markets/<slug> is Polymarket-backed
  // and www.coinbase.com/predictions/event/<TICKER> is Kalshi-backed.
  assert.ok(/Kalshi/.test(coinbaseLine) && /Polymarket/.test(coinbaseLine),
    `coinbase footnote should mention both Kalshi and Polymarket: got ${coinbaseLine.trim()}`)
})

test("compare.js extractTopOutcomes('coinbase', polymarketArray) returns the Polymarket top outcomes (not empty)", () => {
  const ctx = loadUiContext()
  // Polymarket gamma API returns an array of events. predict.coinbase.com/markets/<slug> resolves to this shape.
  const polymarketShape = [{
    title: "Coinbase Predict — example binary",
    volume: 1000, volume24hr: 100, openInterest: 0, liquidity: 500,
    markets: [{
      outcomes: JSON.stringify(["Yes", "No"]),
      outcomePrices: JSON.stringify(["0.62", "0.38"]),
      bestBid: "0.61", bestAsk: "0.63",
    }],
  }]
  const meta = ctx.extractTopOutcomes("coinbase", polymarketShape)
  assert.equal(meta.title, "Coinbase Predict — example binary", "title should be propagated from the Polymarket event")
  assert.ok(Array.isArray(meta.topOutcomes) && meta.topOutcomes.length === 2, `expected 2 top outcomes for binary Polymarket-backed Coinbase, got ${meta.topOutcomes.length}`)
  assert.equal(meta.topOutcomes[0].pct, 62)
  assert.equal(meta.topOutcomes[1].pct, 38)
})
