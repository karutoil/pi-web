# Adversarial Edge-Case Review: Server-Side Agent Pool & Reattach Logic

**Scope:** `packages/server/src/pi-agent.ts` (PooledAgent, agentPool, watchdog, idle timer, rekey, exit handler, getOrCreateAgent, rekeyAgent, etc.) and the WS lifecycle in `packages/server/src/index.ts`.

**Goal:** Find every edge case that could make us lose the ability to connect back to a LIVE PI session still genuinely running on the server.

**Date:** 2026-06-21  
**Reviewer:** adversarial review subagent  
**Files inspected:** `pi-agent.ts` (1426 lines), `pi-agent.test.ts`, `index.ts` (WS handler section), `plan.md` (not found), `progress.md`

---

## Findings

---

### [HIGH] F1 — `session_loaded` rekey to an occupied key silently fails, stranding the agent under a stale key while two runtimes run the same session file

**Location:** `pi-agent.ts:355–360` (handleAgentMessage, session_loaded branch) → `rekeyToSessionPath` at `pi-agent.ts:364–372` → `rekeyAgent` at `pi-agent.ts:700–712`

**Scenario:**
1. User opens session-A in tab 1 → `getOrCreateAgent(cwd, "/session-A.json")` → agent A created at key `/cwd::/session-A.json`.
2. User opens session-B in tab 2 → `getOrCreateAgent(cwd, "/session-B.json")` → agent B created at key `/cwd::/session-B.json`.
3. In tab 2, user triggers `switch_session` to `/session-A.json`. The SDK's `switchSession` runs in-process on agent B's runtime. Agent B's PI is now live on session-A.
4. The SDK emits `session_loaded` with `filePath: "/session-A.json"` (`pi-agent.ts:1303–1311` in SDKAgent.handleCommand).
5. `handleAgentMessage` calls `rekeyToSessionPath(cwd, "/session-A.json")` (`pi-agent.ts:359`).
6. `rekeyAgent("/cwd::/session-B.json", "/cwd::/session-A.json")` checks `agentPool.has(newKey)` → agent A is already at `/cwd::/session-A.json` → returns `null` (`pi-agent.ts:707`).
7. `rekeyToSessionPath` does NOT call the rekeyHandler, does NOT update `this.agentKey`, does NOT log a warning (`pi-agent.ts:370–371`). The failure is **silent**.

**Impact:** Agent B is now keyed at `/cwd::/session-B.json` but its PI runtime is live on session-A. Meanwhile agent A is also keyed at `/cwd::/session-A.json` with its own PI runtime on session-A. **Two in-process SDK runtimes are now bound to the same session file.** Any prompt sent to either agent writes to the same `.jsonl` — interleaved writes risk corrupting the session. A reconnect by path `/session-B.json` finds agent B running the *wrong* session (session-A), so the user sees session-A's content under session-B's identity. There is **no fallback mechanism** (unlike the new-session case, which has the `originalNewSessionId` reverse lookup) — the agent is permanently stranded.

**Evidence:**
```typescript
// pi-agent.ts:355-360
} else if (msg.type === "session_loaded") {
    const loadedPath = (msg as any).session?.filePath;
    if (loadedPath) this.rekeyToSessionPath(cwd, loadedPath);
    projectSessionsChangedHandler?.(wd);
}

// pi-agent.ts:364-372
private rekeyToSessionPath(cwd: string, sessionPath: string) {
    const oldKey = this.agentKey;
    const newKey = buildAgentKey(cwd, sessionPath);
    if (newKey === oldKey) return;
    if (rekeyAgent(oldKey, newKey)) {       // returns null if target occupied
        this.rekeyHandler?.(oldKey, newKey); // NOT called on failure
    }
    // No else branch — no logging, no error, no fallback
}

// pi-agent.ts:707
if (agentPool.has(newKey)) return null;    // silently refuses
```

**Fix:** In `rekeyToSessionPath`, handle the rekey failure explicitly:
```typescript
if (rekeyAgent(oldKey, newKey)) {
    this.rekeyHandler?.(oldKey, newKey);
} else {
    console.error(`[pool] rekey FAILED: ${oldKey} -> ${newKey} (target occupied). Agent stranded at ${oldKey}.`);
    this.broadcast({ type: "error", message: "Session switch conflict: another agent already holds the target session. Please reconnect." });
}
```
For a deeper fix: when the target key is occupied during a `session_loaded` rekey, stop the agent at the target key first (it's being superseded by the in-process switch), then rekey. Or refuse the `switch_session` command at the server level if another agent already holds the target path.

---

### [HIGH] F2 — `originalNewSessionId` is never cleared after a session switch, so a stale `newSessionId` reconnect can attach to an agent running a *different* session

**Location:** `pi-agent.ts:99` (field declaration), `pi-agent.ts:128` (set in constructor), `pi-agent.ts:627–634` (reverse lookup), `pi-agent.ts:355–360` (session_loaded rekey that doesn't clear it)

**Scenario:**
1. Client creates a new session with `newSessionId="uuid-A"`. Agent created at `/cwd::__new__:uuid-A`, `originalNewSessionId = "uuid-A"`.
2. PI resolves the session → agent rekeyed to `/cwd::/session-A.json`. `originalNewSessionId` is still `"uuid-A"` (it's `readonly`, never cleared).
3. The user switches session in-place (via `switch_session` to `/session-B.json`). Agent rekeyed to `/cwd::/session-B.json`. `originalNewSessionId` is **still** `"uuid-A"`.
4. A client whose WS dropped before step 2 reconnects with the original params: `sessionPath=null, newSessionId="uuid-A"` (e.g., from a bookmarked URL, a stale reconnect attempt, or the client's WS pool still keyed by the original newSessionId).
5. `getOrCreateAgent(cwd, null, "uuid-A")` → key `/cwd::__new__:uuid-A` not in pool → reverse lookup scans pool → finds this agent by `originalNewSessionId === "uuid-A"` (`pi-agent.ts:630`).
6. Client attaches to an agent running **session-B**, not the session-A they created.

**Impact:** The client sees the wrong session's content and may send prompts to it. Session-A's live state (if any in-memory unflushed data) is unreachable — a new agent would need to be created to load session-A from disk, losing any in-flight work. The user has no indication they're on the wrong session.

**Evidence:**
```typescript
// pi-agent.ts:99 — readonly, set once
readonly originalNewSessionId: string | null;

// pi-agent.ts:128 — set in constructor
this.originalNewSessionId = this.isPendingNewSession ? extractNewSessionId(agentKey) : null;

// pi-agent.ts:627-634 — reverse lookup uses it, never invalidated
if (!sessionPath && newSessionId) {
    for (const a of agentPool.values()) {
        if (a.originalNewSessionId === newSessionId) {
            console.log(`[pool] reattaching to rekeyed agent by newSessionId=${newSessionId} -> ${a.getKey()}`);
            return { agent: a, isNew: false };
        }
    }
}

// pi-agent.ts:355-360 — session_loaded rekeys but doesn't clear originalNewSessionId
} else if (msg.type === "session_loaded") {
    const loadedPath = (msg as any).session?.filePath;
    if (loadedPath) this.rekeyToSessionPath(cwd, loadedPath);
    // originalNewSessionId is NOT cleared here
```

**Fix:** Clear `originalNewSessionId` when the agent rekeys due to a session switch (not just new-session resolution). Since it's `readonly`, make it a regular `private` field:
```typescript
private originalNewSessionId: string | null;
// In rekeyToSessionPath, after a successful rekey that is NOT the initial new-session resolution:
// this.originalNewSessionId = null;  // only clear on session_loaded / clone rekeys
```
Or more simply: only match in the reverse lookup if the agent's current key is still a `__new__` key (i.e., the rekey hasn't happened yet):
```typescript
if (a.originalNewSessionId === newSessionId && a.getKey().includes("__new__:")) {
```
But this would break the intended #REATTACH behavior (reconnecting after the initial rekey). The correct fix is to clear `originalNewSessionId` specifically when a `session_loaded` or clone rekey occurs, since at that point the original newSessionId is semantically stale.

---

### [HIGH] F3 — `restartWithSession` calls `this.agent.stop()` which fires the exit handler, deleting the pool entry and closing all clients — defeating the restart

**Location:** `pi-agent.ts:223–239` (restartWithSession), `pi-agent.ts:102–154` (constructor exit handler), `pi-agent.ts:1049–1058` (SDKAgent.stop → onExit)

**Scenario:**
1. Any code path calls `agent.restartWithSession("/new-path.json")`.
2. `restartWithSession` calls `await this.agent.stop()` (`pi-agent.ts:225`).
3. Inside `SDKAgent.stop()`, after `await this.runtime.dispose()`, `this.onExit?.(0)` is called unconditionally (`pi-agent.ts:1058`). `explicitlyStopped` is set (`pi-agent.ts:1042`) but **never checked** anywhere in the codebase.
4. The exit handler (set in the constructor at `pi-agent.ts:102–153`) fires: `this.broadcast(...)` sends "PI agent exited (code 0)" to all clients, `this.closeClients()` clears the client set, `this.cancelWatchdog()`, `agentPool.delete(this.agentKey)`.
5. `restartWithSession` creates a new inner agent and starts it (`pi-agent.ts:226–237`). But the pool entry is already deleted, and all clients are already closed. The new agent runs with **no clients** and **no pool entry** — it's an orphan.

**Impact:** If `restartWithSession` is ever called, the agent becomes unreachable. A reconnect would create a new agent (the old one is not in the pool), orphaning the restarted PI process. This is the "server requires a reboot" failure mode.

**Note:** `restartWithSession` is currently **dead code** — it is defined but never called from `index.ts` or any test. The method exists as a public API with a doc comment ("Use `restartWithSession` for stale-extension-ctx recovery"), so it could be revived. If it is, it would be broken.

**Evidence:**
```typescript
// pi-agent.ts:223-225
async restartWithSession(sessionPath: string): Promise<void> {
    this.cancelIdleTimer();
    await this.agent.stop();  // <-- triggers onExit(0) via SDKAgent.stop()

// pi-agent.ts:1049-1058 (SDKAgent.stop)
async stop(): Promise<void> {
    this.explicitlyStopped = true;  // set but never read
    ...
    this.onExit?.(0);  // ALWAYS fires

// pi-agent.ts:102-154 (constructor exit handler)
this.agent.setExitHandler((code) => {
    ...
    this.closeClients();         // clears all clients
    ...
    agentPool.delete(this.agentKey);  // removes pool entry
});
```

**Fix:** In `restartWithSession`, detach the exit handler before stopping the old agent, or set a flag that suppresses the exit handler during restart:
```typescript
async restartWithSession(sessionPath: string): Promise<void> {
    this.cancelIdleTimer();
    this.cancelWatchdog();
    // Suppress the exit handler during the deliberate stop
    this.agent.setExitHandler(() => {});  // no-op: don't close clients / delete pool
    await this.agent.stop();
    const opts = this.agent.getOptions();
    this.agent = this.createAgent({ cwd: opts.cwd, sessionPath, provider: opts.provider, model: opts.model });
    this.agent.setHandler((msg) => this.handleAgentMessage(msg));
    this.agent.setExitHandler((code) => { /* full cleanup */ });
    await this.agent.start();
    setTimeout(() => this.agent.getState(), 200);
}
```
Alternatively, remove this dead method entirely (YAGNI).

---

### [MEDIUM] F4 — Watchdog TOCTOU: a client reconnecting during `forceStopAndRemove`'s `await this.agent.stop()` briefly attaches then gets kicked by the exit handler

**Location:** `pi-agent.ts:475–490` (startWatchdog), `pi-agent.ts:497–506` (forceStopAndRemove), `pi-agent.ts:102–154` (exit handler → closeClients)

**Scenario:**
1. Agent is streaming, no clients, has been silent for > `STALE_STREAMING_MS`. Watchdog tick fires: `stale && clients.size === 0 && isActive()` → calls `forceStopAndRemove()`.
2. `forceStopAndRemove` calls `cancelWatchdog()`, `cancelIdleTimer()`, then `await this.agent.stop()` (`pi-agent.ts:502`). Control yields at `await this.runtime.dispose()` inside SDKAgent.stop() (`pi-agent.ts:1053`).
3. During this yield, a client reconnects: `getOrCreateAgent` → finds the agent (still in pool, not yet deleted) → `agent.attach(ws)` adds the client.
4. `runtime.dispose()` completes. `SDKAgent.stop()` calls `this.onExit?.(0)` (`pi-agent.ts:1058`).
5. Exit handler fires: `closeClients()` closes the newly-attached client, `agentPool.delete(this.agentKey)` removes the entry.
6. Client's WS closes → `onclose` fires → client reconnects → `getOrCreateAgent` → not in pool → creates a **new** agent that loads the session from disk.

**Impact:** The live session's in-memory state (unflushed messages, running tools) is lost. The user was trying to reattach to a still-running agent but the watchdog killed it at the exact moment of reconnection. The window is the duration of `runtime.dispose()` (which may involve I/O — flushing session files). This is a narrow race but is **structurally real**: the pool entry is not deleted until after the `await`, so `getOrCreateAgent` finds a stale entry.

**Evidence:**
```typescript
// pi-agent.ts:497-506
private async forceStopAndRemove() {
    this.cancelWatchdog();
    this.cancelIdleTimer();
    try { await this.agent.stop(); } catch (err: any) { ... }
    // Pool entry deleted INSIDE agent.stop() via the exit handler (onExit fires)
    // A client can attach during the await above
    agentPool.delete(this.agentKey);
}

// pi-agent.ts:1053-1058 (SDKAgent.stop)
if (this.runtime) {
    try { await this.runtime.dispose(); } catch (err: any) { ... }
}
// ... after the await, onExit fires:
this.onExit?.(0);  // exit handler calls closeClients() + agentPool.delete()
```

**Fix:** Delete the pool entry **before** awaiting `agent.stop()` in `forceStopAndRemove`, so a reconnecting client doesn't find the dying agent:
```typescript
private async forceStopAndRemove() {
    this.cancelWatchdog();
    this.cancelIdleTimer();
    agentPool.delete(this.agentKey);  // remove FIRST
    this.closeClients();               // close any clients that snuck in
    try { await this.agent.stop(); } catch (err: any) {
        console.error(`[pool] force-stop error for ${this.agentKey}:`, err.message);
    }
}
```

---

### [MEDIUM] F5 — Negative `PI_WEB_STALE_STREAMING_MS` or `PI_WEB_IDLE_TIMEOUT_MS` env values produce negative/zero timeouts, causing immediate force-stop of live sessions

**Location:** `pi-agent.ts:29` (IDLE_TIMEOUT_MS), `pi-agent.ts:36` (STALE_STREAMING_MS), `pi-agent.ts:478` (watchdog tick computation)

**Scenario:**
1. Operator sets `PI_WEB_STALE_STREAMING_MS='-1'` (intending "disable watchdog" or typo).
2. `parseInt('-1', 10) = -1`. `-1 || 15 = -1` (because -1 is truthy). `STALE_STREAMING_MS = -1 * 60 * 1000 = -60000`.
3. `WATCHDOG_TICK_MS = 60000`. `tick = Math.min(60000, -60000) = -60000`. `setInterval(fn, -60000)` → Node/Bun clamps to 1ms interval.
4. On the first 1ms tick: `Date.now() - this.lastActivityAt > -60000` → **always true** (any non-negative diff exceeds -60000). If `clients.size === 0 && isActive()` → `forceStopAndRemove()` fires **immediately**.
5. A streaming agent with no clients (user stepped away for 1 second) is force-stopped within milliseconds.

Similarly for `PI_WEB_IDLE_TIMEOUT_MS='-1'`: `IDLE_TIMEOUT_MS = -60000`. `setTimeout(fn, -60000)` fires immediately. An idle agent (not streaming, no clients) is stopped instantly.

`PI_WEB_IDLE_TIMEOUT_MS='0'` and `PI_WEB_STALE_STREAMING_MS='0'` are safe — `0 || 60 = 60` (falls back to default). But negative values bypass the `||` fallback because they are truthy.

**Impact:** Misconfiguration or a typo (`-1` instead of `1`) causes live streaming sessions to be force-stopped almost immediately, making the server unusable for background sessions.

**Evidence:**
```typescript
// pi-agent.ts:29
const IDLE_TIMEOUT_MS = (parseInt(process.env.PI_WEB_IDLE_TIMEOUT_MS || "", 10) || 60) * 60 * 1000;
// parseInt('-1', 10) = -1; -1 is truthy → -1 || 60 = -1; -1 * 60000 = -60000

// pi-agent.ts:36
const STALE_STREAMING_MS = (parseInt(process.env.PI_WEB_STALE_STREAMING_MS || "", 10) || 15) * 60 * 1000;
// parseInt('-1', 10) = -1; -1 || 15 = -1; -1 * 60000 = -60000

// pi-agent.ts:478
const tick = Math.min(WATCHDOG_TICK_MS, this.staleStreamingMs);
// Math.min(60000, -60000) = -60000 → setInterval clamps to 1ms
```

**Fix:** Clamp to a minimum:
```typescript
const IDLE_TIMEOUT_MS = Math.max(1000, (parseInt(process.env.PI_WEB_IDLE_TIMEOUT_MS || "", 10) || 60) * 60 * 1000);
const STALE_STREAMING_MS = Math.max(1000, (parseInt(process.env.PI_WEB_STALE_STREAMING_MS || "", 10) || 15) * 60 * 1000);
```

---

### [MEDIUM] F6 — Messages from a second client are silently dropped if it connects before the first client's `agent.start()` completes

**Location:** `index.ts:2541–2576` (onOpen), `pi-agent.ts:155–170` (attach → setTimeout getState), `pi-agent.ts:1071–1076` (SDKAgent.doSend early-returns)

**Scenario:**
1. WS1 connects for a new session → `getOrCreateAgent` → `isNew=true`. `agent.attach(raw1)`. `await agent.start()` yields (`index.ts:2559`).
2. WS2 connects for the same session before `start()` completes → `getOrCreateAgent` → finds agent, `isNew=false`. `agent.attach(raw2)` (`index.ts:2556`). No `await start()` needed.
3. WS2 sends `prompt`: `agent.send({ type: "prompt", ... })` → `SDKAgent.doSend` → `if (!this.session || !this.runtime) return;` (`pi-agent.ts:1073`) → **message silently dropped**.
4. WS2's `attach` also scheduled `setTimeout(() => this.agent.getState(), 100)` — if `start()` takes >100ms, `getState()` is also dropped.
5. WS1's `start()` eventually completes. Its `setTimeout(() => this.agent.getState(), 300)` fires, broadcasting state to all clients. WS2 finally sees state after ~300ms.
6. But any prompt WS2 sent during the startup window is **permanently lost**. No error response, no acknowledgment.

**Impact:** In a multi-tab scenario (or a rapid reconnect), the second client's initial prompt is silently swallowed. The user sees no response and no error, believes their message was sent. This is not a "lose live session" issue but is a "lose user input" issue — the user's prompt vanishes without trace.

**Evidence:**
```typescript
// index.ts:2541 — WS1 creates the agent
const { agent, isNew } = getOrCreateAgent(cwd, sessionPath || null, newSessionId, ...);
// index.ts:2556 — WS2 attaches (isNew=false, no start())
agent.attach(raw);

// index.ts:2559 — WS1 awaits start (yields here)
if (isNew) {
    try { await agent.start(); } catch ...

// pi-agent.ts:1071-1076 — doSend silently drops if not started
doSend(msg: unknown) {
    if (!this.session || !this.runtime) {
        return;  // silently dropped — no error to client
    }
    ...
```

**Fix:** Queue messages until the session is ready, or return an error response:
```typescript
// In SDKAgent, add a readiness flag and a queue:
private startPromise: Promise<void> | null = null;
async start() {
    if (this.started) return;
    this.startPromise = this._start();
    await this.startPromise;
}
doSend(msg: unknown) {
    if (!this.session || !this.runtime) {
        this.onMessage?.({ type: "response", command: msg?.type ?? "unknown", success: false, error: "Agent not ready yet" });
        return;
    }
    ...
}
```
Or simpler: in `index.ts` onOpen, check `agent.isStarted()` before attaching WS2, and if not started, wait for start to complete before processing messages.

---

### [MEDIUM] F7 — `restartWithSession`'s exit handler omits `cancelWatchdog()` and `pendingDialog = null`, leaking the watchdog timer on a dead agent

**Location:** `pi-agent.ts:226–232` (restartWithSession exit handler), compare with `pi-agent.ts:146–153` (constructor exit handler)

**Scenario:**
1. If `restartWithSession` is called (currently dead code, but if revived), it creates a new inner agent and sets a new exit handler (`pi-agent.ts:226–232`).
2. If the new agent starts streaming and then exits, the exit handler runs: `broadcast`, `closeClients`, `agentPool.delete`.
3. But it does **NOT** call `this.cancelWatchdog()` or `this.pendingDialog = null` (unlike the constructor's exit handler at lines 148–149).
4. The watchdog interval (`setInterval`) keeps ticking. On the next tick, it checks `stale && clients.size === 0 && isActive()`. `streaming` was set to `true` by the last `agent_start` and never cleared (no `agent_end` was received, or it was but `cancelWatchdog` was called by `noteActivity` which is fine — but if the agent crashed mid-stream, `streaming` stays `true`).
5. The watchdog calls `forceStopAndRemove()`, which calls `this.agent.stop()` on the already-dead SDKAgent. `SDKAgent.stop()` has no guard against double-stop — it runs again, calls `this.onExit?.(0)` a second time. The exit handler runs again (closeClients is a no-op, agentPool.delete is a no-op). `forceStopAndRemove`'s `cancelWatchdog` finally clears the interval.

**Impact:** The watchdog leaks for up to one tick (60s default) after the agent exits. During that window, it may call `forceStopAndRemove` on a dead agent, causing a spurious double-stop. Not a "lose live session" issue, but a resource/timer leak and unnecessary error logging.

**Evidence:**
```typescript
// pi-agent.ts:226-232 — restartWithSession exit handler (MISSING cancelWatchdog + pendingDialog)
this.agent.setExitHandler((code) => {
    console.log(`[pool] agent ${this.agentKey} exited (code ${code})`);
    this.broadcast({ type: "error", message: `PI agent exited (code ${code}).` });
    this.closeClients();
    agentPool.delete(this.agentKey);
    // MISSING: this.pendingDialog = null;
    // MISSING: this.cancelWatchdog();
});

// pi-agent.ts:146-153 — constructor exit handler (HAS both)
this.closeClients();
this.pendingDialog = null;
this.cancelWatchdog();
agentPool.delete(this.agentKey);
```

**Fix:** Add the two missing lines to `restartWithSession`'s exit handler, or (better) extract a shared `handleAgentExit()` method.

---

### [MEDIUM] F8 — New-session rekey to an occupied key strands the agent at `__new__:uuid` with `isPendingNewSession` already false — no retry, no fallback by path

**Location:** `pi-agent.ts:330–340` (state handler: sets isPendingNewSession=false BEFORE rekey), `pi-agent.ts:364–372` (rekeyToSessionPath, no failure handling)

**Scenario:**
1. Agent A exists at `/cwd::/session-A.json` (opened by path).
2. Agent B is created as a new session: `/cwd::__new__:uuid-B`. `isPendingNewSession = true`.
3. Agent B's PI resolves its sessionFile to `/session-A.json` (SDK bug, filesystem collision, or the user manually created a session file with the same name the SDK would generate).
4. `handleAgentMessage` receives a `state` event with `sessionFile: "/session-A.json"`. `isPendingNewSession && sessionFile` → true.
5. `this.isPendingNewSession = false` is set **before** the rekey attempt (`pi-agent.ts:333`).
6. `rekeyToSessionPath(cwd, "/session-A.json")` → `rekeyAgent("/cwd::__new__:uuid-B", "/cwd::/session-A.json")` → `agentPool.has(newKey)` is true (agent A) → returns null. Rekey fails silently.
7. Agent B is stranded at `/cwd::__new__:uuid-B` with `isPendingNewSession = false`. No future state event will trigger a rekey (the `if (this.isPendingNewSession && sessionFile)` guard is now false).

**Impact:** Agent B can only be reattached via the `originalNewSessionId` reverse lookup (if the client reconnects with `uuid-B`). A reconnect by path `/session-A.json` finds agent A (which may be running a different session or may be idle). Agent B is an orphan that will eventually idle out. Two agents for the same logical session is confusing but unlikely to cause data corruption (unlike F1, where two runtimes actively write to the same file — here agent B created a new session that happens to resolve to an existing path, which the SDK should prevent).

**Evidence:**
```typescript
// pi-agent.ts:330-340
if (this.isPendingNewSession && sessionFile) {
    this.isPendingNewSession = false;  // set false BEFORE rekey attempt
    this.rekeyToSessionPath(cwd, sessionFile);  // may fail — no retry possible
    projectSessionsChangedHandler?.(cwd);
}
```

**Fix:** Only set `isPendingNewSession = false` if the rekey succeeds:
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
    // else: rekey failed, keep isPendingNewSession true for retry on next state event
}
```

---

### [LOW] F9 — `rekeyAfterClone` poll does not stop when the agent exits, continuing to call `getState()` on a dead agent for up to ~4 seconds

**Location:** `pi-agent.ts:384–401` (rekeyAfterClone), `pi-agent.ts:1071–1076` (doSend early-returns on dead agent)

**Scenario:**
1. Clone succeeds → `rekeyAfterClone` arms the poll (`isPendingCloneRekey = true`, schedules `setTimeout(poll, 200)`).
2. Agent exits (PI crash, OOM, etc.) before the clone rekey fires. Exit handler runs: `closeClients`, `cancelWatchdog`, `agentPool.delete(this.agentKey)`.
3. But the clone poll's `setTimeout` is **not** cancelled by the exit handler. It fires 200ms later.
4. `poll()` checks `!this.isPendingCloneRekey` — it's still true (exit handler doesn't clear it). Calls `this.agent.getState()` → `SDKAgent.doSend` → `if (!this.session || !this.runtime) return;` → silently drops. No harm, but wasteful.
5. Schedules another `setTimeout(poll, 400)`. Repeats for up to 10 attempts (~4 seconds of polling a dead agent).

**Impact:** No live session is lost — the agent is already dead. The poll is harmless (doSend early-returns). But it keeps the PooledAgent in memory via the closure for ~4 seconds after it should have been GC'd, and generates 10 useless `get_state` calls.

**Evidence:**
```typescript
// pi-agent.ts:384-401 — poll loop, no exit check
private rekeyAfterClone() {
    if (this.isPendingCloneRekey) return;
    this.isPendingCloneRekey = true;
    let attempts = 0;
    const poll = () => {
        if (!this.isPendingCloneRekey || attempts++ >= 10) {
            this.isPendingCloneRekey = false;
            return;
        }
        this.agent.getState();           // called on dead agent — silently dropped
        setTimeout(poll, 400);
    };
    setTimeout(poll, 200);
}

// pi-agent.ts:146-153 — exit handler does NOT clear isPendingCloneRekey or cancel the poll
this.agent.setExitHandler((code) => {
    ...
    this.closeClients();
    this.pendingDialog = null;
    this.cancelWatchdog();
    agentPool.delete(this.agentKey);
    // MISSING: this.isPendingCloneRekey = false;
});
```

**Fix:** Clear `isPendingCloneRekey` in the exit handler:
```typescript
this.agent.setExitHandler((code) => {
    ...
    this.isPendingCloneRekey = false;
    ...
});
```

---

### [LOW] F10 — `extractNewSessionId` uses `indexOf` (not `lastIndexOf`), so a cwd containing `__new__:` corrupts the extracted UUID

**Location:** `pi-agent.ts:745–748` (extractNewSessionId)

**Scenario:**
1. A project path contains the literal string `__new__:` — e.g., `/home/user/__new__:/projects/myapp` (unusual but valid on POSIX filesystems).
2. `buildAgentKey("/home/user/__new__:/projects/myapp", null, "uuid-A")` produces key `/home/user/__new__:/projects/myapp::__new__:uuid-A`.
3. `extractNewSessionId(key)` calls `key.indexOf("__new__:")` which finds the **first** occurrence (inside the cwd at position 6), not the one after `::`.
4. Returns `/projects/myapp::__new__:uuid-A` instead of `uuid-A`.
5. `originalNewSessionId` is set to this corrupted value. The reverse lookup in `getOrCreateAgent` compares `a.originalNewSessionId === newSessionId` — `"uuid-A" !== "/projects/myapp::__new__:uuid-A"` → **reverse lookup fails**.
6. A stale-newSessionId reconnect spawns a duplicate agent, orphaning the live one.

**Impact:** A project path containing `__new__:` breaks the #REATTACH reverse lookup. Extremely unlikely in practice (who has `__new__:` in a directory name?), but structurally real.

**Evidence:**
```typescript
// pi-agent.ts:745-748
function extractNewSessionId(key: string): string | null {
    const i = key.indexOf("__new__:");  // finds FIRST occurrence — wrong if cwd contains __new__:
    return i === -1 ? null : key.slice(i + "__new__:".length);
}
```

**Fix:** Use `lastIndexOf`, or better, split on `::` first:
```typescript
function extractNewSessionId(key: string): string | null {
    const idx = key.indexOf("::");
    if (idx < 0) return null;
    const rest = key.slice(idx + 2);
    const prefix = "__new__:";
    return rest.startsWith(prefix) ? rest.slice(prefix.length) : null;
}
```

---

### [LOW] F11 — `::` in a project path (cwd) corrupts key parsing in `agentKeyCwd` and `agentKeySessionPath`

**Location:** `pi-agent.ts:521–524` (agentKeyCwd), `pi-agent.ts:527–533` (agentKeySessionPath)

**Scenario:**
1. A project path contains `::` — e.g., `/home/user::weird/project`.
2. `buildAgentKey("/home/user::weird/project", "/s.json")` → `/home/user::weird/project::/s.json`.
3. `agentKeyCwd(key)` splits on `"::"` → `["/home/user", "weird/project", "/s.json"]` → returns `"/home/user"` (WRONG cwd).
4. When a `state` event fires, `handleAgentMessage` extracts the wrong cwd (`pi-agent.ts:323`). `rekeyToSessionPath` builds a key with the wrong cwd: `buildAgentKey("/home/user", "/resolved.json")` → `/home/user::/resolved.json`.
5. `rekeyAgent` moves the entry from the correct key to a key with the wrong cwd. The agent is now unreachable by its original cwd.

**Impact:** A project path containing `::` breaks rekeying and session-change broadcasting. The agent becomes unreachable via the normal key lookup. Extremely unlikely (`::` in a directory name is unusual) but structurally real.

**Evidence:**
```typescript
// pi-agent.ts:521-524
function agentKeyCwd(key: string): string | null {
    const parts = key.split("::");   // splits on ALL :: — wrong if cwd has ::
    return parts[0] || null;
}

// pi-agent.ts:527-533
function agentKeySessionPath(key: string): string | null {
    const idx = key.indexOf("::");  // finds FIRST :: — wrong if cwd has ::
    if (idx < 0) return null;
    const rest = key.slice(idx + 2);
    return rest.startsWith("__new__") ? null : rest;
}
```

**Fix:** Use a separator that cannot appear in paths (e.g., `\0` or a multi-char sentinel unlikely in paths), or use `indexOf("::")` and `lastIndexOf("::")` with awareness that cwd may contain `::`. The simplest robust fix: store cwd and sessionPath as separate fields on PooledAgent rather than parsing them out of the key string.

---

### [LOW] F12 — `PooledAgent.stop()` fires the exit handler (via `SDKAgent.stop → onExit`) which broadcasts "PI agent exited (code 0)" to all clients, even for deliberate stops

**Location:** `pi-agent.ts:263–270` (stop), `pi-agent.ts:1058` (SDKAgent.stop → onExit), `pi-agent.ts:102–153` (exit handler broadcasts error)

**Scenario:**
1. `stopAllAgents()` is called during graceful shutdown. For each agent, `a.stop()` is called.
2. `stop()` calls `this.agent.stop()` which fires `onExit(0)`.
3. The exit handler broadcasts `{ type: "error", message: "PI agent exited (code 0)." }` to all attached clients.
4. Then `closeClients()` closes all WSes.
5. Clients receive an "error" message with code 0 (clean exit) right before being disconnected. This is misleading — code 0 is not an error.

This also applies to `deleteFromPool` and `stopAgentsForCwd`, which call `agent.stop()` (fire-and-forget). Clients receive a spurious "error" message before being closed.

**Impact:** Not a "lose live session" issue. Clients see a misleading error message during deliberate shutdown or project deletion. Minor UX issue.

**Evidence:**
```typescript
// pi-agent.ts:263-270
async stop() {
    this.cancelIdleTimer();
    this.cancelWatchdog();
    this.pendingDialog = null;
    await this.agent.stop();     // fires onExit(0) → exit handler broadcasts error
    agentPool.delete(this.agentKey);  // double delete (harmless)
}

// pi-agent.ts:1058
this.onExit?.(0);  // always fires, even for deliberate stop

// pi-agent.ts:104-105 (exit handler)
this.broadcast({ type: "error", message: `PI agent exited (code ${code}).` });
```

**Fix:** Check `explicitlyStopped` before broadcasting (the field is already set but never read):
```typescript
// In SDKAgent.stop(), set a flag before calling onExit:
this.onExit?.(0);  // keep as-is

// In PooledAgent's exit handler, check a flag:
private isStopping = false;
async stop() {
    this.isStopping = true;
    ...
}
// In exit handler:
if (!this.isStopping) {
    this.broadcast({ type: "error", message: `PI agent exited (code ${code}).` });
}
```
Or simpler: change the broadcast message type from `"error"` to `"info"` for code 0.

---

### [LOW] F13 — `SDKAgent.stop()` has no guard against double-stop — concurrent `stop()` calls double-dispose the runtime

**Location:** `pi-agent.ts:1049–1058` (SDKAgent.stop, no `if (this.started) return` guard)

**Scenario:**
1. The idle timer fires: `await this.agent.stop()` yields at `await this.runtime.dispose()`.
2. Simultaneously, `stopAllAgents()` (graceful shutdown) calls `a.stop()` → `cancelIdleTimer` (no-op, already fired), `cancelWatchdog`, `await this.agent.stop()`.
3. Both calls to `SDKAgent.stop()` reach `await this.runtime.dispose()` on the same runtime object. `dispose()` is called twice concurrently.
4. If `dispose()` is not idempotent, this could throw or leave the runtime in an inconsistent state. The error is caught by `try/catch` (`pi-agent.ts:1053–1054`), but the runtime may not be properly cleaned up.
5. Both `stop()` calls eventually call `this.onExit?.(0)`, firing the exit handler twice.

**Impact:** Requires very precise timing (idle timer fires at the exact moment `stopAllAgents` is called). The consequence is a potential SDK error during disposal, not a "lose live session" issue. The double `onExit` is harmless (idempotent cleanup).

**Evidence:**
```typescript
// pi-agent.ts:1049-1058 — no guard against double-stop
async stop(): Promise<void> {
    this.explicitlyStopped = true;
    // MISSING: if (!this.started) return;
    ...
    if (this.runtime) {
        try { await this.runtime.dispose(); } catch (err: any) { ... }
    }
    ...
    this.onExit?.(0);
}

// Contrast with start() which HAS a guard:
// pi-agent.ts:858-860
async start(): Promise<void> {
    if (this.started) return;  // <-- guarded
    this.started = true;
    ...
```

**Fix:** Add a guard at the top of `stop()`:
```typescript
async stop(): Promise<void> {
    if (!this.started && !this.runtime) return;  // already stopped
    this.explicitlyStopped = true;
    ...
}
```

---

## EXHAUSTIVE CHECKLIST

### Reattach paths verified SAFE

1. **Reconnect with same sessionPath** → `getOrCreateAgent(cwd, sessionPath)` finds agent by key → **SAFE**. (`pi-agent.ts:617–619`)
2. **Reconnect with path-equivalent sessionPath** (trailing slash, `//`, `./`, `..`) → `normalizeSessionPath` produces same key → **SAFE**. (`pi-agent.ts:739–741`, tested at `pi-agent.test.ts:565–586`)
3. **Reconnect with original newSessionId after initial rekey** (WS dropped before rekey processed) → reverse lookup by `originalNewSessionId` → **SAFE** (provided no subsequent session switch — see F2). (`pi-agent.ts:627–634`, tested at `pi-agent.test.ts:596–612`)
4. **Reconnect after agent exit (PI crash)** → exit handler deletes pool entry + closes clients → client onclose fires → reconnect creates fresh agent → **SAFE**. (`pi-agent.ts:102–154`, tested at `pi-agent.test.ts:285–313`)
5. **Reconnect after idle timeout** → idle timer calls `agent.stop()` → exit handler deletes entry → client reconnects → fresh agent → **SAFE**. (`pi-agent.ts:441–453`, tested at `pi-agent.test.ts:138–157`)
6. **Reconnect after watchdog force-stop** → `forceStopAndRemove` deletes entry → client reconnects → fresh agent → **SAFE** (except the TOCTOU window in F4). (`pi-agent.ts:475–490`, tested at `pi-agent.test.ts:480–506`)
7. **Reconnect after clone** → `session_loaded` rekeys to forked path → reconnect by forked path finds agent → **SAFE** (unless target occupied — see F1). (`pi-agent.ts:355–360`, tested at `pi-agent.test.ts:656–699`)
8. **Cache-cleared refresh** → `GET /api/projects/:id/live-sessions` → `getLiveSessionsForCwd` returns snapshots → client reattaches → **SAFE**. (`pi-agent.ts:562–587`, `index.ts:421`, tested at `pi-agent.test.ts:726–782`)
9. **Two concurrent new sessions (distinct newSessionIds)** → distinct `__new__:uuid-A` and `__new__:uuid-B` keys → no collision → **SAFE**. (`pi-agent.ts:604`, tested at `pi-agent.test.ts:316–325`)
10. **Rekey to unoccupied key (normal new-session resolution)** → `rekeyAgent` moves entry, updates `agentKey` via `setKey` → reconnect by resolved path finds agent → **SAFE**. (`pi-agent.ts:700–712`, tested at `pi-agent.test.ts:328–342`)
11. **Rekey to same key (no-op)** → `rekeyToSessionPath` returns early → **SAFE**. (`pi-agent.ts:367`, tested at `pi-agent.test.ts:688–697`)
12. **Pending dialog replayed on reconnect** → `attach` replays `pendingDialog` to new client → **SAFE**. (`pi-agent.ts:168–174`, tested at `pi-agent.test.ts:442–470`)
13. **Fire-and-forget UI events NOT replayed** → `pendingDialog` only tracks blocking methods → **SAFE**. (`pi-agent.ts:299–304`, tested at `pi-agent.test.ts:462–476`)
14. **Exit handler deletes by CURRENT key (not stale closure key)** → `agentPool.delete(this.agentKey)` uses the live field → **SAFE** (#REKEY-EXIT fix). (`pi-agent.ts:154`, tested at `pi-agent.test.ts:515–562`)
15. **`deleteFromPool` stops the agent** → pool entry deleted + `agent.stop()` called → no orphaned PI → **SAFE**. (`pi-agent.ts:671–679`, tested at `pi-agent.test.ts:619–630`)
16. **`stopAgentsForCwd` stops all project agents** → iterates with `Array.from` snapshot, deletes + stops each → **SAFE**. (`pi-agent.ts:684–695`, tested at `pi-agent.test.ts:634–653`)
17. **`setProjectSessionsChangedHandler` rejection isolation** → wrapper catches sync throws + async rejections → **SAFE**. (`pi-agent.ts:513–525`, tested at `pi-agent.test.ts:356–371`)
18. **Watchdog does not double-fire** → `forceStopAndRemove` cancels watchdog synchronously before first `await` → **SAFE**. (`pi-agent.ts:497–506`)
19. **Idle timer does not arm while streaming** → `isActive()` returns true → `maybeStartIdleTimer` returns early → **SAFE**. (`pi-agent.ts:437–438`)
20. **`broadcastToProjectClients` prefix matching** → `${cwd}::` prefix does not match other projects → **SAFE** (verified: `/home/user2::` does not start with `/home/user::`). (`pi-agent.ts:541–551`)
21. **`getLiveSessionsForCwd` excludes pending-new agents** → `getLiveSnapshot` returns null before sessionFile resolves → **SAFE**. (`pi-agent.ts:562–587`, tested at `pi-agent.test.ts:752–762`)
22. **Graceful shutdown stops all agents with 3s timeout** → `Promise.race` prevents hang → session files flushed (best-effort) → **SAFE** (acknowledged limitation: in-memory state lost). (`index.ts:2797`)
23. **`unhandledRejection` / `uncaughtException` handlers** → log and keep running → one bad agent doesn't crash the server → **SAFE**. (`index.ts:2803–2808`)

### Paths verified SAFE with caveats

24. **`PooledAgent.stop()` double-deletes pool entry** → exit handler deletes, then `stop()` deletes again → **SAFE** (idempotent `Map.delete`). But exit handler broadcasts spurious "error (code 0)" — see F12.
25. **`stop()` from idle timer** → `clients.size === 0` checked before stop → `closeClients` in exit handler is a no-op → **SAFE**. (`pi-agent.ts:441–453`)
26. **Concurrent WS opens for same session** → `getOrCreateAgent` is synchronous, first call sets entry before yielding at `await start()` → second call finds it → **SAFE** (but see F6 for dropped messages during startup).

### Paths that could NOT be fully verified

1. **SDK behavior after `runtime.dispose()`** — whether the SDK can still emit events (e.g., a final `agent_end` or `state` flush) during disposal, which could trigger a rekey on a dying agent. The `unsubscribe?.()` call (`pi-agent.ts:1051`) should prevent this, but SDK internals are not in scope.
2. **`runtime.dispose()` hanging indefinitely** — if `dispose()` never resolves, `forceStopAndRemove` and `stop()` hang forever. The pool entry is eventually deleted (by the exit handler if `onExit` fires, or not if `dispose()` hangs before reaching `onExit`). The graceful shutdown's 3-second `Promise.race` mitigates this for `stopAllAgents`, but `forceStopAndRemove` and `deleteFromPool` have no timeout.
3. **Two SDK runtimes on the same session file (F1 scenario)** — whether the SDK's `SessionManager` uses file locking to prevent concurrent writes. If it does, F1 is less severe (the second `switchSession` would fail). If it doesn't, F1 is a data corruption risk. SDK internals not in scope.
4. **SDK `switchSession` / `fork` resolving the new sessionFile synchronously** — the comments claim this (`pi-agent.ts:56–57`), but the code also has the `isPendingCloneRekey` poll as a "safety net" (`pi-agent.ts:71–72`), suggesting it's not always synchronous. If `session_loaded` fires with a stale or null `filePath`, the rekey is skipped.
5. **Bun's `ServerWebSocket` lifecycle guarantees** — whether `onClose` is guaranteed to fire after `ws.close()`, and whether `ws.readyState` transitions are atomic. Assumed standard but not verified against Bun's implementation.

---

## Summary

The core reattach logic is **well-designed and mostly robust**. The #REKEY-EXIT fix (delete by `this.agentKey`), the `originalNewSessionId` reverse lookup, the path normalization, the watchdog, and the pending-dialog replay are all sound. The test suite covers the major regression paths.

The most serious finding is **F1** (silent rekey failure on `session_loaded` when the target key is occupied), which can leave two SDK runtimes on the same session file — a data corruption risk. **F2** (stale `originalNewSessionId` after session switch) can misroute a reconnecting client to the wrong session. **F3** (`restartWithSession` is broken) is dead code but would be catastrophic if revived. **F4** (watchdog TOCTOU) is a narrow race but structurally real. **F5** (negative env values) is a misconfiguration footgun. **F6** (dropped messages during startup) is a UX issue in multi-tab scenarios.

No CRITICAL findings — the core invariant ("a reconnecting client always finds the same live agent or gets a clean failure") holds for the common paths. The edge cases above are specific multi-session or misconfiguration scenarios.
