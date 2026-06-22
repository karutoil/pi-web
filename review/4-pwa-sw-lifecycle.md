# PWA / Service Worker / App-Lifecycle Edge-Case Review

**Scope:** Service worker, PWA install, app backgrounding, OS suspension, browser cache invalidation — every path where the client can lose the ability to reconnect to a LIVE PI session still running on the server.

**Repo state reviewed:** working tree at commit `c6a6967` with uncommitted edits to `App.tsx`, `ChatInput.tsx`, `styles.css`, server `index.ts`/`pi-agent.ts`/`pi-agent.test.ts`. Built `dist/` present (built 2026-06-20). `dist/sw.js` is byte-identical to `public/sw.js` (`md5 1463db86…`).

**Bar:** ZERO unhandled edge cases. Each finding below is cited with real file:line and a concrete reproducible scenario. What IS robust is enumerated at the end.

---

## Findings

### [CRITICAL] Cache-first navigation + hardcoded `STATIC_CACHE='pi-web-static-v1'` serves a stale app forever after deploy; partial cache eviction yields a permanently broken app that cannot load to reattach

**Location:** `packages/client/public/sw.js:5-7,10-12,72-83` (cache-first static handler); `sw.js:34-40` (activate purges only whole caches, never entries)

**Scenario (stale-forever):**
1. User installs the PWA / loads the app at deploy A. `install` precaches `"/"` (the index.html) into `STATIC_CACHE` (`sw.js:10-12,25-27`).
2. Deploy B ships. `index.html` now references a NEW content-hashed JS bundle (verified: `dist/index.html` → `/assets/index-vzoxC54A.js`). The old bundle hash differs.
3. The browser fetches `/sw.js` on navigation; the byte-for-byte new `sw.js` installs, calls `skipWaiting()` (`sw.js:27`), activates, and `activate()` runs `keys.filter(key => key !== CACHE_NAME && key !== STATIC_CACHE && key !== API_CACHE)` (`sw.js:34-40`). Because `STATIC_CACHE` is still the hardcoded string `"pi-web-static-v1"` — UNCHANGED across deploys — the filter keeps it. No entries inside `pi-web-static-v1` are purged.
4. User navigates to `/`. The fetch handler hits the "Static assets: cache-first" branch (`sw.js:72-83`). `caches.match("/")` returns the DEPLOY-A index.html. It is returned immediately; the network is never consulted.
5. Deploy-A index.html requests `/assets/index-<OLDDASH>.js`. Cache-first finds it in `STATIC_CACHE` (cached on first load). The OLD app boots.
6. The "Update available" banner fires (`index.html:55-60`), but `applyUpdate()` just reloads (`usePWA.ts:64-70`) — and the reload re-traces steps 4-5. The new app is NEVER loaded. The user runs deploy A forever.

**Scenario (permanently broken — cannot reattach):**
1. Same precache as above, but the browser evicts PART of `STATIC_CACHE` under storage pressure (common on mobile): the entry for `/assets/index-<OLDDASH>.js` is evicted while the entry for `"/"` (index.html) survives.
2. User returns to the PWA. Navigation to `/` → cache-first → serves the SURVIVING deploy-A index.html (references the old hash).
3. Old index.html requests `/assets/index-<OLDDASH>.js` → cache-first → MISS (evicted) → falls to network → server 404s (deploy B never shipped that hash).
4. JS entry fails to load → blank `#root` → the app never mounts → `restoreLiveSession` never runs → the WS never opens → the live PI session on the server is unreachable from this client until the SW cache is manually purged.
5. Because there is no `request.mode === "navigate"` network-first branch (verified: `grep navigate sw.js` → NONE) and no `CLEAR_CACHE` is ever sent automatically (see [LOW] #7), the client is stuck on a blank page with no recovery path. The server-side idle timer eventually reaps the orphaned agent — the session IS lost.

**Impact:** A live PI session becomes permanently unreachable from the client. The stale-forever variant degrades silently (old app keeps running, may diverge from server API contract). The partial-eviction variant produces a blank page with no self-healing.

**Evidence:**
```js
// sw.js:5-7
const CACHE_NAME = "pi-web-v1";
const STATIC_CACHE = "pi-web-static-v1";   // never changes across deploys
const API_CACHE = "pi-web-api-v1";
// sw.js:10-12
const PRE_CACHE_URLS = [ "/", "/manifest.json", ... ];
// sw.js:34-40 — activate keeps all three v1 caches wholesale
keys.filter((key) => key !== CACHE_NAME && key !== STATIC_CACHE && key !== API_CACHE)
// sw.js:72-83 — static cache-first, no navigate special-case
event.respondWith(
  caches.match(event.request).then((cached) => {
    if (cached) return cached;           // ← stale index.html served here
    return fetch(event.request).then(...)
  })
);
```
`dist/index.html` references `/assets/index-vzoxC54A.js` (content-hashed), confirming the hash changes per build while the cache name does not.

**Fix (minimal):**
1. Make navigation requests network-first so a fresh `index.html` is always preferred:
   ```js
   if (event.request.mode === "navigate") {
     event.respondWith(
       fetch(event.request).catch(() => caches.match(event.request))
     );
     return;
   }
   ```
   Place this BEFORE the static cache-first branch (`sw.js:72`). Content-hashed `/assets/*` stay cache-first (they're immutable by hash), so only the HTML entry needs network-first.
2. Bump `STATIC_CACHE` per deploy (e.g. derive from a build-time `VERSION` injected into `sw.js`, or append the build hash). Then `activate()`'s existing `filter(key !== STATIC_CACHE)` purges the old cache wholesale on the next deploy. One-line change to the constant plus a build-time injection.

---

### [HIGH] `applyUpdate()` posts `SKIP_WAITING` then immediately reloads — the reload can race the new controller; and `registration.waiting` is already null by the time the banner shows

**Location:** `packages/client/src/hooks/usePWA.ts:64-70`; `packages/client/index.html:55-60`

**Scenario:**
1. New `sw.js` installs. `install` calls `self.skipWaiting()` (`sw.js:27`), so the new worker activates immediately — `registration.waiting` becomes null.
2. `index.html:55-60` listens for `updatefound` → `statechange` → `newWorker.state === "activated"` → dispatches `sw-update` with `detail: reg`.
3. `useServiceWorkerUpdate` stores `reg` as `registration` (`usePWA.ts:54-61`). User clicks "Update". `applyUpdate` runs:
   ```js
   if (registration?.waiting) {                       // ← null: skipWaiting already activated
     registration.waiting.postMessage({ type: "SKIP_WAITING" });
   }
   window.location.reload();                          // ← fires immediately
   ```
4. `postMessage(SKIP_WAITING)` is skipped (dead code in the normal flow). The reload fires. Because `skipWaiting` already activated the new SW, the new SW controls the reload — so the race is benign HERE. BUT: `skipWaiting` is async; if `install` had NOT already called it (e.g., a future edit removing `sw.js:27`), the `postMessage(SKIP_WAITING)` + immediate `reload()` would reload under the OLD controller, and the new SW would only take over on the NEXT navigation. The code relies on `install`'s `skipWaiting` to mask the race.

**Impact (current):** The reload is the only thing that actually applies the update, and it reloads under whatever controller is active. Session-reattach on reload is SAFE (see EXHAUSTIVE CHECKLIST) — `restoreLiveSession` runs from `sessionStorage`. The WS is torn down by the unload and re-established on reload; the server-side agent is NOT reaped (idle timer only arms at `clientCount===0`, and `onClose` detaches — `index.ts:2707-2714`). So this is NOT a session-loss bug today, but it is a latent race: the `postMessage` is a no-op and the correctness depends entirely on `install`'s `skipWaiting`.

**Evidence:**
```js
// usePWA.ts:64-70
const applyUpdate = useCallback(() => {
  if (registration?.waiting) {
    registration.waiting.postMessage({ type: "SKIP_WAITING" });
  }
  window.location.reload();
}, [registration]);
// index.html:57-60 — event fires on "activated", by which point .waiting is null
if (newWorker.state === "activated") {
  window.dispatchEvent(new CustomEvent("sw-update", { detail: reg }));
}
```

**Fix:** Listen for `controllerchange` and reload ONCE it fires, instead of racing the reload:
```js
const applyUpdate = useCallback(() => {
  if (registration?.waiting) {
    navigator.serviceWorker.addEventListener("controllerchange", () => window.location.reload(), { once: true });
    registration.waiting.postMessage({ type: "SKIP_WAITING" });
  } else {
    window.location.reload(); // already activated
  }
}, [registration]);
```
This makes the update deterministic regardless of whether `install` calls `skipWaiting`.

---

### [HIGH] Mobile PWA backgrounding / OS suspension: no `visibilitychange` reconnect probe and no WS heartbeat → socket can read OPEN (readyState==1) while dead on iOS → silent send drops → live session unreachable until full reload

**Location:** `packages/client/src/hooks/useWebSocketPool.ts:112-157` (connect/onclose/onerror — no visibility or heartbeat logic); `packages/client/src/hooks/usePWA.ts:75-90` (`useOnlineStatus` only drives a banner); no `visibilitychange`/`document.hidden` listener anywhere (verified: `grep` → NONE in `packages/client/src`); no server-side WS ping/keepalive (verified: `grep ping|pong|keepalive` in `packages/server/src` → NONE).

**Scenario:**
1. User runs PI in an installed iOS Safari PWA (standalone mode). A long agent run is streaming.
2. User switches apps / locks the phone. iOS suspends the JS context after ~30s. The OS tears down the underlying TCP socket after 30s–5min, but the browser does NOT reliably deliver `onclose` to the suspended page.
3. User foregrounds the PWA. `ws.readyState` still reads `1` (OPEN) because no `close` frame was received. `data.isConnected` is still `true` (`useWebSocketPool.ts:120`). The reconnect timer (`useWebSocketPool.ts:144-156`) never arms because `onclose` never fired.
4. `useOnlineStatus` fires the `online` event on foreground (`usePWA.ts:81`), but it is ONLY consumed by `PWABanner` to toggle a banner (`PWABanner.tsx:49`) — it does NOT call `ws.close()`/reconnect.
5. The user types a prompt. `send()` checks `ws?.readyState === WebSocket.OPEN` (`useWebSocketPool.ts:397`) — it is OPEN — and calls `ws.send(...)`. The bytes go into a dead socket and are silently dropped. The agent never receives the prompt. The UI shows the user's message (optimistic append, `useWebSocketPool.ts:335-342`) but no assistant reply ever arrives. The streaming indicator stays stale.
6. The server still holds the agent alive (idle timer won't arm: `clientCount > 0` because `onClose` never fired server-side either — `index.ts:2707-2714`). So the session is NOT lost on the server, but the client is silently disconnected with no self-heal. The only recovery is a manual full reload.

**Impact:** Live session unreachable from the client with no automatic recovery on iOS PWA. The client believes it is connected. This is the single most likely real-world "lost session" symptom on mobile.

**Evidence:**
```js
// useWebSocketPool.ts:112-157 — no visibility/heartbeat
ws.onopen = () => { data.isConnected = true; ... };
ws.onclose = () => { data.isConnected = false; ... /* reconnect */ };
ws.onerror = (e) => { data.lastError = "..."; };
// no ws.onmessage health-check, no setInterval ping, no visibilitychange listener
// usePWA.ts:75-90 — useOnlineStatus returns a boolean, calls nothing on transition
// PWABanner.tsx:49 — isOnline only renders a banner
```

**Fix (minimal):** Add a visibility-driven reconnect probe in `useWebSocketPool` (or in `App.tsx`):
```js
// in createConnection, after connect():
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && ws?.readyState === WebSocket.OPEN) {
    // probe: if the socket is actually dead, this no-op ping will throw / trigger onerror
    try { ws.send(JSON.stringify({ type: "get_state" })); } catch { ws.close(); /* onclose → reconnect */ }
  }
});
```
Even simpler and more robust: on `visibilitychange → visible`, if `Date.now() - lastMessageAt > 60_000`, force `ws.close()` to let `onclose` drive the existing reconnect path. A server-side ping interval (e.g. Bun's `ws.ping()` every 30s, terminate on no pong) is the complementary fix and also cleans up the server-side half-open sockets that keep `clientCount` inflated.

---

### [HIGH] `useBackgroundSync` is dead code — `retryFailedRequests()` is a no-op, and the hook is never imported, so a prompt queued during a transient offline is lost, not retried

**Location:** `packages/client/src/hooks/usePWA.ts:92-118` (defined, never imported — verified: `grep useBackgroundSync packages/client/src` → only the definition); `packages/client/public/sw.js:91-97` (`retryFailedRequests` empty); `sw.js:140-142` (`checkForUpdates` empty)

**Scenario:**
1. User is briefly offline (flaky mobile network, tunnel flap). They send a prompt. `send()` (`useWebSocketPool.ts:397`) checks `ws?.readyState === WebSocket.OPEN`. If the WS is mid-close, the prompt is appended optimistically to `messagesRef`/`pendingSteering` (`useWebSocketPool.ts:331-342`) but `ws.send` is skipped (not OPEN) — so the `prompt` message is NEVER sent to the server. It lives only in `pendingSteering` local state.
2. The WS reconnects (`useWebSocketPool.ts:144-156`). `onopen` sends `get_state`/`get_messages` (`useWebSocketPool.ts:128-134`) and resets `data.liveMessages = new Map()`. But `pendingSteering` is NOT re-flushed on reconnect — it is only cleared when the server echoes a matching `message_end` user message (`useWebSocketPool.ts:271-276`). If the prompt was never sent, it never gets echoed, so it sits in `pendingSteering` forever, never reaching PI.
3. `useBackgroundSync.registerSync("pi-web-sync")` would be the recovery path, but it is never called (dead code). Even if it were, `retryFailedRequests()` is empty (`sw.js:96-97`).

**Impact:** A prompt sent during a brief offline window is silently lost — the user believes it was sent (it's in the UI) but PI never receives it. The live session continues, but the user's input is gone. Note: `pendingSteering`/`pendingFollowUp` are a *queue UI state*, not a durable outbox — they don't survive a reload either (not persisted).

**Evidence:**
```js
// sw.js:91-97
self.addEventListener("sync", (event) => {
  if (event.tag === "pi-web-sync") { event.waitUntil(retryFailedRequests()); }
});
async function retryFailedRequests() { /* Future: ... */ }
// usePWA.ts:92-118 — useBackgroundSync never imported anywhere
```

**Fix (minimal, ponytail):** The cheapest correct fix is to re-send pending steering on WS `onopen` reconnect. In `useWebSocketPool.ts` `ws.onopen`, after the `get_*` calls:
```js
// flush pending steering/follow-ups that were queued while the socket was down
for (const t of data.pendingSteering) send({ type: "steer", message: t });
for (const t of data.pendingFollowUp) send({ type: "follow_up", message: t });
data.pendingSteering = []; data.pendingFollowUp = [];
```
Either delete `useBackgroundSync`/`retryFailedRequests`/`checkForUpdates` (dead code) or wire them — but the flush-on-reconnect is the real fix; Background Sync API is not supported on iOS Safari anyway, so it can't be the primary path.

---

### [MEDIUM] `notificationclick` opens a new window/tab at `/` with no session context → the new tab reattaches to the most-recently-active live session, which may not be the session the notification was about

**Location:** `packages/client/public/sw.js:110-133`; `packages/client/src/App.tsx:448-493` (restoreLiveSession falls back to `/live-sessions` sorted by recency)

**Scenario:**
1. User has TWO live sessions in the same project. A push notification arrives for session B (`sw.js:103-118` builds the notification; `data.url` is whatever the server sent, or `undefined` → defaults to `"/"` at `sw.js:113`).
2. The original PWA window was killed (iOS reaped it). User taps the notification.
3. `notificationclick` (`sw.js:110-133`): `matchAll({includeUncontrolled: true})` finds no live window → `self.clients.openWindow(url)` (`sw.js:130`) where `url = event.notification.data?.url || "/"` (`sw.js:113`).
4. New tab loads. `App` mounts. `restoreLiveSession` (`App.tsx:448-493`): `sessionStorage` is empty (new tab) → Path 2: `GET /api/projects/:id/live-sessions` (`App.tsx:463`). It picks `data.sessions?.[0]` — "sorted most-recently-active first" (`App.tsx:466`). If session A was touched more recently than session B (e.g., A had a later `lastActivityAt`), the new tab reattaches to A, not B.
5. The user expected to land on B (the notification's session). They land on A. B's agent is still running on the server (not lost), but the user must manually navigate to it.

**Impact:** No session is LOST (both agents survive on the server; the user can navigate to B), but the reattach target is wrong. This is a UX correctness issue, not a data-loss issue. Worse case: if the notification `url` is just `/` (the common case, since the server push payload would need to explicitly set `data.url` to a deep link), the new tab always lands on the most-recent session regardless of which session the notification concerned.

**Evidence:**
```js
// sw.js:113 — url defaults to "/" if notification data has no url
const url = event.notification.data?.url || "/";
// sw.js:130 — opens a new window at that url
return self.clients.openWindow(url);
// App.tsx:466 — picks the single most-recently-active live session
const live = data.sessions?.[0]; // sorted most-recently-active first
```

**Fix:** Have the server include the session-scoped URL in the push payload (`data.url = /?project=<id>&session=<path>`), and have `restoreLiveSession` honor explicit query params (Path 0) before falling back to sessionStorage/live-sessions. Minimum: parse `URLSearchParams(location.search)` for `project`/`session` at the top of `restoreLiveSession` and short-circuit to that session.

---

### [MEDIUM] `notificationclick` focuses the FIRST matching window without checking if that window's WS is dead — focusing a backgrounded window does not trigger a reconnect probe

**Location:** `packages/client/public/sw.js:114-128`; ties to [HIGH] #3 (no visibilitychange probe)

**Scenario:**
1. The PWA window is alive but backgrounded on iOS. Its WS is silently dead (see [HIGH] #3).
2. Push notification arrives. User taps it. `notificationclick` → `matchAll` finds the existing window → `client.focus()` (`sw.js:121-124`).
3. The window is focused, but focusing does NOT fire `visibilitychange` to "visible" in a way that triggers a reconnect (and there is no `visibilitychange` handler anyway — [HIGH] #3). The dead WS stays dead. The user sees a stale UI.

**Impact:** The user is shown a stale, disconnected session with no indication it's dead. The live session on the server is fine but unreachable from this client until a manual reload.

**Evidence:**
```js
// sw.js:120-124 — focuses first matching window, no liveness check
for (const client of clients) {
  if (client.url.includes(self.location.origin) && "focus" in client) {
    return client.focus();
  }
}
```

**Fix:** Resolved by the [HIGH] #3 `visibilitychange` probe — `client.focus()` DOES fire `visibilitychange` → visible in most browsers, so the probe + reconnect path handles it. No separate fix needed once #3 is in place. (Note: iOS Safari standalone may not fire `visibilitychange` on `focus` of an already-foregrounded-but-suspended window; the server-side ping is the belt-and-suspenders fix.)

---

### [MEDIUM] `CLEAR_CACHE` message wipes ALL caches mid-session with no coordination → next navigation has no shell → blank page → cannot reattach

**Location:** `packages/client/public/sw.js:147-153`

**Scenario:**
1. Some future code (or a devtools manual `postMessage`) sends `{ type: "CLEAR_CACHE" }` to the SW.
2. `sw.js:150-153`:
   ```js
   caches.keys().then((keys) => keys.forEach((key) => caches.delete(key)));
   ```
   This deletes `pi-web-static-v1`, `pi-web-api-v1`, AND `pi-web-v1` — ALL caches, including the precached shell.
3. The current page keeps running (in-memory JS is fine). But the NEXT navigation (reload, router nav to `/`, or `applyUpdate` reload) → cache-first for `/` → MISS → network → if the network is down (offline PWA), blank page. Even online, the reload re-fetches everything, which is fine — but the `applyUpdate` reload path specifically calls `window.location.reload()` (`usePWA.ts:69`), and if it races a `CLEAR_CACHE`, the reload loads with no cached shell and no network → stuck.

**Impact:** Currently LOW because NOTHING in the codebase sends `CLEAR_CACHE` (verified: `grep CLEAR_CACHE packages/client/src` → NONE; only `sw.js:151` handles it). It is dead-code-unreachable today. But it is an uncoordinated footgun: if ever wired to a version-mismatch auto-clear, it would blank the app mid-session.

**Evidence:**
```js
// sw.js:147-153
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") { self.skipWaiting(); }
  if (event.data?.type === "CLEAR_CACHE") {
    caches.keys().then((keys) => keys.forEach((key) => caches.delete(key)));
  }
});
```

**Fix:** If `CLEAR_CACHE` is ever needed, it must re-precache the shell (`PRE_CACHE_URLS`) in the same `waitUntil` before returning, so the next navigation has a shell. Better: delete it entirely (dead code) unless a caller is added; or scope it to only non-static caches. Today it's safe-by-disuse, so this is a NOTE, not a blocker.

---

### [LOW] `clients.claim()` on activate does not retroactively control pre-existing uncontrolled clients — but the app degrades gracefully (SW fetch handler simply doesn't run for those tabs)

**Location:** `packages/client/public/sw.js:40` (`then(() => self.clients.claim())`)

**Scenario:**
1. Tab A loads the app BEFORE any SW is registered (first-ever visit, or SW was evicted). The SW registers on `load` (`index.html:52-54`) but Tab A's initial load was uncontrolled.
2. `clients.claim()` makes the SW control Tab A, but only for FUTURE fetches — the already-loaded document and its in-flight resource requests are not retroactively intercepted.
3. On a subsequent navigation WITHIN Tab A, the SW controls it normally.

**Impact:** For the FIRST load, the app works without SW interception (fetches go to network directly — fine, the app functions). The live-session recovery (`restoreLiveSession`) runs regardless of SW control because it's application logic, not SW-mediated. So an uncontrolled client CAN still reattach. This is NOT a session-loss path. The only subtlety: `useServiceWorkerUpdate` won't fire for an uncontrolled client until the next navigation, so update notifications are delayed — but that's cosmetic.

**Evidence:** `clients.claim()` (`sw.js:40`) is present and correct; the edge case is inherent to the SW spec. No fix needed.

---

### [LOW] `periodicsync`/`checkForUpdates` and `sync`/`retryFailedRequests` are no-ops — confirmed they cannot disrupt

**Location:** `packages/client/public/sw.js:91-97,140-142`

**Scenario:** `periodicsync` fires (Android Chrome 94+). `checkForUpdates()` is `async function checkForUpdates() {}` — returns immediately. `event.waitUntil` resolves. No side effects. `sync` fires on connectivity restore; `retryFailedRequests()` is empty — resolves immediately.

**Impact:** None. These are inert. They cannot disrupt a session or evict a cache. Safe. (The real issue — that `retryFailedRequests` SHOULD retry queued prompts — is covered in [HIGH] #4.)

**Evidence:** `sw.js:96-97` `async function retryFailedRequests() { /* Future */ }`; `sw.js:141-142` `async function checkForUpdates() { /* Future */ }`.

**Fix:** None required for safety. Delete the dead handlers if not planning to implement (ponytail: no unrequested scaffolding), or leave them inert. The functional gap is addressed in [HIGH] #4.

---

### [LOW] Scope/start_url/scope alignment is correct — SW controls the page

**Location:** `packages/client/public/manifest.json:6,10` (`start_url: "/"`, `scope: "/"`); `packages/client/index.html:54` (`register("/sw.js", { scope: "/" })`); `packages/server/src/index.ts:2738-2753` (`Service-Worker-Allowed: "/"`)

**Scenario:** `start_url`, `scope`, and the registration `scope` are all `/`. The server serves `sw.js` with `Service-Worker-Allowed: /` (`index.ts:2744`). So the SW's max scope is `/`, matching the registration scope. The SW controls all same-origin pages.

**Impact:** No scope mismatch. The fetch handler runs for all navigations and same-origin GETs. This path is SAFE.

**Evidence:** `manifest.json:6` `"start_url": "/"`; `manifest.json:10` `"scope": "/"`; `index.html:54` `register("/sw.js", { scope: "/" })`; `index.ts:2744` `"Service-Worker-Allowed": "/"`.

---

## EXHAUSTIVE CHECKLIST

Every lifecycle path verified. ✅ = safe/robust, ⚠️ = unverifiable or fragile, ❌ = broken.

### SW Registration & Scope
- ✅ `navigator.serviceWorker.register("/sw.js", { scope: "/" })` IS called — in `index.html:54` (inline, on `load`). NOT missing. `usePWA.ts` is not the registration site; the registration is in `index.html`. Confirmed present.
- ✅ `manifest.json` `start_url:"/"` and `scope:"/"` match the SW scope `/`.
- ✅ Server serves `/sw.js` with `Service-Worker-Allowed: "/"` and `Cache-Control: no-cache, no-store, must-revalidate` (`index.ts:2738-2753`) — so the SW itself is always re-fetched fresh (byte-for-byte `update` check works).
- ✅ `dist/sw.js` is byte-identical to `public/sw.js` (md5 match) — the served SW is the source SW.
- ✅ SW registration failure (`catch` at `index.html:66-68`) logs a warning and the app continues WITHOUT a SW — fetches go to network directly. The app functions; `restoreLiveSession` runs; WS reattaches. SAFE.
- ✅ `clients.claim()` on activate (`sw.js:40`) — uncontrolled first-load clients are controlled on next navigation; current load works uncontrolled. Not a session-loss path ([LOW] #8).

### SW Install / skipWaiting
- ✅ `install` precaches shell + `skipWaiting()` (`sw.js:25-27`). New SW takes over immediately.
- ⚠️ `skipWaiting` on install means the new SW activates without waiting — correct for fast updates, but combined with the non-versioned cache ([CRITICAL] #1), the activate handler purges nothing.

### SW Activate / cache cleanup
- ❌ `activate` deletes only caches whose NAME ≠ the three hardcoded `v1` names (`sw.js:34-40`). Since `STATIC_CACHE="pi-web-static-v1"` never changes across deploys, stale entries inside `pi-web-static-v1` are NEVER purged. → [CRITICAL] #1.
- ✅ `clients.claim()` present.

### SW Fetch — API (network-first)
- ✅ `/api/*` is network-first with cache fallback (`sw.js:48-69`). Only `/api/health` is cached (`CACHEABLE_API` at `sw.js:16`). `/api/projects/:id/live-sessions` is NOT in `CACHEABLE_API` → never cached → a cache-cleared refresh correctly hits network. No stale live-sessions response can be served. SAFE.
- ✅ Non-GET and cross-origin skipped (`sw.js:43-44`) — no mutation caching, no cross-origin interference.
- ✅ `ws:`/`wss:` skipped (`sw.js:46`) — WebSocket upgrade is never intercepted by the SW fetch handler.

### SW Fetch — Static (cache-first)
- ❌ Navigation to `/` and `/assets/*` are cache-first with no `request.mode === "navigate"` special-case (`sw.js:72-83`). → [CRITICAL] #1 (stale-forever + partial-eviction-blank-page).
- ✅ Content-hashed `/assets/*.js` are immutable by hash — cache-first is correct for them (once a hash is cached it never changes). The problem is ONLY the HTML entry (`/`) referencing new hashes.

### SW Update flow (skipWaiting + reload)
- ⚠️ `applyUpdate` posts `SKIP_WAITING` then immediately reloads (`usePWA.ts:64-70`). The postMessage is a no-op in the normal flow (`.waiting` is null by the time the banner shows). The reload is the actual apply. Latent race if `install` ever stops calling `skipWaiting`. → [HIGH] #2.
- ✅ The reload itself does NOT lose the session: `sessionStorage` (`LIVE_SESSION_KEY`) survives reload, `restoreLiveSession` runs on mount (`App.tsx:448-493`), WS reconnects, server agent is NOT reaped (idle timer gated on `clientCount===0`, and `onClose` detaches — `index.ts:2707-2714`). SAFE for the reload.
- ✅ Recovery and reload are composed correctly: `restoreLiveSession` runs on every mount regardless of why the page loaded. The forced reload does NOT skip the recovery endpoint.
- ⚠️ No `controllerchange` listener — update application relies entirely on user clicking "Update" (banner is dismissible, dismissal persisted in `localStorage` — `PWABanner.tsx:6-16`). A user who dismisses once never sees the prompt again and runs stale forever (compounded by [CRITICAL] #1).

### SW Deletion / unregister / failed registration
- ✅ If the SW is unregistered or fails to register, the app fetches directly from network (`index.html:66-68` catch). `restoreLiveSession` and WS reattach work without the SW. SAFE.
- ❌ If the SW IS registered but the cache holds a stale `/` referencing a deleted JS bundle (partial eviction), the app breaks with no self-heal. → [CRITICAL] #1.

### App backgrounding / OS suspension (mobile PWA / iOS)
- ❌ No `visibilitychange`/`document.hidden` listener anywhere in `packages/client/src` (verified). No WS heartbeat. `ws.onclose` does NOT reliably fire on iOS suspend. Client can believe `readyState==1` while socket is dead → silent send drops. → [HIGH] #3.
- ✅ `ws.onclose` DOES drive reconnect when it fires (`useWebSocketPool.ts:144-156`) — exponential backoff then slow-forever (`ws-pool-logic.ts:18-24`). So desktop/Android (where `onclose` fires) recover fine.
- ✅ Server keeps the agent alive during client suspension: `onClose` detaches but `maybeStartIdleTimer` only arms at `clientCount===0 && !isActive()` (`pi-agent.ts:424-428`); a half-open socket keeps `clientCount>0` so the idle timer doesn't fire. The watchdog (`pi-agent.ts:454-477`) only force-stops wedged agents with `clients.size===0` — a half-open socket keeps the client count inflated, so the watchdog won't reap it either. The session survives on the server. The problem is purely client-side reachability.
- ⚠️ No server-side ping/keepalive (verified: no `ping`/`pong`/`isAlive`/`setInterval` heartbeat in `packages/server/src`). Half-open sockets are never detected server-side; they linger until TCP timeout (can be minutes–hours). This keeps the agent alive (good) but means the server can't proactively close a dead client to trigger client reconnect.

### useOnlineStatus
- ⚠️ `useOnlineStatus` (`usePWA.ts:75-90`) only drives the offline banner (`PWABanner.tsx:49`). It does NOT trigger a WS reconnect or probe. On `online` event, the banner hides but a dead WS stays dead. → [HIGH] #3.

### useBackgroundSync / retryFailedRequests
- ❌ `useBackgroundSync` is dead code — defined (`usePWA.ts:92-118`) but NEVER imported anywhere (verified). `retryFailedRequests()` is empty (`sw.js:96-97`). A prompt queued while offline is lost. → [HIGH] #4.
- ✅ `ws.onopen` reconnect re-requests `get_state`/`get_messages` (`useWebSocketPool.ts:128-134`) — so message HISTORY is restored on reconnect. The gap is ONLY unsent prompts (steering/follow-up), not history.

### Push / notificationclick reattach
- ⚠️ `notificationclick` focuses first matching window or opens new window at `url||"/"` (`sw.js:110-133`). New tab reattaches via `/live-sessions` fallback but picks the most-recently-active session, not necessarily the notification's session. → [MEDIUM] #5.
- ⚠️ Focusing a backgrounded window with a dead WS doesn't trigger reconnect (no visibility probe). → [MEDIUM] #6 / [HIGH] #3.
- ✅ Duplicate-session safety: `getOrConnect` keys by `${projectId}::${sessionPath}::${newSessionId}` (`useWebSocketPool.ts:430-440`); server `buildAgentKey` normalizes `sessionPath` (`pi-agent.ts:578-588`) so a reattach finds the EXISTING agent instead of spawning a duplicate. No duplicate PI process. SAFE.

### CLEAR_CACHE message
- ✅ Nobody sends `CLEAR_CACHE` today (verified: `grep` → only `sw.js:151` handles it). Dead-code-unreachable. SAFE by disuse. → [MEDIUM] #7 (footgun if ever wired).

### periodicsync / checkForUpdates
- ✅ `checkForUpdates()` is empty (`sw.js:141-142`). Cannot disrupt. SAFE. → [LOW] #9.

### Live-session recovery composition
- ✅ `restoreLiveSession` (`App.tsx:448-493`) runs on mount, gated once by `restoreAttemptedRef` (`App.tsx:87,472`). Path 1: `sessionStorage` (survives reload). Path 2: `GET /api/projects/:id/live-sessions` (server pool source of truth). Both reattach by `sessionPath` directly, NOT requiring the file to be on disk yet (`App.tsx:442-447`) — so a brand-new session (pre-first-message) is recoverable. SAFE and well-designed.
- ✅ `sessionStorage` persist effect (`App.tsx:508-516`) is gated on `restoreAttemptedRef` AND a real leave of chat — the mount-before-restore window preserves the seed (commented at `App.tsx:494-507`). SAFE.
- ✅ The forced reload from `applyUpdate` does NOT skip recovery — `restoreLiveSession` runs on the reloaded page. SAFE.
- ✅ Cache-cleared refresh: `sessionStorage` is wiped → Path 2 (server `/live-sessions`) fires → reattaches to the most-recently-active live agent. SAFE (this is the designed hard-path recovery).
- ⚠️ If the app is stuck on a blank page ([CRITICAL] #1 partial-eviction), `restoreLiveSession` never runs because the JS never mounts. This is the one path where recovery is defeated — not by the recovery logic, but by the SW cache serving a broken shell.

### Multiple SW versions / controlled vs uncontrolled
- ✅ `skipWaiting` + `clients.claim()` ensures the newest SW controls clients ASAP. Uncontrolled first-load clients degrade gracefully (network fetches, app logic unaffected). → [LOW] #8.

### Scope / start_url
- ✅ All aligned to `/`. → [LOW] #10.

---

## Summary

| # | Severity | Title | Session-loss? |
|---|----------|-------|---------------|
| 1 | CRITICAL | Cache-first nav + non-versioned `STATIC_CACHE` → stale-forever / partial-eviction blank page | YES (partial-eviction: blank page, can't load to reattach) |
| 2 | HIGH | `applyUpdate` postMessage + immediate reload races controller; `.waiting` is null | No (latent race; reload-reattach is safe today) |
| 3 | HIGH | No visibilitychange probe / WS heartbeat → dead socket on iOS suspend | YES (silent disconnect, no self-heal on mobile) |
| 4 | HIGH | `useBackgroundSync` dead code; `retryFailedRequests` no-op → offline prompt lost | Partial (input lost, session survives) |
| 5 | MEDIUM | `notificationclick` new tab reattaches to wrong session | No (wrong target, not lost) |
| 6 | MEDIUM | `notificationclick` focus doesn't trigger reconnect | YES (ties to #3) |
| 7 | MEDIUM | `CLEAR_CACHE` wipes shell mid-session uncoordinated | No (dead code today) |
| 8 | LOW | `clients.claim` uncontrolled first-load | No (degrades gracefully) |
| 9 | LOW | `periodicsync`/`sync` no-ops | No (inert) |
| 10 | LOW | Scope/start_url aligned | No (safe) |

**What IS robust:**
- The live-session recovery logic itself (`restoreLiveSession`, Path 1 + Path 2 server fallback) is well-designed and handles reload, cache-cleared refresh, and new-session-before-first-prompt correctly.
- The server-side agent pool keeps agents alive during client suspension (idle timer + watchdog correctly gated on `clientCount===0` / `isActive()`); `buildAgentKey` path normalization prevents duplicate agents on reattach.
- WS reconnect backoff is "never give up" (exponential then slow-forever).
- Message history is restored on reconnect (`messages_result` merge).
- `/api/*` is network-first; `/live-sessions` is never cached → no stale reattach target.
- `ws:`/`wss:` and non-GET/cross-origin are correctly excluded from the SW fetch handler.
- The server serves `/sw.js` with `no-cache` + `Service-Worker-Allowed: /`.

**The two findings that can actually cause an unreachable live session are [CRITICAL] #1 (cache poisoning → blank page) and [HIGH] #3 (iOS suspend → silent dead socket).** Everything else is either latent, cosmetic, or safe-by-disuse.
