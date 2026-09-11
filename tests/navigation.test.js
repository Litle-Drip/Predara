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

test("the shared header stays anchored while narrow pages keep readable content", () => {
  const analyze = read("index.html")
  assert.ok(analyze.includes(".app { max-width: 1200px; margin: 0 auto; }"))

  for (const page of ["settlement.html", "kyle.html"]) {
    const html = read(page)
    assert.match(html, /\.app\s*\{\s*max-width:\s*1200px/)
    assert.ok(html.includes(".app > :not(.app-header) { width: min(800px, 100%)"))
    assert.ok(html.includes("padding: 52px 32px 96px"))
  }
})

test("page switching is softened and respects reduced-motion preferences", () => {
  for (const page of PAGES) {
    const html = read(page)
    assert.ok(html.includes("@view-transition { navigation: auto; }"), `${page} does not opt into cross-page transitions`)
    assert.ok(html.includes("@media (prefers-reduced-motion: reduce)"), `${page} has no reduced-motion override`)
  }
})

test("all page headers switch to the same non-overlapping two-row layout", () => {
  for (const page of PAGES) {
    const html = read(page)
    assert.ok(html.includes("@media (max-width: 760px)"), `${page} does not use the shared header breakpoint`)
    const responsiveHeader = html.slice(html.indexOf("@media (max-width: 760px)"), html.indexOf("@media (max-width: 760px)") + 900)
    assert.ok(responsiveHeader.includes("grid-template-columns: minmax(0, 1fr) auto"), `${page} can collapse its brand into its tools`)
    assert.match(responsiveHeader, /grid-column:\s*1\s*\/\s*-1/, `${page} does not move its page tabs to a full-width row`)
  }
})

test("all page shells keep identical geometry through the phone breakpoint", () => {
  for (const page of PAGES) {
    const html = read(page)
    const phone = html.slice(html.indexOf("@media (max-width: 640px)"), html.indexOf("@media (max-width: 640px)") + 500)
    assert.ok(phone.includes("body { padding: 20px 14px 64px; }"), `${page} uses different phone page bounds`)
    assert.ok(phone.includes(".app-header { margin-bottom: 24px; }"), `${page} uses different phone header spacing`)
    assert.ok(phone.includes(".app-title") && phone.includes("font-size: 18px"), `${page} uses different phone branding size`)
  }

  for (const page of ["settlement.html", "kyle.html"]) {
    const html = read(page)
    const header = html.slice(html.indexOf(".app-header {"), html.indexOf(".app-header {") + 240)
    assert.ok(header.includes("gap: 10px"), `${page} uses a different desktop nav/tool gap`)
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
