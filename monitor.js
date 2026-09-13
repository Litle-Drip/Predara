// ── Prediction Markets Monitor (client) ──────────────────────────────────────
// Renders the platform-wide book-quality dashboard from /api/monitor.
//
// The server sweeps the public event feed and sends back three things: rolled-up
// totals, one summary per event (uncapped), and a capped list of contract rows.
// The per-event summaries are what make the filters honest — they carry the
// unrounded `spreadSum` and the per-event overround, so this file can re-roll
// any subset of events and get exactly the number the server's own platform
// average would give. Averaging the per-event averages would not, which is why
// the sum travels alongside the mean.
//
// The contract table is capped because 39k rows is not a payload. Every
// aggregate on the page therefore comes from the event summaries, never from
// the capped rows — otherwise a filtered total would silently describe only the
// top slice of the book.

const MON_HAS_DOM = typeof document !== "undefined"

// Eight categorical slots, assigned in fixed order and never cycled. A ninth
// category shares one neutral swatch rather than getting a generated hue.
const MON_SLOTS = 8

// ── Formatters ────────────────────────────────────────────────────────────────

function monMoney(value, { compact = true } = {}) {
  if (value === null || value === undefined || !isFinite(value)) return null
  const n = Number(value)
  const abs = Math.abs(n)
  if (!compact || abs < 1000) {
    return `$${n.toLocaleString("en-US", { minimumFractionDigits: abs < 1000 && abs % 1 !== 0 ? 2 : 0, maximumFractionDigits: 2 })}`
  }
  if (abs < 1e6) return `$${(n / 1e3).toFixed(abs < 1e4 ? 1 : 0)}K`
  if (abs < 1e9) return `$${(n / 1e6).toFixed(2)}M`
  return `$${(n / 1e9).toFixed(2)}B`
}

function monCount(value) {
  if (value === null || value === undefined || !isFinite(value)) return null
  const n = Number(value)
  if (Math.abs(n) >= 1e5) return `${(n / 1e3).toFixed(1)}K`
  return n.toLocaleString("en-US")
}

function monPct(fraction, { digits = 0, signed = false } = {}) {
  if (fraction === null || fraction === undefined || !isFinite(fraction)) return null
  const pct = Number(fraction) * 100
  const body = `${Math.abs(pct).toFixed(digits)}%`
  if (!signed) return `${pct < 0 ? "−" : ""}${body}`
  return `${pct < 0 ? "−" : "+"}${body}`
}

function monPrice(value, digits = 2) {
  if (value === null || value === undefined || !isFinite(value)) return null
  return Number(value).toFixed(digits)
}

function monSpread(value) {
  if (value === null || value === undefined || !isFinite(value)) return null
  const n = Number(value)
  return `${n < 0 ? "−" : ""}$${Math.abs(n).toFixed(3)}`
}

// ── Volume series ─────────────────────────────────────────────────────────────

// The hourly feed carries a per-category breakdown, so the chart stacks it
// rather than plotting one undifferentiated total. Stacked bands are the
// ADJACENT-pair case — a band only ever touches the one below and above it —
// which the eight-slot categorical order passes on this page's surfaces. That
// is why the palette is legitimate here and was not in the treemap, where any
// block can touch any other.
const MON_VOLUME_SLOTS = 8

function monVolumeSeries(history) {
  const named = (history.categories || []).map((c) => c.name)
  if (!named.length) return []

  // Slots go to the largest categories in a fixed order; the tail shares one
  // neutral band rather than a generated ninth hue.
  const slotted = named.slice(0, MON_VOLUME_SLOTS)
  const series = slotted.map((name, i) => ({ name, color: `var(--series-${i + 1})` }))
  if (named.length > MON_VOLUME_SLOTS) {
    series.push({ name: "Other", color: "var(--series-other)", rest: named.slice(MON_VOLUME_SLOTS) })
  }
  return series
}

// Value of one series in one hour. "Other" is the sum of everything past the
// eight slots, so the stack always adds up to the hour's real total.
function monSeriesValue(bucket, series) {
  const by = bucket.byCategory || {}
  if (!series.rest) return by[series.name] || 0
  return series.rest.reduce((sum, name) => sum + (by[name] || 0), 0)
}

// ── Tile shading ──────────────────────────────────────────────────────────────

// The heat map used to colour tiles by category identity. That was wrong: any
// block in a treemap can touch any other, so it is an "all pairs" colour form,
// and eight categorical hues do not survive it — on this page's own surfaces
// the validator puts magenta against aqua at a CVD ΔE of 1.6 (indistinguishable
// to a deuteranope) and red against orange at 7.1 for NORMAL vision, which is
// the floor that direct labels do not excuse.
//
// Identity was never carried by hue anyway: each category block is labelled
// with its own name and total. So hue is spent on a second variable instead —
// quote coverage, as one sequential ramp — which makes the panel diagnostic
// rather than decorative: a large, strongly shaded block is a lot of volume
// sitting on a poorly quoted book, which is the whole point of the dashboard.
function monTileCoverage(event) {
  if (!event || !event.contractsListed) return null
  return event.contractsQuoted / event.contractsListed
}

// Strong shading means "more attention needed", matching the category matrix.
// A tile is visible because of --tile-base, not because of the shading, so the
// ramp can start at almost nothing: a well-quoted market reads as neutral and
// only the thinly quoted ones glow. Starting higher tinted the whole panel
// orange and buried the signal in it.
function monTileBg(coverage) {
  const deficit = coverage === null || coverage === undefined ? 0 : 1 - coverage
  const alpha = Number((0.05 + 0.62 * Math.max(0, Math.min(1, deficit))).toFixed(3))
  return `linear-gradient(rgba(var(--heat-hue), ${alpha}), rgba(var(--heat-hue), ${alpha})), var(--tile-base)`
}

// Kept in step with OVERROUND_MIN_SAMPLE / overroundExclusionKey in
// lib/monitor.js, so a filtered slice reaches the same verdict the server does.
const MON_OVERROUND_MIN_SAMPLE = 10

function monOverroundExclusionKey(event) {
  if (event.overroundPlausible) return null
  if (event.overroundEligible) return "implausible"
  const reason = event.overroundReason || ""
  if (reason.includes("single-winner")) return "notSingleWinner"
  if (reason.includes("not every outcome")) return "legUnquoted"
  if (reason.includes("fewer than two")) return "tooFewContracts"
  return "other"
}

// ── Rollups ───────────────────────────────────────────────────────────────────

// Re-rolls a list of event summaries into the same shape the server produces.
// Kept arithmetically identical to lib/monitor.js finishRollup — a filtered
// total that disagrees with the unfiltered one would be worse than no filter.
function monRollup(events) {
  const acc = {
    events: 0, liveEvents: 0, contractsListed: 0, contractsQuoted: 0, contractsTwoSided: 0,
    crossed: 0, spreadSum: 0, overroundSum: 0, overroundEligibleEvents: 0,
    overroundImplausibleEvents: 0, overroundMaxLegs: 0, dutchBooks: 0,
    volume: 0, volumeEvents: 0, expiring24h: 0,
  }
  const fields = new Set()
  acc.overroundExcluded = { notSingleWinner: 0, legUnquoted: 0, tooFewContracts: 0, implausible: 0, other: 0 }

  for (const e of events || []) {
    acc.events += 1
    if (e.live) acc.liveEvents += 1
    acc.contractsListed += e.contractsListed || 0
    acc.contractsQuoted += e.contractsQuoted || 0
    acc.contractsTwoSided += e.contractsTwoSided || 0
    acc.crossed += e.crossed || 0
    acc.spreadSum += e.spreadSum || 0
    // Only events the server marked plausible enter the average — see
    // OVERROUND_PLAUSIBLE_LIMIT in lib/monitor.js. The rest are counted so the
    // page can say how many were set aside rather than quietly dropping them.
    if (e.overroundPlausible) {
      acc.overroundSum += e.overround
      acc.overroundEligibleEvents += 1
      acc.overroundMaxLegs = Math.max(acc.overroundMaxLegs, e.contractsListed || 0)
      if (e.dutchBook) acc.dutchBooks += 1
    } else {
      if (e.overroundEligible && e.overround !== null && e.overround !== undefined) {
        acc.overroundImplausibleEvents += 1
      }
      const key = monOverroundExclusionKey(e)
      if (key) acc.overroundExcluded[key] += 1
    }
    if (e.volume !== null && e.volume !== undefined) {
      acc.volume += e.volume
      acc.volumeEvents += 1
      if (e.volumeField) fields.add(e.volumeField)
    }
    if (e.expiringSoon) acc.expiring24h += 1
  }

  return {
    events: acc.events,
    liveEvents: acc.liveEvents,
    contractsListed: acc.contractsListed,
    contractsQuoted: acc.contractsQuoted,
    contractsTwoSided: acc.contractsTwoSided,
    crossed: acc.crossed,
    coverage: acc.contractsListed ? acc.contractsQuoted / acc.contractsListed : null,
    avgSpread: acc.contractsTwoSided ? acc.spreadSum / acc.contractsTwoSided : null,
    avgOverround: acc.overroundEligibleEvents ? acc.overroundSum / acc.overroundEligibleEvents : null,
    overroundEligibleEvents: acc.overroundEligibleEvents,
    overroundImplausibleEvents: acc.overroundImplausibleEvents,
    overroundExcluded: acc.overroundExcluded,
    overroundMaxLegs: acc.overroundMaxLegs,
    // Mirrors lib/monitor.js: an average over a handful of events is not a
    // platform figure, and live data makes that the normal case.
    overroundRepresentative: acc.overroundEligibleEvents >= MON_OVERROUND_MIN_SAMPLE,
    dutchBooks: acc.dutchBooks,
    volume: acc.volumeEvents ? acc.volume : null,
    volumeEvents: acc.volumeEvents,
    volumeField: fields.has("volume") ? "volume" : (fields.has("volume24h") ? "volume24h" : null),
    expiring24h: acc.expiring24h,
  }
}

function monRollupByCategory(events) {
  const groups = new Map()
  for (const e of events || []) {
    const key = e.category || "Uncategorized"
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(e)
  }
  return [...groups.entries()]
    .map(([category, list]) => ({ category, ...monRollup(list) }))
    .sort((a, b) => (b.volume || 0) - (a.volume || 0) || b.contractsListed - a.contractsListed)
}

// ── Filters ───────────────────────────────────────────────────────────────────

const MON_DAY_MS = 86400000

// Event-level filters. These scope every aggregate, the heat map and the table,
// because they can be applied to the uncapped event summaries exactly.
function monFilterEvents(events, filters, now) {
  const f = filters || {}
  const at = now === undefined ? Date.now() : now
  return (events || []).filter((e) => {
    if (f.category && e.category !== f.category) return false
    if (f.expiry) {
      const t = e.expiry ? Date.parse(e.expiry) : NaN
      if (!isFinite(t)) return false
      const window = f.expiry === "24h" ? MON_DAY_MS : 7 * MON_DAY_MS
      if (t <= at || t - at > window) return false
    }
    return true
  })
}

// Contract-level filters. These only narrow the table, never an aggregate — the
// rows they run over are a capped slice of the book.
function monFilterRows(rows, filters) {
  const f = filters || {}
  const needle = String(f.search || "").trim().toLowerCase()
  return (rows || []).filter((r) => {
    if (f.category && r.category !== f.category) return false

    if (f.quote === "two" && !(r.bid !== null && r.ask !== null)) return false
    if (f.quote === "one" && !((r.bid === null) !== (r.ask === null))) return false
    if (f.quote === "none" && (r.bid !== null || r.ask !== null)) return false

    if (f.spread) {
      const s = r.spread
      if (f.spread === "crossed") { if (!(s !== null && s < 0)) return false }
      else if (s === null || s < 0) return false
      else if (f.spread === "tight" && !(s <= 0.02)) return false
      else if (f.spread === "mid" && !(s > 0.02 && s <= 0.10)) return false
      else if (f.spread === "wide" && !(s > 0.10)) return false
    }

    if (needle) {
      const haystack = `${r.event || ""} ${r.contract || ""} ${r.symbol || ""} ${r.category || ""}`.toLowerCase()
      if (!haystack.includes(needle)) return false
    }
    return true
  })
}

// ── Squarified treemap ────────────────────────────────────────────────────────
// Squarified layout (Bruls, Huizing & van Wijk): fill the shorter side of the
// remaining rectangle with a row of tiles, choosing the row length that keeps
// aspect ratios closest to square. Long thin slivers are unreadable and cannot
// carry a label, which is the whole reason not to use a naive slice-and-dice.

function monWorstRatio(row, rowValue, rowArea, side) {
  if (!rowValue || !side) return Infinity
  const thickness = rowArea / side
  let worst = 0
  for (const item of row) {
    const length = side * (item.value / rowValue)
    if (!length || !thickness) return Infinity
    worst = Math.max(worst, thickness / length, length / thickness)
  }
  return worst
}

function monSquarify(items, rect) {
  const out = []
  let remaining = (items || []).filter((i) => i && i.value > 0).sort((a, b) => b.value - a.value)
  if (!remaining.length || rect.w <= 0 || rect.h <= 0) return out

  let { x, y, w, h } = rect
  let total = remaining.reduce((a, b) => a + b.value, 0)

  while (remaining.length && w > 0.5 && h > 0.5 && total > 0) {
    const side = Math.min(w, h)
    const scale = (w * h) / total

    const row = []
    let rowValue = 0
    let bestRatio = Infinity

    for (const item of remaining) {
      const nextValue = rowValue + item.value
      const ratio = monWorstRatio(row.concat(item), nextValue, nextValue * scale, side)
      if (!row.length || ratio <= bestRatio) {
        row.push(item)
        rowValue = nextValue
        bestRatio = ratio
      } else break
    }

    const thickness = Math.min(rowValue * scale / side, w <= h ? h : w)
    let offset = 0
    for (const item of row) {
      const length = side * (item.value / rowValue)
      if (w <= h) out.push({ ...item, x: x + offset, y, w: length, h: thickness })
      else out.push({ ...item, x, y: y + offset, w: thickness, h: length })
      offset += length
    }

    if (w <= h) { y += thickness; h -= thickness } else { x += thickness; w -= thickness }
    remaining = remaining.slice(row.length)
    total -= rowValue
  }

  return out
}

// Category blocks first, then the events inside each — so the reader sees the
// category shape before the individual markets, the way the matrix groups them.
function monTreemapLayout(events, rect, { labelBand = 15, maxPerCategory = 28 } = {}) {
  const byCategory = new Map()
  for (const e of events || []) {
    if (!(e.volume > 0)) continue
    const key = e.category || "Uncategorized"
    if (!byCategory.has(key)) byCategory.set(key, [])
    byCategory.get(key).push(e)
  }

  const blocks = monSquarify(
    [...byCategory.entries()].map(([category, list]) => ({
      key: category,
      value: list.reduce((a, b) => a + b.volume, 0),
    })),
    rect)

  const groups = []
  const tiles = []

  for (const block of blocks) {
    const list = (byCategory.get(block.key) || []).slice().sort((a, b) => b.volume - a.volume)
    groups.push({ category: block.key, value: block.value, x: block.x, y: block.y, w: block.w, h: block.h })

    // A long tail of sub-pixel tiles is noise; it becomes one "+N markets" tile
    // that is still hoverable and still sums to the truth. The cap is generous
    // because a tight one made the rollup the largest tile in a busy category —
    // 509 of Sports' 522 markets in a single block — which buried the very
    // markets the panel exists to surface. Where the tail really does carry
    // most of a category's volume, a dominant rollup tile is the honest answer
    // and says so on its face.
    let items = list.map((e) => ({ key: e.ticker || e.title, value: e.volume, event: e }))
    if (items.length > maxPerCategory) {
      const head = items.slice(0, maxPerCategory - 1)
      const tail = items.slice(maxPerCategory - 1)
      head.push({
        key: `__other__${block.key}`,
        value: tail.reduce((a, b) => a + b.value, 0),
        rollup: { count: tail.length, category: block.key },
      })
      items = head
    }

    const inner = {
      x: block.x + 1,
      y: block.y + labelBand,
      w: Math.max(0, block.w - 2),
      h: Math.max(0, block.h - labelBand - 1),
    }
    for (const tile of monSquarify(items, inner)) tiles.push({ ...tile, category: block.key })
  }

  return { groups, tiles }
}

// ── CSV ───────────────────────────────────────────────────────────────────────

const MON_CSV_COLUMNS = [
  ["event", "Event"], ["eventTicker", "Event ticker"], ["category", "Category"],
  ["contract", "Contract"], ["symbol", "Symbol"], ["bid", "Bid"], ["ask", "Ask"],
  ["last", "Last"], ["spread", "Spread"], ["expiry", "Expiry"], ["eventVolume", "Event volume"],
]

// A leading =, +, - or @ makes a spreadsheet treat the cell as a formula, so
// those are prefixed with a quote. Everything else is plain RFC4180 quoting.
function monCsvCell(value) {
  if (value === null || value === undefined) return ""
  let text = String(value)
  if (/^[=+\-@]/.test(text)) text = `'${text}`
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function monCsv(rows) {
  const header = MON_CSV_COLUMNS.map(([, label]) => monCsvCell(label)).join(",")
  const body = (rows || []).map((r) => MON_CSV_COLUMNS.map(([key]) => monCsvCell(r[key])).join(","))
  return [header, ...body].join("\n")
}

// ── Heat scales ───────────────────────────────────────────────────────────────
// Alpha over the card surface, so the ramp is monotonic in lightness by
// construction in both themes. `t` is always relative to the largest value
// currently visible, and the legend says so — these are not absolute grades.

function monHeatAlpha(t) {
  const clamped = Math.max(0, Math.min(1, isFinite(t) ? t : 0))
  return Number((0.05 + 0.5 * clamped).toFixed(3))
}

function monAttentionBg(t) {
  if (t === null || t === undefined || !isFinite(t)) return "transparent"
  return `rgba(var(--heat-hue), ${monHeatAlpha(t)})`
}

// Positions a value within the range actually on screen, rather than as a
// fraction of the largest value. Dividing by the max shaded every category's
// spread near-full orange when the real range was $0.045 to $0.067 — a narrow,
// healthy spread of values that read as an alarm. Against the range, the same
// column shows the ranking it is there to show.
//
// A range of zero shades nothing: when every category is equally fine there is
// no "worst" to point at, and inventing one would be the same overstatement in
// the other direction.
function monRangeScale(values) {
  const usable = (values || []).filter((v) => v !== null && v !== undefined && isFinite(v))
  if (usable.length < 2) return () => null
  const min = Math.min(...usable)
  const max = Math.max(...usable)
  if (!(max > min)) return () => null
  return (value) => (value === null || value === undefined || !isFinite(value)
    ? null
    : (value - min) / (max - min))
}

// Diverging: red arm for a negative overround (a dutch book), blue arm for
// positive margin, the neutral card showing through at zero.
function monDivergingBg(value, maxAbs) {
  if (value === null || value === undefined || !isFinite(value) || !maxAbs) return "transparent"
  const t = Math.min(1, Math.abs(value) / maxAbs)
  const hue = value < 0 ? "var(--div-neg-hue)" : "var(--div-pos-hue)"
  return `rgba(${hue}, ${monHeatAlpha(t)})`
}

// ════════════════════════════════════════════════════════════════════════════
// Everything below touches the DOM.
// ════════════════════════════════════════════════════════════════════════════

let _mon = null              // last successful snapshot
let _monSort = { key: "spread", dir: "desc" }
let _monLoading = false
let _monResizeTimer = null

const MON_ESC = (v) => (typeof esc === "function" ? esc(v) : String(v == null ? "" : v))

function monFilters() {
  if (!MON_HAS_DOM) return {}
  const get = (id) => (document.getElementById(id) || {}).value || ""
  return {
    category: get("fCategory"),
    expiry: get("fExpiry"),
    quote: get("fQuote"),
    spread: get("fSpread"),
    search: get("fSearch"),
  }
}

function monSetLive(state, text) {
  const pill = document.getElementById("livePill")
  const label = document.getElementById("liveText")
  if (pill) pill.className = `live-pill${state ? ` ${state}` : ""}`
  if (label) label.textContent = text
}

async function monFetchSnapshot() {
  // Production publishes the monitor sweep at /api/monitor via a rewrite; the
  // rewrite destination is the fallback so a deploy without it still works.
  const paths = ["/api/monitor", "/api/gemini-events?view=monitor"]
  let lastError = null
  for (const path of paths) {
    try {
      const res = await fetch(path)
      const body = await res.json().catch(() => null)
      if (res.ok && body && !body.error) return body
      lastError = (body && body.error) || `HTTP ${res.status}`
      if (res.status !== 404) break
    } catch (err) {
      lastError = err.message
    }
  }
  throw new Error(lastError || "the monitor sweep could not be reached")
}

async function monLoad() {
  if (_monLoading) return
  _monLoading = true
  const btn = document.getElementById("btnRefresh")
  if (btn) btn.disabled = true
  monSetLive("", _mon ? "Refreshing" : "Loading")
  document.querySelectorAll(".panel, .kpi-grid").forEach((el) => el.classList.add("refreshing"))

  try {
    const snapshot = await monFetchSnapshot()
    _mon = snapshot
    monPopulateCategories(snapshot.categories)
    monRender()
    const at = snapshot.generatedAt ? new Date(snapshot.generatedAt) : new Date()
    monSetLive(snapshot.complete === false ? "stale" : "", `Updated ${at.toLocaleTimeString()}`)
  } catch (err) {
    monSetLive("failed", "Sweep failed")
    monRenderAlerts([{ level: "err", text: `The monitor sweep failed: ${err.message}` }])
    if (!_mon) {
      const grid = document.getElementById("kpiGrid")
      if (grid) grid.innerHTML = `<div class="empty">No data to show — the public event feed did not answer.</div>`
    }
  } finally {
    _monLoading = false
    if (btn) btn.disabled = false
    document.querySelectorAll(".refreshing").forEach((el) => el.classList.remove("refreshing"))
  }
}

function monRefresh() { monLoad() }
function monFilterChanged() { if (_mon) monRender() }

function monClearFilters() {
  ["fCategory", "fExpiry", "fQuote", "fSpread", "fSearch"].forEach((id) => {
    const el = document.getElementById(id)
    if (el) el.value = ""
  })
  monFilterChanged()
}

function monPopulateCategories(categories) {
  const select = document.getElementById("fCategory")
  if (!select) return
  const current = select.value
  const names = [...(categories || [])].map((c) => c.category).sort((a, b) => a.localeCompare(b))
  select.innerHTML = `<option value="">All categories</option>` +
    names.map((n) => `<option value="${MON_ESC(n)}">${MON_ESC(n)}</option>`).join("")
  if (names.includes(current)) select.value = current
}

function monRenderAlerts(extra) {
  const host = document.getElementById("monAlerts")
  if (!host) return
  const items = [...(extra || [])]

  if (_mon) {
    if (_mon.complete === false) {
      items.push({
        level: "warn",
        text: (_mon.warnings && _mon.warnings[0]) ||
          "The event sweep did not finish, so every count below is a floor, not a total.",
      })
    }
    const vh = _mon.volumeHistory
    if (vh && vh.available && vh.nestedRowsSkipped > 0 && vh.buckets && !vh.buckets.length) {
      items.push({ level: "warn", text: "The hourly volume feed carried only nested category rows, with no top-level totals to sum." })
    }
    if (vh && vh.available && vh.unresolved > 0) {
      items.push({
        level: "warn",
        text: `${vh.unresolved} hourly volume entr${vh.unresolved === 1 ? "y" : "ies"} carried no readable hour and are missing from the chart. ` +
          "The chart's total covers only what could be placed on a real time axis.",
      })
    }
    if (vh && vh.available && (vh.missingDays || []).length) {
      items.push({
        level: "warn",
        text: `No hourly volume for ${vh.missingDays.map((d) => d.date).join(", ")} — the chart covers the days that answered.`,
      })
    }
    if (_mon.totals && _mon.totals.volumeField === "volume") {
      items.push({
        level: "warn",
        text: "At least one event reported only cumulative volume, not a 24-hour figure. " +
          "The volume totals below are labelled “cumulative” because mixing the two would misstate both.",
      })
    }
  }

  host.innerHTML = items
    .map((i) => `<div class="mon-warn${i.level === "err" ? " err" : ""}">${MON_ESC(i.text)}</div>`)
    .join("")
}

// ── Render ────────────────────────────────────────────────────────────────────

function monRender() {
  if (!_mon) return
  const filters = monFilters()
  const events = monFilterEvents(_mon.events, filters)
  const totals = monRollup(events)
  const categories = monRollupByCategory(events)
  const rows = monFilterRows(_mon.rows, filters)

  // Reveal the panels BEFORE drawing into them. A hidden element measures
  // clientWidth 0, so the heat map fell back to a 900px layout and then — being
  // absolutely positioned rather than scaled by a viewBox — kept it, leaving a
  // dead band down the right of a 1500px panel on every first load.
  const filterRow = document.getElementById("monFilters")
  if (filterRow) filterRow.hidden = false
  ;["panelHeat", "panelVolume", "panelMatrix", "panelContracts"].forEach((id) => {
    const el = document.getElementById(id)
    if (el) el.hidden = false
  })

  monRenderAlerts()
  monRenderKpis(totals)
  monRenderHeat(events, totals)
  monRenderVolume()
  monRenderMatrix(categories, totals)
  monRenderDutch(events)
  monRenderContracts(rows, filters)
}

function monRepaint() {
  if (_mon) monRender()
}

function monKpi({ label, value, sub, tip, state }) {
  const na = value === null || value === undefined
  return `<div class="kpi">
    <div class="kpi-label">${MON_ESC(label)}${tip ? `<span class="info" title="${MON_ESC(tip)}" aria-label="${MON_ESC(tip)}">i</span>` : ""}</div>
    <div class="kpi-value${na ? " na" : state ? ` ${state}` : ""}">${na ? "Not available" : MON_ESC(value)}</div>
    <div class="kpi-sub">${MON_ESC(sub || "")}</div>
  </div>`
}

// Overround needs its own tile builder because the honest answer is usually
// "not enough eligible events", and that has to be said rather than papered
// over with an average of one.
function monOverroundKpi(totals) {
  const excluded = totals.overroundExcluded || {}
  const why = [
    [excluded.legUnquoted, "a leg is unquoted"],
    [excluded.notSingleWinner, "multi-winner"],
    [excluded.tooFewContracts, "single-contract"],
    [excluded.implausible, "outside ±100%"],
  ].filter(([n]) => n > 0).map(([n, label]) => `${monCount(n)} ${label}`)

  const tip = "Sum of every outcome's ask, minus $1.00, averaged across events. " +
    "Only single-winner markets (template: categorical) with every leg offered are eligible — a multi-winner " +
    "market has no meaningful sum of asks, and a missing ask read as zero would invent a dutch book. " +
    "Values outside ±100% are set aside as mislabelled rather than averaged in. " +
    `Below ${MON_OVERROUND_MIN_SAMPLE} eligible events no average is shown: it would describe those few markets, not the platform. ` +
    "Read it with the field size in mind — on a large field the sum of asks is inflated by longshots resting at the minimum tick, " +
    "so a wide margin there is a granularity artefact rather than a spread the venue is charging."

  if (!totals.overroundRepresentative) {
    return monKpi({
      label: "Avg overround",
      value: null,
      sub: `Only ${monCount(totals.overroundEligibleEvents)} of ${monCount(totals.events)} events eligible` +
        (why.length ? ` — ${why.join(", ")}` : ""),
      tip,
    })
  }

  return monKpi({
    label: "Avg overround",
    value: monPct(totals.avgOverround, { digits: 1, signed: true }),
    sub: `${monCount(totals.overroundEligibleEvents)} single-winner events eligible` +
      (totals.overroundMaxLegs ? `, up to ${monCount(totals.overroundMaxLegs)} outcomes` : "") +
      (totals.overroundImplausibleEvents ? ` · ${monCount(totals.overroundImplausibleEvents)} set aside` : ""),
    tip,
  })
}

function monRenderKpis(totals) {
  const grid = document.getElementById("kpiGrid")
  if (!grid) return

  const volumeLabel = totals.volumeField === "volume" ? "Cumulative volume" : "24h volume"
  const volumeTip = totals.volumeField === "volume"
    ? "Summed from each event's cumulative volume — the feed did not carry a 24-hour figure for every event, so this is not a 24-hour number."
    : "Summed from each event's reported 24-hour traded notional."

  const tiles = [
    monKpi({
      label: volumeLabel,
      value: monMoney(totals.volume),
      sub: `${monCount(totals.volumeEvents)} of ${monCount(totals.events)} events reported a figure`,
      tip: volumeTip,
    }),
    monKpi({
      label: "Active events",
      value: monCount(totals.liveEvents),
      sub: `${monCount(totals.events)} swept, ${monCount(totals.expiring24h)} expiring in 24h`,
      tip: "An event with at least one contract that is not settled, closed or cancelled.",
    }),
    monKpi({
      label: "Contracts listed",
      value: monCount(totals.contractsListed),
      sub: "Across every active event",
      tip: "Unsettled contracts on the events swept. Settled legs are excluded so they cannot drag coverage down.",
    }),
    monKpi({
      label: "Quote coverage",
      value: monPct(totals.coverage),
      sub: `${monCount(totals.contractsQuoted)} / ${monCount(totals.contractsListed)} with a live quote`,
      tip: "A contract counts as quoted when it carries a positive best bid or best ask. Depth is not available from the public feed, so this measures presence of a quote, not size behind it.",
    }),
    monKpi({
      label: "Avg spread",
      value: monSpread(totals.avgSpread),
      sub: `Over ${monCount(totals.contractsTwoSided)} two-sided books`,
      tip: "Mean of (best ask − best bid) across contracts quoted on both sides. One-sided books have no spread a trader could cross and are excluded rather than counted as zero.",
    }),
    monOverroundKpi(totals),
    monKpi({
      label: "Dutch books",
      value: monCount(totals.dutchBooks),
      sub: totals.dutchBooks ? "Outcomes offered for under $1.00 in total" : "None in the eligible events",
      state: totals.dutchBooks > 0 ? "critical" : null,
      tip: "Single-winner events whose asks sum to less than $1.00 — buying every outcome would lock in a profit. Counted only where every leg is quoted, so a missing quote can never be mistaken for one.",
    }),
    monKpi({
      label: "Crossed books",
      value: monCount(totals.crossed),
      sub: totals.crossed ? "Contracts quoting a bid above the ask" : "None in the contracts swept",
      state: totals.crossed > 0 ? "warning" : null,
      tip: "A crossed top of book — the best bid sits above the best ask. Counted across every contract in the sweep, not just the rows loaded into the table below.",
    }),
  ]

  grid.innerHTML = tiles.join("")
}

function monRenderHeat(events, totals) {
  const host = document.getElementById("treemap")
  const meta = document.getElementById("heatMeta")
  const legend = document.getElementById("heatLegend")
  if (!host) return

  const withVolume = events.filter((e) => e.volume > 0)
  if (meta) {
    meta.textContent = `${monCount(withVolume.length)} of ${monCount(events.length)} events report volume · ` +
      `${monMoney(totals.volume) || "—"} total`
  }

  if (!withVolume.length) {
    host.innerHTML = `<div class="empty">No event in this slice reports a traded-volume figure, so there is nothing to size the map by.<br>The category matrix below does not depend on volume.</div>`
    if (legend) legend.innerHTML = ""
    return
  }

  // A zero measurement means this ran before layout; defer a frame rather than
  // laying the map out against a guessed width.
  const width = host.clientWidth
  const height = host.clientHeight || 420
  if (!width) {
    requestAnimationFrame(() => { if (_mon) monRenderHeat(events, totals) })
    return
  }
  const { groups, tiles } = monTreemapLayout(withVolume, { x: 0, y: 0, w: width, h: height })

  const groupHtml = groups.map((g) => {
    const showLabel = g.w > 66 && g.h > 24
    return `<div class="tile-group" style="left:${g.x}px;top:${g.y}px;width:${g.w}px;height:${g.h}px">
      ${showLabel ? `<span class="tile-group-label">${MON_ESC(g.category)} · ${MON_ESC(monMoney(g.value))}</span>` : ""}
    </div>`
  }).join("")

  const tileHtml = tiles.map((t, i) => {
    const coverage = t.rollup ? null : monTileCoverage(t.event)
    const label = t.rollup ? `+${t.rollup.count} markets` : (t.event.title || t.event.ticker || "—")

    // Only render text a tile can actually hold. A clipped label is worse than
    // none — the value is always in the contracts table below — so the line
    // count is derived from the tile's real height rather than guessed, and the
    // value line is dropped before the label is.
    const LINE = 14
    const PAD = 12
    const showValue = t.h >= PAD + LINE * 2
    const labelLines = Math.floor((t.h - PAD - (showValue ? LINE : 0)) / LINE)
    const showLabel = t.w > 58 && labelLines >= 1

    const coverageText = coverage === null ? "" : `, ${monPct(coverage)} quoted`
    return `<div class="tile" style="left:${t.x}px;top:${t.y}px;width:${t.w}px;height:${t.h}px;background:${monTileBg(coverage)}"
      data-tile="${i}" tabindex="0" role="img"
      aria-label="${MON_ESC(`${label}, ${t.category}, ${monMoney(t.value)}${coverageText}`)}">
      ${showLabel ? `<div class="tile-label" style="-webkit-line-clamp:${Math.min(3, labelLines)}">${MON_ESC(label)}</div>` : ""}
      ${showLabel && showValue ? `<div class="tile-value">${MON_ESC(monMoney(t.value))}</div>` : ""}
    </div>`
  }).join("")

  host.innerHTML = groupHtml + tileHtml
  monWireTreemapTips(host, tiles)

  if (legend) {
    // One sequential scale, not eight identities — so this is a scale legend.
    // Category names are printed on the blocks themselves.
    legend.innerHTML = `<span class="legend-item">Area = traded volume · shading = quote coverage:</span>
      <span class="legend-item">fully quoted</span>
      <span class="scale-steps">${[1, 0.75, 0.5, 0.25, 0].map((c) =>
        `<span class="scale-step" style="background:${monTileBg(c)}"></span>`).join("")}</span>
      <span class="legend-item">unquoted</span>`
  }
}

function monWireTreemapTips(host, tiles) {
  const tip = document.getElementById("heatTip")
  if (!tip) return

  const show = (el) => {
    const tile = tiles[Number(el.getAttribute("data-tile"))]
    if (!tile) return
    const e = tile.event
    tip.innerHTML = tile.rollup
      ? `<b>${MON_ESC(tile.rollup.count)} smaller ${MON_ESC(tile.rollup.category)} markets</b><br>${MON_ESC(monMoney(tile.value))} combined`
      : `<b>${MON_ESC(e.title || e.ticker)}</b><br>
         ${MON_ESC(e.category)} · ${MON_ESC(monMoney(e.volume))}<br>
         ${MON_ESC(monCount(e.contractsListed))} contracts · ${MON_ESC(monPct(monTileCoverage(e)) || "—")} quoted<br>
         Avg spread ${MON_ESC(monSpread(e.avgSpread) || "—")}${e.overroundEligible ? ` · overround ${MON_ESC(monPct(e.overround, { digits: 1, signed: true }))}` : ""}`
    const box = host.getBoundingClientRect()
    const cell = el.getBoundingClientRect()
    tip.style.left = `${Math.min(Math.max(0, cell.left - box.left + cell.width / 2), box.width - 240)}px`
    tip.style.top = `${Math.max(0, cell.top - box.top - 8)}px`
    tip.classList.add("on")
  }
  const hide = () => tip.classList.remove("on")

  host.querySelectorAll("[data-tile]").forEach((el) => {
    el.addEventListener("mouseenter", () => show(el))
    el.addEventListener("focus", () => show(el))
    el.addEventListener("mouseleave", hide)
    el.addEventListener("blur", hide)
  })
}

function monRenderVolume() {
  const wrap = document.getElementById("volWrap")
  const meta = document.getElementById("volMeta")
  const desc = document.getElementById("volDesc")
  if (!wrap) return

  const history = _mon.volumeHistory || {}
  if (!history.available || !(history.buckets || []).length) {
    wrap.innerHTML = `<div class="empty">Hourly volume is not available right now.<br>
      <span class="sub">${MON_ESC(history.reason || "the volume endpoint did not return a series this page could read")}</span></div>`
    if (meta) meta.textContent = ""
    return
  }

  const buckets = history.buckets
  if (meta) {
    meta.textContent = `${monCount(history.days.length)} completed UTC days · ${monMoney(history.total) || "—"} total`
  }
  if (desc) {
    desc.textContent = `Completed UTC days, hourly. Today is excluded — the volume endpoint only publishes a day once it has closed.`
  }

  const width = Math.max(320, wrap.clientWidth)
  const height = 260
  if (!wrap.clientWidth) {
    requestAnimationFrame(() => { if (_mon) monRenderVolume() })
    return
  }
  const pad = { top: 12, right: 12, bottom: 28, left: 62 }
  const plotW = width - pad.left - pad.right
  const plotH = height - pad.top - pad.bottom

  // The time axis comes from the REQUESTED window, not from the timestamps that
  // came back. Deriving it from the data let one misread hour field stretch the
  // axis to ~33 days and crush seven day labels into the left fifth of the plot,
  // while the series still looked plausible.
  const xMin = history.window ? Date.parse(history.window.start) : buckets[0].hour
  const xMax = history.window ? Date.parse(history.window.end) : buckets[buckets.length - 1].hour
  const yMax = Math.max(...buckets.map((b) => b.volume)) || 1
  const span = xMax - xMin || 1
  const series = monVolumeSeries(history)

  const px = (h) => pad.left + ((h - xMin) / span) * plotW
  const py = (v) => pad.top + plotH - (v / yMax) * plotH

  // A bucket outside the requested window means the hour was misread upstream of
  // here; it is left off the axis rather than allowed to distort it.
  const plotted = buckets.filter((b) => b.hour >= xMin && b.hour <= xMax)
  if (!plotted.length) {
    wrap.innerHTML = `<div class="empty">The hourly series did not fall inside the ${MON_ESC(history.days.length)} days requested, so there is nothing to plot against a real time axis.</div>`
    return
  }

  // Bands are built bottom-up over a running cumulative, so each one sits on the
  // one below rather than being drawn from the baseline and overlapping it.
  let bandsHtml = ""
  if (series.length) {
    const cumulative = plotted.map(() => 0)
    for (const s of series) {
      const tops = plotted.map((b, i) => cumulative[i] + monSeriesValue(b, s))
      const topEdge = plotted.map((b, i) => `${i ? "L" : "M"}${px(b.hour).toFixed(1)} ${py(tops[i]).toFixed(1)}`).join(" ")
      const bottomEdge = plotted.map((b, i) => `L${px(b.hour).toFixed(1)} ${py(cumulative[i]).toFixed(1)}`)
        .reverse().join(" ")
      bandsHtml +=
        `<path d="${topEdge} ${bottomEdge} Z" fill="${s.color}" opacity="0.85"/>` +
        // A 2px surface-coloured rule along the top edge separates the bands,
        // instead of outlining every mark with a border.
        `<path d="${topEdge}" fill="none" stroke="var(--card)" stroke-width="2" stroke-linejoin="round"/>`
      plotted.forEach((b, i) => { cumulative[i] = tops[i] })
    }
  }

  // No breakdown in the feed: one total series, which needs no legend because
  // the panel title names it.
  const line = plotted.map((b, i) => `${i ? "L" : "M"}${px(b.hour).toFixed(1)} ${py(b.volume).toFixed(1)}`).join(" ")
  const area = `${line} L${px(plotted[plotted.length - 1].hour).toFixed(1)} ${py(0).toFixed(1)} L${px(plotted[0].hour).toFixed(1)} ${py(0).toFixed(1)} Z`
  const totalHtml = series.length
    ? `<path class="series-line" d="${line}" stroke="var(--text-mid)" stroke-width="1.25" opacity="0.5"/>`
    : `<path class="series-fill" d="${area}"/><path class="series-line" d="${line}"/>`

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax)
  const gridHtml = yTicks.map((v) =>
    `<line class="grid-line" x1="${pad.left}" y1="${py(v).toFixed(1)}" x2="${(pad.left + plotW).toFixed(1)}" y2="${py(v).toFixed(1)}"/>
     <text class="tick" x="${pad.left - 8}" y="${(py(v) + 3.5).toFixed(1)}" text-anchor="end">${MON_ESC(monMoney(v))}</text>`
  ).join("")

  // One tick per UTC midnight, thinned so labels cannot overlap however narrow
  // the panel gets: a label is only drawn if it clears the last one it drew.
  const MIN_LABEL_GAP = 62
  let lastLabelX = -Infinity
  const xHtml = history.days
    .map((d) => Date.parse(`${d.date}T00:00:00Z`))
    .filter((t) => t >= xMin && t <= xMax)
    .map((t) => {
      const x = px(t)
      if (x - lastLabelX < MIN_LABEL_GAP) return ""
      lastLabelX = x
      return `<text class="tick" x="${x.toFixed(1)}" y="${height - 9}" text-anchor="middle">${MON_ESC(new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }))}</text>`
    })
    .join("")

  wrap.innerHTML = `<svg class="chart" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img"
      aria-label="Hourly traded volume over the last ${history.days.length} completed UTC days">
      ${gridHtml}
      ${bandsHtml}
      ${totalHtml}
      <line class="axis-line" x1="${pad.left}" y1="${(pad.top + plotH).toFixed(1)}" x2="${(pad.left + plotW).toFixed(1)}" y2="${(pad.top + plotH).toFixed(1)}"/>
      ${xHtml}
      <line class="crosshair" id="volCross" x1="0" y1="${pad.top}" x2="0" y2="${(pad.top + plotH).toFixed(1)}" style="opacity:0"/>
      <circle class="cursor-dot" id="volDot" r="4" cx="0" cy="0" style="opacity:0"/>
      <rect id="volHit" x="${pad.left}" y="${pad.top}" width="${plotW}" height="${plotH}" fill="transparent"/>
    </svg>
    <div class="tip" id="volTip"></div>
    ${series.length ? `<div class="legend">${series.map((s) =>
      `<span class="legend-item"><span class="legend-swatch" style="background:${s.color}"></span>${MON_ESC(s.name)}</span>`
    ).join("")}<span class="legend-item sub">outline = hourly total</span></div>` : ""}`

  monWireChartTips(wrap, plotted, { px, py, pad, plotW }, series)
}

function monWireChartTips(wrap, buckets, geom, series) {
  const hit = wrap.querySelector("#volHit")
  const cross = wrap.querySelector("#volCross")
  const dot = wrap.querySelector("#volDot")
  const tip = wrap.querySelector("#volTip")
  if (!hit || !tip) return

  const nearest = (clientX) => {
    const box = hit.getBoundingClientRect()
    const ratio = (clientX - box.left) / (box.width || 1)
    const target = geom.pad.left + ratio * geom.plotW
    let best = buckets[0]
    let bestDist = Infinity
    for (const b of buckets) {
      const d = Math.abs(geom.px(b.hour) - target)
      if (d < bestDist) { bestDist = d; best = b }
    }
    return best
  }

  const move = (clientX) => {
    const b = nearest(clientX)
    const x = geom.px(b.hour)
    const y = geom.py(b.volume)
    if (cross) { cross.setAttribute("x1", x); cross.setAttribute("x2", x); cross.style.opacity = "1" }
    if (dot) { dot.setAttribute("cx", x); dot.setAttribute("cy", y); dot.style.opacity = "1" }
    const at = new Date(b.hour)
    // Only the categories that actually traded in this hour, largest first —
    // a list of zeroes is noise.
    const breakdown = (series || [])
      .map((s) => ({ name: s.name, value: monSeriesValue(b, s), color: s.color }))
      .filter((r) => r.value > 0)
      .sort((a, c) => c.value - a.value)
      .slice(0, 6)
      .map((r) => `<span class="legend-swatch" style="background:${r.color}"></span>${MON_ESC(r.name)} ${MON_ESC(monMoney(r.value))}`)
      .join("<br>")

    tip.innerHTML = `<b>${MON_ESC(monMoney(b.volume))}</b><br>${MON_ESC(at.toLocaleString("en-US", {
      month: "short", day: "numeric", hour: "numeric", timeZone: "UTC",
    }))} UTC${breakdown ? `<br><span class="tip-rule"></span>${breakdown}` : ""}`
    const box = wrap.getBoundingClientRect()
    const svgBox = hit.getBoundingClientRect()
    tip.style.left = `${Math.min(Math.max(0, svgBox.left - box.left + (x - geom.pad.left) / geom.plotW * svgBox.width - 60), box.width - 170)}px`
    tip.style.top = `${Math.max(0, y - 52)}px`
    tip.classList.add("on")
  }

  hit.addEventListener("mousemove", (e) => move(e.clientX))
  hit.addEventListener("mouseleave", () => {
    tip.classList.remove("on")
    if (cross) cross.style.opacity = "0"
    if (dot) dot.style.opacity = "0"
  })
}

function monRenderMatrix(categories, totals) {
  const table = document.getElementById("matrixTable")
  const meta = document.getElementById("matrixMeta")
  const scale = document.getElementById("matrixScale")
  if (!table) return

  if (meta) {
    meta.textContent = `${monCount(categories.length)} categories · ${monCount(totals.events)} events · ${monCount(totals.contractsListed)} contracts`
  }

  if (!categories.length) {
    table.innerHTML = `<tbody><tr><td class="na">Nothing matches the current filters.</td></tr></tbody>`
    if (scale) scale.innerHTML = ""
    return
  }

  const maxVolume = Math.max(...categories.map((c) => c.volume || 0), 0)
  // Coverage is scaled on its deficit so that "worse" is the strong end, the
  // same direction as spread. Overround keeps an absolute centre at zero —
  // range-scaling a diverging metric would move its midpoint off the one value
  // that means "a fair book".
  const coverageScale = monRangeScale(categories.map((c) => (c.coverage === null ? null : 1 - c.coverage)))
  const spreadScale = monRangeScale(categories.map((c) => c.avgSpread))
  const maxOverround = Math.max(...categories
    .filter((c) => c.overroundRepresentative)
    .map((c) => Math.abs(c.avgOverround || 0)), 0)

  const head = `<thead><tr>
    <th>Category</th>
    <th>Events</th>
    <th>Contracts</th>
    <th>Volume</th>
    <th>Coverage</th>
    <th>Avg spread</th>
    <th>Overround</th>
    <th>Dutch</th>
    <th>Expiring 24h</th>
  </tr></thead>`

  const body = categories.map((c) => {
    const coverageDeficit = c.coverage === null ? null : 1 - c.coverage
    const volumeShare = maxVolume ? (c.volume || 0) / maxVolume : 0
    return `<tr>
      <td class="name">${MON_ESC(c.category)}</td>
      <td>${MON_ESC(monCount(c.events))}</td>
      <td>${MON_ESC(monCount(c.contractsListed))}</td>
      <td>${c.volume === null ? `<span class="na-cell">—</span>` : `${MON_ESC(monMoney(c.volume))}
        <div style="height:4px;margin-top:4px;border-radius:2px;background:var(--series-1);opacity:0.6;width:${Math.max(2, volumeShare * 100).toFixed(1)}%;margin-left:auto"></div>`}</td>
      <td style="background:${monAttentionBg(coverageScale(coverageDeficit))}">${MON_ESC(monPct(c.coverage) || "—")}</td>
      <td style="background:${monAttentionBg(spreadScale(c.avgSpread))}">${MON_ESC(monSpread(c.avgSpread) || "—")}</td>
      <td style="background:${c.overroundRepresentative ? monDivergingBg(c.avgOverround, maxOverround) : "transparent"}">${
        c.avgOverround === null
          ? `<span class="na-cell" title="No single-winner event in this category had every leg quoted">—</span>`
          : c.overroundRepresentative
            ? MON_ESC(monPct(c.avgOverround, { digits: 1, signed: true }))
            : `<span class="na-cell" title="Too few eligible events to average — read the per-event values instead">(${MON_ESC(monPct(c.avgOverround, { digits: 1, signed: true }))})</span>`
      }<div class="sub">${MON_ESC(monCount(c.overroundEligibleEvents))} elig.</div></td>
      <td>${c.dutchBooks ? `<span class="flag critical">⚠ ${MON_ESC(c.dutchBooks)}</span>` : `<span class="na-cell">0</span>`}</td>
      <td>${c.expiring24h ? MON_ESC(monCount(c.expiring24h)) : `<span class="na-cell">—</span>`}</td>
    </tr>`
  }).join("")

  const foot = `<tfoot><tr>
    <td class="name"><strong>All visible</strong></td>
    <td>${MON_ESC(monCount(totals.events))}</td>
    <td>${MON_ESC(monCount(totals.contractsListed))}</td>
    <td>${MON_ESC(monMoney(totals.volume) || "—")}</td>
    <td>${MON_ESC(monPct(totals.coverage) || "—")}</td>
    <td>${MON_ESC(monSpread(totals.avgSpread) || "—")}</td>
    <td>${totals.overroundRepresentative
      ? MON_ESC(monPct(totals.avgOverround, { digits: 1, signed: true }) || "—")
      : `<span class="na-cell">n/a</span>`}</td>
    <td>${MON_ESC(monCount(totals.dutchBooks))}</td>
    <td>${MON_ESC(monCount(totals.expiring24h))}</td>
  </tr></tfoot>`

  table.innerHTML = head + `<tbody>${body}</tbody>` + foot

  if (scale) {
    const steps = [0, 0.25, 0.5, 0.75, 1]
    scale.innerHTML = `
      <span>Coverage &amp; spread shading — stronger means more attention needed, placed within the range currently visible (the printed value is the absolute figure):</span>
      <span class="scale-steps">${steps.map((t) => `<span class="scale-step" style="background:${monAttentionBg(t)}"></span>`).join("")}</span>
      <span>Overround:</span>
      <span class="scale-steps">
        <span class="scale-step" style="background:${monDivergingBg(-1, 1)}" title="negative — dutch book"></span>
        <span class="scale-step" style="background:transparent" title="zero — a fair book"></span>
        <span class="scale-step" style="background:${monDivergingBg(1, 1)}" title="positive margin"></span>
      </span>
      <span class="sub">negative ← 0 → positive. Every shaded value is also printed, so no figure here depends on colour.</span>`
  }
}

function monRenderDutch(events) {
  const panel = document.getElementById("panelDutch")
  const table = document.getElementById("dutchTable")
  const meta = document.getElementById("dutchMeta")
  if (!panel || !table) return

  const books = events.filter((e) => e.dutchBook)
    .sort((a, b) => a.overround - b.overround)

  if (!books.length) {
    panel.hidden = true
    return
  }
  panel.hidden = false
  if (meta) meta.textContent = `${monCount(books.length)} event${books.length === 1 ? "" : "s"}`

  table.innerHTML = `<thead><tr>
      <th>Event</th><th>Category</th><th>Legs</th><th>Sum of asks</th><th>Overround</th><th>Closes</th>
    </tr></thead><tbody>` +
    books.map((e) => `<tr>
      <td class="name">${MON_ESC(e.title)}<div class="sub sym">${MON_ESC(e.ticker || "")}</div></td>
      <td><span class="cat-pill">${MON_ESC(e.category)}</span></td>
      <td>${MON_ESC(monCount(e.contractsListed))}</td>
      <td>${MON_ESC(monPrice(1 + e.overround, 4))}</td>
      <td><span class="flag critical">${MON_ESC(monPct(e.overround, { digits: 2, signed: true }))}</span></td>
      <td>${MON_ESC(monDueText(e.expiry))}</td>
    </tr>`).join("") + `</tbody>`
}

function monDueText(iso) {
  if (!iso) return "—"
  if (typeof fmtTimeRemaining === "function") {
    const t = fmtTimeRemaining(iso)
    if (t && t.text) return t.text.replace("CLOSES IN ", "in ").toLowerCase()
  }
  return new Date(iso).toLocaleString()
}

const MON_CONTRACT_COLUMNS = [
  { key: "event", label: "Event", type: "text" },
  { key: "category", label: "Category", type: "text" },
  { key: "contract", label: "Contract", type: "text" },
  { key: "bid", label: "Bid", type: "num" },
  { key: "ask", label: "Ask", type: "num" },
  { key: "last", label: "Last", type: "num" },
  { key: "spread", label: "Spread", type: "num" },
  { key: "expiry", label: "Expiry", type: "text" },
]

function monSortRows(rows, sort) {
  const col = MON_CONTRACT_COLUMNS.find((c) => c.key === sort.key)
  if (!col) return rows
  const dir = sort.dir === "asc" ? 1 : -1
  return [...rows].sort((a, b) => {
    const x = a[col.key]
    const y = b[col.key]
    // A null is an absent quote, not a small one: it sorts last either way.
    if (x === null || x === undefined) return 1
    if (y === null || y === undefined) return -1
    if (col.type === "num") return (x - y) * dir
    return String(x).localeCompare(String(y)) * dir
  })
}

function monSortBy(key) {
  _monSort = _monSort.key === key
    ? { key, dir: _monSort.dir === "asc" ? "desc" : "asc" }
    : { key, dir: key === "event" || key === "category" || key === "contract" ? "asc" : "desc" }
  monFilterChanged()
}

function monRenderContracts(rows, filters) {
  const table = document.getElementById("contractsTable")
  const meta = document.getElementById("contractsMeta")
  const note = document.getElementById("contractsNote")
  if (!table) return

  const sorted = monSortRows(rows, _monSort)
  const capped = _mon.rowsShown < _mon.rowsTotal
  const anyFilter = Object.values(filters || {}).some(Boolean)

  if (meta) {
    meta.textContent = `${monCount(sorted.length)} row${sorted.length === 1 ? "" : "s"}` +
      (anyFilter ? ` of ${monCount(_mon.rowsShown)} loaded` : "")
  }
  if (note) {
    note.textContent = capped
      ? `Showing the ${monCount(_mon.rowsShown)} widest-spread contracts on the busiest events, out of ${monCount(_mon.rowsTotal)} listed. The totals and the matrix above cover all ${monCount(_mon.rowsTotal)}.`
      : `All ${monCount(_mon.rowsTotal)} listed contracts.`
  }

  if (!sorted.length) {
    table.innerHTML = `<tbody><tr><td class="na">Nothing matches the current filters.</td></tr></tbody>`
    return
  }

  const head = `<thead><tr>${MON_CONTRACT_COLUMNS.map((c) => {
    const active = _monSort.key === c.key
    const arrow = active ? (_monSort.dir === "asc" ? "▲" : "▼") : "↕"
    return `<th class="sortable" tabindex="0" role="button"
      aria-sort="${active ? (_monSort.dir === "asc" ? "ascending" : "descending") : "none"}"
      onclick="monSortBy('${c.key}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();monSortBy('${c.key}')}"
      >${MON_ESC(c.label)}<span class="arrow">${arrow}</span></th>`
  }).join("")}</tr></thead>`

  // Rendering 1500 rows of innerHTML at once is faster than 1500 node builds
  // and the table is replaced wholesale on every sort anyway.
  const body = sorted.slice(0, 1500).map((r) => {
    const oneSided = (r.bid === null) !== (r.ask === null)
    const unquoted = r.bid === null && r.ask === null
    return `<tr>
      <td class="name">${MON_ESC(r.event)}</td>
      <td><span class="cat-pill">${MON_ESC(r.category)}</span></td>
      <td class="name">${MON_ESC(r.contract)}${r.symbol ? `<div class="sub sym">${MON_ESC(r.symbol)}</div>` : ""}</td>
      <td class="${r.bid === null ? "na" : ""}">${MON_ESC(monPrice(r.bid) || "—")}</td>
      <td class="${r.ask === null ? "na" : ""}">${MON_ESC(monPrice(r.ask) || "—")}</td>
      <td class="${r.last === null ? "na" : ""}">${MON_ESC(monPrice(r.last) || "—")}</td>
      <td>${r.spread === null
        ? `<span class="flag warning">${unquoted ? "unquoted" : "one-sided"}</span>`
        : r.spread < 0
          ? `<span class="flag critical">crossed ${MON_ESC(monSpread(r.spread))}</span>`
          : MON_ESC(monSpread(r.spread))}</td>
      <td>${MON_ESC(monDueText(r.expiry))}</td>
    </tr>`
  }).join("")

  table.innerHTML = head + `<tbody>${body}</tbody>`
}

function monExportCsv() {
  if (!_mon) return
  const rows = monSortRows(monFilterRows(_mon.rows, monFilters()), _monSort)
  const blob = new Blob([monCsv(rows)], { type: "text/csv;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `predara-monitor-${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function monInit() {
  if (!MON_HAS_DOM) return
  monLoad()
  // The treemap and the chart are laid out in pixels, so a resize has to
  // re-lay them out rather than letting CSS stretch a stale geometry.
  window.addEventListener("resize", () => {
    clearTimeout(_monResizeTimer)
    _monResizeTimer = setTimeout(() => { if (_mon) monRender() }, 180)
  })
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    monMoney, monCount, monPct, monPrice, monSpread,
    monTileCoverage, monTileBg,
    monVolumeSeries, monSeriesValue, MON_VOLUME_SLOTS,
    monRollup, monRollupByCategory, monOverroundExclusionKey,
    MON_OVERROUND_MIN_SAMPLE,
    monFilterEvents, monFilterRows,
    monSquarify, monTreemapLayout, monWorstRatio,
    monCsv, monCsvCell,
    monHeatAlpha, monAttentionBg, monDivergingBg, monRangeScale,
    monSortRows,
    MON_SLOTS,
  }
}
