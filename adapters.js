// ── API Adapters ───────────────────────────────────────────────────────────────
// Each normalize*() function converts raw platform API data into a canonical
// NormalizedMarket object consumed by renderMarket() in renderers.js.
//
// NormalizedMarket shape:
// {
//   platform:      string,
//   title:         string,
//   subtitle:      string,   // rendered as "title — subtitle" when non-empty
//   statusDot:     "dot-green"|"dot-red"|"dot-muted",
//   statusText:    string,
//   resolvedBanner: string,  // pre-rendered HTML or ""
//   exclusiveTag:  string,   // pre-rendered HTML or ""
//   tagsHtml:      string,   // pre-rendered HTML for category/tag spans
//   staleIso:      string,   // passed to staleWarningHtml()
//   closeIso:      string,   // passed to fmtTimeRemaining()
//   timelineRows:  string,   // pre-rendered HTML for timeline section body
//   hasTimeline:   boolean,
//   outcomes:      NormalizedOutcome[],
//   stats:         { label, value?, sub? }[],  // exactly 4 items
//   analyticsSource: { label, prob, ask, bid }[],
//   leadPct:       number,
//   betExplainerText: string,
//   ruleSentences: string[],
//   resSourceHtml: string,   // pre-rendered HTML or ""
// }
//
// NormalizedOutcome shape:
// { label, sub, pct, color, delta, bid?, ask?, isEstimate?, vol?, oi? }

// ── Gemini price extraction ────────────────────────────────────────────────────
// Consolidates all known field variants into a single function.
// Previously duplicated twice in renderGeminiEvent with 13+ fallback levels.
// Prefers live bid/ask midpoint over potentially stale lastTradePrice, so the
// displayed probability tracks the current market rather than an old trade.
function geminiExtractPrice(c) {
  const cp = c.prices || {}
  // Current live bid/ask midpoint is the most accurate market probability
  const bid = parseFloat(cp.bestBid || cp.bid || c.bestBid || c.bid || 0) || 0
  const ask = parseFloat(cp.bestAsk || cp.ask || c.bestAsk || c.ask || 0) || 0
  if (bid > 0 && ask > 0) return (bid + ask) / 2
  // Fall back to theoretical fair-value fields, then stale last-trade price
  return parseFloat(
    cp.mark || cp.mid ||
    cp.lastTradePrice || cp.last || cp.close ||
    c.lastPrice || c.currentPrice || c.lastSalePrice ||
    c.midpoint || c.mid || c.mark || c.price ||
    c.bestAsk || c.ask || c.probability ||
    ask || bid || 0
  )
}

// ── Gemini contract name extraction ───────────────────────────────────────────
// Extracts a human-readable name from symbol/slug strings like
// "NCAAM-2603151930-PUR-MICH-M-MICH" → "Mich"
// "GEMI-TPC2026WIN-ABERG" → "Aberg"
// Previously duplicated twice in renderGeminiEvent.
function geminiExtractName(c, fallback) {
  const rawName = [c.label, c.title, c.name, c.instrumentSymbol, c.ticker]
    .find(v => typeof v === "string" && v.trim()) || fallback
  if (!rawName.includes("-")) return rawName
  const parts = rawName.split("-")
  // Filter out pure-numeric and single-char segments (e.g. trailing "M" in sports tickers)
  const meaningful = parts.filter(p => p.length > 1 && !/^\d+$/.test(p))
  const lastPart = meaningful[meaningful.length - 1] || parts[parts.length - 1]
  return lastPart ? lastPart.charAt(0).toUpperCase() + lastPart.slice(1) : rawName
}

// Keep resolution source link labels concise and readable.
// Some provider payloads include entire terms text as `name`, which can flood the UI.
function sourceLabel(source, fallback = "Resolution source") {
  const url = typeof source === "string" ? source : source?.url || ""
  const rawName = typeof source === "object" && typeof source.name === "string"
    ? source.name.trim()
    : ""
  const cleanName = rawName.replace(/\s+/g, " ").trim()
  const looksVerbose = cleanName.length > 90 || /terms|conditions|agreement|disclaimer/i.test(cleanName)
  if (cleanName && !looksVerbose) return cleanName
  try {
    const u = new URL(url)
    return u.hostname.replace(/^www\./, "")
  } catch {
    return fallback
  }
}

// ── normalizeKalshi ────────────────────────────────────────────────────────────
function normalizeKalshi(ev, platformKey = "kalshi") {
  const markets    = (ev.markets || []).filter(m => m.yes_sub_title)
  const allMarkets = (ev._allMarkets || ev.markets || []).filter(m => m.yes_sub_title)
  if (!markets.length) return null

  const first = markets[0] || {}
  const sorted = [...markets].sort((a, b) =>
    parseFloat(b.last_price_dollars || 0) - parseFloat(a.last_price_dollars || 0))

  const status     = first.status || "active"
  const statusDot  = status === "active" ? "dot-green" : status === "closed" ? "dot-red" : "dot-muted"
  const statusText = status.toUpperCase()
  const category   = ev.product_metadata?.competition || ev.category || "Markets"
  const catColor   = categoryColor(category)
  const eventTitle = (ev.title || ev.event_ticker || "").replace(/[?!.]+$/, "").trim()
  const eventSubTitle = ev.sub_title || ""

  // Resolution banner
  const isFinished = status === "finalized" || status === "closed"
  const resolvedMarket = sorted.find(m => m.result === "yes") ||
    (isFinished ? sorted.find(m => m.result === "no") : null)
  const resolution  = resolvedMarket?.result || ""
  const expValue    = resolvedMarket?.expiration_value || first.expiration_value || ""
  const resolvedBanner = ""

  const isMultiOutcome = markets.length > 2

  // Stale data — most recent last_trade_time across all markets
  const lastTradeIso = allMarkets.reduce((latest, m) => {
    const t = m.last_trade_time || ""
    return t > latest ? t : latest
  }, "")

  // Outcomes
  const outcomes = sorted.map((m, i) => {
    const lastPrice = parseFloat(m.last_price_dollars || 0)
    const yesBid    = parseFloat(m.yes_bid_dollars || 0)
    const yesAsk    = parseFloat(m.yes_ask_dollars || 0)
    const isEstimate = lastPrice <= 0
    const pct = lastPrice > 0
      ? Math.round(lastPrice * 100)
      : yesAsk > 0 ? Math.round((yesBid + yesAsk) / 2 * 100) : Math.round(yesBid * 100)

    const prevDollars = parseFloat(m.previous_price_dollars || (m.previous_price != null ? m.previous_price / 100 : 0))
    const prevPct = prevDollars > 0 ? Math.round(prevDollars * 100) : null
    const delta = prevPct !== null ? pct - prevPct : null

    const label = isMultiOutcome ? m.yes_sub_title : `${m.yes_sub_title} to win`
    const sub = isMultiOutcome ? "" : (m.rules_primary || "")
      .replace(/^If /, "").replace(/, then the market resolves to Yes\.?$/, "")

    const out = {
      label, sub, pct,
      color: OUTCOME_COLORS[i % OUTCOME_COLORS.length],
      delta, bid: yesBid, ask: yesAsk, isEstimate,
    }
    if (isMultiOutcome) {
      const mVol = parseFloat(m.volume_fp || 0) / 100
      const mOI  = parseFloat(m.open_interest_fp || 0) / 100
      if (mVol > 0) out.vol = Math.round(mVol).toLocaleString()
      if (mOI > 0)  out.oi  = Math.round(mOI).toLocaleString()
    }
    return out
  })

  // For true binary markets (single Kalshi market), add the complementary NO side
  if (markets.length === 1 && outcomes.length === 1) {
    const yesOut = outcomes[0]
    const m0 = sorted[0]
    const yesAsk = parseFloat(m0.yes_ask_dollars || 0)
    const yesBid = parseFloat(m0.yes_bid_dollars || 0)
    const noBid  = yesAsk > 0 ? Math.max(0, 1 - yesAsk) : 0
    const noAsk  = yesBid > 0 ? Math.min(1, 1 - yesBid) : 0
    outcomes.push({
      label: "NO",
      sub: "",
      pct: 100 - yesOut.pct,
      color: OUTCOME_COLORS[1],
      delta: yesOut.delta !== null ? -yesOut.delta : null,
      bid: noBid,
      ask: noAsk,
      isEstimate: yesOut.isEstimate,
    })
  }

  // Stats — always use allMarkets (full event) for accurate totals
  const totalVol = fmtNum(ev.volume_fp != null
    ? parseEventFP(ev.volume_fp)
    : allMarkets.reduce((s, m) => s + parseFloat(m.volume_fp || 0), 0) / 100)
  const totalVol24 = fmtNum(ev.volume_24h_fp != null
    ? parseEventFP(ev.volume_24h_fp)
    : allMarkets.reduce((s, m) => {
        if (m.volume_24h_fp) return s + parseFloat(m.volume_24h_fp) / 100
        return s + parseFloat(m.volume_24h || 0)
      }, 0))
  // Kalshi liquidity: try all known field variants across API versions
  const totalLiq = fmtNum(allMarkets.reduce((s, m) => {
    if (m.liquidity_dollars  != null) return s + parseFloat(m.liquidity_dollars)
    if (m.liquidity_fp       != null) return s + parseFloat(m.liquidity_fp) / 100
    if (m.liquidity          != null) return s + parseFloat(m.liquidity) / 100
    if (m.liquidity_yes_fp   != null) return s + (parseFloat(m.liquidity_yes_fp) + parseFloat(m.liquidity_no_fp || 0)) / 100
    if (m.liquidity_yes      != null) return s + parseFloat(m.liquidity_yes) + parseFloat(m.liquidity_no || 0)
    return s
  }, 0))
  const totalOI = fmtNum(allMarkets.reduce((s, m) => s + parseFloat(m.open_interest_fp || 0), 0) / 100)

  // Timeline — event-level open_time, fall back to earliest market open_time
  const eventOpenTime = ev.open_time ||
    allMarkets.reduce((earliest, m) => {
      if (!m.open_time) return earliest
      return !earliest || m.open_time < earliest ? m.open_time : earliest
    }, null)
  const canCloseEarly = first.can_close_early
  const earlyCloseText = first.early_close_condition || (canCloseEarly ? "Possible" : "")
  const timelineRows = [
    infoRow("Trading opens",       fmtDate(eventOpenTime)),
    infoRow("Betting closes",      fmtDateTime(first.close_time)),
    infoRow("Expected resolution", fmtDateTime(first.expected_expiration_time)),
    earlyCloseText
      ? `<div class="info-row"><span class="info-key">${esc("Early close")}</span><span class="info-val">${esc(earlyCloseText)}</span></div>`
      : "",
  ].join("")
  const hasTimeline = !!(eventOpenTime || first.close_time || first.expected_expiration_time)

  // Analytics source
  const analyticsSource = (isMultiOutcome ? sorted.slice(0, 3) : markets.length === 2 ? sorted.slice(0, 2) : sorted.slice(0, 1)).map((m, i) => {
    const lp  = parseFloat(m.last_price_dollars || 0)
    const bid = parseFloat(m.yes_bid_dollars || 0)
    let ask   = parseFloat(m.yes_ask_dollars || 0)
    const prob = lp > 0 ? lp : (ask > 0 ? (bid + ask) / 2 : bid)
    if (!Number.isFinite(ask) || ask <= 0) {
      ask = Number.isFinite(bid) && bid > 0 ? (bid + prob) / 2 : prob
    }
    return { label: m.yes_sub_title || "YES", prob, ask, bid, color: OUTCOME_COLORS[i % OUTCOME_COLORS.length] }
  })

  const leadPct = (() => {
    if (!sorted[0]) return 0
    const lp = parseFloat(sorted[0].last_price_dollars || 0)
    const yb = parseFloat(sorted[0].yes_bid_dollars || 0)
    const ya = parseFloat(sorted[0].yes_ask_dollars || 0)
    return lp > 0 ? Math.round(lp * 100) : ya > 0 ? Math.round((yb + ya) / 2 * 100) : Math.round(yb * 100)
  })()

  // Bet explainer
  let betExplainerText = ""
  if (!isMultiOutcome && markets.length === 2) {
    const labelA = sorted[0]?.yes_sub_title || "one outcome"
    const labelB = sorted[1]?.yes_sub_title || "the other outcome"
    betExplainerText = `Pick a side: bet YES on ${labelA} if you think they win, or YES on ${labelB} if you think they win. Each contract pays $1 — only one side can resolve YES.`
  } else if (!isMultiOutcome && first.rules_primary) {
    betExplainerText = first.rules_primary
      .split(/[.!?]\s/)[0]
      .replace(/^If /i, "You win if ")
      .replace(/,\s*then the market resolves to Yes$/i, "")
      .replace(/,\s*then you win$/i, "")
      .trim()
    if (betExplainerText && !betExplainerText.endsWith(".")) betExplainerText += "."
    const noText = first.rules_primary.match(/otherwise[^.]*resolves? to "?No"?/i)
    betExplainerText += noText ? " Otherwise, you lose your bet." : " You lose if it doesn't happen."
  } else if (isMultiOutcome) {
    const eventName = (ev.title || ev.event_ticker || "this event").replace(/[?!.]+$/, "").trim()
    const sampleOutcome = (sorted[0]?.yes_sub_title || "").replace(/[.!?]+$/, "")
    betExplainerText = sampleOutcome
      ? `Bet on which outcome will happen for ${eventName} — for example, "${sampleOutcome}." You win if your chosen outcome is correct.${ev.mutually_exclusive ? " Only one outcome can win — winner takes all." : ""}`
      : `Bet on which outcome will happen for ${eventName}. You win if your chosen outcome is correct.${ev.mutually_exclusive ? " Only one outcome can win — winner takes all." : ""}`
  }

  // Resolution sources — prefer structured settlement_sources, fall back to URLs in rules text
  const rawSources = first.settlement_sources || ev.settlement_sources || []
  const validSources = rawSources.filter(s => {
    const url = typeof s === "string" ? s : s?.url
    try { const u = new URL(url); return u.protocol === "http:" || u.protocol === "https:" } catch { return false }
  })
  if (!validSources.length) {
    const rulesText = [first.rules_primary, first.rules_secondary].filter(Boolean).join(" ")
    const seen = new Set()
    ;(rulesText.match(/https?:\/\/[^\s\),"'<>]+/g) || []).forEach(url => {
      if (seen.has(url)) return
      seen.add(url)
      try { const u = new URL(url); if (u.protocol === "http:" || u.protocol === "https:") validSources.push(url) } catch {}
    })
  }
  if (!validSources.length) {
    const contractUrl = ev._contract_url
      || first.contract_url
      || (ev.markets || []).find(m => m.contract_url)?.contract_url
    if (contractUrl) validSources.push({ url: contractUrl, name: "View full rules (PDF)" })
  }
  const resSourceHtml = validSources.length
    ? `<div class="info-row" style="border-bottom:none"><span class="info-key">Resolution source${validSources.length > 1 ? "s" : ""}</span><span class="info-val">${
        validSources.map(s => {
          const url  = typeof s === "string" ? s : s.url
          const name = sourceLabel(s)
          return `<a href="${esc(url)}" target="_blank" rel="noopener" style="color:var(--orange)">${esc(name)}</a>`
        }).join(" · ")
      }</span></div>`
    : ""

  // Rules
  const rulesRaw = first.rules_secondary || first.rules_primary || ""
  const ruleSentences = plainEnglishRules(rulesRaw)

  // Tags
  const tagsHtml = `<span class="tag-cat" style="color:${catColor};border-color:${catColor};background:${catColor}1a">${esc(category.toUpperCase())}</span>`
  const exclusiveTag = ev.mutually_exclusive
    ? `<span class="tag-exclusive">WINNER TAKES ALL</span>` : ""

  const resolvedInfo = (isFinished && resolution) ? {
    winner: resolvedMarket
      ? (isMultiOutcome
          ? resolvedMarket.yes_sub_title
          : (resolution === "yes" ? (resolvedMarket.yes_sub_title || "YES") : "NO"))
      : null,
    resolution,
    resolvedAt: first.close_time || "",
    value: expValue || null,
    totalVol: totalVol || null,
    isMultiOutcome,
  } : null

  return {
    platform: platformKey,
    title: eventTitle || eventSubTitle,
    subtitle: eventTitle && eventSubTitle ? eventSubTitle : "",
    statusDot, statusText,
    resolvedBanner, resolvedInfo, exclusiveTag, tagsHtml,
    staleIso: lastTradeIso,
    closeIso: first.close_time || "",
    timelineRows, hasTimeline,
    outcomes,
    stats: [
      { label: "VOLUME TRADED", value: totalVol ? `$${totalVol}` : "—" },
      { label: "24H VOLUME",    value: totalVol24 ? `$${totalVol24}` : "—" },
      { label: "LIQUIDITY",     value: totalLiq ? `$${totalLiq}` : "—" },
      { label: "OPEN INTEREST", value: totalOI ? `$${totalOI}` : "—" },
    ],
    analyticsSource,
    leadPct,
    betExplainerText,
    ruleSentences,
    resSourceHtml,
  }
}

// ── normalizeGemini ────────────────────────────────────────────────────────────
function normalizeGemini(event) {
  const status = (event.status || "").toLowerCase()
  const isOpen = status === "active" || status === "approved" || status === "open"
  const statusDot  = isOpen ? "dot-green" : "dot-red"
  const statusText = isOpen ? "OPEN" : status.toUpperCase() || "CLOSED"

  const contracts = Array.isArray(event.contracts) ? event.contracts : []
  const isBinary  = event.type === "binary"

  const outcomes = []
  const analyticsSource = []

  if (isBinary && contracts.length === 1) {
    const c = contracts[0]
    const price = geminiExtractPrice(c)
    const cp    = c.prices || {}
    const bid   = parseFloat(cp.bestBid || cp.bid || c.bestBid || c.bid || price)
    const ask   = parseFloat(cp.bestAsk || cp.ask || c.bestAsk || c.ask || price)
    // If the market is settled and resolutionSide is explicit, use it to override
    // price-derived percentages (which go to 0 after settlement, making NO look like winner).
    const resSide = (c.resolutionSide || "").toLowerCase()
    const pctYes = resSide === "yes" ? 100 : resSide === "no" ? 0 : Math.round(price * 100)
    const pctNo  = 100 - pctYes
    const extras = Number.isFinite(bid) && Number.isFinite(ask) && ask > 0 ? { bid, ask } : {}
    // Carry _resolutionSide so geminiWinner can use the explicit field (cleaned up below).
    outcomes.push({ label: "YES", sub: "", pct: pctYes, _resolutionSide: resSide === "yes" ? "yes" : (resSide === "no" ? "no" : null), color: OUTCOME_COLORS[0], delta: null, ...extras })
    outcomes.push({ label: "NO",  sub: "", pct: pctNo,  _resolutionSide: resSide === "no" ? "yes" : (resSide === "yes" ? "no" : null), color: OUTCOME_COLORS[1], delta: null })
    if (ask > 0) analyticsSource.push({ label: "YES", prob: price, ask, bid: bid || price, color: OUTCOME_COLORS[0] })
  } else {
    const sortedContracts = [...contracts].sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999))
    sortedContracts.forEach((c, idx) => {
      const name  = geminiExtractName(c, `Outcome ${idx + 1}`)
      const price = geminiExtractPrice(c)
      const cp    = c.prices || {}
      const bid   = parseFloat(cp.bestBid || cp.bid || c.bestBid || c.bid || price)
      const ask   = parseFloat(cp.bestAsk || cp.ask || c.bestAsk || c.ask || price)
      const out   = { label: name, sub: "", pct: 0, _rawPrice: price, _resolutionSide: (c.resolutionSide || "").toLowerCase() || null, color: OUTCOME_COLORS[idx % OUTCOME_COLORS.length], delta: null }
      if (Number.isFinite(bid) && Number.isFinite(ask) && ask > 0) { out.bid = bid; out.ask = ask }
      if (c.volume || c.notionalVolume) out.vol = fmtNum(parseFloat(c.volume || c.notionalVolume))
      if (c.openInterest) out.oi = fmtNum(parseFloat(c.openInterest))
      outcomes.push(out)
      if (price > 0 && ask > 0) analyticsSource.push({ label: String(name), prob: price, ask, bid: bid || price, color: out.color })
    })
    // Normalize raw prices to sum to exactly 100%, eliminating over-round from bid/ask spread.
    const rawSum = outcomes.reduce((s, o) => s + (o._rawPrice || 0), 0)
    outcomes.forEach(o => {
      o.pct = rawSum > 0 ? Math.round((o._rawPrice || 0) / rawSum * 100) : 0
      delete o._rawPrice
    })
    // Remove internal flag after normalization (before geminiWinner reads it below)
    // _resolutionSide is read by geminiWinner and then deleted before returning outcomes.
  }

  if (!outcomes.length) return null

  // Stats
  const contractLiq = contracts.reduce((s, c) => s + parseFloat(c.liquidity || c.notionalLiquidity || 0), 0)
  const totalVol   = fmtNum(parseFloat(event.volume || event.notionalVolume || 0))
  const totalVol24 = fmtNum(parseFloat(event.volume24h || event.volume24Hr || 0))
  const totalLiq   = fmtNum(parseFloat(event.liquidity || event.notionalLiquidity || contractLiq || 0))
  const totalOI    = fmtNum(parseFloat(event.openInterest || event.notionalOpenInterest || 0))
  const contractNames = contracts.map((c, i) => geminiExtractName(c, `Outcome ${i + 1}`)).filter(Boolean)

  // Tags
  let tags = Array.isArray(event.tags) ? event.tags : []
  const cat = event.category || ""
  if (cat && !tags.includes(cat)) tags = [cat, ...tags]
  const tagsHtml = tags
    .filter(t => t != null)
    .map(t => {
      const col = categoryColor(String(t))
      return `<span class="tag-cat" style="color:${col};border-color:${col};background:${col}1a">${esc(String(t).toUpperCase())}</span>`
    }).join("")

  // Timing
  const contractCloseDate = contracts.length > 0
    ? (contracts[0].closeDate || contracts[0].expiryDate || contracts[0].endDate || "")
    : ""
  const expiryIso = event.closeDate || event.expiryDate || event.endDate || contractCloseDate || event.resolvedAt || ""
  const startIso  = event.openDate || event.startDate || event.startTime || event.effectiveDate || event.createdAt || ""

  // Timeline
  const timelineRows = [
    infoRow("Start date", fmtDate(startIso)),
    infoRow("End date", fmtDate(expiryIso)),
    event.resolvedAt ? infoRow("Resolved", fmtDateTime(event.resolvedAt)) : "",
  ].join("")
  const hasTimeline = !!(startIso || expiryIso)

  // Analytics
  analyticsSource.sort((a, b) => b.prob - a.prob)
  const leadPct = analyticsSource.length ? Math.round(analyticsSource[0].prob * 100) : 0

  // Bet explainer
  const desc = event.description || ""
  const eventTitle = (event.title || "").trim()
  let betExplainerText = ""
  if (desc && desc.trim() !== eventTitle) {
    const candidate = applyResolveText(desc)
      .split(/(?<=[.!?])\s+/)
      .filter(s => s.trim().length > 10)
      .slice(0, 3)
      .join(" ")
    // Only use if it contains substantive information beyond the title
    if (candidate && candidate.trim() !== eventTitle) betExplainerText = candidate
  }

  // Rules — only use description if it contains actual resolution criteria,
  // not just the market title echoed back.
  const descRules = desc ? plainEnglishRules(desc).slice(0, 8) : []
  const looksLikeRules = descRules.some(s =>
    /\b(resolv|YES|NO|win|payout|\$1|contract|expir|settl)/i.test(s)
  )
  const ruleSentences = looksLikeRules ? descRules : []
  const isHeadToHead = !isBinary && contracts.length === 2
  if (ruleSentences.length === 0) {
    if (isBinary) {
      const title = event.title || "this event"
      ruleSentences.push(
        `YES or NO market: will ${title} happen?`,
        `If it does, the YES contract resolves to $1 — you collect $1 per contract held`,
        `If it does not, the YES contract expires at $0 and NO pays out instead`,
        `Only one side wins — hold the right contract to collect $1`
      )
      if (!betExplainerText) {
        betExplainerText = `Bet YES if you think it happens, NO if you think it doesn't. Winning contract pays $1.`
      }
    } else if (isHeadToHead && contractNames.length === 2) {
      const [a, b] = contractNames
      ruleSentences.push(
        `Pick which side wins: ${a} or ${b}`,
        `If ${a} wins, the "${a}" contract resolves YES and pays $1`,
        `If ${b} wins, the "${b}" contract resolves YES and pays $1`,
        `The losing side's contract resolves NO and expires worthless`
      )
      if (!betExplainerText) {
        betExplainerText = `Bet on the winner: ${a} or ${b}. Each contract pays $1 if your side wins. Only one side can win — the other expires at $0.`
      }
    } else if (!isBinary && contracts.length > 2 && contractNames.length > 0) {
      const listed = contractNames.slice(0, 3).join(", ")
      const more = contractNames.length > 3 ? `, and ${contractNames.length - 3} more` : ""
      ruleSentences.push(
        `Pick one outcome from ${contracts.length} options: ${listed}${more}`,
        `The contract matching the actual result resolves YES and pays $1`,
        `All other contracts resolve NO and expire worthless`,
        `Only one outcome can win`
      )
      if (!betExplainerText) {
        betExplainerText = `Pick the winning outcome from ${contracts.length} choices. The correct contract pays $1; all others expire at $0.`
      }
    }
  }
  if (ruleSentences.length > 0 && expiryIso) {
    ruleSentences.push(`Trading closes ${fmtDate(expiryIso)}`)
  }

  // Resolution sources — Gemini wraps Kalshi data so check both field shapes
  const geminiRawSources = event.settlement_sources || event.settlementSources || []
  const geminiSingleUrl  = event.resolutionSource || event.resolution_source ||
    (contracts[0] && (contracts[0].resolutionSource || contracts[0].resolution_source)) || ""
  const geminiSources = Array.isArray(geminiRawSources) && geminiRawSources.length
    ? geminiRawSources
    : geminiSingleUrl ? [geminiSingleUrl] : []
  let geminiValidSources = geminiSources.filter(s => {
    const url = typeof s === "string" ? s : s?.url
    try { const u = new URL(url); return u.protocol === "http:" || u.protocol === "https:" } catch { return false }
  })
  const directTermsUrl = event.termsLink
    || (contracts[0] && contracts[0].termsAndConditionsUrl)
    || event._contract_url
    || null
  if (!geminiValidSources.length && directTermsUrl) {
    geminiValidSources = [{ url: directTermsUrl, name: "Read full contract terms & conditions" }]
  }
  const resSourceHtml = geminiValidSources.length
    ? `<div class="info-row" style="border-bottom:none"><span class="info-key">Resolution source${geminiValidSources.length > 1 ? "s" : ""}</span><span class="info-val">${
        geminiValidSources.map(s => {
          const url  = typeof s === "string" ? s : s.url
          const name = sourceLabel(s)
          return `<a href="${esc(url)}" target="_blank" rel="noopener" style="color:var(--orange)">${esc(name)}</a>`
        }).join(" · ")
      }</span></div>`
    : ""

  // Prefer the contract's explicit resolutionSide field ("yes" = winner).
  // This is populated by Gemini on settlement even when prices have gone to 0.
  // Fall back to price-percentage comparison for live/open markets.
  const geminiWinner = !isOpen && outcomes.length > 0
    ? (outcomes.find(o => o._resolutionSide === "yes") ||
       outcomes.find(o => o.pct === 100) ||
       outcomes.reduce((a, b) => a.pct > b.pct ? a : b))
    : null
  // Clean up the internal flag so it doesn't reach the UI renderer.
  outcomes.forEach(o => { delete o._resolutionSide })
  const resolvedInfo = (!isOpen && geminiWinner) ? {
    winner: geminiWinner.label,
    resolution: isBinary ? (geminiWinner.label === "YES" ? "yes" : "no") : "",
    resolvedAt: event.resolvedAt || expiryIso || "",
    value: null,
    totalVol: totalVol || null,
    isMultiOutcome: !isBinary && contracts.length > 2,
  } : null

  return {
    platform: "gemini",
    title: event.title || "Gemini Prediction Market",
    subtitle: "",
    statusDot, statusText,
    resolvedBanner: "", resolvedInfo, exclusiveTag: (!isBinary && contracts.length >= 2) ? `<span class="tag-exclusive">WINNER TAKES ALL</span>` : "", tagsHtml,
    staleIso: event.updatedAt || event.lastUpdated || "",
    closeIso: expiryIso,
    timelineRows, hasTimeline,
    outcomes,
    stats: [
      { label: "VOLUME TRADED", value: totalVol ? `$${totalVol}` : null },
      { label: "24H VOLUME",    value: totalVol24 ? `$${totalVol24}` : null },
      { label: "LIQUIDITY",     value: totalLiq ? `$${totalLiq}` : null },
      { label: "OPEN INTEREST", value: totalOI ? `$${totalOI}` : null },
      {
        label: "RUNNERS",
        value: contracts.length > 0 ? String(contracts.length) : null,
        sub: contractNames.length > 0
          ? contractNames.slice(0, 5).join(" · ") + (contractNames.length > 5 ? " ···" : "")
          : "",
      },
    ],
    analyticsSource,
    leadPct,
    betExplainerText,
    ruleSentences,
    resSourceHtml,
  }
}

// ── normalizePolymarket ────────────────────────────────────────────────────────
function normalizePolymarket(event, markets, platformKey = "polymarket") {
  const outcomes = []
  const analyticsSource = []
  const categoricalEntries = []
  let colorIdx = 0
  let hasCategorical = false

  markets.forEach(market => {
    let outs, prices
    try {
      outs   = typeof market.outcomes === "string" ? JSON.parse(market.outcomes) : market.outcomes
      prices = typeof market.outcomePrices === "string" ? JSON.parse(market.outcomePrices) : market.outcomePrices
    } catch (e) { return }
    if (!Array.isArray(outs) || !Array.isArray(prices)) return

    const rawAsk = parseFloat(market.bestAsk)
    const rawBid = parseFloat(market.bestBid)
    const bestAsk = Number.isFinite(rawAsk) && rawAsk > 0 ? rawAsk : null
    const bestBid = Number.isFinite(rawBid) && rawBid > 0 ? rawBid : null

    // Categorical market: each market in the event represents one named outcome
    // (e.g. a candidate). groupItemTitle holds the outcome name; outcomes are
    // always ["Yes","No"] so we only use the Yes (i=0) price as the probability.
    const groupLabel = market.groupItemTitle || ""
    const isCategorical = groupLabel && outs.length === 2 &&
      outs[0] && outs[0].toLowerCase() === "yes" &&
      outs[1] && outs[1].toLowerCase() === "no"

    if (isCategorical) {
      hasCategorical = true
      const prob = parseFloat(prices[0])
      const vol = parseFloat(market.volume || 0)
      categoricalEntries.push({
        label: groupLabel,
        prob: Number.isFinite(prob) ? prob : 0,
        vol: Number.isFinite(vol) ? vol : 0,
        bestAsk, bestBid,
      })
      return
    }

    outs.forEach((name, i) => {
      if (i >= prices.length) return
      const pct = Math.round(parseFloat(prices[i] || 0) * 100)
      const out = {
        label: name, sub: "", pct,
        color: OUTCOME_COLORS[colorIdx % OUTCOME_COLORS.length],
        delta: null,
      }
      colorIdx++
      // bestBid/bestAsk refer to the YES token (i=0).
      // For binary (2-outcome) markets invert for the NO side; for 3+ outcomes
      // the formula is meaningless so leave bid/ask unset (falls back to prob).
      if (bestBid != null && bestAsk != null) {
        if (i === 0) { out.bid = bestBid; out.ask = bestAsk }
        else if (outs.length === 2) { out.bid = Math.max(0, 1 - bestAsk); out.ask = Math.min(1, 1 - bestBid) }
      }
      outcomes.push(out)
      const prob = parseFloat(prices[i])
      if (!Number.isFinite(prob) || prob <= 0) return
      analyticsSource.push({
        prob,
        label: name ? String(name) : market.question || "YES",
        ask: out.ask != null ? out.ask : prob,
        bid: out.bid != null ? out.bid : prob,
        color: out.color,
      })
    })
  })

  // For categorical markets: sort by odds desc, then volume desc; show top 10
  if (hasCategorical) {
    categoricalEntries.sort((a, b) => b.prob - a.prob || b.vol - a.vol)
    const top10 = categoricalEntries.slice(0, 10)
    top10.forEach(entry => {
      const pct = Math.round(entry.prob * 100)
      const volStr = entry.vol > 0 ? `$${fmtNum(entry.vol)} traded` : ""
      const out = {
        label: entry.label, sub: volStr, pct,
        color: OUTCOME_COLORS[colorIdx % OUTCOME_COLORS.length],
        delta: null,
        bid: entry.bestBid != null ? entry.bestBid : undefined,
        ask: entry.bestAsk != null ? entry.bestAsk : undefined,
      }
      colorIdx++
      outcomes.push(out)
      if (entry.prob > 0) {
        analyticsSource.push({
          prob: entry.prob,
          label: entry.label,
          ask: out.ask != null ? out.ask : entry.prob,
          bid: out.bid != null ? out.bid : entry.prob,
          color: out.color,
        })
      }
    })
  }

  if (!outcomes.length) return null

  const first = markets[0] || {}
  const totalVol    = fmtNum(parseFloat(event.volume || 0))
  const totalLiq    = fmtNum(parseFloat(event.liquidity || first.liquidity || 0))
  const totalVol24  = fmtNum(parseFloat(event.volume24hr || first.volume24hr || 0))
  const commentCount = parseInt(event.commentCount || 0, 10)

  // Tags
  let tags = event.tags || []
  if (typeof tags === "string") { try { tags = JSON.parse(tags) } catch(e) { tags = [] } }
  if (!Array.isArray(tags)) tags = []
  const tagsHtml = tags
    .filter(t => t != null)
    .map(t => {
      const label = t.label || t.slug || String(t)
      const col = categoryColor(label)
      return `<span class="tag-cat" style="color:${col};border-color:${col};background:${col}1a">${esc(label.toUpperCase())}</span>`
    }).join("")

  analyticsSource.sort((a, b) => b.prob - a.prob)
  const leadPct = analyticsSource.length ? Math.round(analyticsSource[0].prob * 100) : 0

  // Bet explainer
  let betExplainerText = ""
  const firstDesc = first.description || first.question || event.description || ""
  if (firstDesc) {
    betExplainerText = applyResolveText(firstDesc)
      .split(/(?<=[.!?])\s+/)
      .filter(s => s.trim().length > 10)
      .slice(0, 3)
      .join(" ")
  }
  if (!betExplainerText && markets.length > 1) {
    betExplainerText = `Pick which outcome you think will happen. You win if your chosen outcome is correct.`
  }
  if (!betExplainerText && event.title) {
    betExplainerText = `This market is about: ${event.title}. Check the outcomes below to see the options and their current odds.`
  }

  // Rules
  const ruleSentences = []
  const seenTexts = new Set()
  const seenSentences = new Set()
  markets.forEach(m => {
    ;[m.description || "", m.question || ""].forEach(text => {
      if (!text || seenTexts.has(text)) return
      seenTexts.add(text)
      plainEnglishRules(text).forEach(s => {
        if (!seenSentences.has(s)) { seenSentences.add(s); ruleSentences.push(s) }
      })
    })
  })
  const limitedRules = ruleSentences.slice(0, 8)

  // Resolution source
  let resSource = ""
  for (const m of markets) {
    if (m.resolutionSource && typeof m.resolutionSource === "string") {
      try {
        const u = new URL(m.resolutionSource)
        if (u.protocol === "http:" || u.protocol === "https:") { resSource = m.resolutionSource; break }
      } catch(e) {}
    }
  }
  let resSourceLabel = ""
  if (resSource) {
    try {
      const u = new URL(resSource)
      resSourceLabel = u.hostname.replace(/^www\./, "")
    } catch { resSourceLabel = resSource.replace(/^https?:\/\//, "").split("/")[0] }
  }
  const resSourceHtml = resSource
    ? `<div class="info-row" style="border-bottom:none"><span class="info-key">Resolution source</span><span class="info-val"><a href="${esc(resSource)}" target="_blank" rel="noopener" style="color:var(--orange)">${esc(resSourceLabel)}</a></span></div>`
    : ""

  // Timeline
  const timelineRows = [
    infoRow("Start date", fmtDate(event.startDate)),
    infoRow("End date", fmtDate(event.endDate)),
    infoRow("Expected resolution", fmtDate(event.closedTime || event.endDate)),
  ].join("")
  const hasTimeline = !!event.endDate

  const statusDot  = event.closed ? "dot-red" : "dot-green"
  const statusText = event.closed ? "CLOSED" : "OPEN"

  const polyWinner = event.closed && outcomes.length > 0
    ? (outcomes.find(o => o.pct === 100) || outcomes.reduce((a, b) => a.pct > b.pct ? a : b))
    : null
  const resolvedInfo = (event.closed && polyWinner) ? {
    winner: polyWinner.label,
    resolution: outcomes.length === 2 ? (polyWinner.label === "No" ? "no" : "yes") : "",
    resolvedAt: event.closedTime || event.endDate || "",
    value: null,
    totalVol: totalVol || null,
    isMultiOutcome: outcomes.length > 2,
  } : null

  return {
    platform: platformKey,
    title: event.title || "",
    subtitle: "",
    statusDot, statusText,
    resolvedBanner: "", resolvedInfo, exclusiveTag: "", tagsHtml,
    staleIso: event.updatedAt || first.lastTradeTime || first.updatedAt || "",
    closeIso: event.endDate || "",
    timelineRows, hasTimeline,
    outcomes,
    stats: [
      { label: "VOLUME TRADED", value: totalVol ? `$${totalVol}` : "—" },
      { label: "24H VOLUME",    value: totalVol24 ? `$${totalVol24}` : "—" },
      { label: "LIQUIDITY",     value: totalLiq ? `$${totalLiq}` : "—" },
      { label: "COMMENTS",      value: commentCount > 0 ? commentCount.toLocaleString() : "—" },
    ],
    analyticsSource,
    leadPct,
    betExplainerText,
    ruleSentences: limitedRules,
    resSourceHtml,
  }
}
