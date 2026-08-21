// Shared HTTP shell for the read-only Vercel functions.
// Each handler resolves to the { status, data } / { status, error } shape that
// lib/gemini.js returns, and this wrapper does the CORS and serialization.

// Wrap a `(query) => Promise<{ status, data?, error? }>` as a Vercel handler.
function readOnlyJson(handler) {
  return async (req, res) => {
    // CORS preflight
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Origin", "*")
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS")
      res.setHeader("Access-Control-Allow-Headers", "Content-Type")
      return res.status(204).end()
    }

    res.setHeader("Access-Control-Allow-Origin", "*")
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
