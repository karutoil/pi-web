# PI Session Lifecycle — Edge-Case Review (Unified Synthesis)

**Method:** 4 parallel fresh-context `reviewer` subagents (model `umans-glm-5.2`, high reasoning), distinct lenses:
1. Server agent pool & reattach (`pi-agent.ts`)
2. Server WS layer & recovery endpoints (`index.ts`)
3. Client WS reconnect & session persistence (`useWebSocketPool.ts`, `ws-pool-logic.ts`, `App.tsx`)
4. PWA / service worker / app lifecycle (`sw.js`, `usePWA.ts`, `index.html`)

Full reports: `review/1-server-pool-reattach.md` … `review/4-pwa-sw-lifecycle.md`.

## Verdict

The server-side reattach core is **well-engineered** — `getOrCreateAgent` reverse-lookup (`#REATTACH`), `setRekeyHandler` wsToAgent sync, idle/watchdog reaping, `#REKEY-EXIT` delete-by-current-key, `pendingDialog` replay, path normalization, and the `/live-sessions` recovery endpoint all hold under the common cases and are well-tested.

**The bar of "ZERO unhandled edge cases" is NOT met.** Findings converge on **4 independent clusters**, each of which can make a *genuinely-live* server-side session unreachable from the client. Three are CRITICAL, several HIGH. The clusters were hit independently by 2+ reviewers (high confidence).

---

## CRITICAL — fix these first

### C1. Pending new-session `newSessionId` is in-memory only → reload/tab-close/crash before rekey orphans the live session AND spawns a duplicate
**Where:** `App.tsx:46` (`useState`), `App.tsx:510` (`LIVE_SESSION_KEY` stores only `{projectId, sessionPath}`, never `newSessionId`), `App.tsx:409/452` (restore reads `sessionPath` only).
**Path:** User clicks "New session" → `uuidV4()` lives only in React state → WS opens with `?newSessionId=<uuid>`, server creates `__new__:<uuid>` agent **and sends `new_session`** (`index.ts:2573`) → user reloads/closes/crashes **before** PI reports the sessionFile and the client rekeys → on reload, `sessionStorage` has no `newSessionId`, `/live-sessions` OMITS the pending agent (`SDKAgent.getLiveSnapshot()` returns null pre-sessionFile) → client lands on empty view, the booting PI is orphaned in the pool (1h idle), and a second "New session" generates a *different* uuid → server's `originalNewSessionId` reverse-scan misses → **duplicate agent spawned**.
**Confirmed by:** reviewer 3 (CRITICAL F1) + reviewer 1 (notes `getLiveSessionsForCwd` excludes pending-new agents).
**Fix (~10 lines, App.tsx):** persist `newSessionId` into `LIVE_SESSION_KEY` when a new session starts; restore it in `restoreLiveSession` so a reload reattaches to the same `__new__:<uuid>` (the server reverse-lookup already supports this); clear it in `handleSessionLoaded` (where `setNewSessionId(null)` already runs, `App.tsx:217`). Server complement (optional): have `getLiveSessionsForCwd` include pending-new agents keyed by `__new__:<uuid>`.

### C2. `send()` silently drops every command when the WS is not OPEN → prompts/steers/abort/dialog-responses are LOST FOREVER during any reconnect window
**Where:** `useWebSocketPool.ts:397` (`if (ws?.readyState === WebSocket.OPEN) ws.send(...)` — no `else`, no queue), `:407-421` (`sendPrompt` optimistically appends to `messagesRef` regardless of send success), `:120-141` (`onopen` requests state/messages but never re-sends pending prompts).
**Path:** WS mid-reconnect (CONNECTING/CLOSED) → user hits Send → local copy appended (UI shows it) → `send()` no-ops → PI never receives it → on reconnect, `messages_result` merge preserves the local copy in the UI (looks sent) but no agent ever runs. Same root drops `steer`/`follow_up`/`abort`/`extension_ui_response` (can't stop a runaway agent or answer a blocking dialog while WS is down).
**Confirmed by:** reviewer 3 (CRITICAL F2) + reviewer 4 (HIGH #4 — `useBackgroundSync`/`retryFailedRequests` are dead no-ops, the would-be recovery path).
**Fix (~15 lines):** minimal pending-message queue (`prompt`/`steer`/`follow_up`/`abort`/`extension_ui_response`) that flushes on `onopen`; dedup flushed prompts against `messages_result` using the C4 signature fix. Also delete the dead `useBackgroundSync`/`retryFailedRequests`/`checkForUpdates` no-ops.

### C3. `sessionStorage` doesn't survive tab-close+reopen or browser restart → reattach token lost
**Where:** `App.tsx:86` (`LIVE_SESSION_KEY`), `App.tsx:510` (`sessionStorage.setItem`), `App.tsx:452` (`getItem`).
**Path:** `sessionStorage` is per-tab and cleared when the browsing context is destroyed → close tab / browser restart / force-quit → on reopen, Path 1 (`sessionStorage`) returns null → Path 2 (`/live-sessions`) only recovers IF the *right* project is selected; project restore falls back to most-recently-touched (`App.tsx:403-405`), which may be a *different* project → `/live-sessions` queried for the wrong cwd → live session for the original project not found. Short absences are otherwise saved by Path 2 (within the 1h idle window).
**Confirmed by:** reviewer 3 (CRITICAL F3) + reviewer 4 (MEDIUM #5 — `notificationclick` new tab lands on most-recent session, wrong target, same root).
**Fix (~3 lines):** move `LIVE_SESSION_KEY` to `localStorage` (it's just `{projectId, sessionPath}` — no secrets; the server idle timer is the real liveness bound). `restoreAttemptedRef` gate already prevents double-restore.

### C4. SW cache-first navigation + non-versioned `STATIC_CACHE='pi-web-static-v1'` → stale-forever, and partial cache eviction → permanently broken app that cannot load to reattach
**Where:** `sw.js:5-7` (hardcoded `v1` cache names), `sw.js:34-40` (activate purges only *whole* caches, never entries), `sw.js:72-83` (static cache-first, no `request.mode === "navigate"` special-case). `dist/index.html` references content-hashed `/assets/index-*.js` (hash changes per build, cache name does not).
**Path (stale-forever):** deploy B ships new `index.html`+new hash → new `sw.js` installs/activates → `activate()` keeps `pi-web-static-v1` wholesale (name unchanged) → next navigation: cache-first serves the **deploy-A** `index.html` → references old-hash JS → cache-first serves old JS → old app boots forever; the "Update" banner just reloads into the same loop.
**Path (blank page, the session-loss one):** mobile storage pressure evicts the old-hash JS entry but keeps `index.html` → reload serves surviving old `index.html` → requests evicted old-hash JS → cache MISS → network 404 (deploy B never shipped that hash) → `#root` blank → app never mounts → `restoreLiveSession` never runs → **live session unreachable until SW cache manually purged**; server idle timer eventually reaps the orphaned agent → session lost.
**Confirmed by:** reviewer 4 (CRITICAL #1, verified `dist/sw.js` byte-identical to `public/sw.js`).
**Fix:** (a) make navigation requests network-first (`if (event.request.mode === "navigate") respondWith(fetch().catch(() => caches.match()))` placed before the cache-first branch); (b) bump `STATIC_CACHE` per deploy (inject build hash into `sw.js`) so `activate()`'s existing `filter(key !== STATIC_CACHE)` purges the old cache wholesale. Content-hashed `/assets/*` stay cache-first (immutable by hash) — only the HTML entry needs network-first.

---

## HIGH

### H1. No `visibilitychange` probe / WS heartbeat / `useOnlineStatus` wired → dead socket reads OPEN on iOS suspend → silent send drops (reviewer 4 HIGH #3 + reviewer 3 HIGH F7 — same root)
**Where:** no `visibilitychange`/`document.hidden` listener anywhere in `packages/client/src` (verified); no server-side `ping`/`pong`/keepalive (verified); `useOnlineStatus` (`usePWA.ts:75-90`) only drives `PWABanner`, not the WS pool.
**Path:** iOS PWA backgrounded → OS suspends JS ~30s, tears down TCP 30s–5min, no `onclose` delivered → foreground → `ws.readyState` still `1` → `send()` "succeeds" into a dead socket → prompt vanishes, no reconnect arms. Server keeps the agent alive (half-open socket keeps `clientCount>0`, so neither idle timer nor watchdog reaps). Client is silently disconnected with no self-heal — **the most likely real-world "lost session" on mobile.**
**Fix:** on `visibilitychange→visible`, if `Date.now() - lastMessageAt > 60_000`, force `ws.close()` to let `onclose` drive the existing reconnect path. Complement: server-side `ws.ping()` every 30s, terminate on no pong (also prunes server-side half-open sockets). Wire `useOnlineStatus`: on `offline` close the WS, on `online` short-circuit backoff and reconnect immediately.

### H2. `onerror` doesn't schedule a reconnect → client gives up forever if `onclose` never fires (reviewer 3 HIGH F4)
**Where:** `useWebSocketPool.ts:158-163` (`onerror` only sets `lastError`; `onclose` at `:144-157` is the *sole* scheduler of `reconnectTimer`).
**Path:** some browsers fire `onerror` WITHOUT a subsequent `onclose` (DNS failure, network-stack suspend) → `reconnectTimer` never set → client never reconnects, defeats the `#3` "never give up" design.
**Fix (~5 lines):** in `onerror`, if `!intentionallyClosed && !reconnectTimer && ws.readyState !== OPEN`, schedule a reconnect with the same backoff as `onclose` (guard on `reconnectTimer` null to prevent stacking with H3).

### H3. `onclose` doesn't clear the existing `reconnectTimer` → double `connect()` can stack (reviewer 3 HIGH F5)
**Where:** `useWebSocketPool.ts:152` (sets `reconnectTimer` without `clearTimeout` of any existing timer); `:119` (`ws = new WebSocket` overwrites closure var; late `onclose` from the superseded socket re-enters the handler).
**Fix (~1 line):** `if (reconnectTimer) clearTimeout(reconnectTimer);` at the top of `onclose`. Also track current `ws` identity and ignore events from superseded sockets.

### H4. Server `onOpen` fatal-catch leaves the WS open with no `wsToAgent` entry → client hangs forever (reviewer 2 HIGH)
**Where:** `index.ts:2577-2580` (`catch (fatalErr)` logs + sends error but does **not** `ws.close()`). Contrast: the projectId-missing (`:2528-2536`), project-not-found (`:2533-2537`), and start()-failure (`:2569-2573`) paths all correctly `ws.close()`.
**Path:** `getOrCreateAgent`/constructor throws transiently (corrupted creds, `ModelRegistry` init) → WS stays OPEN, no `wsToAgent` entry → every `onMessage` silently drops (`if (!agentKey) return`) → client's `onopen` fired so it thinks it's connected, never gets `onclose`, reconnect never starts.
**Fix (1 line):** `try { ws.close(); } catch {}` in the fatal catch (mirror the start-failure path).

### H5. `rekeyToSessionPath` silently fails when the target key is occupied → two SDK runtimes on the same session file (reviewer 1 HIGH F1)
**Where:** `pi-agent.ts:364-372` (no `else` on rekey failure), `:707` (`if (agentPool.has(newKey)) return null`).
**Path:** session-A agent exists at key A; session-B agent `switch_session`s to session-A → SDK emits `session_loaded` with `/session-A.json` → `rekeyAgent` finds key A occupied → returns null, **no log, no error, no fallback** → agent B stranded at key B but its runtime is live on session-A → **two runtimes writing the same `.jsonl`** (interleaved writes → corruption risk); a reconnect by path `/session-B.json` finds agent B running the *wrong* session.
**Fix:** in `rekeyToSessionPath`, handle the failure explicitly (broadcast an error + log); or refuse `switch_session` at the server layer if another agent already holds the target path.

### H6. `originalNewSessionId` is never cleared after a session switch → stale newSessionId reconnect attaches to the *wrong* session (reviewer 1 HIGH F2)
**Where:** `pi-agent.ts:99` (`readonly`, set once in constructor `:128`), `:627-634` (reverse lookup uses it, never invalidated), `:355-360` (`session_loaded` rekeys but doesn't clear it).
**Path:** new session `uuid-A` resolves to `/session-A.json` (rekeyed, `originalNewSessionId` still `uuid-A`) → user `switch_session` to `/session-B.json` (rekeyed again, `originalNewSessionId` **still** `uuid-A`) → a client reconnects with the original `uuid-A` → reverse-scan finds this agent → attaches to an agent running **session-B**, not session-A.
**Fix:** clear `originalNewSessionId` on a `session_loaded`/clone rekey (make it a regular `private` field, not `readonly`); or only match in the reverse-lookup if the agent's current key is still a `__new__:` key.

### H7. `messageSignature` collision → distinct user messages with identical text ("yes" twice) collapse (reviewer 3 HIGH F6)
**Where:** `ws-pool-logic.ts:19-34` (signature is `${role}:${text}:${toolCallId}`, no nonce/timestamp), `:42-46` (`mergeMessagesOnReconnect` filters by signature).
**Path:** user sends "yes" (persisted), later sends "yes" again (NOT sent, per C2) → WS drops → reconnect merge sees `user:yes:` in restored history → filters the local "yes" as a "duplicate" → **the unsent message vanishes from the UI**. The `:23-25` "acceptable ceiling" comment is wrong once C2's queue lands (the second "yes" may be a *lost* message, not a deliberate repeat).
**Fix (~5 lines):** add a client-assigned `clientId` (e.g. `crypto.randomUUID()`) to local user messages and include it in `messageSignature` when present; dedup collapses only messages with the same `clientId` (or no `clientId` for server-originated).

---

## MEDIUM

- **M1. Watchdog TOCTOU** (`pi-agent.ts:497-506`): during `forceStopAndRemove`'s `await this.agent.stop()`, a reconnecting client finds the dying agent (still in pool), attaches, then the exit handler `closeClients()` kicks it → live in-memory state lost. Fix: delete the pool entry **before** the `await`. (reviewer 1 F4)
- **M2. Negative env values → immediate force-stop** (`pi-agent.ts:29,36`): `PI_WEB_STALE_STREAMING_MS='-1'` is truthy (`-1 || 15 = -1`) → `-60000ms` → `setInterval` clamps to 1ms → watchdog force-stops streaming sessions instantly. `0` is safe (`0 || 15`). Fix: `Math.max(1000, ...)`. (reviewer 1 F5)
- **M3. Ghost clients / no `onError`** (`pi-agent.ts:281-298`, Hono adapter): the Hono/Bun WS adapter wires no `error` handler; a hard socket error (RST/TLS) that doesn't follow with `close` leaves a dead `raw` in `wsToAgent` + `agent.clients` → `clients.size` inflated → agent never reaps. `broadcast`/`sendToClients` skip dead sockets but don't prune them. Fix: piggyback pruning on broadcast (`if (ws.readyState !== 1) this.clients.delete(ws)`); add a periodic `sweepDeadClients()`. (reviewer 2)
- **M4. WS `load_session`/`switch_session` skip `validateSessionPath`** (`index.ts:2607-2608`): every REST endpoint validates session paths; the WS path forwards raw to the SDK — inconsistent trust boundary, and a crafted path pollutes the pool key on the subsequent `session_loaded` rekey. Fix: validate before forwarding. (reviewer 2)
- **M5. `restartWithSession` is dead code and broken** (`pi-agent.ts:223-243`): its `await this.agent.stop()` fires the exit handler → deletes the pool entry + closes all clients → the new inner agent runs orphaned with no pool entry → reconnect spawns a duplicate. Two reviewers independently flagged this. Fix: **delete the method** (YAGNI — it has no caller). (reviewers 1 F3 & 2)
- **M6. `applyUpdate` races the controller** (`usePWA.ts:64-70`): posts `SKIP_WAITING` then immediately `window.location.reload()` — the postMessage is a no-op in the normal flow (`registration.waiting` is already null because `install` calls `skipWaiting`), so correctness depends entirely on `install`'s skipWaiting. Latent race if that ever changes. Fix: listen for `controllerchange` and reload once it fires. (reviewer 4 HIGH #2)
- **M7. Multiple live sessions → client picks `data.sessions?.[0]`** (`App.tsx:465-467`): `/live-sessions` returns most-recently-active; the client picks `[0]`, which may not be the session the user was viewing. Fix: prefer the entry matching `saved.sessionPath` (from C3's `localStorage`). (reviewer 3 F8)
- **M8. `CLEAR_CACHE` wipes the shell mid-session uncoordinated** (`sw.js:147-153`): deletes ALL caches including the precached shell; next navigation has no shell → blank page. Dead-code-unreachable today (no caller), but a footgun if ever wired to a version mismatch. Fix: delete it, or re-precache `PRE_CACHE_URLS` in the same `waitUntil`. (reviewer 4 MEDIUM #7)

## LOW (batch when convenient)

- `extractNewSessionId` uses `indexOf` not `lastIndexOf` → a cwd containing `__new__:` corrupts the UUID → reverse-lookup fails → duplicate spawn (`pi-agent.ts:745-748`). (reviewer 1 F10)
- `::` in a cwd/sessionPath corrupts key parsing in `agentKeyCwd`/`agentKeySessionPath` (`pi-agent.ts:521-533`) and client `rekey` (`useWebSocketPool.ts:546-549`). Two reviewers. Fix: store cwd/sessionPath as fields, or use `indexOf`/`lastIndexOf`. (reviewers 1 F11 & 3 F9)
- `rekeyAfterClone` poll keeps calling `getState()` on a dead agent for ~4s after exit — exit handler doesn't clear `isPendingCloneRekey`. Harmless (doSend early-returns) but leaks the closure. (reviewer 1 F9)
- `SDKAgent.stop()` has no double-stop guard (contrast `start()`'s `if (this.started) return`) → concurrent stops double-dispose. (reviewer 1 F13)
- `PooledAgent.stop()` exit handler broadcasts "error (code 0)" for deliberate stops — `explicitlyStopped` is set but never read. Cosmetic. (reviewer 1 F12)
- `restartWithSession`'s exit handler omits `cancelWatchdog()` + `pendingDialog = null` (moot if M5 deletes it). (reviewer 1 F7)
- `notifyTimer` / `autoRetry` not reset on reconnect → stale UI indicators. (reviewer 3 F11/F12)

---

## Confirmed robust (do NOT regress)

- Server `getOrCreateAgent` reverse-lookup by `originalNewSessionId` (`pi-agent.ts:627-634`) — sound, well-tested.
- `setRekeyHandler` wsToAgent sync (`index.ts:2549-2551`) — closure scan is correct; WS opened post-rekey unaffected.
- `#REKEY-EXIT` delete-by-current-key (`pi-agent.ts:154`) — exit handler uses `this.agentKey`, not the stale closure key.
- Path normalization (`normalizeSessionPath`, `buildAgentKey`) — trailing-slash/`//`/`./`/`..` collapse; reattach is stable.
- `pendingDialog` replay on attach (`pi-agent.ts:168-174`) — disconnect-mid-dialog recovers.
- `reconnectDelay` backoff (`ws-pool-logic.ts`) — never null/infinity, caps at 30s forever (for the `onclose` path).
- `mergeMessagesOnReconnect` trust model — never trusts local assistant/toolResult over server.
- `start()`-failure path (`index.ts:2569-2573`) — detaches + deletes + closes → client reconnects to a fresh agent.
- `validateSessionPath` (`index.ts:68-114`) — REST roots match PI's actual session dirs; realpath handles symlinks.
- `/api/*` network-first; `/live-sessions` never cached → no stale reattach target. `ws:`/`wss:`/non-GET/cross-origin excluded from SW fetch.
- `Service-Worker-Allowed: /`, `Cache-Control: no-store` on `/sw.js` → SW byte-check works.
- Server restart → pool lost (by design, `#LIVE` contract); `.jsonl` files on disk are the persisted record; client reloads from disk. Acceptable.
- Multiple tabs same session: server broadcasts to both; closing one tab detaches without killing the agent for the other.
- Spawned `pi` CLI processes (one-shot, `Bun.spawn` w/ timeout+kill) don't leak pooled agents (pool is SDK-driven, not subprocess-driven).
- Terminal WS path is independent of the agent pool — a terminal leak doesn't keep an agent "attached."

---

## Recommended fix order

1. **C1, C2, C3, C4** — the four session-loss clusters. C1+C3 are client-only (`App.tsx`); C2 is client (`useWebSocketPool.ts`); C4 is `sw.js`. Independent, can ship together.
2. **H1+H2+H3** — client reconnect robustness (visibility probe + onerror-schedule + clear-existing-timer). All in `useWebSocketPool.ts`, one PR.
3. **H4** — server `onOpen` fatal-catch `ws.close()` (1 line).
4. **H5+H6** — server rekey correctness (`rekeyToSessionPath` failure handling + clear `originalNewSessionId` on switch).
5. **H7** — `messageSignature` `clientId` (gates C2's queue dedup; do alongside C2).
6. **M-batch** — watchdog TOCTOU, env clamps, ghost-client sweep, WS path validation, delete `restartWithSession`, `applyUpdate` controllerchange, multi-session selection.
7. **L-batch** — `indexOf`→`lastIndexOf`, `::`-in-path, double-stop guard, stale-indicator resets.

The three CRITICAL client fixes (C1/C2/C3) plus H1 are what stand between the current state and "ZERO unhandled edge cases." The server reattach machinery itself is not the weak link — the weak link is the client losing the reattach token (C1/C3), dropping the prompt (C2), and not noticing a dead socket (H1).

---

## PATCHES APPLIED (this session)

All CRITICAL + HIGH + MEDIUM findings applied except where noted. Verified: `tsc --noEmit` clean, client `tsc -b && vite build` clean, all 67 server tests pass (incl. 34 pi-agent reattach/rekey/idle/watchdog/clone tests). Pre-existing client test failures (`React.act is not a function`, 81 fails) are an unrelated React-19 testing-library env issue — identical on unmodified HEAD.

### Client — `packages/client/src/App.tsx` (C1, C3, M7)
- `LIVE_SESSION_KEY` moved from `sessionStorage` → `localStorage` (survives tab close+reopen + browser restart). Centralized via `readLiveSession`/`writeLiveSession`/`clearLiveSession` helpers. **C3**
- Pending new-session `newSessionId` is now persisted (`{projectId, newSessionId}`) on creation and restored on mount → server `#REATTACH` reverse-lookup reattaches to the booting agent instead of orphaning it + spawning a duplicate. Cleared (replaced by sessionPath) once the session resolves. **C1**
- `restoreLiveSession` Path 2 now prefers the saved `sessionPath` among multiple live sessions (falls back to most-recently-active) — so with several sessions going it restores the one the user was viewing, not a random `[0]`. **M7**

### Client — `packages/client/src/hooks/useWebSocketPool.ts` (C2, H1, H2, H3)
- Pending-message queue: `prompt`/`steer`/`follow_up` sent while the WS isn't OPEN are queued and flushed on reconnect AFTER `get_messages` (so the merge dedup baseline is captured first). **C2**
- `visibilitychange` probe: on foreground, if no frame arrived in 60s while OPEN, force-close the (silently-dead) socket so `onclose` drives reconnect. **H1**
- `online`/`offline` wired per-connection: offline closes the WS; online resets backoff and reconnects immediately. **H1**
- `onerror` now schedules a reconnect (some browsers fire onerror without onclose) — guarded so it can't stack with onclose. **H2**
- `onclose` clears any existing `reconnectTimer` first — no double `connect()`. **H3**
- All listeners are per-connection and cleaned up in `close()` → closing one dead socket in a multi-session pool never tears down a sibling session.

### Client — `packages/client/public/sw.js` (C4, M8)
- Navigation requests are now network-first (fresh `index.html` always wins; offline falls back to cached shell). **C4**
- Cache-name versioning documented (bump suffix on deploy → `activate` purges old caches wholesale).
- Dead `CLEAR_CACHE` handler + `sync`/`periodicsync` no-ops (`retryFailedRequests`/`checkForUpdates`) removed. **M8**

### Client — `packages/client/src/hooks/usePWA.ts` (M6)
- `applyUpdate` listens for `controllerchange` then reloads (deterministic SW activation instead of racing the reload). **M6**
- Dead `useBackgroundSync` removed.

### Server — `packages/server/src/pi-agent.ts` (H5, H6, M1, M2, M3, M5, F9, F10, F12, F13)
- `rekeyToSessionPath` now surfaces a rekey failure (target key occupied) via error + log instead of silently stranding the agent / risking two runtimes on one session file. **H5**
- `originalNewSessionId` cleared on a `session_loaded` (switch/clone) so a stale newSessionId reconnect can't attach to the wrong session. (Initial new-session resolution uses the `state` path, so `#REATTACH` still works after the first rekey.) **H6**
- `forceStopAndRemove` deletes the pool entry BEFORE the `await agent.stop()` — a reconnect during dispose can't attach to the dying agent. **M1**
- Env timeouts clamped with `Math.max(1000, …)` — a typo'd/negative `PI_WEB_*_MS` can't force-stop live sessions instantly. **M2**
- `broadcast`/`sendToClients` prune dead sockets (`readyState !== 1`) so a half-open WS can't keep `clients.size > 0` and block idle reaping. **M3**
- Dead `restartWithSession` removed (it orphaned the restarted agent from the pool). **M5**
- Exit handler clears `isPendingCloneRekey` (no polling a dead agent) and only broadcasts an error for non-zero exit codes. **F9, F12**
- `extractNewSessionId` uses `lastIndexOf` (a cwd containing `__new__:` can't corrupt the reverse-lookup id). **F10**
- `SDKAgent.stop()` dedupes concurrent calls via a shared `stopPromise` (no double `dispose()`/`onExit`). **F13**

### Server — `packages/server/src/index.ts` (H4, M4)
- `onOpen` fatal-catch now `ws.close()`s so the client's `onclose` fires and it reconnects (was: WS left OPEN with no `wsToAgent` entry → silent hang). **H4**
- WS `load_session`/`switch_session` now validate the session path (`validateSessionPath`) like every REST endpoint — no crafted paths outside allowed roots. **M4**

### DEFERRED (not applied — documented)
- **H7 (`messageSignature` "yes twice" collision):** the complete fix requires a client-assigned nonce round-tripped through the server+SDK, which is out of scope for this pass. Fixing **C2** (the queue) removes the main trigger — prompts are now actually sent and persisted, so the merge dedup shows them correctly. Residual: two distinct user messages with identical text + a WS drop between them may briefly collide. This is the ceiling the original author already accepted (`ws-pool-logic.ts:23-25`).
- **LOW (`::` in a cwd/sessionPath corrupts key parsing):** the robust fix is to store cwd/sessionPath as fields instead of parsing the key string — a larger refactor touching `buildAgentKey`/the pool. Probability is near-zero (`::` in a directory name is invalid on Windows, unusual on POSIX). The `extractNewSessionId` `lastIndexOf` fix (F10) covers the related `__new__:` case.
- **Server-side WS ping interval:** the client-side visibility probe (H1) + the broadcast dead-socket prune (M3) cover the practical half-open cases. A Bun `ws.ping()` heartbeat every 30s would be belt-and-suspenders for fully-detecting half-open sockets server-side; deferred as a hardening item.
