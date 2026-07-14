const https = require("https")
const crypto = require("crypto")

const REQUEST_TIMEOUT_MS = 12000
const AI_TIMEOUT_MS = 25000

function isSafeParam(str) {
  return typeof str === "string" && /^[A-Za-z0-9_\-\.]+$/.test(str)
}

function normalizePem(raw) {
  let pem = raw.replace(/\\n/g, "\n").trim()
  const headerMatch = pem.match(/-----BEGIN ([^-]+)-----/)
  const keyType = headerMatch ? headerMatch[1] : "RSA PRIVATE KEY"
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "")
  const body = b64.match(/.{1,64}/g).join("\n")
  return `-----BEGIN ${keyType}-----\n${body}\n-----END ${keyType}-----`
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "Accept": "application/json" } }, (apiRes) => {
      let body = ""
      apiRes.on("data", (chunk) => { body += chunk })
      apiRes.on("end", () => resolve({ status: apiRes.statusCode, body }))
    })
    req.setTimeout(REQUEST_TIMEOUT_MS, () => { req.destroy(); reject(new Error("API request timed out")) })
    req.on("error", reject)
  })
}

function kalshiAuthGet(apiPath, keyId, normalizedKey) {
  return new Promise((resolve, reject) => {
    const basePath = apiPath.split("?")[0]
    const ts = Date.now().toString()
    let sig
    try { sig = crypto.createSign("SHA256").update(ts + "GET" + basePath).sign(normalizedKey, "base64") }
    catch (e) { return reject(e) }
    const req = https.request({
      hostname: "api.elections.kalshi.com",
      path: apiPath,
      method: "GET",
      headers: { "KALSHI-ACCESS-KEY": keyId, "KALSHI-ACCESS-TIMESTAMP": ts, "KALSHI-ACCESS-SIGNATURE": sig, "Content-Type": "application/json" },
    }, (apiRes) => {
      let body = ""
      apiRes.on("data", c => { body += c })
      apiRes.on("end", () => resolve({ status: apiRes.statusCode, body }))
    })
    req.setTimeout(REQUEST_TIMEOUT_MS, () => { req.destroy(); reject(new Error("Kalshi API timed out")) })
    req.on("error", reject).end()
  })
}

function postJson(hostname, path, headers, bodyObj) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(bodyObj)
    const req = https.request({
      hostname, path, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr), ...headers },
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

const SLOW_PATH_PROMPT = `You are a settlement auditor for prediction markets (Gemini, Kalshi, Polymarket, Coinbase). The API data contains no clear winner signal. Analyze the available data and use your knowledge of the real-world event to determine whether settlement appears correct.

Your final response must be a single raw JSON object — no markdown, no code fences, no commentary. First character must be { and last must be }. Schema:
{"ticker":string,"title":string,"status":string,"resolvedSide":string,"verdict":"confirmed"|"discrepancy"|"needs_review","summary":"2-3 sentence explanation of your finding","keyFacts":["short fact","short fact","short fact"],"recommendation":"1-2 sentences: what a support agent should do next"}

Use "confirmed" if settlement looks correct, "discrepancy" if something appears wrong, "needs_review" if data is truly insufficient.`

const VALID_VERDICTS = new Set(["confirmed", "discrepancy", "needs_review"])

let _normalizedKey = null

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
    return res.status(400).json({ verdict: "error", summary: "No input provided. Paste a ticker or market URL from Gemini, Kalshi, Polymarket, or Coinbase." })
  }

  // ── Platform detection ──
  const lower = input.toLowerCase()
  let platform = "gemini"
  if      (lower.includes("polymarket.com"))                platform = "polymarket"
  else if (lower.includes("predict.coinbase.com"))          platform = "coinbase-poly"
  else if (lower.includes("coinbase.com/predictions/event")) platform = "coinbase-kalshi"
  else if (lower.includes("coinbase.com"))                  platform = "coinbase-poly"
  else if (lower.includes("kalshi.com"))                    platform = "kalshi"
  else if (lower.includes("gemini.com"))                    platform = "gemini"
  else if (/^[a-z][a-z0-9-]{4,}$/.test(input))             platform = "polymarket"

  // ── Identifier extraction ──
  let identifier = input
  try {
    const u = new URL(input)
    const segs = u.pathname.split("/").filter(Boolean)
    identifier = segs[segs.length - 1] || input
  } catch {
    identifier = input.replace(/[_-](Y|N)$/i, "").trim()
  }

  if (!identifier || !isSafeParam(identifier)) {
    return res.status(400).json({ verdict: "error", summary: `Could not extract a valid identifier from: "${input.slice(0, 80)}"` })
  }

  // ── Fetch event data & extract winners ──
  let winnersData
  try {
    if (platform === "kalshi" || platform === "coinbase-kalshi") {
      const keyId = process.env.KALSHI_API_KEY_ID
      const privateKey = process.env.KALSHI_PRIVATE_KEY
      if (!keyId || !privateKey) {
        return res.status(200).json({ verdict: "error", summary: "Kalshi credentials not configured — cannot audit Kalshi/Coinbase markets." })
      }
      if (!_normalizedKey) _normalizedKey = normalizePem(privateKey)
      const nk = _normalizedKey

      const mktRes = await kalshiAuthGet(`/trade-api/v2/markets/${encodeURIComponent(identifier)}`, keyId, nk)
      let raw
      if (mktRes.status === 200) {
        raw = JSON.parse(mktRes.body)
      } else {
        const evtRes = await kalshiAuthGet(`/trade-api/v2/events/${encodeURIComponent(identifier)}?with_nested_markets=true`, keyId, nk)
        if (evtRes.status !== 200) return res.status(200).json({ verdict: "error", summary: `Could not fetch Kalshi data for "${identifier}" (HTTP ${evtRes.status}).` })
        raw = JSON.parse(evtRes.body)
      }

      if (raw.market) {
        const m = raw.market
        const resolvedAt = m.close_time || ""
        const winners = m.result === "yes" ? [{ label: "Yes", resolvedAt }]
                      : m.result === "no"  ? [{ label: "No",  resolvedAt }] : []
        const losers  = m.result === "yes" ? [{ label: "No",  status: m.status || "" }]
                      : m.result === "no"  ? [{ label: "Yes", status: m.status || "" }] : []
        winnersData = { title: m.subtitle || m.title || identifier, ticker: m.event_ticker || identifier, status: m.status || "", resolvedAt, winners, losers, contracts: 2, platformName: "Kalshi" }
      } else if (raw.event) {
        const e = raw.event
        const markets = raw.markets || []
        const winners = markets.filter(m => m.result === "yes").map(m => ({ label: m.subtitle || m.title || m.ticker, resolvedAt: m.close_time || "" }))
        const losers  = markets.filter(m => m.result !== "yes").map(m => ({ label: m.subtitle || m.title || m.ticker, status: m.status || "" }))
        winnersData = { title: e.title || identifier, ticker: e.event_ticker || identifier, status: e.status || "", resolvedAt: e.close_time || "", winners, losers, contracts: markets.length, platformName: "Kalshi" }
      } else {
        return res.status(200).json({ verdict: "error", summary: "Kalshi API returned an unrecognized response shape." })
      }

    } else if (platform === "polymarket" || platform === "coinbase-poly") {
      const { status: pmStatus, body: pmBody } = await fetchJson(
        `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(identifier)}`
      )
      if (pmStatus !== 200) return res.status(200).json({ verdict: "error", summary: `Could not fetch Polymarket data for "${identifier}" (HTTP ${pmStatus}).` })
      const pmData = JSON.parse(pmBody)
      const event = Array.isArray(pmData) ? pmData[0] : pmData
      if (!event) return res.status(200).json({ verdict: "error", summary: `No Polymarket event found for slug "${identifier}".` })

      const pmMarkets = event.markets || []
      const winners = [], losers = []
      for (const m of pmMarkets) {
        const outcomes = m.outcomes ? (typeof m.outcomes === "string" ? JSON.parse(m.outcomes) : m.outcomes) : []
        const prices   = m.outcomePrices ? (typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices) : []
        for (let i = 0; i < outcomes.length; i++) {
          const price = parseFloat(prices[i] || "0")
          if (price >= 0.99) winners.push({ label: outcomes[i], resolvedAt: m.endDate || event.endDate || "" })
          else if (m.closed) losers.push({ label: outcomes[i], status: "settled" })
        }
      }
      const totalOutcomes = pmMarkets.reduce((n, m) => {
        const o = m.outcomes ? (typeof m.outcomes === "string" ? JSON.parse(m.outcomes) : m.outcomes) : []
        return n + o.length
      }, 0)
      winnersData = { title: event.title || identifier, ticker: event.slug || identifier, status: event.closed ? "settled" : (event.active ? "active" : "unknown"), resolvedAt: event.endDate || "", winners, losers, contracts: totalOutcomes, platformName: "Polymarket" }

    } else {
      // Gemini (default)
      const { status: gemStatus, body: gemBody } = await fetchJson(
        `https://api.gemini.com/v1/prediction-markets/events/${encodeURIComponent(identifier)}`
      )
      if (gemStatus !== 200) return res.status(200).json({ verdict: "error", summary: `Could not fetch Gemini event data for "${identifier}" (HTTP ${gemStatus}). Verify the ticker is correct.` })
      const eventData = JSON.parse(gemBody)
      const contracts = Array.isArray(eventData.contracts) ? eventData.contracts : []
      const winners = contracts.filter(c => c.resolutionSide === "yes" || c.result === "yes")
        .map(c => ({ label: c.label || c.displayName || "", resolvedAt: c.resolvedAt || "" }))
      const losers  = contracts.filter(c => c.resolutionSide !== "yes" && c.result !== "yes")
        .map(c => ({ label: c.label || c.displayName || "", status: c.status || "" }))
      winnersData = { title: eventData.title || identifier, ticker: eventData.ticker || identifier, status: eventData.status || "", resolvedAt: eventData.resolvedAt || "", winners, losers, contracts: contracts.length, platformName: "Gemini" }
    }
  } catch (err) {
    return res.status(200).json({ verdict: "error", summary: `Failed to fetch settlement data: ${err.message}` })
  }

  const { title, ticker, status, resolvedAt, winners, losers, contracts, platformName } = winnersData

  // ── Fast path: winner clearly identified by API — no Claude call needed ──
  if (winners.length > 0) {
    const winnerLabels = winners.map(w => w.label).filter(Boolean)
    const settledAt = winners[0]?.resolvedAt || resolvedAt || ""
    const settledDate = settledAt ? new Date(settledAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "unknown date"
    return res.status(200).json({
      ticker, title, status,
      resolvedSide: winnerLabels.join(", "),
      verdict: "confirmed",
      summary: `${platformName}'s API confirms ${winnerLabels.join(" and ")} as the winner, settled on ${settledDate}. ${losers.length > 0 ? `All ${losers.length} other outcome${losers.length !== 1 ? "s" : ""} resolved against.` : ""} Settlement data is clean and unambiguous.`,
      keyFacts: [
        `Winner: ${winnerLabels.join(", ")}`,
        `Settlement timestamp: ${settledAt || "N/A"}`,
        `${winners.length} of ${contracts} outcome${contracts !== 1 ? "s" : ""} resolved YES`,
      ],
      recommendation: "No action needed. Settlement is confirmed directly by the platform's API data.",
    })
  }

  // ── Slow path: no clear winner in API data — ask Claude ──
  const trimmed = { ticker, title, status, resolvedAt, platform: platformName, winners, losers, totalContracts: contracts }

  let claudeText
  try {
    const { status: aiStatus, body: aiBody } = await postJson(
      "api.anthropic.com",
      "/v1/messages",
      { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      {
        model: "claude-haiku-4-5",
        max_tokens: 512,
        system: SLOW_PATH_PROMPT,
        messages: [{ role: "user", content: `Input: ${input}\n\nEvent data:\n${JSON.stringify(trimmed, null, 2)}` }],
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
  if (!verdict.ticker) verdict.ticker = ticker
  if (!verdict.title) verdict.title = title || ticker
  if (!verdict.status) verdict.status = status || "unknown"
  if (!verdict.resolvedSide) verdict.resolvedSide = "unknown"
  if (!Array.isArray(verdict.keyFacts)) verdict.keyFacts = []
  if (!verdict.summary) verdict.summary = "No summary provided."
  if (!verdict.recommendation) verdict.recommendation = "Review manually."

  return res.status(200).json(verdict)
}
