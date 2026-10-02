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
  assert.match(html, /aria-expanded="\$\{expanded \? "true" : "false"\}" aria-controls="case-panel-\$\{esc\(c\.id\)\}"/)
  assert.match(html, /class="case-body" id="case-panel-\$\{esc\(c\.id\)\}" role="region"/)
  assert.match(html, /headerEl\.setAttribute\("aria-expanded", expanded \? "true" : "false"\)/)
  assert.match(html, /headerEl\.getAttribute\("aria-controls"\)/)
  assert.match(html, /if \(panel\) panel\.hidden = !expanded/)
  // Keyboard focus only, neutral.
  assert.match(html, /\.case-header:focus-visible \{ box-shadow: inset 0 0 0 2px var\(--border-hi\); \}/)
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

// ── Phase 3 cleanup ───────────────────────────────────────────────────────────
test("the latest result sits directly under the input, the feed after it", () => {
  const body = html.slice(html.indexOf('<div class="intake">'), html.indexOf('<footer class="footer">'))
  const order = ['id="tickerInput"', 'id="keyPanel"', 'id="caseList"', 'id="gemSettledSlot"'].map(m => body.indexOf(m))
  assert.ok(order.every(i => i !== -1))
  assert.deepEqual([...order].sort((a, b) => a - b), order)
  assert.ok(!/Press Enter to submit/.test(html))
  assert.ok(!/>Review ↗</.test(html))
})

test("only the newest result opens by default, with Clear all for earlier ones", () => {
  assert.match(html, /const expanded = openState\.has\(c\.id\) \? openState\.get\(c\.id\) : i === 0/)
  assert.match(html, /Earlier reviews<\/span><button class="btn-quiet" onclick="clearAllCases\(\)">Clear all/)
  assert.match(html, /function clearAllCases\(\)/)
  assert.match(html, /class="case-chevron" viewBox/)
})

test("one status signal per card: a badge, no coloured left bars", () => {
  assert.ok(!/border-left: 3px solid/.test(html))
  assert.ok(!/verdict-pill|pill-confirmed/.test(html))
  for (const v of ["confirmed", "action_required", "error", "pending"]) assert.match(html, new RegExp(`\\.badge-${v}`))
})

test("the needs-AI message is said once, on the card, with one button to the key", () => {
  const submit = html.slice(html.indexOf("async function submitReview"), html.indexOf("/* ── Remove ── */"))
  assert.ok(!/setKeyNote\(/.test(submit), "the key field does not repeat the message")
  assert.match(html, /onclick="focusKeyField\(\)"/)
  assert.match(html, /if \(!rec \|\| c\.verdict === "action_required"\) return ""/)
  assert.match(html, /\/\^no action \(is \)\?needed\/i/)
})

