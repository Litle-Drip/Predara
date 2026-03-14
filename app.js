const PLATFORMS = {
  kalshi:     { label: "KALSHI",     accent: "#e05530" },
  polymarket: { label: "POLYMARKET", accent: "#7B3FE4" },
  gemini:     { label: "GEMINI",     accent: "#00DCFA" },
  coinbase:   { label: "COINBASE",   accent: "#1652F0" },
}

function toMoneyline(pct) {
  if (pct <= 1 || pct >= 99) return "—"
  return pct >= 50
    ? `-${Math.round(pct / (100 - pct) * 100)}`
    : `+${Math.round((100 - pct) / pct * 100)}`
}

function fmtDate(iso) {
  if (!iso || iso.startsWith("0001")) return "—"
  return new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
}

function fmtDateTime(iso) {
  if (!iso || iso.startsWith("0001")) return "—"
  return new Date(iso).toLocaleString("en-US", {
    month: "long", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short"
  })
}

function fmtNum(val) {
  const n = Math.round(parseFloat(val || 0))
  return n > 0 ? n.toLocaleString() : null
}

function statCard(label, value) {
  const inner = value
    ? `<div class="stat-value">${value}</div>`
    : `<div class="stat-dash"></div>`
  return `<div class="stat-card"><div class="stat-label">${label}</div>${inner}</div>`
}

function numList(sentences) {
  return sentences.map((s, i) => `
    <div class="num-row">
      <span class="num-idx">0${i + 1}</span>
      <span class="num-text">${s}</span>
    </div>`).join("")
}

function outcomeRow(label, sub, pct, color) {
  const ml = toMoneyline(pct)
  return `
    <div class="outcome-row">
      <div class="outcome-top">
        <div>
          <div class="outcome-name" style="color:${color}">${label}</div>
          ${sub ? `<div class="outcome-sub">${sub}</div>` : ""}
        </div>
        <div class="outcome-right">
          <span class="outcome-ml">${ml}</span>
          <span class="outcome-pct" style="color:${color}">${pct}%</span>
        </div>
      </div>
      <div class="bar-wrap">
        <div class="bar-fill" style="width:${pct}%; background:${color}"></div>
      </div>
    </div>`
}

function buildOutcomesHtml(visible, hidden) {
  if (!hidden.length) return visible.join("")
  return visible.join("") + `
    <div class="outcomes-overflow" style="display:none">${hidden.join("")}</div>
    <div class="show-more-row">
      <button class="show-more-btn" onclick="this.closest('.show-more-row').previousElementSibling.style.display='block';this.closest('.show-more-row').style.display='none'">
        + ${hidden.length} MORE UNDER 1.1%  ↓
      </button>
    </div>`
}

function renderKalshiEvent(ev, accent) {
  const markets = (ev.markets || []).filter(m => m.yes_sub_title)
  const first = markets[0] || {}

  // Sort highest probability first
  const sorted = [...markets].sort((a, b) =>
    parseFloat(b.last_price_dollars || 0) - parseFloat(a.last_price_dollars || 0))

  // Event meta
  const status     = first.status || "active"
  const statusDot  = status === "active" ? "dot-green" : status === "closed" ? "dot-red" : "dot-muted"
  const statusText = status.toUpperCase()
  const category   = ev.product_metadata?.competition || ev.category || "Markets"

  // Description: first sentence of rules_secondary
  const desc = (first.rules_secondary || first.rules_primary || "")
    .split(/\.\s+/)[0].replace(/^The following market refers to/, "Prediction market on") + "."

  // Outcomes
  const colors = ["#22c55e", "#ef4444", "#f59e0b", "#60a5fa"]
  const visibleKalshi = [], hiddenKalshi = []
  sorted.forEach((m, i) => {
    const lastPrice = parseFloat(m.last_price_dollars || 0)
    const yesBid = parseFloat(m.yes_bid_dollars || 0)
    const yesAsk = parseFloat(m.yes_ask_dollars || 0)
    const pct = lastPrice > 0
      ? Math.round(lastPrice * 100)
      : yesAsk > 0 ? Math.round((yesBid + yesAsk) / 2 * 100) : Math.round(yesBid * 100)
    const label = `${m.yes_sub_title} to win`
    const sub = (m.rules_primary || "")
      .replace(/^If /, "").replace(/, then the market resolves to Yes\.?$/, "")
    const row = outcomeRow(label, sub, pct, colors[i] || "#aaa")
    if (pct <= 1) hiddenKalshi.push(row)
    else visibleKalshi.push(row)
  })
  const outcomesHtml = buildOutcomesHtml(visibleKalshi, hiddenKalshi)

  // Aggregate stats
  const totalVol  = fmtNum(markets.reduce((s, m) => s + parseFloat(m.volume_fp || 0), 0))
  const totalLiq  = fmtNum(markets.reduce((s, m) => s + parseFloat(m.liquidity_dollars || 0), 0))
  const totalOI   = fmtNum(markets.reduce((s, m) => s + parseFloat(m.open_interest_fp || 0), 0))

  // Timeline
  const startDate = fmtDate(first.open_time)
  const endDate   = fmtDateTime(first.close_time)
  const expDate   = fmtDateTime(first.expected_expiration_time)

  // Rules from rules_secondary, split into sentences
  const rulesRaw = first.rules_secondary || first.rules_primary || ""
  const ruleSentences = rulesRaw
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim().replace(/\.$/, ""))
    .filter(s => s.length > 20 && !s.toLowerCase().startsWith("kalshi is not affiliated"))
    .slice(0, 6)

  return `
    <!-- Event header -->
    <div class="mi-card">
      <div class="event-head">
        <div class="event-tags">
          <span class="tag-platform">${PLATFORMS.kalshi.label}</span>
          <span class="tag-cat">${category.toUpperCase()}</span>
          <span class="tag-status">
            <span class="${statusDot}">●</span> ${statusText}
          </span>
        </div>
        <div class="event-title">${ev.title}${ev.sub_title ? " — " + ev.sub_title : ""}</div>
        <div class="event-desc">${desc}</div>
      </div>
    </div>

    <!-- Outcomes -->
    <div class="mi-card">
      <div class="section-label">OUTCOMES &amp; PROBABILITY</div>
      ${outcomesHtml}
    </div>

    <!-- Stats -->
    <div class="stats-grid">
      ${statCard("VOLUME TRADED", totalVol)}
      ${statCard("LIQUIDITY", totalLiq)}
      ${statCard("OPEN INTEREST", totalOI)}
    </div>

    <!-- Timeline -->
    <div class="mi-card">
      <div class="section-label">TIMELINE</div>
      <div class="info-row"><span class="info-key">Start date</span><span class="info-val">${startDate}</span></div>
      <div class="info-row"><span class="info-key">End / expiry</span><span class="info-val">${endDate}</span></div>
      <div class="info-row"><span class="info-key">Expected resolution</span><span class="info-val">${expDate}</span></div>
    </div>

    ${ruleSentences.length ? `
    <!-- Rules -->
    <div class="mi-card">
      <div class="section-label">RULES &amp; CRITERIA</div>
      <div class="num-list">${numList(ruleSentences)}</div>
    </div>` : ""}
  `
}

function renderPolymarketEvent(event, markets, accent) {
  const statusDot  = event.closed ? "dot-red" : "dot-green"
  const statusText = event.closed ? "CLOSED" : "OPEN"

  const colors = ["#22c55e", "#ef4444", "#f59e0b", "#60a5fa"]
  const visiblePoly = [], hiddenPoly = []
  markets.forEach((market, idx) => {
    const outcomes = typeof market.outcomes === "string" ? JSON.parse(market.outcomes) : market.outcomes
    const prices   = typeof market.outcomePrices === "string" ? JSON.parse(market.outcomePrices) : market.outcomePrices
    ;(outcomes || []).forEach((name, i) => {
      const pct = Math.round(parseFloat(prices ? prices[i] : 0) * 100)
      const row = outcomeRow(name, "", pct, colors[(idx + i) % colors.length])
      if (pct <= 1) hiddenPoly.push(row)
      else visiblePoly.push(row)
    })
  })
  const outcomesHtml = buildOutcomesHtml(visiblePoly, hiddenPoly)

  const first = markets[0] || {}
  const totalVol  = fmtNum(parseFloat(event.volume || 0))
  const totalLiq  = fmtNum(parseFloat(event.liquidity || first.liquidity || 0))
  const totalVol24 = fmtNum(parseFloat(event.volume24hr || first.volume24hr || 0))

  return `
    <div class="mi-card">
      <div class="event-head">
        <div class="event-tags">
          <span class="tag-platform" style="background:${accent}">${PLATFORMS.polymarket.label}</span>
          <span class="tag-status"><span class="${statusDot}">●</span> ${statusText}</span>
        </div>
        <div class="event-title">${event.title}</div>
        ${event.description ? `<div class="event-desc">${event.description}</div>` : ""}
      </div>
    </div>

    <div class="mi-card">
      <div class="section-label">OUTCOMES &amp; PROBABILITY</div>
      ${outcomesHtml}
    </div>

    <div class="stats-grid">
      ${statCard("VOLUME TRADED", totalVol ? `$${totalVol}` : null)}
      ${statCard("24H VOLUME", totalVol24 ? `$${totalVol24}` : null)}
      ${statCard("LIQUIDITY", totalLiq ? `$${totalLiq}` : null)}
    </div>

    ${event.endDate ? `
    <div class="mi-card">
      <div class="section-label">TIMELINE</div>
      <div class="info-row"><span class="info-key">End date</span><span class="info-val">${fmtDate(event.endDate)}</span></div>
    </div>` : ""}
  `
}

async function analyze() {
  const url = document.getElementById("urlInput").value.trim()
  const result = document.getElementById("result")
  result.innerHTML = `<div class="mi-loading">ANALYZING...</div>`

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
      if (!res.ok) throw new Error(`API error ${res.status}`)
      const data = await res.json()

      const event = Array.isArray(data) ? data[0] : data
      if (!event) throw new Error("No event found.")
      const markets = event.markets || []
      if (!markets.length) throw new Error("No market data found.")

      result.innerHTML = renderPolymarketEvent(event, markets, accent)
    } catch (err) {
      console.error(err)
      result.innerHTML = `<div class="mi-error">ERROR: ${err.message}</div>`
    }

  } else if (platform === "kalshi") {
    try {
      if (!url.includes("/markets/") && !url.includes("/events/")) {
        throw new Error("Invalid Kalshi URL.")
      }
      const cleanPath = url.split("?")[0].split("#")[0].replace(/\/$/, "")
      const ticker = cleanPath.split("/").pop().toUpperCase()

      const res = await fetch(`/api/kalshi?ticker=${encodeURIComponent(ticker)}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `API error ${res.status}`)

      if (data.event) {
        result.innerHTML = renderKalshiEvent(data.event, accent)
      } else if (data.market) {
        // Single market — wrap in minimal event structure
        const m = data.market
        const fakeEvent = {
          title: m.title,
          sub_title: "",
          category: "Markets",
          markets: [m],
          product_metadata: {},
        }
        result.innerHTML = renderKalshiEvent(fakeEvent, accent)
      } else {
        throw new Error("Unexpected API response.")
      }
    } catch (err) {
      console.error(err)
      result.innerHTML = `<div class="mi-error">ERROR: ${err.message}</div>`
    }

  } else {
    result.innerHTML = `<div class="mi-loading">PLATFORM NOT YET SUPPORTED</div>`
  }
}
