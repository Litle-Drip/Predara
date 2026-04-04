// ── Entry point ───────────────────────────────────────────────────────────────
// Depends on: utils.js, components.js, adapters.js, renderers.js, compare.js

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
  const shareBarEl = document.getElementById("shareBar")
  if (shareBarEl) shareBarEl.style.display = "none"

  // Detect platform early for a contextual loading message
  const earlyLower = url.toLowerCase()
  const loadingPlatform = earlyLower.includes("kalshi") ? "KALSHI"
    : earlyLower.includes("polymarket") ? "POLYMARKET"
    : earlyLower.includes("coinbase") ? "COINBASE"
    : earlyLower.includes("gemini") ? "GEMINI"
    : ""
  result.innerHTML = `<div class="mi-loading"><span class="mi-spinner"></span>ANALYZING${loadingPlatform ? " " + loadingPlatform : ""}\u2026</div>`

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
            addShareBar(url)
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
      addShareBar(url)
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
        addShareBar(url)
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
        addShareBar(url)
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
        throw new Error(errData.error || `Gemini API error ${res.status}`)
      }
      const data = await res.json()
      if (!data || (!data.title && !data.contracts && !data.ticker)) throw new Error("No event data returned.")

      result.innerHTML = renderGeminiEvent(data, accent)
      addShareBar(url)
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
