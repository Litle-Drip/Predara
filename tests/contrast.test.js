// Text contrast is arithmetic, not taste, so it is computed here rather than
// eyeballed in a screenshot.
//
// Every one of these pairings shipped failing at some point, and they all failed
// the same way: one token doing two jobs. --muted was a single grey used for
// every secondary label in the app and sat at 3.0:1; the brand orange was used
// both as a fill under white text (4.13:1) and as small text on a dark card
// (4.29:1); a single white pill label was used on four venue brand fills, which
// on Kalshi green is 2.27:1 and on Gemini cyan 1.66:1.
//
// The fix in each case was to split the token by job — see the comment on :root
// in index.html — and these assertions are what keep the split honest. WCAG 2.1
// AA is 4.5:1 for normal text and 3:1 for large text (>=24px, or >=18.66px bold).

const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const ROOT = path.join(__dirname, "..")
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8")

function luminance(hex) {
  const c = hex.replace("#", "").match(/../g).map((h) => parseInt(h, 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)))
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

// Pull a custom property out of a specific rule block, so the dark values in
// :root and the light ones in body.light are read apart rather than whichever
// happens to match first.
function token(html, block, name) {
  const start = html.indexOf(block)
  assert.ok(start !== -1, `no ${block} block found`)
  const body = html.slice(start, html.indexOf("}", start))
  const m = body.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`))
  assert.ok(m, `${block} does not define --${name}`)
  return m[1].toLowerCase()
}

const SURFACES = {
  dark: { bg: "#0f0f11", card: "#18181c", bar: "#222228" },
  light: { bg: "#f7f7f5", card: "#ffffff", bar: "#eeeeed" },
}

// index.html is the reference palette; the other two pages carry their own copy
// of it, which is exactly how --muted drifted back out of AA on two pages after
// being fixed on the third.
const PALETTE_PAGES = ["index.html", "settlement.html"]

for (const page of PALETTE_PAGES) {
  test(`${page}: --muted clears AA on every surface it is used on`, () => {
    const html = read(page)
    for (const [theme, block] of [["dark", ":root {"], ["light", "body.light {"]]) {
      const muted = token(html, block, "muted")
      for (const [name, surface] of Object.entries(SURFACES[theme])) {
        const ratio = contrast(muted, surface)
        assert.ok(ratio >= 4.5,
          `${theme} --muted ${muted} on ${name} ${surface} is ${ratio.toFixed(2)}:1, below AA 4.5:1`)
      }
    }
  })

  test(`${page}: the accent fill carries a white label at AA`, () => {
    const html = read(page)
    for (const block of [":root {", "body.light {"]) {
      const fill = token(html, block, "accent-fill")
      const ratio = contrast("#ffffff", fill)
      assert.ok(ratio >= 4.5,
        `white on --accent-fill ${fill} is ${ratio.toFixed(2)}:1, below AA 4.5:1`)
    }
  })

  test(`${page}: every *-ink token clears AA as text on bg and card`, () => {
    const html = read(page)
    for (const [theme, block] of [["dark", ":root {"], ["light", "body.light {"]]) {
      for (const name of ["accent-ink", "green-ink", "red-ink", "amber-ink"]) {
        const ink = token(html, block, name)
        for (const surface of [SURFACES[theme].bg, SURFACES[theme].card]) {
          const ratio = contrast(ink, surface)
          assert.ok(ratio >= 4.5,
            `${theme} --${name} ${ink} on ${surface} is ${ratio.toFixed(2)}:1, below AA 4.5:1`)
        }
      }
    }
  })
}

// ── Venue pills ───────────────────────────────────────────────────────────────
// The fill is each venue's own brand colour and is not ours to change, so the
// label colour is what has to vary. platformInk() picks it from the fill; this
// asserts the choice it makes actually clears AA for all four.
test("every venue pill's label clears AA against that venue's brand fill", () => {
  const utils = read("utils.js")
  const ctx = {}
  // PLATFORMS and platformInk are plain declarations at the top of utils.js.
  const src = utils.slice(0, utils.indexOf("// ── Gemini ticker input"))
  new Function("exports", src + "\nexports.PLATFORMS = PLATFORMS; exports.platformInk = platformInk")(ctx)

  const venues = Object.entries(ctx.PLATFORMS)
  assert.equal(venues.length, 4, "expected four venues")

  for (const [name, meta] of venues) {
    const ink = ctx.platformInk(meta.accent)
    const ratio = contrast(ink, meta.accent)
    assert.ok(ratio >= 4.5,
      `${name}: ${ink} on ${meta.accent} is ${ratio.toFixed(2)}:1, below AA 4.5:1`)
    // The table's declared ink and the derived one must agree, or a call site
    // reading meta.ink gets a different answer than one calling platformInk().
    assert.equal(meta.ink.toLowerCase(), ink.toLowerCase(),
      `${name}: declared ink ${meta.ink} disagrees with platformInk() ${ink}`)
  }
})

test("a white label is never put on the two bright venue fills", () => {
  const utils = read("utils.js")
  const src = utils.slice(0, utils.indexOf("// ── Gemini ticker input"))
  const ctx = {}
  new Function("exports", src + "\nexports.platformInk = platformInk")(ctx)
  // These two are the pairs that shipped broken: 2.27:1 and 1.66:1.
  for (const fill of ["#00C805", "#00DCFA"]) {
    assert.notEqual(ctx.platformInk(fill).toLowerCase(), "#ffffff",
      `${fill} is too bright to carry a white label`)
  }
})

// ── Regressions the token split is there to prevent ───────────────────────────
test("no rule dims already-muted text with opacity", () => {
  // --muted is set to clear AA exactly; an opacity on top of it puts the text
  // back under, which is how .stat-empty, .ml-label, .shortcut-hint and
  // .last-updated each ended up failing while the token itself was fine.
  const html = read("index.html")
  const offenders = []
  for (const [, name, body] of html.matchAll(/\.([-\w]+)\s*\{([^}]*)\}/g)) {
    if (!/var\(--(muted|text|text-mid)\)/.test(body)) continue
    const op = body.match(/opacity:\s*([\d.]+)/)
    // .footer-sep is a decorative "·" between links, not text to read.
    if (op && Number(op[1]) < 1 && name !== "footer-sep") offenders.push(`.${name} (opacity ${op[1]})`)
  }
  assert.deepEqual(offenders, [], `these dim text that is already at the AA floor: ${offenders.join(", ")}`)
})

test("accent text goes through the ink token, never the raw brand accent", () => {
  // color: var(--orange) is the brand accent used as text; on a dark card that
  // is 4.29:1. Inline style="color:var(--orange)" in the renderers had the same
  // problem and is why .link-accent exists.
  const cssOffenders = read("index.html").split("\n")
    .filter((l) => /[\s{;]color:\s*var\(--orange\)/.test(l))
  assert.deepEqual(cssOffenders, [], "use --accent-ink for accent-coloured text")

  for (const file of ["adapters.js", "app.js", "features.js", "renderers.js", "utils.js", "components.js", "compare.js", "crossmatch.js", "gemini-live.js"]) {
    assert.ok(!read(file).includes("color:var(--orange)"),
      `${file} sets accent text inline — use class="link-accent"`)
  }
})
