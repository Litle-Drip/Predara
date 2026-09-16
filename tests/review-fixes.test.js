// Regressions from a full-repo review. Each test below is a bug that shipped,
// written as the thing that was actually wrong rather than as a unit of code:
// the kyle.js cases are sentences that reached a customer, and the compare.js
// cases are numbers a reader would have traded on.

const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const http = require("node:http")
const { spawn } = require("node:child_process")

const ROOT = path.join(__dirname, "..")
const kyle = require("../kyle.js")
const match = require("../lib/match.js")

// ── Static file server: dotfiles are not web assets ───────────────────────────

test("the static server refuses dotted paths instead of serving the repo", async () => {
  // STATIC_ROOT is the repo root, so /.git/config was served with a 200 —
  // handing any unauthenticated caller the remote and the object store behind
  // it. .replit publishes this server on port 80.
  const port = 5300 + (process.pid % 200)
  const proc = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
  })
  const get = (p) => new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: p }, (res) => {
      let body = ""
      res.on("data", (c) => { body += c })
      res.on("end", () => resolve({ status: res.statusCode, body }))
    })
    req.on("error", reject)
    req.setTimeout(4000, () => { req.destroy(); reject(new Error("timeout")) })
  })
  // Wait for listen without polling the clock harder than needed.
  let up = false
  for (let i = 0; i < 40 && !up; i++) {
    try { await get("/index.html"); up = true } catch { await new Promise(r => setTimeout(r, 100)) }
  }
  try {
    assert.ok(up, "server never came up")
    for (const p of ["/.git/config", "/.git/HEAD", "/.replit", "/.env",
      "/server.js", "/tests/review-fixes.test.js", "/package-lock.json",
      "/attached_assets/Pasted-file.txt", "/kyle-themes/README.md"]) {
      const res = await get(p)
      assert.equal(res.status, 403, `${p} must not be served (got ${res.status})`)
      assert.ok(!/remote "origin"/.test(res.body), `${p} leaked git config`)
    }
    // The real pages still work.
    assert.equal((await get("/index.html")).status, 200)
    assert.equal((await get("/kyle-themes/astro.jpg")).status, 200)
  } finally {
    proc.kill()
  }
})

test("settlement review rejects an oversized body with one 413 response", async () => {
  const port = 5500 + (process.pid % 200)
  const proc = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
  })
  const post = (body) => new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port, path: "/api/settlement-review", method: "POST",
      headers: {
        Origin: "https://predara.org", "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let response = ""
      res.on("data", c => { response += c })
      res.on("end", () => resolve({ status: res.statusCode, response }))
    })
    req.on("error", reject)
    req.setTimeout(4000, () => { req.destroy(); reject(new Error("timeout")) })
    req.end(body)
  })
  try {
    let up = false
    for (let i = 0; i < 40 && !up; i++) {
      try {
        const probe = await new Promise((resolve, reject) => {
          http.get({ host: "127.0.0.1", port, path: "/index.html" }, (res) => {
            res.resume()
            res.on("end", () => resolve(res.statusCode))
          }).on("error", reject)
        })
        up = probe === 200
      } catch { await new Promise(r => setTimeout(r, 100)) }
    }
    assert.ok(up, "server never came up")
    const result = await post(JSON.stringify({ input: "x".repeat(17000) }))
    assert.equal(result.status, 413)
    assert.match(result.response, /request body too large/i)
  } finally {
    proc.kill()
  }
})

// ── lib/match.js: market-kind classification ──────────────────────────────────

test("an over/under title declares the totals kind", () => {
  // These patterns run against normalizeTitle() output, where "/" is already a
  // space — so /\bover\/under\b/ could never fire and the kind went undeclared,
  // which is what let a totals market match a moneyline.
  assert.equal(match.marketKind("Lakers vs. Celtics: Over/Under 220.5"), "total")
  assert.equal(match.marketKind("Chiefs vs Bills O/U 45.5"), "total")
})

test("a totals market is not offered as a match for the moneyline", () => {
  const totals = { platform: "polymarket", title: "Lakers vs. Celtics: Over/Under 220.5", date: "2026-11-08", outcomes: ["Over", "Under"] }
  const moneyline = { platform: "kalshi", title: "Lakers vs. Celtics Winner", date: "2026-11-08", outcomes: [] }
  const r = match.scoreMatch(totals, moneyline)
  assert.equal(r.disqualified, "different market type (total vs winner)")
  assert.equal(r.score, 0)
})

test("\"Total Points\" and \"Total\" are the same kind of market", () => {
  // `points` used to be tested first, so these two disqualified each other as
  // different market types despite being the same bet.
  assert.equal(match.marketKind("Chiefs vs Bills Total Points"), "total")
  const a = { platform: "kalshi", title: "Chiefs vs Bills Total Points", date: "2026-11-08", outcomes: ["Over 45.5", "Under 45.5"] }
  const b = { platform: "polymarket", title: "Chiefs vs Bills Total", date: "2026-11-08", outcomes: ["Over", "Under"] }
  assert.equal(match.scoreMatch(a, b).disqualified, null)
})

// ── kyle.js: what the agent tells the customer ────────────────────────────────

const NOW = Date.parse("2026-06-15T12:00:00Z")
const at = (h) => new Date(NOW + h * 3600000).toISOString()

function focusOn(status) {
  const event = {
    ticker: "ABC26", title: "Race", status, closeDate: at(48),
    contracts: [{ label: "Albon", instrumentSymbol: "GEMI-ABC26-ALB", prices: { bestAsk: "0.11" } }],
  }
  const brief = kyle.kyleBrief(event, NOW, { focusSymbol: "GEMI-ABC26-ALB" })
  return { brief, focus: kyle.kyleFocusAnswer(brief, NOW) }
}

test("the pasted contract is not called \"still trading\" on a cancelled event", () => {
  // This is the first thing on the page and it said a cancelled event was live,
  // then invited the agent to tell the customer they could still sell it.
  const { focus } = focusOn("cancelled")
  assert.equal(focus.verdict, "voided")
  assert.doesNotMatch(focus.line, /still trading/i)
  assert.doesNotMatch(focus.note, /can still buy or sell/i)
})

test("the pasted contract is not called \"still trading\" once trading closed", () => {
  const { focus } = focusOn("closed")
  assert.equal(focus.verdict, "closed")
  assert.doesNotMatch(focus.line, /still trading/i)
})

test("a cancelled event is not promised a result", () => {
  const { brief } = focusOn("cancelled")
  assert.equal(brief.status.code, "voided")
  assert.doesNotMatch(brief.resolution.text, /result is published after that/i)
  assert.match(brief.resolution.text, /will not resolve/i)
})

test("a close time that has not passed is never described as past", () => {
  // Gemini can report trading closed while publishing a future close time.
  // "Trading stopped in 4 hours" — and, in copied text, "Trading closed
  // <future timestamp>" — states the clock backwards.
  const event = { ticker: "X", title: "T", status: "pending", closeDate: at(4), contracts: [{ label: "Yes" }] }
  const brief = kyle.kyleBrief(event, NOW, {})
  assert.equal(brief.status.code, "closed")
  for (const relative of [true, false]) {
    const line = kyle.kyleHeadline(brief, NOW, { relative })
    assert.doesNotMatch(line, /Trading (stopped|closed) \d/,
      `a future close time is stated as past: ${line}`)
  }
})

test("a settled event does not claim unresolved contracts paid zero", () => {
  // On a top-N event where only the winner published a side, the headline said
  // "every other contract settles at zero" while the focus card on the same
  // page correctly said that contract's result was not published.
  const event = {
    ticker: "P", title: "Podium", status: "settled", template: "binary",
    resolvedAt: "2026-06-14T18:00:00Z",
    contracts: [
      { label: "Verstappen", instrumentSymbol: "S-VER", resolutionSide: "yes", strike: { value: 3 } },
      { label: "Albon", instrumentSymbol: "S-ALB", strike: { value: 3 } },
      { label: "Norris", instrumentSymbol: "S-NOR", strike: { value: 3 } },
    ],
  }
  const brief = kyle.kyleBrief(event, NOW, { focusSymbol: "S-ALB" })
  const headline = kyle.kyleHeadline(brief, NOW, { relative: false })
  assert.doesNotMatch(headline, /every other contract settles at zero/i)
  assert.match(headline, /no published result/i)

  // With every side published, the plain statement is correct and stays.
  const settled = JSON.parse(JSON.stringify(event))
  settled.contracts[1].resolutionSide = "no"
  settled.contracts[2].resolutionSide = "no"
  assert.match(kyle.kyleHeadline(kyle.kyleBrief(settled, NOW, {}), NOW, { relative: false }),
    /Every other contract settles at zero/i)
})

test("a live multi-winner market is not described in the past tense", () => {
  const event = {
    ticker: "P", title: "Podium", status: "active", template: "binary", closeDate: at(24),
    contracts: [
      { label: "Verstappen", strike: { value: 3 } },
      { label: "Albon", strike: { value: 3 } },
      { label: "Norris", strike: { value: 3 } },
    ],
  }
  const brief = kyle.kyleBrief(event, NOW, {})
  assert.equal(brief.status.code, "open")
  assert.equal(brief.type.exclusive, false)
  assert.doesNotMatch(brief.type.plain, /settled with more than one/i)
  assert.doesNotMatch(brief.type.plain, /had several winners/i)
})

test("the settlement-delay flag does not round the wait upward", () => {
  const event = { ticker: "D", title: "T", status: "closed", closeDate: at(-36), contracts: [{ label: "Yes" }] }
  const titles = kyle.kyleIssues(event, NOW).map((i) => i.title)
  assert.ok(titles.some((t) => /Unresolved 1 day after/.test(t)),
    `36 hours should read as 1 day, got: ${titles.join(" | ")}`)
})

test("a terms link is dropped unless it is http(s)", () => {
  const event = { ticker: "T", title: "T", termsLink: "javascript:alert(1)", contracts: [{ label: "Yes" }] }
  assert.equal(kyle.kyleBrief(event, NOW, {}).links.terms, "")
  const ok = { ticker: "T", title: "T", termsLink: "https://www.gemini.com/terms.pdf", contracts: [{ label: "Yes" }] }
  assert.equal(kyle.kyleBrief(ok, NOW, {}).links.terms, "https://www.gemini.com/terms.pdf")
})

// ── Browser bundle: escaping and price comparison ─────────────────────────────

function loadBrowser(files) {
  const context = vm.createContext({
    console, window: {}, Date, Math, Number, String, URL, Map, Set, JSON,
    Array, Object, RegExp, parseFloat, parseInt, isNaN, isFinite, fetch: () => {},
  })
  for (const f of files) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), context, { filename: f })
  }
  return context
}

test("safeUrl passes http(s) through and drops every other scheme", () => {
  const { safeUrl } = loadBrowser(["utils.js"])
  assert.equal(safeUrl("https://kalshi.com/events/X"), "https://kalshi.com/events/X")
  for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "data:text/html,<script>", "vbscript:x", null, ""]) {
    assert.equal(safeUrl(bad), "", `expected drop: ${String(bad)}`)
  }
})

test("a javascript: market URL never reaches the trade button's href", () => {
  // ?q= is auto-analyzed on load and the platform is picked by substring, so a
  // crafted link put a javascript: URL behind the primary call to action.
  const ctx = loadBrowser(["utils.js", "components.js"])
  const html = ctx.tradeCtaHtml("javascript:alert(document.domain)//kalshi.com/events/X", "kalshi", false)
  assert.equal(html, "", "a non-http(s) source URL must not render a trade link")
  assert.match(ctx.tradeCtaHtml("https://kalshi.com/events/X", "kalshi", false), /href="https:\/\/kalshi\.com\/events\/X"/)
})

test("the show-more pool does not hand escaped markup back as live HTML", () => {
  // The rows are escaped HTML stored in a data- attribute. The parser decodes
  // an attribute once on the way out, so escaping only `"` returned
  // `<img onerror=...>` as real markup for innerHTML to run.
  const ctx = loadBrowser(["utils.js", "components.js"])
  const rows = Array.from({ length: 12 }, (_, i) =>
    `<div class="outcome-row"><span class="outcome-name-text">${ctx.esc(i === 11 ? '<img src=x onerror=alert(1)>' : "Outcome " + i)}</span></div>`)
  const html = ctx.buildOutcomesHtml(rows)
  const attr = html.match(/data-rows="([^"]*)"/)[1]
  // Decode the attribute the way an HTML parser would, then re-parse the JSON.
  const decoded = attr
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
  const pool = JSON.parse(decoded)
  assert.ok(!pool.join("").includes("<img src=x onerror="),
    "esc() was undone by the attribute round-trip — innerHTML would run this")
})

test("Kalshi rules text and Gemini contract names are escaped into the bet card", () => {
  const ctx = loadBrowser(["utils.js", "components.js", "renderers.js", "adapters.js"])
  const kalshi = ctx.normalizeKalshi({
    title: "T", event_ticker: "T", markets: [{
      yes_sub_title: "Yes", ticker: "T-1", status: "active",
      rules_primary: 'If <img src=x onerror="alert(1)"> happens, then the market resolves to Yes',
      last_price_dollars: "0.5", yes_bid_dollars: "0.49", yes_ask_dollars: "0.51",
    }],
  })
  assert.ok(!String(kalshi.betExplainerText).includes("<img"),
    `unescaped rules text: ${kalshi.betExplainerText}`)

  const gemini = ctx.normalizeGemini({
    title: "T", ticker: "T", status: "active",
    contracts: [
      { label: "<img src=x onerror=alert(1)>", prices: { bestAsk: "0.5" } },
      { label: "Bravo", prices: { bestAsk: "0.5" } },
    ],
  })
  assert.ok(!String(gemini.betExplainerText).includes("<img"),
    `unescaped contract name: ${gemini.betExplainerText}`)
})

// ── compare.js: cross-venue prices ────────────────────────────────────────────

function compareCtx() {
  return loadBrowser(["utils.js", "components.js", "renderers.js", "adapters.js", "compare.js"])
}

test("a grouped Polymarket event lists its candidates, not Yes/No", () => {
  // Each candidate is its own Yes/No market named in groupItemTitle. Reading
  // the inline outcomes produced a list of "No" rows carrying the long-shots'
  // complements — no names, and the wrong probabilities on top.
  const ctx = compareCtx()
  const meta = ctx.extractTopOutcomes("polymarket", {
    title: "F1 Spanish GP Winner",
    markets: [
      { groupItemTitle: "Verstappen", outcomes: '["Yes","No"]', outcomePrices: '["0.40","0.60"]' },
      { groupItemTitle: "Norris", outcomes: '["Yes","No"]', outcomePrices: '["0.35","0.65"]' },
      { groupItemTitle: "Antonelli", outcomes: '["Yes","No"]', outcomePrices: '["0.05","0.95"]' },
    ],
  })
  // Round-tripped through JSON: the adapter runs in its own vm realm, so its
  // arrays are not deepStrictEqual to plain ones here.
  const rows = JSON.parse(JSON.stringify(meta.topOutcomes))
  assert.deepEqual(rows.map((o) => o.name), ["Verstappen", "Norris", "Antonelli"])
  assert.deepEqual(rows.map((o) => o.pct), [40, 35, 5])
})

function venues(ctx, kalshiYes, geminiYes) {
  const kalshi = {
    platform: "kalshi", error: null,
    meta: ctx.extractTopOutcomes("kalshi", { event: { title: "T", markets: [
      { yes_sub_title: "Yes", last_price_dollars: String(kalshiYes), yes_bid_dollars: String(kalshiYes - 0.01), yes_ask_dollars: String(kalshiYes + 0.01) },
      { yes_sub_title: "No", last_price_dollars: String(1 - kalshiYes), yes_bid_dollars: String(0.99 - kalshiYes), yes_ask_dollars: String(1.01 - kalshiYes) },
    ] } }),
  }
  const gemini = {
    platform: "gemini", error: null,
    meta: ctx.extractTopOutcomes("gemini", { title: "T", contracts: [
      { label: "Yes", prices: { bestAsk: String(geminiYes), bestBid: String(geminiYes - 0.01), lastTradePrice: String(geminiYes) } },
      { label: "No", prices: { bestAsk: String(1 - geminiYes), bestBid: String(0.99 - geminiYes), lastTradePrice: String(1 - geminiYes) } },
    ] }),
  }
  return [kalshi, gemini]
}

test("divergence compares YES against YES, not YES against NO", () => {
  // Outcomes were re-keyed by price RANK, so a market whose favourite side
  // differed between venues had its "Yes" keyed __LEAD__ on one side and
  // __TRAIL__ on the other: Kalshi Yes 80 was compared against Gemini No 55
  // and reported a 25-point gap where the real YES disagreement was 35.
  const ctx = compareCtx()
  const html = ctx.renderComparison(venues(ctx, 0.80, 0.45))
  const m = html.match(/disagree by (\d+) points on &ldquo;([^&]*)&rdquo;/)
  assert.ok(m, "expected a divergence callout")
  assert.equal(m[1], "35")
  assert.equal(m[2].toLowerCase(), "yes")
})

test("a price difference is never presented as guaranteed profit", () => {
  // The old test reduced to 100 - |yesA - yesB| < 100, true for any difference
  // at all, and the NO leg was the complement of a midpoint rather than a
  // quoted ask — so a 1-point gap was reported as risk-free money.
  const ctx = compareCtx()
  for (const [a, b] of [[0.52, 0.51], [0.80, 0.45], [0.30, 0.29]]) {
    const html = ctx.renderComparison(venues(ctx, a, b))
    assert.doesNotMatch(html, /guaranteed profit/i, `guaranteed profit claimed for ${a} vs ${b}`)
    assert.doesNotMatch(html, /ARB OPPORTUNITY/i, `arb claimed for ${a} vs ${b}`)
    assert.doesNotMatch(html, /% ROI/, `ROI claimed for ${a} vs ${b}`)
  }
  // The gap itself is still surfaced, stated as a gap.
  const html = ctx.renderComparison(venues(ctx, 0.52, 0.51))
  assert.match(html, /CROSS-VENUE PRICE GAP/)
  assert.match(html, /priced 1 point apart/)
})

// ── Second pass: quotes, sides, and claims left over from the first review ────

test("a contract quoting only an ask shows no bid rather than a fake one", () => {
  // geminiExtractPrice prefers the ASK, so falling back to it for the bid
  // rendered "Bid 64¢ · Ask 64¢" — a zero spread, and a bid nobody is
  // offering. The Kalshi path refuses the same thing for the derived NO side.
  const ctx = loadBrowser(["utils.js", "components.js", "renderers.js", "adapters.js"])
  const askOnly = ctx.normalizeGemini({
    title: "T", ticker: "T", status: "active", type: "binary",
    contracts: [{ label: "Up", prices: { bestAsk: "0.64" } }],
  })
  const yes = askOnly.outcomes[0]
  assert.equal(yes.bid, undefined, "a spread must not be shown without a real bid")
  assert.equal(yes.ask, undefined)

  // A real two-sided book is still reported.
  const real = ctx.normalizeGemini({
    title: "T", ticker: "T", status: "active", type: "binary",
    contracts: [{ label: "Up", prices: { bestAsk: "0.64", bestBid: "0.61" } }],
  })
  assert.equal(real.outcomes[0].bid, 0.61)
  assert.equal(real.outcomes[0].ask, 0.64)
})

test("the same applies to each contract of a multi-outcome market", () => {
  const ctx = loadBrowser(["utils.js", "components.js", "renderers.js", "adapters.js"])
  const norm = ctx.normalizeGemini({
    title: "T", ticker: "T", status: "active",
    contracts: [
      { label: "Alpha", prices: { bestAsk: "0.50" } },
      { label: "Bravo", prices: { bestAsk: "0.30", bestBid: "0.28" } },
      { label: "Chuck", prices: { bestAsk: "0.20" } },
    ],
  })
  const rows = JSON.parse(JSON.stringify(norm.outcomes))
  const alpha = rows.find((o) => o.label === "Alpha")
  const bravo = rows.find((o) => o.label === "Bravo")
  assert.equal(alpha.bid, undefined, "ask-only contract must not report a bid")
  assert.equal(bravo.bid, 0.28, "a real bid is still reported")
})

test("a NO side chosen earlier does not price a market that has no NO", () => {
  // The side is carried across markets but the toggle only renders for binary
  // ones, so the calculator said "If NO wins" on a pick-one market with no NO
  // side and no control on screen to undo it.
  const ctx = loadBrowser(["utils.js", "components.js", "renderers.js", "adapters.js"])
  ctx.window._simMarket = { amount: 10, pct: 0, platform: "gemini", side: "no" }
  const multi = [
    { label: "Alpha", pct: 50, bid: 0.49, ask: 0.51, color: "#1" },
    { label: "Bravo", pct: 30, bid: 0.29, ask: 0.31, color: "#2" },
    { label: "Chuck", pct: 20, bid: 0.19, ask: 0.21, color: "#3" },
  ]
  // The side name sits inside markup ("If <strong>NO</strong> wins"), so
  // compare against the text rather than the raw HTML.
  const text = (html) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ")
  const html = ctx.betSimulatorHtml(multi)
  assert.ok(!/betSimSideToggle/.test(html), "a pick-one market has no side toggle")
  assert.doesNotMatch(text(html), /If NO wins/, "must not price a NO side that does not exist")
  assert.match(text(html), /If YES wins/)
  assert.equal(ctx.window._simMarket.side, "yes", "the stale side is reset, not inherited")

  // A binary market still honours an explicit NO, with the toggle to change it.
  ctx.window._simMarket.side = "no"
  const binary = ctx.betSimulatorHtml([
    { label: "YES", pct: 60, bid: 0.59, ask: 0.61, color: "#1" },
    { label: "NO", pct: 40, bid: 0.39, ask: 0.41, color: "#2" },
  ])
  assert.match(binary, /betSimSideToggle/)
  assert.match(text(binary), /If NO wins/)
})

test("no dead code is left claiming a guaranteed profit", () => {
  // Both removed functions were unreferenced and both announced a guaranteed
  // profit from ASK prices summing below 100%, which in a real book they do
  // not. Dead code that makes a financial claim is a claim waiting to be
  // wired up.
  const features = fs.readFileSync(path.join(ROOT, "features.js"), "utf8")
  assert.doesNotMatch(features, /function arbitrageDetectorHtml/)
  assert.doesNotMatch(features, /function crossPlatformArbHtml/)
  // Nothing references them either, so neither can be revived by accident.
  for (const f of ["features.js", "compare.js", "components.js", "renderers.js", "adapters.js", "app.js", "index.html"]) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8")
    assert.ok(!/arbitrageDetectorHtml|crossPlatformArbHtml/.test(src),
      `${f} still references a removed arbitrage function`)
  }
  // The rendered-output claim itself is covered behaviourally by "a price
  // difference is never presented as guaranteed profit" above.
})

test("cached() runs the producer once for a burst of cold readers", async () => {
  // The contract says "at most once per key per TTL window", but without an
  // in-flight map every concurrent reader on a cold key ran the producer —
  // one signed upstream request each, against a shared rate limit.
  const guard = require("../lib/guard.js")
  let calls = 0
  const producer = () => new Promise((r) => setTimeout(() => { calls++; r("value") }, 20))
  const key = "burst-" + Math.random()
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => guard.cached(key, 5000, producer)))
  assert.equal(calls, 1, "the producer must run once for five concurrent cold callers")
  assert.ok(results.every((r) => r.value === "value"), "every caller gets the value")
})

test("cached() does not cache a failure", async () => {
  const guard = require("../lib/guard.js")
  const key = "fail-" + Math.random()
  const boom = () => Promise.reject(new Error("upstream down"))
  await assert.rejects(() => guard.cached(key, 5000, boom), /upstream down/)
  await assert.rejects(() => guard.cached(key, 5000, boom), /upstream down/)
  // The key is released, so the next caller retries rather than inheriting it.
  const { value } = await guard.cached(key, 5000, () => Promise.resolve("recovered"))
  assert.equal(value, "recovered")
})
