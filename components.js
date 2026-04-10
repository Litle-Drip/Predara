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
