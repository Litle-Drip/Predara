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
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8")

function scriptTags() {
  return [...html.matchAll(/<script src="([^"]+\.js)(\?v=(\d+))?"/g)]
    .map(m => ({ src: m[1], version: m[3] }))
}

test("every local script carries a cache-busting version", () => {
  for (const { src, version } of scriptTags()) {
    if (src.startsWith("http")) continue
    assert.ok(version, `${src} has no ?v= — a change to it would never reach a returning reader`)
  }
})

test("all scripts share one version, so a change is one number to bump", () => {
  const versions = [...new Set(scriptTags().filter(s => !s.src.startsWith("http")).map(s => s.version))]
  assert.equal(versions.length, 1,
    `scripts are on mixed versions (${versions.join(", ")}). Bump them all together: ` +
    "picking which files 'really' changed is how a stale client ships.")
})

test("every versioned script is in the service worker's asset list", () => {
  // Assets are cache-first, so a script missing from the shell is fetched from
  // the network every load and is not there at all when the reader is offline.
  const sw = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8")
  const assetList = sw.split("const ASSET_URLS")[1].split("]")[0]
  for (const { src } of scriptTags()) {
    if (src.startsWith("http")) continue
    assert.ok(assetList.includes(`"/${src}"`), `sw.js ASSET_URLS is missing /${src}`)
  }
})
