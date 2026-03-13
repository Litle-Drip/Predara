async function analyze() {

  const url = document.getElementById("urlInput").value.trim()

  const result = document.getElementById("result")

  result.innerHTML = "Analyzing..."

  const lowerUrl = url.toLowerCase()

  let platform = "unknown"

  if (lowerUrl.includes("kalshi")) platform = "kalshi"
  if (lowerUrl.includes("polymarket")) platform = "polymarket"
  if (lowerUrl.includes("gemini")) platform = "gemini"
  if (lowerUrl.includes("coinbase")) platform = "coinbase"

  if (platform === "polymarket") {

    try {

      // Extract slug and strip any query params or hash fragments
      const eventPart = url.split("/event/")[1]
      if (!eventPart) throw new Error("Invalid Polymarket URL. Expected: polymarket.com/event/<slug>")
      const slug = eventPart.split("?")[0].split("#")[0].replace(/\/$/, "")

      // Use the local server proxy to avoid CORS/ad-blocker issues
      const api = `/api/polymarket?slug=${encodeURIComponent(slug)}`

      const res = await fetch(api)

      if (!res.ok) throw new Error(`API request failed with status ${res.status}`)

      const data = await res.json()

      // Response is an array — grab the first matching event
      const event = Array.isArray(data) ? data[0] : data
      if (!event) throw new Error("No event found for that URL.")

      const market = event.markets && event.markets[0]
      if (!market) throw new Error("No market data found in event.")

      // outcomes and outcomePrices are JSON strings in the API response
      const outcomes = typeof market.outcomes === "string"
        ? JSON.parse(market.outcomes)
        : market.outcomes

      const prices = typeof market.outcomePrices === "string"
        ? JSON.parse(market.outcomePrices)
        : market.outcomePrices

      let html = `
        <h2>${event.title}</h2>
        <p><b>Volume:</b> $${parseFloat(event.volume || 0).toLocaleString()}</p>
        <h3>Outcomes</h3>
      `

      outcomes.forEach((name, i) => {
        const price = prices ? parseFloat(prices[i]) : 0
        html += `<p>${name} — ${Math.round(price * 100)}%</p>`
      })

      result.innerHTML = html

    } catch (err) {

      console.error("Polymarket fetch error:", err)
      result.innerHTML = `Could not fetch Polymarket data: ${err.message}`

    }

  }

  else if (platform === "kalshi") {

    try {

      // Extract the last path segment (before any query/hash) as the ticker
      // Kalshi market URLs can have 2 or 3 segments after /markets/ — the last is always the ticker
      // e.g. /markets/kxncaambgame/mens-college-basketball-mens-game/kxncaambgame-26mar13wisill
      const cleanPath = url.split("?")[0].split("#")[0].replace(/\/$/, "")
      const lastSegment = cleanPath.split("/").pop().toUpperCase()

      let ticker, type
      if (url.includes("/markets/")) {
        ticker = lastSegment
        type = "market"
      } else if (url.includes("/events/")) {
        ticker = lastSegment
        type = "event"
      } else {
        throw new Error("Invalid Kalshi URL. Expected: kalshi.com/markets/... or kalshi.com/events/...")
      }

      const api = `/api/kalshi?ticker=${encodeURIComponent(ticker)}&type=${type}`

      const res = await fetch(api)

      const data = await res.json()

      if (!res.ok) throw new Error(data.error || `API request failed with status ${res.status}`)

      // Market URL response: { market: { title, yes_bid, no_bid, volume } }
      // Event URL response: { event: { title, markets: [...] } }
      if (data.market) {

        const m = data.market
        const yesPct = Math.round((m.yes_bid || 0) * 100)
        const noPct = Math.round((m.no_bid || 0) * 100)

        result.innerHTML = `
          <h2>${m.title}</h2>
          <p><b>Volume:</b> $${(m.volume || 0).toLocaleString()}</p>
          <h3>Outcomes</h3>
          <p>Yes — ${yesPct}%</p>
          <p>No — ${noPct}%</p>
        `

      } else if (data.event) {

        const ev = data.event
        let html = `<h2>${ev.title}</h2><h3>Markets</h3>`

        ;(ev.markets || []).forEach(m => {
          const yesPct = Math.round((m.yes_bid || 0) * 100)
          html += `<p><b>${m.title}</b> — Yes: ${yesPct}%</p>`
        })

        result.innerHTML = html

      } else {
        throw new Error("Unexpected response from Kalshi API.")
      }

    } catch (err) {

      console.error("Kalshi fetch error:", err)
      result.innerHTML = `Could not fetch Kalshi data: ${err.message}`

    }

  }

  else {

    result.innerHTML =
      "Platform detected but data fetching not added yet."

  }

}
