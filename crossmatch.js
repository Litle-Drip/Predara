// ── "Same event on other platforms" ───────────────────────────────────────────
// The compare view can hold three markets, but until now the reader had to find
// all three URLs themselves — on venues that name the same event differently
// enough that searching for it by hand is genuinely hard (the 2026 Spanish
// Grand Prix is listed as the Madrid Grand Prix on one venue and as `thsgp` on
// another). This card does the finding: analyze one market, and the other
// venues' listings for the same event arrive one click from a comparison.
//
// It never picks for the reader. Candidates are shown with the venue's own
// title, its close date, a confidence and the reasons behind it, because a
// silently wrong match would put two different events side by side and call the
// difference an arbitrage. Scoring lives server-side in lib/match.js.

const XMATCH_CONFIDENCE = {
  strong: { label: "STRONG MATCH", color: "var(--green, #00C805)" },
  likely: { label: "LIKELY",       color: "var(--orange, #d94f2b)" },
  weak:   { label: "CHECK THIS",   color: "var(--muted, #888)" },
}

let _xmatchToken = 0

// What the reader currently has open, read back off the rendered page rather
// than threaded through every platform branch of analyze().
function _xmatchSource() {
  const platform = typeof _currentPlatform === "function" ? _currentPlatform() : ""
  const title = typeof _currentTitle === "function" ? _currentTitle() : ""
  if (!platform || !title) return null
  const closeIso = (typeof window !== "undefined" && window._lastCloseIso) || ""
  const outcomes = []
  document.querySelectorAll("#result .outcome-row").forEach(row => {
    const name = typeof _outcomeNameText === "function" ? _outcomeNameText(row) : ""
    if (name) outcomes.push(name)
  })
  return {
    platform,
    title,
    // A close timestamp is an ISO instant; the matcher compares calendar days.
    date: (closeIso.match(/^(\d{4}-\d{2}-\d{2})/) || [])[1] || "",
    outcomes: outcomes.slice(0, 16),
  }
}

function crossMatchCardHtml() {
  const source = _xmatchSource()
  if (!source) return ""
  return `
    <div class="mi-card xmatch-card" id="xmatchCard">
      <div class="section-label">SAME EVENT ON OTHER PLATFORMS</div>
      <div class="xmatch-body" id="xmatchBody">
        <div class="xmatch-status"><span class="mi-spinner"></span>Looking for this event on the other venues…</div>
      </div>
    </div>`
}

async function loadCrossMatches() {
  const body = document.getElementById("xmatchBody")
  const source = _xmatchSource()
  if (!body || !source) return
  const token = ++_xmatchToken

  const params = new URLSearchParams({ platform: source.platform, title: source.title })
  if (source.date) params.set("date", source.date)
  // The pipe is the separator, so an outcome carrying one would split into two
  // names and match against neither.
  if (source.outcomes.length) params.set("outcomes", source.outcomes.map(o => o.replace(/\|/g, "/")).join("|"))

  let payload
  try {
    const res = await fetch(`/api/match?${params}`)
    payload = await res.json()
    if (!res.ok) throw new Error(payload.error || `Match API ${res.status}`)
  } catch (err) {
    if (token !== _xmatchToken) return
    body.innerHTML = `<div class="xmatch-status xmatch-failed">Couldn't search the other venues: ${esc(err.message)}</div>
      ${_xmatchManualLinks(source)}`
    return
  }
  if (token !== _xmatchToken) return
  body.innerHTML = _xmatchResultsHtml(source, payload.results || [])
}

function _xmatchManualLinks(source) {
  const q = encodeURIComponent(source.title.split(/\s+/).slice(0, 5).join(" "))
  const links = []
  if (source.platform !== "kalshi")     links.push(`<a href="https://kalshi.com/markets?search=${q}" target="_blank" rel="noopener" class="xmatch-manual-link">Search Kalshi ↗</a>`)
  if (source.platform !== "polymarket") links.push(`<a href="https://polymarket.com/search?q=${q}" target="_blank" rel="noopener" class="xmatch-manual-link">Search Polymarket ↗</a>`)
  if (source.platform !== "gemini")     links.push(`<a href="https://www.gemini.com/predictions" target="_blank" rel="noopener" class="xmatch-manual-link">Browse Gemini ↗</a>`)
  return links.length ? `<div class="xmatch-manual">${links.join("")}</div>` : ""
}

function _xmatchResultsHtml(source, results) {
  // Held in a module-level map rather than serialized into the onclick, so a
  // venue's own market title can never break out of the attribute it sits in.
  window._xmatchCandidates = {}
  let anyCandidates = false

  const blocks = results.map(r => {
    const meta = PLATFORMS[r.platform] || {}
    const label = meta.label || r.platform.toUpperCase()
    const head = `<span class="tag-platform xmatch-platform" style="background:${meta.accent || "#555"}">${esc(label)}</span>`

    if (r.error) {
      return `<div class="xmatch-venue">${head}<div class="xmatch-none">${esc(r.error)}</div></div>`
    }
    if (!r.candidates || !r.candidates.length) {
      return `<div class="xmatch-venue">${head}<div class="xmatch-none">No matching event found</div></div>`
    }

    const rows = r.candidates.map((c, i) => {
      anyCandidates = true
      const id = `${r.platform}-${i}`
      window._xmatchCandidates[id] = c.url
      const conf = XMATCH_CONFIDENCE[c.confidence] || XMATCH_CONFIDENCE.weak
      const reasons = (c.reasons || []).join(" · ")
      return `<div class="xmatch-row">
        <div class="xmatch-row-main">
          <span class="xmatch-title">${esc(c.title)}</span>
          <span class="xmatch-conf" style="color:${conf.color}">${conf.label}</span>
        </div>
        ${reasons ? `<div class="xmatch-reasons">${esc(reasons)}</div>` : ""}
        <div class="xmatch-actions">
          <button class="xmatch-add-btn" onclick="xmatchAdd('${esc(id)}')">Add to compare ↗</button>
          <a href="${esc(c.url)}" target="_blank" rel="noopener" class="xmatch-open-link">Open on ${esc(label)} ↗</a>
        </div>
      </div>`
    }).join("")

    return `<div class="xmatch-venue">${head}${rows}</div>`
  }).join("")

  // Only "strong" candidates are offered for one-click bulk comparison. A
  // "likely" or "check this" candidate still has to be read and chosen, which
  // is the whole reason those bands exist.
  const strong = []
  results.forEach(r => {
    const best = (r.candidates || []).find(c => c.confidence === "strong")
    if (best) strong.push({ platform: r.platform, url: best.url })
  })
  window._xmatchStrong = strong.map(s => s.url)
  const bulk = strong.length
    ? `<button class="xmatch-all-btn" onclick="xmatchCompareAll()">Compare all ${strong.length + 1} venues ↗</button>`
    : ""

  return `${bulk}${blocks}${anyCandidates ? "" : _xmatchManualLinks(source)}`
}

// Drops a found market into the compare row and runs the comparison. The first
// empty slot is used so a reader can stack a second venue onto a comparison
// they have already started instead of overwriting it.
function xmatchAdd(id) {
  const url = (window._xmatchCandidates || {})[id]
  if (!url) return
  const slots = [document.getElementById("urlInput2"), document.getElementById("urlInput3")].filter(Boolean)
  if (!slots.length) return
  const existing = slots.map(s => s.value.trim())
  if (existing.includes(url)) return _xmatchRunCompare()
  const target = slots.find(s => !s.value.trim()) || slots[0]
  target.value = url
  _xmatchRunCompare()
}

function xmatchCompareAll() {
  const urls = window._xmatchStrong || []
  const slots = [document.getElementById("urlInput2"), document.getElementById("urlInput3")].filter(Boolean)
  slots.forEach((slot, i) => { slot.value = urls[i] || "" })
  _xmatchRunCompare()
}

function _xmatchRunCompare() {
  // The compare inputs must be visible before the comparison runs, or the
  // reader gets a three-way result with no way to see or edit what produced it.
  const section = document.getElementById("compareSection")
  if (section && section.style.display === "none" && typeof toggleCompareMode === "function") {
    toggleCompareMode()
  }
  if (typeof analyzeCompare === "function") analyzeCompare()
}
