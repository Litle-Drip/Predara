// Vercel serverless function — paginated Gemini event discovery.
// GET /api/gemini-events?status=active&category=crypto&search=&limit=50&offset=0

const { readOnlyJson } = require("../lib/serverless")
const { listEvents } = require("../lib/gemini")

module.exports = readOnlyJson((query) => listEvents({
  status:   query.status,
  category: query.category,
  search:   query.search,
  limit:    query.limit,
  offset:   query.offset,
}))
