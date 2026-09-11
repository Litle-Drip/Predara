// Predara Service Worker — PWA offline shell
//
// Bump CACHE_NAME on any change that returning users must not miss. The
// previous bump went with the ?v= fix that actually delivers changed scripts to
// returning readers; this one carries the cross-venue search fix and the
// polymarket.us copy. Bump this and the ?v= in index.html together, always —
// see tests/asset-versions.test.js.
const CACHE_NAME = "predara-v12"

// Pages, cached so the app opens offline — but always fetched fresh first when
// the network is there. See the navigation rule in the fetch handler.
const PAGE_URLS = [
  "/",
  "/index.html",
  "/settlement.html",
  "/kyle.html",
]

const ASSET_URLS = [
  "/utils.js",
  "/components.js",
  "/adapters.js",
  "/renderers.js",
  "/compare.js",
  "/crossmatch.js",
  "/gemini-live.js",
  "/app.js",
  "/features.js",
  "/kyle.js",
  "/og-image.png",
  "/manifest.json",
]

const SHELL_URLS = PAGE_URLS.concat(ASSET_URLS)

// A page request — the browser asking for a document, not for a script or an
// image. `mode: "navigate"` covers every way a user reaches a page: typing a
// URL, a bookmark, and clicking a link from another page.
function isPageRequest(request, url) {
  return request.mode === "navigate" || (request.destination === "document") ||
    url.pathname.endsWith(".html") || url.pathname === "/"
}

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

function putInCache(request, response) {
  if (response && response.ok) {
    const clone = response.clone()
    caches.open(CACHE_NAME).then((cache) => cache.put(request, clone))
  }
  return response
}

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return
  const url = new URL(e.request.url)
  if (url.pathname.startsWith("/api/")) return
  if (url.origin !== self.location.origin) return

  // ── Pages: network first ──
  // A page carries the site's navigation, so serving a stale one strands the
  // user on an old version of the app: this is exactly how the Kyle tab went
  // missing from the Settlement Desk header for anyone who had visited that
  // page before Kyle shipped. Cache-first handed them the old HTML and only
  // refreshed it in the background, so the new tab did not appear until their
  // SECOND visit after the deploy — and never, if they only ever came once.
  // Pages are small and change on every deploy; assets are the things worth
  // serving instantly from cache. The cached copy stays as the offline
  // fallback, which is the reason this service worker exists.
  if (isPageRequest(e.request, url)) {
    e.respondWith(
      fetch(e.request)
        .then((res) => putInCache(e.request, res))
        .catch(() => caches.match(e.request).then((cached) => cached || caches.match("/index.html")))
    )
    return
  }

  // ── Assets: cache first, refreshed in the background ──
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const fetchPromise = fetch(e.request)
        .then((res) => putInCache(e.request, res))
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
