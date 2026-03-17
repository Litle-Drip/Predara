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
  const betSimHtml = betSimulatorHtml(norm.leadPct)

  const analyticsRows = norm.analyticsSource.slice(0, 3)
    .map(c => calcAnalyticsRow(c.label, c.prob, c.ask, c.bid, c.color))
    .filter(Boolean)
  const analyticsHtml = analyticsCard(analyticsRows, timeLeft)

  const statsHtml = norm.stats.map(s => statCard(s.label, s.value || "—", s.sub || "")).join("")

  const platformLabel = (PLATFORMS[norm.platform] || {}).label || norm.platform.toUpperCase()
  const hasRules = norm.ruleSentences.length > 0
  const hasTimeline = norm.hasTimeline || !!norm.resSourceHtml

  return `
    <div class="mi-card">
      <div class="event-head">
        <div class="event-tags">
          <span class="tag-platform" style="background:${accent}">${esc(platformLabel)}</span>
          ${norm.tagsHtml}
          ${norm.exclusiveTag}
          <span class="tag-status"><span class="${norm.statusDot}">●</span> ${esc(norm.statusText)}</span>
        </div>
        ${norm.resolvedBanner}
        <div class="event-title">${esc(norm.title)}${norm.subtitle ? " — " + esc(norm.subtitle) : ""}</div>
        ${urgencyHtml}
        ${staleHtml}
      </div>
    </div>

    ${whatsTheBetCard(norm.betExplainerText)}

    ${hasRules ? `
    <div class="mi-card">
      <div class="section-label">HOW IT RESOLVES</div>
      <div class="num-list">${numList(norm.ruleSentences)}</div>
    </div>` : ""}

    ${hasTimeline ? `
    <div class="mi-card">
      <div class="section-label">TIMELINE</div>
      ${norm.timelineRows}
      ${norm.resSourceHtml}
    </div>` : ""}

    <div class="mi-card">
      <div class="section-label">OUTCOMES &amp; PROBABILITY</div>
      ${outcomesHtml}
    </div>

    <div class="stats-grid">
      ${statsHtml}
    </div>

    ${betSimHtml}

    ${analyticsHtml}
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
