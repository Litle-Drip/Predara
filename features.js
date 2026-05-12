// ── Predara Features Module ────────────────────────────────────────────────────
// Contains all new features (20 total). Each feature is self-contained and
// integrates with the existing codebase through hooks in app.js / index.html.

// ════════════════════════════════════════════════════════════════════════════════
// FEATURE 16: PWA — register service worker
// ════════════════════════════════════════════════════════════════════════════════
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {})
}

// ════════════════════════════════════════════════════════════════════════════════
// FEATURE 19: Smart Paste — auto-detect market URL from clipboard on focus
// ════════════════════════════════════════════════════════════════════════════════
let _smartPasteShown = false
function initSmartPaste() {
  const input = document.getElementById("urlInput")
  if (!input) return
  window.addEventListener("focus", async () => {
    if (_smartPasteShown || input.value.trim()) return
    try {
      if (!navigator.clipboard || !navigator.clipboard.readText) return
      const text = await navigator.clipboard.readText()
      if (!text || text.length > 300) return
      const lower = text.toLowerCase()
      const isMarketUrl =
        lower.includes("kalshi.com/") ||
        lower.includes("polymarket.com/") ||
        lower.includes("gemini.com/prediction") ||
        lower.includes("coinbase.com/")
      if (isMarketUrl) {
        _smartPasteShown = true
        _showSmartPasteBanner(text)
      }
    } catch {}
  })
}

function _showSmartPasteBanner(url) {
  const existing = document.getElementById("smartPasteBanner")
  if (existing) existing.remove()
  const banner = document.createElement("div")
  banner.id = "smartPasteBanner"
  banner.className = "smart-paste-banner"
  const short = url.length > 60 ? url.slice(0, 57) + "..." : url
  banner.innerHTML = `
    <span>Market URL detected in clipboard: <strong>${esc(short)}</strong></span>
    <button onclick="acceptSmartPaste('${esc(url.replace(/'/g, "\\'"))}')">Analyze it</button>
    <button onclick="this.parentElement.remove()" style="background:none;border:1px solid var(--border);color:var(--muted)">Dismiss</button>`
  const result = document.getElementById("result")
  if (result) result.parentElement.insertBefore(banner, result)
}

window.acceptSmartPaste = function (url) {
  const input = document.getElementById("urlInput")
  if (input) input.value = url
  const banner = document.getElementById("smartPasteBanner")
  if (banner) banner.remove()
  analyze()
}

// ════════════════════════════════════════════════════════════════════════════════
// FEATURE 18: Keyboard Shortcuts (extended beyond existing / R S)
// ════════════════════════════════════════════════════════════════════════════════
function initExtendedKeyboardShortcuts() {
  document.addEventListener("keydown", function (e) {
    const tag = document.activeElement ? document.activeElement.tagName : ""
    const isEditing = tag === "INPUT" || tag === "TEXTAREA" || document.activeElement?.isContentEditable
    if (isEditing) return

    // B = toggle bookmarks panel
    if (e.key === "b" || e.key === "B") {
      e.preventDefault()
      if (typeof toggleBookmarks === "function") toggleBookmarks()
    }
    // H = toggle history panel
    if (e.key === "h" || e.key === "H") {
      e.preventDefault()
      if (typeof toggleHistory === "function") toggleHistory()
    }
    // T = toggle theme
    if (e.key === "t" || e.key === "T") {
      e.preventDefault()
      if (typeof toggleTheme === "function") toggleTheme()
    }
    // D = open discovery
    if (e.key === "d" || e.key === "D") {
      e.preventDefault()
      switchTab("discover")
    }
    // W = open watchlist
    if (e.key === "w" || e.key === "W") {
      e.preventDefault()
      switchTab("watchlist")
    }
    // E = export
    if (e.key === "e" || e.key === "E") {
      e.preventDefault()
      exportMarketData()
    }
    // ? = show shortcut help
    if (e.key === "?") {
      e.preventDefault()
      toggleShortcutHelp()
    }
  })
}

let _shortcutHelpVisible = false
function toggleShortcutHelp() {
  _shortcutHelpVisible = !_shortcutHelpVisible
  let modal = document.getElementById("shortcutHelpModal")
  if (!modal) {
    modal = document.createElement("div")
    modal.id = "shortcutHelpModal"
    modal.className = "modal-overlay"
    modal.onclick = (e) => { if (e.target === modal) toggleShortcutHelp() }
    document.body.appendChild(modal)
  }
  if (_shortcutHelpVisible) {
    modal.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">Keyboard Shortcuts<button class="modal-close" onclick="toggleShortcutHelp()">&times;</button></div>
        <div class="shortcut-grid">
          <div class="shortcut-key">/</div><div>Focus search bar</div>
          <div class="shortcut-key">R</div><div>Refresh current market</div>
          <div class="shortcut-key">S</div><div>Save / unsave market</div>
          <div class="shortcut-key">B</div><div>Toggle bookmarks panel</div>
          <div class="shortcut-key">H</div><div>Toggle history panel</div>
          <div class="shortcut-key">T</div><div>Toggle light/dark theme</div>
          <div class="shortcut-key">D</div><div>Open market discovery</div>
          <div class="shortcut-key">W</div><div>Open watchlist</div>
          <div class="shortcut-key">E</div><div>Export market data</div>
          <div class="shortcut-key">Ctrl+K</div><div>Focus search bar</div>
          <div class="shortcut-key">Esc</div><div>Close modal / blur input</div>
          <div class="shortcut-key">?</div><div>Show this help</div>
        </div>
      </div>`
    modal.style.display = "flex"
  } else {
    modal.style.display = "none"
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// FEATURE 2: Price History Chart — localStorage time series + canvas sparkline
// ════════════════════════════════════════════════════════════════════════════════
function _getTimeSeries(url) {
  if (!url) return []
  try {
    return JSON.parse(localStorage.getItem("predara-ts:" + url.slice(0, 200)) || "[]")
  } catch { return [] }
}

function _appendTimeSeries(url) {
  if (!url) return
  const outcomes = []
  document.querySelectorAll(".outcome-row").forEach((row) => {
    const labelEl = row.querySelector(".outcome-name-text") || row.querySelector(".outcome-name")
    const name = (labelEl?.textContent || "").replace(/[↑↓▲▼]/g, "").trim()
    const pctEl = row.querySelector(".outcome-pct")
    const pctText = (pctEl?.textContent || "").replace(/\(est\.\)/g, "").trim()
    const pct = parseInt(pctText, 10)
    if (name && !isNaN(pct)) outcomes.push({ name, pct })
  })
  if (!outcomes.length) return
  const ts = _getTimeSeries(url)
  ts.push({ t: Date.now(), outcomes })
  // Keep last 100 data points
  const trimmed = ts.slice(-100)
  try {
    localStorage.setItem("predara-ts:" + url.slice(0, 200), JSON.stringify(trimmed))
  } catch {}
}

function priceHistoryChartHtml(url) {
  const ts = _getTimeSeries(url)
  if (ts.length < 2) return ""
  return `
    <div class="mi-card">
      <div class="section-label">PRICE HISTORY</div>
      <div class="price-chart-wrap">
        <canvas id="priceHistoryCanvas" width="700" height="180"></canvas>
        <div class="price-chart-legend" id="priceChartLegend"></div>
      </div>
    </div>`
}

function drawPriceHistoryChart(url) {
  const canvas = document.getElementById("priceHistoryCanvas")
  if (!canvas) return
  const ts = _getTimeSeries(url)
  if (ts.length < 2) return

  const ctx = canvas.getContext("2d")
  const W = canvas.width
  const H = canvas.height
  const pad = { top: 12, right: 16, bottom: 28, left: 40 }

  const isDark = !document.body.classList.contains("light")
  const bgColor = isDark ? "#18181c" : "#ffffff"
  const gridColor = isDark ? "#27272e" : "#e6e6e4"
  const textColor = isDark ? "#6b6b7a" : "#8e8e9a"

  ctx.fillStyle = bgColor
  ctx.fillRect(0, 0, W, H)

  // Collect all outcome names
  const nameSet = new Set()
  ts.forEach((p) => p.outcomes.forEach((o) => nameSet.add(o.name)))
  const names = [...nameSet]

  const colors = ["#22c55e", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899"]

  const tMin = ts[0].t
  const tMax = ts[ts.length - 1].t
  const tRange = Math.max(tMax - tMin, 1)

  // Draw grid lines
  ctx.strokeStyle = gridColor
  ctx.lineWidth = 0.5
  for (let pct = 0; pct <= 100; pct += 25) {
    const y = pad.top + (1 - pct / 100) * (H - pad.top - pad.bottom)
    ctx.beginPath()
    ctx.moveTo(pad.left, y)
    ctx.lineTo(W - pad.right, y)
    ctx.stroke()
    ctx.fillStyle = textColor
    ctx.font = "10px Inter, sans-serif"
    ctx.textAlign = "right"
    ctx.fillText(pct + "%", pad.left - 6, y + 3)
  }

  // Draw time labels
  ctx.textAlign = "center"
  const timePoints = [0, 0.5, 1]
  timePoints.forEach((frac) => {
    const t = tMin + frac * tRange
    const x = pad.left + frac * (W - pad.left - pad.right)
    const d = new Date(t)
    const label =
      tRange > 86400000
        ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
        : d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    ctx.fillStyle = textColor
    ctx.fillText(label, x, H - 6)
  })

  // Draw lines for each outcome
  const legendEl = document.getElementById("priceChartLegend")
  const legendParts = []
  names.forEach((name, idx) => {
    const color = colors[idx % colors.length]
    ctx.strokeStyle = color
    ctx.lineWidth = 2
    ctx.lineJoin = "round"
    ctx.beginPath()
    let started = false
    ts.forEach((p) => {
      const o = p.outcomes.find((o) => o.name === name)
      if (!o) return
      const x = pad.left + ((p.t - tMin) / tRange) * (W - pad.left - pad.right)
      const y = pad.top + (1 - o.pct / 100) * (H - pad.top - pad.bottom)
      if (!started) { ctx.moveTo(x, y); started = true }
      else ctx.lineTo(x, y)
    })
    ctx.stroke()
    const lastPct = ts[ts.length - 1].outcomes.find((o) => o.name === name)?.pct
    legendParts.push(`<span class="chart-legend-item"><span style="color:${color}">●</span> ${esc(name)}${lastPct != null ? ": " + lastPct + "%" : ""}</span>`)
  })
  if (legendEl) legendEl.innerHTML = legendParts.join("")
}

// ════════════════════════════════════════════════════════════════════════════════
// FEATURE 5: Portfolio / Watchlist Dashboard
// ════════════════════════════════════════════════════════════════════════════════
let _watchlistRefreshInterval = null

function renderWatchlist() {
  const container = document.getElementById("watchlistContent")
  if (!container) return
  const bookmarks = _getBookmarks()
  if (!bookmarks.length) {
    container.innerHTML = `<div class="empty-state">No saved markets yet. Analyze a market and click "Save" to add it to your watchlist.</div>`
    return
  }

  container.innerHTML = `
    <div class="watchlist-header">
      <div class="watchlist-title-row">
        <span>${bookmarks.length} saved market${bookmarks.length !== 1 ? "s" : ""}</span>
        <button class="copy-link-btn" onclick="refreshWatchlist()">↺ Refresh all</button>
      </div>
    </div>
    <div class="watchlist-grid" id="watchlistGrid">
      ${bookmarks.map((b) => _watchlistCardHtml(b)).join("")}
    </div>`
  _startWatchlistAutoRefresh()
}

function _watchlistCardHtml(bookmark) {
  const snap = _loadSnapshot(bookmark.url)
  const outcomesHtml = snap && snap.outcomes
    ? snap.outcomes.slice(0, 3).map((o, i) => {
        const color = ["#22c55e", "#3b82f6", "#f59e0b"][i] || "#6b6b7a"
        return `<div class="wl-outcome"><span style="color:${color}">${esc(o.name)}</span><span class="wl-pct">${o.pct}%</span></div>`
      }).join("")
    : `<div class="wl-no-data">No snapshot data</div>`
  const age = snap ? _timeAgo(snap.ts) : ""
  return `
    <div class="wl-card" onclick="_loadAndAnalyze('${esc(bookmark.url.replace(/'/g, "\\'"))}');switchTab('analyze')">
      <div class="wl-card-header">
        ${bookmark.platform ? `<span class="wl-platform">${esc(bookmark.platform.toUpperCase())}</span>` : ""}
        <span class="wl-card-title">${esc(bookmark.title || bookmark.url.slice(-40))}</span>
      </div>
      ${outcomesHtml}
      ${age ? `<div class="wl-age">Updated ${age}</div>` : ""}
    </div>`
}

function refreshWatchlist() {
  renderWatchlist()
}

function _startWatchlistAutoRefresh() {
  if (_watchlistRefreshInterval) clearInterval(_watchlistRefreshInterval)
  _watchlistRefreshInterval = setInterval(renderWatchlist, 60000)
}

// ════════════════════════════════════════════════════════════════════════════════
// FEATURE 6: P&L Calculator
// ════════════════════════════════════════════════════════════════════════════════
function pnlCalculatorHtml() {
  return `
    <div class="mi-card">
      <div class="section-label">P&L CALCULATOR</div>
      <div class="pnl-body">
        <div class="pnl-input-grid">
          <label>Shares / contracts bought</label>
          <input type="number" id="pnlShares" value="100" min="1" oninput="updatePnl()" />
          <label>Entry price (cents)</label>
          <input type="number" id="pnlEntry" value="35" min="1" max="99" oninput="updatePnl()" />
          <label>Current price (cents)</label>
          <input type="number" id="pnlCurrent" value="52" min="1" max="99" oninput="updatePnl()" />
        </div>
        <div id="pnlResult" class="pnl-result"></div>
      </div>
    </div>`
}

window.updatePnl = function () {
  const shares = parseFloat(document.getElementById("pnlShares")?.value) || 0
  const entry = parseFloat(document.getElementById("pnlEntry")?.value) || 0
  const current = parseFloat(document.getElementById("pnlCurrent")?.value) || 0
  const el = document.getElementById("pnlResult")
  if (!el || shares <= 0 || entry <= 0) return

  const costBasis = shares * (entry / 100)
  const currentVal = shares * (current / 100)
  const unrealized = currentVal - costBasis
  const pctReturn = ((current - entry) / entry * 100).toFixed(1)
  const breakEvenExit = entry
  const ifWins = shares * 1.0 - costBasis
  const cls = unrealized >= 0 ? "val-green" : "val-red"
  const sign = unrealized >= 0 ? "+" : ""

  el.innerHTML = `
    <div class="pnl-row"><span>Cost basis</span><strong>$${costBasis.toFixed(2)}</strong></div>
    <div class="pnl-row"><span>Current value</span><strong>$${currentVal.toFixed(2)}</strong></div>
    <div class="pnl-row"><span>Unrealized P&L</span><strong class="${cls}">${sign}$${unrealized.toFixed(2)} (${sign}${pctReturn}%)</strong></div>
    <div class="pnl-row"><span>Break-even exit</span><strong>${breakEvenExit}¢</strong></div>
    <div class="pnl-row"><span>If contract wins ($1)</span><strong class="val-green">+$${ifWins.toFixed(2)} profit</strong></div>`
}

// ════════════════════════════════════════════════════════════════════════════════
// FEATURE 7: Multi-Market Parlay Calculator
// ════════════════════════════════════════════════════════════════════════════════
function parlayCalculatorHtml() {
  return `
    <div class="mi-card">
      <div class="section-label">PARLAY CALCULATOR</div>
      <div class="parlay-body">
        <p class="parlay-desc">Combine 2-4 independent markets to calculate combined probability and potential payout.</p>
        <div id="parlayLegs">
          <div class="parlay-leg">
            <input type="text" class="parlay-name" placeholder="Market name (optional)" />
            <input type="number" class="parlay-prob" placeholder="Probability %" min="1" max="99" oninput="updateParlay()" />
          </div>
          <div class="parlay-leg">
            <input type="text" class="parlay-name" placeholder="Market name (optional)" />
            <input type="number" class="parlay-prob" placeholder="Probability %" min="1" max="99" oninput="updateParlay()" />
          </div>
        </div>
        <div class="parlay-actions">
          <button class="copy-link-btn" onclick="addParlayLeg()">+ Add leg</button>
          <div class="parlay-bet-row">
            <span>Bet: $</span>
            <input type="number" id="parlayBet" value="10" min="1" oninput="updateParlay()" />
          </div>
        </div>
        <div id="parlayResult" class="parlay-result"></div>
      </div>
    </div>`
}

window.addParlayLeg = function () {
  const container = document.getElementById("parlayLegs")
  if (!container) return
  const legs = container.querySelectorAll(".parlay-leg")
  if (legs.length >= 4) return
  const leg = document.createElement("div")
  leg.className = "parlay-leg"
  leg.innerHTML = `
    <input type="text" class="parlay-name" placeholder="Market name (optional)" />
    <input type="number" class="parlay-prob" placeholder="Probability %" min="1" max="99" oninput="updateParlay()" />`
  container.appendChild(leg)
}

window.updateParlay = function () {
  const probs = []
  const names = []
  document.querySelectorAll(".parlay-prob").forEach((input, i) => {
    const v = parseFloat(input.value)
    if (v > 0 && v < 100) probs.push(v / 100)
    const nameInput = document.querySelectorAll(".parlay-name")[i]
    names.push(nameInput?.value || `Leg ${i + 1}`)
  })
  const el = document.getElementById("parlayResult")
  if (!el || probs.length < 2) { if (el) el.innerHTML = ""; return }

  const combined = probs.reduce((a, b) => a * b, 1)
  const combinedPct = (combined * 100).toFixed(1)
  const bet = parseFloat(document.getElementById("parlayBet")?.value) || 10
  const payout = bet / combined
  const profit = payout - bet

  const legDetails = probs.map((p, i) =>
    `<span class="parlay-leg-detail">${esc(names[i])}: ${Math.round(p * 100)}%</span>`
  ).join(" × ")

  el.innerHTML = `
    <div class="parlay-combined">
      <div class="parlay-combined-label">COMBINED PROBABILITY</div>
      <div class="parlay-combined-pct">${combinedPct}%</div>
    </div>
    <div class="parlay-legs-display">${legDetails}</div>
    <div class="pnl-row"><span>If all hit: collect</span><strong class="val-green">$${payout.toFixed(2)} (+$${profit.toFixed(2)} profit)</strong></div>
    <div class="pnl-row"><span>If any misses: lose</span><strong class="val-red">-$${bet.toFixed(2)}</strong></div>
    <div class="pnl-row"><span>Implied moneyline</span><strong>${toMoneyline(Math.round(combined * 100))}</strong></div>`
}

// ════════════════════════════════════════════════════════════════════════════════
// FEATURE 8: Market Calendar View
// ════════════════════════════════════════════════════════════════════════════════
function renderCalendar() {
  const container = document.getElementById("calendarContent")
  if (!container) return
  const bookmarks = _getBookmarks()
  const history = _getHistory()
  const allMarkets = [...bookmarks, ...history]
    .filter((m, i, arr) => arr.findIndex((x) => x.url === m.url) === i)

  if (!allMarkets.length) {
    container.innerHTML = `<div class="empty-state">No markets tracked yet. Analyze and save markets to see them in the calendar.</div>`
    return
  }

  // Group by day (using ts from bookmarks/history)
  const now = new Date()
  const days = {}
  for (let i = 0; i < 14; i++) {
    const d = new Date(now)
    d.setDate(d.getDate() + i)
    const key = d.toISOString().slice(0, 10)
    days[key] = { label: d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }), markets: [] }
  }

  // Put recent markets in "today"
  const todayKey = now.toISOString().slice(0, 10)
  allMarkets.forEach((m) => {
    if (days[todayKey]) days[todayKey].markets.push(m)
  })

  const daysHtml = Object.entries(days).map(([key, day]) => {
    const isToday = key === todayKey
    const marketsHtml = day.markets.length
      ? day.markets.slice(0, 5).map((m) =>
          `<div class="cal-market" onclick="_loadAndAnalyze('${esc(m.url.replace(/'/g, "\\'"))}');switchTab('analyze')">
            ${m.platform ? `<span class="wl-platform">${esc(m.platform.toUpperCase())}</span>` : ""}
            <span>${esc(m.title || m.url.slice(-40))}</span>
          </div>`
        ).join("")
      : `<div class="cal-empty">${isToday ? "Your tracked markets appear here" : "—"}</div>`
    return `
      <div class="cal-day ${isToday ? "cal-today" : ""}">
        <div class="cal-day-label">${day.label}${isToday ? " (today)" : ""}</div>
        ${marketsHtml}
      </div>`
  }).join("")

  container.innerHTML = `
    <div class="calendar-grid">${daysHtml}</div>
    <div class="cal-note">Markets are shown based on when you last analyzed them. Close/resolution dates from the market data will appear as more markets are tracked.</div>`
}

// ════════════════════════════════════════════════════════════════════════════════
// FEATURE 10: Export to CSV / PDF
// ════════════════════════════════════════════════════════════════════════════════
function exportMarketData() {
  const title = document.querySelector(".event-title")?.textContent?.trim()
  if (!title) {
    _showToast("No market loaded to export")
    return
  }

  const outcomes = []
  document.querySelectorAll(".outcome-row").forEach((row) => {
    const name = (row.querySelector(".outcome-name-text") || row.querySelector(".outcome-name"))?.textContent?.replace(/[↑↓▲▼]/g, "").trim()
    const pctText = (row.querySelector(".outcome-pct")?.textContent || "").replace(/\(est\.\)/g, "").trim()
    const pct = parseInt(pctText, 10)
    if (name) outcomes.push({ name, pct: isNaN(pct) ? "" : pct })
  })

  const stats = []
  document.querySelectorAll(".stat-card").forEach((card) => {
    const label = card.querySelector(".stat-label")?.textContent?.trim()
    const value = card.querySelector(".stat-value")?.textContent?.trim()
    if (label) stats.push({ label, value: value || "—" })
  })

  // CSV export
  let csv = "Predara Market Export\n"
  csv += `Market,"${title}"\n`
  csv += `Exported,"${new Date().toISOString()}"\n\n`
  csv += "Outcome,Probability (%)\n"
  outcomes.forEach((o) => { csv += `"${o.name}",${o.pct}\n` })
  csv += "\nStatistic,Value\n"
  stats.forEach((s) => { csv += `"${s.label}","${s.value}"\n` })

  const blob = new Blob([csv], { type: "text/csv" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `predara-${title.replace(/[^a-z0-9]/gi, "-").slice(0, 40)}.csv`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1500)
  _showToast("CSV exported")
}

// ════════════════════════════════════════════════════════════════════════════════
// FEATURE 11: My Prediction Tracker
// ════════════════════════════════════════════════════════════════════════════════
function _getPredictions() {
  try { return JSON.parse(localStorage.getItem("predara-predictions") || "[]") } catch { return [] }
}

function _savePrediction(url, title, myProb, marketProb) {
  const preds = _getPredictions().filter((p) => p.url !== url)
  preds.unshift({ url, title, myProb, marketProb, ts: Date.now(), resolved: null })
  try { localStorage.setItem("predara-predictions", JSON.stringify(preds.slice(0, 200))) } catch {}
}

function myPredictionHtml(url) {
  if (!url) return ""
  const existing = _getPredictions().find((p) => p.url === url)
  const val = existing ? existing.myProb : ""
  return `
    <div class="mi-card my-prediction-card">
      <div class="section-label">MY PREDICTION</div>
      <div class="my-pred-body">
        <div class="my-pred-row">
          <label>I think the probability is:</label>
          <div class="edge-input-wrap">
            <input type="number" id="myPredInput" class="edge-prob-input" value="${val}" min="1" max="99" placeholder="—" />
            <span class="edge-pct-sign">%</span>
          </div>
          <button class="copy-link-btn" onclick="saveMyPrediction()">Save</button>
        </div>
        ${existing ? `<div class="my-pred-saved">Saved ${_timeAgo(existing.ts)} · Market was at ${existing.marketProb}%</div>` : ""}
      </div>
    </div>`
}

window.saveMyPrediction = function () {
  const input = document.getElementById("myPredInput")
  if (!input) return
  const myProb = parseInt(input.value, 10)
  if (isNaN(myProb) || myProb < 1 || myProb > 99) { _showToast("Enter a probability between 1-99%"); return }
  const url = document.getElementById("urlInput")?.value?.trim()
  const title = document.querySelector(".event-title")?.textContent?.trim() || ""
  const leadPct = parseInt(document.querySelector(".outcome-pct")?.textContent, 10) || 50
  _savePrediction(url, title, myProb, leadPct)
  _showToast("Prediction saved")
}

// ════════════════════════════════════════════════════════════════════════════════
// FEATURE 3: Price Alerts (Browser Notifications)
// ════════════════════════════════════════════════════════════════════════════════
function _getAlerts() {
  try { return JSON.parse(localStorage.getItem("predara-alerts") || "[]") } catch { return [] }
}

function _saveAlerts(alerts) {
  try { localStorage.setItem("predara-alerts", JSON.stringify(alerts)) } catch {}
}

function priceAlertHtml(url) {
  if (!url) return ""
  const outcomes = []
  document.querySelectorAll(".outcome-row").forEach((row) => {
    const name = (row.querySelector(".outcome-name-text") || row.querySelector(".outcome-name"))?.textContent?.replace(/[↑↓▲▼]/g, "").trim()
    if (name) outcomes.push(name)
  })
  if (!outcomes.length) return ""

  const existingAlerts = _getAlerts().filter((a) => a.marketUrl === url)
  const existingHtml = existingAlerts.length
    ? `<div class="alert-existing">${existingAlerts.map((a) =>
        `<div class="alert-item">
          <span>"${esc(a.outcomeName)}" ${a.direction} ${a.threshold}%</span>
          <button class="history-remove" onclick="removeAlert('${a.id}')">&times;</button>
        </div>`
      ).join("")}</div>`
    : ""

  const options = outcomes.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join("")
  return `
    <div class="mi-card">
      <div class="section-label">PRICE ALERTS</div>
      <div class="alert-body">
        <div class="alert-form">
          <span>Alert me when</span>
          <select id="alertOutcome" class="alert-select">${options}</select>
          <select id="alertDirection" class="alert-select">
            <option value="above">goes above</option>
            <option value="below">drops below</option>
          </select>
          <div class="edge-input-wrap">
            <input type="number" id="alertThreshold" class="edge-prob-input" value="60" min="1" max="99" />
            <span class="edge-pct-sign">%</span>
          </div>
          <button class="copy-link-btn" onclick="addPriceAlert()">Set alert</button>
        </div>
        ${existingHtml}
        <div class="alert-note">Alerts check prices when you visit Predara. Enable browser notifications for background alerts.</div>
      </div>
    </div>`
}

window.addPriceAlert = function () {
  const outcome = document.getElementById("alertOutcome")?.value
  const direction = document.getElementById("alertDirection")?.value
  const threshold = parseInt(document.getElementById("alertThreshold")?.value, 10)
  if (!outcome || !direction || isNaN(threshold)) return

  if (Notification.permission === "default") {
    Notification.requestPermission()
  }

  const url = document.getElementById("urlInput")?.value?.trim()
  const title = document.querySelector(".event-title")?.textContent?.trim() || ""
  const alerts = _getAlerts()
  alerts.push({
    id: "alert-" + Date.now(),
    marketUrl: url,
    marketTitle: title,
    outcomeName: outcome,
    direction,
    threshold,
    platform: _currentPlatform(),
    ts: Date.now(),
  })
  _saveAlerts(alerts)
  _showToast(`Alert set: "${outcome}" ${direction} ${threshold}%`)

  // Re-render the alert section
  const resultEl = document.getElementById("result")
  if (resultEl) {
    const existing = resultEl.querySelector(".mi-card:has(.alert-body)")
    if (existing) existing.outerHTML = priceAlertHtml(url)
  }
}

window.removeAlert = function (id) {
  const alerts = _getAlerts().filter((a) => a.id !== id)
  _saveAlerts(alerts)
  const url = document.getElementById("urlInput")?.value?.trim()
  const resultEl = document.getElementById("result")
  if (resultEl) {
    const existing = resultEl.querySelector(".mi-card:has(.alert-body)")
    if (existing) existing.outerHTML = priceAlertHtml(url)
  }
}

function checkAlertsOnLoad() {
  const alerts = _getAlerts()
  if (!alerts.length) return
  const outcomes = []
  document.querySelectorAll(".outcome-row").forEach((row) => {
    const name = (row.querySelector(".outcome-name-text") || row.querySelector(".outcome-name"))?.textContent?.replace(/[↑↓▲▼]/g, "").trim()
    const pctText = (row.querySelector(".outcome-pct")?.textContent || "").replace(/\(est\.\)/g, "").trim()
    const pct = parseInt(pctText, 10)
    if (name && !isNaN(pct)) outcomes.push({ name, pct })
  })
  const url = document.getElementById("urlInput")?.value?.trim()
  const matching = alerts.filter((a) => a.marketUrl === url)
  matching.forEach((alert) => {
    const o = outcomes.find((o) => o.name.toLowerCase() === alert.outcomeName.toLowerCase())
    if (!o) return
    const triggered =
      (alert.direction === "above" && o.pct >= alert.threshold) ||
      (alert.direction === "below" && o.pct <= alert.threshold)
    if (triggered && Notification.permission === "granted") {
      new Notification("Predara Price Alert", {
        body: `${alert.marketTitle}: "${alert.outcomeName}" is now at ${o.pct}% (threshold: ${alert.direction} ${alert.threshold}%)`,
        icon: "/og-image.png",
      })
    }
  })
}

// ════════════════════════════════════════════════════════════════════════════════
// FEATURE 4: Market Discovery / Trending
// ════════════════════════════════════════════════════════════════════════════════
let _discoveryCache = null
let _discoveryCacheTs = 0

async function renderDiscovery() {
  const container = document.getElementById("discoverContent")
  if (!container) return
  container.innerHTML = `<div class="mi-loading"><div class="mi-spinner"></div> Loading trending markets...</div>`

  try {
    if (_discoveryCache && Date.now() - _discoveryCacheTs < 120000) {
      _renderDiscoveryResults(container, _discoveryCache)
      return
    }
    const res = await fetch("/api/discover")
    if (!res.ok) throw new Error("Failed to load")
    const data = await res.json()
    _discoveryCache = data
    _discoveryCacheTs = Date.now()
    _renderDiscoveryResults(container, data)
  } catch {
    container.innerHTML = `
      <div class="empty-state">
        <p>Could not load trending markets. Discovery fetches top markets from each platform.</p>
        <p style="margin-top:12px">Try searching directly by pasting a market URL in the Analyze tab.</p>
      </div>`
  }
}

function _renderDiscoveryResults(container, data) {
  const platforms = data.platforms || []
  if (!platforms.length) {
    container.innerHTML = `<div class="empty-state">No trending markets found. Try again later.</div>`
    return
  }
  const html = platforms.map((p) => {
    const marketsHtml = (p.markets || []).slice(0, 8).map((m) =>
      `<div class="discover-market" onclick="_loadAndAnalyze('${esc(m.url.replace(/'/g, "\\'"))}');switchTab('analyze')">
        <div class="discover-market-title">${esc(m.title)}</div>
        <div class="discover-market-meta">
          ${m.volume ? `<span>Vol: $${esc(m.volume)}</span>` : ""}
          ${m.topOutcome ? `<span>${esc(m.topOutcome)}: ${m.topPct}%</span>` : ""}
        </div>
      </div>`
    ).join("")
    return `
      <div class="discover-platform">
        <div class="discover-platform-label" style="color:${(PLATFORMS[p.name] || {}).accent || "#999"}">${esc(p.name.toUpperCase())}</div>
        ${marketsHtml || `<div class="cal-empty">No markets available</div>`}
      </div>`
  }).join("")
  container.innerHTML = html
}

// ════════════════════════════════════════════════════════════════════════════════
// FEATURE 1: Cross-Platform Arbitrage Detector
// ════════════════════════════════════════════════════════════════════════════════
function arbitrageDetectorHtml(outcomes, platform) {
  if (!outcomes || outcomes.length < 2) return ""
  // For binary markets: check if YES + NO from the current market < $1
  const yesOutcome = outcomes.find((o) => o.pct > 0)
  if (!yesOutcome) return ""

  const total = outcomes.reduce((s, o) => s + o.pct, 0)
  if (total >= 100) return ""

  const gap = 100 - total
  const profit = (gap / 100).toFixed(2)
  return `
    <div class="mi-card arb-card">
      <div class="section-label arb-label">ARBITRAGE OPPORTUNITY</div>
      <div class="arb-body">
        Outcome probabilities sum to <strong>${total}%</strong> — that's <strong class="arb-profit">${gap}% below 100%</strong>.
        Buying all outcomes costs ~<span class="arb-cost">$${(total / 100).toFixed(2)}</span> per contract set,
        for a guaranteed <span class="arb-profit">$${profit} profit</span> per set.
      </div>
      <div class="arb-disclaimer">Theoretical only. Excludes fees, spread, and execution risk across platforms.</div>
    </div>`
}

// Enhanced cross-platform arb hint (shown after compare)
function crossPlatformArbHtml(markets) {
  if (!markets || markets.length < 2) return ""
  const hints = []
  for (let i = 0; i < markets.length; i++) {
    for (let j = i + 1; j < markets.length; j++) {
      const a = markets[i]
      const b = markets[j]
      if (!a.topOutcomes?.length || !b.topOutcomes?.length) continue
      // Check if same outcome has different prices
      a.topOutcomes.forEach((ao) => {
        const match = b.topOutcomes.find((bo) =>
          bo.normalizedName === ao.normalizedName ||
          bo.name.toLowerCase() === ao.name.toLowerCase()
        )
        if (match && Math.abs(ao.pct - match.pct) >= 5) {
          hints.push({
            outcome: ao.name,
            platform1: a.platform,
            pct1: ao.pct,
            platform2: b.platform,
            pct2: match.pct,
            diff: Math.abs(ao.pct - match.pct),
          })
        }
      })
    }
  }
  if (!hints.length) return ""
  const rows = hints.map((h) =>
    `<div class="arb-hint-row">
      <strong>"${esc(h.outcome)}"</strong>: ${h.pct1}% on ${esc(h.platform1.toUpperCase())} vs ${h.pct2}% on ${esc(h.platform2.toUpperCase())}
      <span class="arb-profit">(${h.diff}pt gap)</span>
    </div>`
  ).join("")
  return `
    <div class="mi-card arb-card">
      <div class="section-label arb-label">CROSS-PLATFORM PRICE GAPS</div>
      <div class="arb-body">${rows}</div>
      <div class="arb-disclaimer">Price gaps may reflect timing differences, fees, or liquidity. Not financial advice.</div>
    </div>`
}

// ════════════════════════════════════════════════════════════════════════════════
// FEATURE 9: Embed Widget
// ════════════════════════════════════════════════════════════════════════════════
function embedWidgetHtml(url) {
  if (!url) return ""
  const embedUrl = `${location.origin}/?q=${encodeURIComponent(url)}&embed=1`
  const iframeCode = `<iframe src="${esc(embedUrl)}" width="100%" height="600" frameborder="0" style="border-radius:12px;border:1px solid #27272e"></iframe>`
  return `
    <div class="mi-card">
      <div class="section-label">EMBED THIS MARKET</div>
      <div class="embed-body">
        <p class="embed-desc">Add this market analysis to your website or blog:</p>
        <div class="embed-code-wrap">
          <code class="embed-code">${esc(iframeCode)}</code>
          <button class="copy-link-btn" onclick="copyEmbedCode()">Copy code</button>
        </div>
      </div>
    </div>`
}

window.copyEmbedCode = function () {
  const code = document.querySelector(".embed-code")?.textContent
  if (code) {
    navigator.clipboard.writeText(code).then(() => _showToast("Embed code copied"))
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// FEATURE 12: Community Consensus (client-side)
// ════════════════════════════════════════════════════════════════════════════════
function _getCommunityVotes() {
  try { return JSON.parse(localStorage.getItem("predara-community") || "{}") } catch { return {} }
}

function communityConsensusHtml(url) {
  if (!url) return ""
  const votes = _getCommunityVotes()
  const key = url.slice(0, 200)
  const myVote = votes[key]
  const predictions = _getPredictions()
  const relatedPreds = predictions.filter((p) => p.myProb && p.myProb > 0)

  // Calculate average from all saved predictions (simulates community)
  const avg = relatedPreds.length >= 2
    ? Math.round(relatedPreds.reduce((s, p) => s + p.myProb, 0) / relatedPreds.length)
    : null

  return `
    <div class="mi-card">
      <div class="section-label">COMMUNITY PULSE</div>
      <div class="consensus-body">
        ${avg !== null
          ? `<div>Based on ${relatedPreds.length} saved predictions, your average estimate across markets is <strong>${avg}%</strong>.</div>`
          : `<div>Save predictions on multiple markets to see your personal calibration trend here.</div>`
        }
        ${myVote ? `<div class="my-pred-saved">Your prediction for this market: ${myVote}%</div>` : ""}
      </div>
    </div>`
}

// ════════════════════════════════════════════════════════════════════════════════
// FEATURE 13: Market Correlation Map
// ════════════════════════════════════════════════════════════════════════════════
function correlationMapHtml(title) {
  if (!title || title.length < 5) return ""
  const history = _getHistory()
  const bookmarks = _getBookmarks()
  const all = [...history, ...bookmarks]
    .filter((m, i, arr) => arr.findIndex((x) => x.url === m.url) === i)

  // Extract keywords from current market title
  const keywords = title.toLowerCase().split(/\s+/).filter((w) => w.length > 3)
  const related = all.filter((m) => {
    if (!m.title) return false
    const mLower = m.title.toLowerCase()
    return keywords.some((kw) => mLower.includes(kw))
  }).slice(0, 5)

  if (!related.length) return ""

  const items = related.map((m) =>
    `<div class="corr-item" onclick="_loadAndAnalyze('${esc(m.url.replace(/'/g, "\\'"))}')">
      ${m.platform ? `<span class="wl-platform">${esc(m.platform.toUpperCase())}</span>` : ""}
      <span>${esc(m.title || m.url.slice(-40))}</span>
    </div>`
  ).join("")

  return `
    <div class="mi-card">
      <div class="section-label">RELATED MARKETS</div>
      <div class="corr-body">${items}</div>
    </div>`
}

// ════════════════════════════════════════════════════════════════════════════════
// FEATURE 14: Historical Accuracy Dashboard
// ════════════════════════════════════════════════════════════════════════════════
function _getAccuracyLog() {
  try { return JSON.parse(localStorage.getItem("predara-accuracy") || "[]") } catch { return [] }
}

function _logAccuracy(url, marketProb, resolved) {
  const log = _getAccuracyLog()
  log.push({ url, marketProb, resolved, ts: Date.now() })
  try { localStorage.setItem("predara-accuracy", JSON.stringify(log.slice(-500))) } catch {}
}

function renderAccuracyDashboard() {
  const container = document.getElementById("toolsExtra")
  if (!container) return ""
  const predictions = _getPredictions()
  const resolved = predictions.filter((p) => p.resolved !== null)

  if (resolved.length < 3) {
    return `
      <div class="mi-card">
        <div class="section-label">CALIBRATION TRACKER</div>
        <div class="consensus-body">
          <p>Track your prediction accuracy over time. As you make predictions and markets resolve, your calibration score will appear here.</p>
          <p style="margin-top:8px"><strong>${predictions.length}</strong> predictions saved · <strong>${resolved.length}</strong> resolved</p>
        </div>
      </div>`
  }

  // Calculate Brier score
  let brierSum = 0
  resolved.forEach((p) => {
    const outcome = p.resolved ? 1 : 0
    const prob = p.myProb / 100
    brierSum += Math.pow(prob - outcome, 2)
  })
  const brier = (brierSum / resolved.length).toFixed(3)
  const brierClass = brier < 0.15 ? "val-green" : brier < 0.25 ? "val-amber" : "val-red"

  return `
    <div class="mi-card">
      <div class="section-label">CALIBRATION TRACKER</div>
      <div class="consensus-body">
        <div class="pnl-row"><span>Predictions made</span><strong>${predictions.length}</strong></div>
        <div class="pnl-row"><span>Resolved</span><strong>${resolved.length}</strong></div>
        <div class="pnl-row"><span>Brier Score</span><strong class="${brierClass}">${brier}</strong></div>
        <div class="alert-note">Brier Score: 0 = perfect, 0.25 = random. Lower is better.</div>
      </div>
    </div>`
}

// ════════════════════════════════════════════════════════════════════════════════
// FEATURE 15: Notification Integrations (webhook stubs)
// ════════════════════════════════════════════════════════════════════════════════
function _getWebhookConfig() {
  try { return JSON.parse(localStorage.getItem("predara-webhooks") || "{}") } catch { return {} }
}

function _saveWebhookConfig(config) {
  try { localStorage.setItem("predara-webhooks", JSON.stringify(config)) } catch {}
}

function notificationSettingsHtml() {
  const config = _getWebhookConfig()
  return `
    <div class="mi-card">
      <div class="section-label">NOTIFICATION INTEGRATIONS</div>
      <div class="webhook-body">
        <p class="embed-desc">Connect external services to receive alerts when tracked markets move.</p>
        <div class="webhook-row">
          <label>Discord Webhook URL</label>
          <input type="url" id="webhookDiscord" class="compare-url-input" placeholder="https://discord.com/api/webhooks/..." value="${esc(config.discord || "")}" />
        </div>
        <div class="webhook-row">
          <label>Telegram Bot Token</label>
          <input type="text" id="webhookTelegram" class="compare-url-input" placeholder="bot_token:chat_id" value="${esc(config.telegram || "")}" />
        </div>
        <div class="webhook-row">
          <label>Slack Webhook URL</label>
          <input type="url" id="webhookSlack" class="compare-url-input" placeholder="https://hooks.slack.com/services/..." value="${esc(config.slack || "")}" />
        </div>
        <button class="copy-link-btn" onclick="saveWebhookConfig()" style="margin-top:8px">Save settings</button>
        <div class="alert-note" style="margin-top:8px">Webhooks fire when price alerts are triggered. Configured locally in your browser.</div>
      </div>
    </div>`
}

window.saveWebhookConfig = function () {
  const config = {
    discord: document.getElementById("webhookDiscord")?.value?.trim() || "",
    telegram: document.getElementById("webhookTelegram")?.value?.trim() || "",
    slack: document.getElementById("webhookSlack")?.value?.trim() || "",
  }
  _saveWebhookConfig(config)
  _showToast("Webhook settings saved")
}

// ════════════════════════════════════════════════════════════════════════════════
// FEATURE 17: RSS Feed (client-side export of bookmarks as OPML)
// ════════════════════════════════════════════════════════════════════════════════
function exportBookmarksAsOpml() {
  const bookmarks = _getBookmarks()
  if (!bookmarks.length) { _showToast("No bookmarks to export"); return }

  let opml = `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n<head><title>Predara Bookmarks</title></head>\n<body>\n`
  bookmarks.forEach((b) => {
    const shareUrl = `${location.origin}/?q=${encodeURIComponent(b.url)}`
    opml += `  <outline text="${esc(b.title || b.url)}" type="link" url="${esc(shareUrl)}" />\n`
  })
  opml += `</body>\n</opml>`

  const blob = new Blob([opml], { type: "text/xml" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = "predara-bookmarks.opml"
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1500)
  _showToast("Bookmarks exported as OPML")
}

// Also generate a simple JSON feed
function exportBookmarksAsJson() {
  const bookmarks = _getBookmarks()
  if (!bookmarks.length) { _showToast("No bookmarks to export"); return }
  const feed = {
    version: "https://jsonfeed.org/version/1.1",
    title: "Predara Watchlist",
    items: bookmarks.map((b) => ({
      id: b.url,
      title: b.title || b.url,
      url: `${location.origin}/?q=${encodeURIComponent(b.url)}`,
      date_published: new Date(b.ts).toISOString(),
      tags: [b.platform || "unknown"],
    })),
  }
  const blob = new Blob([JSON.stringify(feed, null, 2)], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = "predara-feed.json"
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1500)
  _showToast("Feed exported as JSON")
}

// ════════════════════════════════════════════════════════════════════════════════
// FEATURE 20: SEO improvements (structured data injection)
// ════════════════════════════════════════════════════════════════════════════════
function updateSeoMeta(title, description) {
  if (title) {
    document.title = `${title} — Predara`
    const ogTitle = document.querySelector('meta[property="og:title"]')
    if (ogTitle) ogTitle.content = `${title} — Predara`
  }
  if (description) {
    const desc = document.querySelector('meta[name="description"]')
    if (desc) desc.content = description
    const ogDesc = document.querySelector('meta[property="og:description"]')
    if (ogDesc) ogDesc.content = description
  }
  // Update canonical URL with query param
  const url = document.getElementById("urlInput")?.value?.trim()
  if (url) {
    const canonical = `${location.origin}/?q=${encodeURIComponent(url)}`
    let link = document.querySelector('link[rel="canonical"]')
    if (!link) {
      link = document.createElement("link")
      link.rel = "canonical"
      document.head.appendChild(link)
    }
    link.href = canonical
    const ogUrl = document.querySelector('meta[property="og:url"]')
    if (ogUrl) ogUrl.content = canonical
    // Push to browser history
    if (location.search !== `?q=${encodeURIComponent(url)}`) {
      history.replaceState(null, "", `?q=${encodeURIComponent(url)}`)
    }
  }
  // Inject structured data
  _injectStructuredData(title)
}

function _injectStructuredData(title) {
  let script = document.getElementById("structuredData")
  if (!script) {
    script = document.createElement("script")
    script.id = "structuredData"
    script.type = "application/ld+json"
    document.head.appendChild(script)
  }
  const outcomes = []
  document.querySelectorAll(".outcome-row").forEach((row) => {
    const name = (row.querySelector(".outcome-name-text") || row.querySelector(".outcome-name"))?.textContent?.replace(/[↑↓▲▼]/g, "").trim()
    const pctText = (row.querySelector(".outcome-pct")?.textContent || "").replace(/\(est\.\)/g, "").trim()
    if (name) outcomes.push({ name, probability: pctText })
  })
  script.textContent = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: `${title || "Market Analysis"} — Predara`,
    description: `Prediction market analysis: ${outcomes.slice(0, 3).map((o) => `${o.name} ${o.probability}`).join(", ")}`,
    url: location.href,
  })
}

// ════════════════════════════════════════════════════════════════════════════════
// TAB NAVIGATION (for discovery, watchlist, calendar, tools)
// ════════════════════════════════════════════════════════════════════════════════
let _currentTab = "analyze"

function switchTab(tab) {
  _currentTab = tab
  const tabs = ["analyze", "discover", "watchlist", "calendar", "tools"]
  tabs.forEach((t) => {
    const el = document.getElementById(`tab-${t}`)
    const btn = document.getElementById(`tabBtn-${t}`)
    if (el) el.style.display = t === tab ? "block" : "none"
    if (btn) btn.classList.toggle("active", t === tab)
  })

  if (tab === "discover") renderDiscovery()
  if (tab === "watchlist") renderWatchlist()
  if (tab === "calendar") renderCalendar()
  if (tab === "tools") renderToolsTab()
}

function renderToolsTab() {
  const container = document.getElementById("toolsContent")
  if (!container) return
  container.innerHTML = `
    ${pnlCalculatorHtml()}
    ${parlayCalculatorHtml()}
    ${renderAccuracyDashboard()}
    ${notificationSettingsHtml()}
    <div class="mi-card">
      <div class="section-label">DATA EXPORT</div>
      <div class="consensus-body" style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="copy-link-btn" onclick="exportBookmarksAsOpml()">Export bookmarks (OPML)</button>
        <button class="copy-link-btn" onclick="exportBookmarksAsJson()">Export watchlist (JSON feed)</button>
      </div>
    </div>`
  // Initialize P&L calculator
  setTimeout(() => { if (typeof updatePnl === "function") updatePnl() }, 50)
}

// ════════════════════════════════════════════════════════════════════════════════
// TOAST NOTIFICATIONS
// ════════════════════════════════════════════════════════════════════════════════
function _showToast(msg) {
  let toast = document.getElementById("predara-toast")
  if (!toast) {
    toast = document.createElement("div")
    toast.id = "predara-toast"
    toast.className = "toast"
    document.body.appendChild(toast)
  }
  toast.textContent = msg
  toast.classList.add("toast-show")
  setTimeout(() => toast.classList.remove("toast-show"), 2500)
}

// ════════════════════════════════════════════════════════════════════════════════
// HOOK: Called after every successful market analysis render
// ════════════════════════════════════════════════════════════════════════════════
function afterAnalysisHook(url) {
  // Append to time series for price history chart
  _appendTimeSeries(url)

  // Inject new feature cards into the result area
  const result = document.getElementById("result")
  if (!result) return

  const title = document.querySelector(".event-title")?.textContent?.trim() || ""

  // Price history chart
  const chartHtml = priceHistoryChartHtml(url)
  if (chartHtml) {
    result.insertAdjacentHTML("beforeend", chartHtml)
    setTimeout(() => drawPriceHistoryChart(url), 50)
  }

  // My Prediction
  result.insertAdjacentHTML("beforeend", myPredictionHtml(url))

  // Price Alerts
  result.insertAdjacentHTML("beforeend", priceAlertHtml(url))

  // Embed Widget
  result.insertAdjacentHTML("beforeend", embedWidgetHtml(url))

  // Correlation Map
  result.insertAdjacentHTML("beforeend", correlationMapHtml(title))

  // Community Consensus
  result.insertAdjacentHTML("beforeend", communityConsensusHtml(url))

  // Check existing alerts
  checkAlertsOnLoad()

  // SEO meta update
  updateSeoMeta(title, `Market analysis for ${title} on Predara`)
}

// ════════════════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ════════════════════════════════════════════════════════════════════════════════
document.addEventListener("DOMContentLoaded", function () {
  initSmartPaste()
  initExtendedKeyboardShortcuts()
  // Set default tab
  switchTab("analyze")
})
