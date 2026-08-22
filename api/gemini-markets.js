// Vercel serverless function — the browsable public Gemini data entrypoint.
// GET /api/gemini-markets?resource=upcoming&limit=6
// GET /api/gemini-markets?resource=volume&date=2026-08-20&hourly=1
//
// One route for the resources the UI selects by name (event feeds, categories,
// volume, maker rebates, liquidity rewards, terms), each validated and cached
// in lib/gemini-public.js. Read-only, like every other api/gemini*.js.

const { readOnlyJson } = require("../lib/serverless")
const { getGeminiPublic } = require("../lib/gemini-public")

module.exports = readOnlyJson(async ({ resource, ...query }) => {
  const { status, json } = await getGeminiPublic(resource, query)
  return { status, data: json }
})
