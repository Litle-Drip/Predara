const http = require("http")
const https = require("https")
const crypto = require("crypto")
const fs = require("fs")
const path = require("path")
const url = require("url")

const PORT = 3000

const MIME = {
  ".html": "text/html",
  ".js":   "application/javascript",
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true)

  // Proxy endpoint — avoids browser CORS restrictions entirely
  if (parsed.pathname === "/api/polymarket") {
    const slug = parsed.query.slug
    if (!slug) {
      res.writeHead(400, { "Content-Type": "application/json" })
      return res.end(JSON.stringify({ error: "Missing slug" }))
    }

    const target = `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`

    https.get(target, (apiRes) => {
      let body = ""
      apiRes.on("data", (chunk) => { body += chunk })
      apiRes.on("end", () => {
        res.writeHead(apiRes.statusCode, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        })
        res.end(body)
      })
    }).on("error", (err) => {
      res.writeHead(502, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: err.message }))
    })

    return
  }

  if (parsed.pathname === "/api/kalshi") {
    const keyId = process.env.KALSHI_API_KEY_ID
    const privateKey = process.env.KALSHI_PRIVATE_KEY
    if (!keyId || !privateKey) {
      res.writeHead(503, { "Content-Type": "application/json" })
      return res.end(JSON.stringify({ error: "Kalshi credentials not configured. Set KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY." }))
    }

    const ticker = parsed.query.ticker
    const type = parsed.query.type  // "market" or "event"
    if (!ticker) {
      res.writeHead(400, { "Content-Type": "application/json" })
      return res.end(JSON.stringify({ error: "Missing ticker" }))
    }

    const isMarket = type === "market"
    const basePath = isMarket
      ? `/trade-api/v2/markets/${encodeURIComponent(ticker)}`
      : `/trade-api/v2/events/${encodeURIComponent(ticker)}`
    const apiPath = isMarket ? basePath : `${basePath}?with_nested_markets=true`

    const normalizedKey = privateKey.replace(/\\n/g, "\n")
    const timestamp = Date.now().toString()
    const msgString = timestamp + "GET" + basePath
    let signature
    try {
      signature = crypto.createSign("SHA256").update(msgString).sign(normalizedKey, "base64")
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" })
      return res.end(JSON.stringify({ error: `Failed to sign request: ${err.message}` }))
    }

    const options = {
      hostname: "trading-api.kalshi.com",
      path: apiPath,
      method: "GET",
      headers: {
        "KALSHI-ACCESS-KEY": keyId,
        "KALSHI-ACCESS-TIMESTAMP": timestamp,
        "KALSHI-ACCESS-SIGNATURE": signature,
        "Content-Type": "application/json",
      },
    }

    https.request(options, (apiRes) => {
      let body = ""
      apiRes.on("data", (chunk) => { body += chunk })
      apiRes.on("end", () => {
        const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        if (apiRes.statusCode !== 200) {
          res.writeHead(apiRes.statusCode, headers)
          res.end(JSON.stringify({ error: body.trim() }))
        } else {
          res.writeHead(200, headers)
          res.end(body)
        }
      })
    }).on("error", (err) => {
      res.writeHead(502, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: err.message }))
    }).end()

    return
  }

  // Serve static files
  let filePath = parsed.pathname === "/" ? "/index.html" : parsed.pathname
  filePath = path.join(__dirname, filePath)

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404)
      return res.end("Not found")
    }
    const ext = path.extname(filePath)
    res.writeHead(200, { "Content-Type": MIME[ext] || "text/plain" })
    res.end(data)
  })
})

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`)
})
