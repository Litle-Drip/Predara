const https = require("https")

const REQUEST_TIMEOUT_MS = 10000

// Builder.io API key embedded in all Gemini predictions pages
const BUILDER_API_KEY = "1b77ce3a269a43e985e77f3d65f715ba"

function isSafeParam(str) {
  return typeof str === "string" && /^[A-Za-z0-9_\-\.]+$/.test(str)
}

function isSafeUrl(str) {
  if (typeof str !== "string") return false
  try {
    const u = new URL(str)
    return (u.protocol === "https:" || u.protocol === "http:") &&
           u.hostname.endsWith("gemini.com")
  } catch { return false }
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { "Accept": "application/json" },
    }, (apiRes) => {
      let body = ""
      apiRes.on("data", (chunk) => { body += chunk })
      apiRes.on("end", () => resolve({ status: apiRes.statusCode, body }))
    })
    req.setTimeout(REQUEST_TIMEOUT_MS, () => { req.destroy(); reject(new Error("timeout")) })
    req.on("error", reject)
  })
}

// Walk a Builder.io content tree and collect all cdn.builder.io asset URLs.
// Checks both JSON object properties (href/url/src) and URLs embedded inside
// HTML strings (e.g. rich-text blocks with <a href="cdn.builder.io/assets/...">).
function collectBuilderAssets(node, results = []) {
  if (!node || typeof node !== "object") return results
  for (const [key, val] of Object.entries(node)) {
    if (typeof val === "string") {
      // Direct link fields
      if ((key === "href" || key === "url" || key === "src") && val.includes("cdn.builder.io")) {
        results.push(val)
      }
      // URLs embedded in HTML strings (rich-text "terms & conditions" links)
      const embedded = val.match(/https:\/\/cdn\.builder\.io\/assets[^\s"'<>)\\]+/g)
      if (embedded) results.push(...embedded)
    } else if (Array.isArray(val)) {
      val.forEach(v => collectBuilderAssets(v, results))
    } else if (val && typeof val === "object") {
      collectBuilderAssets(val, results)
    }
  }
  return results
}

// Fetch the Builder.io page content for a Gemini predictions URL and
// return the first CDN asset URL that looks like contract terms.
async function fetchBuilderContractUrl(pageUrl) {
  try {
    const parsed = new URL(pageUrl)
    // Use the path without query/hash as the Builder.io page URL key
    const pagePath = parsed.pathname
    const apiUrl = `https://cdn.builder.io/api/v3/content/page` +
      `?apiKey=${BUILDER_API_KEY}` +
      `&url=${encodeURIComponent(pagePath)}` +
      `&limit=1&fields=data`
    const r = await fetchJson(apiUrl)
    if (r.status !== 200) return null
    const json = JSON.parse(r.body)
    const assets = collectBuilderAssets(json)
    return assets.length ? assets[0] : null
  } catch (_) { return null }
}

module.exports = async (req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type")
    return res.status(204).end()
  }

  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Content-Type", "application/json")

  const ticker  = req.query.ticker
  const pageUrl = req.query.pageUrl

  if (!ticker || !isSafeParam(ticker)) {
    return res.status(400).json({ error: "Missing or invalid ticker" })
  }
  if (pageUrl && !isSafeUrl(pageUrl)) {
    return res.status(400).json({ error: "Invalid pageUrl" })
  }

  const target = `https://api.gemini.com/v1/prediction-markets/events/${encodeURIComponent(ticker)}`

  // Fetch Gemini event API + Builder.io contract URL in parallel
  const eventFetch = fetchJson(target)
  const contractFetch = pageUrl
    ? fetchBuilderContractUrl(pageUrl).catch(() => null)
    : Promise.resolve(null)

  let eventResult, contractUrl
  try {
    ;[eventResult, contractUrl] = await Promise.all([eventFetch, contractFetch])
  } catch (err) {
    return res.status(502).json({ error: err.message })
  }

  if (eventResult.status !== 200) {
    if (eventResult.status === 404) {
      return res.status(404).json({ error: `Ticker "${ticker}" not found on Gemini. Make sure you have the full ticker (e.g. TPC2026T5, not TPC2026T).` })
    }
    return res.status(eventResult.status).json({ error: `Gemini API returned ${eventResult.status}` })
  }

  let data
  try { data = JSON.parse(eventResult.body) } catch {
    return res.status(502).json({ error: "Invalid response from Gemini API" })
  }

  if (contractUrl) data._contract_url = contractUrl

  return res.status(200).json(data)
}
