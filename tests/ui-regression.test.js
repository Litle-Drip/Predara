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
    parseFloat,
    parseInt,
    isNaN,
    Set,
  })
  ;["utils.js", "components.js", "renderers.js", "adapters.js"].forEach((file) => {
    const fullPath = path.join(__dirname, "..", file)
    const code = fs.readFileSync(fullPath, "utf8")
    vm.runInContext(code, context, { filename: file })
  })
  return context
}

test("Gemini resolution source label stays concise even with verbose terms text", () => {
  const ctx = loadUiContext()
  const verboseName = "Full Terms and Conditions Agreement: By trading you acknowledge all disclaimers, liabilities, exclusions, and indemnification clauses in this long legal notice."
  const normalized = ctx.normalizeGemini({
    title: "Will Team A win?",
    status: "active",
    type: "binary",
    description: "YES resolves to 1 if Team A wins.",
    contracts: [{
      prices: { lastTradePrice: "0.62", bestBid: "0.61", bestAsk: "0.63" },
      closeDate: "2026-04-01T00:00:00Z",
    }],
    settlementSources: [{
      url: "https://cdn.builder.io/cdn/v1/terms.pdf",
      name: verboseName,
    }],
  })

  assert.ok(normalized.resSourceHtml.includes("cdn.builder.io"), "Expected concise hostname label")
  assert.equal(normalized.resSourceHtml.includes("Full Terms and Conditions Agreement"), false)
})

test("Resolution source renders in a dedicated card, not the timeline card", () => {
  const ctx = loadUiContext()
  const html = ctx.renderMarket({
    platform: "gemini",
    title: "Example market",
    subtitle: "",
    statusDot: "dot-green",
    statusText: "OPEN",
    resolvedBanner: "",
    exclusiveTag: "",
    tagsHtml: "",
    staleIso: "",
    closeIso: "",
    timelineRows: '<div class="info-row">timeline row</div>',
    hasTimeline: true,
    outcomes: [{ label: "YES", sub: "", pct: 60, color: "#22c55e", delta: null }],
    stats: [{ label: "VOLUME TRADED", value: "—" }],
    analyticsSource: [],
    leadPct: 60,
    betExplainerText: "",
    ruleSentences: [],
    resSourceHtml: '<div class="info-row"><span class="info-key">Resolution source</span><span class="info-val"><a href="https://example.com">example.com</a></span></div>',
  }, "#00DCFA")

  assert.ok(html.includes("section-label\">TIMELINE"))
  assert.ok(html.includes("section-label\">RESOLUTION SOURCES"))
  assert.ok(html.indexOf("section-label\">TIMELINE") < html.indexOf("section-label\">RESOLUTION SOURCES"))
})
