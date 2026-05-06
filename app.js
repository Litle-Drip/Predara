// ── Entry point ───────────────────────────────────────────────────────────────
// Depends on: utils.js, components.js, adapters.js, renderers.js, compare.js

// ── MLB game-link fetcher ─────────────────────────────────────────────────────
// Fetches the MLB schedule for a date, matches by team abbreviation, and injects
// a "Watch → MLB Gameday" link into the #sports-game-link-slot placeholder.
// Works for both Polymarket sports events and Gemini MLB ticker markets.
async function fetchAndInjectMlbLink(date, awayAbbr, homeAbbr) {
  try {
    if (!date || !awayAbbr || !homeAbbr) return
    const inputEl = document.getElementById("urlInput")
    const urlAtStart = inputEl ? inputEl.value.trim() : null
    const res = await fetch(`/api/mlb?date=${encodeURIComponent(date)}`)
    if (!res.ok) return
    const data = await res.json()
    if (!data.games || !data.games.length) return

    const aw = awayAbbr.toLowerCase()
    const hw = homeAbbr.toLowerCase()
    const game = data.games.find(g =>
      g.awayAbbr.toLowerCase() === aw && g.homeAbbr.toLowerCase() === hw
    ) || data.games.find(g =>
      g.homeAbbr.toLowerCase() === aw && g.awayAbbr.toLowerCase() === hw
    )
    if (!game || !game.gamePk) return

    const urlNow = inputEl ? inputEl.value.trim() : null
    if (urlAtStart !== urlNow) return

    const [yr, mo, dy] = date.split("-")
    const gameUrl = `https://www.mlb.com/gameday/${game.awaySlug}-vs-${game.homeSlug}/${yr}/${mo}/${dy}/${game.gamePk}/live`

    const slot = document.getElementById("sports-game-link-slot")
    if (slot) {
      slot.outerHTML = `<div class="info-row"><span class="info-key">Watch</span><span class="info-val"><a href="${gameUrl}" target="_blank" rel="noopener" style="color:var(--orange)">MLB Gameday ↗</a></span></div>`
    }
  } catch {}
}

// ── Feature 1: "What changed?" diff on refresh ────────────────────────────────
// Reads the pure outcome label text, stripping momentum arrows and other
// decorative glyphs injected inside .outcome-name.
function _outcomeNameText(row) {
  const labelEl = row.querySelector(".outcome-name-text") || row.querySelector(".outcome-name")
  return (labelEl?.textContent || "").replace(/[↑↓▲▼]/g, "").trim()
}

function _captureOutcomeSnapshot() {
  const url = document.getElementById("urlInput")?.value?.trim()
  if (!url) return null
  const outcomes = []
  document.querySelectorAll(".outcome-row").forEach(row => {
    const name = _outcomeNameText(row)
    const pctEl = row.querySelector(".outcome-pct")
    // Strip trailing "(est.)" suffix before parsing
    const pctText = (pctEl?.textContent || "").replace(/\(est\.\)/g, "").trim()
    const pct = parseInt(pctText, 10)
    if (name && !isNaN(pct)) outcomes.push({ name, pct })
  })
  return outcomes.length ? { ts: Date.now(), url, outcomes } : null
}

function _saveSnapshot(snap) {
  if (!snap) return
  try { localStorage.setItem("predara-snap:" + snap.url.slice(0, 200), JSON.stringify(snap)) } catch {}
}

function _loadSnapshot(url) {
  if (!url) return null
  try { return JSON.parse(localStorage.getItem("predara-snap:" + url.slice(0, 200))) || null } catch { return null }
}

function _timeAgo(ts) {
  const mins = Math.floor((Date.now() - ts) / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return mins + "m ago"
  return Math.floor(mins / 60) + "h ago"
}

function _showRefreshDiff(prevSnap) {
  if (!prevSnap || !prevSnap.outcomes) return
  const newOutcomes = []
  document.querySelectorAll(".outcome-row").forEach(row => {
    const name = _outcomeNameText(row)
    const pctEl = row.querySelector(".outcome-pct")
    const pctText = (pctEl?.textContent || "").replace(/\(est\.\)/g, "").trim()
    const pct = parseInt(pctText, 10)
    if (name && !isNaN(pct)) newOutcomes.push({ name, pct })
  })
  if (!newOutcomes.length) return

  const oldMap = {}
  prevSnap.outcomes.forEach(o => { oldMap[o.name] = o.pct })
  const changes = []
  newOutcomes.forEach(o => {
    const old = oldMap[o.name]
    if (old != null && old !== o.pct) {
      const diff = o.pct - old
      changes.push(`<span class="diff-item-name">${esc(o.name)}</span>: ${old}% → <strong>${o.pct}%</strong> <span class="${diff > 0 ? "diff-up" : "diff-dn"}">(${diff > 0 ? "+" : ""}${diff} pts)</span>`)
    }
  })

  const banner = document.createElement("div")
  const ageText = _timeAgo(prevSnap.ts)
  if (changes.length) {
    banner.className = "diff-banner diff-has-change"
    banner.innerHTML = `<span class="diff-banner-title">↺ WHAT CHANGED · since ${ageText}</span><div class="diff-changes">${changes.map(c => `<div class="diff-change-item">${c}</div>`).join("")}</div>`
  } else {
    banner.className = "diff-banner diff-no-change"
    banner.innerHTML = `<span>↺ No price changes since ${ageText}</span>`
  }
  const result = document.getElementById("result")
  if (result?.firstChild) result.insertBefore(banner, result.firstChild)
}

// ── Analysis history ──────────────────────────────────────────────────────────
function _getHistory() {
  try { return JSON.parse(localStorage.getItem("predara-history") || "[]") } catch { return [] }
}
function _logHistory(url, title, platform) {
  if (!url) return
  const hist = _getHistory().filter(h => h.url !== url)
  hist.unshift({ url, title: title || "", platform: platform || "", ts: Date.now() })
  try { localStorage.setItem("predara-history", JSON.stringify(hist.slice(0, 50))) } catch {}
  _renderHistoryPanel()
}
function _renderHistoryPanel() {
  const panel = document.getElementById("historyPanel")
  if (!panel) return
  const hist = _getHistory()
  if (!hist.length) { panel.innerHTML = `<div class="history-empty">No recent markets yet</div>`; return }
  panel.innerHTML = hist.slice(0, 12).map(h => `
    <div class="history-item" data-url="${esc(h.url)}" onclick="_loadAndAnalyze(this.dataset.url)">
      ${h.platform ? `<span class="history-platform">${esc(h.platform.toUpperCase())}</span>` : ""}
      <span class="history-title">${esc(h.title || h.url.slice(-40))}</span>
      <span class="history-time">${_timeAgo(h.ts)}</span>
    </div>`).join("")
}
let _historyOpen = false
function toggleHistory() {
  // Close bookmarks panel if open
  if (_bookmarksOpen) {
    _bookmarksOpen = false
    const bp = document.getElementById("bookmarksPanel")
    const bb = document.getElementById("bookmarksToggleBtn")
    if (bp) bp.style.display = "none"
    if (bb) bb.classList.remove("active")
  }
  _historyOpen = !_historyOpen
  const panel = document.getElementById("historyPanel")
  const btn   = document.getElementById("historyBtn")
  if (!panel) return
  if (_historyOpen) { _renderHistoryPanel(); panel.style.display = "block"; if (btn) btn.classList.add("active") }
  else              { panel.style.display = "none"; if (btn) btn.classList.remove("active") }
}

// ── Bookmarks ─────────────────────────────────────────────────────────────────
function _getBookmarks() {
  try { return JSON.parse(localStorage.getItem("predara-bookmarks") || "[]") } catch { return [] }
}
function _saveBookmark(url, title, platform) {
  if (!url) return
  const bms = _getBookmarks().filter(b => b.url !== url)
  bms.unshift({ url, title: title || "", platform: platform || "", ts: Date.now() })
  try { localStorage.setItem("predara-bookmarks", JSON.stringify(bms.slice(0, 100))) } catch {}
  _renderBookmarksPanel(); _refreshBookmarkBtn(url)
}
function _removeBookmark(url) {
  const bms = _getBookmarks().filter(b => b.url !== url)
  try { localStorage.setItem("predara-bookmarks", JSON.stringify(bms)) } catch {}
  _renderBookmarksPanel(); _refreshBookmarkBtn(url)
}
function _isBookmarked(url) { return _getBookmarks().some(b => b.url === url) }
function _refreshBookmarkBtn(url) {
  const btn = document.getElementById("bookmarkBtn")
  if (!btn) return
  const saved = url ? _isBookmarked(url) : false
  btn.textContent = saved ? "★ SAVED" : "☆ SAVE"
  btn.classList.toggle("bookmarked", saved)
  btn.onclick = () => saved ? _removeBookmark(url) : _saveBookmark(url, _currentTitle(), _currentPlatform())
}
function _renderBookmarksPanel() {
  const panel = document.getElementById("bookmarksPanel")
  if (!panel) return
  const bms = _getBookmarks()
  if (!bms.length) { panel.innerHTML = `<div class="history-empty">No saved markets yet</div>`; return }
  panel.innerHTML = bms.slice(0, 20).map(b => `
    <div class="history-item">
      ${b.platform ? `<span class="history-platform">${esc(b.platform.toUpperCase())}</span>` : ""}
      <span class="history-title" style="cursor:pointer" data-url="${esc(b.url)}" onclick="_loadAndAnalyze(this.dataset.url)">${esc(b.title || b.url.slice(-40))}</span>
      <button class="history-remove" data-url="${esc(b.url)}" onclick="_removeBookmark(this.dataset.url)" title="Remove">✕</button>
    </div>`).join("")
}
let _bookmarksOpen = false
function toggleBookmarks() {
  // Close history panel if open
  if (_historyOpen) {
    _historyOpen = false
    const hp = document.getElementById("historyPanel")
    const hb = document.getElementById("historyBtn")
    if (hp) hp.style.display = "none"
    if (hb) hb.classList.remove("active")
  }
  _bookmarksOpen = !_bookmarksOpen
  const panel = document.getElementById("bookmarksPanel")
  const btn   = document.getElementById("bookmarksToggleBtn")
  if (!panel) return
  if (_bookmarksOpen) { _renderBookmarksPanel(); panel.style.display = "block"; if (btn) btn.classList.add("active") }
  else                { panel.style.display = "none"; if (btn) btn.classList.remove("active") }
}
// Safe URL loader — used by history/bookmark onclick handlers via data-url attribute
// Avoids JSON.stringify double-quote injection in HTML attribute strings
function _loadAndAnalyze(url) {
  if (!url) return
  const inp = document.getElementById("urlInput")
  if (inp) inp.value = url
  _closeAllPanels()
  analyze()
}

function _closeAllPanels() {
  _historyOpen = false; _bookmarksOpen = false
  const hp = document.getElementById("historyPanel")
  const bp = document.getElementById("bookmarksPanel")
  const hb = document.getElementById("historyBtn")
  const bb = document.getElementById("bookmarksToggleBtn")
  if (hp) hp.style.display = "none"
  if (bp) bp.style.display = "none"
  if (hb) hb.classList.remove("active")
  if (bb) bb.classList.remove("active")
}

function _currentTitle() {
  return document.querySelector("#result .event-title")?.textContent?.trim() || ""
}
function _currentPlatform() {
  const lower = (document.getElementById("urlInput")?.value || "").toLowerCase()
  return lower.includes("kalshi") ? "kalshi" : lower.includes("polymarket") ? "polymarket"
    : lower.includes("coinbase") ? "coinbase" : lower.includes("gemini") ? "gemini" : ""
}

// ── Data freshness indicator ───────────────────────────────────────────────────
function _updateFreshnessDisplay() {
  const el = document.getElementById("fetchedAt")
  if (!el || !window._lastFetchedAt) return
  el.textContent = "Fetched " + _timeAgo(window._lastFetchedAt)
  el.style.display = "inline"
}

// ── Feature 7: Share card image generator ────────────────────────────────────
function _wrapText(ctx, text, maxWidth) {
  const words = text.split(" ")
  const lines = []
  let line = ""
  for (const word of words) {
    const test = line ? line + " " + word : word
    if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = word }
    else line = test
  }
  if (line) lines.push(line)
  return lines
}

function generateShareCard() {
  const titleEl = document.querySelector(".event-title")
  const title = titleEl?.textContent?.trim() || "Market Analysis"
  const platformEl = document.querySelector(".tag-platform")
  const platformLabel = platformEl?.textContent?.trim() || "PREDARA"
  const accentStyle = platformEl ? getComputedStyle(platformEl).backgroundColor : "#d94f20"
  const statsEl = document.querySelector(".stats-grid")
  const volumeText = statsEl?.querySelector('.stat-card .stat-label') ? "" : ""

  const outcomes = []
  document.querySelectorAll(".outcome-row").forEach(row => {
    const name = _outcomeNameText(row)
    const pctEl = row.querySelector(".outcome-pct")
    const pctText = (pctEl?.textContent || "").replace(/\(est\.\)/g, "").trim()
    const pct = parseInt(pctText, 10)
    const colorStr = row.querySelector(".outcome-name")?.style?.color || "#22c55e"
    if (name && !isNaN(pct)) outcomes.push({ name, pct, color: colorStr })
  })

  if (!outcomes.length) return

  const W = 1200, H = 630
  const canvas = document.createElement("canvas")
  canvas.width = W; canvas.height = H
  const ctx = canvas.getContext("2d")

  const isDark = !document.body.classList.contains("light")
  const bgColor   = isDark ? "#141210" : "#f5f3ee"
  const cardColor = isDark ? "#1d1c18" : "#ffffff"
  const textBright = isDark ? "#f2f0e6" : "#1a1916"
  const textMuted = isDark ? "#a09e8c" : "#7a7868"
  const borderColor = isDark ? "#2e2c26" : "#dddbd0"

  // Background
  ctx.fillStyle = bgColor
  ctx.fillRect(0, 0, W, H)

  // Top accent bar
  ctx.fillStyle = accentStyle
  ctx.fillRect(0, 0, W, 5)

  // Platform badge
  ctx.font = "bold 13px 'Courier New', monospace"
  const badgeW = ctx.measureText(platformLabel).width + 32
  ctx.fillStyle = accentStyle
  ctx.beginPath()
  ctx.roundRect(56, 52, badgeW, 28, 3)
  ctx.fill()
  ctx.fillStyle = "#ffffff"
  ctx.fillText(platformLabel, 72, 71)

  // Title
  ctx.font = "bold 38px 'Courier New', monospace"
  const titleLines = _wrapText(ctx, title, W - 120)
  ctx.fillStyle = textBright
  titleLines.slice(0, 2).forEach((line, i) => ctx.fillText(line, 56, 124 + i * 52))

  const logoImg = document.querySelector('link[rel="icon"]')?.href ? new Image() : null
  const drawLogo = () => {
    if (!logoImg) return
    const logoW = 84
    const logoH = 84
    const logoX = W - logoW - 52
    const logoY = 48
    ctx.drawImage(logoImg, logoX, logoY, logoW, logoH)
  }
  if (logoImg) {
    logoImg.onload = drawLogo
    logoImg.src = "/og-image.png"
    if (logoImg.complete) drawLogo()
  }

  const timelineEl = document.querySelector(".mi-card .section-label")
  const timelineText = timelineEl ? "Timeline included" : ""

  // Outcomes
  const baseY = titleLines.length > 1 ? 230 : 196
  const maxOutcomes = Math.min(outcomes.length, 4)
  const rowH = Math.min(80, (H - baseY - 80) / maxOutcomes)
  outcomes.slice(0, maxOutcomes).forEach((o, i) => {
    const y = baseY + i * rowH
    const barW = W - 112
    // Row background
    ctx.fillStyle = cardColor
    ctx.beginPath(); ctx.roundRect(56, y, barW, rowH - 6, 4); ctx.fill()
    ctx.strokeStyle = borderColor; ctx.lineWidth = 1
    ctx.beginPath(); ctx.roundRect(56, y, barW, rowH - 6, 4); ctx.stroke()
    // Probability fill
    ctx.fillStyle = o.color + "2a"
    ctx.beginPath(); ctx.roundRect(56, y, barW * (o.pct / 100), rowH - 6, 4); ctx.fill()
    // Outcome name
    ctx.fillStyle = o.color
    ctx.font = `600 ${rowH > 70 ? 18 : 15}px 'Courier New', monospace`
    ctx.fillText(o.name.slice(0, 55), 78, y + rowH * 0.58)
    // Percentage
    ctx.font = `bold ${rowH > 70 ? 30 : 24}px 'Courier New', monospace`
    const pctStr = o.pct + "%"
    ctx.fillText(pctStr, W - 56 - ctx.measureText(pctStr).width - 24, y + rowH * 0.62)
  })

  ctx.fillStyle = textMuted
  ctx.font = "12px 'Courier New', monospace"
  ctx.textAlign = "left"
  ctx.fillText(timelineText || "Timeline", 56, H - 68)
  ctx.fillText("Volume traded: see market stats", 56, H - 52)

  // Footer
  ctx.fillStyle = textMuted
  ctx.font = "11px 'Courier New', monospace"
  ctx.fillText("✦ PREDARA · PREDICTION MARKET ANALYZER · predara.org", 56, H - 36)
  const stamp = new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date())
  const zone = new Intl.DateTimeFormat(undefined, {
    timeZoneName: "short",
  }).formatToParts(new Date()).find(p => p.type === "timeZoneName")?.value || ""
  const stampText = zone ? `${stamp} ${zone}` : stamp
  ctx.textAlign = "right"
  ctx.fillText(stampText, W - 56, H - 36)
  ctx.textAlign = "left"

  canvas.toBlob(blob => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url; a.download = "predara-market.png"; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1500)
  })
}

// ── Post-fetch success handler — call once after each successful render ───────
function _afterSuccessfulFetch(url) {
  _saveSnapshot(_captureOutcomeSnapshot())
  window._lastFetchedAt = Date.now()
  _logHistory(url, _currentTitle(), _currentPlatform())
  _refreshBookmarkBtn(url)
  _updateFreshnessDisplay()
  addShareBar(url)
}

function showError(msg, hint = "") {
  const hintHtml = hint ? `<div class="error-hint">${esc(hint)}</div>` : ""
  document.getElementById("result").innerHTML =
    `<div class="mi-error">
      <div class="error-content"><span>${esc(msg)}</span>${hintHtml}</div>
      <button class="retry-btn" onclick="document.getElementById('urlInput').select();document.getElementById('urlInput').focus()">TRY AGAIN ↺</button>
    </div>`
}

function onInputChange() {
  const raw = document.getElementById("urlInput").value.trim()
  const hint = document.getElementById("inputHint")
  const input = document.getElementById("urlInput")
  if (!hint) return

  if (!raw) {
    hint.textContent = ""
    hint.className = "input-hint"
    input.classList.remove("input-invalid", "input-valid")
    return
  }

  const lower = raw.toLowerCase()
  const geminiTickerRe = /^[A-Z][A-Z0-9\-]{2,}$/i

  if (geminiTickerRe.test(raw) && !raw.startsWith("http")) {
    // GEMI-{eventTicker}-{contract} instrument symbols — extract event ticker
    const eventTicker = /^GEMI-/i.test(raw)
      ? raw.slice(5).replace(/-[^-]+$/, "").toUpperCase()
      : raw.toUpperCase()
    hint.textContent = `Gemini ticker detected — will search for ${eventTicker}`
    hint.className = "input-hint hint-info"
    input.classList.remove("input-invalid", "input-valid")
    return
  }

  if (lower.includes("kalshi.com")) {
    if (!lower.includes("/markets/") && !lower.includes("/events/")) {
      hint.textContent = "Kalshi URL needs /markets/<ticker> or /events/<ticker>"
      hint.className = "input-hint hint-error"
      input.classList.add("input-invalid"); input.classList.remove("input-valid")
    } else {
      hint.textContent = "Kalshi market URL detected"
      hint.className = "input-hint hint-ok"
      input.classList.add("input-valid"); input.classList.remove("input-invalid")
    }
    return
  }
  if (lower.includes("polymarket.com")) {
    if (!lower.includes("/event/") && !lower.includes("/sports/") && !lower.includes("/esports/")) {
      hint.textContent = "Polymarket URL needs /event/<slug> or a sports/esports market URL"
      hint.className = "input-hint hint-error"
      input.classList.add("input-invalid"); input.classList.remove("input-valid")
    } else {
      hint.textContent = "Polymarket event URL detected"
      hint.className = "input-hint hint-ok"
      input.classList.add("input-valid"); input.classList.remove("input-invalid")
    }
    return
  }
  if (lower.includes("gemini.com")) {
    if (!lower.includes("/predictions/") && !lower.includes("/prediction-markets/")) {
      hint.textContent = "Gemini URL needs /predictions/<ticker> or /prediction-markets/<ticker>"
      hint.className = "input-hint hint-error"
      input.classList.add("input-invalid"); input.classList.remove("input-valid")
    } else {
      hint.textContent = "Gemini market URL detected"
      hint.className = "input-hint hint-ok"
      input.classList.add("input-valid"); input.classList.remove("input-invalid")
    }
    return
  }
  if (lower.includes("coinbase.com")) {
    const isCoinbasePredictions = lower.includes("/predictions/event/")
    hint.textContent = isCoinbasePredictions
      ? "Coinbase Predictions URL detected (Kalshi-backed market)"
      : "Coinbase market URL detected"
    hint.className = "input-hint hint-ok"
    input.classList.add("input-valid"); input.classList.remove("input-invalid")
    return
  }
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    hint.textContent = "Unrecognized platform — supported: kalshi.com · polymarket.com · gemini.com · coinbase.com"
    hint.className = "input-hint hint-error"
    input.classList.add("input-invalid"); input.classList.remove("input-valid")
    return
  }

  hint.textContent = ""
  hint.className = "input-hint"
  input.classList.remove("input-invalid", "input-valid")
}

let _analyzing = false

async function analyze() {
  if (_analyzing) return

  let url = document.getElementById("urlInput").value.trim()
  const result = document.getElementById("result")
  const btn = document.querySelector(".search-row button")

  if (!url) {
    showError("Paste a Kalshi, Polymarket, Gemini, or Coinbase URL to analyze.")
    return
  }

  _analyzing = true
  btn.disabled = true
  btn.textContent = "ANALYZING\u2026"
  btn.style.opacity = "0.6"
  btn.style.cursor = "not-allowed"

  // Clear input hint and share bar while loading
  const hintEl = document.getElementById("inputHint")
  if (hintEl) { hintEl.textContent = ""; hintEl.className = "input-hint" }
  const shareControlsEl = document.getElementById("shareControls")
  if (shareControlsEl) shareControlsEl.style.display = "none"

  // Detect platform early for contextual skeleton loading state (Feature 11)
  const earlyLower = url.toLowerCase()
  const loadingPlatform = earlyLower.includes("kalshi") ? "KALSHI"
    : earlyLower.includes("polymarket") ? "POLYMARKET"
    : earlyLower.includes("coinbase") ? "COINBASE"
    : earlyLower.includes("gemini") ? "GEMINI"
    : ""
  result.innerHTML = skeletonHtml(loadingPlatform)

  function resetBtn() {
    _analyzing = false
    btn.disabled = false
    btn.textContent = "ANALYZE \u2197"
    btn.style.opacity = ""
    btn.style.cursor = ""
  }

  // Expand a bare Gemini ticker or instrument symbol to a full URL.
  // GEMI-{eventTicker}-{contract} instrument symbols need the GEMI- prefix
  // and trailing contract segment stripped to recover the event ticker.
  const geminiTickerRe = /^[A-Z][A-Z0-9\-]{2,}$/i
  if (geminiTickerRe.test(url)) {
    const eventTicker = /^GEMI-/i.test(url)
      ? url.slice(5).replace(/-[^-]+$/, "").toUpperCase()
      : url.toUpperCase()
    url = `https://www.gemini.com/predictions/${eventTicker}`
  }

  const lowerUrl = url.toLowerCase()
  let platform = "unknown"
  if      (lowerUrl.includes("kalshi"))     platform = "kalshi"
  else if (lowerUrl.includes("polymarket")) platform = "polymarket"
  else if (lowerUrl.includes("coinbase"))   platform = "coinbase"
  else if (lowerUrl.includes("gemini"))     platform = "gemini"

  const accent = (PLATFORMS[platform] || {}).accent || "#555"

  if (platform === "polymarket" || platform === "coinbase") {
    try {
      let slug = ""
      if (platform === "polymarket") {
        let eventPart = url.split("/event/")[1]
        if (!eventPart) {
          // Support /sports/, /esports/, and other path-based URLs — use last path segment as slug
          const cleanPath = url.split("?")[0].split("#")[0].replace(/\/$/, "")
          const lastSegment = cleanPath.split("/").pop()
          if (lastSegment && lastSegment !== "polymarket.com") eventPart = lastSegment
        }
        if (!eventPart) throw new Error("Invalid Polymarket URL. Expected: polymarket.com/event/<slug> or a sports/esports market URL")
        // /event/<event-slug>/<market-slug> — only the event slug is needed
        slug = eventPart.split("?")[0].split("#")[0].replace(/\/$/, "").split("/")[0]
      } else {
        if (!lowerUrl.includes("/event/") && !lowerUrl.includes("/markets/") && !lowerUrl.includes("/predictions/")) {
          throw new Error("Invalid Coinbase URL. Expected: predict.coinbase.com/markets/<slug> or coinbase.com/predictions/<slug>")
        }
        const cleanPath = url.split("?")[0].split("#")[0].replace(/\/$/, "")
        slug = cleanPath.split("/").pop()
        if (!slug || slug === "markets" || slug === "predictions" || slug === "event") {
          throw new Error("Invalid Coinbase URL. Expected: predict.coinbase.com/markets/<slug>")
        }

        // www.coinbase.com/predictions/event/ URLs use uppercase Kalshi-style tickers
        // (e.g. KXAAAGASW-26MAR16TH) rather than lowercase Polymarket slugs.
        // Detect by case: Polymarket slugs are always lowercase.
        if (slug !== slug.toLowerCase()) {
          const kr = await fetch(`/api/kalshi?ticker=${encodeURIComponent(slug)}`)
          const kd = await kr.json().catch(() => ({}))
          if (kr.ok && (kd.event || kd.market)) {
            if (kd.event) {
              kd.event._allMarkets = [...(kd.event.markets || [])]
              result.innerHTML = renderKalshiEvent(kd.event, accent, "coinbase")
            } else {
              const fakeEvent = { title: kd.market.title, sub_title: "", category: "Markets", markets: [kd.market], product_metadata: {} }
              result.innerHTML = renderKalshiEvent(fakeEvent, accent, "coinbase")
            }
            _afterSuccessfulFetch(url)
            return
          }
          if (kr.status === 503) {
            showError("Kalshi API not configured", "KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY environment variables are required.")
            return
          }
          if (kr.status === 404) {
            showError(`Event "${slug}" not found`, "This market may have expired or been delisted. Browse Coinbase markets at coinbase.com/predictions")
            return
          }
          // Other Kalshi error — fall through to try Polymarket as a last resort
        }
      }

      const res = await fetch(`/api/polymarket?slug=${encodeURIComponent(slug)}`)
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        if (res.status === 404) {
          showError(
            "Event not found on Polymarket",
            "The market slug may have changed or the event may have closed. Copy the URL directly from polymarket.com/event/…"
          )
          return
        }
        if (res.status === 504) {
          showError("Polymarket API timed out", "The request took too long. Try again in a moment.")
          return
        }
        if (res.status === 502) {
          showError("Couldn't load market data", "Polymarket returned an unexpected response. The market may be unavailable — try again in a moment.")
          return
        }
        throw new Error(errData.error || `Polymarket API error ${res.status}`)
      }
      const data = await res.json()

      const event = Array.isArray(data) ? data[0] : data
      if (!event) {
        showError("Event not found", "No matching event for that slug — double-check the URL.")
        return
      }
      const markets = event.markets || []
      if (!markets.length) throw new Error("No market data found.")

      result.innerHTML = renderPolymarketEvent(event, markets, accent, platform)
      // For Polymarket MLB sports markets inject a live gameday link
      if (event.slug && /^mlb-/i.test(event.slug) && Array.isArray(event.teams) && event.teams.length >= 2) {
        const dateMatch = event.slug.match(/(\d{4}-\d{2}-\d{2})$/)
        if (dateMatch) {
          fetchAndInjectMlbLink(dateMatch[1], event.teams[0].abbreviation, event.teams[1].abbreviation)
        }
      }
      _afterSuccessfulFetch(url)
    } catch (err) {
      console.error(err)
      showError(`ERROR: ${err.message}`)
    } finally {
      resetBtn()
    }

  } else if (platform === "kalshi") {
    try {
      if (!url.includes("/markets/") && !url.includes("/events/")) {
        throw new Error("Invalid Kalshi URL. Expected: kalshi.com/markets/<ticker> or kalshi.com/events/<ticker>")
      }
      const cleanPath = url.split("?")[0].split("#")[0].replace(/\/$/, "")
      const pathParts = cleanPath.split("/")
      const marketsIdx = pathParts.findIndex(p => p === "markets" || p === "events")
      const ticker = pathParts[pathParts.length - 1].toUpperCase()
      // For 3-segment URLs like /markets/{series}/{slug}/{ticker}, pathParts[marketsIdx+1]
      // is the series, not the event ticker — fetching it returns the entire series (wrong).
      // Only use it as a prefetch hint for 2-segment URLs: /markets/{series}/{ticker}.
      const segmentsAfterMarkets = marketsIdx !== -1 ? pathParts.length - 1 - marketsIdx : 0
      const eventTicker = (segmentsAfterMarkets === 2 && pathParts[marketsIdx + 1])
        ? pathParts[marketsIdx + 1].toUpperCase()
        : null

      let data = null
      if (eventTicker && eventTicker !== ticker) {
        const eventRes = await fetch(`/api/kalshi?ticker=${encodeURIComponent(eventTicker)}`)
        if (eventRes.ok) data = await eventRes.json()
      }

      if (!data || (!data.event && !data.market)) {
        const res = await fetch(`/api/kalshi?ticker=${encodeURIComponent(ticker)}`)
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}))
          if (res.status === 404) {
            showError(
              `Market "${ticker}" not found on Kalshi`,
              "Check the ticker in the URL — it may have expired or been delisted. Browse markets at kalshi.com/markets"
            )
            return
          }
          if (res.status === 401 || res.status === 403) {
            showError("Kalshi authentication failed", "The API credentials may be expired or misconfigured.")
            return
          }
          if (res.status === 503) {
            showError("Kalshi API not configured", "KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY environment variables are required.")
            return
          }
          if (res.status === 504) {
            showError("Kalshi API timed out", "The request took too long. Try again in a moment.")
            return
          }
          if (res.status === 502) {
            showError("Couldn't load market data", "Kalshi returned an unexpected response. The market may be unavailable — try again in a moment.")
            return
          }
          throw new Error(errData.error || `Kalshi API error ${res.status}`)
        }
        data = await res.json()
      }

      if (data.event) {
        data.event._allMarkets = [...(data.event.markets || [])]

        if (ticker !== eventTicker && data.event.markets && !data.event.mutually_exclusive) {
          const specific = data.event.markets.filter(m => m.ticker?.toUpperCase() === ticker)
          if (specific.length > 0) data.event.markets = specific
        }
        result.innerHTML = renderKalshiEvent(data.event, accent)
        _afterSuccessfulFetch(url)
      } else if (data.market) {
        const m = data.market
        const fakeEvent = {
          title: m.title,
          sub_title: "",
          category: "Markets",
          markets: [m],
          product_metadata: {},
          series_ticker: m.series_ticker,
          _contract_url: m._contract_url,
        }
        result.innerHTML = renderKalshiEvent(fakeEvent, accent)
        _afterSuccessfulFetch(url)
      } else {
        throw new Error("Unexpected API response.")
      }
    } catch (err) {
      console.error(err)
      showError(`ERROR: ${err.message}`)
    } finally {
      resetBtn()
    }

  } else if (platform === "gemini") {
    try {
      if (!lowerUrl.includes("/prediction-markets/") && !lowerUrl.includes("/predictions/")) {
        throw new Error("Invalid Gemini URL. Expected: gemini.com/prediction-markets/<ticker>")
      }
      const cleanPath = url.split("?")[0].split("#")[0].replace(/\/$/, "")
      const pathParts = cleanPath.split("/").filter(Boolean)
      const predictionsIdx = pathParts.findIndex(p => p.toLowerCase() === "predictions" || p.toLowerCase() === "prediction-markets")
      const ticker = predictionsIdx !== -1 && pathParts[predictionsIdx + 1]
        ? pathParts[predictionsIdx + 1]
        : pathParts[pathParts.length - 1]
      if (!ticker || ticker.toLowerCase() === "prediction-markets" || ticker.toLowerCase() === "predictions") {
        throw new Error("Invalid Gemini URL. Expected: gemini.com/prediction-markets/<ticker>")
      }

      const geminiParams = new URLSearchParams({ ticker })
      if (url.startsWith("https://") || url.startsWith("http://")) geminiParams.set("pageUrl", url)
      const res = await fetch(`/api/gemini?${geminiParams}`)
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        if (res.status === 404) {
          showError(
            `Ticker "${ticker}" not found on Gemini`,
            "Double-check the full ticker — some have trailing characters (e.g. TPC2026T5, not TPC2026T). Browse markets at gemini.com/prediction-markets"
          )
          return
        }
        if (res.status === 504) {
          showError("Gemini API timed out", "The request took too long. Try again in a moment.")
          return
        }
        if (res.status === 502) {
          showError("Couldn't load market data", "Gemini returned an unexpected response. The market may be unavailable — try again in a moment.")
          return
        }
        throw new Error(errData.error || `Gemini API error ${res.status}`)
      }
      const data = await res.json()
      if (!data || (!data.title && !data.contracts && !data.ticker)) throw new Error("No event data returned.")

      result.innerHTML = renderGeminiEvent(data, accent)
      // For Gemini MLB markets (ticker: MLB-YYMMDDHHmm-AWAY-HOME-M) inject gameday link
      {
        const mlbM = ticker.match(/^MLB-(\d{2})(\d{2})(\d{2})\d{4}-([A-Z]+)-([A-Z]+)/i)
        if (mlbM) {
          const mlbDate = `20${mlbM[1]}-${mlbM[2]}-${mlbM[3]}`
          fetchAndInjectMlbLink(mlbDate, mlbM[4], mlbM[5])
        }
      }
      _afterSuccessfulFetch(url)
    } catch (err) {
      console.error(err)
      showError(`ERROR: ${err.message}`)
    } finally {
      resetBtn()
    }

  } else {
    const isUrl = url.startsWith("http://") || url.startsWith("https://")
    showError(
      isUrl ? "Unrecognized platform" : "Unrecognized input",
      isUrl
        ? "Supported platforms: kalshi.com · polymarket.com · gemini.com · predict.coinbase.com"
        : "Paste a full market URL, or a bare Gemini ticker like NBA-2603151930-DET-TOR-M"
    )
    resetBtn()
  }
}
