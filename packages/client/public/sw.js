/// <reference lib="webworker" />
// PI Web Service Worker
// Handles: offline caching, background sync, push notifications, periodic sync

const CACHE_NAME = "pi-web-v1";
const STATIC_CACHE = "pi-web-static-v1";
const API_CACHE = "pi-web-api-v1";

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

// Activate: clean old caches
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

// Fetch: network-first for API, cache-first for static assets
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET and cross-origin
  if (event.request.method !== "GET") return;
  if (url.origin !== self.location.origin) return;

  // WebSocket — don't cache
  if (url.protocol === "ws:" || url.protocol === "wss:") return;

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

// Background Sync: retry failed API requests when connectivity returns
self.addEventListener("sync", (event) => {
  if (event.tag === "pi-web-sync") {
    event.waitUntil(retryFailedRequests());
  }
});

async function retryFailedRequests() {
  // Future: retry queued mutations that failed offline
}

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

// Periodic Background Sync (Android Chrome 94+)
self.addEventListener("periodicsync", (event) => {
  if (event.tag === "pi-web-periodic") {
    event.waitUntil(checkForUpdates());
  }
});

async function checkForUpdates() {
  // Future: check for new messages/notifications while app is backgrounded
}

// Message handler from main thread
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
  if (event.data?.type === "CLEAR_CACHE") {
    caches.keys().then((keys) => keys.forEach((key) => caches.delete(key)));
  }
});
