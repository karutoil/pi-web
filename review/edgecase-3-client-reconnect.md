# Adversarial Edge-Case Review: Client-Side WebSocket Reconnect & Live-Session Restore

**Scope:** `packages/client/src/hooks/useWebSocketPool.ts`, `lib/ws-pool-logic.ts`, `App.tsx`, supporting tests/components.
**Goal:** Find EVERY edge case where a user cannot reattach to a LIVE PI session still running on the server, or falsely believes a dead session is alive.
**Method:** Direct file inspection of CURRENT code. Prior review `review/3-client-ws-reconnect.md` consulted for context; findings re-verified and new gaps identified.
**Mode:** Review-only — no source files modified.

---

## Executive Summary

Many of the prior review's CRITICAL findings have been **FIXED** in the current code:
- **F1 (newSessionId persistence):** Now persisted in `localStorage` via `writeLiveSession` and restored in `restoreLiveSession`. **FIXED**.
- **F2 (send() drops):** A `pendingQueue` now captures `prompt`/`steer`/`follow_up` and flushes on reconnect. **PARTIALLY FIXED** — `abort`, `extension_ui_response`, `abort_retry` are still dropped.
- **F3 (sessionStorage):** Now uses `localStorage`. **FIXED** — but introduces new multi-tab interference.
- **F4 (onerror without onclose):** `onerror` now schedules reconnect. **FIXED**.
- **F5 (double-reconnect):** `onclose` clears existing `reconnectTimer` before scheduling. **FIXED**.
- **F7 (useOnlineStatus not wired):** Direct `online`/`offline` listeners added to each connection. **FIXED**.
- **F8 (wrong session from /live-sessions):** Now prefers saved `sessionPath` when available. **FIXED**.

**However**, the prior review's F6 (`messageSignature` collision), F9 (`split("::")`), F11 (`notifyTimer`), F12 (`autoRetry` not cleared) remain **UNFIXED**.

**NEW findings not in the prior review:**
- The regression-guard test for the "refresh loses the live PI session" bug is **BROKEN** — the regex expects `sessionStorage` but the code now uses `localStorage`; the test currently FAILS.
- The `pendingQueue` flush can enter an **INFINITE LOOP** if the WS drops during the 200ms `onopen`→`setTimeout(200)` window.
- `localStorage` is shared across tabs — two tabs on different sessions clobber each other's reattach token.
- `abort` and `extension_ui_response` are still silently dropped during reconnect (part of the F2 partial fix).

---

## Findings

---

### [CRITICAL] E1 — `pendingQueue` flush infinite loop if WS drops during the 200ms onopen window

**Location:** `packages/client/src/hooks/useWebSocketPool.ts:139` (`while (pendingQueue.length) send(pendingQueue.shift()!)`), `useWebSocketPool.ts:131-140` (`onopen` setTimeout block), `useWebSocketPool.ts:453-462` (`send` function).

**Trigger (exact sequence):**
1. WS drops → user sends a prompt → `send()` finds WS not OPEN → prompt pushed to `pendingQueue` (`useWebSocketPool.ts:461`).
2. WS reconnects → `onopen` fires (`useWebSocketPool.ts:132`) → `setTimeout(() => { ... }, 200)` scheduled (`useWebSocketPool.ts:136`).
3. WS drops AGAIN before 200ms elapses (server restart mid-handshake, network blip, rapid close cycle) → `onclose` fires (`useWebSocketPool.ts:155`) → `ws` is still the old socket, now CLOSED (readyState=3). `reconnectTimer` scheduled for ~1000ms later.
4. At T=200ms, the pending `setTimeout` callback fires:
   - `send({ type: "get_state" })` → `ws?.readyState === WebSocket.OPEN` is false (readyState=3) → message type not in queue list → silently dropped.
   - Same for `get_messages`, `get_last_assistant_text`, etc.
   - `while (pendingQueue.length) send(pendingQueue.shift()!)`:
     - `pendingQueue.length` is 1 (the queued prompt)
     - `shift()` removes prompt → `pendingQueue.length` is 0
     - `send(prompt)` → `ws.readyState !== OPEN` → `msg.type === "prompt"` → `pendingQueue.push(msg)` → `pendingQueue.length` is 1
     - `while (pendingQueue.length)` → 1 → **loops again**
     - `shift()` → `send(prompt)` → re-queue → loop → **INFINITE LOOP**

**Why it severs reconnect:** The browser tab hangs (infinite synchronous loop on the JS event loop). The user must kill the tab. The pending prompt and the reconnect are both lost. The live PI session on the server is still running but the client cannot reattach — the tab is frozen.

**Evidence (file:line CURRENT code):**
- `useWebSocketPool.ts:139`: `while (pendingQueue.length) send(pendingQueue.shift()!);` — no guard on `ws.readyState` before the loop.
- `useWebSocketPool.ts:453-462`: `send()` re-queues `prompt`/`steer`/`follow_up` when WS is not OPEN — `pendingQueue.push(msg)` at line 461.
- `useWebSocketPool.ts:136`: `setTimeout(() => { ... }, 200)` — the callback is not cancelled if the WS drops before it fires.
- `useWebSocketPool.ts:155`: `ws.onclose` — doesn't cancel the pending `setTimeout(200)` from `onopen`.

**Confidence:** HIGH. The code path is directly traceable. The only question is real-world frequency: the WS must drop within 200ms of `onopen`, AND there must be a queued message. On flaky networks (mobile, VPN) or during server deploys, rapid connect-disconnect cycles are plausible.

**Handled?** NO.

**Fix direction:** Guard the flush loop with a readyState check:
```ts
if (ws?.readyState === WebSocket.OPEN) {
    while (pendingQueue.length) send(pendingQueue.shift()!);
}
```
Or cancel the `setTimeout(200)` in `onclose` by tracking its id.

---

### [CRITICAL] E2 — Regression-guard test for "refresh loses the live PI session" is BROKEN (stale regex)

**Location:** `packages/client/src/__tests__/App.sessionSwitch.test.tsx:70` (regex), `App.sessionSwitch.test.tsx:71` (assertion).

**Trigger (exact sequence):**
1. Run the test suite: `bun run vitest run packages/client/src/__tests__/App.sessionSwitch.test.tsx`.
2. The test "persistence effect does NOT clear sessionStorage before restore has run" FAILS:
   ```
   AssertionError: LIVE_SESSION persistence effect not found: expected null to be truthy
   ```

**Why it severs reconnect:** The regex at line 70 expects:
- `sessionStorage` in the effect body — but the code now uses `localStorage` via `writeLiveSession`/`clearLiveSession` helper functions (`App.tsx:347-352`). The only `sessionStorage` references in App.tsx are in COMMENTS (`App.tsx:84`, `App.tsx:86`, `App.tsx:414`).
- Dependency array `[view, selectedProject, activeSession]` — but the code now has `[view, selectedProject, activeSession, newSessionId]` (`App.tsx:555`).

Since the regex doesn't match, `match` is null, and the assertion at line 71 fails. The test that guards the critical "refresh loses the live PI session" bug (the `restoreAttemptedRef` gate) is non-functional. A developer could accidentally remove the `restoreAttemptedRef.current` gate and the test wouldn't catch it.

**Evidence (file:line CURRENT code):**
- `App.sessionSwitch.test.tsx:70`: `const match = appSrc.match(/\/\/\s*#LIVE:[\s\S]*?useEffect\(\(\)\s*=>\s*\{[\s\S]*?sessionStorage[\s\S]*?\},\s*\[view,\s*selectedProject,\s*activeSession\]\);/);`
- `App.tsx:347-352`: `writeLiveSession`/`clearLiveSession` use `localStorage`, not `sessionStorage`.
- `App.tsx:555`: `}, [view, selectedProject, activeSession, newSessionId]);` — has `newSessionId`, not just `[view, selectedProject, activeSession]`.
- Test output (verified): `AssertionError: LIVE_SESSION persistence effect not found: expected null to be truthy` — 1 failed, 2 passed.

**Confidence:** HIGH. Verified by running the test — it fails.

**Handled?** NO. The test is broken and needs updating to match the current `localStorage`-based code.

**Fix direction:** Update the regex to match `localStorage` (or `writeLiveSession`/`clearLiveSession`) and the updated dependency array `[view, selectedProject, activeSession, newSessionId]`.

---

### [CRITICAL] E3 — `abort` / `abort_retry` / `extension_ui_response` silently dropped during reconnect (F2 partial fix)

**Location:** `packages/client/src/hooks/useWebSocketPool.ts:459-461` (queue condition), `useWebSocketPool.ts:531` (`abortRetry`), `useWebSocketPool.ts:580` (`respondToUI` / `extension_ui_response`).

**Trigger (exact sequence):**
1. WS drops mid-run. PI is executing a long-running tool (e.g., a runaway build script).
2. `onclose` fires → reconnect armed with backoff (1s+).
3. User hits "Stop" button → calls `abortRetry()` or sends `abort` → `send({ type: "abort_retry" })` or `send({ type: "abort" })`.
4. `send()` (`useWebSocketPool.ts:453`): `ws?.readyState === WebSocket.OPEN` is false → checks `msg.type === "prompt" || msg.type === "steer" || msg.type === "follow_up"` — `abort`/`abort_retry` are NOT in this list → message silently dropped.
5. User cannot stop the runaway agent until the WS reconnects (1-30s+). PI keeps running.

Similarly for `extension_ui_response`:
1. PI sends a blocking dialog (`extension_ui_request` with method `select`/`confirm`/`input`).
2. User sees the dialog and types an answer.
3. WS drops before the user's response is sent → `onclose` fires.
4. The server's `pendingDialog` replay will re-show the dialog on reconnect (`pi-agent.ts:192`), but the user's already-typed answer was silently dropped. The user must re-type the answer.

**Why it severs reconnect:** `abort` and `abort_retry` don't sever the reattach itself, but they prevent the user from controlling a live agent during a reconnect window — the agent keeps running uncontrollably. For `extension_ui_response`, the dialog is re-shown (server replay), so it's not a permanent loss — just a re-type inconvenience.

**Evidence (file:line CURRENT code):**
- `useWebSocketPool.ts:459`: `} else if (msg.type === "prompt" || msg.type === "steer" || msg.type === "follow_up") {` — only these three types are queued.
- `useWebSocketPool.ts:531`: `abortRetry: () => { send({ type: "abort_retry" }); }` — goes through `send()` → not queued.
- `useWebSocketPool.ts:580`: `send({ type: "extension_ui_response", id, ...response });` — goes through `send()` → not queued.
- Server replay: `pi-agent.ts:192`: `if (this.pendingDialog) { try { if (ws.readyState === 1) ws.send(JSON.stringify(this.pendingDialog)); } catch {} }` — dialog is replayed on attach.

**Confidence:** HIGH. Direct code trace.

**Handled?** PARTIAL. `prompt`/`steer`/`follow_up` are queued (F2 fix). `abort`/`abort_retry`/`extension_ui_response` are not.

**Fix direction:** Add `"abort"` and `"abort_retry"` to the queue condition. For `extension_ui_response`, queue it too — the server silently drops unknown dialog ids (`resolveDialogResponse` drops unknown ids), so a duplicate response to an already-answered dialog is harmless.

---

### [HIGH] E4 — `messageSignature` collision hides distinct user messages with same text (F6, still unfixed)

**Location:** `packages/client/src/lib/ws-pool-logic.ts:31` (`messageSignature`), `ws-pool-logic.ts:39-40` (`mergeMessagesOnReconnect`).

**Trigger (exact sequence):**
1. User sends "yes" (prompt A). PI persists it, responds.
2. WS drops. User sends "yes" again (prompt B) while WS is down → prompt B is queued in `pendingQueue` AND optimistically appended to `messagesRef`.
3. WS reconnects → `get_messages` sent → queue flushed → prompt B sent to PI.
4. `messages_result` arrives with the full history (including prompt A but NOT yet prompt B — PI hasn't persisted it from the flush).
5. `mergeMessagesOnReconnect` (`ws-pool-logic.ts:39`): `seen = new Set(restored.map(messageSignature))` includes `user:yes:`. Local prompt B has signature `user:yes:` → matches → **filtered out as "duplicate"**.
6. Prompt B was sent to PI via the queue flush, so PI will run it. But the local copy vanishes from the UI — the user doesn't see their "yes" in the chat until PI echoes it back via `message_end`.

If prompt B was NOT sent (e.g., before the F2 fix), it vanishes completely — the user thinks they sent it, PI never got it, and the dedup hides the local copy.

**Why it severs reconnect:** The user's message vanishes from the UI (hidden by dedup) even though PI received and processed it. The user may re-type it, causing a duplicate run. With the F2 fix, PI already received the flushed prompt — so re-typing causes a genuine duplicate run.

**Evidence (file:line CURRENT code):**
- `ws-pool-logic.ts:31`: `return \`${msg.role}:${text}:${msg.toolCallId ?? ""}\`;` — no timestamp, no clientId.
- `ws-pool-logic.ts:24-26`: comment "Known ceiling: two genuinely-distinct user messages with identical text collide (e.g. 'yes' twice)" — acknowledges but dismisses as "rare and the second is a deliberate repeat." With the F2 queue flush, the second "yes" may have been queued during a reconnect, not a deliberate repeat.
- `ws-pool-logic.ts:39`: `const localOnly = local.filter((m) => m.role === "user" && !seen.has(messageSignature(m)));` — filters by signature.

**Confidence:** HIGH. Direct code trace; test `ws-pool-logic.test.ts:39-46` explicitly tests this collision and confirms the dedup behavior.

**Handled?** NO. Same as prior review F6.

**Fix direction:** Add a client-assigned `clientId` (e.g., `crypto.randomUUID()`) to `ChatMessage`, include it in `messageSignature` when present. Assign it in `sendPrompt` before the optimistic append.

---

### [HIGH] E5 — `localStorage` shared across tabs: two tabs clobber each other's reattach token

**Location:** `packages/client/src/App.tsx:347-352` (`readLiveSession`/`writeLiveSession`/`clearLiveSession` use `localStorage`), `App.tsx:545-555` (persistence effect).

**Trigger (exact sequence):**
1. Tab A opens session X in project P1 → writes `{projectId: "P1", sessionPath: "/X.json"}` to `localStorage["pi-web:live-session"]`.
2. Tab B (same origin) opens session Y in the same project P1 → writes `{projectId: "P1", sessionPath: "/Y.json"}` to the SAME `localStorage` key — clobbers Tab A's entry.
3. Tab A reloads → `restoreLiveSession` reads `localStorage` → gets `{sessionPath: "/Y.json"}` (Tab B's session) → reattaches to session Y instead of session X.
4. Session X is still alive in the server pool but Tab A has no handle to it. Tab A is now viewing the wrong session.

Alternatively with a pending new session:
1. Tab A starts a new session → writes `{projectId: "P1", newSessionId: "uuid-A"}`.
2. Tab B starts a new session → writes `{projectId: "P1", newSessionId: "uuid-B"}` — clobbers.
3. Tab A reloads → restores `newSessionId: "uuid-B"` → reattaches to Tab B's booting agent, not its own.

**Why it severs reconnect:** The reattach token is shared across all tabs on the same origin. The last tab to change its active session wins. Other tabs that reload will reattach to the wrong session — the one that was last written, not the one they were viewing.

**Evidence (file:line CURRENT code):**
- `App.tsx:347-352`: `readLiveSession`/`writeLiveSession` use `localStorage.getItem`/`setItem`/`removeItem` — shared across tabs.
- `App.tsx:548`: `writeLiveSession({ projectId: selectedProject.id, sessionPath: activeSession.filePath });` — called on every `activeSession` change, overwriting any other tab's value.
- `App.tsx:551`: `writeLiveSession({ projectId: selectedProject.id, newSessionId });` — same for pending new sessions.
- No `storage` event listener anywhere in the client to detect cross-tab writes.

**Confidence:** HIGH. `localStorage` is spec'd to be shared across same-origin tabs. No tab-scoping is applied.

**Handled?** NO. This is a NEW issue introduced by the F3 fix (moving from `sessionStorage` to `localStorage`).

**Fix direction:** Use a tab-scoped key (e.g., `pi-web:live-session:${sessionId}` where `sessionId` is a per-tab UUID stored in `sessionStorage`), OR use the `BroadcastChannel` API to coordinate tabs, OR prefix the key with a tab id. The simplest: store a per-tab UUID in `sessionStorage`, use it to namespace the `localStorage` key. On restore, read the tab UUID from `sessionStorage`, then read the namespaced `localStorage` key. This survives tab-close+reopen (bfcache) and browser restart (session restore) while keeping tabs isolated.

---

### [HIGH] E6 — `rekey()` uses `split("::")` which corrupts paths containing `::` (F9, still unfixed)

**Location:** `packages/client/src/hooks/useWebSocketPool.ts:548`.

**Trigger (exact sequence):**
1. A sessionPath contains `::` (e.g., a POSIX path with a directory named `::` or an unusual filesystem path).
2. `rekey(newKey)` at `useWebSocketPool.ts:548`: `const parts = newKey.split("::")` — splits on ALL `::` occurrences, not just the first two.
3. `currentSessionPath = parts[1]` is a TRUNCATED path. `currentNewSessionId = parts[2]` is WRONG.
4. On reconnect, `connect()` uses `currentSessionPath` in the WS URL — the server's `getOrCreateAgent` doesn't find a match with the truncated path → spawns a DUPLICATE agent.

**Why it severs reconnect:** The truncated `sessionPath` causes a duplicate agent spawn. The original agent is orphaned in the server pool (held by the idle timer).

**Evidence (file:line CURRENT code):**
- `useWebSocketPool.ts:548`: `const parts = newKey.split("::"); currentSessionPath = parts[1] || null; currentNewSessionId = parts[2] || null;`
- `useWebSocketPool.ts:545`: comment "sessionPath is a ~/.pi file path (no `::`), so split is safe." — assumption, not guarantee.

**Confidence:** MEDIUM. Session paths are `~/.pi/agent/sessions/<uuid>.json` which are unlikely to contain `::`. But the assumption is not enforced and a non-standard config could violate it.

**Handled?** NO. Same as prior review F9.

**Fix direction:** Use `indexOf("::")` and `lastIndexOf("::")` to split into exactly three parts.

---

### [HIGH] E7 — bfcache (back/forward cache) restore: zombie WS with no reconnect for short freezes

**Location:** `packages/client/src/hooks/useWebSocketPool.ts:181-189` (`onVisible` handler with 60s threshold).

**Trigger (exact sequence):**
1. User navigates away from the PI web app (clicks a link, types a URL) while a session is live.
2. Browser saves the page to bfcache — JS context frozen, WS frozen.
3. Server detects the WS as closed (TCP timeout or server-side poll) → detaches the client → idle timer starts. If <1h, the agent survives.
4. User navigates back (browser back button) → bfcache restores the page.
5. `visibilitychange` fires → `onVisible` checks `Date.now() - lastMessageAt > 60_000`.
6. If the freeze was <60s: the threshold is NOT met → WS is NOT force-closed. But the WS is a zombie — `readyState` may still show OPEN, but the TCP connection is dead (or the server closed it). `send()` will try to send on the dead WS → data goes into a dead buffer → silent failure.
7. If the freeze was >60s: the threshold IS met → WS force-closed → `onclose` → reconnect. **This works correctly.**

The gap is the 0-60s freeze window where the zombie WS is not detected.

**Why it severs reconnect:** The user returns to their session within 60s and the UI looks alive (WS shows OPEN), but every send is silently dropped. The user types a prompt and nothing happens. They have no indication that the connection is dead.

**Evidence (file:line CURRENT code):**
- `useWebSocketPool.ts:185`: `if (document.visibilityState === "visible" && ws && ws.readyState === WebSocket.OPEN && Date.now() - lastMessageAt > 60_000)` — 60s threshold.
- `useWebSocketPool.ts:186`: `try { ws.close(); } catch {}` — only force-closes if >60s.
- No `pageshow` event listener (the standard bfcache restore event) — `onVisible` uses `visibilitychange` which fires for both tab-switching and bfcache restore, but the 60s threshold is too coarse for short bfcache freezes.

**Confidence:** MEDIUM. bfcache behavior varies by browser. Some browsers fire `onclose` during the freeze (server-side close), which would trigger reconnect. Mobile Safari (the primary PWA target) is known to NOT fire `onclose` during bfcache freeze. The 60s threshold is a reasonable heuristic but has a gap.

**Handled?** PARTIAL. The `onVisible` handler catches freezes >60s. Freezes <60s are not caught.

**Fix direction:** Listen for `pageshow` event (with `event.persisted` check for bfcache). On bfcache restore, always force-close the WS (or send a no-op ping and check if a response arrives within a short timeout). Alternatively, lower the threshold for `visibilitychange` to ~5s — bfcache freezes of any duration warrant a freshness check.

---

### [MEDIUM] E8 — `onOnline` can race with `reconnectTimer` callback, creating a transient duplicate WS

**Location:** `packages/client/src/hooks/useWebSocketPool.ts:193-198` (`onOnline`), `useWebSocketPool.ts:164-169` (`onclose` reconnect scheduling).

**Trigger (exact sequence):**
1. WS drops → `onclose` → `reconnectTimer = setTimeout(() => { reconnectAttempts++; connect(); }, delay)` scheduled for T+delay.
2. `reconnectTimer` callback fires at T+delay → `connect()` creates WS_A, sets `ws = WS_A`.
3. Almost simultaneously, `online` event fires → `onOnline()`:
   - `if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }` — `clearTimeout` is a no-op (callback already fired).
   - `reconnectAttempts = 0; connect();` — creates WS_B, sets `ws = WS_B`.
4. WS_A is orphaned — its `onopen`/`onclose` handlers are still attached but `ws` now points to WS_B.
5. WS_A's `onopen` fires → sends `get_state`/`get_messages` on WS_A → server creates a second client entry.
6. Both WS_A and WS_B are connected to the same agent → messages broadcast to both → double-processing on the client.

**Why it severs reconnect:** Not a session-loss bug (server dedupes by agent key). Transient duplicate WS with double message delivery and double server load. Eventually WS_A's `onclose` fires (when it's superseded or the server prunes it) → schedules another reconnect → self-heals.

**Evidence (file:line CURRENT code):**
- `useWebSocketPool.ts:194`: `if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }` — doesn't handle already-fired timers.
- `useWebSocketPool.ts:197`: `connect();` — unconditional, doesn't check if `ws` is already OPEN/CONNECTING.

**Confidence:** MEDIUM. The race requires `online` event to fire almost simultaneously with the reconnect timer callback — low probability but possible during network recovery.

**Handled?** PARTIAL. The `onclose` handler's `clearTimeout(reconnectTimer)` (F5 fix) prevents double-scheduling of NEW timers, but doesn't prevent the initial double-connect from an already-fired timer + `online` event.

**Fix direction:** Track the current `ws` instance identity. In `onOnline`, check `if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;` before calling `connect()`. Or set `reconnectTimer = null` after the callback fires (inside the `setTimeout` callback).

---

### [MEDIUM] E9 — Race between `restoreLiveSession` async fetch and user navigation

**Location:** `packages/client/src/App.tsx:441-528` (`restoreLiveSession`), `App.tsx:530-532` (effect that calls it).

**Trigger (exact sequence):**
1. Page reloads → projects load → `restoreLiveSession` runs.
2. Path 2 (server fallback): `const r = await fetch(\`/api/projects/${selectedProject.id}/live-sessions\`)` (`App.tsx:473`).
3. During the fetch (network latency), the user clicks a different session or project.
4. Fetch completes → `restoreLiveSession` continues: `setActiveSession(...)`, `setView("chat")` (`App.tsx:519-525`).
5. These state updates clobber the user's navigation — the user is now on the restored session, not the one they clicked.

Additionally, `restoreAttemptedRef.current = true` is set AFTER the async fetch (`App.tsx:510`), not before. If the user switches projects during the fetch, the new project's `restoreLiveSession` will see `restoreAttemptedRef.current === false` and start its own restore. When the old fetch completes, it sets `restoreAttemptedRef.current = true` — but with the OLD project's session data. The new project's restore is now blocked (ref is true), and the user is stuck on the wrong project's session.

**Why it severs reconnect:** The user ends up on the wrong session or project after a reload if they navigate during the restore window. Not a permanent loss (they can navigate back), but confusing.

**Evidence (file:line CURRENT code):**
- `App.tsx:473`: `const r = await fetch(...)` — async, no abort signal.
- `App.tsx:510`: `restoreAttemptedRef.current = true;` — set AFTER the await, not before.
- `App.tsx:519-525`: `setActiveSession(...); setView("chat");` — unconditional state updates after async fetch.
- No `AbortController` for the `/live-sessions` fetch.

**Confidence:** MEDIUM. The race window is the fetch latency (typically 50-500ms). Users who navigate quickly after a reload could hit this.

**Handled?** NO.

**Fix direction:** Set `restoreAttemptedRef.current = true` at the START of `restoreLiveSession` (before any async work). Use an `AbortController` for the fetch and abort it if `selectedProject` changes. Check if `selectedProject` is still the same after the await before applying state updates.

---

### [MEDIUM] E10 — `autoRetry` state not cleared on reconnect (F12, still unfixed)

**Location:** `packages/client/src/hooks/useWebSocketPool.ts:132-148` (`onopen` does not reset `autoRetry`).

**Trigger (exact sequence):**
1. PI enters an auto-retry loop → `auto_retry_start` event sets `data.autoRetry`.
2. WS drops → `onclose` fires → reconnect.
3. PI exits its retry loop during the disconnect (e.g., it gave up or succeeded).
4. WS reconnects → `onopen` resets `isConnected`, `lastError`, `liveMessages` — but NOT `autoRetry`.
5. `get_state` response may or may not include retry state. If it doesn't, the client shows a stale "retrying" indicator until the next `auto_retry_end` (which won't come if the retry is over).

**Why it falsely claims a live session:** The UI shows "auto-retrying" when PI has already stopped retrying. The user thinks the agent is still working when it's idle.

**Evidence (file:line CURRENT code):**
- `useWebSocketPool.ts:132-148`: `onopen` resets `data.isConnected`, `data.lastError`, `data.liveMessages` — but NOT `data.autoRetry`, `data.compactionResult`, etc.
- `useWebSocketPool.ts:71`: `autoRetry: null as { ... } | null` — initialized to null, set by `auto_retry_start`, cleared by `auto_retry_end`.

**Confidence:** HIGH. Direct code trace.

**Handled?** NO. Same as prior review F12.

**Fix direction:** In `onopen`, reset transient UI state: `data.autoRetry = null; data.compactionResult = null;`. The server will re-broadcast current state via `get_state`.

---

### [MEDIUM] E11 — `notifyTimer` not cleared before setting new notification (F11, still unfixed)

**Location:** `packages/client/src/hooks/useWebSocketPool.ts:358-365` (notify auto-dismiss), `useWebSocketPool.ts:365` (timer stored on `data`).

**Trigger (exact sequence):**
1. A `notify` event arrives → `data.pendingNotification` set, `autoTimer` scheduled for 4s (`useWebSocketPool.ts:358-365`).
2. A SECOND `notify` event arrives before the first timer fires → `data.pendingNotification` overwritten, a NEW `autoTimer` scheduled. The OLD timer is NOT `clearTimeout`-ed — it's orphaned.
3. The old timer fires after 4s → checks `data.pendingNotificationId === ui.id` (old id). If the second notification has a different id, the check fails → no-op. If the second notification has the SAME id (unlikely), it prematurely clears the second notification.
4. The second notification's timer fires normally.

**Why it falsely claims a live session:** Minor UI glitch — a notification may be auto-dismissed prematurely or a stale `extension_ui_response` with `cancelled: true` sent for an old notification id (server drops unknown ids silently, so harmless).

**Evidence (file:line CURRENT code):**
- `useWebSocketPool.ts:365`: `(data as { notifyTimer?: ReturnType<typeof setTimeout> }).notifyTimer = autoTimer;` — overwrites without clearing previous.
- `useWebSocketPool.ts:358-363`: timer closure captures `ui.id`, checks `data.pendingNotificationId === ui.id`.

**Confidence:** HIGH. Direct code trace.

**Handled?** NO. Same as prior review F11.

**Fix direction:** `if ((data as any).notifyTimer) clearTimeout((data as any).notifyTimer);` before assigning the new timer.

---

### [MEDIUM] E12 — Pool cleanup on unmount closes ALL connections including background streaming sessions (F10, unchanged)

**Location:** `packages/client/src/hooks/useWebSocketPool.ts:660-664` (unmount effect).

**Trigger (exact sequence):**
1. User has session A streaming in the background (navigated to session B). Pool holds both.
2. React 19 strict mode (dev) unmounts and remounts the `App` → unmount effect closes ALL pool entries (`useWebSocketPool.ts:662`).
3. `close()` sets `intentionallyClosed = true` → WS closed → server detaches → idle timer starts for session A.
4. On remount, a new pool is created. Session B's `getOrConnect` creates a fresh WS → reattaches to the still-live agent B. But session A's WS is gone — `getOrConnect` for A isn't called because `activeSession` is B.
5. Session A's agent is still in the server pool (within the 1h idle window). If the user navigates back to A, `getOrConnect` reattaches. **Recoverable.**

In production (no strict mode), this only fires on true unmount (error boundary, full route change — which doesn't happen in this SPA).

**Why it severs reconnect:** In dev (strict mode), background sessions are briefly disconnected on every mount cycle. The server's reattach logic makes this self-healing. In production, this only fires on error boundaries — rare.

**Evidence (file:line CURRENT code):**
- `useWebSocketPool.ts:660-664`: `useEffect(() => { return () => { for (const conn of poolRef.current.values()) conn.close(); }; }, []);`
- `App.tsx:84-86`: comment "PI processes for background sessions are not torn down when the user switches project/session" — contradicts the unmount effect, but in practice the unmount effect is dev-only.

**Confidence:** HIGH. Direct code trace. Impact is dev-only in practice.

**Handled?** PARTIAL. Self-healing via server reattach. The strict-mode flit is annoying but not a session-loss bug.

**Fix direction:** Low priority. Gate the unmount cleanup to skip in dev (React strict mode), or use a `useRef` to track if this is a real unmount vs. a strict-mode double-mount.

---

### [LOW] E13 — `pendingQueue` not cleared on `close()`; stale messages if connection somehow reused

**Location:** `packages/client/src/hooks/useWebSocketPool.ts:631-637` (`close()`), `useWebSocketPool.ts:114` (`pendingQueue` declaration).

**Trigger:** `close()` sets `intentionallyClosed = true` and closes the WS. The `pendingQueue` is not cleared. Since `close()` prevents reconnect, the queue is never flushed. If the same connection object is reused (which shouldn't happen — `getOrConnect` creates new connections), stale messages would be flushed.

**Why it severs reconnect:** Not a real issue — `close()` is terminal, the connection is never reused. The queue is garbage-collected with the closure.

**Evidence:**
- `useWebSocketPool.ts:631-637`: `close()` doesn't clear `pendingQueue`.
- `useWebSocketPool.ts:634`: `ws?.close(); ws = null;` — prevents any future send.

**Confidence:** HIGH (not a real issue).

**Handled?** YES — by design. `close()` is terminal.

---

### [LOW] E14 — `BackgroundSessionToast` uses `key.split(":")[0]` instead of `key.split("::")[0]` for projectId extraction

**Location:** `packages/client/src/components/BackgroundSessionToast.tsx:21`, `packages/client/src/App.tsx:103`.

**Trigger:** The pool key format is `${projectId}::${sessionPath}::${newSessionId}`. Both `BackgroundSessionToast.tsx:21` and `App.tsx:103` use `key.split(":")[0]` (single colon) instead of `key.split("::")[0]` (double colon). Since project IDs are UUIDs (no colons), `split(":")[0]` correctly extracts the projectId. But if the key format ever changes, or if a project ID contains a colon, this would break silently.

**Why it severs reconnect:** Not a severance — just a fragile parse that could break on format changes. The projectId is used for toast routing and streaming-session highlighting.

**Evidence:**
- `BackgroundSessionToast.tsx:21`: `const projectId = key.split(":")[0];`
- `App.tsx:103`: `const projectId = key.split(":")[0];`

**Confidence:** HIGH (not a real issue with UUIDs, but fragile).

**Handled?** YES — by UUID constraint. Not a real bug.

---

## EXHAUSTIVE CHECKLIST — Re-Verified Against CURRENT Code

### After a full page RELOAD (F5 / cmd+R)

| State piece | Survives reload? | Reattach? | Status |
|---|---|---|---|
| `localStorage[LIVE_SESSION_KEY]` (resolved session) | ✅ Yes (localStorage) | ✅ `restoreLiveSession` Path 1 reads it, `getOrConnect(projectId, sessionPath, null)` reattaches. | ✅ **FIXED** (was F3) |
| `localStorage[LIVE_SESSION_KEY]` (pending new session, `newSessionId`) | ✅ Yes | ✅ `restoreLiveSession` reads `saved.newSessionId`, calls `setNewSessionId`, `getOrConnect(projectId, null, newSessionId)` reattaches. Server reverse-lookup finds the `__new__:<uuid>` agent. | ✅ **FIXED** (was F1) |
| `messagesRef` (local message history) | ❌ No (in-memory) | ⚠️ Recovered from server via `get_messages` → `messages_result` → `mergeMessagesOnReconnect`. Queued prompts/steers are flushed on reconnect. `abort`/`extension_ui_response` are still dropped. | ⚠️ **E3** (partial F2 fix) |
| `pendingSteering` / `pendingFollowUp` | ❌ No (in-memory) | ✅ Messages sent during reconnect are queued and flushed on `onopen`. UI arrays are updated optimistically. | ✅ **FIXED** (was F2) |
| `reconnectAttempts` / `reconnectTimer` | ❌ No (in-memory) | ✅ Fresh `createConnection` starts at 0. No stale timer. | ✅ Safe |
| React component state | ❌ No | ✅ `selectedProject` restored from `saved.projectId` in localStorage. `activeSession` reconstructed from `sessionPath`. | ✅ **FIXED** (was F3/F8) |

### After a tab CLOSE + REOPEN (cmd+W, then ctrl+shift+T)

| State piece | Survives? | Reattach? | Status |
|---|---|---|---|
| `localStorage[LIVE_SESSION_KEY]` | ✅ Yes (localStorage survives tab close) | ✅ `restoreLiveSession` Path 1 reads it. | ✅ **FIXED** (was F3) |
| Everything else (in-memory) | ❌ No | Same as reload — fresh mount. | ✅ Safe (with above) |

### After a browser RESTART / CRASH / mobile cold start

| State piece | Survives? | Reattach? | Status |
|---|---|---|---|
| `localStorage` | ✅ Yes (persists across browser restarts) | ✅ `restoreLiveSession` Path 1 reads it. Server agent must survive 1h idle window. | ✅ **FIXED** (was F3) |

### After a NETWORK BLIP (WiFi off → on)

| State piece | Survives? | Reattach? | Status |
|---|---|---|---|
| All in-memory state | ✅ Yes | ✅ `offline` event closes WS → `onclose` → reconnect. `online` event resets backoff and reconnects immediately. | ✅ **FIXED** (was F7) |
| WS connection | ❌ Closed by `onOffline` | ✅ `onclose` → reconnect backoff. On `online`, immediate reconnect. | ✅ **FIXED** (was F7) |
| Pending messages | ✅ Queued | ✅ Flushed on `onopen` (with E1 caveat). | ⚠️ **E1** (infinite loop risk) |

### After a WS DROP (server restart, deploy, agent exit)

| State piece | Survives? | Reattach? | Status |
|---|---|---|---|
| All in-memory state | ✅ Yes | ✅ `onclose` fires → reconnect backoff. `get_state`/`get_messages` restore. Server `getOrCreateAgent` reattaches (or spawns fresh if agent was reaped). | ✅ Safe |
| `reconnectAttempts` | ✅ In-memory | ✅ Reset on `onopen` (line 134). Backoff caps at 30s forever. | ✅ Safe |
| `onerror` without `onclose` | — | ✅ `onerror` now schedules reconnect (guarded by `!reconnectTimer`). | ✅ **FIXED** (was F4) |
| Double `onclose` / late close event | — | ✅ `onclose` clears existing `reconnectTimer` before scheduling. | ✅ **FIXED** (was F5) |

### After a CACHE CLEAR (devtools → clear site data)

| State piece | Survives? | Reattach? | Status |
|---|---|---|---|
| `localStorage` | ❌ No | ⚠️ Path 2 (`/live-sessions`) is the fallback. Works if the right project is selected. Client prefers saved `sessionPath` if available (but localStorage is wiped, so no saved path). Falls back to `live[0]` (most-recently-active). | ⚠️ Partial (by design) |

### Hard reload (Ctrl-Shift-R) vs soft reload

| Concern | Status | Notes |
|---|---|---|
| Hard reload bypasses HTTP cache | ✅ Safe | `localStorage` is not affected by cache bypass. `restoreLiveSession` Path 1 reads it. |
| Soft reload (F5) | ✅ Safe | Same as hard reload for `localStorage`. |

### MULTIPLE TABS on the SAME live session

| Concern | Status | Notes |
|---|---|---|
| Server broadcast to both tabs | ✅ Safe | `PooledAgent.broadcast` iterates all clients in `clients` set. Both tabs receive messages. |
| Closing one tab kills the agent for the other? | ✅ Safe | `detach` only removes one WS from `clients`; agent stays alive while other tab's WS is attached. |
| Both tabs send prompts | ⚠️ By design | Both prompts reach PI. PI queues them. No duplicate-session risk. |
| `localStorage` clobbering | ❌ **E5** | Last tab to change session wins. Other tab's reload reattaches to the wrong session. |

### `send()` while WS is not OPEN (CONNECTING/CLOSING/CLOSED)

| Message type | Behavior | Status |
|---|---|---|
| `prompt` | ✅ Queued, flushed on reconnect. | ✅ **FIXED** (was F2) |
| `steer` / `follow_up` | ✅ Queued, flushed on reconnect. | ✅ **FIXED** (was F2) |
| `abort` | ❌ Silently dropped. Cannot stop runaway agent during reconnect. | ❌ **E3** |
| `abort_retry` | ❌ Silently dropped. Cannot stop auto-retry during reconnect. | ❌ **E3** |
| `extension_ui_response` | ❌ Silently dropped. Server replays dialog on reconnect, user re-answers. | ❌ **E3** |
| `get_state` / `get_messages` (control) | ✅ Re-sent on `onopen` (lines 137-142). | ✅ Safe |
| `new_session` / `load_session` / `switch_session` | ❌ Silently dropped. But these are user-initiated transitions; unlikely during reconnect. | ⚠️ Low risk |

### visibilitychange / backgrounded tab

| Concern | Status | Notes |
|---|---|---|
| WS keepalive timers throttled on mobile | ⚠️ Partial | JS timers are throttled/frozen in backgrounded tabs. `onVisible` checks for >60s gap on foreground. Catches long freezes. |
| Short freeze (<60s) zombie WS | ❌ **E7** | Not detected. WS shows OPEN but may be dead. |
| `onOffline` / `onOnline` | ✅ **FIXED** | Wired directly into each connection (was F7). |

---

## What IS Robust (verified safe in CURRENT code)

1. **Server-side `getOrCreateAgent` reverse-lookup** (`pi-agent.ts:648-658`): reattaches by `originalNewSessionId` after rekey. Well-tested.
2. **`sessionPath` normalization** (`pi-agent.ts:615-618`): trailing slashes, `//`, `./`, `..` normalized. Well-tested.
3. **`reconnectDelay` backoff** (`ws-pool-logic.ts:11-19`): never gives up, caps at 30s forever. Well-tested.
4. **`mergeMessagesOnReconnect` trust model** (`ws-pool-logic.ts:39-40`): never trusts local assistant/toolResult. Only local user messages preserved. Well-tested.
5. **`rekey()` pool entry move** (`useWebSocketPool.ts:544-556`): correctly moves pool entry, updates reconnect params. Well-tested. (`::` split assumption is E6.)
6. **`close()` cleanup** (`useWebSocketPool.ts:631-637`): clears `reconnectTimer` and `notifyTimer`, sets `intentionallyClosed`, removes lifecycle listeners, closes WS.
7. **Server's `closeClients()` on agent exit** (`pi-agent.ts:147-154`): closes all client WSes → client `onclose` → reconnect.
8. **Server's `pendingDialog` replay** (`pi-agent.ts:192`): blocking dialog replayed on attach. Combined with client's `extension_ui_request` handler, recovers refresh-mid-dialog.
9. **`restoreAttemptedRef` gate** (`App.tsx:349`, `App.tsx:510`): prevents double-restore. BUT the static test guarding this is BROKEN (E2).
10. **Pool keying per (project, session)** (`useWebSocketPool.ts:602`): `getOrConnect` keys by `${projectId}::${sessionPath}::${newSessionId}`. Well-tested.
11. **`newSessionId` persistence** (`App.tsx:548-551`): persisted in `localStorage` via `writeLiveSession`, restored in `restoreLiveSession` (`App.tsx:487-497`). **FIXED** (was F1).
12. **`localStorage` for `LIVE_SESSION_KEY`** (`App.tsx:347-352`): survives tab close + browser restart. **FIXED** (was F3). But introduces E5 (multi-tab clobbering).
13. **`onerror` reconnect scheduling** (`useWebSocketPool.ts:163-170`): schedules reconnect with backoff guard. **FIXED** (was F4).
14. **`onclose` timer clearing** (`useWebSocketPool.ts:157`): clears existing `reconnectTimer` before scheduling. **FIXED** (was F5).
15. **`online`/`offline` event wiring** (`useWebSocketPool.ts:188-198`): `onOffline` closes WS, `onOnline` resets backoff and reconnects. **FIXED** (was F7).
16. **`/live-sessions` session preference** (`App.tsx:478`): prefers saved `sessionPath` when available. **FIXED** (was F8).
17. **`pendingQueue` for prompt/steer/follow_up** (`useWebSocketPool.ts:459-461`): queued and flushed on reconnect. **FIXED** (was F2, partial). But E1 (infinite loop) and E3 (abort not queued) remain.

---

## Summary of Required Fixes (by priority)

| Priority | Finding | Fix size | Risk if unfixed |
|---|---|---|---|
| CRITICAL | E1: Guard `pendingQueue` flush against non-OPEN WS (infinite loop) | ~3 lines | Browser tab hangs if WS drops during 200ms onopen window with queued messages |
| CRITICAL | E2: Update stale regression-guard test (sessionStorage → localStorage) | ~2 lines (regex) | Regression guard for "refresh loses session" bug is non-functional; test currently FAILS |
| CRITICAL | E3: Add `abort`/`abort_retry`/`extension_ui_response` to pending queue | ~1 line (condition) | User cannot stop runaway agent or answer dialog during reconnect |
| HIGH | E4: Add `clientId` to `messageSignature` (F6, unfixed) | ~5 lines | Distinct user messages with same text vanish from UI |
| HIGH | E5: Namespace `localStorage` key per-tab to prevent cross-tab clobbering | ~10 lines | Two tabs on different sessions clobber each other's reattach token |
| HIGH | E6: Use `indexOf`/`lastIndexOf` in `rekey` split (F9, unfixed) | ~5 lines | Path with `::` corrupts reconnect params → duplicate agent |
| HIGH | E7: Handle bfcache restore for short freezes | ~5 lines | Zombie WS after <60s bfcache freeze → silent send failure |
| MEDIUM | E8: Guard `onOnline` against racing with already-fired reconnect timer | ~3 lines | Transient duplicate WS on network recovery |
| MEDIUM | E9: Set `restoreAttemptedRef` before async fetch; abort fetch on project change | ~5 lines | Restore clobbers user navigation during async fetch |
| MEDIUM | E10: Reset `autoRetry`/`compactionResult` in `onopen` (F12, unfixed) | ~2 lines | Stale UI indicators after reconnect |
| MEDIUM | E11: Clear existing `notifyTimer` before setting new (F11, unfixed) | ~1 line | Minor UI glitch with rapid notifications |
| MEDIUM | E12: Gate unmount cleanup for strict mode (F10, unchanged) | ~3 lines | Dev-only: background sessions briefly disconnected on mount cycle |
| LOW | E13: Clear `pendingQueue` on `close()` (not a real issue) | ~1 line | No real impact (close is terminal) |
| LOW | E14: Use `split("::")` instead of `split(":")` in toast/App (fragile parse) | ~2 lines | No real impact with UUIDs; fragile to format changes |

---

## Coverage Gaps in Tests

1. **No test for the `pendingQueue` flush behavior** (`useWebSocketPool.test.ts`): The existing tests verify reconnect and message restoration, but NONE test the `pendingQueue`:
   - No test that a prompt sent during a reconnect window is queued and flushed on `onopen`.
   - No test for the E1 infinite loop scenario (WS drops during 200ms window).
   - No test that `abort`/`extension_ui_response` are NOT queued (to document the gap).

2. **No test for `onerror` scheduling reconnect** (`useWebSocketPool.test.ts`): The F4 fix (onerror schedules reconnect) is not tested. The FakeWebSocket class supports `onerror` but no test triggers it.

3. **No test for `onOffline`/`onOnline`** (`useWebSocketPool.test.ts`): The F7 fix (offline/online event wiring) is not tested. No test simulates `window.offline`/`window.online` events.

4. **No test for `onVisible` (visibilitychange) dead-socket detection** (`useWebSocketPool.test.ts`): The E7/bfcache handler is not tested.

5. **Broken test for `restoreAttemptedRef` gate** (`App.sessionSwitch.test.tsx:68-76`): The regression guard test is STALE — it expects `sessionStorage` and `[view, selectedProject, activeSession]` but the code now uses `localStorage` and `[view, selectedProject, activeSession, newSessionId]`. The test currently FAILS (verified by running it). **This must be fixed.**

6. **No test for `newSessionId` persistence in `localStorage`** (`App.sessionSwitch.test.tsx`): The F1 fix (persisting `newSessionId`) is not tested. No test verifies that a reload with a pending new session reattaches to the same `__new__:<uuid>` agent.

7. **No test for multi-tab `localStorage` interference** (`App.sessionSwitch.test.tsx`): The E5 issue (cross-tab clobbering) is not tested.

8. **No test for `messageSignature` collision with identical-text user messages** (`ws-pool-logic.test.ts`): The test at line 39-46 tests the dedup of an identical message, but doesn't test the scenario where two DISTINCT messages with the same text collide (the E4/F6 issue). The test actually confirms the collision behavior but doesn't flag it as a bug.

9. **No test for `rekey` with `::` in sessionPath** (`useWebSocketPool.test.ts`): The E6/F9 issue is not tested.

10. **No test for the `pendingQueue` flush ordering** (`useWebSocketPool.test.ts`): The comment at `useWebSocketPool.ts:143-146` claims the queue is flushed AFTER `get_messages` so the merge baseline is captured first. No test verifies this ordering.

11. **`SubagentsPanel` does not model WS reattach** (`SubagentsPanel.tsx`): The `SubagentsPanel` uses HTTP polling (`fetch` every 2500ms), not the WS pool. Its `onSendPrompt` callback (`SubagentsPanel.tsx:115-117`) goes through `ws.send({ type: "prompt", message: text })` — which uses the main session's WS. If the WS is down, the prompt is queued (if it matches the queue types) or dropped (if not). The panel has no indication of WS state — it shows a toast "Asked agent to resume" regardless of whether the message was sent or queued. This is consistent with the main chat behavior but could confuse users who expect the subagent panel to have its own connection.

12. **`BackgroundSessionToast` polls `wsPool.pool` on every render** (`BackgroundSessionToast.tsx:15-42`): The toast's `useEffect` has no dependency array (runs on every render), iterating the entire pool to detect active→inactive transitions. This is not a reattach issue but could miss transitions if the pool changes between renders without a re-render trigger. In practice, `forceUpdate` on the pool hook triggers re-renders, so this works.
