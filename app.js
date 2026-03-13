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

  else {

    result.innerHTML =
      "Platform detected but data fetching not added yet."

  }

}
