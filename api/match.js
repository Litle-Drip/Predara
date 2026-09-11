// Vercel serverless function — "where else is this event listed?"
// GET /api/match?platform=kalshi&title=Spanish+Grand+Prix+Winner&date=2026-09-13&outcomes=Lando+Norris|…
//
// A thin shell, like every other api/*.js: the searching and scoring live in
// lib/cross-platform.js and lib/match.js so server.js runs the same code path.

const { readOnlyJson } = require("../lib/serverless")
const { handleMatchRequest } = require("../lib/cross-platform")

module.exports = readOnlyJson((query) => handleMatchRequest(query))
