import { normalize } from "node:path";
import { realpathSync } from "node:fs";
import type { WSServerMessage } from "@pi-web/shared";
import type { ServerWebSocket } from "bun";
import type { Model } from "@earendil-works/pi-ai";
import {
	AuthStorage,
	ModelRegistry,
	SessionManager,
	createAgentSessionServices,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	getAgentDir,
	initTheme,
	type AgentSession,
	type AgentSessionEvent,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	type ExtensionUIContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";

// ─── Pooled Agent ───
// Wraps a PIAgent with multi-client broadcast + idle cleanup.
// Survives WebSocket disconnects — agents keep running until idle timeout.
//
// #LIVE: idle agents are kept for a long grace window so a user who steps
// away (lunch, a meeting, a crash + relaunch) returns to their session
// still alive in the pool. The requirement is "unless the app is restarted
// we do not lose access" — so the idle grace is intentionally generous.
// Overridable via PI_WEB_IDLE_TIMEOUT_MS (minutes).
// ponytail: Math.max(1000, ...) so a typo'd/negative env value (e.g. '-1', which
// is truthy and bypasses the `|| 60` fallback) can't produce a negative/zero
// timeout that force-stops a live streaming session within milliseconds.
const IDLE_TIMEOUT_MS = Math.max(1000, (parseInt(process.env.PI_WEB_IDLE_TIMEOUT_MS || "", 10) || 60) * 60 * 1000); // 1 hour default
// #LIVE: watchdog for wedged agent runs. A run that is "streaming" but has
// produced no message activity for this long AND has no clients is treated as
// hung (e.g. blocked on an unanswered extension_ui_request whose client
// disconnected, or a stuck tool / hung model call). Left un-reaped it lingers
// forever — the "server requires a reboot" failure mode. Force-stopped here.
// Overridable via PI_WEB_STALE_STREAMING_MS (minutes).
const STALE_STREAMING_MS = Math.max(1000, (parseInt(process.env.PI_WEB_STALE_STREAMING_MS || "", 10) || 15) * 60 * 1000); // 15 minutes default
// #LIVE: cadence at which the watchdog sweeps a single agent. Kept coarse so
// the per-agent timer is cheap; STALE_STREAMING_MS is what bounds recovery.
const WATCHDOG_TICK_MS = 60 * 1000; // 1 minute

// The in-process SDK path skips the CLI's initTheme(), so the SDK's theme
// singleton is never seeded and tool renderers crash on `theme.fg(...)` with
// "undefined is not an object (evaluating 'theme.fg')". Lazily seed the default
// theme once; extensions read it back via the SDK's own global symbol (the
// mechanism it uses to share the theme across module loaders).
const THEME_GLOBAL = Symbol.for("@earendil-works/pi-coding-agent:theme");
let headlessTheme: Theme | undefined;
function getHeadlessTheme(): Theme {
  if (!headlessTheme) {
    initTheme();
    headlessTheme = (globalThis as any)[THEME_GLOBAL] as Theme;
  }
  return headlessTheme;
}

export interface IPIAgent {
  setHandler(handler: (msg: WSServerMessage) => void): void;
  setExitHandler(handler: (code: number | null) => void): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  getOptions(): PIAgentOptions;
  getState(): void;
  doSend(msg: unknown): void;
  /** Synchronous snapshot of the live session's identity + activity, for the
   * server's live-session recovery endpoint. Returns null before the
   * session has resolved its sessionFile. */
  getLiveSnapshot(): LiveSessionSnapshot | null;
}

/** Identity + liveness snapshot of one pooled agent's session. Used by the
 * live-session recovery flow so a cache-cleared refresh can reattach to the
 * still-running agent it lost its client handle to. */
export interface LiveSessionSnapshot {
  sessionPath: string;
  sessionId: string;
  sessionName: string | null;
  isStreaming: boolean;
  isCompacting: boolean;
  clientCount: number;
  lastActivityAt: number;
  // #LIVE: for a pending new session that hasn't resolved its sessionFile yet,
  // the server-side /live-sessions restore reattaches by newSessionId (reverse
  // lookup) instead of sessionPath. `pending` marks these boot-only snapshots.
  newSessionId?: string | null;
  pending?: boolean;
}

export class PooledAgent {
  private agent: IPIAgent;
  private createAgent: (options: PIAgentOptions) => IPIAgent;
  private clients = new Set<ServerWebSocket>();
  private idleTimer: Timer | null = null;
  private agentKey: string;
  private streaming = false;
  private runningTools = new Set<string>();
  private lastActivityAt = Date.now();
  private idleTimeoutMs: number;
  // #LIVE: how long an active run with no activity + no clients is tolerated.
  private staleStreamingMs: number;
  private isPendingNewSession: boolean;
  // #CLONE: after a clone, PI rebinds to a new forked session file ASYNC and
  // never notifies us of the new path. We poll get_state and rekey to whatever
  // new sessionFile comes back. Cleared on first rekey or after the poll budget
  // runs out. (SDK: switchSession/fork resolve the new path synchronously, so
  // this stays as a safety net for the state-driven rekey path.)
  private isPendingCloneRekey: boolean = false;
  // #LIVE: the last *blocking* extension_ui_request (select/confirm/input/editor)
  // that PI is waiting on. Replayed to a reconnecting client on attach so a
  // disconnect mid-dialog can't wedge PI forever.
  private pendingDialog: WSServerMessage | null = null;
  // #LIVE: watchdog timer. While an agent is active we keep this ticking; if it
  // goes stale (no activity, no clients) the watchdog force-stops the run.
  private watchdogTimer: Timer | null = null;
  // #REATTACH: the newSessionId this agent was created with (for pending new
  // sessions). After the session resolves and the agent is rekeyed to its real
  // sessionFile, a client that reconnects with the ORIGINAL newSessionId (its WS
  // dropped before it processed the rekey) must still reattach to THIS agent
  // instead of spawning a duplicate. See getOrCreateAgent's reverse lookup.
  // Non-readonly so it can be cleared once the agent switches to a different
  // session (session_loaded from switch_session/clone) — at that point the
  // original newSessionId is stale and a reverse-lookup reattach would land
  // on the WRONG session. See handleAgentMessage's session_loaded branch.
  originalNewSessionId: string | null;
  /** Get the current pool key for this agent. */
  getKey(): string {
    return this.agentKey;
  }

  /** Update the pool key (called by rekeyAgent). */
  setKey(newKey: string) {
    this.agentKey = newKey;
  }

  private rekeyHandler: ((oldKey: string, newKey: string) => void) | null = null;
  /** Set a callback invoked when this agent's pool key changes (pending-new -> resolved). */
  setRekeyHandler(cb: ((oldKey: string, newKey: string) => void) | null) { this.rekeyHandler = cb; }

  constructor(
    agentKey: string,
    options: PIAgentOptions,
  createAgent: (options: PIAgentOptions) => IPIAgent = (opts) => new SDKAgent(opts),
  idleTimeoutMs = IDLE_TIMEOUT_MS,
  // #LIVE: test seam for the watchdog window.
  staleStreamingMs = STALE_STREAMING_MS,
) {
    this.agentKey = agentKey;
    this.idleTimeoutMs = idleTimeoutMs;
    this.staleStreamingMs = staleStreamingMs;
    this.isPendingNewSession = !options.sessionPath;
    // Extract the newSessionId from a pending `__new__:<uuid>` key (if any) so a
    // stale-newSessionId reconnect can reattach after rekey (#REATTACH).
    this.originalNewSessionId = this.isPendingNewSession ? extractNewSessionId(agentKey) : null;
    this.createAgent = createAgent;
    this.agent = createAgent(options);

    // Forward agent messages to clients and track activity for keepalive
    this.agent.setHandler((msg) => this.handleAgentMessage(msg));

    // Handle unexpected agent failure
    this.agent.setExitHandler((code) => {
      console.log(`[pool] agent ${this.agentKey} exited (code ${code})`);
      // #LIVE: only surface an error for an unexpected exit. A deliberate stop
      // (idle timeout, shutdown) reports code 0 and would otherwise broadcast a
      // misleading "error" right before the client is closed+reconnected.
      if (code !== 0) this.broadcast({ type: "error", message: `PI agent exited (code ${code}).` });
      // #1: Close every attached client WS so the client's onclose fires and
      // its reconnect logic kicks in. Without this the WS stays 'open' while
      // the agent is gone from the pool — every subsequent send is silently
      // dropped and the user thinks they're talking to a live agent.
      this.closeClients();
      // #LIVE: drop any orphaned dialog + stop the watchdog — the agent is gone.
      this.pendingDialog = null;
      this.isPendingCloneRekey = false;
      this.cancelWatchdog();
      // #REKEY-EXIT: delete by the CURRENT key (this.agentKey), not the closure
      // `agentKey` captured at construction. A new-session agent is rekeyed
      // from `__new__:<uuid>` to the resolved `${cwd}::${sessionFile}` once PI
      // reports the sessionFile; deleting the stale original key left the
      // rekeyed entry in the pool with a dead PI underneath — a reconnect
      // reused the dead agent and every send was silently dropped. That is
      // the "server requires a reboot" failure mode.
      //
      // #SDK-MIGRATION: runtime.dispose() is async (extension session_shutdown
      // handlers do I/O), so onExit fires LONG after the stop path already
      // deleted this entry. A client that reconnected during that gap spawned a
      // NEW live agent at this same key — deleting unconditionally here would
      // orphan that replacement. Only delete if this entry still belongs to
      // THIS (dying) agent.
      if (agentPool.get(this.agentKey) === this) agentPool.delete(this.agentKey);
    });
  }

  async start(): Promise<void> {
    await this.agent.start();
    this.startWatchdog();
    // Send initial state to any already-attached clients
    setTimeout(() => this.agent.getState(), 300);
  }

  /** Attach a WebSocket client. Cancels idle timer if running. */
  attach(ws: ServerWebSocket) {
    this.clients.add(ws);
    this.cancelIdleTimer();
    // Send current state to the newly attached client
    setTimeout(() => this.agent.getState(), 100);
    // #LIVE: replay any blocking dialog PI is still waiting on. Without this,
    // a refresh while a modal is open leaves PI blocked forever — the dialog
    // was broadcast to the now-gone client and never re-delivered (the
    // "requires a reboot" failure mode). Fire-and-forget UI events (notify,
    // setStatus, ...) are intentionally NOT replayed.
    if (this.pendingDialog) {
      try { if (ws.readyState === 1) ws.send(JSON.stringify(this.pendingDialog)); } catch {}
    }
  }

  /** Detach a WebSocket client. Starts idle timer only when no clients remain and agent is idle. */
  detach(ws: ServerWebSocket) {
    this.clients.delete(ws);
    this.maybeStartIdleTimer();
  }

  /** Get number of attached clients */
  get clientCount() { return this.clients.size; }

  /** Snapshot this agent's session identity + liveness for the recovery
   * endpoint. For a pending new session (no sessionFile yet) we still surface a
   * `pending` snapshot carrying newSessionId so the server-side restore can
   * reattach to the booting agent via getOrCreateAgent's reverse lookup. */
  getLiveSnapshot(): LiveSessionSnapshot | null {
    const snap = this.agent.getLiveSnapshot();
    if (!snap) {
      if (this.isPendingNewSession && this.originalNewSessionId) {
        return {
          sessionPath: "",
          sessionId: "",
          sessionName: null,
          isStreaming: this.streaming,
          isCompacting: false,
          clientCount: this.clients.size,
          lastActivityAt: this.lastActivityAt,
          newSessionId: this.originalNewSessionId,
          pending: true,
        };
      }
      return null;
    }
    snap.clientCount = this.clients.size;
    snap.lastActivityAt = this.lastActivityAt;
    // Reflect the pool's authoritative streaming flag (it tracks agent_start/end
    // and tool activity, which may differ from the SDK's momentary read).
    snap.isStreaming = this.streaming || snap.isStreaming;
    // #SDK-MIGRATION: the SDK allocates sessionFile synchronously in start(),
    // but the pool key stays `__new__:<uuid>` until the first state/session_loaded
    // rekey lands (~300ms). In that window a /live-sessions client reconnecting
    // by sessionPath would miss the `__new__` key and spawn a duplicate. Surface
    // newSessionId+pending so the client reattaches via the reverse lookup
    // (getOrCreateAgent's originalNewSessionId scan) instead.
    if (this.isPendingNewSession && this.originalNewSessionId) {
      snap.newSessionId = this.originalNewSessionId;
      snap.pending = true;
    }
    return snap;
  }

  /** Forward a command to the underlying agent. Clears a stale blocking dialog
   * when the client answers it, so a reconnecting client isn't replayed a dialog
   * that's already been resolved (LOW-1). */
  send(msg: unknown) {
    if ((msg as any)?.type === "extension_ui_response") {
      const id = (msg as any).id;
      const dlg = this.pendingDialog as any;
      if (dlg && dlg?.ui?.id === id) this.pendingDialog = null;
    }
    this.agent.doSend(msg);
  }

  /**
   * Close every attached client WebSocket and drop them from the client set.
   * Used when the underlying PI process dies — closing the WS makes the
   * client's onclose fire so it reconnects (and either reattaches to a
   * still-running agent or spawns a fresh one that reloads the session).
   */
  closeClients() {
    for (const ws of this.clients) {
      try { if ((ws as any).readyState === 1) ws.close(); } catch {}
    }
    this.clients.clear();
  }

  /** Drop dead sockets from the client set; arm the idle timer if it emptied.
   * Called by broadcast/sendToClients (on send) and sweepPool (periodic) so a
   * half-open socket on an idle agent can't pin clients.size > 0 forever
   * (which would block idle reaping). HIGH-3 / MEDIUM-1. */
  pruneDeadClients() {
    if (this.clients.size === 0) return;
    let pruned = false;
    for (const ws of this.clients) {
      if (ws.readyState !== 1) { this.clients.delete(ws); pruned = true; }
    }
    if (pruned) this.maybeStartIdleTimer();
  }

  // restartWithSession was REMOVED: it was dead code (no caller) and broken —
  // await this.agent.stop() fired the exit handler which deleted the pool
  // entry and closed all clients, leaving the restarted inner agent orphaned
  // with no pool entry (a reconnect would spawn a duplicate). Use a new pool
  // entry / getOrCreateAgent for any restart need instead.

  /**
   * Send a `load_session` RPC to the running agent — let PI handle the
   * in-process switch instead of recreating the runtime. Use `restartWithSession`
   * for stale-extension-ctx recovery.
   */
  loadSession(sessionPath: string): void {
    try {
      this.send({ type: "load_session", sessionPath });
    } catch (err: any) {
      console.error(`[pool] failed to send load_session ${sessionPath}:`, err.message);
      this.broadcast({ type: "error", message: `Failed to load session: ${err.message}` });
    }
  }

  /**
   * Send a `switch_session` RPC to the running agent — let PI handle the
   * in-process switch.
   */
  switchSession(sessionPath: string): void {
    try {
      this.send({ type: "switch_session", sessionPath });
    } catch (err: any) {
      console.error(`[pool] failed to send switch_session ${sessionPath}:`, err.message);
      this.broadcast({ type: "error", message: `Failed to switch session: ${err.message}` });
    }
  }

  /** Explicitly stop the agent (e.g., server shutdown) */
  async stop() {
    this.cancelIdleTimer();
    this.cancelWatchdog();
    this.pendingDialog = null;
    // E8: bound the stop so a hung runtime.dispose() (stuck I/O) can't leave the
    // SDK session lingering in memory indefinitely. The pool entry is deleted
    // regardless after the race.
    try {
      await Promise.race([
        this.agent.stop(),
        new Promise<void>(r => setTimeout(r, 5000)),
      ]);
    } catch (err: any) {
      console.error(`[pool] stop error for ${this.agentKey}:`, err.message);
    }
    agentPool.delete(this.agentKey);
  }

  private broadcast(msg: WSServerMessage) {
    const data = JSON.stringify(msg);
    let pruned = false;
    for (const ws of this.clients) {
      // ponytail: prune dead sockets (readyState !== OPEN) so a WS that died
      // without firing onClose (hard socket error; the Hono/Bun adapter wires no
      // onError) can't linger and keep clients.size > 0 — blocking idle reaping.
      if (ws.readyState !== 1) { this.clients.delete(ws); pruned = true; continue; }
      try {
        // ponytail: backpressure — Bun's send() returns -1 when the buffer is
        // full. Close the stalled client (1011) instead of silently dropping
        // messages and leaving the user looking at a dead stream (MEDIUM-2).
        // Number() coerces safely across send() return shapes.
        if (Number(ws.send(data)) < 0) { this.clients.delete(ws); pruned = true; try { ws.close(1011, "Backpressure"); } catch {} }
      } catch { this.clients.delete(ws); pruned = true; }
    }
    // HIGH-3: a prune may have emptied the client set — arm the idle timer so
    // an idle agent with only dead clients eventually reaps (broadcast only
    // runs on send, so without this an idle agent with a dead client lingers).
    if (pruned) this.maybeStartIdleTimer();
  }

  /** Send a pre-serialized payload to every attached client. */
  sendToClients(data: string) {
    let pruned = false;
    for (const ws of this.clients) {
      if (ws.readyState !== 1) { this.clients.delete(ws); pruned = true; continue; }
      try {
        if (Number(ws.send(data)) < 0) { this.clients.delete(ws); pruned = true; try { ws.close(1011, "Backpressure"); } catch {} }
      } catch { this.clients.delete(ws); pruned = true; }
    }
    if (pruned) this.maybeStartIdleTimer();
  }

  private handleAgentMessage(msg: WSServerMessage) {
    this.noteActivity(msg);
    this.broadcast(msg);
    // #LIVE: remember the last *blocking* extension_ui_request so we can
    // replay it to a client that reconnects after a refresh/leave. PI blocks
    // on these until answered; losing the only client that saw the request
    // would otherwise wedge the run forever.
    if (msg.type === "extension_ui_request") {
      const method = (msg as any).ui?.method;
      if (["select", "confirm", "input", "editor"].includes(method)) {
        this.pendingDialog = msg;
      }
    }
    // #REATTACH: rekey UNCONDITIONALLY (not gated on the sessions-changed
    // handler being registered) — the rekey is what keeps a reconnect
    // attached to the right agent; depending on the UI-refresh handler for it
    // would silently desync the keys if that handler were ever null.
    const cwd = agentKeyCwd(this.agentKey);
    if (cwd) {
      if (msg.type === "state") {
        const sessionFile = (msg as any).data?.sessionFile;
        if (this.isPendingNewSession && sessionFile) {
          // M1: only clear isPendingNewSession on a SUCCESSFUL rekey — if the
          // target key is occupied (rekeyAgent refused), keep the flag so a
          // later state event retries instead of stranding the agent at
          // __new__ forever (undiscoverable by sessionPath reconnect).
          if (this.rekeyToSessionPath(cwd, sessionFile)) {
            this.isPendingNewSession = false;
            projectSessionsChangedHandler?.(cwd);
          }
        } else if (this.isPendingCloneRekey) {
          // #CLONE: SDK rebinding to the forked session reports it via get_state.
          // Rekey to the NEW path the moment it differs from our current key so a
          // reconnect lands on THIS agent. Only clear the flag on success (M1).
          const currentPath = agentKeySessionPath(this.agentKey);
          if (sessionFile && sessionFile !== currentPath) {
            if (this.rekeyToSessionPath(cwd, sessionFile)) {
              this.isPendingCloneRekey = false;
              projectSessionsChangedHandler?.(cwd);
            }
          }
        }
      } else if (msg.type === "session_loaded") {
        // #REATTACH: switch_session / load_session switch the runtime to a
        // DIFFERENT session in-place (used by the clone flow). The client
        // rekeys its pool entry to the loaded filePath (App.handleSessionLoaded),
        // so the SERVER must rekey too — otherwise the keys desync and a
        // reconnect spawns a fresh agent, orphaning this in-process-switched
        // runtime (and running two agents on the cloned session file -> corruption).
        const loadedPath = (msg as any).session?.filePath;
        if (loadedPath) this.rekeyToSessionPath(cwd, loadedPath);
        // #SDK-MIGRATION (M2+H6 interaction): new_session ALSO emits
        // session_loaded (M2, for deterministic rekey), and it fires while
        // isPendingNewSession is still true. Clearing originalNewSessionId here
        // would break the #REATTACH reverse-lookup for a WS that drops during
        // the new-session resolution window — orphaning the live agent and
        // spawning a duplicate. Only invalidate the new-session token for an
        // EXPLICIT switch away (load/switch/clone/fork), which arrives AFTER
        // the new session has resolved (isPendingNewSession == false, cleared
        // by the `state` branch above).
        if (!this.isPendingNewSession) this.originalNewSessionId = null;
        projectSessionsChangedHandler?.(cwd);
      } else if (msg.type === "clone_result") {
        // #CLONE: clone forks to a new session file; the SDK resolves it but
        // we still arm the poll as a safety net in case the state-driven
        // rekey hasn't landed yet.
        // ponytail: !cancelled gates it (a failed clone just polls harmlessly; the
        // state branch's sessionFile!==currentPath guard blocks any spurious rekey).
        if (!(msg as any).cancelled) this.rekeyAfterClone();
      } else if (msg.type === "session_name_changed" || msg.type === "agent_end") {
        projectSessionsChangedHandler?.(cwd);
      }
    }
  }

  /**
   * Rekey this agent's pool entry from its current key to
   * `${cwd}::${normalizeSessionPath(sessionPath)}`. Used for new-session
   * resolution (state.sessionFile) AND in-process session switches
   * (session_loaded from switch_session/load_session). Keeps wsToAgent in
   * sync via the rekey handler so in-flight client sends keep routing here.
   * No-op if the key is unchanged; refuses to clobber a different agent at
   * the target key (rekeyAgent returns null). #REATTACH
   */
  private rekeyToSessionPath(cwd: string, sessionPath: string): boolean {
    const oldKey = this.agentKey;
    const newKey = buildAgentKey(cwd, sessionPath);
    if (newKey === oldKey) return true;
    if (rekeyAgent(oldKey, newKey)) {
      this.rekeyHandler?.(oldKey, newKey);
      return true;
    }
    // #LIVE: rekey refused because a DIFFERENT agent already holds newKey
    // (rekeyAgent returns null without clobbering). Previously this failed
    // SILENTLY — the agent stayed keyed at oldKey while its runtime switched
    // to the target session, risking two runtimes on the same session file.
    // Surface it so the client knows to reconnect cleanly instead of talking
    // to a stranded agent. Returns false so callers keep their pending flag.
    console.error(`[pool] rekey FAILED: ${oldKey} -> ${newKey} (target occupied); agent stranded at ${oldKey}`);
    this.broadcast({ type: "error", message: "Session switch conflict: another agent already holds the target session. Reconnecting." });
    return false;
  }

  /**
   * #CLONE: after a successful clone, the SDK asynchronously rebinds to the
   * forked session file. The state-driven rekey path (isPendingCloneRekey)
   * catches it when get_state reports the new path; this method arms the flag
   * and drives a few get_state polls in case the client never asks for state.
   * Bounded: stops after a few attempts so a stuck session can't loop us.
   */
  private rekeyAfterClone() {
    if (this.isPendingCloneRekey) return;
    this.isPendingCloneRekey = true;
    // The SDK's rebind may land between events — retry a few times with short
    // delays until the forked path lands in state.
    let attempts = 0;
    const poll = () => {
      if (!this.isPendingCloneRekey || attempts++ >= 10) {
        this.isPendingCloneRekey = false;
        return;
      }
      this.agent.getState();
      // Re-check shortly; if the state handler rekeyed it cleared the flag and
      // we stop. Otherwise try again.
      setTimeout(poll, 400);
    };
    setTimeout(poll, 200);
  }
  private noteActivity(msg: WSServerMessage) {
    this.lastActivityAt = Date.now();
    if (msg.type === "agent_start") {
      this.streaming = true;
      // #LIVE: begin watching for a wedged run (no activity + no clients).
      this.startWatchdog();
    } else if (msg.type === "agent_end") {
      this.streaming = false;
      this.runningTools.clear();
      // #LIVE: the run finished — any blocking dialog is moot now, and the
      // watchdog has nothing left to watch.
      this.pendingDialog = null;
      this.cancelWatchdog();
      this.maybeStartIdleTimer();
    } else if (msg.type === "tool_start") {
      this.runningTools.add(msg.toolCallId);
    } else if (msg.type === "tool_end") {
      this.runningTools.delete(msg.toolCallId);
      this.maybeStartIdleTimer();
    } else if (msg.type === "state" && "isStreaming" in msg.data) {
      this.streaming = msg.data.isStreaming || false;
      if (!this.streaming) this.runningTools.clear();
      this.maybeStartIdleTimer();
    }
  }

  private isActive(): boolean {
    return this.streaming || this.runningTools.size > 0;
  }

  private maybeStartIdleTimer() {
    this.cancelIdleTimer();
    if (this.clients.size > 0 || this.isActive()) return;
    console.log(`[pool] agent ${this.agentKey} idle, starting ${this.idleTimeoutMs / 1000}s timeout`);
    this.idleTimer = setTimeout(async () => {
      // H1: re-check (a client may have attached between arming and firing).
      if (this.clients.size > 0 || this.isActive()) return;
      // H1: delete the pool entry + close clients BEFORE awaiting agent.stop()
      // (the forceStopAndRemove pattern). Previously the entry stayed during the
      // I/O-yielding dispose, so a reconnecting client attached to this dying
      // agent and was then kicked by the exit handler — losing the live
      // in-memory state. With the entry gone, a reconnect spawns a fresh agent.
      agentPool.delete(this.agentKey);
      this.closeClients();
      try { await this.agent.stop(); } catch (err: any) {
        console.error(`[pool] idle stop error for ${this.agentKey}:`, err.message);
      }
    }, this.idleTimeoutMs);
  }

  private cancelIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  // #LIVE: watchdog — reaps an agent that is "streaming" but has gone
  // silent with no clients attached. The idle timer can't catch this (it only
  // arms when !isActive()); without the watchdog a hung run lingers in the
  // pool forever, holding the session, and the only recovery is a server
  // reboot. The watchdog self-cancels once the run goes idle or a client
  // reattaches; if it goes stale it force-stops the agent.
  private startWatchdog() {
    this.cancelWatchdog();
    // Tick at most once per minute, but no coarser than the stale window so a
    // tiny test window still trips the watchdog promptly.
    const tick = Math.min(WATCHDOG_TICK_MS, this.staleStreamingMs);
    this.watchdogTimer = setInterval(() => {
      const stale = Date.now() - this.lastActivityAt > this.staleStreamingMs;
      if (stale && this.clients.size === 0 && this.isActive()) {
        console.warn(`[pool] agent ${this.agentKey} wedged (streaming, no activity, no clients) — force-stopping`);
        this.pendingDialog = null;
        this.forceStopAndRemove();
      }
    }, tick);
  }

  private cancelWatchdog() {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  // #LIVE: stop a possibly-unresponsive agent and drop it from the pool.
  // The SDK session may spawn child processes (bash, dev servers, …); we
  // tree-kill the tracked spawned-tool process tree on the escalation path so
  // they don't survive the stop and leak.
  async forceStopAndRemove() {
    this.cancelWatchdog();
    this.cancelIdleTimer();
    // #LIVE: delete the pool entry BEFORE awaiting agent.stop() so a client
    // that reconnects during the (I/O-yielding) dispose can't attach to this
    // dying agent and then get kicked by the exit handler — losing the live
    // in-memory session state. With the entry gone, a reconnect spawns a fresh
    // agent that reloads the session from disk.
    agentPool.delete(this.agentKey);
    this.closeClients();
    try { await this.agent.stop(); } catch (err: any) {
      console.error(`[pool] force-stop error for ${this.agentKey}:`, err.message);
    }
  }
}

// ─── Agent Pool ───
// Global singleton. Keys are `${cwd}::${sessionPath || "__new__"}` —
// one agent per (project, session) tuple so multiple sessions in the same
// project can run concurrently and keep streaming while the user navigates
// away.

const agentPool = new Map<string, PooledAgent>();

let projectSessionsChangedHandler: ((cwd: string) => void) | null = null;

/**
 * Register the project-sessions-changed handler. The handler may be async;
 * we wrap it so a rejection can never become an unhandledRejection that
 * crashes the whole server (and every other pooled agent with it). #5
 */
export function setProjectSessionsChangedHandler(handler: (cwd: string) => void | Promise<void>) {
  projectSessionsChangedHandler = (cwd) => {
    try {
      Promise.resolve(handler(cwd)).catch(e => console.error('[sessions] handler rejected', e));
    } catch (e) {
      console.error('[sessions] handler threw', e);
    }
  };
}

function agentKeyCwd(key: string): string | null {
  const parts = key.split("::");
  return parts[0] || null;
}
// #CLONE: the sessionPath half of a pool key (everything after the first `::`).
// Used to detect when a post-clone get_state reports a DIFFERENT path than the
// one we're keyed under, so we can rekey to the forked session.
function agentKeySessionPath(key: string): string | null {
  const idx = key.indexOf("::");
  if (idx < 0) return null;
  const rest = key.slice(idx + 2);
  return rest.startsWith("__new__") ? null : rest;
}

export function broadcastToProjectClients(cwd: string, msg: WSServerMessage) {
  const prefix = `${cwd}::`;
  const data = JSON.stringify(msg);
  for (const [key, agent] of agentPool) {
    if (key.startsWith(prefix)) {
      agent.sendToClients(data);
    }
  }
}

/**
 * Snapshot every live agent keyed under `${cwd}::` — used by the
 * live-session recovery endpoint (GET /api/projects/:id/live-sessions) so a
 * cache-cleared refresh can reattach to a still-running session it has no
 * client-side handle for. Sorted most-recently-active first.
 *
 * Includes agents that are streaming, compacting, have attached clients, OR
 * were active within the idle grace window. Genuinely-stale idle agents are
 * excluded (the idle timer reaps them). Anything returned here is a session
 * the user could legitimately still want back.
 */
export function getLiveSessionsForCwd(cwd: string): LiveSessionSnapshot[] {
  const prefix = `${cwd}::`;
  const out: LiveSessionSnapshot[] = [];
  for (const [key, agent] of agentPool) {
    if (!key.startsWith(prefix)) continue;
    const snap = agent.getLiveSnapshot();
    if (!snap) continue;
    out.push(snap);
  }
  out.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return out;
}

/**
 * Periodic sweep (called from a setInterval in the server entry): prune dead
 * sockets from every agent's client set and arm the idle timer if a prune
 * emptied one. Closes the gap for IDLE agents with a half-open client (killed
 * PWA / hard socket error with no onClose) — broadcast only prunes on send, so
 * an idle agent would otherwise keep clients.size > 0 forever and never reap.
 * Also a backstop for the Hono/Bun adapter which wires no onError. (HIGH-3,
 * MEDIUM-1, LOW-2.)
 */
export function sweepPool() {
  for (const agent of agentPool.values()) agent.pruneDeadClients();
}

/**
 * Build the pool key for a (cwd, sessionPath) pair.
 * ponytail: pending-new-session keys embed newSessionId so two concurrent
 * new sessions in the same project don't collapse onto one `__new__` agent.
 * On resolution the agent is rekeyed to the real sessionFile path (see
 * handleAgentMessage).
 * #REATTACH: sessionPath is normalized (trailing slash / `//` / `./` collapsed)
 * so a client that reconnects with a path-equivalent string reattaches to the
 * SAME agent instead of spawning a duplicate that orphans the live one.
 */
export function buildAgentKey(cwd: string, sessionPath: string | null | undefined, newSessionId?: string | null): string {
  if (sessionPath) return `${cwd}::${normalizeSessionPath(sessionPath)}`;
  return `${cwd}::__new__${newSessionId ? `:${newSessionId}` : ""}`;
}

/** Normalize a sessionPath for pool keying: collapse `//`, `./`, resolve `..`,
 * strip trailing slashes. Two path-equivalent strings must produce the same
 * key so a reconnect always finds the existing agent (#REATTACH). */
function normalizeSessionPath(p: string): string {
  // path.normalize handles `//`, `./`, `../`, redundant segments; then drop any
  // trailing slash it leaves behind so `/a/b.json` and `/a/b.json/` collide.
  const n = normalize(p).replace(/\/+$/, "") || p;
  // M3: resolve symlinks so a session opened via a symlinked path and one opened
  // via its real path produce the SAME key (onOpen uses the raw client path;
  // load_session/switch_session use realpathSync). Without this a reconnect by
  // the symlink path misses the rekeyed agent and spawns a duplicate. realpath
  // only applies to existing files; new-session paths (null) never reach here.
  try { return realpathSync(n); } catch { return n; }
}

/** Pull the <uuid> out of a pending `__new__:<uuid>` key (or null).
 * Uses lastIndexOf so a cwd that itself contains `__new__:` (unusual but valid
 * on POSIX) can't corrupt the extracted id and break the #REATTACH reverse
 * lookup (which would then spawn a duplicate on a stale-newSessionId reconnect). */
function extractNewSessionId(key: string): string | null {
  const i = key.lastIndexOf("__new__:");
  return i === -1 ? null : key.slice(i + "__new__:".length);
}


export function getOrCreateAgent(
  cwd: string,
  sessionPath: string | null,
  newSessionId?: string | null,
  provider?: string,
  model?: string,
  // ponytail: test injection — lets tests drive the real module pool with a
  // FakeAgent instead of constructing an SDK session. Defaults to the real SDKAgent.
  createAgent?: (options: PIAgentOptions) => IPIAgent,
): { agent: PooledAgent; isNew: boolean } {
  const key = buildAgentKey(cwd, sessionPath, newSessionId);
  const existing = agentPool.get(key);
  if (existing) {
    console.log(`[pool] reusing existing agent ${key} (${existing.clientCount} clients)`);
    return { agent: existing, isNew: false };
  }

  // #REATTACH: a pending new session may have already resolved and been rekeyed
  // from `__new__:<uuid>` to its real sessionFile. A client whose WS dropped
  // before it processed the rekey will reconnect with the ORIGINAL newSessionId;
  // without this reverse lookup it would spawn a 2nd agent and orphan the live
  // one. Scan is O(pool size) — small, and only hit on the rare stale reconnect.
  if (!sessionPath && newSessionId) {
    for (const a of agentPool.values()) {
      if (a.originalNewSessionId === newSessionId) {
        console.log(`[pool] reattaching to rekeyed agent by newSessionId=${newSessionId} -> ${a.getKey()}`);
        return { agent: a, isNew: false };
      }
    }
  }

  console.log(`[pool] creating new agent ${key}`);
  const pooled = new PooledAgent(key, {
    cwd,
    sessionPath: sessionPath || undefined,
    provider: provider || undefined,
    model: model || undefined,
  }, createAgent);
  agentPool.set(key, pooled);
  return { agent: pooled, isNew: true };
}

/** Lookup an existing agent by key (returns null if not found) */
export function lookupAgent(agentKey: string): PooledAgent | null {
  return agentPool.get(agentKey) || null;
}

/** Lookup an existing agent by (cwd, sessionPath). */
export function lookupAgentBySessionKey(cwd: string, sessionPath: string | null | undefined): PooledAgent | null {
  return agentPool.get(buildAgentKey(cwd, sessionPath)) || null;
}

/** Detach a client from an agent by key */
export function detachFromAgent(agentKey: string, ws: ServerWebSocket) {
  const agent = agentPool.get(agentKey);
  if (agent) agent.detach(ws);
}

/**
 * Delete an agent from the pool AND stop its underlying session.
 * #REATTACH: previously this only removed the pool entry without stopping the
 * session, leaving a live session with no pool entry — the client could NEVER
 * reattach (a reconnect would spawn a duplicate). Now it stops the agent so
 * no orphaned session lingers. Callers: start-failure cleanup, project deletion.
 */
export function deleteFromPool(agentKey: string) {
  const agent = agentPool.get(agentKey);
  agentPool.delete(agentKey);
  if (agent) {
    // Fire-and-forget the async stop; the pool entry is already gone so a
    // reconnect won't reuse it.
    agent.stop().catch((e) => console.error(`[pool] deleteFromPool stop error for ${agentKey}:`, e));
  }
}

/** Stop every agent whose key starts with `${cwd}::` (project deletion).
 * #REATTACH: project deletion previously called deleteFromPool(project.path)
 * with the BARE cwd, but keys are `${cwd}::${sessionPath}` — so it matched
 * nothing and left every agent for the project running in the pool. This stops
 * them all cleanly. */
export function stopAgentsForCwd(cwd: string) {
  const prefix = `${cwd}::`;
  for (const [key, agent] of Array.from(agentPool.entries())) {
    if (key.startsWith(prefix)) {
      agentPool.delete(key);
      agent.stop().catch((e) => console.error(`[pool] stopAgentsForCwd stop error for ${key}:`, e));
    }
  }
}

/**
 * Move an agent from one pool key to another. Used when a new session gets
 * its real file path and the pool entry is re-keyed from `__new__` to the
 * real path. Returns the moved agent, or null if the old key was not found.
 */
export function rekeyAgent(oldKey: string, newKey: string): PooledAgent | null {
  if (oldKey === newKey) return agentPool.get(oldKey) || null;
  const agent = agentPool.get(oldKey);
  if (!agent) return null;
  // If a different agent already exists at newKey, leave it alone and
  // return null — the caller should decide how to resolve the conflict.
  if (agentPool.has(newKey)) return null;
  agentPool.delete(oldKey);
  agentPool.set(newKey, agent);
  agent.setKey(newKey);
  console.log(`[pool] rekeyed agent ${oldKey} -> ${newKey}`);
  return agent;
}

export function getPoolStats() {
  return {
    agents: agentPool.size,
    details: Array.from(agentPool.entries()).map(([key, a]) => ({
      key,
      clients: a.clientCount,
    })),
  };
}

/** Stop all agents (for graceful shutdown) */
export async function stopAllAgents() {
  const promises = Array.from(agentPool.values()).map(a => a.stop());
  await Promise.all(promises);
}

// ponytail: test-only escape hatch so the pool's module-level state can be
// reset between tests. Not for production use.
export function _resetPoolForTesting() {
  for (const a of agentPool.values()) { try { a.closeClients(); } catch {} }
  agentPool.clear();
}

// ─── SDKAgent (internal, wraps an in-process AgentSession + AgentSessionRuntime) ───
//
// Replaces the former `pi --mode rpc` subprocess wrapper. The server now
// drives PI's SDK directly in-process: no stdin/stdout JSONL, no subprocess
// management, no readline/U+2028 framing bug. AgentSession.subscribe gives us
// typed events; AgentSessionRuntime gives atomic newSession/switchSession/
// fork/clone that resolve the new sessionFile synchronously — eliminating the
// get_state-polling and key-desync hacks the subprocess required.

export interface PIAgentOptions {
  cwd: string;
  sessionPath?: string;
  model?: string;
  provider?: string;
}

// Dialog methods that block the agent until the client answers. Tracked for
// replay-on-reconnect (see PooledAgent.pendingDialog).
const BLOCKING_DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

// ponytail: one shared AuthStorage/ModelRegistry/SettingsManager for the whole
// process — credentials and custom models live in ~/.pi/agent. SDK reads the
// same files the CLI does, so behavior is identical to `pi --mode rpc`.
let sharedAuthStorage: ReturnType<typeof AuthStorage.create> | null = null;
let sharedModelRegistry: ModelRegistry | null = null;
function getSharedAuth() {
  if (!sharedAuthStorage) sharedAuthStorage = AuthStorage.create();
  return sharedAuthStorage;
}
function getSharedModelRegistry() {
  if (!sharedModelRegistry) sharedModelRegistry = ModelRegistry.create(getSharedAuth());
  return sharedModelRegistry;
}

export class SDKAgent implements IPIAgent {
  private onMessage: ((msg: WSServerMessage) => void) | null = null;
  private onExit: ((code: number | null) => void) | null = null;
  private runtime: AgentSessionRuntime | null = null;
  private session: AgentSession | null = null;
  private unsubscribe: (() => void) | null = null;
  private explicitlyStopped = false;
  private started = false;
  // #LIVE: dedupe concurrent stop() calls (idle timer + shutdown racing) so
  // runtime.dispose() isn't driven twice on the same runtime and onExit doesn't
  // fire twice. A second caller awaits the in-flight stop.
  private stopPromise: Promise<void> | null = null;
  // Extension UI dialogs awaiting a client response, keyed by request id.
  // Mirrors runRpcMode's pendingExtensionRequests. Fire-and-forget UI methods
  // (notify/setStatus/...) are not tracked — they just broadcast.
  private pendingDialogs = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void; timer: Timer | null }>();

  constructor(private options: PIAgentOptions) {}

  setHandler(handler: (msg: WSServerMessage) => void) { this.onMessage = handler; }
  setExitHandler(handler: (code: number | null) => void) { this.onExit = handler; }
  getOptions(): PIAgentOptions { return this.options; }

  getLiveSnapshot(): LiveSessionSnapshot | null {
    const s = this.session;
    if (!s) return null;
    const file = s.sessionFile;
    if (!file) return null;
    return {
      sessionPath: file,
      sessionId: s.sessionId,
      sessionName: s.sessionName ?? null,
      isStreaming: s.isStreaming,
      isCompacting: s.isCompacting,
      clientCount: 0, // filled in by PooledAgent
      lastActivityAt: Date.now(),
    };
  }

  /** Build the runtime factory the SDK uses for newSession/switchSession/fork.
   * Each replacement rebuilds cwd-bound services (resource loader, settings,
   * model registry) for the effective cwd — same as the CLI. */
  private buildRuntimeFactory(): CreateAgentSessionRuntimeFactory {
    const opts = this.options;
    return async ({ cwd, sessionManager, sessionStartEvent }) => {
      const services = await createAgentSessionServices({
        cwd,
        agentDir: getAgentDir(),
        authStorage: getSharedAuth(),
        modelRegistry: getSharedModelRegistry(),
      });
      return {
        ...(await createAgentSessionFromServices({
          services,
          sessionManager,
          sessionStartEvent,
        })),
        services,
        diagnostics: services.diagnostics,
      };
    };
  }

  /** Resolve an initial model from the provider/model options. Returns undefined
   * to let the SDK pick the default (restored from session, or first available).
   * ponytail: uses only public registry APIs (find/getAvailable) instead of the
   * non-exported parseModelPattern. Handles `provider/id`, bare ids, and bare
   * provider names — enough for the server's --model/--provider params. */
  private async resolveInitialModel(): Promise<Model<any> | undefined> {
    const { provider, model } = this.options;
    if (!provider && !model) return undefined;
    const registry = getSharedModelRegistry();
    const available = registry.getAvailable();
    if (provider && model) {
      // Exact provider/id lookup.
      const exact = registry.find(provider, model);
      if (exact) return exact;
    }
    if (model) {
      // Bare id (possibly with a `:thinking` suffix the SDK ignores here —
      // the CLI's thinking-from-pattern is handled by setThinkingLevel later).
      const bare = model.split(":")[0];
      const match = available.find((m) => m.id === bare || m.id === model);
      if (match && (!provider || match.provider === provider)) return match;
    }
    if (provider) {
      // Only provider given — pick the first available for that provider.
      return available.find((m) => m.provider === provider);
    }
    return undefined;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.explicitlyStopped = false;
    const { cwd, sessionPath } = this.options;
    // `--session <path>` -> SessionManager.open; no path -> SessionManager.create (new).
    // Same semantics as the CLI (dist/main.js).
    const sessionManager = sessionPath
      ? SessionManager.open(sessionPath)
      : SessionManager.create(cwd);
    const runtime = await createAgentSessionRuntime(this.buildRuntimeFactory(), {
      cwd,
      agentDir: getAgentDir(),
      sessionManager,
    });
    this.runtime = runtime;
    // Resolve + set initial model BEFORE binding extensions so the first prompt
    // has a valid model (SDK throws if no model/auth when streaming starts).
    const initialModel = await this.resolveInitialModel();
    if (initialModel) {
      try { await runtime.session.setModel(initialModel); } catch (err: any) {
        // Non-fatal: SDK falls back to default/available. Surface the warning.
        console.warn(`[pi] initial model set failed: ${err.message}`);
      }
    }
    await this.bindSession(runtime.session);
  }

  /** Bind to a session: subscribe to events, wire extension UI context. Used on
   * initial start AND after runtime.newSession/switchSession/fork/clone. */
  private async bindSession(session: AgentSession): Promise<void> {
    // Tear down the previous binding if any.
    this.unsubscribe?.();
    this.session = session;
    this.unsubscribe = session.subscribe((event) => this.handleEvent(event));
    // Extension UI context: dialog methods block on a client response we track
    // in pendingDialogs; fire-and-forget methods just broadcast. Mirrors
    // runRpcMode's createExtensionUIContext.
    await session.bindExtensions({
      uiContext: this.createExtensionUIContext(),
      onError: (err) => {
        this.onMessage?.({
          type: "extension_error",
          extensionPath: err.extensionPath || "",
          event: err.event || "",
          error: err.error || "",
        });
      },
    });
  }

  private createExtensionUIContext(): ExtensionUIContext {
    const self = this;
    const handler = () => self.onMessage;
    return {
      async select(title, options, opts) {
        return self.runDialog<string | undefined>(
          { method: "select", title, options, timeout: opts?.timeout },
          (r: any) => (r.cancelled ? undefined : r.value),
          opts?.timeout,
        );
      },
      async confirm(title, message, opts) {
        return self.runDialog<boolean>(
          { method: "confirm", title, message, timeout: opts?.timeout },
          (r: any) => (r.cancelled ? false : !!r.confirmed),
          opts?.timeout,
        );
      },
      async input(title, placeholder, opts) {
        return self.runDialog<string | undefined>(
          { method: "input", title, placeholder, timeout: opts?.timeout },
          (r: any) => (r.cancelled ? undefined : r.value),
          opts?.timeout,
        );
      },
      notify(message, type) {
        handler()?.({ type: "extension_ui_request", ui: { id: cryptoId(), method: "notify", message, notifyType: type } });
      },
      onTerminalInput() { return () => {}; },
      setStatus(key, text) {
        handler()?.({ type: "extension_ui_request", ui: { id: cryptoId(), method: "setStatus", statusKey: key, statusText: text } });
      },
      setWorkingMessage() {},
      setWorkingVisible() {},
      setWorkingIndicator() {},
      setHiddenThinkingLabel() {},
      setWidget(key, content, options) {
        // Only string arrays supported (component factories require TUI).
        if (content === undefined || Array.isArray(content)) {
          handler()?.({
            type: "extension_ui_request",
            ui: { id: cryptoId(), method: "setWidget", widgetKey: key, widgetLines: content, widgetPlacement: options?.placement },
          });
        }
      },
      setFooter() {},
      setHeader() {},
      setTitle(title) {
        handler()?.({ type: "extension_ui_request", ui: { id: cryptoId(), method: "setTitle", title } });
      },
      async custom<T>(_factory: any, _options?: any): Promise<T> { return undefined as T; },
      pasteToEditor(text) { this.setEditorText(text); },
      setEditorText(text) {
        handler()?.({ type: "extension_ui_request", ui: { id: cryptoId(), method: "set_editor_text", text } });
      },
      getEditorText() { return ""; },
      async editor(title, prefill) {
        return self.runDialog<string | undefined>(
          { method: "editor", title, prefill },
          (r: any) => (r.cancelled ? undefined : r.value),
        );
      },
      addAutocompleteProvider() {},
      setEditorComponent() {},
      getEditorComponent() { return undefined; },
      get theme() { return getHeadlessTheme(); },
      getAllThemes() { return []; },
      getTheme() { return getHeadlessTheme(); },
      setTheme() { return { success: false, error: "Theme switching not supported in this mode" }; },
      getToolsExpanded() { return false; },
      setToolsExpanded() {},
    };
  }

  /** Drive a blocking extension dialog: broadcast the request, wait for the
   * matching extension_ui_response, resolve/reject the extension's promise.
   * If a timeout is given, resolve with the default after it elapses (the SDK
   * contract: the agent auto-resolves; we emulate that here). */
  private runDialog<T>(
    request: Record<string, unknown>,
    parse: (response: any) => T,
    timeout?: number,
  ): Promise<T> {
    const id = cryptoId();
    return new Promise<T>((resolve, reject) => {
      const entry = {
        resolve: (response: any) => {
          if (entry.timer) clearTimeout(entry.timer);
          this.pendingDialogs.delete(id);
          try { resolve(parse(response)); } catch (e) { reject(e); }
        },
        reject: (e: any) => {
          if (entry.timer) clearTimeout(entry.timer);
          this.pendingDialogs.delete(id);
          reject(e);
        },
        timer: null as Timer | null,
      };
      this.pendingDialogs.set(id, entry);
      if (timeout) {
        entry.timer = setTimeout(() => {
          // SDK contract: timeout auto-resolves with the default value.
          entry.resolve({ cancelled: true });
        }, timeout);
      }
      this.onMessage?.({
        type: "extension_ui_request",
        ui: { id, ...request } as any,
      });
    });
  }

  getState() { this.doSend({ type: "get_state" }); }

  doSend(msg: unknown) {
    if (!this.session || !this.runtime) {
      // E5: previously dropped silently. Surface an error so the client knows its
      // command (a prompt during the startup window, or a reconnect racing
      // start()) was not delivered — instead of looking sent while PI never got it.
      const command = (msg as any)?.type ?? "unknown";
      this.onMessage?.({ type: "response", command, success: false, error: "Agent not ready" });
      return;
    }
    // Fire-and-forget; errors surface as `error` messages to the client.
    this.handleCommand(msg).catch((err) => {
      console.error("[pi] command error:", err);
      const command = (msg as any)?.type ?? "unknown";
      this.onMessage?.({ type: "response", command, success: false, error: err?.message ?? String(err) });
    });
  }

  /** Resolve an extension_ui_response to the waiting dialog promise. */
  private resolveDialogResponse(response: any) {
    const pending = this.pendingDialogs.get(response.id);
    if (pending) {
      this.pendingDialogs.delete(response.id);
      pending.resolve(response);
    }
    // Unknown id (e.g. response to an already-timed-out dialog) — drop silently.
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this._stop();
    try { await this.stopPromise; } finally { this.stopPromise = null; }
  }

  private async _stop(): Promise<void> {
    this.explicitlyStopped = true;
    // Reject any pending dialogs so extensions don't hang.
    for (const [, entry] of this.pendingDialogs) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new Error("Agent stopped"));
    }
    this.pendingDialogs.clear();
    this.unsubscribe?.();
    this.unsubscribe = null;
    // #SDK-MIGRATION: runtime.dispose() only disconnects event listeners; it
    // does NOT abort the in-flight turn. Subprocess-era tree-kill ended
    // everything; the in-process SDK would otherwise keep streaming (LLM calls,
    // tool execution) with no listener — burning credits and running tools after
    // the user intended to stop. Abort the turn first (bounded by
    // PooledAgent.stop()'s 5s race).
    if (this.session) {
      try { await this.session.abort(); } catch {}
    }
    if (this.runtime) {
      try { await this.runtime.dispose(); } catch (err: any) {
        console.error(`[pi] dispose error:`, err.message);
      }
    }
    this.runtime = null;
    this.session = null;
    this.started = false;
    // Surface an exit so the pool cleans up (closes clients, deletes entry).
    // Code 0 = clean stop.
    this.onExit?.(0);
  }

  // ─── Event translation: AgentSessionEvent -> WSServerMessage ───
  // The SDK event names match PI's RPC events 1:1 (agent_start, message_update,
  // tool_execution_start, …). We normalize a few SDK-specific shapes
  // (message_update delta, compaction/session_info/thinking_level events,
  // agent_end's extra willRetry field) into the client's WSServerMessage.
  private handleEvent(event: AgentSessionEvent) {
    const handler = this.onMessage;
    if (!handler) return;
    try {
      switch (event.type) {
        case "agent_start":
          handler({ type: "agent_start" });
          break;
        case "agent_end":
          handler({ type: "agent_end", messages: event.messages as any });
          break;
        case "turn_start":
          handler({ type: "turn_start" });
          break;
        case "turn_end":
          handler({ type: "turn_end", message: event.message as any, toolResults: event.toolResults as any });
          break;
        case "message_start":
          handler({ type: "message_start", message: event.message as any });
          break;
        case "message_update": {
          const delta = event.assistantMessageEvent as any;
          if (delta) {
            handler({
              type: "message_update",
              message: event.message as any,
              delta: {
                type: delta.type,
                contentIndex: delta.contentIndex ?? 0,
                delta: delta.delta ?? "",
                ...(delta.type === "toolcall_end" ? { toolCall: delta.toolCall } : {}),
              },
            });
          }
          break;
        }
        case "message_end":
          handler({ type: "message_end", message: event.message as any });
          break;
        case "tool_execution_start":
          handler({ type: "tool_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args || {} });
          break;
        case "tool_execution_update":
          handler({ type: "tool_update", toolCallId: event.toolCallId, partialResult: event.partialResult || { content: [], details: undefined } });
          break;
        case "tool_execution_end":
          handler({ type: "tool_end", toolCallId: event.toolCallId, toolName: event.toolName, result: event.result || { content: [] }, isError: event.isError || false });
          break;
        case "queue_update":
          handler({ type: "queue_update", steering: [...event.steering], followUp: [...event.followUp] });
          break;
        case "compaction_start":
          handler({ type: "compaction_start", reason: event.reason });
          break;
        case "compaction_end":
          handler({
            type: "compaction_end",
            reason: event.reason,
            result: event.result as any,
            aborted: event.aborted,
            willRetry: event.willRetry,
            errorMessage: event.errorMessage,
          });
          break;
        case "session_info_changed":
          handler({ type: "session_name_changed", name: event.name ?? "" });
          break;
        case "thinking_level_changed":
          handler({ type: "thinking_changed", level: event.level });
          break;
        case "auto_retry_start":
          handler({ type: "auto_retry_start", attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs, errorMessage: event.errorMessage });
          break;
        case "auto_retry_end":
          handler({ type: "auto_retry_end", success: event.success, attempt: event.attempt, finalError: event.finalError });
          break;
        // extension_error is emitted via the extension runner's onError, not as
        // a session event — handled in bindExtensions above via onError binding.
      }
    } catch (err) {
      console.error("[pi] event handler error:", err);
    }
  }

  // ─── Command dispatch: WSServerMessage-shaped commands -> SDK calls ───
  // Mirrors runRpcMode's handleCommand. Each command resolves to one or more
  // WSServerMessage responses broadcast to the client.
  private async handleCommand(msg: any) {
    const session = this.session;
    const runtime = this.runtime;
    if (!session || !runtime) return;
    switch (msg.type) {
      // ── Prompting ──
      case "prompt": {
        // Fire the prompt; emit the success response after preflight acceptance.
        let preflightSucceeded = false;
        try {
          await session.prompt(msg.message, {
            images: msg.images,
            streamingBehavior: msg.streamingBehavior,
            source: "rpc",
            preflightResult: (ok) => {
              if (ok) {
                preflightSucceeded = true;
                this.onMessage?.({ type: "response", command: "prompt", success: true });
              }
            },
          });
        } catch (e: any) {
          if (!preflightSucceeded) {
            this.onMessage?.({ type: "response", command: "prompt", success: false, error: e.message });
          }
        }
        break;
      }
      case "steer":
        await session.steer(msg.message, msg.images);
        this.onMessage?.({ type: "response", command: "steer", success: true });
        break;
      case "follow_up":
        await session.followUp(msg.message, msg.images);
        this.onMessage?.({ type: "response", command: "follow_up", success: true });
        break;
      case "clear_queue":
        session.clearQueue();
        this.onMessage?.({ type: "response", command: "clear_queue", success: true });
        break;
      case "abort":
        await session.abort();
        this.onMessage?.({ type: "response", command: "abort", success: true });
        break;

      // ── State ──
      case "get_state":
        this.onMessage?.({ type: "state", data: this.snapshotState() });
        break;
      case "get_messages":
        this.onMessage?.({ type: "messages_result", messages: session.messages as any });
        break;
      case "get_last_assistant_text":
        this.onMessage?.({ type: "last_assistant_text_result", text: session.getLastAssistantText() ?? null });
        break;
      case "get_session_stats":
        this.onMessage?.({ type: "session_stats", stats: session.getSessionStats() as any });
        break;

      // ── Model ──
      case "set_model": {
        const models = await session.modelRegistry.getAvailable();
        const model = models.find((m: any) => m.provider === msg.provider && m.id === msg.modelId);
        if (!model) {
          this.onMessage?.({ type: "response", command: "set_model", success: false, error: `Model not found: ${msg.provider}/${msg.modelId}` });
          break;
        }
        await session.setModel(model);
        // model_changed is emitted as an event by the SDK; also send a response.
        this.onMessage?.({ type: "response", command: "set_model", success: true });
        break;
      }
      case "cycle_model": {
        const result = await session.cycleModel();
        if (result) {
          this.onMessage?.({ type: "model_changed", provider: result.model.provider, modelId: result.model.id });
          if (result.thinkingLevel) this.onMessage?.({ type: "thinking_changed", level: result.thinkingLevel });
        }
        this.onMessage?.({ type: "response", command: "cycle_model", success: true });
        break;
      }
      case "get_available_models": {
        const models = await session.modelRegistry.getAvailable();
        this.onMessage?.({
          type: "available_models",
          models: models.map((m: any) => ({
            id: m.id, name: m.name, api: m.api, provider: m.provider,
            contextWindow: m.contextWindow, maxTokens: m.maxTokens,
            reasoning: m.reasoning, input: m.input, cost: m.cost,
          })),
        });
        break;
      }

      // ── Thinking ──
      case "set_thinking_level":
        session.setThinkingLevel(msg.level);
        this.onMessage?.({ type: "thinking_changed", level: msg.level });
        this.onMessage?.({ type: "response", command: "set_thinking_level", success: true });
        break;
      case "cycle_thinking_level": {
        const level = session.cycleThinkingLevel();
        if (level) this.onMessage?.({ type: "thinking_changed", level });
        this.onMessage?.({ type: "response", command: "cycle_thinking_level", success: true });
        break;
      }

      // ── Queue Modes ──
      case "set_steering_mode":
        session.setSteeringMode(msg.mode);
        this.onMessage?.({ type: "response", command: "set_steering_mode", success: true });
        break;
      case "set_follow_up_mode":
        session.setFollowUpMode(msg.mode);
        this.onMessage?.({ type: "response", command: "set_follow_up_mode", success: true });
        break;

      // ── Compaction ──
      case "compact":
        await session.compact(msg.customInstructions);
        this.onMessage?.({ type: "response", command: "compact", success: true });
        break;
      case "set_auto_compaction":
        session.setAutoCompactionEnabled(msg.enabled);
        this.onMessage?.({ type: "response", command: "set_auto_compaction", success: true });
        break;

      // ── Retry ──
      case "set_auto_retry":
        session.setAutoRetryEnabled(msg.enabled);
        this.onMessage?.({ type: "response", command: "set_auto_retry", success: true });
        break;
      case "abort_retry":
        session.abortRetry();
        this.onMessage?.({ type: "response", command: "abort_retry", success: true });
        break;

      // ── Bash ──
      case "bash":
        await session.executeBash(msg.command);
        this.onMessage?.({ type: "response", command: "bash", success: true });
        break;
      case "abort_bash":
        session.abortBash();
        this.onMessage?.({ type: "response", command: "abort_bash", success: true });
        break;

      // ── Session ──
      case "new_session": {
        const result = await runtime.newSession();
        if (!result.cancelled) {
          await this.bindSession(runtime.session);
          // M2: emit session_loaded so the server rekeys to the resolved
          // sessionFile deterministically (same as load_session/switch_session/
          // clone) — instead of racing the 300ms getState(), which could key
          // the agent under the wrong session and make a reconnect spawn a
          // duplicate / orphan the live one.
          if (runtime.session.sessionFile) {
            this.onMessage?.({ type: "session_loaded", session: { filePath: runtime.session.sessionFile } as any });
          }
        }
        this.onMessage?.({ type: "response", command: "new_session", success: !result.cancelled, data: result });
        break;
      }
      case "load_session":
      case "switch_session": {
        const result = await runtime.switchSession(msg.sessionPath);
        if (!result.cancelled) {
          await this.bindSession(runtime.session);
          // session_loaded drives the server-side rekey (PooledAgent.handleAgentMessage).
          this.onMessage?.({
            type: "session_loaded",
            session: { filePath: runtime.session.sessionFile ?? msg.sessionPath } as any,
          });
        }
        this.onMessage?.({ type: "response", command: msg.type, success: !result.cancelled, data: result });
        break;
      }
      case "fork": {
        const result = await runtime.fork(msg.entryId);
        if (!result.cancelled) await this.bindSession(runtime.session);
        // Emit session_loaded so the server rekeys to the forked path (same as
        // clone) — otherwise a reconnect by the new path misses the stale
        // (pre-fork) pool key and spawns a duplicate, orphaning the live fork.
        if (!result.cancelled && runtime.session.sessionFile) {
          this.onMessage?.({ type: "session_loaded", session: { filePath: runtime.session.sessionFile } as any });
        }
        this.onMessage?.({ type: "response", command: "fork", success: !result.cancelled, data: { text: result.selectedText, cancelled: result.cancelled } });
        break;
      }
      case "clone": {
        const leafId = session.sessionManager.getLeafId();
        if (!leafId) {
          this.onMessage?.({ type: "response", command: "clone", success: false, error: "Cannot clone session: no current entry selected" });
          break;
        }
        const result = await runtime.fork(leafId, { position: "at" });
        if (!result.cancelled) await this.bindSession(runtime.session);
        // Emit session_loaded so the server rekeys to the forked path
        // deterministically (same path as switch_session). clone_result is
        // kept for the client's clone-specific UI.
        if (!result.cancelled && runtime.session.sessionFile) {
          this.onMessage?.({ type: "session_loaded", session: { filePath: runtime.session.sessionFile } as any });
        }
        this.onMessage?.({ type: "clone_result", cancelled: result.cancelled, sessionPath: runtime.session.sessionFile });
        this.onMessage?.({ type: "response", command: "clone", success: !result.cancelled, data: { cancelled: result.cancelled } });
        break;
      }
      case "get_fork_messages": {
        const messages = session.getUserMessagesForForking();
        this.onMessage?.({ type: "fork_messages", messages: messages as any });
        break;
      }
      case "set_session_name":
        session.setSessionName(msg.name);
        this.onMessage?.({ type: "response", command: "set_session_name", success: true });
        break;
      case "export_html": {
        const path = await session.exportToHtml(msg.outputPath);
        this.onMessage?.({ type: "export_html_result", path });
        this.onMessage?.({ type: "response", command: "export_html", success: true });
        break;
      }
      case "get_commands": {
        const commands: any[] = [];
        for (const cmd of session.extensionRunner.getRegisteredCommands()) {
          commands.push({ name: cmd.invocationName, description: cmd.description, source: "extension", path: (cmd as any).sourceInfo?.path });
        }
        for (const t of session.promptTemplates) {
          commands.push({ name: t.name, description: t.description, source: "prompt", location: (t as any).sourceInfo?.location, path: (t as any).sourceInfo?.path });
        }
        for (const skill of session.resourceLoader.getSkills().skills) {
          commands.push({ name: `skill:${skill.name}`, description: skill.description, source: "skill", location: (skill as any).sourceInfo?.location, path: (skill as any).sourceInfo?.path });
        }
        this.onMessage?.({ type: "available_commands", commands });
        break;
      }

      // ── Extension UI ──
      case "extension_ui_response":
        this.resolveDialogResponse(msg);
        break;

      default:
        console.warn("[pi] unknown command:", msg.type);
    }
  }

  /** Build an AgentState snapshot from the live session (mirrors runRpcMode's
   * get_state handler). */
  private snapshotState() {
    const session = this.session!;
    const model = session.model as any;
    return {
      isStreaming: session.isStreaming,
      isCompacting: session.isCompacting,
      sessionFile: session.sessionFile ?? null,
      sessionId: session.sessionId,
      sessionName: session.sessionName ?? null,
      model: model?.id ?? null,
      thinkingLevel: session.thinkingLevel,
      messageCount: session.messages.length,
      pendingMessageCount: session.pendingMessageCount,
      steering: session.getSteeringMessages ? [...session.getSteeringMessages()] : [],
      followUp: session.getFollowUpMessages ? [...session.getFollowUpMessages()] : [],
      // #SDK-MIGRATION: forward the in-flight assistant message so a client
      // reattaching mid-stream (refresh / device switch / WS drop) can render
      // the streaming text immediately. Without it the client sees isStreaming
      // with no (or stale) text — the perceived "lost live session".
      streamingMessage: ((session.state.streamingMessage as any) ?? null),
    };
  }
}

/** Small id generator that avoids depending on the browser `crypto.randomUUID`
 * in server contexts where it may be absent. Uses Node's crypto. */
function cryptoId(): string {
  // node:crypto.randomUUID is available on Node 14.17+ / Bun.
  try {
    return (globalThis.crypto as any).randomUUID();
  } catch {
    return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

