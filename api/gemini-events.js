// Vercel serverless function — Gemini events and the cross-venue discovery feed.

const { readOnlyJson } = require("../lib/serverless")
const { listEvents } = require("../lib/gemini")
const { getDiscoveryFeed } = require("../lib/discover")

module.exports = readOnlyJson(async (query) => {
  if (query.view === "discover") {
    return {
      status: 200,
      data: await getDiscoveryFeed({ limit: query.limit }),
    }
  }

  return listEvents({
    status:   query.status,
    category: query.category,
    search:   query.search,
    limit:    query.limit,
    offset:   query.offset,
  })
})
