function resolvedBoxHtml(info) {
  if (!info) return ""
  const isNo = info.resolution === "no"
  const colorClass = isNo ? "resolved-no" : "resolved-yes"
  const pillText = info.isMultiOutcome ? "WINNER" : (info.resolution ? info.resolution.toUpperCase() : "RESOLVED")

  const metaItems = []
  if (info.resolvedAt) metaItems.push({ key: "ENDED", val: fmtDateTime(info.resolvedAt) })
  if (info.value)      metaItems.push({ key: "SETTLED AT", val: info.value })
  if (info.totalVol)   metaItems.push({ key: "TOTAL VOLUME", val: `$${info.totalVol}` })

  const metaHtml = metaItems.length
    ? `<div class="resolved-meta-grid">${metaItems.map(i =>
        `<div class="resolved-meta-item">
          <span class="resolved-meta-key">${esc(i.key)}</span>
          <span class="resolved-meta-val">${esc(i.val)}</span>
        </div>`).join("")}</div>`
    : ""

  return `
    <div class="mi-card resolved-box ${colorClass}">
      <div class="resolved-top-row">
        <div class="resolved-circle">${isNo ? "✗" : "✓"}</div>
        <div class="resolved-header-text">
          <div class="resolved-header-label">MARKET RESOLVED</div>
          <span class="resolved-pill">${esc(pillText)}</span>
        </div>
      </div>
      ${info.winner ? `<div class="resolved-winner">${esc(info.winner)}</div>` : ""}
      ${metaHtml}
    </div>`
}

function whatsTheBetCard(text) {
  if (!text) return ""
  return `
    <div class="mi-card bet-explainer">
      <div class="section-label">WHAT'S THE BET?</div>
      <div class="bet-explainer-body">${esc(text)}</div>
    </div>`
}

function betSimulatorHtml(pctYes) {
  if (!pctYes || pctYes <= 0 || pctYes >= 100) return ""
  const prob = pctYes / 100
  const defaultBet = window._simMarket ? window._simMarket.amount : 10
  const winPayout = (defaultBet / prob).toFixed(2)
  const profit = (winPayout - defaultBet).toFixed(2)
  return `
    <div class="mi-card bet-sim-card">
      <div class="section-label">BET CALCULATOR</div>
      <div class="bet-sim-body">
        <div class="bet-sim-input-row">
          <span class="bet-sim-label">If you bet</span>
          <span class="bet-sim-dollar">$</span>
          <input type="number" class="bet-sim-input" id="betSimInput" value="${defaultBet}" min="1" max="100000" step="1"
            oninput="updateBetSim()" />
          <span class="bet-sim-label">on the leading outcome at <strong>${pctYes}%</strong></span>
        </div>
        <div class="bet-sim-results" id="betSimResults">
          <div class="bet-sim-win">If you <strong>win</strong>: collect <strong>$${winPayout}</strong> <span class="val-green">(+$${profit} profit)</span></div>
          <div class="bet-sim-lose">If you <strong>lose</strong>: lose your <strong>$${defaultBet.toFixed(2)}</strong></div>
        </div>
      </div>
    </div>`
}

window._simMarket = { amount: 10, pct: 0, platform: "" }
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

function analyticsCard(rows, timeLeft) {
  if ((!rows || !rows.length) && !timeLeft) return ""
  const lines = rows.map(r => {
    const parts = []
    parts.push(`<div class="info-row"><span class="info-key">${tip("BREAK-EVEN")}</span><span class="info-val val-muted">${r.breakEven}%</span></div>`)
    const evClass = r.ev > 0 ? "val-green" : r.ev < 0 ? "val-red" : "val-muted"
    parts.push(`<div class="info-row"><span class="info-key">${tip("EXPECTED VALUE")}</span><span class="info-val ${evClass}">${r.ev > 0 ? "+" : ""}${r.ev}%</span></div>`)
    if (r.kelly !== null) {
      parts.push(`<div class="info-row"><span class="info-key">${tip("KELLY CRITERION")}</span><span class="info-val val-muted">${r.kelly}%</span></div>`)
    }
    if (r.spread !== null) {
      const spClass = r.spread < 3 ? "val-green" : r.spread < 8 ? "val-amber" : "val-red"
      parts.push(`<div class="info-row"><span class="info-key">${tip("SPREAD QUALITY")}</span><span class="info-val ${spClass}">${r.spread}%</span></div>`)
    }
    const dotStyle = r.color ? ` style="color:${esc(r.color)}"` : ""
    const labelHeader = rows.length > 1
      ? `<div class="info-row" style="border-bottom:none;padding-bottom:4px"><span class="info-key" style="font-weight:600"><span${dotStyle}>●</span> ${esc(r.label)}</span></div>`
      : ""
    return labelHeader + parts.join("")
  }).join("")
  const timeRow = timeLeft
    ? `<div class="info-row"><span class="info-key">TIME REMAINING</span><span class="info-val urgency-text-${timeLeft.urgency}">⏱ ${esc(timeLeft.text)}</span></div>`
    : ""
  return `
    <div class="mi-card">
      <div class="section-label">TRADER ANALYTICS</div>
      ${timeRow}
      ${lines}
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
  const deltaHtml = delta !== null && delta !== 0
    ? `<span class="outcome-delta ${delta > 0 ? 'delta-up' : 'delta-dn'}">${delta > 0 ? '▲' : '▼'} ${Math.abs(delta)}</span>`
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
            <span class="outcome-ml">${tip(ml, "MONEYLINE")}</span>
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
const PAGE_SIZE = 5
let _opCounter = 0

function showMoreOutcomes(uid) {
  const row = document.getElementById(uid + "_smr")
  if (!row) return
  let pool
  try { pool = JSON.parse(row.dataset.rows || "[]") } catch { return }
  if (!pool.length) return
  const batch = pool.splice(0, PAGE_SIZE)
  row.dataset.rows = JSON.stringify(pool)
  const tmp = document.createElement("div")
  tmp.innerHTML = batch.join("")
  while (tmp.firstChild) row.parentNode.insertBefore(tmp.firstChild, row)
  const btn = row.querySelector("button")
  if (!pool.length) {
    row.remove()
  } else {
    btn.textContent = `+ ${pool.length} MORE  ↓`
  }
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
