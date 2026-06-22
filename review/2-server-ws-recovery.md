# Adversarial Edge-Case Review: Server-Side WebSocket Layer & Live-Session Recovery

**Scope:** `packages/server/src/index.ts` (WS handlers, endpoints, spawn sites, path validation), `packages/server/src/pi-agent.ts` (pool glue: `getOrCreateAgent`, `lookupAgent`, `rekeyAgent`, `detachFromAgent`, `deleteFromPool`, `stopAgentsForCwd`, `broadcastToProjectClients`, `getLiveSessionsForCwd`, `setRekeyHandler`), `packages/server/src/pi-sessions.ts` (session discovery), and the client recovery flow in `packages/client/src/App.tsx` + `hooks/useWebSocketPool.ts`.

**Working-tree state reviewed:** includes uncommitted diff (`live-sessions` endpoint, `getLiveSessionsForCwd`, watchdog, extended idle grace). Line numbers below are from the working tree.

---

## Findings

### [HIGH] onOpen fatal-catch leaves WS open with no `wsToAgent` entry — client hangs forever, never reconnects

**Location:** `packages/server/src/index.ts:2577-2580` (the `catch (fatalErr)` at the end of `onOpen`)

**Scenario:**
1. Client opens `/ws?projectId=...&sessionPath=...`.
2. `onOpen` enters the `try`. `getProject(projectId)` succeeds, `touchProject` runs.
3. `getOrCreateAgent(...)` throws (e.g. `buildAgentKey` is pure, but the `PooledAgent` constructor at `pi-agent.ts:111` could throw if `createAgent(options)` throws — or any synchronous error in the constructor path).
4. Execution jumps to `catch (fatalErr)` at L2577: logs, sends `{type:"error", message:"Internal server error"}`, and **returns without calling `ws.close()`**.
5. The WS is now OPEN, `wsToAgent` has no entry for `raw`, no agent was attached.
6. Client's `onopen` fires (client side `useWebSocketPool.ts:131`), marks `isConnected=true`, sends `get_state` / `get_messages` etc. at L138-142.
7. Server `onMessage` (L2583) reads `wsToAgent.get(raw)` → `undefined` → `if (!agentKey) return;` (L2585). Every message silently dropped.
8. Client never receives state, never receives an `onclose`, reconnect timer never starts. UI shows "connected" but dead.

**Impact:** A client that hits a transient construction error (e.g. SDK `AuthStorage.create()` throws on a corrupted credentials file, or `ModelRegistry.create` throws) is permanently stranded on a dead WS. The user must manually refresh — and if the same error reproduces on the next `getOrCreateAgent`, the client loops on dead connections. The agent pool is NOT affected (no entry was added), but the USER loses the ability to reach their live session because the client thinks it's connected.

**Evidence:**
```ts
// index.ts:2577-2580
} catch (fatalErr: any) {
  console.error("Fatal onOpen error:", fatalErr);
  try { ws.send(JSON.stringify({ type: "error", message: "Internal server error" })); } catch {}
}
// ↑ no ws.close() — WS stays open, no wsToAgent entry, client hangs
```
Contrast with the projectId-missing path (L2528-2536) and the project-not-found path (L2533-2537), which both correctly `ws.close()`. And the start()-failure path (L2569-2573) which also `ws.close()`s. Only this catch is missing it.

**Fix:** Add `ws.close()` in the fatal catch (mirror the start-failure path):
```ts
} catch (fatalErr: any) {
  console.error("Fatal onOpen error:", fatalErr);
  try { ws.send(JSON.stringify({ type: "error", message: "Internal server error" })); } catch {}
  try { ws.close(); } catch {}
}
```
This makes the client's `onclose` fire → reconnect timer starts → retries `getOrCreateAgent` (which may succeed on a transient error).

---

### [MEDIUM] WS `load_session` / `switch_session` messages accept arbitrary `sessionPath` with no validation — can reattach to / load a session outside allowed roots

**Location:** `packages/server/src/index.ts:2607-2608` (`onMessage` cases `load_session` / `switch_session`)

**Scenario:**
1. Client (or attacker with WS access — server is `127.0.0.1` bound, so local-only, but still) sends `{"type":"load_session","sessionPath":"/etc/passwd"}` or `{"type":"switch_session","sessionPath":"../../etc/shadow"}`.
2. `agent.loadSession(msg.sessionPath)` / `agent.switchSession(...)` at `pi-agent.ts:250-269` forwards directly to the SDK via `this.send({ type: "load_session", sessionPath })`.
3. The SDK attempts to open/read that path. Whether it succeeds depends on the SDK's own validation, but the SERVER does not gate it.
4. Every REST endpoint that takes a `sessionPath` (`GET /api/sessions/detail` L447, `DELETE /api/sessions/:path` L460, `PATCH /api/sessions/rename` L475, export endpoints) calls `validateSessionPath()`. The WS path does NOT.

**Impact:** Inconsistent trust boundary. A legit session path that happens to live outside the two hardcoded roots (`~/.pi/agent/sessions`, `<project>/.pi/sessions`) — e.g. a session the SDK wrote to a custom `--session` location — can be LOADED via WS but not READ/DELETED/RENAMED via REST. More importantly, a crafted path could direct the SDK to open a non-session file, and the subsequent `session_loaded` event would rekey the agent to that path (`pi-agent.ts:340-346`), polluting the pool key. This is not a "lose the ability to reconnect" bug per se, but it's a path-trust gap in the WS layer that the REST layer closes.

**Evidence:**
```ts
// index.ts:2607-2608 — no validateSessionPath
case "load_session": agent.loadSession(msg.sessionPath); break;
case "switch_session": agent.switchSession((msg as any).sessionPath); break;
```
vs.
```ts
// index.ts:447 — REST validates
const safePath = validateSessionPath(filePath);
const detail = await getSessionDetail(safePath);
```

**Fix:** Validate in the WS handler before forwarding (the `load_session`/`switch_session` are in the `try` block, so a throw is caught and logged at L2703 — but should send an error to the client):
```ts
case "load_session": {
  try { const safe = validateSessionPath(msg.sessionPath); agent.loadSession(safe); }
  catch (e: any) { if (raw.readyState === 1) raw.send(JSON.stringify({ type: "error", message: `Invalid session path: ${e.message}` })); }
  break;
}
// same for switch_session
```

---

### [MEDIUM] `restartWithSession` deletes the pool entry via the exit handler but never re-adds it — orphaned agent (dead code, but a latent trap)

**Location:** `packages/server/src/pi-agent.ts:223-243`

**Scenario:**
1. `restartWithSession(sessionPath)` is called (currently no caller — dead code, but exported on the class).
2. L229 `await this.agent.stop()` triggers `SDKAgent.stop()` → `this.onExit?.(0)` (L1068).
3. The exit handler (L233-238) calls `this.closeClients()` + `agentPool.delete(this.agentKey)`.
4. L231-242 creates a NEW inner `IPIAgent`, sets handler + exit handler, and `await this.agent.start()`.
5. **The `PooledAgent` is never re-inserted into `agentPool`.** It was deleted in step 3.
6. The agent runs, but `lookupAgent(key)` returns null — every `onMessage` after restart silently drops (`if (!agent) return;` at L2588). Clients are closed, so they reconnect, but `getOrCreateAgent` doesn't find this orphan and creates a DUPLICATE agent for the same key.

**Impact:** If `restartWithSession` is ever called (currently dead, but it's a public method), the agent is orphaned from the pool and a duplicate is spawned on reconnect. Not a current bug, but a trap.

**Evidence:** L229 `await this.agent.stop()` → exit handler L233 `agentPool.delete(this.agentKey)` → L231-242 new agent created but `agentPool.set(...)` is never called. Compare `stop()` (L273-279) which also deletes, or `forceStopAndRemove` (L492-498) which deletes after stop.

**Fix:** Either delete the dead method, or re-add to the pool after recreating the inner agent:
```ts
// after L241 (this.agent.setExitHandler(...))
agentPool.set(this.agentKey, this); // re-register — we were deleted by stop()'s exit handler
await this.agent.start();
```
Given ponytail (no unrequested code), **delete the method** — it's unused.

---

### [MEDIUM] Hono/Bun WS adapter has no `onError` — abnormal socket errors may not fire `onClose`, leaving ghost entries in `wsToAgent` and `agent.clients`

**Location:** `node_modules/.bun/hono@4.12.22/.../adapter/bun/websocket.js` (the `createBunWebSocket` adapter) — consumed by `index.ts:42` `const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>();`

**Scenario:**
1. Client WS is open and attached to an agent (`wsToAgent.set(raw, agentKey)`, `agent.attach(raw)`).
2. The underlying TCP socket hits a fatal error (RST mid-stream, TLS renegotiation failure, OS-level socket abort, OOM kill of the bun process's network layer).
3. Bun's `ServerWebSocket` fires the `error` event. The Hono adapter at `websocket.js` only wires `open`/`close`/`message` — it does NOT wire `error` or pass it through.
4. If Bun does not ALSO fire `close` after `error` (which is not guaranteed for hard socket errors — the WS may be in a half-open state), then:
   - `onClose` (L2684-2700) never runs.
   - `wsToAgent` retains `raw → agentKey` (ghost entry).
   - `agent.clients` retains the dead `raw` (ghost client).
   - `agent.maybeStartIdleTimer()` never arms because `clients.size > 0`.
   - The agent never reaps. It holds the session forever (until server restart).
5. A reconnecting client with the same `sessionPath` hits `getOrCreateAgent`, finds the ghost agent, reuses it. `agent.attach(newRaw)` adds the new client. Sends work. But the ghost client counts toward `clients.size`, so the idle timer never arms even after the real client leaves.

**Impact:** Ghost entries prevent idle reaping, slowly leaking agents over time on a server with flaky connections. The user can still REATTACH (the agent is alive), so this is not a "lose the session" bug — it's a resource leak. The bigger risk: if the ghost agent's underlying SDK session also died (but the pool doesn't know), sends are silently dropped.

**Evidence:** The Hono adapter source (read from `node_modules`):
```js
var websocket = {
  open(ws) { ... },
  close(ws, code, reason) { ... },
  message(ws, message) { ... }
  // ↑ no error(ws, err) handler
};
```
Bun's `ServerWebSocket` DOES support an `error` event, but the Hono adapter doesn't forward it. There's no `onError` in the WS config at `index.ts:2519-2702`.

**Fix:** This is a framework limitation. The pragmatic mitigation is a periodic reaper that scans `agent.clients` for sockets with `readyState !== 1` (OPEN) and removes them:
```ts
// ponytail: sweep ghost clients every WATCHDOG_TICK_MS — Bun/Hono adapter
// has no onError, so a hard socket error without a follow-up close leaves
// a dead ws in agent.clients. readyState check is cheap.
setInterval(() => {
  for (const agent of agentPool.values()) {
    for (const ws of agent.clients) {
      if ((ws as any).readyState !== 1) {
        try { agent.detach(ws); } catch {}
      }
    }
  }
}, 60_000);
```
This requires exposing a `sweepDeadClients()` method on `PooledAgent`. Alternatively, upgrade Hono or switch to Bun's native WS directly (bypassing the Hono adapter) to get `error` events. Given the 127.0.0.1-only binding, the risk is low; flag as MEDIUM.

---

### [LOW] `getLiveSessionsForCwd` TOCTOU: snapshot says "streaming" but agent reaped before client reattaches — client gets a fresh agent (acceptable, not a loss)

**Location:** `packages/server/src/pi-agent.ts:551-572` (`getLiveSessionsForCwd`), `packages/client/src/App.tsx:463-468` (client consumes it)

**Scenario:**
1. Client hard-refreshes. `sessionStorage` wiped.
2. Client calls `GET /api/projects/:id/live-sessions`. Server returns `[{sessionPath:"/x.jsonl", isStreaming:true, ...}]`.
3. Between the response and the client opening the WS, the agent's watchdog fires (15min stale, no clients) → `forceStopAndRemove` → pool entry deleted.
4. Client opens WS with `?sessionPath=/x.jsonl`. `getOrCreateAgent` finds NO entry → creates a NEW agent → `SDKAgent.start()` calls `SessionManager.open(sessionPath)` → reloads the session from disk.
5. Client gets a fresh agent on the same session file. In-progress streaming is lost; history is reloaded from disk.

**Impact:** No loss of access. The client reattaches to a fresh agent that reloads the same session. The only loss is transient streaming state (the in-flight assistant message that hadn't been persisted to the .jsonl yet). This is inherent to crash recovery and is acceptable.

**Evidence:** `getLiveSessionsForCwd` returns a snapshot; the client only uses `sessionPath` (`App.tsx:466` `if (live?.sessionPath) sessionPath = live.sessionPath;`). The WS open path (`index.ts:2541`) calls `getOrCreateAgent` which creates-if-missing. `SDKAgent.start()` (`pi-agent.ts:870-892`) opens the existing session file.

**Fix:** None needed. This is correct behavior — the recovery contract is "reattach to the session, not to the streaming state."

---

### [LOW] Server restart loses all in-memory pool state — no persisted reattach record (by design, confirmed)

**Location:** `packages/server/src/pi-agent.ts:497-503` (`agentPool` is a `Map`, in-memory), `index.ts:2784-2796` (`gracefulShutdown` stops all agents)

**Scenario:**
1. Server process crashes / is killed (SIGKILL, OOM, segfault) or restarts (deploy).
2. `gracefulShutdown` may not run (SIGKILL). All `PooledAgent` instances are gone. `agentPool` is empty.
3. All client WS connections die. Clients' `onclose` fires → reconnect timer starts.
4. Client reconnects. `getOrCreateAgent` finds empty pool → creates new agent → `SDKAgent.start()` → `SessionManager.open(sessionPath)` → reloads from disk.
5. If the session file was being actively written when the server died, the last .jsonl line may be truncated. `parseSessionSummaryFull` / `getSessionDetail` wrap each line in try/catch (`pi-sessions.ts:119`, `165`), so a truncated line is skipped — no crash, but the last message may be lost.

**Impact:** No permanent loss of access. The client reconnects to a fresh agent that reloads the same session from disk. The `#LIVE` comment at `pi-agent.ts:8-11` explicitly states "unless the app is restarted we do not lose access" — restart is out of scope by design. The `.jsonl` files on disk ARE the persisted record. `restoreLiveSession` (`App.tsx:425-471`) handles this via `sessionStorage` (fast path) or `/live-sessions` (empty after restart → falls back to `sessions.find(s => s.filePath === sessionPath)` at L461, which reads from disk).

**Evidence:** `agentPool` is `const agentPool = new Map<string, PooledAgent>();` (L501). No `Map` serialization on shutdown. `gracefulShutdown` (L2789-2795) calls `stopAllAgents()` which stops SDK sessions (flushing) but doesn't persist pool keys.

**Fix:** None needed — this is the documented contract. If persistence across restarts were desired, the pool keys could be written to `~/.pi-web/pool-state.json` on shutdown and restored on boot, but that adds complexity for a restart scenario that already recovers via disk.

---

### [LOW] `broadcastToProjectClients` / `PooledAgent.broadcast` / `sendToClients` skip dead sockets but don't remove them — gradual ghost accumulation

**Location:** `packages/server/src/pi-agent.ts:281-289` (`broadcast`), `291-298` (`sendToClients`), `547-556` (`broadcastToProjectClients`)

**Scenario:**
1. An agent has 3 clients. One client's WS died abnormally (see MEDIUM ghost-entry finding above) — `readyState` is `CLOSING` or `CLOSED` but still in `clients`.
2. `broadcast` iterates `this.clients`, checks `ws.readyState === 1`, skips the dead one, continues. No throw.
3. The dead WS is never removed from `clients`. Over time, `clients` accumulates dead sockets.
4. `clients.size` is inflated → `maybeStartIdleTimer` thinks there are clients → agent never reaps.

**Impact:** Same as the ghost-entry finding — resource leak, not a loss of access. The broadcasts themselves are safe (try/catch + readyState guard).

**Evidence:**
```ts
// pi-agent.ts:281-289
private broadcast(msg: WSServerMessage) {
  const data = JSON.stringify(msg);
  for (const ws of this.clients) {
    try {
      if (ws.readyState === 1) ws.send(data);
    } catch {}
    // ↑ dead ws is skipped but NOT removed from this.clients
  }
}
```

**Fix:** Remove dead sockets during broadcast (piggyback on the existing iteration):
```ts
private broadcast(msg: WSServerMessage) {
  const data = JSON.stringify(msg);
  for (const ws of this.clients) {
    if (ws.readyState !== 1) { this.clients.delete(ws); continue; } // ponytail: prune dead sockets
    try { ws.send(data); } catch { this.clients.delete(ws); }
  }
}
```
Same for `sendToClients`. This partially mitigates the MEDIUM ghost-entry finding without needing the `onError` handler.

---

## What IS robust (invariants that hold)

1. **`wsToAgent.delete(raw)` in `onClose` (L2686):** Always called for any close that fires. The `onClose` handler unconditionally deletes from `wsToAgent` before detaching. Even if `agentKey` is undefined (WS closed before `wsToAgent.set`), `wsToAgent.delete(raw)` is a no-op. Safe.

2. **`setRekeyHandler` closure correctness (L2549-2551):** The handler scans ALL of `wsToAgent` for entries matching `oldKey` and updates them. It's set on every `onOpen` (overwriting the previous), but since every closure does the same module-level scan, it doesn't matter which one runs. A WS that opened AFTER rekey (with the new key already in `wsToAgent`) is unaffected — the scan only touches entries where `k === oldKey`.

3. **`getOrCreateAgent` reverse lookup by `originalNewSessionId` (L611-619):** A client whose WS dropped before it processed the rekey reconnects with the original `newSessionId`. The scan finds the rekeyed agent by its `originalNewSessionId` field (L94, captured at construction). This closes the "rekey happened, wsToAgent not synced" race for the new-session path. Correct.

4. **`onMessage` silent-drop when `lookupAgent(agentKey) === null` (L2588):** This happens when the agent was force-stopped (watchdog), deleted (project removal), or the key was rekeyed but `wsToAgent` points at the old key (shouldn't happen due to `setRekeyHandler`, but if it did). The drop is silent, BUT the exit handler (`pi-agent.ts:138-154`) closes all clients via `closeClients()`, which fires the client's `onclose` → reconnect. So the silent drop is transient — the client reconnects and either reattaches to a surviving agent or spawns a fresh one. The only risk is if `closeClients` didn't fire (see MEDIUM ghost finding).

5. **`start()` failure path (L2569-2573):** Correctly detaches, deletes from `wsToAgent`, deletes from pool, sends error, closes WS. The client's `onclose` fires → reconnect. `deleteFromPool` stops the agent, so a reconnect won't reuse the dead entry. The client reconnects and `getOrCreateAgent` creates a fresh agent. No infinite loop on the same key because the key was deleted. If the project is genuinely broken (e.g. SDK can't init), the client will loop reconnecting — but that's a real error, not a stuck state.

6. **Concurrent `new_session` with same `newSessionId`:** The client generates a fresh `uuidV4()` per new-session action (`App.tsx:611`). Two tabs clicking "new chat" get different UUIDs → different pool keys → two agents. If somehow the same UUID were reused (e.g. client bug), `getOrCreateAgent` would find the existing `__new__:<uuid>` key and reuse the agent (L598-601). No duplicate agents. Safe.

7. **Spawned `pi` CLI processes (L1159, L1883, L1945, L2002):** All four `Bun.spawn` sites are one-shot CLI commands (generate-commit-message, install/uninstall extension, `pkill` external PI). Each awaits `proc.exited` with a timeout that `proc.kill()`s on expiry. They do NOT create pooled agents — the pool is driven by the in-process SDK (`SDKAgent`), not subprocesses. No spawn can leak a session the pool manages. The `killExternalPiProcesses` (L1996-2016) is a blunt `pkill -x pi` — it kills external PI processes but not the in-process SDK agents (those are stopped via `stopAllAgents`). Safe.

8. **Terminal WS path (L2465-2518):** Terminals are independent of the agent pool. `wsToTerminal` is set on open, deleted on close (`onClose` L2510-2514). Terminal instances (`pi-terminal.ts`) have NO idle timer — they persist until `killTerminal` or the PTY exits (`onExit` deletes from the `terminals` Map at L47). A terminal leak does NOT keep an agent "attached" — agents and terminals are separate systems. A leaked terminal holds a PTY process, not an agent session. The agent's `clients` Set only contains chat WS clients, not terminal WS clients. Safe.

9. **`stopAgentsForCwd` on project removal (L295-298):** Correctly matches the `${cwd}::` prefix (not bare `cwd`). Stops all agents for the project. The comment at L295-298 documents the previous bug (bare `cwd` matched nothing). Current code is correct.

10. **`validateSessionPath` (L90-114):** Resolves symlinks via `realpathSync` on both the path and the roots, checks `isInside`, rejects directories. Roots are `~/.pi/agent/sessions` + `<project>/.pi/sessions`, matching where PI actually stores sessions (`pi-sessions.ts:64-68`). A legit session path is accepted. A crafted traversal (`../../etc/passwd`) is rejected because `realpathSync` resolves it outside the roots. The `isInside` function (L62-68) correctly handles the `relative` empty-string case (returns `true` for `child === parent`). Safe for reattach — the REST endpoints that validate never reject a legit session.

11. **`deleteFromPool` stops the agent (L668-679):** The `#REATTACH` comment documents the previous bug (only removed the pool entry without stopping). Now it calls `agent.stop()` fire-and-forget, which triggers the exit handler → `closeClients` + `agentPool.delete`. A reconnect won't reuse a dead entry. Correct.

12. **`rekeyAgent` (L700-716):** Refuses to clobber a different agent at `newKey` (returns null if `agentPool.has(newKey)`). The caller (`rekeyToSessionPath`, L373-380) checks the return and only fires the rekey handler if the move succeeded. No double-mapping.

---

## EXHAUSTIVE CHECKLIST

| # | Reattach / Recovery Path | Status | Evidence |
|---|--------------------------|--------|----------|
| 1 | Normal WS disconnect → `onClose` → `wsToAgent.delete` + `detachFromAgent` | ✅ Safe | `index.ts:2684-2700` |
| 2 | WS reconnect with same `sessionPath` → `getOrCreateAgent` reuses | ✅ Safe | `pi-agent.ts:598-601` |
| 3 | New-session rekey → `setRekeyHandler` syncs `wsToAgent` | ✅ Safe | `index.ts:2549-2551`, `pi-agent.ts:373-380` |
| 4 | Reconnect with stale `newSessionId` after rekey → reverse lookup | ✅ Safe | `pi-agent.ts:611-619` |
| 5 | `start()` failure → detach + delete + close WS → client reconnects | ✅ Safe | `index.ts:2569-2573` |
| 6 | `onOpen` fatal throw (non-start) → **WS left open, no close** | ⚠️ HIGH | `index.ts:2577-2580` — see finding |
| 7 | Agent exit (PI crash) → `closeClients` → client `onclose` → reconnect | ✅ Safe | `pi-agent.ts:138-154` |
| 8 | Watchdog force-stop (stale streaming, no clients) | ✅ Safe | `pi-agent.ts:466-498` (no clients to close) |
| 9 | Idle timeout → `agent.stop()` → exit handler → `closeClients` + delete | ✅ Safe | `pi-agent.ts:435-448` |
| 10 | Project deletion → `stopAgentsForCwd` stops all `${cwd}::` agents | ✅ Safe | `index.ts:295-298`, `pi-agent.ts:682-694` |
| 11 | Server graceful shutdown → `stopAllAgents` (3s timeout) | ✅ Safe | `index.ts:2789-2795` |
| 12 | Server crash (SIGKILL) → pool lost, client reloads from disk | ✅ Safe (by design) | `.jsonl` files persist; `App.tsx:461` disk fallback |
| 13 | Hard refresh, `sessionStorage` wiped → `/live-sessions` endpoint | ✅ Safe | `index.ts:413-422`, `App.tsx:463-468` |
| 14 | `/live-sessions` TOCTOU (agent reaped between snapshot and WS open) | ✅ Safe (fresh agent) | `getOrCreateAgent` creates-if-missing; SDK reloads from disk |
| 15 | Two sessions same cwd → `/live-sessions` returns both, client picks `[0]` | ✅ Safe | Pool keys unique by `sessionPath`; snapshots include distinct `sessionPath` |
| 16 | `onMessage` with `lookupAgent()==null` (agent gone) → silent drop | ✅ Safe (transient) | Exit handler closes clients → reconnect; see finding #6 for the exception |
| 17 | Abnormal WS error (RST/TLS) with no `onClose` → ghost in `wsToAgent` + `clients` | ⚠️ MEDIUM | Hono adapter has no `onError`; see finding |
| 18 | `load_session` / `switch_session` WS messages — no path validation | ⚠️ MEDIUM | `index.ts:2607-2608`; see finding |
| 19 | Terminal WS leak → keeps agent alive? | ✅ Safe (separate) | Terminals don't touch `agent.clients`; `pi-terminal.ts` is independent |
| 20 | `broadcastToProjectClients` throws → crashes request? | ✅ Safe | `sendToClients` wraps each `ws.send` in try/catch; `pi-agent.ts:291-298` |
| 21 | `validateSessionPath` rejects legit session → can't reattach? | ✅ Safe | Roots match PI's actual session dirs; realpath handles symlinks |
| 22 | Concurrent new-session race (same `newSessionId`) → two agents? | ✅ Safe | `getOrCreateAgent` deduplicates by key; client uses fresh UUID per action |
| 23 | `restartWithSession` orphans agent from pool | ⚠️ MEDIUM (dead code) | `pi-agent.ts:223-243`; see finding |
| 24 | `rekeyAgent` clobbers existing agent at `newKey`? | ✅ Safe | Returns null if `agentPool.has(newKey)`; `pi-agent.ts:708` |
| 25 | Spawned `pi` CLI process leaks a pooled session? | ✅ Safe | All spawns are one-shot CLI commands, not pooled agents |
| 26 | `broadcast` / `sendToClients` skip dead sockets but don't prune | ⚠️ LOW (leak) | `pi-agent.ts:281-298`; see finding |

---

## Summary

**Bar = ZERO unhandled edge cases.** Two actionable findings remain:

1. **HIGH:** `onOpen` fatal-catch doesn't `ws.close()` — client hangs on a dead open WS. One-line fix.
2. **MEDIUM:** WS `load_session`/`switch_session` skip `validateSessionPath` — inconsistent trust boundary vs REST.

Three lower-severity items (ghost entries from missing `onError`, dead-code `restartWithSession`, broadcast not pruning dead sockets) are resource-leak risks, not reattach-loss bugs. The core reattach/recovery flow — `getOrCreateAgent` reverse lookup, `setRekeyHandler` sync, idle/watchdog reaping, `/live-sessions` endpoint, disk-fallback on restart — is robust. The invariants that hold (documented above) cover every path where a client can legitimately reconnect to a live session.
