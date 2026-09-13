// A stat or analytics label is wrapped by tip() only when GLOSSARY has an entry
// for it, and tip() is what draws the dotted underline. So a missing entry is not
// just a missing tooltip — it renders as a label with no underline sitting beside
// siblings that have one, which reads as random emphasis rather than as "this one
// has no definition". RUNNERS shipped that way next to five underlined stats, and
// TIME REMAINING and YOUR EDGE did the same in Trader Analytics.
//
// Every label the UI actually prints is listed here, so adding a row to a card
// without defining its term fails the build rather than the design review.

const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const ROOT = path.join(__dirname, "..")
const utils = fs.readFileSync(path.join(ROOT, "utils.js"), "utf8")

function glossaryKeys() {
  const start = utils.indexOf("const GLOSSARY = {")
  assert.ok(start !== -1, "GLOSSARY not found in utils.js")
  const block = utils.slice(start, utils.indexOf("\n}", start))
  return new Set([...block.matchAll(/^\s*"([^"]+)":/gm)].map((m) => m[1]))
}

// The labels rendered by statCard() in the adapters and by analyticsCard().
const DISPLAYED = [
  "VOLUME TRADED",
  "24H VOLUME",
  "LIQUIDITY",
  "OPEN INTEREST",
  "MARKET AGE",
  "RUNNERS",
  "COMMENTS",
  "OVERROUND",
  "TIME REMAINING",
  "BREAK-EVEN",
  "YOUR EDGE",
  "SPREAD QUALITY",
]

test("every label the UI prints has a glossary entry, so underlining is uniform", () => {
  const keys = glossaryKeys()
  const missing = DISPLAYED.filter((label) => !keys.has(label))
  assert.deepEqual(missing, [],
    `these render without the dotted underline their neighbours have: ${missing.join(", ")}`)
})

test("glossary definitions are written for a first-time trader", () => {
  const keys = glossaryKeys()
  const start = utils.indexOf("const GLOSSARY = {")
  const block = utils.slice(start, utils.indexOf("\n}", start))
  for (const [, key, text] of block.matchAll(/^\s*"([^"]+)":\s*"((?:[^"\\]|\\.)*)"/gm)) {
    if (!keys.has(key)) continue
    assert.ok(text.length >= 30, `${key} has a definition too short to explain anything: "${text}"`)
    assert.ok(/[.!]$/.test(text.trim()), `${key}'s definition should be a full sentence: "${text}"`)
  }
})
