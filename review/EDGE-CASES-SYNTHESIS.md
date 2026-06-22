# PI Live-Session Reconnect — Edge-Case Synthesis

**Goal:** enumerate EVERY edge case that severs (or falsely claims) the ability to connect back to a **LIVE** PI session, and prioritize fixes toward "zero unhandled edge cases."

> **✅ FIX STATUS (all 4 reviews complete):** all findings below are implemented and verified — `tsc --noEmit` clean; server suite 67/67 pass; client suite green for the relevant files (`App.sessionSwitch` 3/3 incl. the rewritten server-side-restore guard, `ws-pool-logic` 8/8). The only failing client tests are a **pre-existing** React 19 + `react-dom/test-utils` `React.act` env issue (confirmed present at HEAD before these edits, unrelated to the findings).
>
> **H6 (messageSignature duplicate-text collision)** is the one finding intentionally **not** behavior-changed: any client-side fix (adding `clientId` to the signature) would break the normal echo-dedup (server echoes lack a clientId) and cause duplicates in the common case. The ceiling is already documented in `ws-pool-logic.ts`; fully closing it needs server-side message identity (PI persisting a client-assigned id) — out of scope for a client-only change. The `pendingQueue` flush (C1) already ensures the duplicate-text message is *sent* to PI, so it reappears on echo.

**All 4 adversarial reviews complete** (layers 1/2/3/4).

**Source reviews (fresh-context, model `umans-glm-5.2`, thinking high):**
- `review/edgecase-1-server-pool.md` — server pool & process lifecycle (11 findings)
- `review/edgecase-3-client-reconnect.md` — client reconnect & restore (14 findings)
- `review/edgecase-4-pwa-sw.md` — PWA / Service Worker / offline (9 findings)
- `review/edgecase-2-server-ws.md` — server WS transport (pending)

**Architecture (refresher):** server-side pool of long-lived in-process `pi` agents (`PooledAgent`, keyed `cwd::sessionPath`); clients attach over WebSocket (`useWebSocketPool`). A *live* session = a pooled agent still running. Idle reaper (1h) and streaming watchdog (15m) reap dead agents. Restore path: `localStorage` → `GET /live-sessions` → `getOrConnect` reattach.

---

## 1. The bugs that ACTUALLY sever reconnect to a live session (ranked)

These are the subset that *lose a still-alive session* or *show a dead one as alive*. Fix these first.

### CRITICAL

| # | Layer | Bug | Mechanism | Evidence |
|---|-------|-----|-----------|----------|
| C1 | client | **`pendingQueue` infinite loop → frozen tab** | WS drops during the 200ms `onopen`→`setTimeout(200)` window with a queued prompt. `while (pendingQueue.length) send(shift())` re-queues the prompt (WS not OPEN) → infinite synchronous loop → tab hangs. Server agent still alive, client cannot reach it. | `useWebSocketPool.ts:139` (flush loop), `:453-462` (`send` re-queues prompt), `:136` (uncancelled 200ms timer), `:155` (`onclose` doesn't cancel it) |
| C2 | client | **Regression-guard test is BROKEN** | The test that guards the original "refresh loses the live PI session" bug expects `sessionStorage` + deps `[view, selectedProject, activeSession]`, but code now uses `localStorage` + `[view, selectedProject, activeSession, newSessionId]`. Test currently FAILS → the `restoreAttemptedRef` gate is unguarded by tests. | `App.sessionSwitch.test.tsx:70-71` vs `App.tsx:347-352,555` |
| C3 | client | **`abort` / `abort_retry` / `extension_ui_response` dropped during reconnect** | `pendingQueue` only queues `prompt`/`steer`/`follow_up`. User cannot stop a runaway live agent or answer a blocking dialog while WS is down. | `useWebSocketPool.ts:459-461` (queue condition), `:531` (`abortRetry`), `:580` (`extension_ui_response`) |

### HIGH

| # | Layer | Bug | Mechanism | Evidence |
|---|-------|-----|-----------|----------|
| H1 | server | **Idle-timer TOCTOU** (the F4 fix was NOT applied to the idle path) | Idle timer fires → `await agent.stop()` yields during `runtime.dispose()` → a client reconnects, finds the agent still in the pool, attaches → exit handler then fires `closeClients()`, kicking the just-attached client → fresh agent spawned from disk. **In-memory live state lost.** `forceStopAndRemove` was fixed (delete-before-await) but the *idle timer* was not. | `pi-agent.ts:458-471` (idle timer, NOT fixed) vs `:516-524` (`forceStopAndRemove`, fixed) |
| H2 | client | **`localStorage` cross-tab clobber** (regression from the F3 fix) | Two tabs on different sessions share one `localStorage` key; the last tab to switch wins. The other tab's reload reattaches to the **wrong** session; its real session is orphaned from its view. | `App.tsx:347-352,548,551` (no tab-scoping, no `storage` listener) |
| H3 | client | **bfcache zombie WS (short freeze)** | Tab backgrounded <60s on iOS → socket killed but `readyState` still OPEN. `onVisible` threshold is 60s from `lastMessageAt`, so it doesn't force-close. Sends silently drop into a dead buffer; user believes session is live. | `useWebSocketPool.ts:181-189` (60s threshold, no `pageshow`/`persisted` check) |
| H4 | pwa | **Offline partial-eviction → blank page** | Browser evicts a hashed `/assets/*.js` under storage pressure but keeps cached `/`. Offline nav serves stale `index.html` → cache-first asset MISS (evicted) → inner `fetch` rejects with no `.catch` → app never mounts → cannot reattach the (still-alive) server agent. | `sw.js:70-83` (nav fallback to stale `/`), `:85-98` (asset fetch, no `.catch`) |
| H5 | pwa | **`onOnline` creates a 2nd WS without closing the 1st** | `online` event fires without a preceding `offline` (partial flap). `connect()` overwrites `ws`; old OPEN socket lingers, its `onclose` later cascades more reconnects. Server `clients.size` inflated → idle timer never arms → agents linger. | `useWebSocketPool.ts:212-217` (no `ws.close()` before `connect()`) |
| H6 | client | **`messageSignature` collision hides user messages** (F6, unfixed) | Two distinct user messages with identical text ("yes" x2) collide on `role:text:toolCallId`. On reconnect merge, the local copy is filtered as "duplicate" → message vanishes from UI → user re-types → duplicate PI run. | `ws-pool-logic.ts:31,39-40` (no `clientId`) |
| H7 | client | **`rekey()` `split("::")` corrupts paths containing `::`** (F9, unfixed) | Splits on ALL `::`; `parts[1]`/`parts[2]` get truncated/wrong values → reconnect uses a truncated `sessionPath` → server spawns a **duplicate** agent; original orphaned. | `useWebSocketPool.ts:548` |

### MEDIUM (true-sever or false-alive)

| # | Layer | Bug | One-liner | Evidence |
|---|-------|-----|-----------|----------|
| M1 | server | **`isPendingNewSession` set false before rekey** | If rekey fails, agent is permanently stranded at `__new__:uuid`, undiscoverable → orphaned. | `pi-agent.ts:320-327` |
| M2 | server | **`new_session` RPC emits no `session_loaded`** | Rekey races `getState()` vs `newSession()` → agent keyed under wrong session → reconnect spawns duplicate. | `pi-agent.ts:1346-1351` vs `:1352-1365` |
| M3 | server | **Symlinked session path key mismatch** | WS onOpen uses raw path; `load_session` uses `realpathSync`. Rekey moves to real path → reconnect by symlink path misses → duplicate. | `index.ts:2508` vs `:2613`, `pi-agent.ts:615-618` |
| M4 | server | **Broken SDK runtime with no `onExit`** | Agent "alive" in pool but dead underneath; every `send` fails. No liveness probe. | `pi-agent.ts:143-157,1083-1101` |
| M5 | pwa | **No server-side WS ping/keepalive** | Killed PWA leaves half-open socket; `clients.size` stays >0 → idle timer never arms → agent lingers indefinitely (resource leak; reattach still works but cleanup is broken). | `pi-agent.ts:453,489` (gated on `clients.size===0`); no `ping`/`pong` anywhere server-side |
| M6 | pwa | **`onVisible` 60s threshold misses short dead sockets mid-stream** | `lastMessageAt` updated by streaming messages; a 30s backgrounding reads <60s → no close → zombie. | `useWebSocketPool.ts:202-208` |
| M7 | pwa | **5xx navigation has no cache fallback** | Server returns 500 for `/` → returned as-is (`.catch` only fires on network failure) → broken page, can't mount. | `sw.js:72-79` |
| M8 | pwa | **`notificationclick` focuses first window / ignores deep-link** (INERT today — no push wired) | Focuses any same-origin window; `restoreLiveSession` doesn't parse URL params → lands on wrong/most-recent session. | `sw.js:119-135`, `App.tsx:460-512` |
| M9 | client | **`restoreLiveSession` fetch race with user navigation** | `restoreAttemptedRef` set after the await; fetch result clobbers user's navigation / wrong project's restore. No `AbortController`. | `App.tsx:473,510,519-525` |

### LOW (not true-severs, included for completeness)
- server E5: 2nd-client messages dropped during `start()` window (`pi-agent.ts:1054-1057`).
- server E6/E10: stale `pendingDialog` replayed after being answered (`pi-agent.ts:297-303,1356`).
- server E8: `runtime.dispose()` hang leaks resources on fire-and-forget stop (`pi-agent.ts:671-679,1083-1101`).
- client E8/E10/E11/E12/E13/E14: `onOnline`/reconnect-timer race, stale `autoRetry`, uncleared `notifyTimer`, strict-mode unmount flit, fragile `split(":")` parse.
- pwa F7/F8/F9: non-automated `STATIC_CACHE` versioning, `clients.claim()` first-load (safe), `client.url.includes(origin)` spoofing (security, inert).

---

## 2. Cross-cutting themes (the "zero edge cases" levers)

1. **No server-side socket liveness probe.** *THE central gap.* Dead/half-open sockets aren't detected server-side, so `clients.size` stays inflated → idle timer never arms (agents linger) AND a "live" agent may have only dead clients. Appears as pwa-M5 and is the root of H5/H3/M6. **Add a server WS `ping`/`pong` interval** (Bun `ServerWebSocket.ping()`), prune on failure, re-eval `maybeStartIdleTimer()`. Layer 2 review will detail the server side.

2. **`stop()` TOCTOU is only half-fixed.** The F4 "delete pool entry before `await agent.stop()`" fix lives in `forceStopAndRemove` but NOT the idle timer (H1). Extract one `stopAndRemove()` used by idle timer + watchdog + `deleteFromPool` + `stopAgentsForCwd`.

3. **Rekey / session-identity → pool-key mapping is fragile.** M1/M2/M3/H7: multiple rekey paths can strand, mis-key, or duplicate an agent. Emit `session_loaded` from `new_session` (M2); clear `isPendingNewSession` only on rekey success (M1); resolve symlinks in `normalizeSessionPath`/WS onOpen (M3); use `indexOf`/`lastIndexOf` instead of `split("::")` in client `rekey` (H7).

4. **Multi-tab is unmodeled on the client.** H2: one shared `localStorage` key clobbers across tabs. Namespace the key per-tab (tab UUID in `sessionStorage` → namespaced `localStorage`), or use `BroadcastChannel`.

5. **Client has no authoritative liveness signal.** H3/M6/M4 + stale `autoRetry` (E10): the UI can show "live/streaming" while the socket or agent is dead. A server `ping` (#1) plus resetting transient UI state on `onopen` fixes the false-alive class.

6. **Input loss during reconnect is incomplete.** C3: the `pendingQueue` must also cover `abort`/`abort_retry`/`extension_ui_response` (server drops unknown dialog ids, so a duplicate response is harmless).

7. **Message identity is too weak.** H6: add a client-assigned `clientId` (`crypto.randomUUID()`) to `ChatMessage`, include it in `messageSignature`.

---

## 3. Test-coverage gaps (the safety net is torn)

- **The "refresh loses live session" regression test is broken** (C2) — fix first; it's the guard for the exact class of bug being hunted.
- **Zero SW tests** — nav fallback, asset cache-first, activate purge, all untested.
- **No `onVisible`/`onOnline`/`onOffline`/`pendingQueue` flush tests** in `useWebSocketPool.test.ts`.
- **No half-open-socket / server-ping test** (M5).
- **No multi-tab test** (H2).
- **No `restoreLiveSession` path-1/path-2 test**, no `newSessionId` persistence test.
- **No `new_session` rekey test** (M2), no symlink test (M3), no idle-timer TOCTOU test with an async-yielding `FakeAgent.stop()` (H1).

---

## 4. Path-to-"zero unhandled edge cases"

1. Fix C1, C3, C2 (client tab-freeze, dropped control messages, broken guard test) — small diffs, highest blast radius.
2. Fix H1 (idle-timer TOCTOU) — structurally verified, one shared `stopAndRemove()`.
3. Add server WS ping/pong (theme #1 / M5) — unblocks correct reaping and kills the false-alive class (H3/M6/M4).
4. Fix H2 (per-tab `localStorage` namespace) + H6 (`clientId`) + H7 (`indexOf` split) — multi-tab + identity correctness.
5. Fix rekey cluster M1/M2/M3 — `session_loaded` on `new_session`, clear flag on success, symlink resolution.
6. Fix H4/M7 (SW offline + 5xx fallback) — `.catch` on asset fetch, cache fallback on non-OK nav.
7. Backfill the test gaps in §3.

Layer 2 (server WS transport) findings will be merged into §1/§2 on completion.
