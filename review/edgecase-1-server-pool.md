# Adversarial Edge-Case Review: Server-Side Session Pool & Process Lifecycle (Layer 1)

**Date:** 2026-06-22
**Reviewer:** adversarial edge-case review subagent
**Scope:** `packages/server/src/pi-agent.ts` (1461 lines), `packages/server/src/index.ts` (WS handler ~2475–2830), `packages/server/src/pi-sessions.ts`, `packages/server/src/pi-agent.test.ts` (793 lines)
**Prior review:** `review/1-server-pool-reattach.md` (2026-06-21) — 13 findings (F1–F13). This review re-verifies each against the current code and finds what it missed.

---

## Re-verification of prior findings

| Prior | Status | Evidence |
|-------|--------|----------|
| F1 (silent rekey failure) | **FIXED** | `pi-agent.ts:340–344` — `rekeyToSessionPath` now has an `else` branch that logs + broadcasts an error when `rekeyAgent` returns null. |
| F2 (stale `originalNewSessionId`) | **FIXED** | `pi-agent.ts:349–354` — `session_loaded` handler now sets `this.originalNewSessionId = null`. Field is no longer `readonly` (`pi-agent.ts:106`). |
| F3 (`restartWithSession` broken) | **FIXED** | `pi-agent.ts:233–237` — method removed entirely. Comment explains why. |
| F4 (watchdog TOCTOU) | **PARTIALLY FIXED** | `pi-agent.ts:516–524` — `forceStopAndRemove` now deletes the pool entry BEFORE `await this.agent.stop()`. **But the identical race in the idle timer was NOT fixed** — see E1 below. |
| F5 (negative env values) | **FIXED** | `pi-agent.ts:29, 33` — `Math.max(1000, ...)` clamp applied. |
| F6 (messages dropped during startup) | **STILL PRESENT** | `pi-agent.ts:1054–1057` — `doSend` still silently returns when `!this.session \|\| !this.runtime`. See E5. |
| F7 (restartWithSession exit handler missing cleanup) | **FIXED** | Method removed. |
| F8 (isPendingNewSession set false before rekey) | **PARTIALLY FIXED** | Error is now surfaced (F1 fix), but `isPendingNewSession` is still set to `false` BEFORE the rekey attempt (`pi-agent.ts:321`). If rekey fails, the flag is already false and no future state event will retry. See E2. |
| F9 (clone poll after exit) | **FIXED** | `pi-agent.ts:156` — exit handler now sets `this.isPendingCloneRekey = false`. |
| F10 (`indexOf` vs `lastIndexOf`) | **FIXED** | `pi-agent.ts:622` — uses `lastIndexOf`. |
| F11 (`::` in cwd) | **STILL PRESENT** | `pi-agent.ts:538–548` — `agentKeyCwd` still splits on `::`. Acknowledged as unlikely; no fix applied. |
| F12 (spurious error broadcast on clean stop) | **FIXED** | `pi-agent.ts:146` — exit handler now checks `if (code !== 0)` before broadcasting. |
| F13 (double-stop) | **FIXED** | `pi-agent.ts:1078–1080` — `stopPromise` dedup added. |

---

## New findings

### [HIGH] E1 — Idle timer TOCTOU: same race as F4 but in the idle-timer path (NOT fixed)

**Location:** `pi-agent.ts:458–471` (idle timer callback), compare with `pi-agent.ts:516–524` (`forceStopAndRemove`, which WAS fixed)

**Trigger:**
1. Agent is idle (no clients, not streaming, no running tools). Idle timer is armed.
2. Idle timer fires after `IDLE_TIMEOUT_MS` (default 1 hour). The `setTimeout` callback checks `this.clients.size === 0 && !this.isActive()` → true (synchronous check passes).
3. `await this.agent.stop()` → enters `SDKAgent._stop()` (`pi-agent.ts:1083`): unsubscribes (sync), then `await this.runtime.dispose()` → **YIELDS** to the event loop.
4. During the yield (runtime.dispose() involves I/O — flushing session files): a client reconnects. `getOrCreateAgent(cwd, sessionPath)` → finds the agent **still in the pool** (the idle timer did NOT delete the pool entry before the await) → `agent.attach(ws)` → `this.clients.add(ws)`, `cancelIdleTimer()` (no-op, timer already fired), `setTimeout(getState, 100)`, replays `pendingDialog`.
5. `runtime.dispose()` completes. `_stop()` continues: `this.runtime = null`, `this.session = null`, `this.started = false`, `this.onExit?.(0)`.
6. Exit handler fires (`pi-agent.ts:143–157`): `closeClients()` → **closes the just-attached client**, `agentPool.delete(this.agentKey)`.
7. Idle timer callback continues: `agentPool.delete(this.agentKey)` (no-op, already deleted).
8. Client's WS was closed → `onclose` fires → client reconnects → `getOrCreateAgent` → agent not in pool → creates a **fresh** agent → loads session from disk. **In-memory state lost.**

**Why it severs reconnect to a LIVE session:** The user reconnects to a still-running agent (it hasn't been stopped yet — `runtime.dispose()` is in progress), attaches, and immediately gets kicked by the exit handler. The live in-memory state (unflushed messages, running tools, pending dialogs) is lost. A fresh agent is spawned from disk.

**Evidence:**
```typescript
// pi-agent.ts:458-471 — idle timer: pool entry NOT deleted before await
this.idleTimer = setTimeout(async () => {
    try {
        if (this.clients.size === 0 && !this.isActive()) {
            console.log(`[pool] agent ${this.agentKey} idle timeout, stopping`);
            await this.agent.stop();              // <-- YIELDS; client can attach during this
            agentPool.delete(this.agentKey);      // <-- pool entry still present during the await
        }
    } catch (err: any) {
        console.error(`[pool] idle stop error for ${this.agentKey}:`, err.message);
        agentPool.delete(this.agentKey);
    }
}, this.idleTimeoutMs);

// CONTRAST with forceStopAndRemove (pi-agent.ts:516-524) — F4 fix applied here:
private async forceStopAndRemove() {
    this.cancelWatchdog();
    this.cancelIdleTimer();
    agentPool.delete(this.agentKey);   // <-- DELETE FIRST (the F4 fix)
    this.closeClients();
    try { await this.agent.stop(); } catch ...
}
```

**Handled?** NO. The F4 fix was applied to `forceStopAndRemove` but NOT to the idle timer path. The idle timer is the **more common** reaping path (fires after 1 hour of idle vs 15 minutes of stale streaming).

**Fix direction:** Apply the same pattern as `forceStopAndRemove`: delete the pool entry and close clients BEFORE the `await this.agent.stop()`:
```typescript
this.idleTimer = setTimeout(async () => {
    if (this.clients.size === 0 && !this.isActive()) return;
    agentPool.delete(this.agentKey);   // remove FIRST
    this.closeClients();
    try { await this.agent.stop(); } catch ...
}, this.idleTimeoutMs);
```
Or better: extract a shared `stopAndRemove()` method used by both the idle timer and the watchdog.

**Confidence:** HIGH — structurally identical to the verified F4 race. The timing window is the duration of `runtime.dispose()` (I/O). Probability depends on how long dispose takes and whether a reconnect happens during that exact window.

---

### [MEDIUM] E2 — `isPendingNewSession` set to `false` BEFORE rekey attempt: if rekey fails, the agent is permanently stranded at `__new__:uuid` with no retry path

**Location:** `pi-agent.ts:320–327` (state handler), `pi-agent.ts:370–384` (`rekeyToSessionPath`)

**Trigger:**
1. Agent A exists at `/cwd::/session-X.json` (opened by path).
2. Agent B is created as a new session: `/cwd::__new__:uuid-B`. `isPendingNewSession = true`.
3. Agent B's PI resolves its sessionFile to `/session-X.json` (SDK generates the same path, or the user pre-created the file, or two new sessions resolve to the same generated name).
4. A `state` event arrives with `sessionFile: "/session-X.json"`. `isPendingNewSession && sessionFile` → true.
5. `this.isPendingNewSession = false` is set **BEFORE** the rekey (`pi-agent.ts:321`).
6. `rekeyToSessionPath(cwd, "/session-X.json")` → `rekeyAgent("/cwd::__new__:uuid-B", "/cwd::/session-X.json")` → `agentPool.has(newKey)` is true (agent A) → returns null → rekey fails.
7. Error is now logged and broadcast (F1 fix). But `isPendingNewSession` is already `false`. No future `state` event will trigger a rekey (the `if (this.isPendingNewSession && sessionFile)` guard is now false).
8. Agent B is stranded at `/cwd::__new__:uuid-B` with `isPendingNewSession = false`. It can only be found via `originalNewSessionId` reverse lookup — but if a `session_loaded` fires later (from a switch), `originalNewSessionId` is cleared (`pi-agent.ts:354`), making the agent completely undiscoverable.

**Why it severs reconnect:** A reconnect by path `/session-X.json` finds agent A (which may be a different session or idle). Agent B is orphaned at the `__new__` key and will eventually idle out. If the user was interacting with agent B, their session is lost.

**Evidence:**
```typescript
// pi-agent.ts:320-327
if (this.isPendingNewSession && sessionFile) {
    this.isPendingNewSession = false;           // set false BEFORE rekey
    this.rekeyToSessionPath(cwd, sessionFile);  // may fail — no retry possible
    projectSessionsChangedHandler?.(cwd);
}
```

**Handled?** PARTIAL. The F1 fix surfaces the error (log + broadcast), but the agent is still stranded. The prior review (F8) suggested only setting `isPendingNewSession = false` on success. This has NOT been applied.

**Fix direction:** Only clear `isPendingNewSession` if the rekey succeeds:
```typescript
if (this.isPendingNewSession && sessionFile) {
    const oldKey = this.agentKey;
    const newKey = buildAgentKey(cwd, sessionFile);
    if (newKey !== oldKey && rekeyAgent(oldKey, newKey)) {
        this.isPendingNewSession = false;
        this.rekeyHandler?.(oldKey, newKey);
        projectSessionsChangedHandler?.(cwd);
    } else if (newKey === oldKey) {
        this.isPendingNewSession = false;
    }
    // else: rekey failed — keep isPendingNewSession true for retry on next state event
}
```

**Confidence:** HIGH — verified the code path. Trigger requires a session-path collision (unlikely but structurally real).

---

### [MEDIUM] E3 — `new_session` RPC does not emit `session_loaded`: agent may be keyed under the wrong session's path

**Location:** `pi-agent.ts:1346–1351` (new_session handler — no `session_loaded` emission), compare with `pi-agent.ts:1352–1365` (load_session/switch_session — DOES emit), `index.ts:2577–2579` (onOpen sends `new_session` after `start()`)

**Trigger:**
1. Client opens a new session → `getOrCreateAgent(cwd, null, "uuid-A")` → agent at `/cwd::__new__:uuid-A`, `isPendingNewSession = true`.
2. `await agent.start()` → `SDKAgent.start()` calls `SessionManager.create(cwd)` → creates session A → `bindSession(sessionA)` → `this.session = sessionA`.
3. `start()` completes → `setTimeout(() => this.agent.getState(), 300)` scheduled (`pi-agent.ts:173`).
4. `onOpen` sends `agent.send({ type: "new_session" })` (`index.ts:2578`) → `doSend` → `handleCommand` → `runtime.newSession()` (async, yields) → creates session B → `bindSession(sessionB)` → `this.session = sessionB`.
5. The 300ms `getState()` fires → `snapshotState()` returns **session B's** state (if `newSession()` completed) or **session A's** state (if it hasn't).
6. **If `getState()` fires before `newSession()` completes:** state event has `sessionFile: sessionA` → `isPendingNewSession` is true → rekey to `/cwd::sessionA.json` → `isPendingNewSession = false`. Then `newSession()` completes → session B is active → no more `getState()` → **no rekey to session B**. Agent is keyed under session A but running session B.
7. **If `newSession()` completes before 300ms:** state event has `sessionFile: sessionB` → rekey to `/cwd::sessionB.json` → correct. But this depends on `newSession()` being fast enough.

The `load_session`/`switch_session`/`clone` handlers all emit `session_loaded` after `bindSession`, which triggers a deterministic rekey. The `new_session` handler does NOT.

**Why it severs reconnect:** If the agent is keyed under session A but running session B, a reconnect by path `sessionB` spawns a **duplicate** agent (the real session B is orphaned under session A's key). A reconnect by path `sessionA` finds the agent but it's running session B — the user sees the wrong session.

**Evidence:**
```typescript
// pi-agent.ts:1346-1351 — new_session: NO session_loaded emission
case "new_session": {
    const result = await runtime.newSession();
    if (!result.cancelled) await this.bindSession(runtime.session);
    this.onMessage?.({ type: "response", command: "new_session", success: true, data: result });
    break;
}

// pi-agent.ts:1352-1365 — load_session/switch_session: DOES emit session_loaded
case "load_session":
case "switch_session": {
    const result = await runtime.switchSession(msg.sessionPath);
    if (!result.cancelled) {
        await this.bindSession(runtime.session);
        this.onMessage?.({
            type: "session_loaded",
            session: { filePath: runtime.session.sessionFile ?? msg.sessionPath } as any,
        });
    }
    ...
}
```

**Handled?** NO. The `new_session` handler relies on the `state`-event-driven rekey path, which races with the `newSession()` async completion. The other session-switching handlers emit `session_loaded` for deterministic rekey.

**Note:** `start()` also creates a session via `SessionManager.create(cwd)` when `sessionPath` is null. So `new_session` creates a **second** session (the first from `start()` is orphaned). This is wasteful but the rekey race is the real problem — not the orphaned session.

**Fix direction:** Emit `session_loaded` from the `new_session` handler (like `load_session`/`switch_session`/`clone`):
```typescript
case "new_session": {
    const result = await runtime.newSession();
    if (!result.cancelled) {
        await this.bindSession(runtime.session);
        if (runtime.session.sessionFile) {
            this.onMessage?.({ type: "session_loaded", session: { filePath: runtime.session.sessionFile } as any });
        }
    }
    this.onMessage?.({ type: "response", command: "new_session", success: true, data: result });
    break;
}
```
This ensures the rekey fires deterministically after `newSession()` completes, regardless of when `getState()` fires. The `session_loaded` handler also clears `originalNewSessionId` (`pi-agent.ts:354`), which is correct — the new session's `newSessionId` is stale after resolution.

**Confidence:** MEDIUM — the race depends on `runtime.newSession()` completion timing relative to the 300ms `getState()` timeout. If `newSession()` is always fast (< 300ms), the race never triggers. But there's no guarantee — `newSession()` involves filesystem I/O (creating a new `.jsonl` session file).

---

### [MEDIUM] E4 — Symlinked session path: WS onOpen uses raw `sessionPath` for pool key, but `load_session`/`switch_session` use `realpathSync`-resolved path — key mismatch prevents reattach

**Location:** `index.ts:2508` (WS query `sessionPath` — raw, no `realpath`), `index.ts:2613–2625` (`load_session`/`switch_session` use `validateSessionPath` → `realpathSync`), `pi-agent.ts:615–618` (`normalizeSessionPath` — only `path.normalize`, no `realpath`)

**Trigger:**
1. Session file `/home/user/project/.pi/sessions/abc.jsonl` is a symlink to `/home/user/.pi/agent/sessions/xyz.jsonl`.
2. Client connects with `sessionPath=/home/user/project/.pi/sessions/abc.jsonl` (the symlink path).
3. `getOrCreateAgent(cwd, "/home/user/project/.pi/sessions/abc.jsonl")` → `buildAgentKey` → `normalizeSessionPath` → `path.normalize` → key is `/cwd::/home/user/project/.pi/sessions/abc.jsonl`.
4. Agent starts. `SDKAgent.start()` → `SessionManager.open("/home/user/project/.pi/sessions/abc.jsonl")` → SDK resolves the symlink internally → session loaded.
5. A `state` event fires with `sessionFile: "/home/user/.pi/agent/sessions/xyz.jsonl"` (the real path).
6. `handleAgentMessage` → `isPendingNewSession` is false (session was opened by path, not new). But if `isPendingCloneRekey` is true (after a clone), or if `session_loaded` fires from a `switch_session`:
7. `rekeyToSessionPath(cwd, "/home/user/.pi/agent/sessions/xyz.jsonl")` → key becomes `/cwd::/home/user/.pi/agent/sessions/xyz.jsonl`.
8. Client's WS drops. Client reconnects with the ORIGINAL `sessionPath=/home/user/project/.pi/sessions/abc.jsonl` (the symlink path it was given).
9. `getOrCreateAgent(cwd, "/home/user/project/.pi/sessions/abc.jsonl")` → key `/cwd::/home/user/project/.pi/sessions/abc.jsonl` → **NOT in pool** (agent was rekeyed to the real path) → spawns a **duplicate** agent. The live session is orphaned.

Alternatively, even without a rekey: the WS onOpen passes the raw `sessionPath` to `getOrCreateAgent`, while `load_session`/`switch_session` pass `validateSessionPath(msg.sessionPath, cwd)` which calls `realpathSync`. If the client sends `load_session` with a symlink path, the `session_loaded` rekey uses the real path, but the WS connection was keyed by the symlink path. A WS reconnect uses the symlink path → key mismatch.

**Why it severs reconnect:** The pool key is derived from the raw `sessionPath` (no symlink resolution), but rekeys use the real path (from `validateSessionPath` or SDK-reported `sessionFile`). A reconnect with the original symlink path can't find the rekeyed agent.

**Evidence:**
```typescript
// index.ts:2508 — WS onOpen: raw sessionPath, no realpath
const sessionPath = c.req.query("sessionPath");
// index.ts:2541 — passed directly to getOrCreateAgent
const { agent, isNew } = getOrCreateAgent(cwd, sessionPath || null, ...);

// index.ts:2613-2614 — load_session: validateSessionPath → realpathSync
try { agent.loadSession(validateSessionPath(msg.sessionPath, cwd)); }

// pi-agent.ts:615-618 — normalizeSessionPath: only path.normalize, no realpath
function normalizeSessionPath(p: string): string {
    return normalize(p).replace(/\/+$/, "") || p;
}
```

**Handled?** NO. `normalizeSessionPath` does `path.normalize` (collapses `//`, `./`, `..`) but does NOT resolve symlinks (`realpath`). The WS onOpen path and the `validateSessionPath` path can diverge for symlinked session files.

**Fix direction:** Either (a) apply `realpathSync` in `normalizeSessionPath` (with a fallback to `normalize` if the file doesn't exist yet — for new sessions), or (b) validate+resolve the `sessionPath` in the WS onOpen handler before passing it to `getOrCreateAgent` (matching what `load_session`/`switch_session` already do). Option (b) is simpler and consistent with existing validation.

**Confidence:** MEDIUM — requires a symlinked session file, which is uncommon but valid on POSIX. The `~/.pi/agent/sessions/` directory is the canonical session root; symlinks into it from project-local `.pi/sessions/` are a supported pattern (the SDK's `SessionManager` follows symlinks).

---

### [MEDIUM] E5 — Messages from a second client are silently dropped if it connects before the first client's `agent.start()` completes

**Location:** `index.ts:2559` (onOpen awaits `agent.start()`), `pi-agent.ts:1054–1057` (`doSend` silently drops when `!this.session \|\| !this.runtime`), `pi-agent.ts:913–928` (`start()` is async, sets `this.session` inside `bindSession`)

**Trigger:**
1. WS1 connects for a new session → `getOrCreateAgent` → `isNew=true`. `agent.attach(raw1)`. `await agent.start()` yields at `await createAgentSessionRuntime(...)` (`pi-agent.ts:897`) or `await this.resolveInitialModel()` (`pi-agent.ts:902`) or `await this.bindSession(...)` (`pi-agent.ts:912`).
2. WS2 connects for the same session before `start()` completes → `getOrCreateAgent` → finds agent, `isNew=false`. `agent.attach(raw2)`. No `await start()` needed.
3. WS2's client sends `prompt`: `agent.send({ type: "prompt", ... })` → `SDKAgent.doSend` → `if (!this.session \|\| !this.runtime) return;` (`pi-agent.ts:1055`) → **message silently dropped**. No error response.
4. WS2's `attach` also scheduled `setTimeout(() => this.agent.getState(), 100)` — if `start()` takes >100ms, `getState()` is also dropped (same guard).
5. WS1's `start()` eventually completes. Its `setTimeout(() => this.agent.getState(), 300)` fires, broadcasting state to all clients. WS2 finally sees state after ~300ms.
6. But any prompt WS2 sent during the startup window is **permanently lost**. No error response, no acknowledgment.

**Why it severs reconnect:** Not a "lose live session" issue per se — it's a "lose user input" issue. But in a rapid-reconnect scenario (WS drops, client immediately reconnects while the agent is still starting from the first connection), the user's first prompt vanishes without trace, and they may believe the agent is unresponsive.

**Evidence:**
```typescript
// pi-agent.ts:1054-1057 — doSend silently drops
doSend(msg: unknown) {
    if (!this.session \|\| !this.runtime) {
        // Not started yet — commands are dropped. Callers await start() first.
        return;
    }
    ...
}

// index.ts:2559 — WS1 creates the agent, WS2 attaches (isNew=false, no start())
if (isNew) {
    try { await agent.start(); } catch ...  // yields here
}
```

**Handled?** NO. `doSend` returns silently. No error response is sent to the client.

**Fix direction:** In `doSend`, return an error response instead of silently dropping:
```typescript
doSend(msg: unknown) {
    if (!this.session \|\| !this.runtime) {
        this.onMessage?.({ type: "response", command: (msg as any)?.type ?? "unknown", success: false, error: "Agent not ready yet" });
        return;
    }
    ...
}
```
Or queue messages until the session is ready.

**Confidence:** HIGH — verified the code path. The window is the duration of `agent.start()` (SDK initialization, model resolution, extension binding — potentially seconds).

---

### [LOW] E6 — Stale `pendingDialog` replayed to a reconnecting client after the dialog was already answered

**Location:** `pi-agent.ts:297–303` (pendingDialog set on `extension_ui_request`), `pi-agent.ts:186–189` (replayed on `attach`), `pi-agent.ts:1086–1092` (`_stop` rejects pendingDialogs), `pi-agent.ts:1356` (`extension_ui_response` resolves the dialog but does NOT clear `pendingDialog`)

**Trigger:**
1. PI asks a blocking question (dialog D1). `handleAgentMessage` sets `this.pendingDialog = D1`.
2. Client A answers D1 → `extension_ui_response` → `SDKAgent.resolveDialogResponse` → resolves the dialog promise → PI continues. But `PooledAgent.pendingDialog` is **still set to D1** — it's only cleared on `agent_end` (`pi-agent.ts:434`), exit (`pi-agent.ts:155`), stop (`pi-agent.ts:251`), or watchdog (`pi-agent.ts:484`).
3. Client A disconnects (refresh). PI is still running (past D1).
4. Client B reconnects → `attach(ws)` → replays `pendingDialog` (D1, already answered).
5. Client B sees D1 and thinks PI is waiting for an answer. PI is actually running normally.
6. If Client B answers D1, `resolveDialogResponse` doesn't find it in `pendingDialogs` (already deleted) → silently dropped. No harm, but confusing UX.

**Why it severs reconnect:** Doesn't sever the connection, but the client sees a stale dialog that's already been answered, which is confusing and may cause the user to think PI is wedged.

**Evidence:**
```typescript
// pi-agent.ts:297-303 — pendingDialog set, never cleared on response
if (msg.type === "extension_ui_request") {
    const method = (msg as any).ui?.method;
    if (["select", "confirm", "input", "editor"].includes(method)) {
        this.pendingDialog = msg;
    }
}

// pi-agent.ts:186-189 — replayed on attach
if (this.pendingDialog) {
    try { if (ws.readyState === 1) ws.send(JSON.stringify(this.pendingDialog)); } catch {}
}

// pi-agent.ts:1356 — extension_ui_response resolves the SDK dialog but NOT PooledAgent.pendingDialog
case "extension_ui_response":
    this.resolveDialogResponse(msg);
    break;
```

**Handled?** NO. `pendingDialog` is only cleared on `agent_end`/exit/stop/watchdog — not when the dialog is answered.

**Fix direction:** Clear `pendingDialog` when the matching `extension_ui_response` is received. Route the response through `PooledAgent` (not just `SDKAgent`):
```typescript
// In PooledAgent.send() or a new method:
send(msg: unknown) {
    if ((msg as any).type === "extension_ui_response") {
        const id = (msg as any).id;
        if (this.pendingDialog && (this.pendingDialog as any).ui?.id === id) {
            this.pendingDialog = null;
        }
    }
    this.agent.doSend(msg);
}
```

**Confidence:** HIGH — verified the code path. The dialog is always stale after being answered until the next `agent_end`.

---

### [LOW] E7 — `broadcastToProjectClients` prefix matching: a project path that is a prefix of another project's path causes cross-project broadcast leakage

**Location:** `pi-agent.ts:541–551` (`broadcastToProjectClients`), `pi-agent.ts:684–695` (`stopAgentsForCwd`), `pi-agent.ts:580–591` (`getLiveSessionsForCwd`)

**Trigger:**
1. Two projects: `/home/user/proj` and `/home/user/project`.
2. `broadcastToProjectClients("/home/user/proj", msg)` → prefix is `/home/user/proj::`.
3. An agent for `/home/user/project` has key `/home/user/project::/session.json`.
4. `"/home/user/project::/session.json".startsWith("/home/user/proj::")` → **true**! (Because `/home/user/proj::` is a prefix of `/home/user/project::/session.json` — the `j` in `proj` is followed by `::`, and `project::/session.json` starts with `proj`... wait, no. `/home/user/proj::` is 20 chars. `/home/user/project::/session.json` starts with `/home/user/proje`, which does NOT start with `/home/user/proj::`. The 17th char is `e` vs `:`. So this is actually safe.)

Actually, let me re-verify: `prefix = "/home/user/proj::"`. Key = `/home/user/project::/session.json`. Does `key.startsWith(prefix)`? `prefix` is `/home/user/proj::` (20 chars). `key` starts with `/home/user/proje` (18 chars). The 18th char of `key` is `e`, the 18th char of `prefix` is `:`. So `startsWith` returns false. **This is safe.**

The `::` suffix on the prefix prevents prefix-matching a shorter cwd against a longer one, because `::` can't appear in the middle of a path segment (it would have to be `proj::` vs `project::`, and `project::` doesn't start with `proj::`).

**Handled?** YES — the `::` suffix on the prefix naturally prevents this. The prior review's check #20 was correct.

**No finding — verified safe.** Including for completeness of the audit.

---

### [LOW] E8 — `stopAgentsForCwd` and `deleteFromPool` are fire-and-forget: if `agent.stop()` hangs on `runtime.dispose()`, the process lingers in the pool's closure but the entry is already deleted

**Location:** `pi-agent.ts:671–679` (`deleteFromPool`), `pi-agent.ts:684–695` (`stopAgentsForCwd`), `pi-agent.ts:1083–1101` (`_stop` — `await this.runtime.dispose()` has no timeout)

**Trigger:**
1. Project deletion calls `stopAgentsForCwd(cwd)`.
2. For each agent: `agentPool.delete(key)` (sync) + `agent.stop().catch(...)` (fire-and-forget).
3. `PooledAgent.stop()` → `await this.agent.stop()` → `SDKAgent._stop()` → `await this.runtime.dispose()`.
4. If `runtime.dispose()` hangs (SDK bug, stuck I/O), `agent.stop()` never resolves. The `.catch()` never fires (no rejection, just a hanging promise).
5. The pool entry is already deleted (step 2), so a reconnect spawns a fresh agent. No reattach issue.
6. But the old runtime's resources (file handles, subscriptions, SDK internals) leak. The `SDKAgent` instance stays in memory via the unresolved promise closure.

**Why it severs reconnect:** Doesn't sever reconnect directly — the pool entry is deleted before the stop. But the leaked resources may cause issues (file descriptor exhaustion, SDK state corruption) that affect other agents.

**Evidence:**
```typescript
// pi-agent.ts:671-679 — deleteFromPool: fire-and-forget stop
export function deleteFromPool(agentKey: string) {
    const agent = agentPool.get(agentKey);
    agentPool.delete(agentKey);
    if (agent) {
        agent.stop().catch((e) => console.error(...));
    }
}

// pi-agent.ts:1083-1101 — _stop: no timeout on runtime.dispose()
private async _stop(): Promise<void> {
    ...
    if (this.runtime) {
        try { await this.runtime.dispose(); } catch ...  // <-- can hang forever
    }
    ...
}
```

**Handled?** PARTIAL. `gracefulShutdown` wraps `stopAllAgents` in a `Promise.race` with a 3-second timeout (`index.ts:2813`). But `deleteFromPool` and `stopAgentsForCwd` have no timeout — they're fire-and-forget.

**Fix direction:** Add a timeout to `PooledAgent.stop()`:
```typescript
async stop() {
    this.cancelIdleTimer();
    this.cancelWatchdog();
    this.pendingDialog = null;
    await Promise.race([
        this.agent.stop(),
        new Promise(r => setTimeout(r, 5000)),
    ]);
    agentPool.delete(this.agentKey);
}
```

**Confidence:** MEDIUM — requires `runtime.dispose()` to hang, which is an SDK bug. The graceful shutdown path has a timeout; the fire-and-forget paths don't.

---

### [LOW] E9 — Server restart: all in-memory sessions are silently lost; no reattach path exists

**Location:** `pi-agent.ts:528` (`agentPool = new Map<>()` — module-level, in-memory), `index.ts:2810–2814` (graceful shutdown stops all agents), `index.ts:417–423` (live-sessions endpoint reads from pool — empty after restart)

**Trigger:**
1. Server is running with N live agents in the pool.
2. Server restarts (SIGTERM → graceful shutdown → `stopAllAgents()` → `process.exit(0)`).
3. After restart: `agentPool` is a fresh empty `Map`. No agents.
4. Client reconnects → `getOrCreateAgent` → not in pool → creates a fresh agent → `SessionManager.open(sessionPath)` → loads session from disk.
5. In-memory state (unflushed messages, running tools, pending dialogs) is lost. The session file on disk has whatever was flushed before shutdown (best-effort, 3-second timeout).

**Why it severs reconnect:** The session is NOT "still alive" after restart — the in-process SDK runtime is dead. This is by design (the comment at `pi-agent.ts:22` says "unless the app is restarted we do not lose access"). But there's no mechanism to detect that a session was live before restart and prioritize its recovery.

**Evidence:**
```typescript
// pi-agent.ts:528 — in-memory pool, wiped on restart
const agentPool = new Map<string, PooledAgent>();

// index.ts:2813 — graceful shutdown: stop all agents with 3s timeout
try { await Promise.race([stopAllAgents(), new Promise(r => setTimeout(r, 3000))]); } catch {}

// index.ts:417-423 — live-sessions endpoint: reads from pool (empty after restart)
app.get("/api/projects/:id/live-sessions", (c) => {
    const project = getProject(c.req.param("id"));
    if (!project) return c.json({ error: "Project not found" }, 404);
    const sessions = getLiveSessionsForCwd(project.path);
    return c.json({ sessions });
});
```

**Handled?** YES (by design). The `#LIVE` comments explicitly acknowledge this limitation: "unless the app is restarted we do not lose access." Graceful shutdown flushes sessions to disk (best-effort). After restart, sessions reload from disk. The SDK runs in-process (no orphaned subprocesses), so there are no zombie `pi` processes after a crash.

**Note:** If the server is killed with SIGKILL (OOM, crash), `stopAllAgents()` never runs. Session files may have truncated `.jsonl` lines (mid-write). A fresh agent loading the session would encounter parse errors on the truncated lines (handled by `try/catch` in `pi-sessions.ts:97`). Not a reattach issue — the session isn't alive.

**Confidence:** HIGH — verified by design. No fix needed unless persistent sessions across restarts are desired (would require a process supervisor or external session store).

---

### [LOW] E10 — `pendingDialog` not cleared when the dialog is answered via `extension_ui_response`: stale dialog replayed on reconnect

This is the same as E6 above. Deduplicated.

---

### [LOW] E11 — Process death vs stale pool entry: no liveness probe for the in-process SDK runtime

**Location:** `pi-agent.ts:143–157` (exit handler — relies on `SDKAgent.onExit`), `pi-agent.ts:1083–1101` (`_stop` calls `onExit?.(0)` — but only after `runtime.dispose()` completes)

**Trigger:**
1. The SDK runtime crashes or throws an unrecoverable error internally (not via the event system — e.g., a segfault in a native module, or an unhandled rejection inside the SDK that doesn't propagate to `onExit`).
2. `this.session` and `this.runtime` are still set (the SDK objects exist but are in a broken state).
3. No exit handler fires (the SDK didn't call `onExit`).
4. The agent stays in the pool with `streaming = true` (or `false` if the crash happened after `agent_end`).
5. If `streaming = true` and no clients: the watchdog eventually reaps it (after `STALE_STREAMING_MS`).
6. If `streaming = false` and no clients: the idle timer eventually reaps it (after `IDLE_TIMEOUT_MS`).
7. If a client is attached: the client sends messages. `doSend` → `handleCommand` → the SDK throws (broken state) → caught by `.catch()` → error response sent to client. The agent stays in the pool.

**Why it severs reconnect:** A broken SDK runtime that doesn't fire `onExit` stays in the pool. A reconnecting client attaches to it and gets error responses. The agent is "alive" in the pool but dead underneath — every send fails.

**Handled?** PARTIAL. The watchdog catches streaming-but-stale agents. The idle timer catches idle agents. But a broken agent with a client attached is not caught — the client gets error responses until it disconnects (then the watchdog/idle timer eventually reaps it). There's no health probe that checks "is the SDK runtime actually responsive?"

**Evidence:**
```typescript
// pi-agent.ts:143-157 — exit handler relies on SDKAgent calling onExit
this.agent.setExitHandler((code) => {
    console.log(`[pool] agent ${this.agentKey} exited (code ${code})`);
    if (code !== 0) this.broadcast({ type: "error", message: `PI agent exited (code ${code}).` });
    this.closeClients();
    this.pendingDialog = null;
    this.isPendingCloneRekey = false;
    this.cancelWatchdog();
    agentPool.delete(this.agentKey);
});

// pi-agent.ts:1100 — onExit is called at the END of _stop, after dispose
// If the SDK crashes BEFORE calling stop(), onExit never fires
```

**Fix direction:** Add a health probe to the watchdog: periodically call `session.isStreaming` (or similar) and if it throws, treat the agent as dead. Or wrap `handleCommand` with a failure counter — if N consecutive commands throw, force-stop the agent.

**Confidence:** LOW — speculative. Requires the SDK to enter a broken state without calling `onExit`. The `handleEvent` try/catch (`pi-agent.ts:1122`) and `handleCommand` catch (`pi-agent.ts:1060`) prevent most crashes from propagating, but a native crash or unhandled rejection inside the SDK could bypass them.

---

## Additional verified-safe paths

1. **Server restart orphans no `pi` processes** — The SDK runs in-process (`SDKAgent` wraps `AgentSession`/`AgentSessionRuntime`), not as subprocesses. When the Bun process exits, the SDK dies with it. No zombie processes. (`pi-agent.ts:725–730` comments confirm this architecture change.)

2. **`killExternalPiProcesses` does not kill the server** — Uses `pkill -x pi` (exact match on process name `pi`). The server process is `bun` (or `node`), not `pi`. Safe. (`index.ts:1998`)

3. **`stopAgentsForCwd` prefix matching is safe** — `${cwd}::` prefix doesn't match other projects (verified for `/home/user/proj` vs `/home/user/project` — the `::` suffix prevents partial prefix matches). (`pi-agent.ts:686`)

4. **`getLiveSessionsForCwd` excludes pending-new agents** — `getLiveSnapshot()` returns null when `session.sessionFile` is falsy (before resolution). (`pi-agent.ts:204–215`)

5. **`stopPromise` dedup prevents double-stop** — `SDKAgent.stop()` returns the in-flight `stopPromise` for concurrent callers. (`pi-agent.ts:1078–1080`)

6. **Exit handler deletes by CURRENT key** — `agentPool.delete(this.agentKey)` uses the live field, not a stale closure. (`pi-agent.ts:157`)

7. **`originalNewSessionId` cleared on session switch** — `session_loaded` handler sets `this.originalNewSessionId = null`. (`pi-agent.ts:354`)

8. **Pending dialog replayed on reconnect** — `attach()` replays `pendingDialog` to new client. (`pi-agent.ts:186–189`)

9. **Fire-and-forget UI events NOT replayed** — Only `select`/`confirm`/`input`/`editor` methods are tracked. (`pi-agent.ts:300–303`)

10. **Idle timer does not arm while streaming** — `isActive()` returns true → `maybeStartIdleTimer` returns early. (`pi-agent.ts:437–438`)

11. **Watchdog does not double-fire** — `forceStopAndRemove` cancels watchdog synchronously before first `await`. (`pi-agent.ts:517`)

12. **Graceful shutdown has 3s timeout** — `Promise.race` prevents hang. (`index.ts:2813`)

13. **`unhandledRejection`/`uncaughtException` handlers** — Log and keep running. (`index.ts:2820–2824`)

14. **`extractNewSessionId` uses `lastIndexOf`** — Safe for cwds containing `__new__:`. (`pi-agent.ts:622`)

15. **Rekey failure is surfaced** — `rekeyToSessionPath` logs + broadcasts error when target occupied. (`pi-agent.ts:380–384`)

16. **Negative env values clamped** — `Math.max(1000, ...)` prevents negative/zero timeouts. (`pi-agent.ts:29, 33`)

17. **Never-reaped dialog claim is FALSE** — Watchdog reaps streaming agents with no activity/clients after 15 min; idle timer reaps non-streaming agents after 1 hour. Either way, agents with pending dialogs ARE reaped. (`pi-agent.ts:476–491`, `pi-agent.ts:458–471`)

---

## Coverage gaps in tests

1. **No test for idle timer TOCTOU (E1)** — The test "stops the agent after the idle timeout when no clients and no activity" (`pi-agent.test.ts:138–157`) verifies that the idle timer fires and stops the agent, but does NOT test the race where a client attaches DURING `await this.agent.stop()`. The `FakeAgent.stop()` is synchronous (`async stop() { this.stopCalls++; }` — no yield), so the race can't reproduce. Need a `FakeAgent` with an async `stop()` that yields.

2. **No test for `isPendingNewSession` set false before rekey (E2)** — The test "rekey to an already-occupied key is refused" (`pi-agent.test.ts:328–342`) tests `rekeyAgent` directly, not the `handleAgentMessage` state path. No test drives a `state` event with a `sessionFile` that collides with an existing agent to verify the `isPendingNewSession` flag behavior.

3. **No test for `new_session` RPC rekey (E3)** — No test exercises the `new_session` command handler. The `FakeAgent.doSend()` is a no-op, so `handleCommand` never runs. No test verifies that the agent rekeys to the correct session after `new_session`.

4. **No test for symlinked session path key mismatch (E4)** — All tests use simple paths like `/s.json`, `/a.json`. No test uses symlinked paths or verifies that `normalizeSessionPath` + `realpathSync` produce the same key.

5. **No test for messages dropped during startup (E5)** — The test "a reconnecting client reattaches to the SAME running agent" (`pi-agent.test.ts:500–539`) tests reattach AFTER `start()` completes. No test sends a prompt during the `start()` window.

6. **No test for stale `pendingDialog` replay (E6)** — The test "a dialog that arrived while the client was away is replayed" (`pi-agent.test.ts:442–470`) tests replay BEFORE the dialog is answered. No test answers the dialog and then reconnects to verify the stale dialog is NOT replayed.

7. **No test for `runtime.dispose()` hanging (E8)** — `FakeAgent.stop()` is instant. No test simulates a hanging `dispose()`.

8. **No test for SDK crash without `onExit` (E11)** — All tests trigger exit via `fake.exitHandler!(code)`. No test simulates the SDK entering a broken state without calling `onExit`.

9. **No multi-tab test** — No test exercises two WS clients on the same agent simultaneously, verifying that one tab's detach doesn't affect the other. The prior review noted this as check #26 but it's not tested.

10. **No test for `new_session` creating a second session** — The `new_session` RPC is sent in `onOpen` (`index.ts:2578`) but no test verifies that the agent doesn't end up keyed under the wrong session.
