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

test("Settlement Desk treats a missing Anthropic key as an action state", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "settlement.html"), "utf8")

  assert.ok(html.includes('action_required: "Action required"'))
  assert.ok(html.includes('data.needsKey ? "action_required"'))
  assert.ok(html.includes('document.getElementById("tickerInput").value = data.ticker || input'))
})

test("Position news is rendered on the Analyze homepage, not the Watchlist panel", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8")
  const features = fs.readFileSync(path.join(__dirname, "..", "features.js"), "utf8")
  const startCard = html.slice(html.indexOf('<div class="start-card"'), html.indexOf("</div><!-- /tab-analyze -->"))
  const watchlist = html.slice(html.indexOf('<div id="tab-watchlist"'), html.indexOf('<div id="tab-calendar"'))

  assert.ok(startCard.includes('id="homePositionNews"'))
  assert.equal(watchlist.includes('id="homePositionNews"'), false)
  assert.ok(features.includes("News on your positions"))
  assert.ok(features.includes("renderHomePositionNews()"))
})

test("Rewards uses a structured dashboard and collapses long live-program tables", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8")
  const features = fs.readFileSync(path.join(__dirname, "..", "features.js"), "utf8")

  assert.ok(html.includes(".rewards-program-grid"))
  assert.ok(features.includes('class="rewards-shell"'))
  assert.ok(features.includes('class="rewards-extra-row" hidden'))
  assert.ok(features.includes("toggleRewardsRows"))
})

test("Analyze input does not keep a duplicate clipboard prompt or empty hint gap", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8")
  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8")
  const features = fs.readFileSync(path.join(__dirname, "..", "features.js"), "utf8")

  assert.ok(features.includes("_sameMarketUrl(url, current)"))
  assert.ok(features.includes("_sameMarketUrl(url, analyzed)"))
  assert.ok(app.includes('document.getElementById("smartPasteBanner")'))
  assert.ok(html.includes(".input-hint:not(:empty)"))
  assert.ok(html.includes("min-height: 0"))
})

// ── Analyze start state (Phase 2 cleanup) ────────────────────────────────────
test("Analyze start state reads headline → subhead → input → examples → value points", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8")
  const tab = html.slice(html.indexOf('<div id="tab-analyze"'), html.indexOf("</div><!-- /tab-analyze -->"))
  const order = ['class="home-title"', 'class="home-sub"', 'id="urlInput"', 'id="homeExamples"', 'class="start-points']
    .map((m) => tab.indexOf(m))
  assert.ok(order.every((i) => i !== -1), "every part of the start state is present")
  assert.deepEqual([...order].sort((a, b) => a - b), order, "start state is out of order")
  const points = tab.slice(tab.indexOf('class="start-points'), tab.indexOf("</ul>"))
  assert.ok((points.match(/<li>/g) || []).length <= 3, "three value points at most")
  // No duplicate tagline or eyebrow, no feature cards, no second disclaimer.
  assert.ok(!/start-eyebrow|start-feature|start-proof|start-note|Independent market intelligence/.test(tab))
  assert.ok(!/shortcut-hint/.test(html), "the shortcut hint lives in the ? help only")
  assert.ok(/<button onclick="analyze\(\)">Analyze<\/button>/.test(tab))
})

test("first-run intro collapses for returning visitors, with a storage fallback", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8")
  const features = fs.readFileSync(path.join(__dirname, "..", "features.js"), "utf8")
  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8")
  assert.ok(html.includes("body.is-returning .home-intro"))
  assert.ok(html.includes("body.is-returning .first-run-only"))
  assert.match(app, /_logHistory\(url, _currentTitle\(\), _currentPlatform\(\)\)\n\s*if \(typeof markOnboarded === "function"\) markOnboarded\(\)/,
    "only a completed analysis marks the visitor as returning")
  assert.match(features, /_onboardedThisSession = true\n\s*try \{ localStorage\.setItem\("predara-onboarded", "1"\) \} catch/)
  assert.match(features, /new MutationObserver\(syncHomeState\)/)
})

test("News on your positions renders nothing without a saved market", () => {
  const features = fs.readFileSync(path.join(__dirname, "..", "features.js"), "utf8")
  const fn = features.slice(features.indexOf("function renderHomePositionNews()"), features.indexOf("// ── Analyze start state"))
  assert.match(fn, /if \(!bookmarks\.length\) \{\n\s*container\.innerHTML = ""\n\s*return/)
  assert.ok(!fn.includes("position-news-empty"))
})
