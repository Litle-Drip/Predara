const https = require("https")

const REQUEST_TIMEOUT_MS = 10000

function isSafeDate(str) {
  return typeof str === "string" && /^\d{4}-\d{2}-\d{2}$/.test(str)
}

module.exports = (req, res) => {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type")
    return res.status(204).end()
  }

  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Content-Type", "application/json")

  const date = req.query.date
  if (!isSafeDate(date)) {
    return res.status(400).json({ error: "date param required (YYYY-MM-DD)" })
  }

  const [yr, mo, dy] = date.split("-")
  const target = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${mo}/${dy}/${yr}`

  let responded = false
  const proxyReq = https.get(target, (apiRes) => {
    let body = ""
    apiRes.on("data", chunk => { body += chunk })
    apiRes.on("end", () => {
      if (responded) return
      responded = true
      if (apiRes.statusCode !== 200) {
        return res.status(apiRes.statusCode).json({ error: `MLB API returned ${apiRes.statusCode}` })
      }
      try {
        const data = JSON.parse(body)
        const games = (data.dates || []).flatMap(d => d.games || [])
        const simplified = games.map(g => ({
          gamePk:   g.gamePk,
          awayId:   g.teams?.away?.team?.id || null,
          awayName: g.teams?.away?.team?.name || "",
          homeId:   g.teams?.home?.team?.id || null,
          homeName: g.teams?.home?.team?.name || "",
        }))
        res.status(200).json({ games: simplified })
      } catch {
        res.status(500).json({ error: "Failed to parse MLB response" })
      }
    })
  })

  proxyReq.setTimeout(REQUEST_TIMEOUT_MS, () => {
    proxyReq.destroy()
    if (responded) return
    responded = true
    res.status(504).json({ error: "MLB API timed out" })
  })

  proxyReq.on("error", err => {
    if (responded) return
    responded = true
    res.status(502).json({ error: err.message })
  })
}
