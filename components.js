// ── Rule flag patterns ─────────────────────────────────────────────────────────
const RULE_FLAG_PATTERNS = [
  { re: /(?:can|may|will)\s+close\s+early|early\s+(?:close|resolution|resolv)|resolves?\s+early/i,
    label: "EARLY RESOLUTION", desc: "This market may resolve before its scheduled close date." },
  { re: /mathematically impossible|cannot\s+(?:be\s+)?(?:reached?|achieved?|attained?|exceeded?)|no longer possible/i,
    label: "THRESHOLD TRIGGER", desc: "The market can auto-resolve once an outcome becomes mathematically locked in." },
  { re: /emergency\s+(?:session|meeting|vote|order|declaration|measure)|extraordinary\s+(?:session|measure|circumstance)|special\s+session/i,
    label: "EMERGENCY CLAUSE", desc: "Emergency or extraordinary governmental events could affect how this market resolves." },
  { re: /force\s+majeure/i,
    label: "FORCE MAJEURE", desc: "Force majeure events may void or alter resolution." },
  { re: /(?:at\s+the?\s+)?sole\s+discretion|at\s+the?\s+discretion\s+of|platform['s\s]+judgment|determined\s+(?:solely\s+)?by\s+(?:the\s+)?(?:exchange|platform|admin|operator|kalshi|polymarket|gemini)/i,
    label: "DISCRETIONARY", desc: "Resolution may involve subjective platform judgment, not just a clear objective trigger." },
  { re: /\bvoid\b|\bcancell?ed?\b|\bpostponed?\b|\babandoned?\b|\bcalled\s+off\b/i,
    label: "CANCELLATION RISK", desc: "This market may be voided, cancelled, or postponed under certain conditions." },
  { re: /resolves?\s+(?:to\s+)?(?:N\.?A\.?|no[- ]?action|N\.?O\.?)|50[\s-\/]50\s*(?:split)?|50\s*\/\s*50|refunded?/i,
    label: "PARTIAL REFUND", desc: "Market may resolve to N/A or a 50-50 split (partial refund) rather than a clear winner." },
  { re: /includes?\s+(?:any\s+)?(?:overtime|extra\s+time|extra\s+innings|shootout|penalty\s+kicks?|\bOT\b|playoffs?)/i,
    label: "OVERTIME INCLUDED", desc: "The result includes overtime or extra periods — not just regulation time." },
  { re: /regardless\s+of|irrespective\s+of|notwithstanding/i,
    label: "OVERRIDE CLAUSE", desc: "A clause that may override what seems like the obvious real-world result." },
  { re: /as\s+of\s+(?:the\s+)?(?:market\s+)?close|at\s+(?:the\s+)?(?:time\s+of\s+)?(?:close|resolution|settlement|expir)|price\s+at\s+(?:market\s+)?close/i,
    label: "TIMING SENSITIVE", desc: "Resolution is tied to data at a precise moment — small timing differences can flip the outcome." },
]

// Feature: Rule highlights / edge case detector
function ruleAlertsCard(rawRulesText) {
  if (!rawRulesText || typeof rawRulesText !== "string" || rawRulesText.length < 30) return ""
  const sentences = rawRulesText
    .replace(/\n{2,}/g, ". ")
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 25)
  const flagged = []
  const seen = new Set()
  for (const sentence of sentences) {
    for (const flag of RULE_FLAG_PATTERNS) {
      if (!seen.has(flag.label) && flag.re.test(sentence)) {
        seen.add(flag.label)
        const q = sentence.length > 220 ? sentence.slice(0, 220) + "…" : sentence
        flagged.push({ label: flag.label, desc: flag.desc, quote: q })
        break
      }
    }
  }
  if (!flagged.length) return ""
  const items = flagged.map(f => `
    <div class="rule-flag-item">
      <div class="rule-flag-header">
        <span class="rule-flag-icon">⚠</span>
        <span class="rule-flag-label">${esc(f.label)}</span>
      </div>
      <div class="rule-flag-desc">${esc(f.desc)}</div>
      <div class="rule-flag-quote">&ldquo;${esc(f.quote)}&rdquo;</div>
    </div>`).join("")
  return `
    <div class="mi-card rule-alerts-card">
      <div class="section-label rule-alerts-label">⚠ RULE ALERTS</div>
      ${items}
    </div>`
}

// Helper: parse "$1,234,567" or "—" stat values to a raw number
function _parseStatVol(stats, labelKey) {
  const s = (stats || []).find(s => s.label === labelKey)
  if (!s || !s.value || s.value === "—") return 0
  return parseInt(String(s.value).replace(/[$,]/g, ""), 10) || 0
}

// Feature: Volume spike alert — fires when 24h vol is ≥25% of lifetime vol
function volumeSpikeHtml(stats, outcomes) {
  const totalVol = _parseStatVol(stats, "VOLUME TRADED")
  const vol24h   = _parseStatVol(stats, "24H VOLUME")
  if (!vol24h || !totalVol || totalVol < 5000) return ""
  const ratio = vol24h / totalVol
  if (ratio < 0.25) return ""
  const pctOfTotal = Math.round(ratio * 100)
  const mover = [...outcomes]
    .filter(o => o.delta != null)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0]
  const moverNote = mover && Math.abs(mover.delta) >= 2
    ? ` &ldquo;${esc(mover.label)}&rdquo; is the biggest mover (${mover.delta > 0 ? "+" : ""}${mover.delta} pts).`
    : ""
  return `
    <div class="mi-card volume-spike-card">
      <div class="volume-spike-header">
        <span class="volume-spike-icon">⚡</span>
        <span class="volume-spike-title">UNUSUAL VOLUME</span>
      </div>
      <div class="volume-spike-body">
        <strong>${pctOfTotal}%</strong> of this market's lifetime volume traded in the last 24 hours.${moverNote}
        Something may have changed — check recent news for a catalyst.
      </div>
    </div>`
}

// Feature: News correlation hint — fires when any outcome has moved ≥5 points
function newsMoveHint(outcomes, title) {
  const movers = [...outcomes]
    .filter(o => o.delta != null && Math.abs(o.delta) >= 5)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
  if (!movers.length) return ""
  const top = movers[0]
  const dir = top.delta > 0 ? "up" : "down"
  const pts = Math.abs(top.delta)
  const q = encodeURIComponent((title ? title + " " : "") + top.label)
  const newsUrl = "https://news.google.com/search?q=" + q
  return `
    <div class="mi-card news-hint-card">
      <div class="news-hint-header">
        <span class="news-hint-icon">📰</span>
        <span class="news-hint-title">PRICE MOVEMENT DETECTED</span>
      </div>
      <div class="news-hint-body">
        &ldquo;${esc(top.label)}&rdquo; moved ${dir} ${pts} pts since the last trade.
        Check for a catalyst:
        <a href="${newsUrl}" target="_blank" rel="noopener" class="news-hint-link">Search news ↗</a>
      </div>
    </div>`
}

// Feature: Resolved market insights — upset, sharpness score, money breakdown, odds journey
function resolvedInsightsCard(resolvedInfo, stats, outcomes) {
  if (!resolvedInfo) return ""
  const winners = resolvedInfo.winners || (resolvedInfo.winner ? [resolvedInfo.winner] : [])
  if (!winners.length) return ""

  const totalVol     = _parseStatVol(stats, "VOLUME TRADED")
  const closeOdds    = resolvedInfo.winnerCloseOdds ?? null
  const prevOdds     = resolvedInfo.winnerPrevOdds  ?? null
  const wasUpset     = resolvedInfo.wasUpset || false
  const winnerVolRank = resolvedInfo.winnerVolRank ?? null

  // Sharpness label — based on winner's closing odds (Kalshi only)
  let sharpnessHtml = ""
  if (closeOdds != null) {
    let label, cls, sub
    if      (closeOdds >= 80) { label = "CALLED IT";    cls = "val-green"; sub = "market was very confident" }
    else if (closeOdds >= 60) { label = "LEANED RIGHT"; cls = "val-green"; sub = "market slightly favored winner" }
    else if (closeOdds >= 45) { label = "PHOTO FINISH"; cls = "val-amber"; sub = "market was nearly 50/50" }
    else if (closeOdds >= 25) { label = "SURPRISED";    cls = "val-red";   sub = "market didn't expect this" }
    else                      { label = "SHOCKED";      cls = "val-red";   sub = "major upset — market was wrong" }
    sharpnessHtml = `
      <div class="ri-row">
        <span class="ri-label">MARKET ACCURACY</span>
        <span class="ri-val ${cls}">${label} <span class="ri-sub">· ${sub} (winner at ${closeOdds}% at close)</span></span>
      </div>`
  }

  // Odds journey (Kalshi only: prev_price → close)
  let oddsJourneyHtml = ""
  if (prevOdds != null && closeOdds != null && prevOdds !== closeOdds) {
    const arrow = closeOdds > prevOdds ? "↑" : "↓"
    oddsJourneyHtml = `
      <div class="ri-row">
        <span class="ri-label">ODDS AT CLOSE</span>
        <span class="ri-val">Before final trade: ${prevOdds}% ${arrow} Final: ${closeOdds}%</span>
      </div>`
  }

  // Money transferred estimate (when we have close odds + total vol)
  let moneyHtml = ""
  if (totalVol > 0 && closeOdds != null && closeOdds > 0 && closeOdds < 100) {
    const transfer = Math.round(totalVol * (100 - closeOdds) / 100)
    const fmt = n => "$" + n.toLocaleString()
    moneyHtml = `
      <div class="ri-row">
        <span class="ri-label">MONEY TRANSFERRED (EST.)</span>
        <span class="ri-val val-green">~${fmt(transfer)}</span>
      </div>
      <div class="ri-row" style="margin-top:-2px">
        <span class="ri-label" style="font-size:10px;opacity:.6">zero-sum: winners gain what losers paid</span>
        <span class="ri-val"></span>
      </div>`
  } else if (totalVol > 0) {
    const fmt = n => "$" + n.toLocaleString()
    moneyHtml = `
      <div class="ri-row">
        <span class="ri-label">TOTAL TRADED</span>
        <span class="ri-val">${fmt(totalVol)} moved through this market</span>
      </div>`
  }

  // Upset banner — fires for Kalshi (closeOdds<50) or Polymarket categorical (volRank>1)
  const upsetLabel = closeOdds != null
    ? `${esc(winners[0])} was priced at only ${closeOdds}% at close`
    : winnerVolRank != null && winnerVolRank > 1
      ? `${esc(winners[0])} was the #${winnerVolRank}-backed outcome by volume`
      : ""
  const upsetBanner = wasUpset && upsetLabel ? `
    <div class="upset-banner">
      <span class="upset-icon">🔥</span>
      <div class="upset-body">
        <strong>UNDERDOG WINS</strong> — ${upsetLabel}. The market got this one wrong.
      </div>
    </div>` : ""

  if (!sharpnessHtml && !oddsJourneyHtml && !moneyHtml && !upsetBanner) return ""

  return `
    <div class="mi-card resolved-insights-card">
      <div class="section-label">MARKET INSIGHTS</div>
      ${upsetBanner}
      ${sharpnessHtml}
      ${oddsJourneyHtml}
      ${moneyHtml}
    </div>`
}

// ── Resolution confidence score ────────────────────────────────────────────────
function _resolutionConfidenceScore(rawRulesText) {
  if (!rawRulesText || typeof rawRulesText !== "string" || rawRulesText.length < 30) return null
  let score = 60
  const text = rawRulesText.toLowerCase()
  // Modal verbs must be followed by a verb-like word so we don't penalise
  // "May 2024" or "Friday, May 3" as discretionary language.
  const MODAL_RE = /\b(?:may|might|could)\s+(?:be|not|have|include|involve|affect|result|require|occur|apply|vary|differ|exclude|change|depend|need|cause|happen|be\w*)\b/
  if (MODAL_RE.test(text)) score -= 7
  for (const w of ["discretion", "sole judgment", "sole discretion",
      "approximately", "reasonable", "substantially", "at its ", "as determined", "in its opinion"]) {
    if (text.includes(w)) score -= 7
  }
  if (/https?:\/\//.test(rawRulesText)) score += 12
  if (/\b(official|federal|government|national)\s+(data|source|report|website|statistic)/i.test(rawRulesText)) score += 8
  if (/\b\d{4}-\d{2}-\d{2}\b|\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s+\d{4}/i.test(rawRulesText)) score += 8
  if (/resolves?\s+(?:yes|no|to\s+(?:yes|no))\b/i.test(rawRulesText)) score += 10
  if (/\bif\s+and\s+only\s+if\b/i.test(rawRulesText)) score += 6
  score = Math.max(5, Math.min(100, score))
  const label = score >= 70 ? "HIGH" : score >= 45 ? "MEDIUM" : "LOW"
  const cls   = score >= 70 ? "val-green" : score >= 45 ? "val-amber" : "val-red"
  const hint  = score >= 70
    ? "Clear, objective criteria with verifiable triggers."
    : score >= 45
    ? "Some ambiguity — platform judgment may be involved."
    : "Vague or discretionary criteria — resolution could surprise you."
  return { score, label, cls, hint }
}

function resolutionConfidenceHtml(rawRulesText) {
  const r = _resolutionConfidenceScore(rawRulesText)
  if (!r) return ""
  return `<div class="resolution-confidence"><span class="rc-label">CLARITY</span><span class="rc-val ${r.cls}">${r.label}</span><span class="rc-hint">${esc(r.hint)}</span></div>`
}

// ── Resolution checklist ───────────────────────────────────────────────────────
// outcomes: NormalizedOutcome[] — used to flag sentences that match a high-
// probability outcome so traders can see at a glance which conditions are
// likely to trigger. A sentence "matches" when:
//   • it contains "you win"  → cross-ref against the YES / leading outcome
//   • it contains "you lose" → cross-ref against the NO  / trailing outcome
//   • it contains an outcome label (multi-outcome markets, case-insensitive)
// The indicator is shown when the matched outcome is ≥ 65%.
function resolutionChecklist(sentences, outcomes) {
  if (!sentences || !sentences.length) return ""

  // Build a lookup: normalised label → { pct, color }
  const outcomeMap = []
  if (Array.isArray(outcomes)) {
    outcomes.forEach(o => {
      if (o && typeof o.label === "string") {
        outcomeMap.push({ label: o.label.toLowerCase(), pct: o.pct || 0, color: o.color || "var(--orange)" })
      }
    })
  }

  const THRESHOLD = 65

  function matchPct(sentence) {
    const sl = sentence.toLowerCase()

    // "you win" → the YES / highest-probability side
    if (/\byou win\b/.test(sl)) {
      const yes = outcomeMap.find(o => o.label === "yes") || outcomeMap[0]
      if (yes && yes.pct >= THRESHOLD) return yes
    }

    // "you lose" → the NO / lowest-probability side
    if (/\byou lose\b/.test(sl)) {
      const no = outcomeMap.find(o => o.label === "no") || outcomeMap[outcomeMap.length - 1]
      if (no && no.pct >= THRESHOLD) return no
    }

    // Multi-outcome: any outcome label found verbatim in the sentence
    for (const o of outcomeMap) {
      if (o.label.length > 1 && sl.includes(o.label) && o.pct >= THRESHOLD) return o
    }

    return null
  }

  return sentences.map(s => {
    // Rule sentences arrive as plain text. linkKnownSources() escapes the
    // sentence itself and only injects anchors for a fixed allowlist of sources,
    // so its output is safe to insert directly; anything else is escaped here.
    const inner = typeof s === "string" ? (linkKnownSources(s) || esc(s)) : esc(s)
    const match = typeof s === "string" ? matchPct(s) : null
    const iconHtml = match
      ? `<span class="rule-check-icon rule-check-active" style="color:${match.color}" title="${esc("Conditions likely met \u2014 " + match.label.toUpperCase() + " is at " + Math.round(match.pct) + "%")}">●</span>`
      : `<span class="rule-check-icon">○</span>`
    return `
    <div class="rule-check-item${match ? " rule-check-item--live" : ""}">
      ${iconHtml}
      <span class="rule-check-text">${inner}</span>
    </div>`
  }).join("")
}

// ── Volume-weighted consensus ─────────────────────────────────────────────────
function volumeWeightedConsensusCard(outcomes) {
  if (!outcomes || outcomes.length < 3) return ""
  const withVol = outcomes.filter(o => o.vol && o.vol !== "—")
  if (withVol.length < 3) return ""
  const vols = withVol.map(o => parseInt(String(o.vol).replace(/,/g, ""), 10))
  const totalVol = vols.reduce((s, v) => s + v, 0)
  if (totalVol <= 0) return ""
  const ranked = withVol.map((o, i) => ({ ...o, volPct: Math.round(vols[i] / totalVol * 100) }))
    .sort((a, b) => b.volPct - a.volPct)
  const top = ranked[0]
  const consensus = top.volPct >= 50
    ? `<strong style="color:${top.color}">${esc(top.label)}</strong> has ${top.volPct}% of all volume`
    : `No clear money consensus — <strong style="color:${top.color}">${esc(top.label)}</strong> leads with ${top.volPct}%`
  return `
    <div class="mi-card">
      <div class="section-label">VOLUME-WEIGHTED CONSENSUS</div>
      <div class="consensus-body">${consensus}<span class="consensus-sep"> · </span>price: ${top.pct}%</div>
    </div>`
}

// ── "Find similar open markets" card (resolved pages only) ────────────────────
function findSimilarMarketsCard(platform, title) {
  if (!title) return ""
  const keywords = title.split(/\s+/).filter(w => w.length > 4).slice(0, 4).join(" ")
  const kq = encodeURIComponent(keywords)
  const links = []
  if (platform !== "kalshi")    links.push(`<a href="https://kalshi.com/markets?search=${kq}" target="_blank" rel="noopener" class="similar-link">Search Kalshi ↗</a>`)
  // polymarket.com/?q=… is silently ignored by the homepage; /search?q=… 301s to /predictions?_q=…
  if (platform !== "polymarket") links.push(`<a href="https://polymarket.com/search?q=${kq}" target="_blank" rel="noopener" class="similar-link">Search Polymarket ↗</a>`)
  // gemini.com/prediction-markets returns the JSON API (Content-Type: application/json); /predictions is the user-facing page
  if (platform !== "gemini")     links.push(`<a href="https://www.gemini.com/predictions" target="_blank" rel="noopener" class="similar-link">Browse Gemini ↗</a>`)
  if (!links.length) return ""
  const shortTitle = title.length > 65 ? title.slice(0, 64) + "…" : title
  return `
    <div class="mi-card similar-markets-card">
      <div class="section-label">FIND SIMILAR OPEN MARKETS</div>
      <div class="similar-markets-body">Looking for active markets about <em>${esc(shortTitle)}</em>?</div>
      <div class="similar-links">${links.join("")}</div>
    </div>`
}

function resolvedBoxHtml(info) {
  if (!info) return ""
  const isNo = info.resolution === "no"
  const colorClass = isNo ? "resolved-no" : "resolved-yes"
  const winners = info.winners || (info.winner ? [info.winner] : [])
  const multiWin = winners.length > 1
  const pillText = multiWin ? "WINNERS" : (info.isMultiOutcome ? "WINNER" : (info.resolution ? info.resolution.toUpperCase() : "RESOLVED"))
  const checkMark = isNo ? "✗" : "✓"

  const metaItems = []
  if (info.resolvedAt) metaItems.push({ key: "ENDED", val: fmtDateTime(info.resolvedAt) })
  if (info.durationDays != null) metaItems.push({ key: "MARKET RAN", val: `${info.durationDays} day${info.durationDays !== 1 ? "s" : ""}` })
  if (info.totalVol)   metaItems.push({ key: "TOTAL VOLUME", val: `$${info.totalVol}` })
  if (info.value)      metaItems.push({ key: "SETTLED AT", val: info.value })
  if (info.totalOutcomes) metaItems.push({ key: "OUTCOMES", val: `${info.winnersCount} of ${info.totalOutcomes} resolved YES` })
  if (info.runnerUp)   metaItems.push({ key: "RUNNER-UP (BY VOLUME)", val: `${info.runnerUp.label} · ${info.runnerUp.vol}` })

  const metaHtml = metaItems.length
    ? `<div class="resolved-meta">${metaItems.map(i =>
        `<div class="resolved-meta-item">
          <div class="resolved-meta-key">${esc(i.key)}</div>
          <div class="resolved-meta-val">${esc(i.val)}</div>
        </div>`).join("")}</div>`
    : ""

  const winnersHtml = winners.map(w =>
    `<div class="resolved-winner"><span class="resolved-check">${checkMark}</span> ${esc(w)}</div>`
  ).join("")

  return `
    <div class="mi-card resolved-box ${colorClass}">
      <div class="resolved-header">
        <span class="resolved-header-label">MARKET RESOLVED</span>
        <span class="resolved-pill">${esc(pillText)}</span>
      </div>
      <div class="resolved-body">
        ${winnersHtml}
        ${metaHtml}
      </div>
    </div>`
}

function whatsTheBetCard(text) {
  if (!text) return ""
  return `
    <div class="mi-card bet-explainer">
      <div class="section-label">WHAT'S THE BET?</div>
      <div class="bet-explainer-body">${text}</div>
    </div>`
}

function formatCount(n) {
  if (n >= 100) return n.toFixed(0)
  if (n >= 10) return n.toFixed(1)
  return n.toFixed(2)
}

// `market` is a normalized outcome ({ pct, bid, ask }); a bare probability
// fraction is still accepted for callers that have no order book to hand.
function computeBetResult(bet, market, platform, side) {
  const outcome = typeof market === "number" ? { pct: market * 100 } : (market || {})
  const isNo = side === "no"
  // Price off the book you would actually hit, not the midpoint. See
  // executionPrice() in utils.js for why the NO side is (1 - bid).
  const { price, isEstimate } = executionPrice(outcome, isNo ? "no" : "yes")
  if (!Number.isFinite(price) || price <= 0 || price >= 1) {
    return { winPayout: 0, profit: 0, lossBet: bet, note: "Invalid probability.", count: null, fee: null }
  }
  const sideLabel = isNo ? "NO" : "YES"
  const isContracts = platform === "kalshi"
  const countUnit = isContracts ? "contracts" : "shares"
  const count = bet / price
  const winPayout = count * 1.00
  const profit = winPayout - bet
  const fee = feeFor(platform, { contracts: count, price })

  const priceEach = isContracts
    ? Math.round(price * 100) + "\u00a2"
    : price.toFixed(2) + " USDC"
  const venue = { kalshi: "Kalshi", polymarket: "Polymarket", coinbase: "Coinbase", gemini: "Gemini" }[platform]
  const model = isContracts ? "$1-contract" : "USDC/share ($1 per share)"
  const priceSource = isEstimate
    ? "estimated from the last price \u2014 no live order book, so your real fill may differ"
    : `the live ${isNo ? "NO" : "YES"} ask`
  const note = venue
    ? `${venue} ${model} model: betting ${sideLabel} at ${priceSource}.`
    : `Estimate only \u2014 no fee or order-book data for this venue.`

  return {
    winPayout, profit, lossBet: bet, note, count, countUnit, priceEach,
    price, isEstimate, fee, sideLabel,
  }
}

function betSimResultHtml(bet, market, platform, side) {
  const r = computeBetResult(bet, market, platform, side)
  const { winPayout, profit, lossBet, note, count, countUnit, priceEach, price, isEstimate, fee } = r
  if (count == null) return `<div class="bet-sim-win" style="color:var(--muted)">${esc(note)}</div>`
  const sideLabel = r.sideLabel
  const estFlag = isEstimate ? ` <span class="bet-sim-est">(est.)</span>` : ""
  const countLine = `<div class="bet-sim-count">You buy <strong>~${formatCount(count)} ${countUnit}</strong> at <strong>${priceEach}</strong> each${estFlag}</div>`
  const sensTable = (bet > 0 && price > 0 && price < 1) ? oddsSensTableHtml(bet, price, countUnit) : ""

  // The fee is charged when the trade fills, so it comes out of a win AND is
  // added to a loss. Showing it only against profit (as this used to) makes
  // every trade look cheaper than it is.
  const feeAmt = fee && fee.known ? fee.amount : 0
  const netWin = profit - feeAmt
  const netLoss = lossBet + feeAmt
  let feeLine = ""
  if (fee && fee.known && feeAmt > 0) {
    feeLine = `<div class="bet-sim-fee">${esc(fee.label)}: <strong>\u2212$${feeAmt.toFixed(2)}</strong> <span class="bet-sim-fee-detail">${esc(fee.note)}</span></div>`
  } else if (fee && fee.known) {
    feeLine = `<div class="bet-sim-fee">${esc(fee.label)}: <strong>$0.00</strong> <span class="bet-sim-fee-detail">${esc(fee.note)}</span></div>`
  } else if (fee) {
    feeLine = `<div class="bet-sim-fee bet-sim-fee-unknown">${esc(fee.label)} not included \u2014 <span class="bet-sim-fee-detail">${esc(fee.note)}</span></div>`
  }

  return `
    ${countLine}
    <div class="bet-sim-win">If <strong>${sideLabel}</strong> wins: collect <strong>$${winPayout.toFixed(2)}</strong> <span class="val-green">(+$${netWin.toFixed(2)} net)</span></div>
    <div class="bet-sim-lose">If <strong>${sideLabel}</strong> loses: you are out <strong>$${netLoss.toFixed(2)}</strong></div>
    ${feeLine}
    <div class="bet-sim-note">${note}</div>
    ${sensTable}`
}

function oddsSensTableHtml(bet, effectiveProb, countUnit) {
  const anchors = [0.10, 0.30, 0.50, 0.70, 0.90]
  const DEDUP_EPS = 0.02
  const filtered = anchors.filter(a => Math.abs(a - effectiveProb) >= DEDUP_EPS)
  const allLevels = [...filtered, effectiveProb].sort((a, b) => a - b)
  const rowsHtml = allLevels.map(p => {
    const isCurrent = p === effectiveProb
    const cnt = bet / p
    const payout = cnt * 1.0
    const profit = payout - bet
    const cls = isCurrent ? ' class="odds-sens-current"' : ""
    const marker = isCurrent ? " ◀" : ""
    return `<tr${cls}><td>${Math.round(p * 100)}%${marker}</td><td>~${formatCount(cnt)} ${countUnit}</td><td>$${payout.toFixed(2)}</td><td class="val-green">+$${profit.toFixed(2)}</td></tr>`
  }).join("")
  return `
    <details class="odds-sens-details">
      <summary class="odds-sens-summary">Odds sensitivity table</summary>
      <table class="odds-sens-table">
        <thead><tr><th>Odds</th><th>Size</th><th>Collect</th><th>Profit</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </details>`
}

function betSimulatorHtml(outcomes) {
  if (!Array.isArray(outcomes)) {
    const n = outcomes
    outcomes = (n > 0 && n < 100) ? [{ label: "the leading outcome", pct: n, color: "#22c55e" }] : []
  }
  const valid = outcomes.filter(o => o.pct > 0 && o.pct < 100).sort((a, b) => b.pct - a.pct)
  if (!valid.length) return ""
  const capped = valid.slice(0, 4)
  const first = capped[0]
  const defaultBet = window._simMarket ? window._simMarket.amount : 10
  const platform = window._simMarket ? window._simMarket.platform : ""
  // The selected outcome is carried whole (pct + bid + ask) so the calculator
  // can price off the real book rather than the midpoint.
  if (window._simMarket) window._simMarket.outcome = { pct: first.pct, bid: first.bid, ask: first.ask, label: first.label }
  const isBinary = capped.length <= 2
  const tabsHtml = !isBinary && capped.length > 1
    ? `<div class="bet-sim-tabs">${capped.map((o, i) => {
        const active = i === 0
        const s = active ? `border-color:${o.color};color:${o.color};background:${o.color}22` : ``
        return `<button class="bet-sim-tab${active ? " active" : ""}" style="${s}"
          data-pct="${o.pct}" data-label="${esc(o.label)}" data-color="${esc(o.color)}"
          data-bid="${Number.isFinite(o.bid) ? o.bid : ""}" data-ask="${Number.isFinite(o.ask) ? o.ask : ""}"
          onclick="selectBetSimOutcome(this)">${esc(o.label)} · ${o.pct}%</button>`
      }).join("")}</div>`
    : ""
  const yesPct = first.pct
  const noPct = 100 - first.pct
  const savedSide = window._simMarket ? window._simMarket.side || "yes" : "yes"
  const sideToggleHtml = isBinary
    ? `<div class="bet-sim-side-toggle" id="betSimSideToggle">
        <span class="bet-sim-side-label">Betting side:</span>
        <button class="bet-sim-side-btn${savedSide !== "no" ? " active" : ""}" id="betSimSideYes" onclick="selectBetSimSide('yes')">YES <span class="bet-sim-side-pct" id="betSimYesPct">· ${yesPct}%</span></button>
        <button class="bet-sim-side-btn${savedSide === "no" ? " active" : ""}" id="betSimSideNo" onclick="selectBetSimSide('no')">NO <span class="bet-sim-side-pct" id="betSimNoPct">· ${noPct}%</span></button>
      </div>`
    : ""
  return `
    <div class="mi-card bet-sim-card">
      <div class="section-label">BET CALCULATOR</div>
      ${tabsHtml}
      <div class="bet-sim-body">
        ${sideToggleHtml}
        <div class="bet-sim-input-row">
          <span class="bet-sim-label">If you bet</span>
          <span class="bet-sim-dollar">$</span>
          <input type="number" class="bet-sim-input" id="betSimInput" value="${defaultBet}" min="1" max="100000" step="1"
            oninput="updateBetSim()" />
        </div>
        <div class="bet-sim-results" id="betSimResults">
          ${betSimResultHtml(defaultBet, first, platform, window._simMarket ? window._simMarket.side : "yes")}
        </div>
      </div>
    </div>`
}

window._simMarket = { amount: 10, pct: 0, platform: "", side: "yes" }
window.selectBetSimOutcome = function(btn) {
  const pct = parseFloat(btn.dataset.pct)
  const color = btn.dataset.color
  const bid = parseFloat(btn.dataset.bid)
  const ask = parseFloat(btn.dataset.ask)
  window._simMarket.pct = pct
  window._simMarket.outcome = {
    pct,
    label: btn.dataset.label || "",
    ...(Number.isFinite(bid) ? { bid } : {}),
    ...(Number.isFinite(ask) ? { ask } : {}),
  }
  document.querySelectorAll(".bet-sim-tab").forEach(t => {
    t.classList.remove("active")
    t.style.borderColor = ""
    t.style.color = ""
    t.style.background = ""
  })
  btn.classList.add("active")
  btn.style.borderColor = color
  btn.style.color = color
  btn.style.background = color + "22"
  const side = window._simMarket.side || "yes"
  const yesBtn = document.getElementById("betSimSideYes")
  const noBtn = document.getElementById("betSimSideNo")
  if (yesBtn && noBtn) {
    yesBtn.classList.toggle("active", side === "yes")
    noBtn.classList.toggle("active", side === "no")
  }
  updateBetSim()
}
window.selectBetSimSide = function(side) {
  window._simMarket.side = side
  const yesBtn = document.getElementById("betSimSideYes")
  const noBtn = document.getElementById("betSimSideNo")
  if (yesBtn && noBtn) {
    yesBtn.classList.toggle("active", side === "yes")
    noBtn.classList.toggle("active", side === "no")
  }
  updateBetSim()
}
function updateBetSim() {
  const input = document.getElementById("betSimInput")
  const results = document.getElementById("betSimResults")
  if (!input || !results) return
  const bet = Math.max(0, parseFloat(input.value) || 0)
  window._simMarket.amount = bet
  const outcome = window._simMarket.outcome || { pct: window._simMarket.pct }
  const side = window._simMarket.side || "yes"
  if (!(outcome.pct > 0 && outcome.pct < 100) || bet <= 0) {
    results.innerHTML = `<div class="bet-sim-win" style="color:var(--muted)">Enter a bet amount above</div>`
    return
  }
  results.innerHTML = betSimResultHtml(bet, outcome, window._simMarket.platform || "", side)
}

// ── "What's your edge?" personal Kelly calculator ─────────────────────────────
function edgeCalculatorHtml(outcomes) {
  const valid = outcomes.filter(o => o.pct > 0 && o.pct < 100)
  if (!valid.length) return ""
  const first = valid[0]
  const askFrac = executionPrice(first, "yes").price
  // Store for callback
  window._edgeCalcAsk = askFrac
  window._edgeCalcLabel = first.label
  // A single probability input drives both the Kelly math and the saved
  // prediction log (there used to be a second, duplicate input further down).
  const saved = typeof _getSavedPrediction === "function" ? _getSavedPrediction() : null
  return `
    <div class="mi-card edge-calc-card">
      <div class="section-label">WHAT'S YOUR EDGE?</div>
      <div class="edge-calc-body">
        <div class="edge-input-row">
          <label class="edge-input-label">My probability for <strong>${esc(first.label)}</strong>:</label>
          <div class="edge-input-wrap">
            <input type="number" id="edgeProbInput" class="edge-prob-input"
              value="${saved ? saved.myProb : ""}" placeholder="?" min="1" max="99" step="1" oninput="updateEdgeCalc()" />
            <span class="edge-pct-sign">%</span>
          </div>
          <button class="copy-link-btn" onclick="saveMyPrediction()" title="Log this estimate to track your calibration over time">Save estimate</button>
        </div>
        ${saved ? `<div class="my-pred-saved" id="edgeSavedNote">Last saved estimate: ${saved.myProb}% (market was at ${saved.marketProb}%)</div>` : `<div class="my-pred-saved" id="edgeSavedNote" style="display:none"></div>`}
        <div id="edgeCalcResult" class="edge-calc-result"></div>
      </div>
    </div>`
}

// Called once after the market renders: seeds EV/Kelly from a saved estimate,
// or leaves them explicitly undefined until the user states one.
window.initEdgeCalc = function() {
  const input = document.getElementById("edgeProbInput")
  const platform = window._simMarket ? window._simMarket.platform : ""
  const seeded = input && input.value !== "" ? parseFloat(input.value) : NaN
  if (Number.isFinite(seeded)) { window.updateEdgeCalc(); return }
  window._userProb = null
  renderAnalyticsEdge(NaN, platform, window._edgeCalcLabel)
}

window.updateEdgeCalc = function() {
  const input = document.getElementById("edgeProbInput")
  const resultEl = document.getElementById("edgeCalcResult")
  const platform = window._simMarket ? window._simMarket.platform : ""
  if (!input) return
  const myProb = Math.max(1, Math.min(99, parseFloat(input.value) || 50)) / 100
  // One estimate drives the whole page: the analytics card's EV and Kelly are
  // the same numbers as this card's, computed from the same price and fees.
  window._userProb = myProb
  renderAnalyticsEdge(myProb, platform, window._edgeCalcLabel)
  if (!resultEl) return

  const ask = window._edgeCalcAsk
  if (!Number.isFinite(ask) || ask <= 0 || ask >= 1) { resultEl.innerHTML = ""; return }
  const k = kellyFractionAfterFees(myProb, ask, platform)
  const cost = k.effectivePrice
  const marketPct = Math.round(ask * 100)
  const costPct = Math.round(cost * 100)
  const myPct = Math.round(myProb * 100)
  const feeLine = k.feeKnown
    ? (k.fee.amount > 0
        ? `Includes ${esc(k.fee.label.toLowerCase())} \u2014 your true break-even is <strong>${costPct}%</strong>, not ${marketPct}%.`
        : `${esc(k.fee.label)}: none on this venue, so your break-even is the ask (<strong>${marketPct}%</strong>).`)
    : `${esc(k.fee.label)} are not modeled, so this is <strong>before fees</strong>.`

  if (!Number.isFinite(k.fraction) || k.fraction <= 0) {
    const msg = myPct < costPct
      ? `You are less bullish (${myPct}%) than the price you would pay (${costPct}%) \u2014 no edge betting YES.`
      : `Edge too thin at these odds to cover the cost of entry.`
    resultEl.innerHTML = `
      <div class="edge-result-row val-red"><strong>No edge</strong> \u2014 ${esc(msg)}</div>
      <div class="bet-sim-note">${feeLine}</div>`
    return
  }
  const kellyPct = Math.round(k.fraction * 100 * 10) / 10
  const half = Math.round(kellyPct / 2 * 10) / 10
  const quarter = Math.round(kellyPct / 4 * 10) / 10
  const evPct = Math.round((myProb - cost) / cost * 1000) / 10
  resultEl.innerHTML = `
    <div class="edge-result-row val-green">
      You have a <strong>+${myPct - costPct}pt edge</strong> after cost of entry (you: ${myPct}% vs your break-even: ${costPct}%)
    </div>
    <div class="edge-result-row">Expected value: <strong class="val-green">+${evPct}%</strong> per dollar staked</div>
    <div class="edge-kelly-rows">
      <div class="edge-kelly-row"><span class="edge-kelly-label">Full Kelly:</span> <span class="val-amber">${kellyPct}% of bankroll</span> <span class="edge-kelly-hint">(aggressive)</span></div>
      <div class="edge-kelly-row"><span class="edge-kelly-label">Half Kelly:</span> <span class="val-green">${half}%</span> <span class="edge-kelly-hint">(recommended)</span></div>
      <div class="edge-kelly-row"><span class="edge-kelly-label">Quarter Kelly:</span> <span class="val-green">${quarter}%</span> <span class="edge-kelly-hint">(conservative)</span></div>
    </div>
    <div class="bet-sim-note">${feeLine} Kelly assumes a $1 settlement per share and that your estimate is well calibrated.</div>`
}

function calcAnalyticsRow(label, prob, ask, bid, color) {
  if (!Number.isFinite(prob) || prob <= 0 || prob >= 1) return null
  if (!Number.isFinite(ask) || ask <= 0 || ask >= 1) return null
  const round1 = n => Math.round(n * 10) / 10
  // Break-even and spread are properties of the market itself, so they are
  // computed here. Expected value and Kelly are NOT: both are defined against
  // YOUR probability, and measuring them against the market's own midpoint
  // (which is what this function used to do) makes EV always equal minus half
  // the spread and Kelly always zero, on every market. They are filled in by
  // renderAnalyticsEdge() once the user states an estimate.
  const breakEven = round1(ask * 100)
  const mid = Number.isFinite(bid) ? (bid + ask) / 2 : ask
  const spread = mid > 0 && Number.isFinite(bid) ? round1((ask - bid) / mid * 100) : null
  return { label, breakEven, spread, ask, marketPct: Math.round(prob * 100), color: color || "" }
}

// Fills the EV / Kelly slots in the analytics card from the user's own
// probability. Called on render (with whatever estimate is saved) and again on
// every keystroke in the "What's your edge?" input.
function renderAnalyticsEdge(myProb, platform, forLabel) {
  if (typeof document === "undefined") return
  const slots = document.querySelectorAll(".analytics-edge-slot")
  slots.forEach((slot) => {
    const ask = parseFloat(slot.dataset.ask)
    if (!Number.isFinite(ask) || ask <= 0 || ask >= 1) { slot.innerHTML = ""; return }
    // An estimate is about one outcome. On a multi-outcome market, applying the
    // same number to every row would be nonsense, so only the row the estimate
    // was made for gets EV and Kelly.
    const isTarget = !forLabel || !slot.dataset.label || slot.dataset.label === forLabel
    if (!isTarget) {
      slot.innerHTML = `<div class="info-row analytics-edge-prompt"><span class="info-key">YOUR EDGE</span><span class="info-val val-muted">estimate applies to \u201c${esc(forLabel)}\u201d</span></div>`
      return
    }
    if (!Number.isFinite(myProb) || myProb <= 0 || myProb >= 1) {
      slot.innerHTML = `<div class="info-row analytics-edge-prompt"><span class="info-key">YOUR EDGE</span><span class="info-val val-muted">needs your probability \u2014 see \u201cWhat\u2019s your edge?\u201d below</span></div>`
      return
    }
    slot.innerHTML = analyticsEdgeRowsHtml(myProb, ask, platform)
  })
}

// EV and Kelly for one outcome, net of entry fees where the venue publishes
// them. Both are expressed per dollar staked at the price you would actually
// pay, so they line up with the bet calculator above.
function analyticsEdgeRowsHtml(myProb, ask, platform) {
  const round1 = n => Math.round(n * 10) / 10
  const k = kellyFractionAfterFees(myProb, ask, platform)
  const cost = k.effectivePrice
  const ev = round1((myProb * 1.0 - cost) / cost * 100)
  const evClass = ev > 0 ? "val-green" : ev < 0 ? "val-red" : "val-muted"
  const feeNote = k.feeKnown ? "" : ` <span class="analytics-fee-caveat">(before fees)</span>`
  const parts = [
    `<div class="info-row"><span class="info-key">${tip("EXPECTED VALUE")}</span><span class="info-val ${evClass}">${ev > 0 ? "+" : ""}${ev}%${feeNote}</span></div>`,
  ]
  const raw = k.fraction
  if (Number.isFinite(raw)) {
    const rawPct = round1(raw * 100)
    const CAP = 25
    const capped = Math.min(Math.max(rawPct, 0), CAP)
    const barW = Math.round(capped / CAP * 100)
    const kellyClass = capped <= 0 ? "val-muted" : capped < 5 ? "val-green" : capped < 15 ? "val-amber" : "val-red"
    // The bar is capped at 25% of bankroll, but say so rather than silently
    // clipping a 60% Kelly down to 25% and letting it read as the real answer.
    const capNote = rawPct > CAP
      ? ` <span class="kelly-cap-note" title="Full Kelly here is ${rawPct}% of bankroll; the bar is capped at ${CAP}%">full Kelly ${rawPct}% \u2014 bar capped at ${CAP}%</span>`
      : ""
    parts.push(`
      <div class="info-row info-row-kelly">
        <span class="info-key">${tip("KELLY CRITERION")}</span>
        <span class="info-val kelly-val-wrap">
          <span class="kelly-visual" title="Kelly suggests ${rawPct}% of bankroll">
            <span class="kelly-fill" style="width:${barW}%"></span>
          </span>
          <span class="${kellyClass}">${rawPct <= 0 ? "no bet" : rawPct + "%"}</span>${capNote}
        </span>
      </div>`)
  }
  return parts.join("")
}

// Feature 3 & 6: analyticsCard now accepts optional overround for prominent display
function analyticsCard(rows, timeLeft, overround) {
  if ((!rows || !rows.length) && !timeLeft && overround == null) return ""
  const lines = rows.map((r, idx) => {
    const parts = []
    parts.push(`<div class="info-row"><span class="info-key">${tip("BREAK-EVEN")}</span><span class="info-val val-muted">${r.breakEven}%</span></div>`)
    // EV and Kelly land here, filled by renderAnalyticsEdge() from the user's
    // own probability -- they are undefined until someone states one.
    parts.push(`<div class="analytics-edge-slot" data-ask="${r.ask}" data-label="${esc(r.label)}"></div>`)
    if (r.spread !== null) {
      const spClass = r.spread < 3 ? "val-green" : r.spread < 8 ? "val-amber" : "val-red"
      parts.push(`<div class="info-row"><span class="info-key">${tip("SPREAD QUALITY")}</span><span class="info-val ${spClass}">${r.spread}%</span></div>`)
    }
    const dotStyle = r.color ? ` style="color:${esc(r.color)}"` : ""
    const sepStyle = rows.length > 1 && idx > 0 ? "border-top:1px solid var(--border);margin-top:4px;padding-top:8px;" : ""
    const labelHeader = rows.length > 1
      ? `<div class="info-row" style="border-bottom:none;padding-bottom:4px;${sepStyle}"><span class="info-key" style="font-weight:600"><span${dotStyle}>●</span> ${esc(r.label)}</span></div>`
      : ""
    return labelHeader + parts.join("")
  }).join("")
  const timeRow = timeLeft
    ? `<div class="info-row"><span class="info-key">TIME REMAINING</span><span class="info-val urgency-text-${timeLeft.urgency}">⏱ ${esc(timeLeft.text)}</span></div>`
    : ""
  // Feature 3: overround prominently in analytics (key quality signal)
  let overroundRow = ""
  if (overround != null && overround > 0) {
    const edge = overround - 100
    const orClass = edge <= 1 ? "val-green" : edge <= 5 ? "val-amber" : "val-red"
    const orNote = edge <= 0 ? "FAIR" : `+${edge}% HOUSE EDGE`
    overroundRow = `<div class="info-row"><span class="info-key">${tip("OVERROUND")}</span><span class="info-val ${orClass}">${overround}% <span class="overround-note">${orNote}</span></span></div>`
  }
  return `
    <div class="mi-card">
      <div class="section-label">TRADER ANALYTICS</div>
      ${overroundRow}
      ${timeRow}
      ${lines}
    </div>`
}

// Feature 2: Volume distribution bar — shows where money is concentrated across outcomes
function volumeDistBar(outcomes) {
  const withVol = outcomes.filter(o => o.vol && o.vol !== "—")
  if (withVol.length < 2) return ""
  const vols = withVol.map(o => parseInt(String(o.vol || "0").replace(/,/g, ""), 10))
  const total = vols.reduce((s, v) => s + v, 0)
  if (total <= 0) return ""
  const segments = withVol.map((o, i) => {
    const pct = (vols[i] / total * 100).toFixed(1)
    return `<div class="vd-seg" style="width:${pct}%;background:${o.color}" title="${esc(o.label)}: ${pct}% of volume ($${o.vol} traded)"></div>`
  }).join("")
  const legendItems = withVol.map((o, i) => {
    const pct = Math.round(vols[i] / total * 100)
    return `<span class="vd-legend-item"><span style="color:${o.color}">●</span> ${esc(o.label)}: ${pct}%</span>`
  }).join("")
  return `
    <div class="mi-card">
      <div class="section-label">VOLUME DISTRIBUTION</div>
      <div class="vd-wrap">
        <div class="vd-bar">${segments}</div>
        <div class="vd-legend">${legendItems}</div>
      </div>
    </div>`
}

// Feature 11: Skeleton loading state matching the market layout
function skeletonHtml(platformLabel) {
  const label = platformLabel ? `<div class="sk-block" style="width:80px;height:22px;border-radius:3px"></div>` : ""
  return `
    <div class="skeleton">
      <div class="mi-card">
        <div class="sk-event-head">
          <div class="sk-tags">
            ${label}
            <div class="sk-block" style="width:70px;height:22px;border-radius:3px"></div>
            <div class="sk-block" style="width:50px;height:22px;border-radius:3px"></div>
          </div>
          <div class="sk-block" style="width:78%;height:26px;margin-top:18px"></div>
          <div class="sk-block" style="width:55%;height:26px;margin-top:12px"></div>
        </div>
      </div>
      <div class="mi-card" style="overflow:hidden">
        <div class="sk-block" style="width:140px;height:13px;margin:18px 32px 14px;border-radius:2px"></div>
        <div class="sk-outcome-row"><div class="sk-block" style="width:42%;height:16px"></div><div class="sk-block" style="width:64px;height:44px"></div></div>
        <div class="sk-outcome-row" style="border-top:1px solid var(--border)"><div class="sk-block" style="width:56%;height:16px"></div><div class="sk-block" style="width:54px;height:44px"></div></div>
        <div class="sk-outcome-row" style="border-top:1px solid var(--border)"><div class="sk-block" style="width:38%;height:16px"></div><div class="sk-block" style="width:48px;height:44px"></div></div>
      </div>
      <div class="sk-stats-grid">
        <div class="sk-block sk-stat-card"></div>
        <div class="sk-block sk-stat-card"></div>
        <div class="sk-block sk-stat-card"></div>
        <div class="sk-block sk-stat-card"></div>
      </div>
      <div class="mi-card" style="overflow:hidden">
        <div class="sk-block" style="width:140px;height:13px;margin:18px 32px 14px;border-radius:2px"></div>
        <div style="padding:14px 32px"><div class="sk-block" style="width:100%;height:12px"></div></div>
        <div style="padding:8px 32px 20px"><div class="sk-block" style="width:80%;height:12px"></div></div>
      </div>
    </div>`
}

function statCard(label, value, sub = "") {
  const hasValue = value && String(value).trim() && String(value).trim() !== "—"
  const inner = hasValue
    ? `<div class="stat-value">${esc(String(value))}</div>${sub ? `<div class="stat-sub">${esc(sub)}</div>` : ""}`
    : `<div class="stat-empty">Not reported</div>`
  return `<div class="stat-card"><div class="stat-label">${tip(label)}</div>${inner}</div>`
}

// Liquidity/maker/taker reward program card — shared across Kalshi, Polymarket, and Gemini.
// rows: { key, val }[] rendered via infoRow (auto-glossary-linked when key matches GLOSSARY).
// note: optional pre-rendered HTML footnote (e.g. program description + link out).
function rewardsCard(rows, note) {
  const body = (rows || []).map(r => infoRow(r.key, r.val)).filter(Boolean).join("")
  if (!body && !note) return ""
  return `
    <div class="mi-card">
      <div class="section-label">LIQUIDITY &amp; TRADING REWARDS</div>
      ${body}
      ${note ? `<div class="platform-footnote">${note}</div>` : ""}
    </div>`
}

function infoRow(key, val) {
  if (!val || val === "—") return ""
  const keyHtml = GLOSSARY[key.toUpperCase()] ? tip(key, key.toUpperCase()) : esc(key)
  return `<div class="info-row"><span class="info-key">${keyHtml}</span><span class="info-val info-val-wrap">${esc(val)}</span></div>`
}

function numList(sentences) {
  return sentences.map((s, i) => `
    <div class="num-row">
      <span class="num-idx">${String(i + 1).padStart(2, "0")}</span>
      <span class="num-text">${s}</span>
    </div>`).join("")
}

// ── Plain talk probability label ───────────────────────────────────────────────
function pctToPlainTalk(pct) {
  if (pct >= 95) return "Near certain"
  if (pct >= 85) return "Very likely"
  if (pct >= 70) return "Likely"
  if (pct >= 55) return "More likely than not"
  if (pct >= 45) return "Coin flip"
  if (pct >= 30) return "Unlikely"
  if (pct >= 15) return "Long shot"
  return "Very unlikely"
}

function outcomeRow(label, sub, pct, color, delta = null, extras = {}) {
  const ml = toMoneyline(pct)

  // Momentum arrow next to outcome name (↑/↓ based on delta direction)
  const momentumArrow = delta !== null && delta !== 0
    ? `<span class="momentum-arrow ${delta > 0 ? "momentum-up" : "momentum-dn"}" title="${delta > 0 ? "Rising" : "Falling"} (${delta > 0 ? "+" : ""}${delta} pts)">${delta > 0 ? "↑" : "↓"}</span>`
    : ""

  // Feature 10: label delta as "pts" with a tooltip
  const deltaHtml = delta !== null && delta !== 0
    ? `<span class="outcome-delta ${delta > 0 ? 'delta-up' : 'delta-dn'}" title="Price change vs. last trade: ${delta > 0 ? "+" : ""}${delta} percentage points">${delta > 0 ? '▲' : '▼'} ${Math.abs(delta)}<span class="delta-label">pts</span></span>`
    : ""

  // Plain talk label below outcome name
  const plainTalkHtml = `<div class="outcome-plain-talk">${pctToPlainTalk(pct)}</div>`

  const estTag = extras.isEstimate ? `<span class="est-tag">(est.)</span>` : ""
  const metaParts = []

  // Dead money indicator: spread > 15% of mid = illiquid; LIQUID badge: spread ≤ 2% of mid AND vol ≥ $50k
  let deadMoneyHtml = ""
  let liquidBadgeHtml = ""
  if (Number.isFinite(extras.bid) && Number.isFinite(extras.ask) && extras.ask > extras.bid && extras.ask > 0) {
    const spread = extras.ask - extras.bid
    const mid = (extras.bid + extras.ask) / 2
    if (mid > 0) {
      const spreadPct = spread / mid
      if (spreadPct > 0.15) {
        deadMoneyHtml = `<span class="dead-money-tag" title="Wide spread (${Math.round(spread * 100)}¢) — low liquidity">Illiquid</span>`
      } else {
        const vol = parseInt(String(extras.vol || "0").replace(/,/g, ""), 10)
        if (spreadPct <= 0.02 && vol >= 50000) {
          liquidBadgeHtml = `<span class="liquid-badge" title="Tight spread (${Math.round(spread * 100)}¢) + high volume — good market to trade">Liquid</span>`
        }
      }
    }
  }

  if (Number.isFinite(extras.bid) && Number.isFinite(extras.ask)) {
    metaParts.push(`${tip("Bid", "BID / ASK")} ${Math.round(extras.bid * 100)}¢ · ${tip("Ask", "BID / ASK")} ${Math.round(extras.ask * 100)}¢`)
  }

  // Spread cost visualization: ~$X spread per $100 bet
  if (Number.isFinite(extras.bid) && Number.isFinite(extras.ask) && extras.ask > extras.bid) {
    const spreadCost = Math.round((extras.ask - extras.bid) * 100)
    if (spreadCost > 0) {
      metaParts.push(`<span class="spread-cost-note" title="Estimated round-trip spread cost per $100 payout">~$${spreadCost} spread per $100</span>`)
    }
  }

  if (extras.vol) metaParts.push(`Vol $${extras.vol}`)
  if (extras.oi) metaParts.push(`OI $${extras.oi}`)

  const badgeHtml = deadMoneyHtml || liquidBadgeHtml
  const metaHtml = (metaParts.length || badgeHtml)
    ? `<div class="outcome-meta">${badgeHtml ? `<span>${badgeHtml}</span>` : ""}${metaParts.map(p => `<span>${p}</span>`).join("")}</div>`
    : ""

  // Feature 10: "ML" micro-label above moneyline
  const mlBlock = ml !== "—"
    ? `<div class="outcome-ml-wrap"><div class="ml-label">ML</div><span class="outcome-ml">${tip(ml, "MONEYLINE")}</span></div>`
    : `<span class="outcome-ml">${tip(ml, "MONEYLINE")}</span>`

  return `
    <div class="outcome-row">
      <div class="outcome-top">
        <div class="outcome-left-col">
          <div class="outcome-name"><span class="outcome-dot" style="background:${color}"></span><span class="outcome-name-text">${esc(label)}</span>${momentumArrow}</div>
          ${sub ? `<div class="outcome-sub">${esc(sub)}</div>` : ""}
          ${plainTalkHtml}
        </div>
        <div class="outcome-right">
          <div class="odds-display"${extras.rank === 0 ? ` style="color:${color}"` : ""}>
            <span class="outcome-pct">${pct}%${estTag}</span>
            ${mlBlock}
          </div>
          ${deltaHtml}
        </div>
      </div>
      <div class="bar-wrap">
        <div class="bar-fill" style="width:${pct}%; background:${color}"></div>
      </div>
      ${metaHtml}
    </div>`
}

// Paginated show-more: reveals PAGE_SIZE rows at a time
// Remaining rows are stored as JSON on the DOM element — no global state needed.
const PAGE_SIZE = 10
let _opCounter = 0

function showMoreOutcomes(uid) {
  const row = document.getElementById(uid + "_smr")
  if (!row) return
  let pool
  try { pool = JSON.parse(row.dataset.rows || "[]") } catch { return }
  if (!pool.length) return
  const revealed = document.createElement("div")
  revealed.id = uid + "_revealed"
  revealed.innerHTML = pool.join("")
  row.parentNode.insertBefore(revealed, row)
  row.dataset.rows = "[]"
  const btn = row.querySelector("button")
  btn.textContent = "Show less ↑"
  btn.onclick = () => showLessOutcomes(uid, pool)
}

function showLessOutcomes(uid, pool) {
  const revealed = document.getElementById(uid + "_revealed")
  if (revealed) revealed.remove()
  const row = document.getElementById(uid + "_smr")
  if (!row) return
  row.dataset.rows = JSON.stringify(pool)
  const btn = row.querySelector("button")
  btn.textContent = `Show ${pool.length} more ↓`
  btn.onclick = () => showMoreOutcomes(uid)
}

function buildOutcomesHtml(rows) {
  if (rows.length <= PAGE_SIZE) return rows.join("")
  const uid = "op" + (++_opCounter)
  const remaining = JSON.stringify(rows.slice(PAGE_SIZE)).replace(/"/g, "&quot;")
  return rows.slice(0, PAGE_SIZE).join("") + `
    <div class="show-more-row" id="${uid}_smr" data-rows="${remaining}">
      <button class="show-more-btn" onclick="showMoreOutcomes('${uid}')">
        Show ${rows.length - PAGE_SIZE} more ↓
      </button>
    </div>`
}


// ── "Go place the bet" ────────────────────────────────────────────────────────
// The analysis ends in a decision, so the page has to offer somewhere to act on
// it. Without this the user is walked to a conclusion and then abandoned.
// Suppressed on resolved markets, where there is nothing left to trade.
function tradeCtaHtml(sourceUrl, platform, isResolved) {
  if (!sourceUrl || isResolved) return ""
  const venue = (PLATFORMS[platform] || {}).label || (platform || "").toUpperCase() || "the platform"
  return `
    <div class="mi-card trade-cta-card">
      <a class="trade-cta-btn" href="${esc(sourceUrl)}" target="_blank" rel="noopener noreferrer">
        Trade this market on ${esc(venue)} \u2197
      </a>
      <div class="trade-cta-note">Opens the original market. Predara does not take orders or hold funds.</div>
    </div>`
}
