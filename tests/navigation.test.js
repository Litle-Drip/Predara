const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const ROOT = path.join(__dirname, "..")
const PAGES = ["index.html", "settlement.html", "kyle.html", "monitor.html"]
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8")
const sharedShell = read("shared-shell.css")

// One primary nav — Analyze · Monitor · Settlement Desk — identical on every
// page. Kyle is deliberately absent: it is a support tool reached by direct
// link (/kyle), checked in kyle.test.js.
const PRIMARY = [
  ["/", "Analyze"],
  ["/monitor.html", "Monitor"],
  ["/settlement.html", "Settlement Desk"],
]

function primaryNav(html) {
  const start = html.indexOf('<nav class="primary-nav"')
  assert.ok(start !== -1, "page has no primary nav")
  return html.slice(start, html.indexOf("</nav>", start))
}

test("every page carries the same three-item primary nav", () => {
  for (const page of PAGES) {
    const nav = primaryNav(read(page))
    const links = [...nav.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map(m => [m[1], m[2]])
    assert.deepEqual(links, PRIMARY, `${page} nav differs from the shared nav`)
  }
})

test("the current page is the one marked active in its own nav", () => {
  const expected = {
    "index.html": '<a href="/" class="active" aria-current="page"',
    "settlement.html": '<a href="/settlement.html" class="active" aria-current="page"',
    "monitor.html": '<a href="/monitor.html" class="active" aria-current="page"',
  }
  for (const [page, marker] of Object.entries(expected)) {
    assert.ok(primaryNav(read(page)).includes(marker), `${page} does not mark itself as the active tab`)
  }
  assert.ok(!primaryNav(read("kyle.html")).includes("active"), "Kyle is not a nav item, so nothing is active")
})

test("the tagline is gone from every header", () => {
  for (const page of PAGES) {
    const html = read(page)
    assert.ok(!html.includes("app-subtitle"), `${page} still carries the header tagline`)
    assert.ok(!html.includes("Independent prediction market intelligence</div>"), `${page} repeats the tagline`)
  }
})

test("the header holds only logo, nav and utility buttons", () => {
  for (const page of PAGES) {
    const html = read(page)
    const header = html.slice(html.indexOf('<header class="app-header">'), html.indexOf("</header>"))
    assert.ok(header.length > 0, `${page} has no shared header`)
    // Page-specific status and refresh controls overlapped the nav on Monitor.
    assert.ok(!/livePill|btnRefresh|Updated/.test(header), `${page} puts page controls in the global header`)
    for (const btn of header.matchAll(/<button class="([^"]+)"/g)) {
      if (page === "kyle.html" && btn[1].includes("k-swatch")) continue
      assert.ok(btn[1].split(" ").includes("icon-btn"), `${page} header button "${btn[1]}" is not the shared icon button`)
    }
  }
  assert.ok(read("monitor.html").includes('<div class="page-bar">'), "Monitor's status and refresh live in its page bar")
})

test("one content width for standard pages, a wide one only for Monitor", () => {
  assert.match(sharedShell, /--shell-width:\s*1200px/)
  assert.match(sharedShell, /--shell-width-wide:\s*1440px/)
  assert.match(sharedShell, /\.app\s*\{\s*max-width:\s*var\(--shell-width\)/)
  assert.ok(read("monitor.html").includes('class="app app--wide"'))
  for (const page of ["index.html", "settlement.html", "kyle.html"]) {
    const html = read(page)
    assert.ok(!html.includes("app--wide"), `${page} must use the standard width`)
    const inline = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] || ""
    assert.doesNotMatch(inline, /(^|\n)\s*\.app\s*\{/, `${page} redefines the shell width`)
  }
  for (const page of ["settlement.html", "kyle.html"]) {
    assert.ok(read(page).includes('class="app app--narrow"'))
  }
  assert.match(sharedShell, /\.app\.app--narrow\s*>\s*:not\(\.app-header\):not\(\.footer\)/)
  assert.match(sharedShell, /width:\s*min\(var\(--reading-width\),\s*100%\)/)
})

test("every page ends with the same footer", () => {
  for (const page of PAGES) {
    const html = read(page)
    const footer = html.slice(html.indexOf('<footer class="footer">'), html.indexOf("</footer>"))
    assert.ok(footer.includes('<span class="footer-brand"><span>Predara</span>'), `${page} footer brand line differs`)
    assert.ok(footer.includes('href="/#rewards"'), `${page} footer has no Rewards link`)
    assert.equal((footer.match(/class="footer-note"/g) || []).length, 1, `${page} needs exactly one disclaimer line`)
    const inline = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] || ""
    assert.doesNotMatch(inline, /(^|\n)\s*\.footer\s*\{/, `${page} restyles the shared footer`)
  }
})

test("Rewards is out of the sub-tab row and reachable by hash", () => {
  const html = read("index.html")
  const row = html.slice(html.indexOf('<div class="tab-bar"'), html.indexOf('<div id="tab-analyze"'))
  assert.ok(!/Rewards/.test(row), "Rewards should not be a sub-tab")
  assert.ok(!/tabBtn-analyze/.test(row), "Analyze is the primary nav item, not a sub-tab")
  for (const t of ["discover", "watchlist", "calendar", "tools"]) assert.ok(row.includes(`tabBtn-${t}`))
  assert.ok(html.includes('id="tab-rewards"'), "the Rewards view itself is kept")
  const features = read("features.js")
  assert.match(features, /switchTab\(_tabFromHash\(\)\)/)
  assert.match(features, /"hashchange"/)
})

test("page switching is softened and respects reduced-motion preferences", () => {
  for (const page of PAGES) {
    const html = read(page)
    assert.ok(html.includes("@view-transition { navigation: auto; }"), `${page} does not opt into cross-page transitions`)
    assert.ok(html.includes("@media (prefers-reduced-motion: reduce)"), `${page} has no reduced-motion override`)
  }
})

test("all page headers wrap to the same non-overlapping two-row layout on phones", () => {
  for (const page of PAGES) {
    assert.ok(read(page).includes('/shared-shell.css?v=42'), `${page} does not load the shared shell`)
  }
  const phone = sharedShell.slice(sharedShell.indexOf("@media (max-width: 640px)"))
  assert.match(phone, /\.app-header\s*\{[^}]*flex-wrap:\s*wrap/)
  assert.match(phone, /\.primary-nav\s*\{[^}]*flex:\s*1 1 100%/)
  assert.match(phone, /body\s*\{\s*padding:\s*20px 14px 64px/)
  assert.match(phone, /\.app\.app--narrow\s*>\s*:not\(\.app-header\):not\(\.footer\)\s*\{[^}]*width:\s*100%/)
})

test("shared shell is available offline and from the public server", () => {
  const sw = read("sw.js")
  const server = read("server.js")
  assert.ok(sw.includes('"/shared-shell.css?v=42"'))
  assert.ok(server.includes('"shared-shell.css"'))
})

test("no page redefines shared header geometry", () => {
  const sharedSelectors = [
    ".app-header",
    ".logo-link",
    ".app-logo",
    ".app-title",
    ".primary-nav",
    ".header-utils",
    ".icon-btn",
  ]

  for (const page of PAGES) {
    const inlineStyles = read(page).match(/<style>([\s\S]*?)<\/style>/)?.[1] || ""
    for (const selector of sharedSelectors) {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      assert.doesNotMatch(
        inlineStyles,
        new RegExp(`(^|[},]\\s*)${escaped}\\s*\\{`, "m"),
        `${page} redefines shared selector ${selector}`
      )
    }
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
  assert.ok(sw.includes('"/monitor.js"'), "monitor.js is not precached")
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

// The accent marks two things: the active primary nav item and a page's
// primary action. Eyebrows, links, tickers, hovers and selected states are
// neutral, so the accent keeps its meaning.
test("the accent is reserved for the primary action and the active nav", () => {
  const allowedFill = [".search-row button", ".trade-cta-btn", ".compare-submit-btn",
    ".smart-paste-banner button", ".btn-primary", ".tag-platform", ".btn-review", ".btn-key.primary"]
  for (const page of ["index.html", "settlement.html", "monitor.html"]) {
    const css = read(page).match(/<style>([\s\S]*?)<\/style>/)[1]
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, "").split("}")
    for (const rule of rules) {
      const [selector, body = ""] = rule.split("{")
      const sel = selector.trim()
      if (/^(:root|body\.light)/.test(sel) || sel.startsWith("@")) continue
      assert.doesNotMatch(body, /var\(--(orange|accent-ink|accent-tint|accent-line|accent-ring|orange-dim|orange-bg)\)/,
        `${page}: ${sel} uses the accent outside the primary action`)
      if (/var\(--accent-fill\)/.test(body)) {
        assert.ok(allowedFill.some(a => sel.endsWith(a)), `${page}: ${sel} fills with the accent but is not a primary action`)
      }
    }
  }
  assert.match(sharedShell, /\.primary-nav a\.active::after\s*\{[^}]*background:\s*var\(--orange\)/)
})
