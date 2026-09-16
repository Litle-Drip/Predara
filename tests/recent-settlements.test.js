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
  assert.match(slot.innerHTML, /Awaiting result data/)
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

  assert.match(slot.innerHTML, /Awaiting result data/)
  assert.doesNotMatch(slot.innerHTML, /Settled:/)
  assert.match(slot.innerHTML, /only when Gemini publishes a winning side/)
})