// ── Unified market renderer ────────────────────────────────────────────────────
// Consumes a NormalizedMarket object (from adapters.js) and returns HTML.
// All three platforms (Kalshi, Gemini, Polymarket/Coinbase) share this renderer.

function renderMarket(norm, accent) {
  if (!norm) return `<div class="mi-error">No market data available.</div>`

  const staleHtml   = staleWarningHtml(norm.staleIso)
  const timeLeft    = fmtTimeRemaining(norm.closeIso)
  const urgencyHtml = timeLeft
    ? `<div class="urgency-banner urgency-${timeLeft.urgency}">⏱ ${esc(timeLeft.text)}</div>`
    : ""

  const allRows = norm.outcomes.map(o =>
    outcomeRow(o.label, o.sub || "", o.pct, o.color, o.delta ?? null, {
      bid: o.bid, ask: o.ask, isEstimate: o.isEstimate, vol: o.vol, oi: o.oi,
    })
  )
  const outcomesHtml = buildOutcomesHtml(allRows)

  window._simMarket = { amount: window._simMarket?.amount || 10, pct: norm.leadPct, platform: norm.platform }
  const betSimHtml = betSimulatorHtml(norm.outcomes)

  // Feature 2: volume distribution bar
  const volDistHtml = volumeDistBar(norm.outcomes)

  // Feature 3: compute overround (sum of all outcome %) — key quality signal
  const overroundVal = norm.outcomes.length > 1
    ? Math.round(norm.outcomes.reduce((s, o) => s + o.pct, 0))
    : null

  const analyticsRows = norm.analyticsSource.slice(0, 3)
    .map(c => calcAnalyticsRow(c.label, c.prob, c.ask, c.bid, c.color))
    .filter(Boolean)
  const analyticsHtml = analyticsCard(analyticsRows, timeLeft, overroundVal)

  const statsHtml = norm.stats.map(s => statCard(s.label, s.value || "—", s.sub || "")).join("")

  const platformLabel = (PLATFORMS[norm.platform] || {}).label || norm.platform.toUpperCase()
  const hasRules = norm.ruleSentences.length > 0
  const hasTimeline = norm.hasTimeline

  // New features: rule alerts, volume spike, news hint, resolved insights
  const ruleAlertsHtml   = ruleAlertsCard(norm.rawRulesText || "")
  const volSpikeHtml     = volumeSpikeHtml(norm.stats, norm.outcomes)
  const newsMoveHtml     = norm.resolvedInfo ? "" : newsMoveHint(norm.outcomes, norm.title)
  const resolvedInsights = resolvedInsightsCard(norm.resolvedInfo, norm.stats, norm.outcomes)

  // Round 3 features
  const volConsensusHtml  = volumeWeightedConsensusCard(norm.outcomes)
  const edgeCalcHtml      = edgeCalculatorHtml(norm.outcomes)
  const findSimilarHtml   = norm.resolvedInfo ? findSimilarMarketsCard(norm.platform, norm.title) : ""
  const resConfidenceHtml = resolutionConfidenceHtml(norm.rawRulesText || "")

  return `
    <div class="mi-card">
      <div class="event-head">
        <div class="event-tags">
          <span class="tag-platform" style="background:${accent}">${esc(platformLabel)}</span>
          ${norm.tagsHtml}
          ${norm.exclusiveTag}
          <span class="tag-status"><span class="${norm.statusDot}">●</span> ${esc(norm.statusText)}</span>
        </div>
        <div class="event-title">${esc(norm.title)}${norm.subtitle ? " — " + esc(norm.subtitle) : ""}</div>
        ${urgencyHtml}
        ${staleHtml}
      </div>
    </div>

    ${resolvedBoxHtml(norm.resolvedInfo)}

    ${resolvedInsights}

    ${norm.notification ? `
    <div class="mi-card market-notice">
      <div class="market-notice-icon">⚠</div>
      <div class="market-notice-text">${esc(norm.notification)}</div>
    </div>` : ""}

    ${whatsTheBetCard(norm.betExplainerText)}

    ${hasRules ? `
    <div class="mi-card">
      <div class="section-label">HOW IT RESOLVES</div>
      ${resConfidenceHtml}
      <div class="num-list">${resolutionChecklist(norm.ruleSentences)}</div>
    </div>` : ""}

    ${ruleAlertsHtml}

    ${hasTimeline ? `
    <div class="mi-card">
      <div class="section-label">TIMELINE</div>
      ${norm.timelineRows}
    </div>` : ""}

    ${norm.resSourceHtml ? `
    <div class="mi-card">
      <div class="section-label">RESOLUTION SOURCES</div>
      ${norm.resSourceHtml}
    </div>` : ""}

    <div class="mi-card">
      <div class="section-label">CURRENT ODDS</div>
      ${outcomesHtml}
    </div>

    ${volDistHtml}

    ${volConsensusHtml}

    ${volSpikeHtml}

    ${newsMoveHtml}

    <div class="stats-grid">
      ${statsHtml}
    </div>

    ${betSimHtml}

    ${edgeCalcHtml}

    ${analyticsHtml}

    ${findSimilarHtml}
  `
}

// ── Backwards-compatible wrappers ─────────────────────────────────────────────
// These preserve the existing call signatures used by analyze() and fetchOneMarket().

function renderKalshiEvent(ev, accent, platformKey = "kalshi") {
  const markets = (ev.markets || []).filter(m => m.yes_sub_title)
  if (!markets.length) return `<div class="mi-error">No outcome data available for this market.</div>`
  return renderMarket(normalizeKalshi(ev, platformKey), accent)
}

function renderGeminiEvent(event, accent) {
  const norm = normalizeGemini(event)
  if (!norm) return `<div class="mi-error">No outcome data found for this event.</div>`
  return renderMarket(norm, accent)
}

function renderPolymarketEvent(event, markets, accent, platformKey = "polymarket") {
  const norm = normalizePolymarket(event, markets, platformKey)
  if (!norm) return `<div class="mi-error">No outcome data found for this market.</div>`
  return renderMarket(norm, accent)
}
