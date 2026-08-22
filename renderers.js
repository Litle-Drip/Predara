// ── Unified market renderer ────────────────────────────────────────────────────
// Consumes a NormalizedMarket object (from adapters.js) and returns HTML.
// All three platforms (Kalshi, Gemini, Polymarket/Coinbase) share this renderer.

function renderMarket(norm, accent) {
  if (!norm) return `<div class="mi-error">No market data available.</div>`

  // Exposed so history/bookmarks can record when the market actually closes
  // (the Calendar tab groups tracked markets by their close date).
  if (typeof window !== "undefined") window._lastCloseIso = norm.closeIso || ""

  // Gemini streams its public order book per contract instrumentSymbol; the
  // feed is opened by initGeminiLive() after this HTML is in the DOM.
  if (typeof window !== "undefined") window._geminiLive = norm.geminiLive || null

  // Identifiers the PRICE HISTORY chart uses to pull the platform's own time
  // series. Null on venues that publish none -- the chart then says so rather
  // than drawing the reader's own page-view snapshots as if they were data.
  if (typeof window !== "undefined") window._historyRef = norm.historyRef || null

  const staleHtml   = staleWarningHtml(norm.staleIso)
  const timeLeft    = fmtTimeRemaining(norm.closeIso)

  // `rank` lets the renderer highlight only the leading outcome instead of
  // giving every row its own color.
  const allRows = norm.outcomes.map((o, i) =>
    outcomeRow(o.label, o.sub || "", o.pct, o.color, o.delta ?? null, {
      bid: o.bid, ask: o.ask, isEstimate: o.isEstimate, vol: o.vol, oi: o.oi, rank: i,
    })
  )
  const outcomesHtml = buildOutcomesHtml(allRows)

  window._simMarket = { amount: window._simMarket?.amount || 10, pct: norm.leadPct, platform: norm.platform, side: window._simMarket?.side || "yes" }
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

  const statsHtml = norm.stats.filter(Boolean).map(s => statCard(s.label, s.value || "—", s.sub || "")).join("")

  // Key facts strip in the header: the market's own headline numbers, so the top
  // of the page answers "who's winning, when does it close, is anyone trading it".
  const leader  = norm.outcomes[0]
  const volStat = norm.stats.find(s => s && s.label === "VOLUME TRADED" && s.value && s.value !== "—")
  const headMeta = [
    leader ? {
      label: norm.outcomes.length > 2 ? "Front-runner" : "Market price",
      value: `<span class="event-meta-dot" style="background:${esc(leader.color)}"></span>
              <span class="event-meta-name">${esc(leader.label)}</span>
              <strong>${leader.pct}%</strong>`,
    } : null,
    timeLeft ? {
      label: timeLeft.text === "CLOSED" ? "Status" : "Closes",
      value: `<span class="urgency-text-${timeLeft.urgency}">${esc(
        timeLeft.text === "CLOSED" ? "Trading closed" : timeLeft.text.replace(/^CLOSES IN /, "in ")
      )}</span>`,
    } : null,
    volStat ? { label: "Volume traded", value: esc(volStat.value) } : null,
  ].filter(Boolean)
  const headMetaHtml = headMeta.length
    ? `<div class="event-meta">${headMeta.map(m => `
        <div class="event-meta-item">
          <span class="event-meta-label">${esc(m.label)}</span>
          <span class="event-meta-value">${m.value}</span>
        </div>`).join("")}</div>`
    : ""

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
  const tradeCtaHtmlStr   = tradeCtaHtml(norm.sourceUrl, norm.platform, !!norm.resolvedInfo)

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
        ${headMetaHtml}
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

    ${hasRules || norm.rawRulesText ? `
    <div class="mi-card">
      <div class="section-label">HOW IT RESOLVES</div>
      ${resConfidenceHtml}
      ${hasRules
        ? `<div class="num-list">${resolutionChecklist(norm.ruleSentences, norm.outcomes)}</div>`
        : `<div class="resolution-fallback">See the market source for resolution details.${norm.sourceUrl ? ` <a href="${esc(norm.sourceUrl)}" target="_blank" rel="noopener" style="color:var(--orange)">View original market ↗</a>` : ""}</div>`
      }
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

    ${norm.geminiLive && typeof geminiLiveCardHtml === "function" ? geminiLiveCardHtml(norm.geminiLive) : ""}

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

    ${tradeCtaHtmlStr}

    ${norm.rewardsHtml || ""}

    ${findSimilarHtml}
  `
}

// ── Backwards-compatible wrappers ─────────────────────────────────────────────
// These preserve the existing call signatures used by analyze() and fetchOneMarket().

function renderKalshiEvent(ev, accent, platformKey = "kalshi", inputUrl = "") {
  const markets = (ev.markets || []).filter(m => m.yes_sub_title)
  if (!markets.length) return `<div class="mi-error">No outcome data available for this market.</div>`
  return renderMarket(normalizeKalshi(ev, platformKey, inputUrl), accent)
}

function renderGeminiEvent(event, accent, inputUrl = "") {
  const norm = normalizeGemini(event, inputUrl)
  if (!norm) return `<div class="mi-error">No outcome data found for this event.</div>`
  return renderMarket(norm, accent)
}

function renderPolymarketEvent(event, markets, accent, platformKey = "polymarket", inputUrl = "") {
  const norm = normalizePolymarket(event, markets, platformKey, inputUrl)
  if (!norm) return `<div class="mi-error">No outcome data found for this market.</div>`
  return renderMarket(norm, accent)
}
