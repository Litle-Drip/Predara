// The deployment has a hard cap on serverless functions, and this repo has hit
// it twice: once when api/discover.js was folded into api/gemini-events.js, and
// again when api/match.js was added. Both times the only symptom was a failed
// Vercel deploy with nothing wrong in the code — the tests were green. These
// assert the packaging so the next new route fails here instead of on deploy.

const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const ROOT = path.join(__dirname, "..")
const VERCEL_FUNCTION_LIMIT = 12

function apiFunctions() {
  return fs.readdirSync(path.join(ROOT, "api")).filter(f => f.endsWith(".js"))
}

function vercelConfig() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"))
}

test("api/ stays within the deployment's serverless function cap", () => {
  const functions = apiFunctions()
  assert.ok(functions.length <= VERCEL_FUNCTION_LIMIT,
    `api/ has ${functions.length} functions and the cap is ${VERCEL_FUNCTION_LIMIT}. ` +
    "Fold the new route into api/gemini-events.js behind a view= parameter and " +
    "publish it with a rewrite, the way /api/discover and /api/match are.")
})

test("every folded route is published under its own path", () => {
  const rewrites = vercelConfig().rewrites || []
  const sources = rewrites.map(r => r.source)
  assert.ok(sources.includes("/api/discover"), "/api/discover must be rewritten")
  assert.ok(sources.includes("/api/match"), "/api/match must be rewritten")
  for (const r of rewrites) {
    assert.match(r.destination, /^\/api\/[a-z-]+\?view=[a-z-]+$/,
      `${r.source} must point at a view= on a real function`)
  }
})

test("a rewritten path is answered by the function it points at", () => {
  // A rewrite that names a view the function does not handle deploys cleanly
  // and 404s at runtime, which is the failure this catches.
  const source = fs.readFileSync(path.join(ROOT, "api", "gemini-events.js"), "utf8")
  for (const { destination } of vercelConfig().rewrites || []) {
    const view = destination.split("view=")[1]
    assert.match(source, new RegExp(`query\\.view === "${view}"`),
      `api/gemini-events.js must handle view=${view}`)
  }
})

test("the local server answers both spellings of a folded route", () => {
  // server.js routes /api/match directly; the client falls back to the rewrite
  // destination, so that spelling has to work locally too or the fallback is
  // only ever exercised in production.
  const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8")
  assert.match(server, /pathname === "\/api\/match"/)
  assert.match(server, /q\.view === "match"/)
  assert.match(server, /q\.view === "discover"/)
})
