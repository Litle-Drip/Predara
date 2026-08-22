// Predara Service Worker — PWA offline shell
// Bumped so returning users get the corrected betting math rather than a
// cached bundle that still prices off the midpoint.
const CACHE_NAME = "predara-v2"
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

// Alert checking lives in the page (startAlertPoller in features.js), not here.
// A CHECK_ALERTS message handler used to sit at this spot, but nothing ever
// posted that message and no periodic sync was ever registered, so it was dead
// code that made background alerts look implemented when they were not.

self.addEventListener("notificationclick", (e) => {
  e.notification.close()
  const url = e.notification.data?.url || "/"
  e.waitUntil(clients.openWindow(url))
})
