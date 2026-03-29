// ── Comparison helpers ────────────────────────────────────────────────────────

function fmtCompareNum(n) {
  if (!n || !Number.isFinite(n) || n <= 0) return "—"
  return "$" + Math.round(n).toLocaleString()
}

function extractTopOutcomes(platform, data) {
  try {
    if (platform === "kalshi") {
      const ev = data.event || (data.market ? { title: data.market.title, markets: [data.market] } : null)
      if (!ev) return { title: "", topOutcomes: [], stats: [] }
      const markets = (ev.markets || []).filter(m => m.yes_sub_title)
      const sorted = [...markets].sort((a, b) => parseFloat(b.last_price_dollars || 0) - parseFloat(a.last_price_dollars || 0))
      const vol   = markets.reduce((s, m) => s + parseFloat(m.volume_fp || 0), 0) / 100
      const vol24 = markets.reduce((s, m) => s + parseFloat(m.volume_24h_fp || 0), 0) / 100
      const oi    = markets.reduce((s, m) => s + parseFloat(m.open_interest_fp || 0), 0) / 100
      const spreads = markets.map(m => parseFloat(m.yes_ask_dollars || 0) - parseFloat(m.yes_bid_dollars || 0)).filter(s => s > 0)
      const minSpread = spreads.length ? Math.min(...spreads) : null
      const overround = markets.reduce((s, m) => s + parseFloat(m.last_price_dollars || 0), 0)
      return {
        title: ev.title || "",
        topOutcomes: sorted.slice(0, 3).map((m, i) => ({
          name: m.yes_sub_title,
          pct: Math.round(parseFloat(m.last_price_dollars || 0) * 100),
          color: OUTCOME_COLORS[i],
        })),
        stats: [
          { label: "Volume",        value: fmtCompareNum(vol) },
          { label: "24h Volume",    value: fmtCompareNum(vol24) },
          { label: "Open Interest", value: fmtCompareNum(oi) },
          { label: "Best Spread",   value: minSpread != null ? Math.round(minSpread * 100) + "¢" : "—" },
          { label: "Overround",     value: overround > 0 ? Math.round(overround * 100) + "%" : "—" },
        ],
      }
    }
    if (platform === "polymarket" || platform === "coinbase") {
      const event = Array.isArray(data) ? data[0] : data
      if (!event) return { title: "", topOutcomes: [], stats: [] }
      const all = []
      ;(event.markets || []).forEach(market => {
        let outcomes, prices
        try {
          outcomes = typeof market.outcomes === "string" ? JSON.parse(market.outcomes) : market.outcomes
          prices   = typeof market.outcomePrices === "string" ? JSON.parse(market.outcomePrices) : market.outcomePrices
        } catch (e) { return }
        if (!Array.isArray(outcomes) || !Array.isArray(prices)) return
        outcomes.forEach((name, i) => {
          if (i < prices.length) all.push({ name, pct: Math.round(parseFloat(prices[i] || 0) * 100) })
        })
      })
      all.sort((a, b) => b.pct - a.pct)
      return { title: event.title || "", topOutcomes: all.slice(0, 3).map((o, i) => ({ ...o, color: OUTCOME_COLORS[i] })), stats: [] }
    }
    if (platform === "gemini") {
      if (!data || !data.title) return { title: "", topOutcomes: [], stats: [] }
      const contracts = Array.isArray(data.contracts) ? data.contracts : []
      const extracted = contracts.map((c, i) => {
        const price = geminiExtractPrice(c)
        const name  = geminiExtractName(c, `Outcome ${i + 1}`)
        return { name, pct: Math.round(price * 100), color: OUTCOME_COLORS[i % OUTCOME_COLORS.length] }
      })
      extracted.sort((a, b) => b.pct - a.pct)
      const vol   = parseFloat(data.volume || 0)
      const vol24 = parseFloat(data.volume24h || 0)
      const spreads = contracts.map(c => {
        const ask = parseFloat((c.prices || {}).bestAsk || 0)
        const bid = parseFloat((c.prices || {}).bestBid || 0)
        return ask > 0 && bid > 0 ? ask - bid : null
      }).filter(s => s !== null && s > 0)
      const minSpread = spreads.length ? Math.min(...spreads) : null
      return {
        title: data.title,
        topOutcomes: extracted.slice(0, 3),
        stats: [
          { label: "Volume",        value: fmtCompareNum(vol) },
          { label: "24h Volume",    value: fmtCompareNum(vol24) },
          { label: "Open Interest", value: "—" },
          { label: "Best Spread",   value: minSpread != null ? Math.round(minSpread * 100) + "¢" : "—" },
          { label: "Overround",     value: "~100%" },
        ],
      }
    }
  } catch (e) {}
  return { title: "", topOutcomes: [], stats: [] }
}

// Fetch one market URL and return { html, meta, platform, accent, rawData, error }
async function fetchOneMarket(url) {
  let expandedUrl = (url || "").trim()
  if (!expandedUrl) return null
  const geminiTickerRe = /^[A-Z][A-Z0-9\-]{2,}$/i
  if (geminiTickerRe.test(expandedUrl) && !expandedUrl.startsWith("http")) {
    expandedUrl = `https://www.gemini.com/predictions/${expandedUrl.toUpperCase()}`
  }
  const lowerUrl = expandedUrl.toLowerCase()
  let platform = "unknown"
  if      (lowerUrl.includes("kalshi"))     platform = "kalshi"
  else if (lowerUrl.includes("polymarket")) platform = "polymarket"
  else if (lowerUrl.includes("coinbase"))   platform = "coinbase"
  else if (lowerUrl.includes("gemini"))     platform = "gemini"
  const accent = (PLATFORMS[platform] || {}).accent || "#555"

  try {
    if (platform === "polymarket" || platform === "coinbase") {
      let slug = ""
      if (platform === "polymarket") {
        const part = expandedUrl.split("/event/")[1]
        if (!part) return { error: "Invalid Polymarket URL", platform, accent }
        slug = part.split("?")[0].split("#")[0].replace(/\/$/, "")
      } else {
        const clean = expandedUrl.split("?")[0].split("#")[0].replace(/\/$/, "")
        slug = clean.split("/").pop()
        if (!slug || slug === "markets" || slug === "predictions" || slug === "event") return { error: "Invalid Coinbase URL", platform, accent }

        // www.coinbase.com/predictions/event/ URLs use uppercase Kalshi-style tickers.
        if (slug !== slug.toLowerCase()) {
          const kr = await fetch(`/api/kalshi?ticker=${encodeURIComponent(slug)}`)
          if (kr.ok) {
            const kd = await kr.json().catch(() => ({}))
            if (kd.event || kd.market) {
              let rawData
              if (kd.event) {
                kd.event._allMarkets = [...(kd.event.markets || [])]
                rawData = kd
              } else {
                const fakeEv = { title: kd.market.title, sub_title: "", category: "Markets", markets: [kd.market], product_metadata: {} }
                rawData = { event: fakeEv }
                kd.event = fakeEv
              }
              const html = renderKalshiEvent(kd.event, accent, "coinbase")
              return { html, meta: extractTopOutcomes("kalshi", rawData), platform, accent, rawData }
            }
          }
          if (!kr.ok && kr.status !== undefined) {
            const e = await kr.json().catch(() => ({}))
            return { error: e.error || `Kalshi API ${kr.status}`, platform, accent }
          }
          // Fall through to Polymarket on unexpected errors
        }
      }
      const res = await fetch(`/api/polymarket?slug=${encodeURIComponent(slug)}`)
      if (!res.ok) return { error: `Polymarket API ${res.status}`, platform, accent }
      const data = await res.json()
      const event = Array.isArray(data) ? data[0] : data
      if (!event) return { error: "Event not found", platform, accent }
      const markets = event.markets || []
      if (!markets.length) return { error: "No market data", platform, accent }
      return { html: renderPolymarketEvent(event, markets, accent, platform), meta: extractTopOutcomes(platform, data), platform, accent, rawData: data }

    } else if (platform === "kalshi") {
      if (!expandedUrl.includes("/markets/") && !expandedUrl.includes("/events/")) return { error: "Invalid Kalshi URL — needs /markets/<ticker>", platform, accent }
      const cleanPath = expandedUrl.split("?")[0].split("#")[0].replace(/\/$/, "")
      const pathParts = cleanPath.split("/")
      const marketsIdx = pathParts.findIndex(p => p === "markets" || p === "events")
      const eventTicker = marketsIdx !== -1 && pathParts[marketsIdx + 1] ? pathParts[marketsIdx + 1].toUpperCase() : null
      const ticker = pathParts[pathParts.length - 1].toUpperCase()
      let data = null
      if (eventTicker && eventTicker !== ticker) {
        const er = await fetch(`/api/kalshi?ticker=${encodeURIComponent(eventTicker)}`)
        if (er.ok) data = await er.json()
      }
      if (!data || (!data.event && !data.market)) {
        const res = await fetch(`/api/kalshi?ticker=${encodeURIComponent(ticker)}`)
        if (!res.ok) { const e = await res.json().catch(() => ({})); return { error: e.error || `Kalshi API ${res.status}`, platform, accent } }
        data = await res.json()
      }
      let html, rawData
      if (data.event) {
        data.event._allMarkets = [...(data.event.markets || [])]
        if (ticker !== eventTicker && data.event.markets && !data.event.mutually_exclusive) {
          const specific = data.event.markets.filter(m => m.ticker?.toUpperCase() === ticker)
          if (specific.length > 0) data.event.markets = specific
        }
        html = renderKalshiEvent(data.event, accent)
        rawData = data
      } else if (data.market) {
        const fakeEv = { title: data.market.title, sub_title: "", category: "Markets", markets: [data.market], product_metadata: {} }
        html = renderKalshiEvent(fakeEv, accent)
        rawData = { event: fakeEv }
      } else { return { error: "Unexpected Kalshi response", platform, accent } }
      return { html, meta: extractTopOutcomes(platform, rawData), platform, accent, rawData }

    } else if (platform === "gemini") {
      if (!lowerUrl.includes("/prediction-markets/") && !lowerUrl.includes("/predictions/")) return { error: "Invalid Gemini URL — needs /predictions/<ticker>", platform, accent }
      const cleanPath = expandedUrl.split("?")[0].split("#")[0].replace(/\/$/, "")
      const pathParts = cleanPath.split("/").filter(Boolean)
      const predIdx = pathParts.findIndex(p => p.toLowerCase() === "predictions" || p.toLowerCase() === "prediction-markets")
      const ticker = predIdx !== -1 && pathParts[predIdx + 1] ? pathParts[predIdx + 1] : pathParts[pathParts.length - 1]
      if (!ticker || ticker.toLowerCase() === "prediction-markets" || ticker.toLowerCase() === "predictions") return { error: "Invalid Gemini URL", platform, accent }
      const res = await fetch(`/api/gemini?ticker=${encodeURIComponent(ticker)}`)
      if (!res.ok) { const e = await res.json().catch(() => ({})); return { error: e.error || `Gemini API ${res.status}`, platform, accent } }
      const data = await res.json()
      if (!data || !data.title) return { error: "No Gemini event data", platform, accent }
      return { html: renderGeminiEvent(data, accent), meta: extractTopOutcomes(platform, data), platform, accent, rawData: data }

    } else {
      return { error: "Unrecognized platform", platform, accent }
    }
  } catch (err) {
    return { error: err.message, platform, accent }
  }
}

function renderComparison(results) {
  const cols = results.map((r, i) => {
    if (!r || r.error) {
      return `<div class="compare-col">
        <div class="compare-col-title">Market ${i + 1}</div>
        <div class="compare-col-empty">⚠ ${esc(r ? r.error : "Failed to load")}</div>
      </div>`
    }
    const { meta, accent, platform } = r
    const platformLabel = (PLATFORMS[platform] || {}).label || platform.toUpperCase()
    const outcomesHtml = (meta.topOutcomes || []).map(o =>
      `<div class="compare-outcome">
        <span class="compare-outcome-name" style="color:${o.color}">${esc(o.name)}</span>
        <span class="compare-outcome-pct" style="color:${o.color}">${o.pct}%</span>
      </div>`
    ).join("") || `<div class="compare-col-empty">No outcome data</div>`
    const statsHtml = (meta.stats || []).length
      ? `<div class="compare-stats">${(meta.stats).map(s =>
          `<div class="compare-stat-row">
            <span class="compare-stat-label">${esc(s.label)}</span>
            <span class="compare-stat-value">${esc(s.value)}</span>
          </div>`
        ).join("")}</div>`
      : ""
    return `<div class="compare-col">
      <span class="tag-platform" style="background:${accent};font-size:9px;padding:3px 8px;border-radius:3px">${esc(platformLabel)}</span>
      <div class="compare-col-title">${esc(meta.title || "")}</div>
      ${outcomesHtml}
      ${statsHtml}
    </div>`
  }).join("")

  return `<div class="mi-card" style="margin-bottom:24px">
    <div class="section-label">COMPARING ${results.length} MARKETS</div>
    <div class="compare-cols">${cols}</div>
  </div>
  <div class="compare-details-label">FULL ANALYSES</div>`
}

let _compareMode = false
function toggleCompareMode() {
  _compareMode = !_compareMode
  const section = document.getElementById("compareSection")
  const btn = document.getElementById("compareToggleBtn")
  if (section) section.style.display = _compareMode ? "grid" : "none"
  if (btn) {
    btn.textContent = _compareMode ? "− HIDE COMPARE" : "+ COMPARE MARKETS"
    btn.classList.toggle("active", _compareMode)
  }
}

async function analyzeCompare() {
  const urls = [
    document.getElementById("urlInput").value.trim(),
    document.getElementById("urlInput2").value.trim(),
    document.getElementById("urlInput3").value.trim(),
  ].filter(Boolean)

  if (urls.length < 2) {
    showError("Enter at least 2 market URLs to compare.", "Fill the second URL input in the compare section below.")
    return
  }

  const result = document.getElementById("result")
  const btn = document.getElementById("compareSubmitBtn")
  if (btn) { btn.disabled = true; btn.textContent = "COMPARING…" }
  const shareBarEl = document.getElementById("shareBar")
  if (shareBarEl) shareBarEl.style.display = "none"
  result.innerHTML = `<div class="mi-loading"><span class="mi-spinner"></span>COMPARING ${urls.length} MARKETS</div>`

  const results = await Promise.all(urls.map(fetchOneMarket))

  const detailsHtml = results.map((r, i) => {
    if (!r || r.error) return `<div class="mi-error"><div class="error-content"><span>Market ${i + 1}: ${esc(r ? r.error : "Failed to load")}</span></div></div>`
    return r.html
  }).join('<hr class="compare-separator">')

  result.innerHTML = renderComparison(results) + detailsHtml

  // Share link encodes all URLs joined by newline
  addShareBar(urls.join("\n"))

  if (btn) { btn.disabled = false; btn.textContent = "COMPARE ↗" }
}

function addShareBar(marketUrl) {
  const encoded = encodeURIComponent(marketUrl)
  history.pushState({ q: marketUrl }, "", `${location.pathname}?q=${encoded}`)
  const shareBarEl = document.getElementById("shareBar")
  if (shareBarEl) shareBarEl.style.display = "flex"
  const copyBtn = document.getElementById("copyLinkBtn")
  if (copyBtn) copyBtn.textContent = "COPY LINK ↗"

  // Auto-expand compare markets section on event load
  if (!_compareMode) {
    _compareMode = true
    const section = document.getElementById("compareSection")
    const btn = document.getElementById("compareToggleBtn")
    if (section) section.style.display = "grid"
    if (btn) {
      btn.textContent = "− HIDE COMPARE"
      btn.classList.add("active")
    }
  }
}

// ── End comparison helpers ────────────────────────────────────────────────────
