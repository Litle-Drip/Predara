// Predara Service Worker — PWA offline shell + price alert polling
const CACHE_NAME = "predara-v1"
const SHELL_URLS = [
  "/",
  "/index.html",
  "/utils.js",
  "/components.js",
  "/adapters.js",
  "/renderers.js",
  "/compare.js",
  "/app.js",
  "/features.js",
  "/og-image.png",
  "/manifest.json",
]

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS))
  )
  self.skipWaiting()
})

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  )
  self.clients.claim()
})

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return
  const url = new URL(e.request.url)
  if (url.pathname.startsWith("/api/")) return
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const fetchPromise = fetch(e.request)
        .then((res) => {
          if (res.ok && url.origin === self.location.origin) {
            const clone = res.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone))
          }
          return res
        })
        .catch(() => cached)
      return cached || fetchPromise
    })
  )
})

// Price alert polling — triggered by periodic sync or message from client
self.addEventListener("message", async (e) => {
  if (e.data && e.data.type === "CHECK_ALERTS") {
    const alerts = e.data.alerts || []
    for (const alert of alerts) {
      try {
        const res = await fetch(alert.fetchUrl)
        if (!res.ok) continue
        const data = await res.json()
        const currentPct = extractPctFromData(data, alert.platform, alert.outcomeName)
        if (currentPct === null) continue
        const triggered =
          (alert.direction === "above" && currentPct >= alert.threshold) ||
          (alert.direction === "below" && currentPct <= alert.threshold)
        if (triggered) {
          self.registration.showNotification("Predara Price Alert", {
            body: `${alert.marketTitle}: "${alert.outcomeName}" is now at ${currentPct}% (threshold: ${alert.direction} ${alert.threshold}%)`,
            icon: "/og-image.png",
            tag: alert.id,
            data: { url: alert.marketUrl },
          })
        }
      } catch {}
    }
  }
})

self.addEventListener("notificationclick", (e) => {
  e.notification.close()
  const url = e.notification.data?.url || "/"
  e.waitUntil(clients.openWindow(url))
})

function extractPctFromData(data, platform, outcomeName) {
  try {
    if (platform === "polymarket") {
      const event = Array.isArray(data) ? data[0] : data
      if (!event) return null
      for (const m of event.markets || []) {
        const outcomes = typeof m.outcomes === "string" ? JSON.parse(m.outcomes) : m.outcomes
        const prices = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices
        if (!outcomes || !prices) continue
        const idx = outcomes.findIndex((o) => o.toLowerCase() === outcomeName.toLowerCase())
        if (idx >= 0) return Math.round(parseFloat(prices[idx]) * 100)
      }
    }
    if (platform === "kalshi") {
      const markets = data.event?.markets || (data.market ? [data.market] : [])
      for (const m of markets) {
        if ((m.yes_sub_title || "").toLowerCase() === outcomeName.toLowerCase()) {
          return Math.round(parseFloat(m.last_price_dollars || 0) * 100)
        }
      }
    }
  } catch {}
  return null
}
