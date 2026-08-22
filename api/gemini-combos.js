// Vercel serverless function — Gemini combo contracts (read-only).
// GET /api/gemini-combos                      → list active combos with legs
// GET /api/gemini-combos?symbol=GEMI-CMB-...  → one combo, legs, and fair value
//
// Combo creation (POST /v1/prediction-markets/combos) is authenticated and
// deliberately not proxied: Predara analyzes combos, it does not create them.

const { readOnlyJson } = require("../lib/serverless")
const { listCombos, getCombo } = require("../lib/gemini")

module.exports = readOnlyJson((query) => (
  query.symbol
    ? getCombo(query.symbol)
    : listCombos({ limit: query.limit, offset: query.offset })
))
