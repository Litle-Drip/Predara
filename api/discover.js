const { readOnlyJson } = require("../lib/serverless")
const { getDiscoveryFeed } = require("../lib/discover")

module.exports = readOnlyJson(async (query) => ({
  status: 200,
  data: await getDiscoveryFeed({ limit: query.limit }),
}))
