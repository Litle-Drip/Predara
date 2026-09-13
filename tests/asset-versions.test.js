// index.html busts client caches with a ?v= on every <script>. Changing a file
// without bumping it ships nothing: the browser keeps serving the copy it has,
// and the reader sees a version of the app that no longer exists on the server.
//
// That is not hypothetical. The cross-platform match feature shipped with
// compare.js edited and still requested as compare.js?v=22, so returning
// readers ran the old error handling against the new API and got "Polymarket
// API 404" — the old client's string — instead of the message the new server
// was sending. Worse, the old client never sent the venue parameter, so the
// polymarket.us lookup the same release added was never actually reached. The
// bug looked exactly like a broken feature and was a stale script.
//
// One shared version across every tag makes this a single number to move rather
// than a per-file judgement call about what a change "really" touched — the
// judgement that was got wrong. A few unchanged files re-download; that costs
// far less than a silently stale client.

const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const ROOT = path.join(__dirname, "..")

// Every page, not just index.html. Checking one page is how kyle.html sat on
// kyle.js?v=2 through every change that file ever had: the version test passed,
// index.html kept moving, and support agents kept being served a Kyle from
// twenty commits earlier — including the ask-vs-last-trade price fix and the
// exclusivity fix, both of which change what an agent tells a customer.
const PAGES = ["index.html", "kyle.html", "settlement.html", "monitor.html"]

function scriptTags(page) {
  const html = fs.readFileSync(path.join(ROOT, page), "utf8")
  return [...html.matchAll(/<script src="([^"]+\.js)(\?v=(\d+))?"/g)]
    .map(m => ({ page, src: m[1], version: m[3] }))
}

function allScriptTags() {
  return PAGES.flatMap(scriptTags).filter(s => !s.src.startsWith("http"))
}

test("every local script carries a cache-busting version", () => {
  for (const { page, src, version } of allScriptTags()) {
    assert.ok(version, `${page} loads ${src} with no ?v= — a change to it would never reach a returning reader`)
  }
})

test("all scripts share one version across every page", () => {
  const byVersion = new Map()
  for (const { page, src, version } of allScriptTags()) {
    if (!byVersion.has(version)) byVersion.set(version, [])
    byVersion.get(version).push(`${page} → ${src}`)
  }
  assert.equal(byVersion.size, 1,
    "scripts are on mixed versions. Bump every page together — picking which " +
    "files 'really' changed is how a stale client ships:\n" +
    [...byVersion].map(([v, where]) => `  ?v=${v}: ${where.join(", ")}`).join("\n"))
})

test("every versioned script is in the service worker's asset list", () => {
  // Assets are cache-first, so a script missing from the shell is fetched from
  // the network every load and is not there at all when the reader is offline.
  const sw = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8")
  const assetList = sw.split("const ASSET_URLS")[1].split("]")[0]
  for (const { src } of allScriptTags()) {
    assert.ok(assetList.includes(`"/${src}"`), `sw.js ASSET_URLS is missing /${src}`)
  }
})
