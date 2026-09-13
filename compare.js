// ── Comparison helpers ────────────────────────────────────────────────────────

const PLATFORM_FOOTNOTES = {
  kalshi:     "US-regulated by the CFTC. Real money. Requires US residency.",
  polymarket: "Decentralized (Polygon blockchain). Global access. US users may need VPN.",
  gemini:     "Operated by Gemini exchange. Smaller market selection.",
  coinbase:   "Available to Coinbase users. Routed via Kalshi (uppercase tickers) or Polymarket (lowercase slugs) depending on the market.",
}

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
      // Use bid/ask midpoint as the live price; fall back to last trade when unavailable
      const mktPrice = m => {
        const bid = parseFloat(m.yes_bid_dollars || 0)
        const ask = parseFloat(m.yes_ask_dollars || 0)
        return (bid > 0 && ask > 0) ? (bid + ask) / 2 : parseFloat(m.last_price_dollars || 0)
      }
      const sorted = [...markets].sort((a, b) => mktPrice(b) - mktPrice(a))
      const vol   = markets.reduce((s, m) => s + parseFloat(m.volume_fp || 0), 0) / 100
      const vol24 = markets.reduce((s, m) => s + parseFloat(m.volume_24h_fp || 0), 0) / 100
      const oi    = markets.reduce((s, m) => s + parseFloat(m.open_interest_fp || 0), 0) / 100
      const spreads = markets.map(m => parseFloat(m.yes_ask_dollars || 0) - parseFloat(m.yes_bid_dollars || 0)).filter(s => s > 0)
      const minSpread = spreads.length ? Math.min(...spreads) : null
      // Overround = sum of ask-side probabilities across all outcomes. For a
      // multi-outcome event each yes_sub_title market is one outcome, so the
      // sum of YES prices is correct. For a single-market true-binary event
      // we must also add the implicit NO side (≈ 1 - YES_bid), otherwise
      // overround would show ~50% on every binary market.
      let overround = markets.reduce((s, m) => {
        const ask = parseFloat(m.yes_ask_dollars || 0)
        return s + (ask > 0 ? ask : mktPrice(m))
      }, 0)
      if (markets.length === 1) {
        const m = markets[0]
        const yesBid = parseFloat(m.yes_bid_dollars || 0)
        const noAsk = yesBid > 0 && yesBid < 1 ? 1 - yesBid : 1 - mktPrice(m)
        overround += Math.max(0, noAsk)
      }
      const isBinary = sorted.length === 2 || markets.length === 1
      return {
        title: ev.title || "",
        isBinary,
        topOutcomes: sorted.slice(0, 3).map((m, i) => (
          { name: m.yes_sub_title, pct: Math.round(mktPrice(m) * 100), color: OUTCOME_COLORS[i], rank: i }
        )),
        stats: [
          { label: "Volume",        value: fmtCompareNum(vol) },
          { label: "24h Volume",    value: fmtCompareNum(vol24) },
          { label: "Open Interest", value: fmtCompareNum(oi) },
          { label: "Best Spread",   value: minSpread != null ? Math.round(minSpread * 100) + "¢" : "—" },
          { label: "Overround",     value: overround > 0 ? Math.round(overround * 100) + "%" : "—" },
        ],
      }
    }
    if (platform === "coinbase") {
      // Coinbase has two product surfaces with different backings:
      //   www.coinbase.com/predictions/event/<UPPERCASE_TICKER> → Kalshi-backed
      //   predict.coinbase.com/markets/<lowercase-slug>          → Polymarket-backed
      // The Kalshi proxy returns { event } / { market }; the Polymarket proxy returns an array of events.
      if (data && data.event) return extractTopOutcomes("kalshi", data)
      return extractTopOutcomes("polymarket", data)
    }
    if (platform === "polymarket") {
      const event = Array.isArray(data) ? data[0] : data
      if (!event) return { title: "", topOutcomes: [], stats: [] }
      const allMarkets = event.markets || []
      // Mirror the adapter's moneyline filter for sports events
      const isSportsEvent = allMarkets.some(m => m.sportsMarketType)
      const mlOnly = isSportsEvent ? allMarkets.filter(m => m.sportsMarketType === "moneyline") : []
      const markets = isSportsEvent ? (mlOnly.length ? mlOnly : allMarkets.slice(0, 1)) : allMarkets
      const all = []
      markets.forEach(market => {
        let outcomes, prices
        try {
          outcomes = typeof market.outcomes === "string" ? JSON.parse(market.outcomes) : market.outcomes
          prices   = typeof market.outcomePrices === "string" ? JSON.parse(market.outcomePrices) : market.outcomePrices
        } catch (e) { return }
        if (!Array.isArray(outcomes) || !Array.isArray(prices)) return
        // A grouped (categorical) event splits each candidate into its own
        // Yes/No market and names it in groupItemTitle — the same shape
        // lib/cross-platform.js reads. Taking the inline outcomes instead
        // produced a list of "Yes"/"No" rows carrying the long-shots' NO
        // prices: no candidate names, and the complements of the real
        // probabilities sorted to the top.
        if (markets.length > 1 && market.groupItemTitle) {
          const yesIdx = outcomes.findIndex(o => String(o).toLowerCase().trim() === "yes")
          const idx = yesIdx >= 0 ? yesIdx : 0
          if (idx < prices.length) {
            all.push({ name: market.groupItemTitle, pct: Math.round(parseFloat(prices[idx] || 0) * 100) })
          }
          return
        }
        outcomes.forEach((name, i) => {
          if (i < prices.length) all.push({ name, pct: Math.round(parseFloat(prices[i] || 0) * 100) })
        })
      })
      all.sort((a, b) => b.pct - a.pct)
      const spreads = markets.map(m => {
        const ask = parseFloat(m.bestAsk || 0)
        const bid = parseFloat(m.bestBid || 0)
        return ask > 0 && bid > 0 ? ask - bid : null
      }).filter(s => s !== null && s > 0)
      const minSpread = spreads.length ? Math.min(...spreads) : null
      const pmIsBinary = all.length === 2
      return {
        title: event.title || "",
        isBinary: pmIsBinary,
        topOutcomes: all.slice(0, 3).map((o, i) => ({ ...o, color: OUTCOME_COLORS[i], rank: i })),
        stats: [
          { label: "Volume",        value: fmtCompareNum(parseFloat(event.volume || 0)) },
          { label: "24h Volume",    value: fmtCompareNum(parseFloat(event.volume24hr || 0)) },
          { label: "Open Interest", value: fmtCompareNum(parseFloat(event.openInterest || 0)) },
          { label: "Liquidity",     value: fmtCompareNum(parseFloat(event.liquidity || 0)) },
          { label: "Best Spread",   value: minSpread != null ? Math.round(minSpread * 100) + "¢" : "—" },
        ],
      }
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
      const gemIsBinary = extracted.length === 2
      return {
        title: data.title,
        isBinary: gemIsBinary,
        topOutcomes: extracted.slice(0, 3).map((o, i) => ({ ...o, rank: i })),
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
  // A bare Gemini ticker or instrument symbol becomes a URL. This used to
  // uppercase the input and stop there, so the instrument symbol a reader
  // copies off their own position (GEMI-{event}-{contract}) was sent to the API
  // verbatim and came back 404 — on a market that was open and trading.
  if (!expandedUrl.startsWith("http")) expandedUrl = geminiUrlFromTicker(expandedUrl) || expandedUrl
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
        let part = expandedUrl.split("/event/")[1]
        if (!part) {
          // Support /sports/, /esports/, and other path-based URLs — use last path segment as slug
          const cleanPath = expandedUrl.split("?")[0].split("#")[0].replace(/\/$/, "")
          const lastSegment = cleanPath.split("/").pop()
          if (lastSegment && lastSegment !== "polymarket.com") part = lastSegment
        }
        if (!part) return { error: "Invalid Polymarket URL", platform, accent }
        slug = part.split("?")[0].split("#")[0].replace(/\/$/, "").split("/")[0]
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
          // A Response always carries a numeric status, so the old
          // `kr.status !== undefined` guard returned on every failure and the
          // documented fall-through below was dead: a Polymarket-backed
          // coinbase.com event with a mixed-case slug answered "Kalshi API 404"
          // instead of being retried against Polymarket. Only a 404 — "this is
          // not a Kalshi event" — falls through; anything else is reported.
          if (!kr.ok && kr.status !== 404) {
            const e = await kr.json().catch(() => ({}))
            return { error: e.error || `Kalshi API ${kr.status}`, platform, accent }
          }
          // Fall through to Polymarket: not a Kalshi-backed event.
        }
      }
      const pmVenue = /polymarket\.us/i.test(expandedUrl) ? "us" : "com"
      const res = await fetch(`/api/polymarket?slug=${encodeURIComponent(slug)}&venue=${pmVenue}`)
      if (!res.ok) {
        // The upstream's own message says what actually went wrong — a slug
        // that does not exist reads as "Polymarket API 502" without it.
        const e = await res.json().catch(() => ({}))
        return { error: e.error || `Polymarket API ${res.status}`, platform, accent }
      }
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

// ── Outcome matching key ──────────────────────────────────────────────────────
// Outcomes are matched across venues by name. They used to be re-keyed by price
// RANK for binary markets (top-priced → __LEAD__), which inverted the match
// whenever the two venues disagreed about which side was the favourite: a
// market at Yes 80 on one venue and Yes 45 on another had its "Yes" keyed
// __LEAD__ on one side and __TRAIL__ on the other, so the comparison lined a
// YES up against a NO. The rank key only ever applied to outcomes already
// literally named "yes"/"no", where the name matches correctly on its own.
function _normKey(o) {
  return String(o.name == null ? "" : o.name).toLowerCase().trim()
}

// Feature 4: detect when two platforms disagree by 15+ points on same outcome
function _detectDivergence(results) {
  const valid = results.filter(r => r && !r.error && r.meta && (r.meta.topOutcomes || []).length)
  if (valid.length < 2) return null
  for (let i = 0; i < valid.length - 1; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      const aOutcomes = valid[i].meta.topOutcomes || []
      const bOutcomes = valid[j].meta.topOutcomes || []
      for (const ao of aOutcomes) {
        const aKey = _normKey(ao)
        const bo = bOutcomes.find(o => _normKey(o) === aKey)
        if (!bo) continue
        const diff = Math.abs(ao.pct - bo.pct)
        if (diff >= 15) {
          const pA = (PLATFORMS[valid[i].platform] || {}).label || valid[i].platform.toUpperCase()
          const pB = (PLATFORMS[valid[j].platform] || {}).label || valid[j].platform.toUpperCase()
          return { name: ao.name, diff, pA, pctA: ao.pct, pB, pctB: bo.pct }
        }
      }
    }
  }
  return null
}

// Feature 5: build outcome name → best-platform map
function _buildBestOddsMap(results) {
  const valid = results.filter(r => r && !r.error && r.meta)
  const normKeys = new Set()
  valid.forEach(r => (r.meta.topOutcomes || []).forEach(o => normKeys.add(_normKey(o))))
  const map = {}
  normKeys.forEach(key => {
    let best = { pct: -1, platform: null }
    valid.forEach(r => {
      const o = (r.meta.topOutcomes || []).find(o => _normKey(o) === key)
      if (o && o.pct > best.pct) best = { pct: o.pct, platform: r.platform }
    })
    if (best.platform) map[key] = best.platform
  })
  return map
}

// ── Cross-venue price gap ─────────────────────────────────────────────────────
// Reports how far apart two venues price the SAME outcome.
//
// This deliberately no longer claims an arbitrage. The only NO price available
// in this view is the complement of a YES midpoint, not a quoted ask, and the
// old test reduced to an identity:
//
//   min(yesA, yesB) + min(100-yesA, 100-yesB)  ===  100 - |yesA - yesB|
//
// so "total cost under $1" was true whenever the two venues differed by a
// single cent, and the card reported a guaranteed profit on essentially every
// comparison. Executing a real cross-venue arb needs each venue's actual ask
// plus its fees, which this view does not fetch — so it states the gap and
// leaves the trading decision to the reader.
function _computePriceGap(results) {
  const valid = results.filter(r => r && !r.error && r.meta?.topOutcomes?.length >= 1)
  if (valid.length < 2) return null
  let widest = null
  for (let i = 0; i < valid.length - 1; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      const aTop = valid[i].meta.topOutcomes[0]
      const bTop = valid[j].meta.topOutcomes[0]
      if (!aTop || !bTop) continue
      // Same outcome on both sides only: a YES price held up against a NO
      // price is not a disagreement about anything.
      if (_normKey(aTop) !== _normKey(bTop)) continue
      const gap = Math.abs(aTop.pct - bTop.pct)
      if (gap < 1) continue
      const pA = (PLATFORMS[valid[i].platform] || {}).label || valid[i].platform.toUpperCase()
      const pB = (PLATFORMS[valid[j].platform] || {}).label || valid[j].platform.toUpperCase()
      const aIsLower = aTop.pct <= bTop.pct
      if (!widest || gap > widest.gap) {
        widest = {
          gap,
          name: aTop.name,
          lowPlatform:  aIsLower ? pA : pB,
          lowPct:       Math.min(aTop.pct, bTop.pct),
          highPlatform: aIsLower ? pB : pA,
          highPct:      Math.max(aTop.pct, bTop.pct),
        }
      }
    }
  }
  return widest
}

function renderComparison(results) {
  // Feature 4: divergence callout
  const divergence = _detectDivergence(results)
  const divergenceHtml = divergence ? `
    <div class="divergence-callout">
      <span class="divergence-icon">⚠</span>
      <div class="divergence-body">
        <strong>${esc(divergence.pA)} and ${esc(divergence.pB)} disagree by ${divergence.diff} points on &ldquo;${esc(divergence.name)}&rdquo;</strong>
        — ${esc(divergence.pA)}: ${divergence.pctA}% · ${esc(divergence.pB)}: ${divergence.pctB}%.
        A gap this wide is often a difference in how the two contracts resolve, not a mispricing — compare the rules before reading anything into it.
      </div>
    </div>` : ""

  // Cross-venue price gap. States the difference; makes no profit claim — see
  // _computePriceGap for why the old "guaranteed profit" figure was unsound.
  const gap = _computePriceGap(results)
  const gapHtml = gap ? `
    <div class="mi-card arb-card">
      <div class="section-label arb-label">CROSS-VENUE PRICE GAP</div>
      <div class="arb-body">
        <strong>${esc(gap.name)}</strong> is priced ${gap.gap} point${gap.gap === 1 ? "" : "s"} apart —
        <strong>${esc(gap.lowPlatform)}</strong> ${gap.lowPct}% · <strong>${esc(gap.highPlatform)}</strong> ${gap.highPct}%
      </div>
      <div class="arb-disclaimer">⚠ A gap is not a profit. These are last or mid prices, not the asks you would actually pay, and the two venues may settle on different rules, dates and fees. Predara does not know whether this is tradeable.</div>
    </div>` : ""

  // Feature 5: best odds per outcome (using normalized keys)
  const bestOddsMap = _buildBestOddsMap(results)

  const cols = results.map((r, i) => {
    if (!r || r.error) {
      return `<div class="compare-col">
        <div class="compare-col-title">Market ${i + 1}</div>
        <div class="compare-col-empty">⚠ ${esc(r ? r.error : "Failed to load")}</div>
      </div>`
    }
    const { meta, accent, platform } = r
    const platformLabel = (PLATFORMS[platform] || {}).label || platform.toUpperCase()
    const outcomesHtml = (meta.topOutcomes || []).map(o => {
      const key = _normKey(o)
      const isBest = bestOddsMap[key] === platform
      const bestBadge = isBest ? ` <span class="best-odds-badge">BEST</span>` : ""
      return `<div class="compare-outcome">
        <span class="compare-outcome-name" style="color:${o.color};${isBest ? "font-weight:700" : ""}">${esc(o.name)}${bestBadge}</span>
        <span class="compare-outcome-pct" style="color:${o.color};${isBest ? "font-weight:900" : ""}">${o.pct}%</span>
      </div>`
    }).join("") || `<div class="compare-col-empty">No outcome data</div>`
    const statsHtml = (meta.stats || []).filter(Boolean).length
      ? `<div class="compare-stats">${(meta.stats).filter(Boolean).map(s =>
          `<div class="compare-stat-row">
            <span class="compare-stat-label">${tip(s.label, s.label.toUpperCase())}</span>
            <span class="compare-stat-value">${esc(s.value)}</span>
          </div>`
        ).join("")}</div>`
      : ""
    const footnote = PLATFORM_FOOTNOTES[platform] || ""
    return `<div class="compare-col">
      <span class="tag-platform" style="background:${accent};font-size:9px;padding:3px 8px;border-radius:3px">${esc(platformLabel)}</span>
      <div class="compare-col-title">${esc(meta.title || "")}</div>
      ${outcomesHtml}
      ${statsHtml}
      ${footnote ? `<div class="platform-footnote">${esc(footnote)}</div>` : ""}
    </div>`
  }).join("")

  // Feature 9: swipe hint shown on mobile
  const swipeHint = results.length > 1
    ? `<div class="compare-swipe-hint">← swipe to see all platforms →</div>` : ""

  return `${divergenceHtml}${gapHtml}<div class="mi-card" style="margin-bottom:${divergence || gap ? "0" : "24px"}">
    <div class="section-label">COMPARING ${results.length} MARKETS</div>
    <div class="compare-cols">${cols}</div>
    ${swipeHint}
  </div>
  <div class="compare-details-label" style="margin-top:${divergence || gap ? "16px" : "0"}">FULL ANALYSES</div>`
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
  const shareControlsEl = document.getElementById("shareControls")
  if (shareControlsEl) shareControlsEl.style.display = "none"
  result.innerHTML = `<div class="mi-loading"><span class="mi-spinner"></span>COMPARING ${urls.length} MARKETS</div>`

  const results = await Promise.all(urls.map(fetchOneMarket))

  const detailsHtml = results.map((r, i) => {
    if (!r || r.error) return `<div class="mi-error"><div class="error-content"><span>Market ${i + 1}: ${esc(r ? r.error : "Failed to load")}</span></div></div>`
    return r.html
  }).join('<hr class="compare-separator">')

  result.innerHTML = renderComparison(results) + detailsHtml

  // Share link encodes all URLs joined by newline
  const compareUrl = urls.join("\n")
  addShareBar(compareUrl)
  // Update freshness and bookmark state for compare mode
  if (typeof _updateFreshnessDisplay === "function") {
    window._lastFetchedAt = Date.now()
    _updateFreshnessDisplay()
  }
  if (typeof _refreshBookmarkBtn === "function") _refreshBookmarkBtn(compareUrl)

  if (btn) { btn.disabled = false; btn.textContent = "COMPARE ↗" }
}

function addShareBar(marketUrl) {
  const encoded = encodeURIComponent(marketUrl)
  history.pushState({ q: marketUrl }, "", `${location.pathname}?q=${encoded}`)
  const shareControlsEl = document.getElementById("shareControls")
  if (shareControlsEl) shareControlsEl.style.display = "flex"
  const copyBtn = document.getElementById("copyLinkBtn")
  if (copyBtn) copyBtn.textContent = "Copy link ↗"

  // Keep compare collapsed unless the user opens it explicitly.
}

// ── End comparison helpers ────────────────────────────────────────────────────
