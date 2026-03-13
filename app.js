const PLATFORMS = {
  kalshi:     { label: "Kalshi",     accent: "#00C2CB" },
  polymarket: { label: "Polymarket", accent: "#7B3FE4" },
  gemini:     { label: "Gemini",     accent: "#00DCFA" },
  coinbase:   { label: "Coinbase",   accent: "#1652F0" },
}

function platformBadge(platform) {
  const p = PLATFORMS[platform]
  if (!p) return ""
  return `<span class="platform-badge" style="background:${p.accent}22; color:${p.accent}">${p.label}</span>`
}

function priceChangeHtml(lastPct, prevPct) {
  if (!prevPct || prevPct === 0) return ""
  const delta = lastPct - prevPct
  if (delta === 0) return ""
  const up = delta > 0
  const color = up ? "#4ade80" : "#f87171"
  const bg    = up ? "#4ade8018" : "#f8717118"
  return `<span class="price-change" style="color:${color};background:${bg}">${up ? "▲" : "▼"} ${Math.abs(delta)}pp</span>`
}

function marketCard(label, yesPct, metaRows, accent) {
  const noPct = 100 - yesPct
  const statusClass = metaRows.statusRaw === "active" ? "status-active"
    : metaRows.statusRaw === "closed" ? "status-closed"
    : metaRows.statusRaw === "settled" ? "status-settled" : ""

  const metaHtml = [
    metaRows.volume    ? `<span><b>Volume</b> ${metaRows.volume}</span>` : "",
    metaRows.volume24h ? `<span><b>24h Vol</b> ${metaRows.volume24h}</span>` : "",
    metaRows.liquidity ? `<span><b>Liquidity</b> ${metaRows.liquidity}</span>` : "",
    metaRows.spread    ? `<span><b>Spread</b> ${metaRows.spread}</span>` : "",
    metaRows.oi        ? `<span><b>Open Interest</b> ${metaRows.oi}</span>` : "",
    metaRows.status    ? `<span><b>Status</b> <span class="${statusClass}">${metaRows.status}</span></span>` : "",
    metaRows.result    ? `<span class="full"><b>Result</b> ${metaRows.result}</span>` : "",
    metaRows.closes    ? `<span class="full"><b>Closes</b> ${metaRows.closes}</span>` : "",
  ].filter(Boolean).join("")

  const rulesHtml = metaRows.rules
    ? `<div class="card-rules"><b>Settlement:</b> ${metaRows.rules}</div>`
    : ""

  return `
    <div class="market-card" style="--accent:${accent}">
      <div class="card-label">${label}${metaRows.priceChange || ""}</div>
      <div class="card-probs">
        <span class="yes">${yesPct}%</span>
        <span style="color:#444; font-weight:300; margin:0 6px">/</span>
        <span class="no">${noPct}% No</span>
      </div>
      <div class="prob-bar-wrap"><div class="prob-bar" style="width:${yesPct}%"></div></div>
      <div class="card-meta">${metaHtml}</div>
      ${rulesHtml}
    </div>
  `
}

async function analyze() {
  const url = document.getElementById("urlInput").value.trim()
  const result = document.getElementById("result")
  result.innerHTML = "Analyzing..."

  const lowerUrl = url.toLowerCase()
  let platform = "unknown"
  if (lowerUrl.includes("kalshi"))     platform = "kalshi"
  if (lowerUrl.includes("polymarket")) platform = "polymarket"
  if (lowerUrl.includes("gemini"))     platform = "gemini"
  if (lowerUrl.includes("coinbase"))   platform = "coinbase"

  const accent = (PLATFORMS[platform] || {}).accent || "#555"

  if (platform === "polymarket") {

    try {

      const eventPart = url.split("/event/")[1]
      if (!eventPart) throw new Error("Invalid Polymarket URL. Expected: polymarket.com/event/<slug>")
      const slug = eventPart.split("?")[0].split("#")[0].replace(/\/$/, "")

      const res = await fetch(`/api/polymarket?slug=${encodeURIComponent(slug)}`)
      if (!res.ok) throw new Error(`API request failed with status ${res.status}`)
      const data = await res.json()

      const event = Array.isArray(data) ? data[0] : data
      if (!event) throw new Error("No event found for that URL.")
      const market = event.markets && event.markets[0]
      if (!market) throw new Error("No market data found in event.")

      const outcomes = typeof market.outcomes === "string" ? JSON.parse(market.outcomes) : market.outcomes
      const prices   = typeof market.outcomePrices === "string" ? JSON.parse(market.outcomePrices) : market.outcomePrices

      const vol      = parseFloat(event.volume || 0)
      const vol24h   = parseFloat(event.volume24hr || market.volume24hr || 0)
      const liquidity = parseFloat(event.liquidity || market.liquidity || 0)

      let subParts = [`$${vol.toLocaleString(undefined, {maximumFractionDigits:0})} volume`]
      if (vol24h > 0) subParts.push(`$${vol24h.toLocaleString(undefined, {maximumFractionDigits:0})} 24h`)
      if (liquidity > 0) subParts.push(`$${liquidity.toLocaleString(undefined, {maximumFractionDigits:0})} liquidity`)

      let html = `
        <div class="result-header">
          <h2>${event.title}</h2>
          ${platformBadge(platform)}
        </div>
        <p class="result-sub">${subParts.join(" · ")}</p>
      `
      outcomes.forEach((name, i) => {
        const pct      = Math.round(parseFloat(prices ? prices[i] : 0) * 100)
        const bestBid  = parseFloat(market.bestBid || 0)
        const bestAsk  = parseFloat(market.bestAsk || 0)
        const spreadCts = bestAsk > 0 && bestBid > 0
          ? `${Math.round((bestAsk - bestBid) * 100)}¢`
          : null
        const question = market.question || ""
        const rules = question.length > 160 ? question.slice(0, 157) + "…" : question
        html += marketCard(name, pct, {
          spread: spreadCts,
          rules,
        }, accent)
      })

      result.innerHTML = html

    } catch (err) {
      console.error("Polymarket fetch error:", err)
      result.innerHTML = `Could not fetch Polymarket data: ${err.message}`
    }

  } else if (platform === "kalshi") {

    try {

      if (!url.includes("/markets/") && !url.includes("/events/")) {
        throw new Error("Invalid Kalshi URL. Expected: kalshi.com/markets/... or kalshi.com/events/...")
      }
      const cleanPath = url.split("?")[0].split("#")[0].replace(/\/$/, "")
      const ticker = cleanPath.split("/").pop().toUpperCase()

      const res = await fetch(`/api/kalshi?ticker=${encodeURIComponent(ticker)}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `API request failed with status ${res.status}`)

      function kalshiCard(m) {
        // Use last_price_dollars as primary probability; fall back to bid/ask midpoint
        const lastPrice = parseFloat(m.last_price_dollars || 0)
        const yesBid    = parseFloat(m.yes_bid_dollars || 0)
        const yesAsk    = parseFloat(m.yes_ask_dollars || 0)
        const yesPct = lastPrice > 0
          ? Math.round(lastPrice * 100)
          : yesAsk > 0 ? Math.round((yesBid + yesAsk) / 2 * 100) : Math.round(yesBid * 100)

        const prevPct   = Math.round(parseFloat(m.previous_price_dollars || 0) * 100)
        const spreadCts = yesAsk > 0 && yesBid > 0
          ? `${Math.round((yesAsk - yesBid) * 100)}¢`
          : null
        const liquidity = parseFloat(m.liquidity_dollars || 0)
        const label = m.yes_sub_title ? `${m.yes_sub_title} wins?` : m.title
        const rules = m.rules_primary
          ? (m.rules_primary.length > 160 ? m.rules_primary.slice(0, 157) + "…" : m.rules_primary)
          : ""

        return marketCard(label, yesPct, {
          priceChange: priceChangeHtml(yesPct, prevPct),
          volume:      Math.round(parseFloat(m.volume_fp     || 0)).toLocaleString(),
          volume24h:   Math.round(parseFloat(m.volume_24h_fp || 0)).toLocaleString(),
          liquidity:   liquidity > 0 ? `$${liquidity.toLocaleString(undefined, {maximumFractionDigits:2})}` : null,
          spread:      spreadCts,
          oi:          Math.round(parseFloat(m.open_interest_fp || 0)).toLocaleString(),
          status:      m.status ? m.status.charAt(0).toUpperCase() + m.status.slice(1) : "",
          statusRaw:   m.status || "",
          result:      m.result ? m.result.toUpperCase() : "",
          closes:      m.close_time ? new Date(m.close_time).toLocaleString() : "",
          rules,
        }, accent)
      }

      if (data.market) {
        const m = data.market
        result.innerHTML = `
          <div class="result-header">
            <h2>${m.yes_sub_title ? `${m.yes_sub_title} wins?` : m.title}</h2>
            ${platformBadge(platform)}
          </div>
        ` + kalshiCard(m)

      } else if (data.event) {
        const ev = data.event
        let html = `
          <div class="result-header">
            <h2>${ev.title}</h2>
            ${platformBadge(platform)}
          </div>
          ${ev.sub_title ? `<p class="result-sub">${ev.sub_title}</p>` : ""}
        `
        ;(ev.markets || []).forEach(m => { html += kalshiCard(m) })
        result.innerHTML = html

      } else {
        throw new Error("Unexpected response from Kalshi API.")
      }

    } catch (err) {
      console.error("Kalshi fetch error:", err)
      result.innerHTML = `Could not fetch Kalshi data: ${err.message}`
    }

  } else {
    result.innerHTML = "Platform detected but data fetching not added yet."
  }
}
