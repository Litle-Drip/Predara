const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const ROOT = path.join(__dirname, "..")
const PAGES = ["index.html", "settlement.html", "kyle.html"]
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8")

// Every page must reach every other page. The Kyle tab was missing from the
// Settlement Desk header for returning users, so this is checked rather than
// assumed — in the markup here, and in the caching rule that decides whether a
// user is actually served this markup (below).
test("every page links to every other page", () => {
  const targets = { "index.html": 'href="/"', "settlement.html": 'href="/settlement.html"', "kyle.html": 'href="/kyle.html"' }
  for (const page of PAGES) {
    const html = read(page)
    for (const [target, href] of Object.entries(targets)) {
      assert.ok(html.includes(href), `${page} has no link to ${target}`)
    }
  }
})

test("the current page is the one marked active in its own nav", () => {
  const expected = {
    "index.html": 'class="mode-tab active" href="/"',
    "settlement.html": '<a href="/settlement.html" class="active"',
    "kyle.html": '<a href="/kyle.html" class="active"',
  }
  for (const [page, marker] of Object.entries(expected)) {
    assert.ok(read(page).includes(marker), `${page} does not mark itself as the active tab`)
  }
})

// ── Service worker ────────────────────────────────────────────────────────────
// A page carries the site's navigation, so a cache-first service worker strands
// returning users on an old version of the app: that is exactly how the Kyle
// tab went missing from a header that has always had it in source.
test("pages are served network-first so a deploy is never one visit behind", () => {
  const sw = read("sw.js")
  const navBranch = sw.slice(sw.indexOf("if (isPageRequest("), sw.indexOf("// ── Assets"))
  assert.ok(navBranch.includes("fetch(e.request)"), "a page request must hit the network first")
  assert.ok(
    navBranch.indexOf("fetch(e.request)") < navBranch.indexOf("caches.match"),
    "the cache may only be consulted after the network fails"
  )
  assert.match(navBranch, /catch/, "an offline page must still fall back to the cache")
})

test("assets stay cache-first, so the offline shell is not given up", () => {
  const sw = read("sw.js")
  const assetBranch = sw.slice(sw.indexOf("// ── Assets"))
  assert.ok(
    assetBranch.indexOf("caches.match") < assetBranch.indexOf("fetch(e.request)"),
    "assets should be served from cache first and refreshed behind it"
  )
})

test("every page is precached, so the app opens offline", () => {
  const sw = read("sw.js")
  for (const page of PAGES) {
    assert.ok(sw.includes(`"/${page}"`), `${page} is not in the service worker precache`)
  }
  assert.ok(sw.includes('"/kyle.js"'), "kyle.js is not precached")
})

test("the cache name is bumped, so poisoned caches are cleared on this deploy", () => {
  // Compare the version as a number, not as a digit pattern. This was written
  // as /predara-v[3-9]\d*/ when v3 was current, which stopped matching at v10 —
  // the assertion failed on a correct bump, for no reason but its own spelling.
  const sw = read("sw.js")
  const found = sw.match(/CACHE_NAME = "predara-v(\d+)"/)
  assert.ok(found, "sw.js must declare a versioned CACHE_NAME")
  assert.ok(Number(found[1]) >= 3,
    `CACHE_NAME is at v${found[1]}; it must move past the version that served poisoned HTML`)
})
