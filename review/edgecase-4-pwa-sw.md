# Adversarial Edge-Case Review — PWA / SW / Offline / Notification Routing: "Can we still connect back to a LIVE PI session?"

**Scope:** Every PWA, Service Worker, offline, and notification edge case where the user can no longer reconnect/reattach to a still-alive pooled PI session, or a deploy/offline/SW-update transition leaves the app unable to mount and reattach.

**Method:** Re-derived against current code at commit `628ff9a`. Compared every finding from the prior review (`review/4-pwa-sw-lifecycle.md`) against the current source. Items the prior review flagged that are now FIXED are marked as such; only still-unhandled issues are reported as findings.

**Key changes since prior review:**
- `sw.js` now has network-first navigation (sw.js:70-83), per-deploy cache-version comments (sw.js:11-16), and dead code removed (CLEAR_CACHE, sync, retryFailedRequests, checkForUpdates, periodicsync — all gone).
- `usePWA.ts` `applyUpdate` now uses `controllerchange` listener with `{ once: true }` (usePWA.ts:64-72). `useBackgroundSync` removed.
- `useWebSocketPool.ts` now has `visibilitychange`/`online`/`offline` lifecycle listeners (useWebSocketPool.ts:195-221), `lastMessageAt` tracking (useWebSocketPool.ts:114-115), and `pendingQueue` for offline prompts (useWebSocketPool.ts:453-461, flushed on reconnect at :175-177).

---

## Re-Verification of Prior Review Findings

| Prior # | Severity | Title | Status | Evidence |
|---------|----------|-------|--------|----------|
| 1 | CRITICAL | Cache-first nav + non-versioned STATIC_CACHE → stale-forever / blank page | **LARGELY FIXED** (online self-healing via network-first nav); **residual offline edge** → see Finding 1 | sw.js:70-83 (network-first nav); sw.js:6 (still hardcoded `v1`) |
| 2 | HIGH | applyUpdate postMessage + immediate reload race | **FIXED** | usePWA.ts:64-72 (`controllerchange` listener with `{ once: true }`) |
| 3 | HIGH | No visibilitychange probe / WS heartbeat → dead socket on iOS | **FIXED** (client-side); residual gap → see Finding 3 | useWebSocketPool.ts:195-221 |
| 4 | HIGH | useBackgroundSync dead code; retryFailedRequests no-op | **FIXED** | usePWA.ts (useBackgroundSync removed); sw.js (sync/retryFailedRequests removed); useWebSocketPool.ts:453-461 (pendingQueue) |
| 5 | MEDIUM | notificationclick opens wrong session | **STILL UNHANDLED** but **inert** (no push code exists) → see Finding 5 | sw.js:119-135; App.tsx (no URLSearchParams) |
| 6 | MEDIUM | notificationclick focus doesn't trigger reconnect | **FIXED** (visibilitychange probe fires on focus) but **inert** | useWebSocketPool.ts:202-208 |
| 7 | MEDIUM | CLEAR_CACHE wipes shell | **FIXED** (removed) | sw.js (CLEAR_CACHE handler gone) |
| 8 | LOW | clients.claim uncontrolled first-load | **STILL PRESENT, safe** | sw.js:40 |
| 9 | LOW | periodicsync/sync no-ops | **FIXED** (removed) | sw.js (both gone) |
| 10 | LOW | Scope/start_url aligned | **STILL CORRECT** | manifest.json:6,10; index.html:54 |

---

## Findings (severity-ranked)

### [HIGH] Finding 1 — Offline partial-eviction: stale cached `/` references an evicted JS bundle → blank page → app can't mount to reattach

**Trigger:**
1. User loads the PWA at deploy A. `install` precaches `/` (deploy A's index.html) and `/assets/index-AAA.js` into `STATIC_CACHE` (sw.js:10-12, 24-27).
2. Browser evicts `/assets/index-AAA.js` from `STATIC_CACHE` under storage pressure (common on mobile), but the `/` entry survives.
3. Deploy B ships. User goes OFFLINE before any online navigation (so network-first nav hasn't overwritten the stale `/`).
4. User navigates to `/`. Network-first nav: `fetch(event.request)` fails (offline) → `.catch(() => caches.match(event.request).then(c => c || caches.match("/")))` (sw.js:78-79) → serves deploy A's index.html from cache.
5. Deploy A's index.html requests `/assets/index-AAA.js`. Cache-first (sw.js:85-98): `caches.match` → MISS (evicted) → `fetch(event.request)` → fails (offline) → promise rejects → `respondWith` gets a rejected promise → browser shows network error → blank `#root`.
6. App never mounts → `restoreLiveSession` never runs → WS never opens → live PI session on the server is unreachable from this client until they go online (which overwrites the stale `/` and fetches the new bundle) or manually purge the SW cache.

**Why it severs reconnect:** The app can't load at all offline if the cached shell references an evicted asset. The server-side agent is still alive (idle timer is 1 hour, `pi-agent.ts:32`), but the client has no UI to reach it.

**Evidence:**
- `sw.js:70-83` — network-first nav falls back to cache on network failure:
  ```js
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then(...)
        .catch(() => caches.match(event.request).then((c) => c || caches.match("/")))
    );
  }
  ```
  The fallback serves whatever `/` is in cache — could be stale from a prior deploy.
- `sw.js:85-98` — static assets are cache-first with no `.catch` on the inner `fetch`:
  ```js
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then(...)  // ← rejects on offline, no .catch
    })
  );
  ```
- `sw.js:6` — `STATIC_CACHE` is still hardcoded `"pi-web-static-v1"`; the comment at sw.js:11-16 says to bump per-deploy but it is not automated. If the version WERE bumped, the old cache would be purged on activate (sw.js:30-39), but the precache on install would re-fetch `/` — which would also fail offline. So bumping doesn't fix the offline case; it makes it WORSE (purges the stale-but-functional shell).

**Handled?** PARTIAL. Network-first navigation fully fixes the ONLINE case (stale `/` is overwritten on every online navigation). The OFFLINE case with partial eviction is unhandled — the app can't self-heal without network access.

**Fix direction:** Add a `.catch` on the static-asset fetch handler that returns a minimal offline fallback page (or a cached `/`-equivalent). More robust: precache the current deploy's asset hashes atomically with `/` (so `/` and its referenced assets are evicted/retained together), or use a `Cache-Only` fallback that returns a cached error page when an asset is missing offline.

**Confidence:** High that the code path exists; Medium that this scenario occurs in practice (requires storage pressure eviction of a specific asset while retaining `/`).

---

### [HIGH] Finding 2 — `onOnline` handler creates a second WebSocket without closing the first → orphaned WS lingers, event handlers interfere, potential connection cascade

**Trigger:**
1. WS is OPEN and healthy. A brief network flap occurs that fires the `online` event WITHOUT a preceding `offline` event (some platforms fire `online` on recovery from a partial connectivity loss that didn't register as fully `offline`).
2. `onOnline` (useWebSocketPool.ts:212-217) runs:
   ```js
   const onOnline = () => {
     if (intentionallyClosed) return;
     if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
     reconnectAttempts = 0;
     connect();   // ← creates ws2 without closing ws1
   };
   ```
3. `connect()` sets `ws = new WebSocket(...)` (useWebSocketPool.ts:119). The OLD `ws1` is NOT closed. It's still OPEN and its `onopen`/`onclose`/`onmessage` handlers are still registered on the old WebSocket object.
4. `ws1.onclose` will eventually fire when the old socket dies (TCP timeout). This calls `connect()` AGAIN (via the reconnect timer), creating `ws3` — even though `ws2` is already connected and healthy. `ws3` overwrites `ws`. `ws2` is now orphaned.
5. The server now has 2+ WebSocket entries in `agent.clients` for the same session (ws2 + ws3, or ws1 + ws2). `clients.size` is inflated. When any of these die, `onclose` fires and schedules yet another reconnect. A cascade can develop.

**Why it risks reconnect:** The new WS (ws2) DOES connect and reattach — the session is not LOST. But the orphaned WS's event handlers interfere: `ws1.onopen` fires and calls `send()` which routes to `ws2` (the module-level `ws` variable was overwritten). State gets confused. On the server, `clients.size` is inflated, which prevents the idle timer from reaping a genuinely-dead agent if the user navigates away. In extreme cases the cascade consumes resources and the server may rate-limit or reject new WS connections.

**Evidence:**
- `useWebSocketPool.ts:212-217` — `onOnline` calls `connect()` unconditionally, no `ws?.close()` before it.
- `useWebSocketPool.ts:119` — `ws = new WebSocket(...)` overwrites the variable; old WS is not closed or dereferenced.
- `useWebSocketPool.ts:147-157` — `ws.onclose` schedules a reconnect via `reconnectTimer`. The old WS's `onclose` will fire eventually and schedule a reconnect on top of the new one.

**Handled?** NO. The `onOffline` handler (useWebSocketPool.ts:211) correctly closes the WS before `onOnline` would reconnect — but `onOnline` can fire WITHOUT a preceding `onOffline` (partial flap). And even when `onOffline` does fire first, the `onclose` it triggers schedules a `reconnectTimer`; then `onOnline` clears that timer and calls `connect()`. This path is correct. The bug is specifically: `onOnline` fires while `ws.readyState === OPEN` (no `onOffline` preceded it).

**Fix direction:** In `onOnline`, close the existing WS before creating a new one:
```js
const onOnline = () => {
  if (intentionallyClosed) return;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws && ws.readyState === WebSocket.OPEN) { try { ws.close(); } catch {} }  // close before reconnect
  reconnectAttempts = 0;
  connect();
};
```
Or simpler: only call `connect()` if `ws` is not already OPEN.

**Confidence:** High that the code path exists; Medium that it triggers in practice (requires an `online` event without a preceding `offline`).

---

### [MEDIUM] Finding 3 — `onVisible` probe threshold (60s from last message) misses short-duration dead sockets during active streaming

**Trigger:**
1. Agent is actively streaming (messages arriving every few seconds). `lastMessageAt` is updated on each `ws.onmessage` (useWebSocketPool.ts:191).
2. User backgrounds the iOS PWA for ~30 seconds. iOS suspends JS and may tear down the TCP socket after ~30s. No `onclose` fires (suspended page doesn't receive it).
3. User foregrounds. `onVisible` fires (useWebSocketPool.ts:202-208):
   ```js
   if (document.visibilityState === "visible" && ws && ws.readyState === WebSocket.OPEN
       && Date.now() - lastMessageAt > 60_000) {
     try { ws.close(); } catch {}
   }
   ```
4. `Date.now() - lastMessageAt` is ~30s (last message was 30s ago, just before backgrounding). This is `< 60_000` → probe does NOT fire.
5. The socket is dead but `ws.readyState` still reads OPEN. `data.isConnected` is `true`. The user sees a stale streaming indicator. Sends are silently dropped into the dead socket buffer.
6. No recovery until the user sends a message (which also silently fails — `ws.send()` on a dead-OPEN socket doesn't throw) or backgrounds/foregrounds again (by which point `lastMessageAt` is now 60+ seconds old and the probe fires).

**Why it risks reconnect:** The user believes the session is live and streaming, but the socket is dead. The server-side agent is still alive (half-open socket keeps `clients.size > 0`), but the client can't reach it. The dead socket lingers until the next visibility cycle that exceeds 60s.

**Evidence:**
- `useWebSocketPool.ts:114-115` — `lastMessageAt = Date.now()` initialized at creation.
- `useWebSocketPool.ts:191` — `lastMessageAt = Date.now()` updated on every `onmessage`.
- `useWebSocketPool.ts:205-207` — probe only fires if `Date.now() - lastMessageAt > 60_000`.

**Handled?** PARTIAL. The visibility probe catches the COMMON case (long backgrounding with no recent activity). It misses the case where streaming was active recently and the backgrounding was brief but long enough for iOS to kill the socket.

**Fix direction:** Track `lastVisibleAt` separately and probe if the page was backgrounded for more than ~10s, regardless of `lastMessageAt`:
```js
let lastHiddenAt = Date.now();
const onVisible = () => {
  if (intentionallyClosed) return;
  if (document.visibilityState === "visible") {
    const wasHiddenFor = Date.now() - lastHiddenAt;
    if (ws && ws.readyState === WebSocket.OPEN &&
        (Date.now() - lastMessageAt > 60_000 || wasHiddenFor > 10_000)) {
      try { ws.close(); } catch {}
    }
  } else {
    lastHiddenAt = Date.now();
  }
};
```
Alternatively, lower the threshold to 15s — the cost of a redundant close+reconnect on a healthy socket is low (the reconnect is fast and `get_messages` restores state).

**Confidence:** High that the code path exists; High that iOS kills sockets in ~30s (well-documented platform behavior).

---

### [MEDIUM] Finding 4 — No server-side WS ping/keepalive: half-open sockets on killed PWA windows keep `clients.size > 0` indefinitely, preventing idle-timer reaping

**Trigger:**
1. User opens the PWA, starts a session, agent is idle (not streaming). WS is OPEN.
2. The OS kills the PWA (memory pressure on mobile, or the user swipes it away). The TCP socket enters a half-open state — the client is gone but the server hasn't received a FIN/RST.
3. The server's `onClose` does NOT fire (no close frame received). `ws.readyState` on the server side may still read OPEN.
4. `agent.clients` still contains the dead WS. `clients.size` = 1. `maybeStartIdleTimer()` returns early (`this.clients.size > 0` — pi-agent.ts:453).
5. The idle timer never arms. The agent stays in the pool indefinitely (until TCP timeout, which can be minutes to hours depending on the OS TCP keepalive settings).
6. The user reopens the PWA. A NEW WS connects. `attach(raw)` adds the new WS. `clients.size` = 2 (old dead + new). The new WS works fine — the session IS reachable. But the old dead WS lingers, inflating the count.
7. If the user navigates away again (closes the new WS), `clients.size` goes to 1 (the old dead one). The idle timer STILL doesn't arm. The agent lingers forever.

**Why it risks reconnect:** The user CAN reattach (new WS works). But the orphaned agent never reaps, consuming server resources. If many agents accumulate this way, the server may run out of file descriptors or memory. More critically: if the `broadcast()` method never runs (agent is idle, no messages to send), the dead-socket pruning at pi-agent.ts:282 (`if (ws.readyState !== 1) { this.clients.delete(ws); continue; }`) never executes, so the dead socket is never cleaned up.

**Evidence:**
- `pi-agent.ts:275-285` — `broadcast()` prunes dead sockets by `readyState`, but only runs when the agent sends a message:
  ```js
  private broadcast(msg: WSServerMessage) {
    const data = JSON.stringify(msg);
    for (const ws of this.clients) {
      if (ws.readyState !== 1) { this.clients.delete(ws); continue; }
      try { ws.send(data); } catch { this.clients.delete(ws); }
    }
  }
  ```
- `pi-agent.ts:453` — idle timer only arms when `this.clients.size === 0`:
  ```js
  if (this.clients.size > 0 || this.isActive()) return;
  ```
- No server-side ping/pong/keepalive/isAlive/setInterval heartbeat exists (verified: `grep ping|pong|keepalive|isAlive` in `packages/server/src` → only `setInterval` is the watchdog timer, which only runs during active streaming and also checks `clients.size === 0`).
- The watchdog (pi-agent.ts:487-490) only force-stops agents that are `isActive()` AND `clients.size === 0`. An idle agent with a half-open socket is not caught.

**Handled?** NO. The client-side `onVisible` probe (Finding 3) handles the case where the PWA is merely backgrounded (it foregrounds and closes the dead socket). But if the PWA is KILLED (not just backgrounded), there is no client to fire the probe. The server has no mechanism to detect the half-open socket.

**Fix direction:** Add a server-side WS ping interval (e.g., every 30s, `ws.ping()` and terminate on no pong). Bun's `ServerWebSocket` supports `ws.ping()` and a `pong` handler. On pong failure or send error, remove the WS from `agent.clients` and call `maybeStartIdleTimer()`. This also complements the client-side probe for the "tab visible but socket dead" case (NAT timeout, router reboot).

**Confidence:** High that the code path exists; High that killed PWAs leave half-open sockets (standard TCP behavior).

---

### [MEDIUM] Finding 5 — `notificationclick` focuses the FIRST window without session-identity check; `restoreLiveSession` ignores URL deep-link params

**Trigger:**
1. Two PWA windows are open: window A showing session A, window B showing session B.
2. A push notification arrives for session B (sw.js:98-104 builds the notification; `data.url` would be the session-specific URL IF the server sends one).
3. User taps the notification. `notificationclick` (sw.js:119-135):
   ```js
   self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
     for (const client of clients) {
       if (client.url.includes(self.location.origin) && "focus" in client) {
         return client.focus();   // ← focuses the FIRST window, regardless of session
       }
     }
     return self.clients.openWindow(url);
   });
   ```
4. `matchAll` returns windows in arbitrary order. The loop focuses the FIRST one — which could be window A (session A), not window B (session B).
5. If no window is open, `openWindow(url)` opens at `event.notification.data?.url || "/"` (sw.js:122). The URL defaults to `"/"` if the push payload has no `url` field.
6. The new tab loads. `restoreLiveSession` (App.tsx:460-512) does NOT read URL query parameters (verified: `grep URLSearchParams|location.search|searchParams` in App.tsx → no matches). It falls back to localStorage or `/api/projects/:id/live-sessions` → picks the most-recently-active session, which may not be the notification's session.

**Why it risks reconnect:** The user expects to land on session B (the notification's session). They land on session A or the most-recently-active session. Session B's agent is still alive on the server, but the user must manually navigate to it. Not a data-loss issue, but a reattach-target correctness issue.

**Handled?** NO. The SW does not route by session URL. `restoreLiveSession` does not parse deep-link params.

**IMPORTANT CONTEXT:** There is NO server-side push notification code (verified: `grep pushSubscription|showNotification|sendNotification` in `packages/server/src` → no matches) and NO client-side push subscription code (verified: `grep pushSubscription|PushManager|Notification.requestPermission` in `packages/client/src` → no matches). The push handler (sw.js:98-104) and notificationclick handler (sw.js:119-135) are **dead code today** — they handle events that are never fired. This finding is LATENT: it only manifests if/when push notifications are wired.

**Evidence:**
- `sw.js:119-135` — focuses first matching window, no session-identity check.
- `sw.js:122` — `const url = event.notification.data?.url || "/"` — defaults to root.
- `App.tsx:460-512` — `restoreLiveSession` reads localStorage and `/live-sessions` API; does NOT parse `location.search` or `URLSearchParams`.

**Fix direction:** When push is wired: (1) Server includes `data.url = "/?project=<id>&session=<path>"` in the push payload. (2) SW `notificationclick` matches windows by URL, not just origin. (3) `restoreLiveSession` parses `URLSearchParams(location.search)` for `project`/`session` as Path 0 (before localStorage/server fallback) and short-circuits to that session.

**Confidence:** High that the code path exists and is unhandled; High that it is inert today (no push wired).

---

### [MEDIUM] Finding 6 — Network-first navigation does not fall back to cache on non-OK (5xx) responses — server error serves a broken page with no shell fallback

**Trigger:**
1. Server is up but returns a 500 for `/` (e.g., the SPA fallback handler errors, or a reverse proxy returns a 502/503).
2. Network-first nav (sw.js:70-83):
   ```js
   fetch(event.request)
     .then((response) => {
       if (response.ok) {  // ← false for 5xx
         const clone = response.clone();
         caches.open(STATIC_CACHE).then((cache) => cache.put(event.request, clone));
       }
       return response;  // ← returns the 5xx response to the browser
     })
     .catch(() => caches.match(event.request).then((c) => c || caches.match("/")))
   ```
3. `response.ok` is false (5xx) → cache is NOT updated. The 5xx response is returned to the browser. The `.catch` does NOT fire (the fetch succeeded, it just returned an error status).
4. The browser renders the 5xx error page (or a blank page if the body is empty). The app script tags are not present → the app doesn't mount → `restoreLiveSession` never runs → can't reattach.

**Why it risks reconnect:** If the server is temporarily returning 5xx for navigations (but the API is fine, or the issue is transient), the user gets a broken page. A cached shell would let the app mount and at least show the UI + attempt a WS connection. Without it, the user is stuck on an error page until the server recovers.

**Evidence:**
- `sw.js:72-79` — only `response.ok` responses update the cache; non-ok responses are returned as-is. `.catch` only handles network failures, not HTTP errors.

**Handled?** NO. The code distinguishes network failure (catch → cache fallback) from HTTP error (returned as-is, no fallback).

**Fix direction:** Fall back to cache for non-OK navigations too:
```js
.then((response) => {
  if (response.ok) {
    const clone = response.clone();
    caches.open(STATIC_CACHE).then((cache) => cache.put(event.request, clone));
    return response;
  }
  // Server error — try cached shell so the app can at least mount
  return caches.match(event.request).then((c) => c || caches.match("/")).then((c) => c || response);
})
```

**Confidence:** High that the code path exists; Medium that it occurs in practice (requires a server-side error specifically on the HTML route while the WS/API is fine).

---

### [LOW] Finding 7 — `STATIC_CACHE` version is not automated — a deploy that forgets to bump leaves orphaned entries (self-healing online, but wastes storage)

**Trigger:**
1. Deploy B ships. Developer forgets to bump `STATIC_CACHE` from `"pi-web-static-v1"` to `"v2"` (sw.js:6).
2. `activate` handler (sw.js:30-39) keeps `pi-web-static-v1` (name unchanged). Old `/assets/index-AAA.js` from deploy A remains in cache alongside new `/assets/index-BBB.js`.
3. Orphaned entries accumulate across deploys. Under storage pressure, the browser evicts LRU entries — which are the orphaned old hashes (rarely requested). Current hashes and `/` are frequently accessed and survive.

**Why it (doesn't really) risk reconnect:** Network-first navigation overwrites `/` on every online navigation, so the stale-shell problem is self-healing. Orphaned asset hashes don't interfere (they're never requested by the current index.html). The only impact is wasted storage, which could accelerate browser eviction of OTHER entries (including current ones, in theory). In practice, LRU eviction favors keeping current entries.

**Handled?** PARTIAL. The comment at sw.js:11-16 documents the need to bump, but there is no automated mechanism (build-time injection, CI check). It relies on developer discipline.

**Evidence:**
- `sw.js:6` — `const STATIC_CACHE = "pi-web-static-v1";` (hardcoded, not derived from build).
- `sw.js:11-16` — comment says "bump this suffix on every deploy" but it's a manual step.
- `sw.js:30-39` — activate purges caches whose name doesn't match the three constants.

**Fix direction:** Inject the build hash or a timestamp into the cache name at build time (e.g., Vite `define` or a `replace` plugin step in the build script). This makes the purge automatic and removes the human-error factor.

**Confidence:** High that the code exists as described; Low impact on reattach (self-healing online).

---

### [LOW] Finding 8 — `clients.claim()` on first install: navigations before claim are uncontrolled — app degrades gracefully but SW features (cache) are unavailable

**Trigger:**
1. First-ever visit (no SW registered). `index.html` loads, registers the SW on `load` (index.html:52-54). The SW installs and activates.
2. `clients.claim()` (sw.js:40) makes the SW control the current tab — but only for FUTURE fetches. The already-loaded document and its in-flight resource requests were uncontrolled.
3. The app mounts normally (resources fetched from network). `restoreLiveSession` runs. WS connects. The app functions.

**Why it doesn't risk reconnect:** The app works without SW interception — fetches go directly to network. `restoreLiveSession` is application logic, not SW-mediated. An uncontrolled client CAN still reattach. The only effect: `useServiceWorkerUpdate` won't fire for an uncontrolled client until the next navigation (cosmetic — update banner delayed).

**Handled?** YES (by graceful degradation). This is inherent to the SW spec and the code handles it correctly — `index.html:66-68` catches registration failure and continues without SW.

**Evidence:**
- `sw.js:40` — `then(() => self.clients.claim())`.
- `index.html:52-54` — SW registered on `load`.
- `index.html:66-68` — registration failure caught, app continues.

**Fix direction:** None needed. This is spec behavior with correct graceful degradation.

**Confidence:** High.

---

### [LOW] Finding 9 — `notificationclick` `matchAll` uses `client.url.includes(self.location.origin)` — string-include check could match a spoofed origin (security note, not reattach)

**Trigger:** A malicious page at `https://example.com.evil.com/` would match `client.url.includes("https://example.com")` and get focused/opened. This is a SW security best-practice issue, not a reattach issue.

**Handled?** NO, but not relevant to session reattach.

**Evidence:** `sw.js:127` — `if (client.url.includes(self.location.origin) && "focus" in client)`.

**Fix direction:** Use `new URL(client.url).origin === self.location.origin` instead of `includes`.

**Confidence:** High that the code exists; Not applicable to reattach. Inert today (no push wired).

---

## EXHAUSTIVE CHECKLIST (re-derived against current code)

### SW Registration & Scope
- ✅ `navigator.serviceWorker.register("/sw.js", { scope: "/" })` in `index.html:54` (inline, on `load`).
- ✅ `manifest.json` `start_url:"/"` and `scope:"/"` match SW scope `/`.
- ✅ Server serves `/sw.js` with `Service-Worker-Allowed: "/"` and `Cache-Control: no-cache, no-store, must-revalidate` (`index.ts:2746-2750`).
- ✅ `dist/sw.js` is byte-identical to `public/sw.js` (md5 match: `6c712947…`).
- ✅ SW registration failure caught (`index.html:66-68`); app continues without SW. `restoreLiveSession` runs; WS reattaches. SAFE.
- ✅ `clients.claim()` on activate (sw.js:40). → Finding 8 (safe).

### SW Install / skipWaiting
- ✅ `install` precaches shell + `skipWaiting()` (sw.js:24-27). New SW takes over immediately.
- ✅ `skipWaiting` + network-first nav means the new SW controls the next navigation. No stale-forever.

### SW Activate / cache cleanup
- ⚠️ `activate` deletes only caches whose name ≠ the three hardcoded `v1` names (sw.js:30-39). Since `STATIC_CACHE="pi-web-static-v1"` never changes, stale entries inside it are never purged. → Finding 7 (LOW — self-healing online).

### SW Fetch — Navigations (network-first)
- ✅ `event.request.mode === "navigate"` is network-first (sw.js:70-83). Fresh index.html always wins online.
- ✅ Offline fallback: `caches.match(event.request).then(c => c || caches.match("/"))` (sw.js:78-79). Serves cached shell if network fails.
- ❌ Non-OK (5xx) responses are returned as-is without cache fallback. → Finding 6.
- ❌ Offline partial eviction (stale `/` + evicted asset) → blank page. → Finding 1.

### SW Fetch — API (network-first)
- ✅ `/api/*` is network-first with cache fallback (sw.js:58-68).
- ✅ `CACHEABLE_API = ["/api/health"]` (sw.js:16) — `/api/projects/:id/live-sessions` is NOT cached. A stale live-sessions response CANNOT be served. `restoreLiveSession` Path 2 always hits network. SAFE.
- ✅ Non-GET and cross-origin skipped (sw.js:50-51).
- ✅ `ws:`/`wss:` skipped (sw.js:53).

### SW Fetch — Static assets (cache-first)
- ✅ Content-hashed `/assets/*.js` are immutable by hash — cache-first is correct (sw.js:85-98).
- ❌ No `.catch` on the inner `fetch` for static assets → offline + cache miss = rejected promise → browser error. → Finding 1.

### SW Update flow
- ✅ `applyUpdate` uses `controllerchange` listener with `{ once: true }` (usePWA.ts:64-72). Deterministic regardless of whether `install` calls `skipWaiting`. FIXED from prior review.
- ✅ The reload reattaches: `restoreLiveSession` runs on mount, reads localStorage, WS reconnects, server agent not reaped (1-hour idle timer, `pi-agent.ts:32`). SAFE.
- ✅ `index.html:57-60` dispatches `sw-update` on `"activated"` state.
- ⚠️ Update banner is dismissible, dismissal persisted in localStorage (`PWABanner.tsx:22-27`). But `skipWaiting` means the new SW activates regardless — the next reload uses it. The banner is a "reload now" prompt, not a gate. SAFE.

### SW Deletion / unregister / failed registration
- ✅ If SW is unregistered or fails to register, app fetches directly from network (`index.html:66-68`). `restoreLiveSession` and WS reattach work without SW. No code assumes a controller exists. SAFE.
- ✅ No code path checks `navigator.serviceWorker.controller` for critical functionality (verified: only `usePWA.ts:70` references `navigator.serviceWorker`, and only for the `controllerchange` listener inside `applyUpdate`).

### App backgrounding / OS suspension (mobile PWA / iOS)
- ✅ `visibilitychange` probe added (useWebSocketPool.ts:202-208). On foreground, if `Date.now() - lastMessageAt > 60_000` and WS is OPEN, force-close → `onclose` drives reconnect. FIXED from prior review.
- ✅ `ws.onclose` drives reconnect with exponential backoff then slow-forever (useWebSocketPool.ts:147-157, ws-pool-logic.ts:18-24). Desktop/Android recover fine.
- ✅ `ws.onerror` schedules reconnect if `onclose` didn't fire (useWebSocketPool.ts:159-170). Guards on `reconnectTimer` to prevent stacking.
- ❌ 60s threshold misses short-duration dead sockets during active streaming. → Finding 3.
- ❌ No server-side ping. Killed PWA leaves half-open socket. → Finding 4.
- ✅ Server keeps agent alive during client suspension: idle timer gated on `clients.size === 0` (pi-agent.ts:453); watchdog gated on `clients.size === 0 && isActive()` (pi-agent.ts:489). A half-open socket keeps the agent alive (good for reattach, bad for cleanup — Finding 4).
- ✅ Server's `broadcast()` prunes dead sockets by `readyState` (pi-agent.ts:282) — but only runs when the agent sends a message. Idle agents don't broadcast.

### useOnlineStatus
- ✅ `useOnlineStatus` (usePWA.ts:80-94) returns `isOnline` boolean, consumed by `PWABanner` for the offline banner.
- ✅ `useWebSocketPool` has its OWN `onOnline`/`onOffline` handlers (useWebSocketPool.ts:211-217) that drive WS reconnect. These are INDEPENDENT of `useOnlineStatus` — good separation. The banner is cosmetic; the WS reconnect is functional.
- ❌ `onOnline` can create a second WS without closing the first. → Finding 2.

### useBackgroundSync / retryFailedRequests
- ✅ Both removed. `pendingQueue` in `useWebSocketPool.ts:453-461` handles offline prompts, flushed on reconnect at :175-177. FIXED from prior review.

### Push / notificationclick
- ⚠️ Push handler (sw.js:98-104) and notificationclick handler (sw.js:119-135) exist but are **dead code** — no server-side push sending, no client-side push subscription. → Finding 5 (latent).
- ✅ Duplicate-session safety: `getOrConnect` keys by `${projectId}::${sessionPath}::${newSessionId}` (useWebSocketPool.ts:646); server `buildAgentKey` normalizes `sessionPath` (pi-agent.ts:615-620); reverse lookup by `originalNewSessionId` (pi-agent.ts:654-660). A reattach finds the EXISTING agent. No duplicate PI process. SAFE.

### CLEAR_CACHE / periodicsync / sync
- ✅ All removed from sw.js. FIXED from prior review.

### Live-session recovery composition
- ✅ `restoreLiveSession` (App.tsx:460-512) runs on mount, gated once by `restoreAttemptedRef`. Path 1: localStorage (survives reload + tab close/reopen + browser restart). Path 2: `GET /api/projects/:id/live-sessions` (server pool source of truth). Both reattach by `sessionPath` directly, not requiring the file to be on disk. SAFE and well-designed.
- ✅ localStorage persist effect (App.tsx:530-547) gated on `restoreAttemptedRef` AND a real leave of chat. Mount-before-restore window preserves the seed. SAFE.
- ✅ Forced reload from `applyUpdate` does NOT skip recovery — `restoreLiveSession` runs on the reloaded page. SAFE.
- ✅ Cache-cleared refresh: localStorage wiped → Path 2 (server `/live-sessions`) → reattaches to most-recently-active live agent. SAFE.
- ❌ Does NOT parse URL deep-link params for notification-routed reattach. → Finding 5.
- ❌ If app is stuck on blank page (Finding 1 offline, Finding 6 server error), `restoreLiveSession` never runs because JS never mounts.

### Multiple windows / popups
- ⚠️ `notificationclick` `matchAll` picks the first window — could be a different session's window. → Finding 5 (inert today).

---

## Coverage gaps in tests

1. **No SW tests at all.** There are zero tests for `sw.js` — no test verifies that network-first navigation falls back to cache on network failure, that cache-first assets return cached responses, or that the activate handler purges old caches. The SW's fetch handler logic (the most critical piece for reattach) is completely untested.

2. **No `usePWA.ts` tests.** `applyUpdate`'s `controllerchange` listener, `useServiceWorkerUpdate`'s event handling, and `useOnlineStatus` are untested. The `controllerchange` + `{ once: true }` + `postMessage(SKIP_WAITING)` ordering is not verified by any test.

3. **No `onVisible`/`onOnline`/`onOffline` lifecycle tests in `useWebSocketPool.test.ts`.** The existing tests (`useWebSocketPool.test.ts`) cover keying, rekey, reconnect on close, and message restore — but do NOT test the `visibilitychange` probe, the `online`/`offline` handlers, or the `pendingQueue` flush on reconnect. Specifically:
   - No test that `onVisible` closes a dead-OPEN socket after 60s of silence.
   - No test that `onOnline` reconnects (or that it doesn't double-connect — Finding 2).
   - No test that `pendingQueue` flushes queued prompts after `get_messages` on reconnect.
   - No test that `onOffline` closes the WS.

4. **No `restoreLiveSession` tests.** The App.sessionSwitch test (`App.sessionSwitch.test.tsx`) exists but does not cover `restoreLiveSession`'s two paths (localStorage vs server fallback), the `restoreAttemptedRef` gating, or the mount-before-restore window.

5. **No server-side half-open socket test.** `pi-agent.test.ts` tests keepalive/idle-timer but does not test the `broadcast()` dead-socket pruning path or the scenario where a half-open socket prevents idle-timer reaping (Finding 4).

6. **No integration test for SW update mid-live-session.** No test verifies that a `controllerchange` → reload → `restoreLiveSession` → WS reattach cycle preserves the live session end-to-end.
