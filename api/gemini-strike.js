// Vercel serverless function — strike / threshold info for a Gemini event.
// GET /api/gemini-strike?ticker=BTC05M2603271950
//
// For crypto Up/Down contracts the strike is only captured at `availableAt`,
// so a null `value` before that time is a pending strike rather than an error.
// The response carries `_pending` and `_comparison` to say which it is.

const { readOnlyJson } = require("../lib/serverless")
const { getEventStrike } = require("../lib/gemini")

module.exports = readOnlyJson((query) => getEventStrike(query.ticker))
