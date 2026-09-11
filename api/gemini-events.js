// Vercel serverless function — Gemini events and the cross-venue reads.
//
// This one function answers three paths because Vercel's plan caps a
// deployment at 12 serverless functions and `api/` is at that cap. The two
// cross-venue reads are therefore folded in behind `view=` and published under
// their own paths by the rewrites in vercel.json — the same arrangement
// `/api/discover` has had since it stopped being its own file. `server.js`
// still routes /api/discover and /api/match directly, so local development is
// unaffected by the packaging.
//
// Adding a new api/*.js file breaks the deploy. Fold it in here instead, and
// add a rewrite. tests/vercel-config.test.js enforces both.

const { readOnlyJson } = require("../lib/serverless")
const { listEvents } = require("../lib/gemini")
const { getDiscoveryFeed } = require("../lib/discover")
const { handleMatchRequest } = require("../lib/cross-platform")

module.exports = readOnlyJson(async (query) => {
  if (query.view === "discover") {
    return {
      status: 200,
      data: await getDiscoveryFeed({ limit: query.limit }),
    }
  }

  // "Where else is this event listed?" — see /api/match in vercel.json.
  if (query.view === "match") return handleMatchRequest(query)

  return listEvents({
    status:   query.status,
    category: query.category,
    search:   query.search,
    limit:    query.limit,
    offset:   query.offset,
  })
})
