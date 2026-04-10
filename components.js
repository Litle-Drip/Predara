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

  // Money won/lost estimate (when we have close odds + total vol)
  let moneyHtml = ""
  if (totalVol > 0 && closeOdds != null && closeOdds > 0 && closeOdds < 100) {
    const transfer = Math.round(totalVol * (100 - closeOdds) / 100)
    const fmt = n => "$" + n.toLocaleString()
    moneyHtml = `
      <div class="ri-row">
        <span class="ri-label">WINNERS GAINED (EST.)</span>
        <span class="ri-val val-green">~${fmt(transfer)}</span>
      </div>
      <div class="ri-row">
        <span class="ri-label">LOSERS PAID (EST.)</span>
        <span class="ri-val val-red">~${fmt(transfer)}</span>
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
  const prob = first.pct / 100
  const winPayout = (defaultBet / prob).toFixed(2)
  const profit = (winPayout - defaultBet).toFixed(2)
  const tabsHtml = capped.length > 1
    ? `<div class="bet-sim-tabs">${capped.map((o, i) => {
        const active = i === 0
        const s = active ? `border-color:${o.color};color:${o.color};background:${o.color}22` : ``
        return `<button class="bet-sim-tab${active ? " active" : ""}" style="${s}"
          data-pct="${o.pct}" data-label="${esc(o.label)}" data-color="${esc(o.color)}"
          onclick="selectBetSimOutcome(this)">${esc(o.label)} · ${o.pct}%</button>`
      }).join("")}</div>`
    : ""
  return `
    <div class="mi-card bet-sim-card">
      <div class="section-label">BET CALCULATOR</div>
      ${tabsHtml}
      <div class="bet-sim-body">
        <div class="bet-sim-input-row">
          <span class="bet-sim-label">If you bet</span>
          <span class="bet-sim-dollar">$</span>
          <input type="number" class="bet-sim-input" id="betSimInput" value="${defaultBet}" min="1" max="100000" step="1"
            oninput="updateBetSim()" />
        </div>
        <div class="bet-sim-results" id="betSimResults">
          <div class="bet-sim-win">If you <strong>win</strong>: collect <strong>$${winPayout}</strong> <span class="val-green">(+$${profit} profit)</span></div>
          <div class="bet-sim-lose">If you <strong>lose</strong>: lose your <strong>$${defaultBet.toFixed(2)}</strong></div>
        </div>
      </div>
    </div>`
}

window._simMarket = { amount: 10, pct: 0, platform: "" }
window.selectBetSimOutcome = function(btn) {
  const pct = parseFloat(btn.dataset.pct)
  const color = btn.dataset.color
  window._simMarket.pct = pct
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
  updateBetSim()
}
function updateBetSim() {
  const input = document.getElementById("betSimInput")
  const results = document.getElementById("betSimResults")
  if (!input || !results) return
  const bet = Math.max(0, parseFloat(input.value) || 0)
  window._simMarket.amount = bet
  const prob = window._simMarket.pct / 100
  if (prob <= 0 || prob >= 1 || bet <= 0) {
    results.innerHTML = `<div class="bet-sim-win" style="color:var(--muted)">Enter a bet amount above</div>`
    return
  }
  const winPayout = (bet / prob).toFixed(2)
  const profit = (winPayout - bet).toFixed(2)
  results.innerHTML = `
    <div class="bet-sim-win">If you <strong>win</strong>: collect <strong>$${winPayout}</strong> <span class="val-green">(+$${profit} profit)</span></div>
    <div class="bet-sim-lose">If you <strong>lose</strong>: lose your <strong>$${bet.toFixed(2)}</strong></div>
  `
}

function calcAnalyticsRow(label, prob, ask, bid, color) {
  if (!Number.isFinite(prob) || prob <= 0 || prob >= 1) return null
  if (!Number.isFinite(ask) || ask <= 0 || ask >= 1) return null
  const round1 = n => Math.round(n * 10) / 10
  const breakEven = round1(ask * 100)
  const ev = round1((prob - ask) / ask * 100)
  const mid = Number.isFinite(bid) ? (bid + ask) / 2 : ask
  const spread = mid > 0 && Number.isFinite(bid) ? round1((ask - bid) / mid * 100) : null
  let kelly = null
  const b = (1 - ask) / ask
  if (b > 0) {
    const k = (prob * b - (1 - prob)) / b
    kelly = Math.min(Math.max(round1(k * 100), 0), 25)
  }
  return { label, breakEven, ev, spread, kelly, color: color || "" }
}

// Feature 3 & 6: analyticsCard now accepts optional overround for prominent display
function analyticsCard(rows, timeLeft, overround) {
  if ((!rows || !rows.length) && !timeLeft && overround == null) return ""
  const lines = rows.map((r, idx) => {
    const parts = []
    parts.push(`<div class="info-row"><span class="info-key">${tip("BREAK-EVEN")}</span><span class="info-val val-muted">${r.breakEven}%</span></div>`)
    const evClass = r.ev > 0 ? "val-green" : r.ev < 0 ? "val-red" : "val-muted"
    parts.push(`<div class="info-row"><span class="info-key">${tip("EXPECTED VALUE")}</span><span class="info-val ${evClass}">${r.ev > 0 ? "+" : ""}${r.ev}%</span></div>`)
    if (r.kelly !== null) {
      // Feature 6: Kelly Criterion visual bar instead of just a number
      const kellyCapped = Math.min(r.kelly, 25)
      const kellyBarW = Math.round(kellyCapped / 25 * 100)
      const kellyClass = r.kelly <= 0 ? "val-muted" : r.kelly < 5 ? "val-green" : r.kelly < 15 ? "val-amber" : "val-red"
      parts.push(`
        <div class="info-row info-row-kelly">
          <span class="info-key">${tip("KELLY CRITERION")}</span>
          <span class="info-val kelly-val-wrap">
            <span class="kelly-visual" title="Kelly suggests ${r.kelly}% of bankroll">
              <span class="kelly-fill" style="width:${kellyBarW}%"></span>
            </span>
            <span class="${kellyClass}">${r.kelly}%</span>
          </span>
        </div>`)
    }
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
  const inner = value
    ? `<div class="stat-value">${value}</div>${sub ? `<div class="stat-sub">${esc(sub)}</div>` : ""}`
    : `<div class="stat-dash"></div>`
  return `<div class="stat-card"><div class="stat-label">${tip(label)}</div>${inner}</div>`
}

function infoRow(key, val) {
  if (!val || val === "—") return ""
  const keyHtml = GLOSSARY[key.toUpperCase()] ? tip(key, key.toUpperCase()) : esc(key)
  return `<div class="info-row"><span class="info-key">${keyHtml}</span><span class="info-val">${esc(val)}</span></div>`
}

function numList(sentences) {
  return sentences.map((s, i) => `
    <div class="num-row">
      <span class="num-idx">${String(i + 1).padStart(2, "0")}</span>
      <span class="num-text">${s}</span>
    </div>`).join("")
}

function outcomeRow(label, sub, pct, color, delta = null, extras = {}) {
  const ml = toMoneyline(pct)
  // Feature 10: label delta as "pts" with a tooltip so users know it's a price change
  const deltaHtml = delta !== null && delta !== 0
    ? `<span class="outcome-delta ${delta > 0 ? 'delta-up' : 'delta-dn'}" title="Price change vs. last trade: ${delta > 0 ? "+" : ""}${delta} percentage points">${delta > 0 ? '▲' : '▼'} ${Math.abs(delta)}<span class="delta-label">pts</span></span>`
    : ""
  const estTag = extras.isEstimate ? `<span class="est-tag">(est.)</span>` : ""
  const metaParts = []
  if (Number.isFinite(extras.bid) && Number.isFinite(extras.ask)) {
    metaParts.push(`${tip("Bid", "BID / ASK")} ${Math.round(extras.bid * 100)}¢ · ${tip("Ask", "BID / ASK")} ${Math.round(extras.ask * 100)}¢`)
  }
  if (extras.vol) metaParts.push(`Vol $${extras.vol}`)
  if (extras.oi) metaParts.push(`OI $${extras.oi}`)
  const metaHtml = metaParts.length
    ? `<div class="outcome-meta">${metaParts.map(p => `<span>${p}</span>`).join("")}</div>`
    : ""
  // Feature 10: show "ML" micro-label above moneyline number so users know what it is
  const mlBlock = ml !== "—"
    ? `<div class="outcome-ml-wrap"><div class="ml-label">ML</div><span class="outcome-ml">${tip(ml, "MONEYLINE")}</span></div>`
    : `<span class="outcome-ml">${tip(ml, "MONEYLINE")}</span>`
  return `
    <div class="outcome-row">
      <div class="outcome-top">
        <div>
          <div class="outcome-name" style="color:${color}">${esc(label)}</div>
          ${sub ? `<div class="outcome-sub">${esc(sub)}</div>` : ""}
        </div>
        <div class="outcome-right">
          <div class="odds-display" style="color:${color}">
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
  btn.textContent = "SHOW LESS  ↑"
  btn.onclick = () => showLessOutcomes(uid, pool)
}

function showLessOutcomes(uid, pool) {
  const revealed = document.getElementById(uid + "_revealed")
  if (revealed) revealed.remove()
  const row = document.getElementById(uid + "_smr")
  if (!row) return
  row.dataset.rows = JSON.stringify(pool)
  const btn = row.querySelector("button")
  btn.textContent = `+ ${pool.length} MORE  ↓`
  btn.onclick = () => showMoreOutcomes(uid)
}

function buildOutcomesHtml(rows) {
  if (rows.length <= PAGE_SIZE) return rows.join("")
  const uid = "op" + (++_opCounter)
  const remaining = JSON.stringify(rows.slice(PAGE_SIZE)).replace(/"/g, "&quot;")
  return rows.slice(0, PAGE_SIZE).join("") + `
    <div class="show-more-row" id="${uid}_smr" data-rows="${remaining}">
      <button class="show-more-btn" onclick="showMoreOutcomes('${uid}')">
        + ${rows.length - PAGE_SIZE} MORE  ↓
      </button>
    </div>`
}
