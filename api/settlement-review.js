const https = require("https")

const REQUEST_TIMEOUT_MS = 12000
const AI_TIMEOUT_MS = 25000

function isSafeParam(str) {
  return typeof str === "string" && /^[A-Za-z0-9_\-\.]+$/.test(str)
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "Accept": "application/json" } }, (apiRes) => {
      let body = ""
      apiRes.on("data", (chunk) => { body += chunk })
      apiRes.on("end", () => resolve({ status: apiRes.statusCode, body }))
    })
    req.setTimeout(REQUEST_TIMEOUT_MS, () => { req.destroy(); reject(new Error("Gemini API request timed out")) })
    req.on("error", reject)
  })
}

function postJson(hostname, path, headers, bodyObj) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(bodyObj)
    const req = https.request({
      hostname,
      path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyStr),
        ...headers,
      },
    }, (apiRes) => {
      let body = ""
      apiRes.on("data", (chunk) => { body += chunk })
      apiRes.on("end", () => resolve({ status: apiRes.statusCode, body }))
    })
    req.setTimeout(AI_TIMEOUT_MS, () => { req.destroy(); reject(new Error("AI request timed out")) })
    req.on("error", reject)
    req.write(bodyStr)
    req.end()
  })
}

const SYSTEM_PROMPT = `You are a settlement auditor for Gemini prediction markets. You receive structured event data from Gemini's API. Analyze whether the market's settlement appears correct based on the data and your knowledge of the underlying real-world event.

Data structure: the payload has a "winners" array (contracts with resolutionSide:"yes" or result:"yes") and a "losers" array (all others, label+status only). Check the winners array to identify who won, then verify against your knowledge of the real-world result.

Your final response must be a single raw JSON object — no markdown, no code fences, no commentary. First character must be { and last must be }. Schema:
{"ticker":string,"title":string,"status":string,"resolvedSide":string,"verdict":"confirmed"|"discrepancy"|"needs_review","summary":"2-3 sentence explanation of your finding","keyFacts":["short fact","short fact","short fact"],"recommendation":"1-2 sentences: what a support agent should do next"}

Use "confirmed" if settlement looks correct, "discrepancy" if something appears wrong, "needs_review" if data is truly insufficient.`

const VALID_VERDICTS = new Set(["confirmed", "discrepancy", "needs_review"])

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type")
    return res.status(204).end()
  }

  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Content-Type", "application/json")

  if (req.method !== "POST") {
    return res.status(405).json({ verdict: "error", summary: "Method not allowed. Use POST." })
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
  if (!ANTHROPIC_API_KEY) {
    return res.status(503).json({ verdict: "error", summary: "Settlement review is not configured. ANTHROPIC_API_KEY is missing." })
  }

  const body = req.body || {}
  const input = (typeof body.input === "string" ? body.input : "").trim()

  if (!input) {
    return res.status(400).json({ verdict: "error", summary: "No input provided. Paste a Gemini ticker, instrument symbol, or event URL." })
  }

  let ticker = input
  try {
    const u = new URL(input)
    const segments = u.pathname.split("/").filter(Boolean)
    const predIdx = segments.indexOf("predictions")
    ticker = (predIdx !== -1 && segments[predIdx + 1])
      ? segments[predIdx + 1]
      : (segments[segments.length - 1] || input)
  } catch {
    ticker = input.replace(/[_-](Y|N)$/i, "").trim()
  }

  if (!ticker || !isSafeParam(ticker)) {
    return res.status(400).json({ verdict: "error", summary: `Could not extract a valid ticker from: "${input.slice(0, 80)}"` })
  }

  let eventData
  try {
    const { status: gemStatus, body: gemBody } = await fetchJson(
      `https://api.gemini.com/v1/prediction-markets/events/${encodeURIComponent(ticker)}`
    )
    if (gemStatus !== 200) {
      return res.status(200).json({ verdict: "error", summary: `Could not fetch event data for ticker "${ticker}" — Gemini API returned ${gemStatus}. Verify the ticker is correct.` })
    }
    eventData = JSON.parse(gemBody)
  } catch (err) {
    return res.status(200).json({ verdict: "error", summary: `Failed to fetch Gemini event data: ${err.message}` })
  }

  const contracts = Array.isArray(eventData.contracts) ? eventData.contracts : []

  const trimContract = c => ({
    label: c.label || c.displayName || "",
    status: c.status || "",
    resolutionSide: c.resolutionSide || "",
    result: c.result || "",
    resolvedAt: c.resolvedAt || "",
    lastTradePrice: c.lastTradePrice != null ? c.lastTradePrice : (c.prices?.lastTradePrice ?? null),
  })
  const winners = contracts.filter(c => c.resolutionSide === "yes" || c.result === "yes")
  const losers  = contracts.filter(c => c.resolutionSide !== "yes" && c.result !== "yes")

  const trimmed = {
    ticker: eventData.ticker || ticker,
    title: eventData.title || "",
    status: eventData.status || "",
    resolvedSide: eventData.resolvedSide || "",
    resolvedAt: eventData.resolvedAt || "",
    totalContracts: contracts.length,
    winners: winners.map(trimContract),
    losers: losers.map(c => ({ label: c.label || c.displayName || "", status: c.status || "" })),
  }

  let claudeText
  try {
    const { status: aiStatus, body: aiBody } = await postJson(
      "api.anthropic.com",
      "/v1/messages",
      { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      {
        model: "claude-haiku-4-5",
        max_tokens: 512,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: `Input: ${input}\n\nGemini event data:\n${JSON.stringify(trimmed, null, 2)}` }],
      }
    )
    const aiJson = JSON.parse(aiBody)
    if (aiStatus !== 200) {
      return res.status(200).json({ verdict: "error", summary: `AI analysis failed: ${aiJson?.error?.message || "Anthropic API returned " + aiStatus}` })
    }
    claudeText = aiJson?.content?.[0]?.text || ""
  } catch (err) {
    return res.status(200).json({ verdict: "error", summary: `AI analysis failed: ${err.message}` })
  }

  const firstBrace = claudeText.indexOf("{")
  const lastBrace = claudeText.lastIndexOf("}")
  if (firstBrace === -1 || lastBrace <= firstBrace) {
    return res.status(200).json({ verdict: "error", summary: "AI returned an unrecognized response format. Please try again." })
  }

  let verdict
  try {
    verdict = JSON.parse(claudeText.slice(firstBrace, lastBrace + 1))
  } catch {
    return res.status(200).json({ verdict: "error", summary: "AI returned malformed JSON. Please try again." })
  }

  if (!VALID_VERDICTS.has(verdict.verdict)) verdict.verdict = "needs_review"
  if (!verdict.ticker) verdict.ticker = trimmed.ticker
  if (!verdict.title) verdict.title = trimmed.title || ticker
  if (!verdict.status) verdict.status = trimmed.status || "unknown"
  if (!verdict.resolvedSide) verdict.resolvedSide = trimmed.resolvedSide || "unknown"
  if (!Array.isArray(verdict.keyFacts)) verdict.keyFacts = []
  if (!verdict.summary) verdict.summary = "No summary provided."
  if (!verdict.recommendation) verdict.recommendation = "Review manually."

  return res.status(200).json(verdict)
}
