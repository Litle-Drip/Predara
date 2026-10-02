const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")

function loadRenderer(payload) {
  const slot = { innerHTML: "" }
  const context = vm.createContext({
    Date,
    URLSearchParams,
    fetch: async () => ({ ok: true, json: async () => payload }),
    document: { getElementById: () => slot },
    window: {},
    console,
  })
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "gemini-live.js"), "utf8"),
    context,
    { filename: "gemini-live.js" }
  )
  return { context, slot }
}

test("recent Gemini cards distinguish a published result from missing result data", async () => {
  const { context, slot } = loadRenderer({
    data: [
      {
        ticker: "PUBLISHED",
        title: "Published market",
        contracts: [{ abbreviatedName: "Yes", resolutionSide: "yes" }],
      },
      {
        ticker: "MISSING",
        title: "Closed but incomplete market",
        contracts: [{ abbreviatedName: "Yes" }],
        resolvedAt: "2026-01-01T00:00:00Z",
      },
    ],
  })

  await context.renderGeminiRecentlySettled("settlements", "pickGeminiSettled")

  assert.match(slot.innerHTML, /Result: Yes/)
  assert.match(slot.innerHTML, />Awaiting result</)
  assert.doesNotMatch(slot.innerHTML, /Result unavailable/)
  assert.match(slot.innerHTML, /does not mean Predara has verified the result/)
  assert.match(slot.innerHTML, /awaiting result data/)
})

test("an incomplete recent Gemini card never receives a settled-result label", async () => {
  const { context, slot } = loadRenderer({
    data: [{
      ticker: "NO-RESULT",
      title: "No published winner",
      resolvedAt: "2026-01-01T00:00:00Z",
      contracts: [{ abbreviatedName: "Side A", resolutionSide: "" }],
    }],
  })

  await context.renderGeminiRecentlySettled("settlements")

  assert.match(slot.innerHTML, />Awaiting result</)
  assert.doesNotMatch(slot.innerHTML, /Settled:/)
  assert.match(slot.innerHTML, /only when Gemini publishes a winning side/)
})

// ── Phase 3 feed cleanup ──────────────────────────────────────────────────────
function row(ticker, title, opts = {}) {
  return {
    ticker, title, category: opts.category || "Crypto",
    resolvedAt: "2026-01-01T15:00:00Z",
    contracts: [{ abbreviatedName: "Yes", resolutionSide: opts.awaiting ? "" : "yes" }],
  }
}

test("rows with the same title are told apart by their interval", async () => {
  const { context, slot } = loadRenderer({ data: [
    row("BTC05M2601011000", "BTC price today at 10am EDT"),
    row("BTC15M2601011000", "BTC price today at 10am EDT"),
    row("ETH-UNIQUE", "ETH price"),
  ] })
  await context.renderGeminiRecentlySettled("settlements", "pickGeminiSettled")
  assert.match(slot.innerHTML, /BTC price today at 10am EDT<span class="gem-feed-variant"> · 5-min</)
  assert.match(slot.innerHTML, /BTC price today at 10am EDT<span class="gem-feed-variant"> · 15-min</)
  assert.doesNotMatch(slot.innerHTML, /ETH price<span class="gem-feed-variant">/, "a unique title needs no variant")
})

test("published results show by default; awaiting rows wait behind a toggle; five rows then Show more", async () => {
  const data = [
    ...Array.from({ length: 6 }, (_, i) => row(`DONE${i}`, `Done ${i}`)),
    row("WAIT", "Waiting market", { awaiting: true }),
  ]
  const { context, slot } = loadRenderer({ data })
  await context.renderGeminiRecentlySettled("settlements", "pickGeminiSettled")
  const rows = [...slot.innerHTML.matchAll(/<li class="gem-feed-row([^"]*)"( hidden)?>/g)]
  assert.equal(rows.length, 7)
  assert.equal(rows.filter((r) => !r[2]).length, 5, "five rows visible at first")
  assert.ok(rows.find((r) => r[1].includes("is-awaiting"))[2], "awaiting rows are hidden by default")
  assert.match(slot.innerHTML, /class="btn-quiet gem-feed-more" onclick="gemFeedShowMore\(this\)">Show more/)
  assert.match(slot.innerHTML, /Show awaiting result/)
})

test("the category tag is dropped when every row shares it", async () => {
  const same = loadRenderer({ data: [row("A1", "A"), row("B1", "B")] })
  await same.context.renderGeminiRecentlySettled("settlements")
  assert.doesNotMatch(same.slot.innerHTML, />Crypto</)
  const mixed = loadRenderer({ data: [row("A1", "A"), row("B1", "B", { category: "Sports" })] })
  await mixed.context.renderGeminiRecentlySettled("settlements")
  assert.match(mixed.slot.innerHTML, />Crypto</)
  assert.match(mixed.slot.innerHTML, />Sports</)
})

