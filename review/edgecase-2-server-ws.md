# Adversarial Edge-Case Review: Server-Side WebSocket Transport & Live-Session Streaming

**Scope:** `packages/server/src/index.ts` WS handler (lines ~2475-2742), `packages/server/src/pi-agent.ts` (full `PooledAgent` + `SDKAgent`), `packages/server/src/pi-terminal.ts` (terminal WS reattach contract), `packages/server/src/pi-agent.test.ts` (coverage gaps).

**Prior review:** `review/2-server-ws-recovery.md`. This review re-verifies all prior findings against CURRENT code and hunts for what was MISSED.

**Working-tree state:** HEAD = `628ff9a` ("fix: harden PI session reattach across reload, network blip, and SW update"). Line numbers from working tree.

---

## Prior-Review Findings: Re-Verification

| # | Prior Finding | Status | Evidence |
|---|---------------|--------|----------|
| 1 | HIGH: `onOpen` fatal-catch doesn't `ws.close()` | ✅ **FIXED** | `index.ts:2580-2588` — catch block now calls `try { ws.close(); } catch {}` with `#LIVE` comment |
| 2 | MEDIUM: WS `load_session`/`switch_session` skip `validateSessionPath` | ⚠️ **FIXED-BUT-BROKEN** — see CRITICAL-1 below | `index.ts:2616,2621` — validation added but `cwd` is out of scope |
| 3 | MEDIUM: `restartWithSession` dead code orphans agent | ✅ **FIXED** | `pi-agent.ts:241-246` — method removed with explanatory comment |
| 4 | MEDIUM: Hono/Bun WS adapter has no `onError` — ghost entries | ⚠️ **PARTIALLY MITIGATED** — see MEDIUM-1, HIGH-3 below | `broadcast`/`sendToClients` now prune dead sockets; Bun's `idleTimeout` (120s default) eventually fires `onClose`. Gap remains for idle agents. |
| 5 | LOW: `broadcast`/`sendToClients` skip dead sockets but don't prune | ✅ **FIXED** | `pi-agent.ts:281-296` (`broadcast`), `298-305` (`sendToClients`) — both now prune `readyState !== 1` and catch-removal |

---

## New Findings

### [CRITICAL] 1. `cwd` out-of-scope in `onMessage` — `validateSessionPath` called with `undefined` projectPath, breaking WS `load_session`/`switch_session` for project-local sessions

**Trigger:** Client sends `{"type":"load_session","sessionPath":"<project>/.pi/sessions/abc.json"}` or `{"type":"switch_session",...}` via WebSocket. The session path is inside `<project>/.pi/sessions` (a legitimate session root per `getSessionRoots`).

**Why it severs:** The `cwd` variable is defined inside `onOpen` (`index.ts:2536` `const cwd = project.path;`) but referenced in `onMessage` (`index.ts:2616` `validateSessionPath(msg.sessionPath, cwd)` and `index.ts:2621` `validateSessionPath((msg as any).sessionPath, cwd)`). In JavaScript, `onOpen` and `onMessage` are sibling methods of the returned object — `cwd` is NOT in `onMessage`'s scope. At runtime (Bun doesn't type-check), `cwd` is `undefined`. `validateSessionPath(path, undefined)` calls `getSessionRoots(undefined)` which returns only `[~/.pi/agent/sessions]` — the project-local root (`<project>/.pi/sessions`) is missing. Any session stored in the project-local root is rejected with "Path is outside allowed session directory." The user cannot load or switch to project-local sessions via WS. This severs the in-process session-switch flow (clone, switch_session), which is the exact path the prior review's MEDIUM finding #2 was supposed to protect.

**Evidence:**
- TypeScript confirms the error:
  ```
  $ cd packages/server && bunx tsc --noEmit
  src/index.ts(2616,76): error TS2304: Cannot find name 'cwd'.
  src/index.ts(2621,87): error TS2304: Cannot find name 'cwd'.
  ```
- `index.ts:2536` — `const cwd = project.path;` (local to `onOpen`)
- `index.ts:2616` — `agent.loadSession(validateSessionPath(msg.sessionPath, cwd));` (in `onMessage`)
- `index.ts:2621` — `agent.switchSession(validateSessionPath((msg as any).sessionPath, cwd));` (in `onMessage`)
- `index.ts:69-75` — `getSessionRoots(projectPath?)` only adds project root when `projectPath` is truthy
- `git diff HEAD~1` confirms this was introduced in commit `628ff9a` ("fix: harden PI session reattach") — the fix for prior review's MEDIUM #2

**Handled?** NO. This is a regression introduced by the fix for the prior review's MEDIUM finding #2.

**Fix:** Derive `cwd` from `projectId` inside `onMessage` (mirroring the `delete_session` case at `index.ts:2664` which does `const proj = getProject(projectId)`):
```ts
case "load_session": {
  const proj = getProject(projectId);
  const cwd = proj?.path;
  try { agent.loadSession(validateSessionPath(msg.sessionPath, cwd)); }
  catch (e: any) { try { if (ws.readyState === 1) ws.send(JSON.stringify({ type: "error", message: `Invalid session path: ${e.message}` })); } catch {} }
  break;
}
// same for switch_session
```

---

### [HIGH] 2. No server-side keepalive ping/pong timeout configured — half-open TCP connections can linger

**Trigger:** Client's TCP connection goes half-open (e.g., laptop sleep, network change, suspended tab). The OS-level TCP keepalive may keep the connection alive from the kernel's perspective, but no application-level data flows.

**Why it severs (or doesn't):** The WS handler at `index.ts:2486-2742` does NOT configure `sendPings`, `idleTimeout`, or `backpressureLimit`. The Hono adapter's `websocket` object (verified in `node_modules/.bun/hono@4.12.22/.../adapter/bun/websocket.js`) only wires `open`, `close`, `message` — no `error`, no `ping`/`pong`. Bun's `Bun.serve` at `index.ts:2802` passes this object as the `websocket` option. Bun applies defaults (`sendPings: true`, `idleTimeout: 120s`) when these fields are absent, which SHOULD close dead connections after ~120s of no received data (including pongs). However:
- This is not explicitly configured — relying on undocumented Bun defaults is fragile.
- If the agent is actively streaming (sending messages), the server-side sends reset the idle timer for SENT data, but Bun's `idleTimeout` is based on RECEIVED data (pongs from the client). A suspended client won't pong, so the idle timeout SHOULD fire. But if Bun's implementation differs from the docs, the connection could leak.
- The `wsToAgent` Map and `agent.clients` Set retain entries until `onClose` fires. During the ~120s gap, `clients.size > 0` prevents the idle timer from arming.

**Evidence:**
- `index.ts:2802` — `Bun.serve({ port, hostname, fetch: app.fetch, websocket })` — `websocket` is the Hono adapter object with only `open`/`close`/`message`
- Hono adapter source: `var websocket = { open(ws) {...}, close(ws, code, reason) {...}, message(ws, message) {...} };` — no `sendPings`/`idleTimeout`/`error`
- No grep hits for `ping|pong|keepalive|idleTimeout|sendPings|backpressure` in `packages/server/src/`

**Handled?** PARTIAL — Bun's default `idleTimeout` (120s) provides a backstop. But it's not explicit, and the Hono adapter doesn't forward `error` events.

**Fix:** Explicitly configure WS keepalive in the `Bun.serve` call (if the Hono adapter allows passthrough) or switch to Bun's native WS directly:
```ts
Bun.serve({
  port, hostname, fetch: app.fetch,
  websocket: { ...websocket, sendPings: true, idleTimeout: 120 }
});
```
If the Hono adapter doesn't support this, a periodic reaper sweep (as suggested in the prior review) is the fallback.

---

### [HIGH] 3. `broadcast` prunes dead sockets but doesn't call `maybeStartIdleTimer()` — idle agents with dead clients never reap

**Trigger:** A client's WS dies hard (no `onClose` fires — see MEDIUM-1). The agent was idle (not streaming, no tools running). The dead client stays in `agent.clients` because no `broadcast` occurs (the agent is idle, producing no messages). `clients.size > 0` prevents the idle timer from arming. The watchdog only fires for ACTIVE (streaming/tool) agents — idle agents are exempt.

**Why it severs:** The agent sits in the pool forever with a dead client. The pool entry is never reaped. A reconnecting client with the same `sessionPath` would reattach to this agent (which is fine — the agent is alive). But the RESOURCE LEAK is unbounded: every hard-disconnect on an idle agent permanently leaks the agent + its SDK session + memory. Over time, on a server with flaky connections, agents accumulate.

For ACTIVE agents: when a message is produced, `broadcast` prunes the dead socket, but `maybeStartIdleTimer()` is NOT called after pruning. If the agent then goes idle (`agent_end`), `noteActivity` calls `maybeStartIdleTimer()` — at that point `clients.size` is 0 (dead socket was pruned), so the timer arms. So active agents ARE eventually reaped. But IDLE agents that never produce another message are stuck.

**Evidence:**
- `pi-agent.ts:281-296` — `broadcast` prunes `ws.readyState !== 1` and catch-removes, but does NOT call `maybeStartIdleTimer()` after pruning
- `pi-agent.ts:298-305` — `sendToClients` same pattern
- `pi-agent.ts:452-469` — `maybeStartIdleTimer()` only called from `detach()`, `noteActivity()` (on `agent_end`/`tool_end`/`state` with `isStreaming: false`), and `forceStopAndRemove()`. NOT called from `broadcast`/`sendToClients`.
- `pi-agent.ts:476-499` — watchdog only fires when `isActive()` (streaming or tools running) AND `clients.size === 0`. Idle agents are exempt.
- Bun's `idleTimeout` (120s) provides a backstop: eventually `onClose` fires → `detach()` → `maybeStartIdleTimer()`. But the gap is up to 120s.

**Handled?** PARTIAL — Bun's `idleTimeout` eventually fires `onClose`, which calls `detach()` → `maybeStartIdleTimer()`. The gap is bounded to ~120s. But if Bun's `idleTimeout` doesn't apply (see HIGH-2), the agent leaks forever.

**Fix:** Call `maybeStartIdleTimer()` after pruning in `broadcast`:
```ts
private broadcast(msg: WSServerMessage) {
  const data = JSON.stringify(msg);
  let pruned = false;
  for (const ws of this.clients) {
    if (ws.readyState !== 1) { this.clients.delete(ws); pruned = true; continue; }
    try { ws.send(data); } catch { this.clients.delete(ws); pruned = true; }
  }
  if (pruned) this.maybeStartIdleTimer();
}
```
Additionally, a periodic sweep (every 60s) that checks all agents' clients for dead sockets and calls `maybeStartIdleTimer()` would catch the idle-agent-with-dead-client case that `broadcast` can't.

---

### [MEDIUM] 1. No `onError` handler — hard socket errors that don't fire `onClose` leave ghost entries in `wsToAgent`

**Trigger:** The underlying TCP socket hits a fatal error (RST mid-stream, OS-level socket abort). Bun's `ServerWebSocket` fires an `error` event. The Hono adapter does NOT wire `error` — only `open`/`close`/`message`. If Bun does not also fire `close` after `error` (not guaranteed for hard socket errors), `onClose` never runs.

**Why it severs (or doesn't):** `wsToAgent` retains the dead `raw → agentKey` mapping. `agent.clients` retains the dead `raw` (now pruned by `broadcast`/`sendToClients` for active agents — see HIGH-3 for idle agents). The `wsToAgent` leak is MEMORY-ONLY (the dead ws object stays referenced). A reconnecting client gets a NEW `raw` with a new `wsToAgent` entry, so reattach is NOT broken. The real impact is the `clients.size` inflation preventing idle reaping (covered in HIGH-3). Bun's `idleTimeout` (120s) provides a backstop — it should close the WS and fire `onClose`.

**Evidence:**
- Hono adapter source (`node_modules/.bun/hono@4.12.22/.../websocket.js`):
  ```js
  var websocket = {
    open(ws) {...},
    close(ws, code, reason) {...},
    message(ws, message) {...}
    // no error(ws, err) handler
  };
  ```
- `index.ts:2486-2742` — WS handler config has no `onError`
- `index.ts:2727-2740` — `onClose` is the only cleanup path for `wsToAgent`

**Handled?** PARTIAL — `broadcast`/`sendToClients` prune dead sockets from `agent.clients` (mitigating the `clients.size` inflation for active agents). Bun's `idleTimeout` should fire `onClose` within ~120s. The `wsToAgent` memory leak is bounded to one dead ws object per hard-disconnect.

**Fix:** Switch to Bun's native WS (bypassing the Hono adapter) to get `error` events, OR add a periodic sweep that scans `wsToAgent` for entries where `ws.readyState !== 1` and removes them. Given the 127.0.0.1-only binding, risk is low.

---

### [MEDIUM] 2. Backpressure on slow/stalled client — `ws.send()` return value not checked, messages silently dropped

**Trigger:** A client is slow to read (stalled tab, slow device, constrained bandwidth). The server's `broadcast` calls `ws.send(data)`. Bun's `ServerWebSocket.send()` returns -1 when the send buffer is full (message dropped). The code does NOT check the return value. The `try/catch` only catches thrown errors, not -1 returns.

**Why it severs:** The client misses messages silently. The agent continues streaming (correct — don't lose a live session for a slow client). But the client sees missing output — a partial or blank stream — and thinks the agent is dead. The client doesn't know to reconnect because the WS is still "open." Bun's `backpressureLimit` (default ~16MB) should eventually close the WS with code 1011, firing `onClose` → reconnect. But until then, the client is in a "looks dead" state.

**Evidence:**
- `pi-agent.ts:288-294` — `broadcast`: `try { ws.send(data); } catch { this.clients.delete(ws); }` — no return value check
- `pi-agent.ts:300-305` — `sendToClients`: same pattern
- Bun's `ServerWebSocket.send()` returns `-1` when the buffer is full (per Bun docs), not a thrown error

**Handled?** PARTIAL — Bun's `backpressureLimit` eventually closes the WS. But the gap is unbounded in time (depends on buffer fill rate).

**Fix:** Check `ws.send()` return value and close the WS on sustained backpressure:
```ts
const result = ws.send(data);
if (result < 0) { this.clients.delete(ws); try { ws.close(1011, "Backpressure"); } catch {} }
```
This proactively disconnects a stalled client instead of silently dropping messages.

---

### [MEDIUM] 3. Terminal WS doesn't prune dead sockets — `pty.onData` iterates `clients` without `readyState` check or removal

**Trigger:** A terminal client's WS dies hard (no `onClose`). The PTY produces output. `pty.onData` iterates `clients` and calls `ws.send()` on the dead socket. `ws.send()` either throws (caught by `try/catch`) or returns -1 (not checked). The dead socket stays in `clients`.

**Why it severs (or doesn't):** Terminals are separate from the agent pool — a terminal leak does NOT keep an agent alive or break agent reattach. But the terminal holds a PTY process that never gets cleaned up (no idle timer for terminals — by design, they survive disconnects). The dead socket causes `ws.send()` to throw repeatedly on every PTY output, which is caught silently. The terminal is never reaped until `killTerminal` or PTY exit. Bun's `idleTimeout` (120s) eventually fires `onClose` → `term.detach(raw)`, mitigating the `clients` leak.

**Evidence:**
- `pi-terminal.ts:22-37` — `pty.onData` callback:
  ```ts
  for (const ws of this.clients) {
    try { ws.send(JSON.stringify({ type: "term_output", id: this.info.id, data })); } catch {}
  }
  ```
  No `readyState` check, no pruning on catch.
- `pi-terminal.ts:46-48` — `detach` just does `this.clients.delete(ws)` (only called from `onClose`)

**Handled?** PARTIAL — Bun's `idleTimeout` eventually fires `onClose` → `detach`. But the `pty.onData` callback keeps trying to send to the dead socket until then.

**Fix:** Add `readyState` check and pruning in `pty.onData`:
```ts
for (const ws of this.clients) {
  if (ws.readyState !== 1) { this.clients.delete(ws); continue; }
  try { ws.send(JSON.stringify({ type: "term_output", id: this.info.id, data })); } catch { this.clients.delete(ws); }
}
```

---

### [LOW] 1. `pendingDialog` not cleared after resolution — stale dialog replayed to new attachers

**Trigger:** Agent sends a blocking dialog (`select`/`confirm`/`input`/`editor`). `pendingDialog` is set (`pi-agent.ts:222-226`). Client responds. The dialog is resolved in `SDKAgent.resolveDialogResponse` (`pi-agent.ts:1075-1081`). But `pendingDialog` on `PooledAgent` is NOT cleared — it's only cleared on `agent_end` (`pi-agent.ts:202`) or exit (`pi-agent.ts:151`).

**Why it severs (or doesn't):** A new client that attaches after the dialog was resolved gets the STALE (already-answered) dialog replayed (`pi-agent.ts:175-178`). The client sees a dialog that's already been answered. If the client responds, `SDKAgent.resolveDialogResponse` checks `this.pendingDialogs.get(response.id)` → not found (already resolved) → drops silently. So no harm to the agent, but a UX confusion — the user sees a dialog that doesn't do anything.

**Evidence:**
- `pi-agent.ts:222-226` — `pendingDialog` set on `extension_ui_request` with blocking method
- `pi-agent.ts:175-178` — replayed on `attach`
- `pi-agent.ts:202` — only cleared on `agent_end`
- `pi-agent.ts:151` — cleared on exit
- `SDKAgent` (`pi-agent.ts:1075-1081`) — `resolveDialogResponse` resolves the SDK-side promise but doesn't clear `PooledAgent.pendingDialog`

**Handled?** NO — but impact is UX confusion, not a reattach severance.

**Fix:** Clear `pendingDialog` when the dialog is resolved. This requires a callback from `SDKAgent` to `PooledAgent` when a dialog is resolved, or checking in `handleAgentMessage` whether the dialog was answered. Simplest: add a `clearPendingDialog(id)` method and call it from `resolveDialogResponse` via the handler.

---

### [LOW] 2. `wsToAgent` Map leaks entries when `onClose` doesn't fire (hard socket error + no Bun idle timeout)

**Trigger:** Same as MEDIUM-1 — hard socket error without `onClose`. `wsToAgent` retains the dead `raw → agentKey` entry.

**Why it severs (or doesn't):** The dead `raw` object stays referenced by the `wsToAgent` Map. This is a MEMORY-ONLY leak — one dead `ServerWebSocket` object per hard-disconnect. A reconnecting client gets a new `raw` with a new entry, so reattach is NOT broken. The leak is bounded to one entry per hard-disconnect and is cleaned up if `onClose` eventually fires (via Bun's `idleTimeout`).

**Evidence:**
- `index.ts:2727-2740` — `onClose` is the only path that calls `wsToAgent.delete(raw)`
- No periodic sweep of `wsToAgent` for dead entries

**Handled?** PARTIAL — Bun's `idleTimeout` (120s) should eventually fire `onClose`.

**Fix:** Periodic sweep:
```ts
setInterval(() => {
  for (const [ws, key] of wsToAgent) {
    if ((ws as any).readyState !== 1 && (ws as any).readyState !== 0) {
      wsToAgent.delete(ws);
    }
  }
}, 60_000);
```

---

### [LOW] 3. No close-code differentiation — all close codes trigger identical pool behavior (correct, but undocumented)

**Trigger:** Client disconnects with close code 1000 (normal), 1001 (going away), 1006 (abnormal — no close frame), 1011 (server error), or 4000+ (application-specific).

**Why it severs (or doesn't):** The `onClose` handler at `index.ts:2727-2740` ignores the close code entirely:
```ts
onClose(_event, ws) {
  try {
    const raw = (ws as any).raw as ServerWebSocket;
    const agentKey = wsToAgent.get(raw);
    wsToAgent.delete(raw);
    if (agentKey) { detachFromAgent(agentKey, raw); }
  } catch (e) { console.error("Error in onClose:", e); }
},
```
This is CORRECT — the close code should not affect pool management. The agent stays alive with idle timeout regardless of why the client disconnected. `closeClients()` (server-initiated) uses default code 1000, which also triggers the same `onClose` path. No differentiation needed.

**Handled?** YES — correctly. This is a NOTE, not a bug.

---

## What IS Robust (Verified Against Current Code)

1. **`onOpen` fatal-catch now closes WS** (`index.ts:2580-2588`): `try { ws.close(); } catch {}` added. Client's `onclose` fires → reconnect. ✅
2. **`start()` failure path** (`index.ts:2562-2572`): Detaches, deletes from `wsToAgent`, deletes from pool, sends error, closes WS. Client reconnects. ✅
3. **Exit handler closes clients + deletes pool entry under CURRENT key** (`pi-agent.ts:138-159`): `closeClients()` + `agentPool.delete(this.agentKey)` (not the stale closure-captured key). ✅
4. **`restartWithSession` removed** (`pi-agent.ts:241-246`): Dead code eliminated. ✅
5. **Rekey handler syncs `wsToAgent`** (`index.ts:2551-2553`): Scans all entries, updates matching `oldKey` → `newKey`. Set on every `onOpen` (overwrites), but all closures do the same scan. ✅
6. **Reverse lookup by `originalNewSessionId`** (`pi-agent.ts:611-619`): Stale-newSessionId reconnect finds the rekeyed agent. `originalNewSessionId` cleared on `session_loaded` (switch/clone) so it can't reattach to the wrong session. ✅
7. **`session_loaded` rekey** (`pi-agent.ts:227-235`): `rekeyToSessionPath` called with the loaded `filePath`. `originalNewSessionId` cleared. ✅
8. **`forceStopAndRemove` deletes pool entry BEFORE `await stop()`** (`pi-agent.ts:511-520`): A reconnect during the `await` creates a fresh agent (pool entry gone). Clients closed before `await`. ✅
9. **`deleteFromPool` stops the agent** (`pi-agent.ts:691-703`): Fire-and-forget `agent.stop()`. Pool entry deleted first. ✅
10. **`stopAgentsForCwd` matches `${cwd}::` prefix** (`pi-agent.ts:714-724`): Correct prefix matching. ✅
11. **`broadcast`/`sendToClients` prune dead sockets** (`pi-agent.ts:281-305`): `readyState !== 1` check + catch-removal. ✅ (but doesn't call `maybeStartIdleTimer()` — see HIGH-3)
12. **Concurrent attach/detach**: JavaScript single-threaded. `Set.add`/`Set.delete` are atomic. No race. ✅
13. **Mid-stream WS disconnect**: `detachFromAgent` just removes the client — agent keeps running. No abort signal sent to pi. No .jsonl corruption (SDK writes to disk, not WS). Client reconnects and gets `state` + `get_messages`. ✅
14. **`onMessage` silent-drop when `lookupAgent()==null`** (`index.ts:2599`): Transient — exit handler closes clients → reconnect. ✅
15. **Attach during active streaming** (`pi-agent.ts:167-179`): Late attacher gets `getState()` (100ms) + `pendingDialog` replay + future events. Must call `get_messages` for full history. ✅ (client-side responsibility)
16. **`validateSessionPath`** (`index.ts:90-114`): `realpathSync` on both path and roots, `isInside` check, rejects directories. ✅ (when `projectPath` is provided — see CRITICAL-1 for the bug when it's not)
17. **Terminal WS reattach** (`index.ts:2487-2518`): Scrollback buffer sent on attach. `wsToTerminal` cleaned up on `onClose`. Separate from agent pool. ✅
18. **Concurrent `getOrCreateAgent`**: Single-threaded. First call creates + sets in pool. Second call finds existing. No duplicate. ✅
19. **`stopPromise` deduplication** (`SDKAgent`, `pi-agent.ts:1130-1133`): Concurrent `stop()` calls share the same promise. `onExit` doesn't fire twice. ✅

---

## Exhaustive Checklist (Updated)

| # | Reattach / Recovery Path | Status | Evidence |
|---|--------------------------|--------|----------|
| 1 | Normal WS disconnect → `onClose` → `wsToAgent.delete` + `detach` | ✅ Safe | `index.ts:2727-2740` |
| 2 | WS reconnect with same `sessionPath` → `getOrCreateAgent` reuses | ✅ Safe | `pi-agent.ts:598-601` |
| 3 | New-session rekey → `setRekeyHandler` syncs `wsToAgent` | ✅ Safe | `index.ts:2551-2553`, `pi-agent.ts:373-380` |
| 4 | Reconnect with stale `newSessionId` after rekey → reverse lookup | ✅ Safe | `pi-agent.ts:611-619` |
| 5 | `start()` failure → detach + delete + close WS → client reconnects | ✅ Safe | `index.ts:2562-2572` |
| 6 | `onOpen` fatal throw → **NOW closes WS** | ✅ Fixed | `index.ts:2580-2588` |
| 7 | Agent exit (PI crash) → `closeClients` → client `onclose` → reconnect | ✅ Safe | `pi-agent.ts:138-159` |
| 8 | Watchdog force-stop (stale streaming, no clients) | ✅ Safe | `pi-agent.ts:476-499` |
| 9 | Idle timeout → `agent.stop()` → exit handler → `closeClients` + delete | ✅ Safe | `pi-agent.ts:452-469` |
| 10 | Project deletion → `stopAgentsForCwd` stops all `${cwd}::` agents | ✅ Safe | `pi-agent.ts:714-724` |
| 11 | Server graceful shutdown → `stopAllAgents` (3s timeout) | ✅ Safe | `index.ts:2813` |
| 12 | Server crash (SIGKILL) → pool lost, client reloads from disk | ✅ Safe (by design) | `.jsonl` files persist |
| 13 | Hard refresh, `sessionStorage` wiped → `/live-sessions` endpoint | ✅ Safe | `index.ts:413-422` |
| 14 | `/live-sessions` TOCTOU (agent reaped between snapshot and WS open) | ✅ Safe (fresh agent) | `getOrCreateAgent` creates-if-missing |
| 15 | WS `load_session`/`switch_session` path validation | ⚠️ **BROKEN** | `index.ts:2616,2621` — `cwd` out of scope (CRITICAL-1) |
| 16 | Abnormal WS error (RST/TLS) with no `onClose` → ghost entries | ⚠️ Partial | Hono adapter no `onError`; Bun `idleTimeout` backstop (MEDIUM-1, HIGH-3) |
| 17 | `broadcast` prunes dead sockets | ✅ Fixed | `pi-agent.ts:281-305` (but doesn't call `maybeStartIdleTimer` — HIGH-3) |
| 18 | Backpressure on slow client → messages dropped | ⚠️ Partial | `send()` return not checked; Bun `backpressureLimit` backstop (MEDIUM-2) |
| 19 | Terminal WS dead socket pruning | ⚠️ Partial | `pi-terminal.ts:22-37` no `readyState` check (MEDIUM-3) |
| 20 | `pendingDialog` stale replay | ⚠️ LOW | `pi-agent.ts:222-226` not cleared on resolve (LOW-1) |
| 21 | No keepalive ping/pong config | ⚠️ Relies on Bun defaults | `index.ts:2802` (HIGH-2) |
| 22 | `restartWithSession` dead code | ✅ Fixed | `pi-agent.ts:241-246` — removed |
| 23 | Close code differentiation (1000/1001/1006/1011/4000+) | ✅ Safe (no differentiation needed) | `index.ts:2727-2740` |
| 24 | Server-initiated close vs client close → same pool effect | ✅ Safe | `closeClients()` → `onClose` → `detach` |
| 25 | Duplicate/echoed messages on reconnect | ✅ Safe | No server-side re-broadcast; client gets `state` + `get_messages` |
| 26 | `session_loaded` rekey race | ✅ Safe | Single-threaded; rekey is synchronous in `handleAgentMessage` |
| 27 | Attach during active streaming | ✅ Safe | `getState()` + `pendingDialog` + future events (LOW-1 for stale dialog) |
| 28 | Concurrent attach/detach races | ✅ Safe | Single-threaded; `Set.add`/`Set.delete` atomic |
| 29 | `forceStopAndRemove` racing reconnect | ✅ Safe | Pool entry deleted before `await stop()` (pi-agent.ts:511-520) |
| 30 | WS upgrade auth/origin validation | ✅ Safe | `projectId` required (`index.ts:2528-2535`); 127.0.0.1-only binding |
| 31 | `wsToAgent` / `agent.clients` consistency on error paths | ⚠️ Partial | `onClose` is only cleanup; no `onError` (MEDIUM-1) |

---

## Coverage Gaps in Tests

1. **No test for `load_session`/`switch_session` WS path validation.** The `cwd` out-of-scope bug (CRITICAL-1) is a TypeScript compile error that no test catches (tests run via `bun:test` which doesn't type-check). A test that sends a `load_session` message with a project-local session path would catch the runtime failure. No such test exists in `pi-agent.test.ts` (793 lines, all testing `PooledAgent`/pool functions directly, not the WS handler).

2. **No test for `broadcast` pruning + `maybeStartIdleTimer` interaction.** The pruning logic in `broadcast` (HIGH-3) is tested indirectly (the watchdog test at line ~520 uses `makeWS` which doesn't simulate dead sockets). No test simulates a WS that dies without `onClose` and verifies the idle timer eventually arms.

3. **No test for backpressure.** No test checks `ws.send()` returning -1 and the server's behavior. No test for Bun's `backpressureLimit` closing the WS.

4. **No test for `onError` / hard socket error without `onClose`.** No test simulates a WS that errors without closing and verifies `wsToAgent`/`agent.clients` cleanup.

5. **No test for `pendingDialog` stale replay.** The dialog replay test (line ~449) tests replay of an UNANSWERED dialog. No test verifies that an ANSWERED dialog is NOT replayed (or that it IS replayed — the current behavior, LOW-1).

6. **No test for terminal WS dead socket pruning.** No test for `pi-terminal.ts` behavior with dead sockets in `clients`.

7. **No test for `forceStopAndRemove` reconnect race.** The test at line ~520 tests watchdog force-stop, but doesn't test a reconnect DURING the `await this.agent.stop()` window.

8. **No integration test for the WS handler itself.** All tests in `pi-agent.test.ts` test `PooledAgent` and pool functions directly with `FakeAgent`. The actual WS handler in `index.ts` (including `onOpen`/`onMessage`/`onClose` wiring, `wsToAgent` management, rekey handler) is untested. The `cwd` scoping bug (CRITICAL-1) is in `index.ts`, not `pi-agent.ts`, so it's invisible to the test suite.
