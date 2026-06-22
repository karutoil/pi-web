/// <reference lib="webworker" />
// PI Web Service Worker
// Handles: offline caching of the app shell, push notifications.
//
// Navigation is network-first so a deploy's fresh index.html always wins over a
// cached copy (stale-forever / partial-eviction blank page). Content-hashed
// /assets/* stay cache-first (immutable by hash).

const CACHE_NAME = "pi-web-v1";
const STATIC_CACHE = "pi-web-static-v1";
const API_CACHE = "pi-web-api-v1";
// ponytail: bump this suffix (-> v2, v3, ...) on every deploy so activate()
// purges the PREVIOUS deploy's cached entries wholesale. Without it the
// hardcoded v1 name is retained across deploys and stale entries inside it are
// never evicted — a partial eviction then serves an old index.html that
// references a 404'd JS bundle and the app can't load to reattach. Combined
// with network-first navigation this is self-healing on the next deploy.

// Assets to pre-cache on install
const PRE_CACHE_URLS = [
  "/",
  "/manifest.json",
  "/icons/icon-192x192.png",
  "/icons/icon-512x512.png",
  "/favicon.svg",
  "/favicon.ico",
];

// API routes that should be cached for offline use
const CACHEABLE_API = ["/api/health"];

// Install: pre-cache shell assets
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      return cache.addAll(PRE_CACHE_URLS);
    }).then(() => self.skipWaiting())
  );
});

// Activate: clean old caches (anything that isn't one of the current names —
// so bumping a version suffix above purges the previous deploy's caches).
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME && key !== STATIC_CACHE && key !== API_CACHE)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch: network-first for navigations + API, cache-first for hashed assets.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET and cross-origin
  if (event.request.method !== "GET") return;
  if (url.origin !== self.location.origin) return;

  // WebSocket — don't cache
  if (url.protocol === "ws:" || url.protocol === "wss:") return;

  // Navigations: network-first. A deploy's fresh index.html MUST win over a
  // cached copy, otherwise a stale/evicted shell can reference a 404'd JS
  // bundle and the app can't mount to reattach its live session. Offline falls
  // back to the cached shell so a backgrounded PWA still loads.
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(STATIC_CACHE).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request).then((c) => c || caches.match("/")))
    );
    return;
  }

  // API requests: network-first, fallback to cache
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          // Cache successful API responses for offline
          if (response.ok && CACHEABLE_API.some((p) => url.pathname.startsWith(p))) {
            const clone = response.clone();
            caches.open(API_CACHE).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Static assets: cache-first, fallback to network
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        // Cache successful static responses
        if (response.ok && (url.pathname.endsWith(".js") || url.pathname.endsWith(".css") ||
            url.pathname.endsWith(".svg") || url.pathname.endsWith(".png") ||
            url.pathname.endsWith(".ico") || url.pathname.endsWith(".woff2"))) {
          const clone = response.clone();
          caches.open(STATIC_CACHE).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});

// Push notifications
self.addEventListener("push", (event) => {
  const data = event.data?.json() ?? {};
  const title = data.title || "PI Web";
  const options = {
    body: data.body || "New activity",
    icon: "/icons/icon-192x192.png",
    badge: "/icons/icon-72x72.png",
    tag: data.tag || "pi-notification",
    data: data.url ? { url: data.url } : undefined,
    vibrate: [100, 50, 100],
    actions: data.actions || [],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Notification click: focus or open the app
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      // Focus existing window if open
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          return client.focus();
        }
      }
      // Otherwise open new window
      return self.clients.openWindow(url);
    })
  );
});

// Message handler from main thread
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
