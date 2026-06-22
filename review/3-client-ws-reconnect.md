# Adversarial Review: Client-Side WebSocket Reconnect & Session-Persistence

**Scope:** `packages/client/src/hooks/useWebSocketPool.ts`, `lib/ws-pool-logic.ts`, `App.tsx`, supporting tests/types.
**Goal:** Find every edge case where, after reload / tab close+reopen / crash / network blip / cache clear, the client can NO LONGER reconnect to a LIVE PI session still running on the server.
**Method:** Direct file inspection; server-side `pi-agent.ts` and `index.ts` consulted to confirm the reattach contract the client must satisfy.
**Mode:** Review-only — no source files modified.

---

## Executive Summary

The reconnect core is **robust for the single most common case** (plain page refresh of a resolved session). The server-side `getOrCreateAgent` reverse-lookup (#REATTACH) is well-engineered and tolerates a LOT of client misbehavior — stale `newSessionId` after rekey, path-equivalent `sessionPath` variants, concurrent new sessions. The two pure helpers (`reconnectDelay`, `mergeMessagesOnReconnect`) are clean and well-tested.

**However**, there are **3 CRITICAL** and **4 HIGH** edge cases where a live session becomes unreachable or a duplicate is spawned. The biggest cluster: `newSessionId` for a pending (pre-rekey) new session is **in-memory only and never persisted** — so any disruption before the client processes the rekey (reload, tab close, crash) orphans the live booting PI and spawns a duplicate. A secondary cluster: `send()` silently drops every command when the WS is not `OPEN`, with no re-send queue, so a prompt sent during the ~200ms onopen bootstrap window — or during any reconnect window — is lost forever despite appearing in the UI.

The findings below are ordered by severity. Each cites real line numbers.

---

## Findings

### [CRITICAL] F1 — Pending new-session `newSessionId` is in-memory only; reload/tab-close/crash before rekey spawns a DUPLICATE session

**Location:** `packages/client/src/App.tsx:46` (`useState<string | null>(null)`), `App.tsx:611` (`setNewSessionId(id)`), `App.tsx:103-107` (passed to `getOrConnect`), `App.tsx:470-479` (restore reads only `sessionPath`, never `newSessionId`).

**Scenario:**
1. User clicks "New session" → `handleNewSession` (`App.tsx:607-617`) calls `uuidV4()`, `setNewSessionId(id)`, sets `view="chat"`. The newSessionId lives **only in React `useState`** — it is NEVER written to `sessionStorage` or `localStorage`.
2. `getOrConnect(projectId, null, newSessionId)` (`App.tsx:103-107`) opens a WS with `?newSessionId=<uuid>&projectId=<pid>`. Server's `getOrCreateAgent(cwd, null, newSessionId)` (`server/src/index.ts:2541`) creates a `__new__:<uuid>` agent and (because `newSessionId` is truthy) **also sends `{type:"new_session"}`** to it (`server/src/index.ts:2573`).
3. **Before** PI reports the sessionFile and the client's `handleSessionLoaded` rekeys the pool entry (`App.tsx:180-219`), the user hits reload / closes the tab / the browser crashes / the laptop sleeps.
4. On reload, `restoreLiveSession` (`App.tsx:419-489`) runs. Path 1 reads `sessionStorage[LIVE_SESSION_KEY]` — but that key is only written when `view==="chat" && activeSession?.filePath` is truthy (`App.tsx:511-513`), and for a pending new session `activeSession` is null and there's no `filePath` yet. So `saved.sessionPath` is null.
5. Path 2 (`/live-sessions`) calls `agent.getLiveSnapshot()` (`server/src/pi-agent.ts:441-459`). For a pending new session whose `sessionFile` is still null, `SDKAgent.getLiveSnapshot()` returns `null` (`server/src/pi-agent.ts` — `if (!file) return null`). So the live-sessions endpoint **omits this agent entirely**.
6. Client finds no session to restore, lands on the empty projects view. The booting PI agent is **orphaned in the server pool** (held by the 1-hour idle timer, `IDLE_TIMEOUT_MS`, `server/src/pi-agent.ts:25`). If the user clicks "New session" again, a **fresh `uuidV4()`** is generated (`App.tsx:609`) — a completely different id — and `getOrCreateAgent` finds no match in its `originalNewSessionId` reverse-scan (`server/src/pi-agent.ts:623-635`), so it **spawns a second agent** while the first still runs.

**Impact:** Live session unreachable AND duplicate PI spawned. The orphaned agent holds its session file and may still be running tools when the duplicate starts — potential file contention on the same `~/.pi` dir. The user sees a fresh empty chat and has no indication their previous new session is still booting server-side.

**Evidence:**
- `App.tsx:46`: `const [newSessionId, setNewSessionId] = useState<string | null>(null);` — in-memory only.
- `App.tsx:511-516`: persistence effect writes to sessionStorage ONLY when `activeSession?.filePath` is truthy — a pending new session has no filePath.
- `App.tsx:470-479`: restore reads `saved.sessionPath`; there is no `saved.newSessionId` field read anywhere.
- `server/src/index.ts:2573`: `if (newSessionId) { agent.send({ type: "new_session" }); }` — a reconnecting client with a stale newSessionId would re-trigger new_session, but the server's reverse-lookup (`pi-agent.ts:623-635`) prevents the duplicate ONLY if the client sends the SAME newSessionId — which it cannot after a reload because it's lost.
- `SDKAgent.getLiveSnapshot()` returns null before `sessionFile` resolves → `/live-sessions` omits the pending agent.

**Fix:** Persist `newSessionId` alongside `sessionPath` in `LIVE_SESSION_KEY` when a new session is started, and restore it on mount so a reload reattaches to the same `__new__:<uuid>` agent. Concretely in `App.tsx`:
- In `handleNewSession`, after `setNewSessionId(id)`: `sessionStorage.setItem(LIVE_SESSION_KEY, JSON.stringify({ projectId: selectedProject.id, newSessionId: id }))`.
- In `restoreLiveSession`, read `saved.newSessionId` and if present, `setNewSessionId(saved.newSessionId)` instead of (or in addition to) setting `sessionPath`. The server's reverse-lookup (`pi-agent.ts:623-635`) then reattaches to the existing `__new__:<uuid>` agent — **no duplicate, no orphan**.
- Clear `newSessionId` from sessionStorage once the session resolves (in `handleSessionLoaded`, where `setNewSessionId(null)` already runs at `App.tsx:217`).

A server-side complement would be to have `getLiveSessionsForCwd` include pending-new agents (keyed `__new__:<uuid>`) in its snapshot so the `/live-sessions` fallback can also recover them — but that requires the client to reattach by newSessionId, which is only possible if the id is persisted. So the client-side fix is the root fix.

---

### [CRITICAL] F2 — `send()` silently drops every command when WS is not OPEN; prompts/steers during reconnect window are LOST FOREVER

**Location:** `packages/client/src/hooks/useWebSocketPool.ts:397` (`function send`), `useWebSocketPool.ts:407-421` (`sendPrompt`).

**Scenario:**
1. WS is mid-reconnect (onclose fired, `reconnectTimer` is pending, `readyState` is `CONNECTING` or `CLOSED`).
2. User types a prompt and hits Send. `sendPrompt` (`useWebSocketPool.ts:407`) optimistically appends the user message to `messagesRef` (line 415) and calls `send({ type: "prompt", ... })` (line 419).
3. `send` (line 397): `if (ws?.readyState === WebSocket.OPEN) ws.send(...)` — the condition is false, so **the prompt is never sent**. No error, no queue, no retry.
4. The optimistic local copy in `messagesRef` survives (the `#7` merge logic at `ws-pool-logic.ts:42-46` preserves local user messages across reconnect) — so the user SEES their prompt in the UI and believes it was sent.
5. On reconnect, `onopen` fires. The client sends `get_state`/`get_messages`/etc. (`useWebSocketPool.ts:133-140`) but **does NOT re-send the dropped prompt**. `messages_result` merges: server history + local-only user messages (`mergeMessagesOnReconnect`). The local prompt is preserved in the UI, but PI **never received it** — so no agent runs, no response comes, and the user stares at their own message with no reply.
6. If the user retypes the prompt, it IS sent (WS is now OPEN) — but the local copy of the FIRST prompt is still in `messagesRef`, producing a **duplicate in the UI** (though only one was sent to PI, so no duplicate run).

**Impact:** Prompt loss with silent failure — the single worst user-facing failure mode for a chat client. The `#7` merge was specifically designed to prevent this ("a re-type would duplicate it in PI", `ws-pool-logic.ts:6-9`), but the design assumes the prompt was actually *sent*. The merge keeps the un-sent local copy visible, which is the right call for UI continuity, but nothing ever *re-sends* it.

**Evidence:**
- `useWebSocketPool.ts:397`: `if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));` — no `else`, no queue.
- `useWebSocketPool.ts:407-421`: `sendPrompt` calls `send({ type: "prompt", ... })` unconditionally; the local append at line 415 happens regardless of send success.
- `useWebSocketPool.ts:120-141` (`onopen`): requests state/messages/models but never re-sends pending prompts.
- `ws-pool-logic.ts:6-9` comment confirms the intent: the merge exists *so that* a prompt sent before a drop isn't lost — but the prompt was never sent.

**Worse cases (same root):**
- `steer`/`follow_up` during reconnect: same silent drop. The `pendingSteering`/`pendingFollowUp` arrays (`useWebSocketPool.ts:79-81`) are appended to in `send` (lines 391, 394) for UI state, but those arrays are **not a re-send queue** — they're cleared on `message_end` echo (lines 231-232) and never re-flushed on `onopen`. So a steer sent during reconnect is lost AND the UI shows it as pending until an echo that never comes.
- `abort` during a runaway run while reconnecting: dropped. The user cannot stop a runaway agent if the WS happens to be down.
- `extension_ui_response` (answering a blocking dialog) during reconnect: dropped. PI stays blocked on the dialog; the server's `pendingDialog` replay (`server/src/pi-agent.ts:139-146`) re-shows it on reconnect, but the user's already-typed answer is gone.

**Fix:** Add a minimal pending-message queue that flushes on `onopen`. The simplest correct version:
```ts
const pendingQueue: WSClientMessage[] = [];
function send(msg: WSClientMessage) {
  if (msg.type === "steer") { data.pendingSteering = [...data.pendingSteering, msg.message]; notify(); }
  else if (msg.type === "follow_up") { data.pendingFollowUp = [...data.pendingFollowUp, msg.message]; notify(); }
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  } else if (msg.type === "prompt" || msg.type === "steer" || msg.type === "follow_up"
             || msg.type === "extension_ui_response" || msg.type === "abort") {
    pendingQueue.push(msg); // re-send on reconnect
  }
}
// in onopen, after the get_state/get_messages block:
setTimeout(() => {
  while (pendingQueue.length) send(pendingQueue.shift()!); // ws now OPEN, so send() succeeds
}, 250);
```
Caveat: `extension_ui_response` replay could double-answer if the server also replays the dialog (`server/src/pi-agent.ts:139-146`) and the client answers both. The server's `resolveDialogResponse` drops unknown ids silently (`server/src/pi-agent.ts` "Unknown id — drop silently"), so a duplicate response to an already-answered dialog is harmless. The `prompt`/`steer`/`follow_up` queue must be deduped against the server's `messages_result` echo on reconnect to avoid double-runs — but the `#7` merge already provides the signature for this; the queue should drop any prompt whose signature already appears in `messagesRef` after the `messages_result` merge.

---

### [CRITICAL] F3 — `sessionStorage` does NOT survive tab close+reopen or browser restart; the reattach token is lost

**Location:** `packages/client/src/App.tsx:327` (`LIVE_SESSION_KEY = "pi-web:live-session"`), `App.tsx:514` (`sessionStorage.setItem`), `App.tsx:468` (`sessionStorage.getItem`).

**Scenario:**
1. User has a live streaming session. `sessionStorage["pi-web:live-session"] = {projectId, sessionPath}` is set (`App.tsx:514`).
2. User closes the tab (cmd+W) or the browser crashes / is force-quit. `sessionStorage` is **per-tab and does not survive tab close** (per the HTML spec; `sessionStorage` is cleared when the browsing context is destroyed).
3. User reopens the tab (ctrl+shift+T / "reopen closed tab") or restarts the browser with session restore.
4. `restoreLiveSession` (`App.tsx:419`) Path 1: `sessionStorage.getItem(LIVE_SESSION_KEY)` returns null.
5. Path 2 (`/live-sessions`): the server's `getLiveSessionsForCwd` (`server/src/pi-agent.ts:553-573`) returns live agents — BUT only if the agent is still in the pool. The 1-hour idle timer (`IDLE_TIMEOUT_MS`, `server/src/pi-agent.ts:25`) means a long tab-close (>1h) reaps the agent. For a short close (<1h), the agent survives and Path 2 recovers it.
6. **For a short tab-close+reopen, Path 2 saves the session.** For a browser restart / long absence, the agent is reaped and the session is gone — but that's server policy, not a client bug.

**Impact:** For tab-close+reopen within the idle window, the `/live-sessions` fallback recovers the session — so this is **less severe than it first appears**. The real gap is the `projectId` selection: `restoreLiveSession` only runs after `selectedProject` is set, and the project-restore effect (`App.tsx:386-417`) falls back to "most-recently-touched project" (`lastOpenedAt` sort, `App.tsx:403-405`). If the user has multiple projects and the `lastOpenedAt` touch is stale (e.g. another project was opened more recently in a different tab), the **wrong project** is selected, `restoreLiveSession` queries `/live-sessions` for the wrong `cwd`, and the live session for the original project is **not found** — even though it's still in the pool under the original project's cwd.

**Evidence:**
- `App.tsx:327`: `const LIVE_SESSION_KEY = "pi-web:live-session";` — sessionStorage, not localStorage.
- `App.tsx:514`: `sessionStorage.setItem(LIVE_SESSION_KEY, ...)` — per-tab.
- `App.tsx:403-405`: fallback picks `sorted[0]` by `lastOpenedAt` — this is a *guess*, not the actual project that owned the orphaned session.
- `server/src/pi-agent.ts:25`: `IDLE_TIMEOUT_MS = 60 * 60 * 1000` — 1 hour grace.

**Fix:** Either (a) use `localStorage` for `LIVE_SESSION_KEY` (survives tab close + browser restart) — the key is just `{projectId, sessionPath}`, no sensitive data, and the server's idle timer is the real liveness bound; or (b) have the server's `/live-sessions` endpoint accept no project filter and return ALL live sessions across projects, so the client can recover regardless of which project was selected. Option (a) is the minimal change and directly addresses the tab-reopen case. The `restoreAttemptedRef` gate (`App.tsx:349`) already prevents double-restore, so moving to localStorage doesn't introduce re-entrancy.

**Note:** This is marked CRITICAL because tab-close+reopen is an extremely common user action and the failure is silent — the user expects to return to their session and instead lands on a (possibly wrong) project view. But it's partially mitigated by Path 2 for the common case (single project, short absence).

---

### [HIGH] F4 — `reconnectAttempts` is never reset on intentional close-and-reopen of a DIFFERENT session; backoff ceiling persists across pool entries

**Location:** `packages/client/src/hooks/useWebSocketPool.ts:108` (`reconnectAttempts = 0`), `useWebSocketPool.ts:123` (reset on `onopen`), `useWebSocketPool.ts:156` (increment on `onclose`).

**Scenario:**
1. A connection's WS drops. `onclose` fires, `reconnectAttempts` increments through fast backoff (1s, 1.5s, 2.25s, ...) up to `MAX_RECONNECT=10` (`ws-pool-logic.ts:3`), then settles at `SLOW_RECONNECT_MS=30000` (30s) forever.
2. **This is actually correct per-connection** — `reconnectAttempts` is a closure variable per `createConnection`, so each pool entry has its own counter. The reset on `onopen` (line 123) correctly zeroes it when the WS reconnects.
3. **The actual risk:** `onerror` fires (line 160-163) and sets `lastError`, but does NOT clear `reconnectTimer` or set `intentionallyClosed`. If the browser fires `onerror` WITHOUT a subsequent `onclose` (which some browsers do for certain failure modes, e.g. a DNS failure on a long-lived WS), then `reconnectTimer` is never scheduled — the client **never reconnects** and `isConnected` stays false forever. The `onclose` handler is the only place `reconnectTimer` is set (line 152).

**Impact:** If `onerror` fires without `onclose` (a known browser inconsistency, especially for WS over flaky networks or when the OS suspends the network stack during sleep), the client gives up entirely. The `#3` "never give up" design (`ws-pool-logic.ts:6-10`) is defeated by this single missing path.

**Evidence:**
- `useWebSocketPool.ts:160-163`: `ws.onerror` only sets `lastError` and notifies — no reconnect scheduling.
- `useWebSocketPool.ts:144-157`: `ws.onclose` is the sole scheduler of `reconnectTimer`.
- `ws-pool-logic.ts:6-10`: comment states "never returns null/infinity — the client always retries" — but this invariant only holds if `onclose` fires.

**Fix:** In `ws.onerror`, if `ws.readyState !== WebSocket.OPEN` and `!intentionallyClosed` and `reconnectTimer` is null, schedule a reconnect with the same backoff as `onclose`:
```ts
ws.onerror = (e) => {
  data.lastError = "WebSocket connection error";
  notify();
  // Some browsers fire onerror WITHOUT onclose (e.g. DNS failure, network
  // stack suspend). Schedule reconnect here too so we never give up.
  if (!intentionallyClosed && !reconnectTimer && ws?.readyState !== WebSocket.OPEN) {
    const delay = computeReconnectDelay(reconnectAttempts);
    reconnectTimer = setTimeout(() => { reconnectAttempts++; connect(); }, delay);
  }
};
```
Guard against double-scheduling: check `reconnectTimer` is null. Since `onclose` clears and reschedules, and `onerror` only schedules if the timer is null, they won't stack.

---

### [HIGH] F5 — Double-reconnect risk: `onclose` can fire after a new `connect()` cycle, scheduling a second timer

**Location:** `packages/client/src/hooks/useWebSocketPool.ts:144-157` (`onclose`), `useWebSocketPool.ts:109-111` (`reconnectTimer`).

**Scenario:**
1. `onclose` fires (attempt N). `reconnectTimer = setTimeout(..., delay)` is scheduled (line 152).
2. Timer fires, `connect()` is called (line 155), creating a NEW `ws` and overwriting the closure's `ws` variable (line 119: `ws = new WebSocket(...)`).
3. The OLD `ws` object (now dereferenced) could still have a pending `onclose` if the browser delivers a late close event for the superseded socket. When it fires, `onclose` runs again — but `ws` in the closure now points to the NEW socket. The handler unconditionally schedules another `reconnectTimer` (line 152), **without clearing the existing one** if a new timer was already set by the intervening onclose.
4. Result: two `connect()` calls stack — two WebSocket instances open to the same agent. The server's `getOrCreateAgent` will return the same agent for both (reattach), but now there are TWO client WS entries in `agent.clients` (`server/src/pi-agent.ts:62`), and messages broadcast to both. One will eventually be orphaned when its `ws` variable is overwritten.

**Impact:** Transient duplicate WS connections per agent. Messages may be processed twice on the client (both WS instances deliver the same broadcast). Not a duplicate-session bug (server dedupes by agent key), but a resource leak and potential double-render. In practice, the 200ms `setTimeout` in `onopen` (`useWebSocketPool.ts:133`) means both sockets send `get_state`/`get_messages`, doubling server load briefly.

**Evidence:**
- `useWebSocketPool.ts:119`: `ws = new WebSocket(...)` — overwrites the closure variable; old socket's handlers still reference the shared closure.
- `useWebSocketPool.ts:152`: `reconnectTimer = setTimeout(...)` — no check for existing timer; no `clearTimeout(reconnectTimer)` before setting a new one.
- `useWebSocketPool.ts:109-111`: `reconnectTimer` is a single variable; a second assignment silently drops the reference to the first timer (which is still pending).

**Fix:** Clear any existing `reconnectTimer` at the top of `onclose` before scheduling:
```ts
ws.onclose = () => {
  data.isConnected = false;
  data.isStreaming = false;
  notify();
  if (!intentionallyClosed) {
    if (reconnectTimer) clearTimeout(reconnectTimer); // prevent double-schedule
    const delay = computeReconnectDelay(reconnectAttempts);
    reconnectTimer = setTimeout(() => { reconnectAttempts++; connect(); }, delay);
  }
};
```
Also consider tracking the current `ws` instance and ignoring `onclose`/`onerror` from a superseded socket (compare `ws` identity).

---

### [HIGH] F6 — `messageSignature` dedup can cause a DROPNED user message to be hidden, and a duplicate run is possible if the queue-flush (F2 fix) is added without care

**Location:** `packages/client/src/lib/ws-pool-logic.ts:19-34` (`messageSignature`), `ws-pool-logic.ts:42-46` (`mergeMessagesOnReconnect`).

**Scenario (message drop):**
1. User sends "yes" (prompt A). PI persists it, runs, responds.
2. Later, user sends "yes" again (prompt B). Optimistically appended to `messagesRef`.
3. WS drops. On reconnect, `messages_result` returns the full history including the FIRST "yes".
4. `mergeMessagesOnReconnect` (`ws-pool-logic.ts:42-46`): `seen = restored.map(messageSignature)` includes `user:yes:`. The local "yes" (prompt B) has signature `user:yes:` — matches `seen` — so it's **filtered out as a "duplicate"**.
5. If prompt B was NOT actually sent to PI (per F2), the user's message **vanishes from the UI** — no echo, no run, no indication. The user thinks they sent it; PI never got it.

**Scenario (duplicate run, if F2 queue-flush is added):**
1. User sends "yes" during reconnect. It's queued (F2 fix) AND optimistically appended to `messagesRef`.
2. On reconnect, the queue flushes: `send({ type: "prompt", message: "yes" })` — PI receives it, persists it, starts a run.
3. `messages_result` returns: history includes the new "yes" (PI persisted it from the flush). `mergeMessagesOnReconnect` sees `user:yes:` in `restored`. The local "yes" matches — filtered out. **Correct** — no duplicate in UI.
4. But if the queue flush races with the `messages_result` response (flush happens, then `messages_result` arrives without the new "yes" because PI hasn't persisted it yet), `mergeMessagesOnReconnect` keeps the local "yes" (not in `seen`) — and PI ALSO runs it from the flush. **No duplicate run** (only one flush), but the local copy persists until the next `agent_end` merge reconciles.
5. The real duplicate-run risk: if the queue is NOT idempotent and the WS drops AGAIN after the flush but before PI persists, the queue (if it survives the second drop) would re-flush. The F2 fix must **clear the queue on successful `send`** (not on `onopen`) to avoid re-flushing.

**Impact:** Today (without F2 fix): prompt B vanishes from UI if its text matches an earlier message — a data-loss bug for common short replies ("yes", "ok", "go", "continue"). With the F2 fix: the signature collision means the dedup logic needs to account for the queue, or it'll hide legitimately-sent messages.

**Evidence:**
- `ws-pool-logic.ts:19-34`: signature is `${role}:${text}:${toolCallId ?? ""}` — no timestamp, no message id.
- `ws-pool-logic.ts:23-25` comment: "Known ceiling: two genuinely-distinct user messages with identical text collide (e.g. 'yes' twice) — acceptable for a chat UI where that's rare and the second is a deliberate repeat." — **this assumption is wrong** when combined with F2: the second "yes" may NOT have been sent, so it's not a "deliberate repeat", it's a lost message being hidden by dedup.
- `ws-pool-logic.ts:42-46`: `localOnly = local.filter((m) => m.role === "user" && !seen.has(messageSignature(m)))` — filters by signature, no timestamp.

**Fix:** Include a client-generated nonce or the timestamp in the signature for user messages, OR (simpler) track sent-but-unacked prompts by a client-assigned id and match on that id in `mergeMessagesOnReconnect` instead of text. The minimal fix: append a per-message `clientId` to `ChatMessage` (optional field) and include it in `messageSignature` when present:
```ts
export function messageSignature(msg: ChatMessage): string {
  // ... existing text extraction ...
  return `${msg.role}:${text}:${msg.toolCallId ?? ""}:${(msg as any).clientId ?? ""}`;
}
```
Then `sendPrompt` assigns `clientId: crypto.randomUUID()` to the local message, and the dedup only collapses messages with the SAME clientId (or no clientId, for server-originated messages). This eliminates the "yes twice" collision while preserving dedup for true duplicates.

---

### [HIGH] F7 — `useOnlineStatus` exists but is NOT wired into the WS pool; offline WS stays "open" and silently fails every send

**Location:** `packages/client/src/hooks/usePWA.ts:75-86` (`useOnlineStatus`), `packages/client/src/components/PWABanner.tsx:20` (only consumer), `packages/client/src/hooks/useWebSocketPool.ts` (no import of `useOnlineStatus`).

**Scenario:**
1. User is on a flaky network (mobile, train, VPN). The OS network stack goes offline (e.g. WiFi disconnects).
2. The browser fires `window.offline` event. `useOnlineStatus` (`usePWA.ts:76-86`) sets `isOnline=false`. `PWABanner` shows an "Offline" badge.
3. **But the WebSocket does NOT close.** Many browsers keep a WS in `OPEN` state during a network transition — the TCP keepalive hasn't timed out yet (default TCP keepalive is ~2 hours). `ws.readyState` is still `1` (OPEN).
4. The user sends a prompt. `send` (`useWebSocketPool.ts:397`): `ws.readyState === WebSocket.OPEN` is true, so `ws.send(...)` is called — but the data goes into a dead TCP buffer. The browser may buffer it (if the network returns, it might eventually deliver) or silently drop it.
5. PI never receives the prompt. No `onclose` fires (the WS is still "open"), so no reconnect. The user stares at their prompt with no response. The "Offline" badge shows (from `useOnlineStatus`), but the WS layer is oblivious.
6. Eventually (2+ hours later), TCP keepalive fails, `onclose` fires, reconnect begins — but by then the user has long given up.

**Impact:** Silent prompt loss during network transitions. The `useOnlineStatus` hook exists specifically to detect this, but it's only used for a UI badge — the WS layer relies solely on `onclose`, which is unreliable for detecting offline state.

**Evidence:**
- `usePWA.ts:75-86`: `useOnlineStatus` listens to `online`/`offline` events — but no WS-layer consumer.
- `useWebSocketPool.ts`: grep for `useOnlineStatus|navigator.onLine|online|offline` returns no matches in this file.
- `PWABanner.tsx:20`: only consumer.
- `useWebSocketPool.ts:397`: `send` checks `readyState === OPEN` but not `navigator.onLine`.

**Fix:** Wire `useOnlineStatus` (or `navigator.onLine` directly) into the WS pool. On `offline`, proactively close the WS to force `onclose` and trigger reconnect backoff (which will keep retrying until the network returns). On `online`, force an immediate reconnect (reset `reconnectAttempts` and `connect()`). Minimal version in `useWebSocketPool.ts`:
```ts
useEffect(() => {
  const goOffline = () => { if (ws && !intentionallyClosed) { try { ws.close(); } catch {} } };
  const goOnline = () => {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    reconnectAttempts = 0;
    connect();
  };
  window.addEventListener("offline", goOffline);
  window.addEventListener("online", goOnline);
  return () => { window.removeEventListener("offline", goOffline); window.removeEventListener("online", goOnline); };
}, []);
```
This must be inside `createConnection` (or wired via the pool hook) so each connection reacts to network state. The `goOffline` close triggers `onclose` → reconnect backoff; `goOnline` short-circuits the backoff for immediate recovery.

---

### [MEDIUM] F8 — Multiple live sessions: `/live-sessions` picks `data.sessions?.[0]` (most-recently-active) but the client may pick the WRONG session

**Location:** `packages/client/src/App.tsx:465-467` (`const live = data.sessions?.[0]`).

**Scenario:**
1. User has two streaming sessions in the same project (session X and Y), both live.
2. Cache-cleared refresh. `restoreLiveSession` Path 2 queries `/live-sessions`. Server returns both, sorted by `lastActivityAt` descending (`server/src/pi-agent.ts:571`).
3. Client picks `data.sessions?.[0]` — the most-recently-active. If the user was actually viewing session Y but session X had more recent tool activity (a background tool finished), X is picked instead.
4. Client reattaches to X. Y is still live in the pool but the client has no handle to it — until the user navigates the session list and clicks Y.

**Impact:** Not a lost session (Y is recoverable via the session list), but the user lands on the "wrong" session after a refresh, which is confusing. The `BackgroundSessionToast` (`App.tsx:1130-1138`) may surface Y as a background session, mitigating confusion.

**Evidence:**
- `App.tsx:465-467`: `const live = data.sessions?.[0];` — first only, no user disambiguation.
- `server/src/pi-agent.ts:571`: `out.sort((a, b) => b.lastActivityAt - a.lastActivityAt)` — most-active first, which may not match the user's viewed session.

**Fix:** If multiple live sessions are returned, prefer the one matching `saved.sessionPath` (from sessionStorage, if available), else fall back to `sessions[0]`. Or surface all live sessions and let the user pick. The minimal fix: store the last-viewed `sessionPath` in `localStorage` (per F3) and match against the returned list.

---

### [MEDIUM] F9 — `rekey()` in `createConnection` parses the new key by splitting on `::`, but a sessionPath containing `::` would corrupt the split

**Location:** `packages/client/src/hooks/useWebSocketPool.ts:546-549` (`rekey`).

**Scenario:**
1. A sessionPath (file path) contains `::` — e.g. a path with a colon in a directory name, or a Windows path `C:\\Users\\...` (though `::` is rare). More realistically: a path segment with a literal `::` (some test fixtures or unusual filesystems).
2. `rekey(newKey)` at line 546: `const parts = newKey.split("::")` — splits on ALL `::`. If `newKey` is `projId::/path/with::colon/session.json::`, `parts` becomes `["projId", "/path/with", "colon/session.json", ""]` — `parts[1]` is `/path/with` (truncated), `parts[2]` is `colon/session.json` (wrong).
3. `currentSessionPath` is set to the truncated path. On reconnect, the WS URL includes the truncated `sessionPath`, and the server's `getOrCreateAgent` doesn't find a match — spawns a duplicate.

**Impact:** Low probability (sessionPaths are `~/.pi/agent/sessions/<uuid>.json`, unlikely to contain `::`), but if triggered, causes a duplicate session. The comment at line 545 claims "sessionPath is a ~/.pi file path (no `::`), so split is safe" — this is an assumption, not a guarantee.

**Evidence:**
- `useWebSocketPool.ts:546-549`: `const parts = newKey.split("::"); currentSessionPath = parts[1] || null; currentNewSessionId = parts[2] || null;`
- `useWebSocketPool.ts:545`: comment "sessionPath is a ~/.pi file path (no `::`), so split is safe."

**Fix:** Use `indexOf("::")` and `lastIndexOf("::")` to split into exactly three parts, or use a different delimiter that cannot appear in paths. Minimal:
```ts
const firstSep = newKey.indexOf("::");
const lastSep = newKey.lastIndexOf("::");
const projId = newKey.slice(0, firstSep);
const sessionPath = newKey.slice(firstSep + 2, lastSep);
const newSessionId = newKey.slice(lastSep + 2);
currentSessionPath = sessionPath || null;
currentNewSessionId = newSessionId || null;
```

---

### [MEDIUM] F10 — Pool cleanup on unmount closes ALL connections, including background streaming sessions the user navigated away from

**Location:** `packages/client/src/hooks/useWebSocketPool.ts:626-630` (unmount effect).

**Scenario:**
1. User has session A streaming in the background (navigated away to session B). The pool holds both A and B.
2. A React error boundary unmounts the `App` (or React 19 strict mode double-invokes effects in dev). The unmount effect (`useWebSocketPool.ts:626-630`) iterates ALL pool entries and calls `conn.close()` — including A.
3. `conn.close()` sets `intentionallyClosed = true` and closes the WS. The server's `detach` runs (`server/src/pi-agent.ts:130-133`), the idle timer starts, and if no other client reattaches within 1 hour, A is reaped.
4. On remount (strict mode), a new pool is created. Session A's conn is gone — `getOrConnect` creates a fresh WS, which reattaches to the still-live agent (if within the idle window). So this is **recoverable** in most cases.

**Impact:** In production (no strict mode double-mount), this only fires on true unmount (error boundary, route change if the app were nested in a router). The design comment at `App.tsx:89-94` explicitly says background sessions should NOT be torn down — but the unmount effect contradicts this. In practice, React strict mode in dev will close-and-reconnect every session on mount, causing a brief flit. The server's reattach logic makes this self-healing.

**Evidence:**
- `useWebSocketPool.ts:626-630`: `for (const conn of poolRef.current.values()) conn.close();`
- `App.tsx:89-94`: comment "PI processes for background sessions are not torn down when the user switches project/session."

**Fix:** This is likely intentional (full unmount = full teardown). The self-healing via server reattach makes it low-impact. If strict-mode flit is annoying, gate the unmount cleanup on a `isMountedRef` or skip it in dev. Low priority.

---

### [LOW] F11 — `pendingDialog` auto-dismiss timer (`notifyTimer`) is stored on `data` via a cast; if a reconnect happens mid-notification, the timer fires on stale state

**Location:** `packages/client/src/hooks/useWebSocketPool.ts:253-259` (notify auto-dismiss), `useWebSocketPool.ts:285-290` (timer stored on `data`).

**Scenario:**
1. An `extension_ui_request` with method `notify` arrives. `data.pendingNotification` is set, and a 4-second auto-dismiss timer (`NOTIFY_TIMEOUT_MS`, `constants.ts:6`) is scheduled.
2. WS drops and reconnects. The timer is NOT cleared (only `close()` clears it, line 562-564). On reconnect, the server may replay a DIFFERENT notification (or none).
3. The old timer fires after 4s, sends `extension_ui_response` with `cancelled: true` for the OLD notification id — which the server drops silently (unknown id). The NEW notification (if any) is not dismissed.
4. `data.pendingNotification` may be overwritten by the new notification, but the old timer still references the old `ui.id` — so it clears `pendingNotification` if the id still matches, potentially dismissing the new notification prematurely.

**Impact:** Minor UI glitch — a notification may be auto-dismissed too early or a stale response sent. Not a session-loss bug.

**Evidence:**
- `useWebSocketPool.ts:253-259`: timer captures `ui.id` in closure; checks `data.pendingNotificationId === ui.id` before clearing.
- `useWebSocketPool.ts:285-290`: `(data as any).notifyTimer = autoTimer` — single slot, overwritten by subsequent notifications.

**Fix:** Clear the existing `notifyTimer` before setting a new one (already done implicitly by overwriting, but the old timer is not `clearTimeout`-ed). Minimal: `if ((data as any).notifyTimer) clearTimeout((data as any).notifyTimer);` before assigning. Low priority.

---

### [LOW] F12 — `auto-retry` state (`data.autoRetry`) is not cleared on reconnect; a stale retry indicator may persist

**Location:** `packages/client/src/hooks/useWebSocketPool.ts:82` (`autoRetry` field), `useWebSocketPool.ts:120-141` (`onopen` does not reset `autoRetry`).

**Scenario:**
1. PI is in an auto-retry loop (`auto_retry_start` event sets `data.autoRetry`).
2. WS drops and reconnects. `onopen` does NOT clear `data.autoRetry`. The `get_state` response may or may not include retry state.
3. If PI exited its retry loop during the disconnect, the client still shows the retry indicator until the next `auto_retry_end` (which won't come if the retry is over).

**Impact:** Stale UI indicator. Not a session-loss bug.

**Evidence:**
- `useWebSocketPool.ts:120-141`: `onopen` resets `isConnected`, `lastError`, `liveMessages` — but not `autoRetry`, `compactionResult`, `pendingDialog`, etc.

**Fix:** In `onopen`, reset transient UI state: `data.autoRetry = null; data.compactionResult = null;` (the server will re-broadcast current state via `get_state`). Low priority.

---

## EXHAUSTIVE CHECKLIST — Client Reattach Paths

Each path traced end-to-end. ✅ = verified safe, ⚠️ = partially safe (mitigated by server), ❌ = unsafe (finding above).

### After a full page RELOAD (F5 / cmd+R)

| State piece | Survives reload? | Reattach? | Status |
|---|---|---|---|
| `sessionStorage[LIVE_SESSION_KEY]` (resolved session: `{projectId, sessionPath}`) | ✅ Yes | ✅ `restoreLiveSession` Path 1 reads it, `getOrConnect(projectId, sessionPath, null)` reattaches. Server `getOrCreateAgent(cwd, sessionPath, null)` finds existing agent by `buildAgentKey`. | ✅ Safe |
| `newSessionId` (pending new session, pre-rekey) | ❌ No (in-memory `useState`) | ❌ `restoreLiveSession` reads only `sessionPath`, never `newSessionId`. `/live-sessions` omits pending agents (`getLiveSnapshot` returns null). | ❌ **F1** |
| `messagesRef` (local message history) | ❌ No (in-memory) | ⚠️ Recovered from server via `get_messages` → `messages_result` → `mergeMessagesOnReconnect`. Local-only un-sent prompts (F2) are lost. | ⚠️ **F2, F6** |
| `pendingSteering` / `pendingFollowUp` | ❌ No (in-memory) | ❌ Not re-sent on reconnect. If a steer was sent but not echoed, it's lost. | ❌ **F2** |
| `reconnectAttempts` / `reconnectTimer` | ❌ No (in-memory) | ✅ Fresh `createConnection` starts at 0. No stale timer. | ✅ Safe |
| React component state (`view`, `selectedProject`, `activeSession`) | ❌ No | ⚠️ `selectedProject` recovered via `lastOpenedAt` sort (may pick wrong project if multiple). `activeSession` reconstructed from `sessionPath`. | ⚠️ **F3, F8** |

### After a tab CLOSE + REOPEN (cmd+W, then ctrl+shift+T)

| State piece | Survives? | Reattach? | Status |
|---|---|---|---|
| `sessionStorage[LIVE_SESSION_KEY]` | ❌ No (per-tab, cleared on tab close) | ⚠️ Path 2 (`/live-sessions`) recovers IF the right project is selected AND the agent is still in the pool (<1h idle). | ⚠️ **F3** |
| Everything else (in-memory) | ❌ No | Same as reload — fresh mount. | ⚠️ **F1, F2, F3** |

### After a browser RESTART / CRASH

| State piece | Survives? | Reattach? | Status |
|---|---|---|---|
| `sessionStorage` | ❌ No (cleared on browser close in most browsers; "reopen closed tabs" may restore it in some) | ⚠️ Path 2 only. Agent must survive 1h idle window. | ⚠️ **F3** |
| `localStorage` (if F3 fix applied) | ✅ Would survive | ✅ Would reattach. | Not yet implemented |

### After a NETWORK BLIP (WiFi off → on, <2h TCP keepalive timeout)

| State piece | Survives? | Reattach? | Status |
|---|---|---|---|
| All in-memory state | ✅ Yes (JS context alive) | ⚠️ WS may stay "OPEN" during offline (no `onclose`). `send()` silently drops. `useOnlineStatus` not wired in. | ❌ **F7, F2** |
| WS connection | ⚠️ May stay "OPEN" | ❌ No `onclose` → no reconnect until TCP keepalive fails (~2h). | ❌ **F7** |

### After a WS DROP (server restart, deploy, agent exit)

| State piece | Survives? | Reattach? | Status |
|---|---|---|---|
| All in-memory state | ✅ Yes | ✅ `onclose` fires → reconnect backoff. On reconnect, `get_state`/`get_messages` restore. Server `getOrCreateAgent` reattaches (or spawns fresh if agent was reaped). | ✅ Safe |
| `reconnectAttempts` | ✅ In-memory | ✅ Reset on `onopen` (line 123). Backoff ceiling at 30s forever. | ✅ Safe |
| `onerror` without `onclose` | — | ❌ No reconnect scheduled. | ❌ **F4** |
| Double `onclose` / late close event | — | ⚠️ May schedule two `connect()` calls. | ⚠️ **F5** |

### After a CACHE CLEAR (devtools → clear site data)

| State piece | Survives? | Reattach? | Status |
|---|---|---|---|
| `sessionStorage` | ❌ No | ⚠️ Path 2 (`/live-sessions`) is the designed fallback. Works IF the right project is selected. | ⚠️ **F3, F8** |
| `localStorage` | ❌ No | Same as above. | ⚠️ |

### Multiple tabs on the same session

| Concern | Status | Notes |
|---|---|---|
| Server broadcast to both tabs | ✅ Safe | `PooledAgent.broadcast` (`server/src/pi-agent.ts:222-228`) iterates all clients in the `clients` set. Both tabs receive messages. |
| Closing one tab kills the agent for the other? | ✅ Safe | `detach` (`server/src/pi-agent.ts:130-133`) only removes the one WS from `clients`; the agent stays alive while the other tab's WS is attached. Idle timer only starts when `clients.size === 0`. |
| Both tabs send prompts | ⚠️ Race | Both prompts reach PI. PI queues them (steering/follow-up). No duplicate-session risk, but the prompts interleave. By design. |

### `send()` while WS is not OPEN (CONNECTING/CLOSING/CLOSED)

| Message type | Behavior | Status |
|---|---|---|
| `prompt` | ❌ Silently dropped. Local copy in `messagesRef` persists (UI shows it). PI never runs. | ❌ **F2** |
| `steer` / `follow_up` | ❌ Silently dropped. `pendingSteering`/`pendingFollowUp` UI arrays updated but never re-sent. | ❌ **F2** |
| `abort` | ❌ Silently dropped. User cannot stop a runaway agent during reconnect. | ❌ **F2** |
| `extension_ui_response` | ❌ Silently dropped. PI stays blocked on dialog; server replays on reconnect. | ❌ **F2** |
| `get_state` / `get_messages` (control) | ✅ Re-sent on `onopen` (lines 133-140). | ✅ Safe |
| `new_session` / `load_session` / `switch_session` | ❌ Silently dropped. But these are user-initiated transitions; unlikely during reconnect. | ⚠️ Low risk |

### Auto-retry / abort_retry state across reconnect

| Concern | Status | Notes |
|---|---|---|
| `autoRetry` state persists across reconnect | ⚠️ Stale | `onopen` doesn't clear `data.autoRetry`. May show stale retry indicator. | ⚠️ **F12** |
| `abort_retry` during reconnect | ❌ Dropped | Per F2. User cannot abort a retry if WS is down. | ❌ **F2** |

---

## What IS Robust (verified safe)

The following paths are correctly handled and should NOT be changed:

1. **Server-side `getOrCreateAgent` reverse-lookup** (`server/src/pi-agent.ts:606-635`): correctly reattaches to a rekeyed agent by `originalNewSessionId` when a client reconnects with a stale `newSessionId` after rekey. Well-tested (`pi-agent.test.ts:590-613`). The client just needs to SEND the same newSessionId — which is the gap (F1).

2. **`sessionPath` normalization** (`server/src/pi-agent.ts:577-580`, `buildAgentKey`): trailing slashes, `//`, `./`, `..` are normalized so path-equivalent strings produce the same key. A client reconnecting with a slightly different path string reattaches correctly. Well-tested (`pi-agent.test.ts:566-588`).

3. **`reconnectDelay` backoff** (`ws-pool-logic.ts:11-19`): never returns null/infinity, caps at 30s forever. The `#3` "never give up" invariant holds for the `onclose` path. Well-tested (`ws-pool-logic.test.ts:10-36`).

4. **`mergeMessagesOnReconnect` trust model** (`ws-pool-logic.ts:42-46`): correctly NEVER trusts local assistant/toolResult over server history. Only local user messages are preserved. Well-tested (`ws-pool-logic.test.ts:39-83`).

5. **`rekey()` pool entry move** (`useWebSocketPool.ts:536-557`): correctly unregisters from old key, registers under new key, updates `currentSessionPath`/`currentNewSessionId` for reconnect. Well-tested (`useWebSocketPool.test.ts:88-130`). The `::` split assumption (F9) is the only gap.

6. **`close()` cleanup** (`useWebSocketPool.ts:558-565`): clears `reconnectTimer` and `notifyTimer`, sets `intentionallyClosed`, closes WS. Prevents reconnect after intentional disconnect.

7. **Server's `closeClients()` on agent exit** (`server/src/pi-agent.ts:204-209`): when PI dies, the server closes all client WSes, triggering client `onclose` → reconnect. Prevents the "WS open but agent gone" silent-failure mode. Comment at `server/src/index.ts:2564-2568` confirms this design.

8. **Server's `pendingDialog` replay on attach** (`server/src/pi-agent.ts:139-146`): a blocking dialog is replayed to a reconnecting client so PI doesn't wedge forever. Combined with the client's `extension_ui_request` handler (`useWebSocketPool.ts:265-271`), this recovers a refresh-mid-dialog correctly.

9. **`restoreAttemptedRef` gate** (`App.tsx:349`, `App.tsx:520-525`): prevents the persistence effect from clearing `LIVE_SESSION_KEY` on the initial mount before restore runs. Well-guarded against the "refresh loses session" regression. Static test (`App.sessionSwitch.test.tsx:71-91`) enforces this.

10. **Pool keying per (project, session)** (`useWebSocketPool.ts:590`): `getOrConnect` keys by `${projectId}::${sessionPath}::${newSessionId}`, so different sessions get different conns. No cross-session interference. Well-tested (`useWebSocketPool.test.ts:25-65`).

---

## Summary of Required Fixes (by priority)

| Priority | Finding | Fix size | Risk if unfixed |
|---|---|---|---|
| CRITICAL | F1: Persist `newSessionId` for pending new sessions | ~10 lines in App.tsx | Duplicate session on reload/tab-close before rekey |
| CRITICAL | F2: Queue `send()` messages when WS not OPEN, flush on reconnect | ~15 lines in useWebSocketPool.ts | Silent prompt loss during any reconnect window |
| CRITICAL | F3: Use `localStorage` (not `sessionStorage`) for `LIVE_SESSION_KEY` | ~3 line change in App.tsx | Tab-close+reopen loses reattach token |
| HIGH | F4: Schedule reconnect in `onerror` when `onclose` may not fire | ~5 lines in useWebSocketPool.ts | Client gives up forever on certain network failures |
| HIGH | F5: Clear existing `reconnectTimer` before scheduling in `onclose` | ~1 line in useWebSocketPool.ts | Transient duplicate WS connections |
| HIGH | F6: Add `clientId` to `messageSignature` to prevent "yes twice" collision | ~5 lines in ws-pool-logic.ts | Distinct user messages with same text vanish |
| HIGH | F7: Wire `useOnlineStatus` into WS pool (close on offline, reconnect on online) | ~10 lines in useWebSocketPool.ts | Silent failure during network transitions |
| MEDIUM | F8: Prefer saved `sessionPath` when multiple live sessions returned | ~5 lines in App.tsx | Wrong session selected after refresh |
| MEDIUM | F9: Use `indexOf`/`lastIndexOf` instead of `split("::")` in `rekey` | ~5 lines in useWebSocketPool.ts | Path with `::` corrupts reconnect params |
| MEDIUM | F10: (Low priority) Gate unmount cleanup for strict mode | ~3 lines | Dev-only flit |
| LOW | F11: Clear existing `notifyTimer` before setting new | ~1 line | Minor UI glitch |
| LOW | F12: Reset transient UI state in `onopen` | ~2 lines | Stale indicator |

**The three CRITICAL fixes (F1, F2, F3) are independent and should all be applied.** F2 and F6 interact (the queue flush must dedup against `messages_result` using the improved signature from F6). F4 and F5 are independent one-liners. F7 is the most impactful HIGH fix for mobile/flaky-network users.

The bar of "ZERO unhandled edge cases" is NOT met. The three CRITICAL findings represent real session-loss / duplicate-session paths under common user actions (reload, tab-close, network blip). The server-side reattach logic is robust and compensates for many client mistakes, but it cannot compensate for a lost `newSessionId` (F1) or a never-sent prompt (F2) — those require client-side fixes.
