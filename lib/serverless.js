// Shared HTTP shell for the read-only Vercel functions.
// Each handler resolves to the { status, data } / { status, error } shape that
// lib/gemini.js returns, and this wrapper does the CORS and serialization.

const { applyGuard } = require("./guard")

// Wrap a `(query) => Promise<{ status, data?, error? }>` as a Vercel handler.
function readOnlyJson(handler) {
  return async (req, res) => {
    // Origin allowlist + rate limit. Read-only does not mean free to serve:
    // every call here spends Predara's share of an upstream rate limit.
    if (!applyGuard(req, res)) return

    res.setHeader("Content-Type", "application/json")

    // These proxy public, read-only market data, so nothing here mutates state.
    if (req.method !== "GET") {
      return res.status(405).json({ error: "Method not allowed" })
    }

    let result
    try {
      result = await handler(req.query || {})
    } catch (err) {
      return res.status(502).json({ error: err.message })
    }

    const { status, data, error } = result
    return res.status(status).json(error ? { error } : data)
  }
}

module.exports = { readOnlyJson }
