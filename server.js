const http = require("http")
const https = require("https")
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
