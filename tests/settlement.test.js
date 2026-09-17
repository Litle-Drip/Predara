const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const html = fs.readFileSync(path.join(__dirname, "..", "settlement.html"), "utf8")

test("Settlement Desk keeps cases in memory when browser storage fails", () => {
  assert.match(html, /let inMemoryCases = \[\]/)
  assert.match(html, /inMemoryCases = Array\.isArray\(cases\) \? cases : \[\]/)
  assert.match(html, /catch \{\s*showStorageNotice\(\)\s*}/)
  assert.match(html, /id="storageNotice"[^>]*role="status"/)
  assert.match(html, /Browser storage is unavailable or full/)
})

test("Settlement Desk startup does not fail when localStorage is blocked", () => {
  const themeBoot = html.slice(html.indexOf("/* ── Theme ──"), html.indexOf("function toggleTheme"))
  assert.match(themeBoot, /try \{/)
  assert.match(themeBoot, /catch \{\}/)
})

test("Resolved cases use accessible disclosure buttons and linked panels", () => {
  assert.match(html, /<button type="button" class="case-header"/)
  assert.match(html, /aria-expanded="false" aria-controls="case-panel-\$\{esc\(c\.id\)\}"/)
  assert.match(html, /class="case-body" id="case-panel-\$\{esc\(c\.id\)\}" role="region" aria-hidden="true"/)
  assert.match(html, /headerEl\.setAttribute\("aria-expanded", expanded \? "true" : "false"\)/)
  assert.match(html, /headerEl\.getAttribute\("aria-controls"\)/)
  assert.match(html, /\.case-header:focus-visible/)
})

test("only completed settlement verdicts can be exported as JSON audit records", () => {
  assert.match(html, /const EXPORTABLE_VERDICTS = new Set\(\["confirmed", "discrepancy", "needs_review"\]\)/)
  assert.match(html, /EXPORTABLE_VERDICTS\.has\(c\.verdict\)[\s\S]*?exportCase\('\$\{c\.id\}', event\)/)
  assert.match(html, /function exportCase\(id, event\)/)
  assert.match(html, /const c = loadCases\(\)\.find\(item => item\.id === id\)/)
  for (const field of ["ticker", "title", "platform", "verdict", "summary", "keyFacts", "recommendation", "input", "ts", "exportedAt"]) {
    assert.match(html, new RegExp(`\\b${field}:`), `export is missing ${field}`)
  }
  assert.match(html, /new Blob\(\[JSON\.stringify\(record, null, 2\)/)
  assert.match(html, /link\.download = `predara-settlement-\$\{ticker\}-\$\{date\}\.json`/)
  assert.match(html, /URL\.revokeObjectURL\(url\)/)
})