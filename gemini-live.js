// Gemini Prediction Markets — public data surface.
// Reads through /api/gemini-markets (see lib/gemini-public.js) for REST, and
// connects directly to Gemini's public market-data WebSocket for live books.
// Docs: https://developer.gemini.com/products/prediction-markets
//
// Everything here is read-only public data: no keys, no orders, no positions.
// Self-contained (no utils.js dependency) so settlement.html can load it too.

const GEMINI_WS_URL = "wss://ws.gemini.com/"
const GEMINI_EVENT_URL = (ticker) => `https://www.gemini.com/predictions/${ticker}`

function _gemEsc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  )
}

function _gemMoney(n) {
  const v = typeof n === "number" ? n : parseFloat(n)
  if (!isFinite(v)) return "—"
  if (v >= 1e6) return `$${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`
  if (v >= 1e3) return `$${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}K`
  return `$${v.toFixed(v < 10 ? 2 : 0)}`
}

function _gemCents(p) {
  const v = parseFloat(p)
  return isFinite(v) ? `${Math.round(v * 100)}¢` : "—"
}

function _gemDateTime(iso) {
  if (!iso) return ""
  const d = new Date(iso)
  if (isNaN(d)) return ""
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
}

// UTC day string offset from today — Gemini's volume endpoints are keyed by UTC
// date and only expose completed days.
function _gemUtcDate(daysAgo) {
  const d = new Date(Date.now() - daysAgo * 86400000)
  return d.toISOString().slice(0, 10)
}

// ── REST ──────────────────────────────────────────────────────────────────────
async function geminiPublic(resource, params = {}) {
  const sp = new URLSearchParams({ resource })
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue
    if (Array.isArray(v)) v.forEach((x) => sp.append(k, x))
    else sp.set(k, String(v))
  }
  const res = await fetch(`/api/gemini-markets?${sp}`)
  let json = null
  try { json = await res.json() } catch { /* non-JSON error body */ }
  if (!res.ok) throw new Error((json && json.error) || `Gemini request failed (${res.status})`)
  return json
}

// ── Event list → card rows (shared by every browse feed) ──────────────────────
function _gemTopContract(event) {
  const contracts = Array.isArray(event.contracts) ? event.contracts : []
  let top = null
  let topPrice = -1
  for (const c of contracts) {
    const p = c.prices || {}
    const price = parseFloat(p.lastTradePrice || p.bestAsk || p.bestBid || "")
    if (isFinite(price) && price > topPrice) { topPrice = price; top = c }
  }
  return { top, topPrice }
}

function _gemEventCardHtml(event, { showClose = false, showSettled = false } = {}) {
  const ticker = event.ticker || ""
  const { top, topPrice } = _gemTopContract(event)
  const url = GEMINI_EVENT_URL(ticker)
  const contracts = Array.isArray(event.contracts) ? event.contracts : []
  const closeIso = event.closeDate || event.expiryDate || contracts[0]?.expiryDate || ""
  const winner = showSettled
    ? contracts.find((c) => (c.resolutionSide || "").toLowerCase() === "yes")
    : null
  const meta = [
    ticker ? `<span class="discover-market-ticker">${_gemEsc(ticker)}</span>` : "",
    event.category ? `<span>${_gemEsc(event.category)}</span>` : "",
    top && topPrice >= 0 && !showSettled
      ? `<span>${_gemEsc(top.abbreviatedName || top.label || top.ticker || "Top")}: ${Math.round(topPrice * 100)}%</span>`
      : "",
    winner ? `<span>Settled: ${_gemEsc(winner.abbreviatedName || winner.label || winner.ticker)}</span>` : "",
    parseFloat(event.liquidity) > 0 ? `<span>Liq: ${_gemMoney(event.liquidity)}</span>` : "",
    showClose && closeIso ? `<span>Closes ${_gemEsc(_gemDateTime(closeIso))}</span>` : "",
    showSettled && event.resolvedAt ? `<span>${_gemEsc(_gemDateTime(event.resolvedAt))}</span>` : "",
    contracts.length > 2 ? `<span>${contracts.length} outcomes</span>` : "",
  ].filter(Boolean).join("")
  return `
    <button type="button" class="discover-market" data-url="${_gemEsc(url)}" onclick="_loadAndAnalyze(this.dataset.url);switchTab('analyze')">
      <div class="discover-market-title">${_gemEsc(event.title || ticker || "Untitled")}</div>
      <div class="discover-market-meta">${meta}</div>
    </button>`
}

// ════════════════════════════════════════════════════════════════════════════
// DISCOVER — search + newly listed / upcoming / recently settled feeds
// ════════════════════════════════════════════════════════════════════════════
const GEM_FEEDS = {
  search: { resource: "events", label: "Search" },
  new: { resource: "newly-listed", label: "New (24h)" },
  upcoming: { resource: "upcoming", label: "Upcoming" },
  settled: { resource: "recently-settled", label: "Recently settled" },
}

const _gemBrowse = { mode: "search", search: "", category: "", offset: 0 }
let _gemCategories = null

function geminiBrowseHtml() {
  const tabs = Object.entries(GEM_FEEDS).map(([key, f]) =>
    `<button class="gem-feed-btn${key === _gemBrowse.mode ? " active" : ""}" data-feed="${key}"
      onclick="geminiBrowseSetFeed('${key}')">${_gemEsc(f.label)}</button>`
  ).join("")
  return `
    <div class="mi-card gem-browse-card">
      <div class="section-label">SEARCH GEMINI PREDICTION MARKETS</div>
      <div class="gem-browse-row">
        <input id="gemSearchInput" class="gem-search-input" type="text" autocomplete="off"
          placeholder="Search by team, topic or ticker…"
          onkeydown="if(event.key==='Enter')geminiBrowseSearch()">
        <select id="gemCategorySelect" class="gem-select" onchange="geminiBrowseSearch()">
          <option value="">All categories</option>
        </select>
        <button class="copy-link-btn" onclick="geminiBrowseSearch()">Search</button>
      </div>
      <div class="gem-feed-tabs">${tabs}</div>
      <div id="gemBrowseResults" class="gem-browse-results"></div>
      <div class="cal-note">Live from Gemini's public Prediction Markets API. Click any market to analyze it.</div>
    </div>`
}

// Discover re-renders its whole container, so this runs against fresh empty
// controls every visit and has to restore the search state as well as reload.
async function geminiBrowseInit() {
  const input = document.getElementById("gemSearchInput")
  if (input) input.value = _gemBrowse.search
  _gemBrowseLoad()

  if (!_gemCategories) {
    try {
      const data = await geminiPublic("categories", { status: "active" })
      _gemCategories = (data && data.categories) || []
    } catch { _gemCategories = [] }  // filter stays as "All categories"
  }
  const sel = document.getElementById("gemCategorySelect")
  if (!sel || !_gemCategories.length) return
  sel.insertAdjacentHTML("beforeend", _gemCategories.map((c) =>
    `<option value="${_gemEsc(c)}"${c === _gemBrowse.category ? " selected" : ""}>${_gemEsc(c)}</option>`).join(""))
}

function geminiBrowseSetFeed(mode) {
  if (!GEM_FEEDS[mode]) return
  _gemBrowse.mode = mode
  _gemBrowse.offset = 0
  document.querySelectorAll(".gem-feed-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.feed === mode))
  _gemBrowseLoad()
}

function geminiBrowseSearch() {
  const input = document.getElementById("gemSearchInput")
  const sel = document.getElementById("gemCategorySelect")
  _gemBrowse.search = input ? input.value.trim() : ""
  _gemBrowse.category = sel ? sel.value : ""
  _gemBrowse.offset = 0
  if (_gemBrowse.search && _gemBrowse.mode !== "search") geminiBrowseSetFeed("search")
  else _gemBrowseLoad()
}

async function _gemBrowseLoad(append = false) {
  const box = document.getElementById("gemBrowseResults")
  if (!box) return
  const feed = GEM_FEEDS[_gemBrowse.mode]
  if (!append) box.innerHTML = `<div class="mi-loading"><div class="mi-spinner"></div> Loading markets…</div>`

  const params = { limit: 12, offset: _gemBrowse.offset }
  if (_gemBrowse.category) params.category = _gemBrowse.category
  if (_gemBrowse.mode === "search") {
    params.status = "active"
    if (_gemBrowse.search) params.search = _gemBrowse.search
  }

  try {
    const data = await geminiPublic(feed.resource, params)
    const events = (data && data.data) || []
    const total = (data && data.pagination && data.pagination.total) || events.length
    if (!events.length) {
      const msg = _gemBrowse.search
        ? `No Gemini markets match “${_gemEsc(_gemBrowse.search)}”.`
        : "No markets in this feed right now."
      box.innerHTML = `<div class="cal-empty">${msg}</div>`
      return
    }
    const html = events.map((e) => _gemEventCardHtml(e, {
      showClose: _gemBrowse.mode === "upcoming" || _gemBrowse.mode === "search",
      showSettled: _gemBrowse.mode === "settled",
    })).join("")
    const shown = _gemBrowse.offset + events.length
    const moreBtn = shown < total
      ? `<button class="copy-link-btn gem-more-btn" onclick="geminiBrowseMore()">Show more (${shown} of ${total})</button>`
      : `<div class="cal-note">${shown} of ${total} markets</div>`
    if (append) {
      const old = box.querySelector(".gem-more-btn, .cal-note")
      if (old) old.remove()
      box.insertAdjacentHTML("beforeend", html + moreBtn)
    } else {
      box.innerHTML = html + moreBtn
    }
  } catch (err) {
    box.innerHTML = `<div class="cal-empty">Couldn't reach Gemini right now — ${_gemEsc(err.message)}</div>`
  }
}

function geminiBrowseMore() {
  _gemBrowse.offset += 12
  _gemBrowseLoad(true)
}

// ════════════════════════════════════════════════════════════════════════════
// ANALYZE — live order book over the public WebSocket, strike, reward pool
// ════════════════════════════════════════════════════════════════════════════
let _gemFeed = null

function geminiLiveCardHtml(live) {
  if (!live || !live.contracts.length) return ""
  const rows = live.contracts.map((c) => `
    <tr data-sym="${_gemEsc(c.symbol.toLowerCase())}">
      <td class="gem-book-name">${_gemEsc(c.label)}</td>
      <td class="gem-bid">—</td>
      <td class="gem-ask">—</td>
      <td class="gem-spread">—</td>
      <td class="gem-last">—</td>
      <td class="gem-size">—</td>
    </tr>`).join("")
  return `
    <div class="mi-card" id="gemLiveCard">
      <div class="section-label">
        LIVE ORDER BOOK
        <span class="gem-live-pill" id="gemLiveState">connecting…</span>
      </div>
      <div id="gemStrikeRow" class="gem-strike-row" style="display:none"></div>
      <div class="gem-book-wrap">
        <table class="gem-book-table">
          <thead><tr><th>Outcome</th><th>Bid</th><th>Ask</th><th>Spread</th><th>Last</th><th>Book size</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div id="gemDepthWrap" class="gem-depth-wrap" style="display:none">
        <div class="gem-depth-label" id="gemDepthLabel"></div>
        <div class="gem-depth-cols">
          <div class="gem-depth-col" id="gemDepthBids"></div>
          <div class="gem-depth-col" id="gemDepthAsks"></div>
        </div>
      </div>
      <div class="gem-live-note">
        Streamed from Gemini's public market-data WebSocket (<code>bookTicker</code>, <code>trade</code>, <code>depth5</code>).
        Prices are per $1 payout; sizes are contracts resting on the book.
      </div>
    </div>`
}

function _gemSetState(text, cls) {
  const el = document.getElementById("gemLiveState")
  if (!el) return
  el.textContent = text
  el.className = `gem-live-pill${cls ? ` ${cls}` : ""}`
}

function closeGeminiLive() {
  if (!_gemFeed) return
  const feed = _gemFeed
  _gemFeed = null
  clearInterval(feed.flushTimer)
  try { feed.ws.close() } catch { /* already closing */ }
}

function initGeminiLive() {
  closeGeminiLive()
  const live = typeof window !== "undefined" ? window._geminiLive : null
  if (!live || !live.contracts || !live.contracts.length) return
  if (!document.getElementById("gemLiveCard")) return

  _gemLoadStrike(live)
  _gemLoadEventPool(live)

  if (typeof WebSocket === "undefined") { _gemSetState("unavailable", "gem-live-off"); return }

  const streams = []
  live.contracts.slice(0, 12).forEach((c) => {
    streams.push(`${c.symbol}@bookTicker`, `${c.symbol}@trade`)
  })
  // Only the leading outcome gets a depth ladder — one book is enough context
  // and keeps the subscription small on 100+ contract sports events.
  const depthSymbol = live.contracts[0].symbol
  streams.push(`${depthSymbol}@depth5`)

  let ws
  try { ws = new WebSocket(GEMINI_WS_URL) } catch { _gemSetState("unavailable", "gem-live-off"); return }

  const feed = {
    ws,
    depthSymbol: depthSymbol.toLowerCase(),
    book: new Map(),
    depth: null,
    dirty: false,
    flushTimer: setInterval(() => {
      if (!feed.dirty) return
      feed.dirty = false
      _gemRenderBook(feed)
    }, 400),
  }
  _gemFeed = feed

  ws.onopen = () => {
    _gemSetState("live", "gem-live-on")
    ws.send(JSON.stringify({ method: "SUBSCRIBE", params: streams, id: 1 }))
  }
  ws.onmessage = (evt) => {
    let msg
    try { msg = JSON.parse(evt.data) } catch { return }
    if (!msg || typeof msg !== "object") return
    _gemApplyMessage(feed, msg)
  }
  ws.onerror = () => _gemSetState("offline", "gem-live-off")
  ws.onclose = () => {
    if (_gemFeed === feed) _gemSetState("disconnected", "gem-live-off")
  }
}

// bookTicker: { s, b, B, a, A, c, C }   trade: { s, p, q }
// depth5:     { symbol, bids: [[px, qty]], asks: [...] }
function _gemApplyMessage(feed, msg) {
  if (Array.isArray(msg.bids) || Array.isArray(msg.asks)) {
    const sym = String(msg.symbol || msg.s || "").toLowerCase()
    if (sym && sym !== feed.depthSymbol) return
    feed.depth = { bids: msg.bids || [], asks: msg.asks || [] }
    feed.dirty = true
    return
  }
  const symbol = String(msg.s || "").toLowerCase()
  if (!symbol) return
  const entry = feed.book.get(symbol) || {}
  if (msg.b !== undefined || msg.a !== undefined) {
    entry.bid = msg.b
    entry.bidSize = msg.B
    entry.ask = msg.a
    entry.askSize = msg.A
    if (msg.c !== undefined) entry.last = msg.c
  } else if (msg.p !== undefined) {
    entry.last = msg.p
    entry.lastQty = msg.q
  } else {
    return
  }
  feed.book.set(symbol, entry)
  feed.dirty = true
}

function _gemRenderBook(feed) {
  const card = document.getElementById("gemLiveCard")
  if (!card) { closeGeminiLive(); return }

  card.querySelectorAll("tr[data-sym]").forEach((tr) => {
    const q = feed.book.get(tr.dataset.sym)
    if (!q) return
    const bid = parseFloat(q.bid)
    const ask = parseFloat(q.ask)
    const spread = isFinite(bid) && isFinite(ask) && ask > 0 ? Math.round((ask - bid) * 100) : null
    const size = (parseFloat(q.bidSize) || 0) + (parseFloat(q.askSize) || 0)
    tr.querySelector(".gem-bid").textContent = isFinite(bid) && bid > 0 ? _gemCents(bid) : "—"
    tr.querySelector(".gem-ask").textContent = isFinite(ask) && ask > 0 ? _gemCents(ask) : "—"
    tr.querySelector(".gem-spread").textContent = spread == null ? "—" : `${spread}¢`
    tr.querySelector(".gem-last").textContent = q.last ? _gemCents(q.last) : "—"
    tr.querySelector(".gem-size").textContent = size > 0 ? Math.round(size).toLocaleString() : "—"
  })

  if (!feed.depth) return
  const wrap = document.getElementById("gemDepthWrap")
  const bidsEl = document.getElementById("gemDepthBids")
  const asksEl = document.getElementById("gemDepthAsks")
  const labelEl = document.getElementById("gemDepthLabel")
  if (!wrap || !bidsEl || !asksEl) return
  const leadRow = document.querySelector(`tr[data-sym="${feed.depthSymbol}"] .gem-book-name`)
  if (labelEl) labelEl.textContent = `Depth — ${leadRow ? leadRow.textContent : "leading outcome"}`
  const ladder = (levels, side) => levels.slice(0, 5).map(([px, qty]) => {
    const q = parseFloat(qty) || 0
    return `<div class="gem-depth-lvl gem-depth-${side}">
      <span class="gem-depth-px">${_gemCents(px)}</span>
      <span class="gem-depth-qty">${Math.round(q).toLocaleString()}</span>
    </div>`
  }).join("") || `<div class="gem-depth-lvl">—</div>`
  bidsEl.innerHTML = `<div class="gem-depth-head">Bids</div>${ladder(feed.depth.bids, "bid")}`
  asksEl.innerHTML = `<div class="gem-depth-head">Asks</div>${ladder(feed.depth.asks, "ask")}`
  wrap.style.display = ""
}

// Reference price for crypto "Up/Down" contracts: the value the settlement
// index is measured against (or when that value gets captured).
async function _gemLoadStrike(live) {
  if (!live.ticker) return
  let data
  try { data = await geminiPublic("strike", { ticker: live.ticker }) } catch { return }
  if (!data) return
  const row = document.getElementById("gemStrikeRow")
  if (!row) return
  const value = parseFloat(data.value)
  const at = _gemDateTime(data.availableAt)
  if (!isFinite(value) && !at) return
  // `_comparison` spells out strict vs inclusive thresholds, which decide ties.
  const reading = data._comparison && data._comparison.text ? ` — ${_gemEsc(data._comparison.text)}` : ""
  row.innerHTML = isFinite(value)
    ? `<strong>Strike ${_gemMoney(value)}</strong>${reading || " — outcome is measured against this reference price"}${at ? `, captured ${_gemEsc(at)}` : ""}.`
    : `Strike price is captured at ${_gemEsc(at)} — not published yet.`
  row.style.display = ""
}

// Liquidity Rewards pool for this specific event, if it's in the program.
async function _gemLoadEventPool(live) {
  const slot = document.getElementById("gemEventRewards")
  if (!slot || !live.ticker) return
  let data
  try { data = await geminiPublic("liquidity-rewards-events", { limit: 100, sort: "daily_pool_desc" }) } catch { return }
  const events = (data && data.events) || []
  const match = events.find((e) => e.event_ticker === live.ticker)
  if (!match) return
  slot.innerHTML = `
    <div class="rewards-note-box">
      <strong>This market is in Gemini's Liquidity Rewards Program.</strong>
      Daily pool ${_gemMoney(match.daily_pool_usd)}${match.pool_event_count > 1 ? ` shared across ${match.pool_event_count} events in this pool` : ""} ·
      ${match.qualifying_maker_count || 0} qualifying maker${match.qualifying_maker_count === 1 ? "" : "s"} scored ·
      ends ${_gemEsc(_gemDateTime(match.ends_at))}.
    </div>`
}

// ════════════════════════════════════════════════════════════════════════════
// TOOLS — traded volume by category (daily + hourly) and combo contracts
// ════════════════════════════════════════════════════════════════════════════
let _gemVolDaysAgo = 1

function geminiVolumeCardHtml() {
  return `
    <div class="mi-card" id="gemVolumeCard">
      <div class="section-label">GEMINI TRADED VOLUME</div>
      <div class="gem-vol-controls">
        <button class="copy-link-btn" onclick="geminiVolumeShift(1)">← Earlier</button>
        <span id="gemVolDate" class="gem-vol-date"></span>
        <button class="copy-link-btn" onclick="geminiVolumeShift(-1)">Later →</button>
      </div>
      <div id="gemVolumeBody"><div class="mi-loading"><div class="mi-spinner"></div> Loading volume…</div></div>
    </div>
    <div id="gemCombosSlot"></div>`
}

function geminiVolumeShift(delta) {
  const next = _gemVolDaysAgo + delta
  if (next < 1 || next > 30) return
  _gemVolDaysAgo = next
  loadGeminiVolume(0)
}

// Gemini publishes a day's volume some hours after it closes, so an empty or
// missing most-recent day walks back to the last day that has data.
async function loadGeminiVolume(autoBack = 2) {
  const body = document.getElementById("gemVolumeBody")
  if (!body) return
  const date = _gemUtcDate(_gemVolDaysAgo)
  const dateEl = document.getElementById("gemVolDate")
  if (dateEl) dateEl.textContent = `${date} (UTC)`
  body.innerHTML = `<div class="mi-loading"><div class="mi-spinner"></div> Loading volume…</div>`

  let daily, hourly
  try {
    ;[daily, hourly] = await Promise.all([
      geminiPublic("volume", { date }),
      geminiPublic("volume", { date, hourly: "1" }).catch(() => []),
    ])
  } catch (err) {
    if (autoBack > 0 && _gemVolDaysAgo < 30) {
      _gemVolDaysAgo += 1
      return loadGeminiVolume(autoBack - 1)
    }
    body.innerHTML = `<div class="cal-empty">No volume published for ${_gemEsc(date)} — ${_gemEsc(err.message)}</div>`
    return
  }

  // Top-level categories only (single-element categoryPath) — the deeper paths
  // are sub-totals already counted in their parent.
  const tops = (Array.isArray(daily) ? daily : [])
    .filter((r) => Array.isArray(r.categoryPath) && r.categoryPath.length === 1)
    .map((r) => ({ name: r.categoryPath[0], volume: parseFloat(r.volume) || 0 }))
    .sort((a, b) => b.volume - a.volume)
  if (!tops.length) {
    if (autoBack > 0 && _gemVolDaysAgo < 30) {
      _gemVolDaysAgo += 1
      return loadGeminiVolume(autoBack - 1)
    }
    body.innerHTML = `<div class="cal-empty">No volume published for ${_gemEsc(date)} yet.</div>`
    return
  }
  const total = tops.reduce((s, r) => s + r.volume, 0)
  const max = tops[0].volume || 1
  const bars = tops.slice(0, 10).map((r) => `
    <div class="gem-vol-row">
      <span class="gem-vol-name">${_gemEsc(r.name)}</span>
      <span class="gem-vol-bar"><span style="width:${Math.max(2, Math.round((r.volume / max) * 100))}%"></span></span>
      <span class="gem-vol-val">${_gemMoney(r.volume)}</span>
    </div>`).join("")

  body.innerHTML = `
    <div class="gem-vol-total">${_gemMoney(total)} traded across ${tops.length} categories</div>
    ${bars}
    ${(Array.isArray(hourly) && hourly.length) ? `<canvas id="gemVolChart" class="gem-vol-chart" height="140"></canvas>
      <div class="cal-note">Hourly notional volume, all categories, ${_gemEsc(date)} UTC.</div>` : ""}`

  if (Array.isArray(hourly) && hourly.length) _gemDrawHourly(hourly)
}

function _gemDrawHourly(hourly) {
  const canvas = document.getElementById("gemVolChart")
  if (!canvas || !canvas.getContext) return
  const buckets = new Map()
  hourly
    .filter((r) => Array.isArray(r.categoryPath) && r.categoryPath.length === 1)
    .forEach((r) => {
      const hour = new Date(r.periodStart).getUTCHours()
      buckets.set(hour, (buckets.get(hour) || 0) + (parseFloat(r.volume) || 0))
    })
  const values = Array.from({ length: 24 }, (_, h) => buckets.get(h) || 0)
  const max = Math.max(...values, 1)

  const dpr = window.devicePixelRatio || 1
  const width = canvas.clientWidth || 600
  const height = 140
  canvas.width = width * dpr
  canvas.height = height * dpr
  const ctx = canvas.getContext("2d")
  ctx.scale(dpr, dpr)
  const style = getComputedStyle(document.body)
  const accent = (style.getPropertyValue("--orange") || "#f5820b").trim()
  const muted = (style.getPropertyValue("--muted") || "#888").trim()

  const padBottom = 18
  const barW = width / 24
  values.forEach((v, i) => {
    const h = Math.round(((height - padBottom) * v) / max)
    ctx.fillStyle = accent
    ctx.globalAlpha = 0.85
    ctx.fillRect(i * barW + 1, height - padBottom - h, Math.max(1, barW - 2), h)
  })
  ctx.globalAlpha = 1
  ctx.fillStyle = muted
  ctx.font = "10px system-ui, sans-serif"
  ctx.textAlign = "center"
  for (const h of [0, 6, 12, 18, 23]) {
    ctx.fillText(`${String(h).padStart(2, "0")}h`, h * barW + barW / 2, height - 5)
  }
}

// Multi-leg combo contracts. Gemini exposes the endpoint publicly but returns
// nothing while the product is off, so the card only appears when it has data.
async function loadGeminiCombos() {
  const slot = document.getElementById("gemCombosSlot")
  if (!slot) return
  let data
  try { data = await geminiPublic("combos", { limit: 20 }) } catch { return }
  const combos = (data && (data.combos || data.data)) || []
  if (!combos.length) return
  const rows = combos.map((c) => `
    <tr>
      <td>${_gemEsc(c.name || c.instrumentSymbol || "Combo")}</td>
      <td>${_gemEsc((c.legs || []).map((l) => l.instrumentSymbol || l.symbol || "").filter(Boolean).join(" + ")) || "—"}</td>
      <td>${c.prices ? _gemCents(c.prices.lastTradePrice || c.prices.bestAsk) : "—"}</td>
      <td>${_gemEsc(c.status || "—")}</td>
    </tr>`).join("")
  slot.innerHTML = `
    <div class="mi-card">
      <div class="section-label">GEMINI COMBO CONTRACTS</div>
      <div class="rewards-live-wrap">
        <table class="rewards-live-table">
          <thead><tr><th>Combo</th><th>Legs</th><th>Last</th><th>Status</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="cal-note">Multi-leg contracts that settle YES only if every leg resolves YES.</div>
    </div>`
}

// ════════════════════════════════════════════════════════════════════════════
// REWARDS TAB — live maker-rebate rates and liquidity-reward pools
// ════════════════════════════════════════════════════════════════════════════
async function loadGeminiLiveRewards() {
  _gemLoadMakerRebates()
  _gemLoadLiquidityPools()
}

async function _gemLoadMakerRebates() {
  const box = document.getElementById("gemMakerRebates")
  if (!box) return
  let data
  try { data = await geminiPublic("maker-rebate-rates") } catch {
    box.innerHTML = "Couldn't load live maker-rebate rates right now."
    return
  }
  const rules = (data && data.rate_rules) || []
  const now = Date.now()
  const active = rules.filter((r) => {
    const from = r.effective_from ? new Date(r.effective_from).getTime() : 0
    const to = r.effective_to ? new Date(r.effective_to).getTime() : Infinity
    return from <= now && now < to
  })
  const shown = (active.length ? active : rules.slice(0, 8))
    .sort((a, b) => (b.rebate_multiplier_bps || 0) - (a.rebate_multiplier_bps || 0))
  if (!shown.length) {
    box.innerHTML = "No maker-rebate rate rules published right now."
    return
  }
  const rows = shown.map((r) => `
    <tr>
      <td>${_gemEsc(r.category || "All categories")}</td>
      <td>${((r.rebate_multiplier_bps || 0) / 100).toFixed(0)}% of taker fee</td>
      <td>${_gemEsc(_gemDateTime(r.effective_from)) || "—"}</td>
      <td>${r.effective_to ? _gemEsc(_gemDateTime(r.effective_to)) : "open-ended"}</td>
    </tr>`).join("")
  box.outerHTML = `
    <div class="rewards-live-wrap" id="gemMakerRebates">
      <table class="rewards-live-table">
        <thead><tr><th>Category</th><th>Rebate multiplier</th><th>From</th><th>Until</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="rewards-note-box">${active.length
      ? `${active.length} rate rule${active.length === 1 ? "" : "s"} in effect now.`
      : "No rule is currently in effect — showing the most recent published rules."} The multiplier is applied to the taker fee generated by each fill, capped at 5% of fill notional.</div>`
}

async function _gemLoadLiquidityPools() {
  const box = document.getElementById("gemLiquidityPools")
  if (!box) return
  let config = null
  let data = null
  try {
    ;[config, data] = await Promise.all([
      geminiPublic("liquidity-rewards-config").catch(() => null),
      geminiPublic("liquidity-rewards-events", { limit: 25, sort: "daily_pool_desc" }),
    ])
  } catch {
    box.innerHTML = "Couldn't load live liquidity-reward pools right now."
    return
  }
  const events = (data && data.events) || []
  if (!events.length) {
    box.innerHTML = config && config.enabled === false
      ? "The Liquidity Rewards Program is switched off right now."
      : "No events are earning liquidity rewards right now."
    return
  }
  const total = (data && data.pagination && data.pagination.total) || events.length
  const rows = events.map((e) => `
    <tr data-url="${_gemEsc(GEMINI_EVENT_URL(e.event_ticker))}" style="cursor:pointer"
      onclick="_loadAndAnalyze(this.dataset.url);switchTab('analyze')">
      <td class="rw-desc">${_gemEsc(e.title || e.event_ticker)}</td>
      <td>${_gemEsc(e.category || "—")}</td>
      <td>${_gemMoney(e.daily_pool_usd)}</td>
      <td>${e.qualifying_maker_count == null ? "—" : e.qualifying_maker_count}</td>
      <td>${_gemEsc(_gemDateTime(e.ends_at)) || "—"}</td>
    </tr>`).join("")
  const configLine = config
    ? `Max spread ${config.max_spread_cents}¢ from midpoint · minimum payout ${_gemMoney(config.min_payout_threshold_usd)} · program ${config.enabled ? "enabled" : "disabled"}.`
    : ""
  box.outerHTML = `
    <div class="rewards-live-wrap" id="gemLiquidityPools">
      <table class="rewards-live-table">
        <thead><tr><th>Event</th><th>Category</th><th>Daily pool</th><th>Qualifying makers</th><th>Ends</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="rewards-note-box">${events.length} of ${total} events currently earning liquidity rewards${data && data.last_score_date ? `, scored through ${_gemEsc(data.last_score_date)}` : ""}. ${configLine} Click a row to analyze the market.</div>`
}

// ════════════════════════════════════════════════════════════════════════════
// CALENDAR / SETTLEMENT DESK feeds
// ════════════════════════════════════════════════════════════════════════════
async function renderGeminiUpcoming(containerId = "gemUpcomingSlot") {
  const slot = document.getElementById(containerId)
  if (!slot) return
  slot.innerHTML = `<div class="mi-card"><div class="section-label">CLOSING SOON ON GEMINI</div>
    <div class="mi-loading"><div class="mi-spinner"></div> Loading upcoming markets…</div></div>`
  try {
    const data = await geminiPublic("upcoming", { limit: 10 })
    const events = (data && data.data) || []
    slot.innerHTML = `
      <div class="mi-card">
        <div class="section-label">CLOSING SOON ON GEMINI</div>
        ${events.length
          ? events.map((e) => _gemEventCardHtml(e, { showClose: true })).join("")
          : `<div class="cal-empty">No upcoming Gemini markets listed right now.</div>`}
        <div class="cal-note">Markets that open or close next on Gemini, straight from its public API.</div>
      </div>`
  } catch {
    slot.innerHTML = ""
  }
}

async function renderGeminiRecentlySettled(containerId = "gemSettledSlot", onPick = null) {
  const slot = document.getElementById(containerId)
  if (!slot) return
  let events = []
  try {
    const data = await geminiPublic("recently-settled", { limit: 8 })
    events = (data && data.data) || []
  } catch {
    slot.innerHTML = ""
    return
  }
  if (!events.length) { slot.innerHTML = ""; return }
  const items = events.map((e) => {
    const contracts = Array.isArray(e.contracts) ? e.contracts : []
    const winner = contracts.find((c) => (c.resolutionSide || "").toLowerCase() === "yes")
    const target = onPick ? e.ticker : GEMINI_EVENT_URL(e.ticker)
    return `
      <button type="button" class="discover-market" data-target="${_gemEsc(target)}"
        onclick="${onPick ? `${onPick}(this.dataset.target)` : "_loadAndAnalyze(this.dataset.target);switchTab('analyze')"}">
        <div class="discover-market-title">${_gemEsc(e.title || e.ticker)}</div>
        <div class="discover-market-meta">
          ${e.ticker ? `<span class="discover-market-ticker">${_gemEsc(e.ticker)}</span>` : ""}
          ${winner ? `<span class="discover-market-result">Result: ${_gemEsc(winner.abbreviatedName || winner.label || winner.ticker)}</span>` : `<span>Result unavailable</span>`}
          ${e.category ? `<span>${_gemEsc(e.category)}</span>` : ""}
          ${e.resolvedAt ? `<span>${_gemEsc(_gemDateTime(e.resolvedAt))}</span>` : ""}
        </div>
      </button>`
  }).join("")
  slot.innerHTML = `
    <div class="mi-card">
      <div class="section-label">RECENT GEMINI SETTLEMENTS</div>
      ${items}
      <div class="cal-note">Public settlement results from Gemini${onPick ? " — select one to open an independent audit." : "."}</div>
    </div>`
}
