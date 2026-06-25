import { normalize, resolve } from "node:path";
import { realpathSync } from "node:fs";
import type { WSServerMessage } from "@pi-web/shared";
import type { ServerWebSocket } from "bun";
import type { Model } from "@earendil-works/pi-ai";
import {
	AuthStorage,
	ModelRegistry,
	SessionManager,
	Theme,
	createAgentSessionServices,
	createAgentSessionFromServices,
	type AgentSessionServices,
	createAgentSessionRuntime,
	getAgentDir,
	initTheme,
	type AgentSession,
	type AgentSessionEvent,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	type ExtensionUIContext,
	type ThemeColor,
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

// The CLI normally seeds the SDK theme via initTheme(). In the headless server
// there is no CLI, so tool renderers that call `ui.theme.fg(...)` would crash
// on an uninitialized theme. Use a minimal fallback Theme instance. The SDK
// exposes `Theme` and `initTheme()` but not a clean theme getter from the main
// package, so we construct the instance directly.
let headlessTheme: Theme | undefined;
function getHeadlessTheme(): Theme {
  if (!headlessTheme) {
    initTheme();
    headlessTheme = new Theme(FALLBACK_THEME_FG, FALLBACK_THEME_BG, "truecolor");
  }
  return headlessTheme;
}

const gray = "#9ca3af";
const FALLBACK_THEME_FG: Record<ThemeColor, string | number> = {
  accent: "#3b82f6",
  border: "#52525b",
  borderAccent: "#3b82f6",
  borderMuted: "#3f3f46",
  success: "#22c55e",
  error: "#ef4444",
  warning: "#f59e0b",
  muted: gray,
  dim: "#71717a",
  text: "#e4e4e7",
  thinkingText: "#a1a1aa",
  userMessageText: "#e4e4e7",
  customMessageText: "#e4e4e7",
  customMessageLabel: "#3b82f6",
  toolTitle: "#e4e4e7",
  toolOutput: "#d4d4d8",
  mdHeading: "#f4f4f5",
  mdLink: "#60a5fa",
  mdLinkUrl: "#93c5fd",
  mdCode: "#f4f4f5",
  mdCodeBlock: "#27272a",
  mdCodeBlockBorder: "#3f3f46",
  mdQuote: "#a1a1aa",
  mdQuoteBorder: "#52525b",
  mdHr: "#52525b",
  mdListBullet: "#d4d4d8",
  toolDiffAdded: "#22c55e",
  toolDiffRemoved: "#ef4444",
  toolDiffContext: "#71717a",
  syntaxComment: "#71717a",
  syntaxKeyword: "#c084fc",
  syntaxFunction: "#60a5fa",
  syntaxVariable: "#e4e4e7",
  syntaxString: "#a3e635",
  syntaxNumber: "#fbbf24",
  syntaxType: "#22d3ee",
  syntaxOperator: "#e4e4e7",
  syntaxPunctuation: "#a1a1aa",
  thinkingOff: gray,
  thinkingMinimal: "#d4d4d8",
  thinkingLow: "#93c5fd",
  thinkingMedium: "#60a5fa",
  thinkingHigh: "#3b82f6",
  thinkingXhigh: "#2563eb",
  bashMode: "#f59e0b",
};
const FALLBACK_THEME_BG = {
  selectedBg: "#27272a",
  userMessageBg: "#18181b",
  customMessageBg: "#18181b",
  toolPendingBg: "#27272a",
  toolSuccessBg: "#052e16",
  toolErrorBg: "#450a0a",
};

export interface IPIAgent {
  setHandler(handler: (msg: WSServerMessage) => void): void;
  setExitHandler(handler: (code: number | null) => void): void;
  setRebindHandler?(handler: (sessionFile: string) => boolean): void;
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
  // #LIVE: the last *blocking* extension_ui_request (select/confirm/input/editor)
  // that PI is waiting on. Replayed to a reconnecting client on attach so a
  // disconnect mid-dialog can't wedge PI forever.
  private pendingDialog: WSServerMessage | null = null;
  // #LIVE: watchdog timer. While an agent is active we keep this ticking; if it
  // goes stale (no activity, no clients) the watchdog force-stops the run.
  private watchdogTimer: Timer | null = null;
  // Boot guard: while agent.start() is in-flight, queue client commands instead
  // of letting doSend() answer "Agent not ready" (which surfaced as spurious
  // error toasts during the startup window). Flushed in start() once the
  // session/runtime exist, so the bootstrap reads (get_state/get_models/...)
  // arrive answered with real data instead of erroring out.
  private booting = true;
  private bootQueue: unknown[] = [];
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
    this.createAgent = createAgent;
    this.agent = createAgent(options);

    // Forward agent messages to clients and track activity for keepalive
    this.agent.setHandler((msg) => this.handleAgentMessage(msg));

    // Register the SDK runtime replacement callback so fork/clone/new/switch
    // rekey the pool synchronously inside the SDK transaction. The SDK provides
    // no public listener, so the underlying agent invokes this callback after
    // it binds to the replacement session.
    this.agent.setRebindHandler?.((sessionFile) => {
      const cwd = agentKeyCwd(this.agentKey);
      if (!cwd) return true;
      const ok = this.rekeyToSessionPath(cwd, sessionFile);
      if (ok && this.isPendingNewSession) this.isPendingNewSession = false;
      projectSessionsChangedHandler?.(cwd);
      return ok;
    });

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
    // Boot complete — flush commands queued during startup so they're answered
    // with real data (state/models/commands/stats/messages) instead of the
    // "Agent not ready" error. Order preserved. Not flushed if start() threw
    // (the pool entry is discarded by the caller, so the queue dies with it).
    this.booting = false;
    const queued = this.bootQueue;
    this.bootQueue = [];
    for (const m of queued) this.agent.doSend(m);
    this.startWatchdog();
    // Send initial state to any already-attached clients
    this.agent.getState();
  }

  /** Attach a WebSocket client. Cancels idle timer if running. */
  attach(ws: ServerWebSocket) {
    this.clients.add(ws);
    this.cancelIdleTimer();
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
   * endpoint. The SDK now resolves the sessionFile synchronously inside its
   * replacement transaction, so the pool is always keyed at the canonical path
   * and no boot-time pending snapshot is needed. */
  getLiveSnapshot(): LiveSessionSnapshot | null {
    const snap = this.agent.getLiveSnapshot();
    if (!snap) return null;
    snap.clientCount = this.clients.size;
    snap.lastActivityAt = this.lastActivityAt;
    // Reflect the pool's authoritative streaming flag (it tracks agent_start/end
    // and tool activity, which may differ from the SDK's momentary read).
    snap.isStreaming = this.streaming || snap.isStreaming;
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
    // Queue while the agent is still booting — flushed in start() once ready.
    if (this.booting) { this.bootQueue.push(msg); return; }
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
    this.bootQueue.length = 0;
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
        // Fallback: if the initial lifecycle rekey didn't fire (e.g. the
        // underlying agent did its own startup path), a state event carrying the
        // real sessionFile still rekeys the pending `__new__` entry.
        if (this.isPendingNewSession && sessionFile) {
          if (this.rekeyToSessionPath(cwd, sessionFile)) this.isPendingNewSession = false;
        }
      } else if (msg.type === "session_loaded") {
        // #REATTACH: switch_session / load_session switch the runtime to a
        // DIFFERENT session in-place. The client rekeys its pool entry to the
        // loaded filePath, so the SERVER must rekey too — otherwise the keys
        // desync and a reconnect spawns a fresh agent, orphaning this
        // in-process-switched runtime (and running two agents on the cloned
        // session file -> corruption).
        const loadedPath = (msg as any).session?.filePath;
        if (loadedPath) this.rekeyToSessionPath(cwd, loadedPath);
        projectSessionsChangedHandler?.(cwd);
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
    this.bootQueue.length = 0;
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
 * The SDK resolves the real sessionFile synchronously and rekeys the agent
 * during start / runtime replacement via the `setRebindSession` hook, so the
 * pending-key window is short.
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

// ponytail: test-only escape hatch so the pool's state can be reset between
// tests. Not for production use.
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

// ponytail: one shared AuthStorage/ModelRegistry for the whole process —
// credentials and custom models live in ~/.pi/agent. SDK reads the same files
// the CLI does, so behavior is identical to `pi --mode rpc`.
let sharedAuthStorage: ReturnType<typeof AuthStorage.create> | null = null;
let sharedModelRegistry: ModelRegistry | null = null;
function getSharedAuth() {
  if (!sharedAuthStorage) sharedAuthStorage = AuthStorage.create();
  return sharedAuthStorage;
}
function getSharedModelRegistry() {
  if (!sharedModelRegistry) {
    sharedModelRegistry = ModelRegistry.create(getSharedAuth());
    sharedModelRegistry.refresh();
  }
  return sharedModelRegistry;
}

// ponytail: per-cwd cache of SDK services. The SDK designs services as shareable
// infrastructure (AgentSession is created separately per session), so the expensive
// resourceLoader.reload() jiti transpilation runs once per cwd, not once per start.
const servicesCache = new Map<string, Promise<AgentSessionServices>>();
function getOrCreateServices(cwd: string): Promise<AgentSessionServices> {
  const key = resolve(cwd);
  let cached = servicesCache.get(key);
  if (!cached) {
    cached = createAgentSessionServices({
      cwd,
      agentDir: getAgentDir(),
      authStorage: getSharedAuth(),
      modelRegistry: getSharedModelRegistry(),
    }).catch((err) => {
      servicesCache.delete(key); // don't cache failures — let the next start retry
      throw err;
    });
    servicesCache.set(key, cached);
  }
  return cached;
}

/** Invalidate cached SDK services for a cwd (or all). Call when settings/extensions/skills change. */
export function invalidateServicesCache(cwd?: string) {
  if (cwd) servicesCache.delete(resolve(cwd));
  else servicesCache.clear();
}

export class SDKAgent implements IPIAgent {
  private onMessage: ((msg: WSServerMessage) => void) | null = null;
  private onExit: ((code: number | null) => void) | null = null;
  private runtime: AgentSessionRuntime | null = null;
  private session: AgentSession | null = null;
  private unsubscribe: (() => void) | null = null;
  private extensionRunnerEmitUnwrap: (() => void) | null = null;
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
  // Callback that rekeys the server pool when the SDK resolves a new sessionFile.
  // Supplied by PooledAgent via setRebindHandler; return value indicates whether
  // the rekey succeeded.
  private rebindHandler: ((sessionFile: string) => boolean) | null = null;

  constructor(private options: PIAgentOptions) {}

  setHandler(handler: (msg: WSServerMessage) => void) { this.onMessage = handler; }
  setExitHandler(handler: (code: number | null) => void) { this.onExit = handler; }
  setRebindHandler(handler: (sessionFile: string) => boolean) { this.rebindHandler = handler; }
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
      const services = await getOrCreateServices(cwd);
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
    // Register SDK lifecycle hooks *before* bindSession so replacement
    // operations can bind and rekey inside the SDK transaction.
    runtime.setRebindSession((session) => this.onRuntimeRebind(session));
    runtime.setBeforeSessionInvalidate(() => this.onBeforeSessionInvalidate());
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
    // The initial runtime is not created via a replacement transaction, so
    // notify the pool of the resolved sessionFile here (synchronously after bind).
    const sessionFile = runtime.session.sessionFile;
    if (sessionFile) this.notifySessionLoaded(sessionFile);
  }

  /** Bind to a session: subscribe to events, wire extension UI context. Used on
   * initial start AND after runtime.newSession/switchSession/fork/clone. */
  private async bindSession(session: AgentSession): Promise<void> {
    // Tear down the previous binding if any.
    this.unsubscribe?.();
    this.extensionRunnerEmitUnwrap?.();
    this.session = session;
    this.unsubscribe = session.subscribe((event) => this.handleEvent(event));
    // Intercept extension events produced by model_select / thinking_level_select
    // so they are forwarded to the client as model_changed / thinking_changed.
    this.interceptExtensionRunner(session);
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

  /** The SDK emits model/thinking changes as extension events, not as
   * AgentSessionEvent. The runner has no public `on(type, fn)` API outside the
   * extension factory context, so we wrap its emit() method to intercept these
   * events and translate them to client-facing messages. We only intercept
   * model_select / thinking_level_select; all other events are forwarded verbatim. */
  private interceptExtensionRunner(session: AgentSession): void {
    const runner = session.extensionRunner as any;
    if (!runner || typeof runner.emit !== "function") return;
    const original = runner.emit.bind(runner);
    const handler = this.onMessage;
    runner.emit = async (event: any) => {
      if (handler && event && typeof event === "object") {
        if (event.type === "model_select" && event.model) {
          handler({ type: "model_changed", provider: event.model.provider, modelId: event.model.id });
        } else if (event.type === "thinking_level_select") {
          handler({ type: "thinking_changed", level: event.level });
        }
      }
      return original(event);
    };
    this.extensionRunnerEmitUnwrap = () => {
      runner.emit = original;
    };
  }

  private onRuntimeRebind(session: AgentSession): Promise<void> {
    return this.bindSession(session);
  }

  private onBeforeSessionInvalidate(): void {
    // The current session is about to be torn down by a new/switch/fork.
    // Reject pending UI dialogs so extensions blocked on client input don't
    // wait for an answer on the old session.
    this.rejectAllDialogs("Session replaced");
  }

  private rejectAllDialogs(reason: string): void {
    for (const [, entry] of this.pendingDialogs) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pendingDialogs.clear();
  }

  private notifySessionLoaded(sessionFile: string): boolean {
    const ok = this.rebindHandler?.(sessionFile) ?? true;
    if (ok) {
      this.onMessage?.({ type: "session_loaded", session: { filePath: sessionFile } as any });
    }
    return ok;
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
      async custom<T>(_factory: any, _options?: any): Promise<T> {
        // TUI components require a terminal environment that the WebSocket
        // server doesn't provide. Reject explicitly rather than silently
        // returning undefined, which masks the unsupported operation.
        return Promise.reject(new Error("Custom UI overlays are not supported in server mode"));
      },
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
    this.rejectAllDialogs("Agent stopped");
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.extensionRunnerEmitUnwrap?.();
    this.extensionRunnerEmitUnwrap = null;
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
      case "get_messages": {
        const msgs = session.messages as any[];
        const since = (msg as any).since;
        // ponytail: send only the tail the client doesn't already have. `since`
        // is the client's message count; within bounds we slice (cheap), else
        // fall back to the full array (first connect, or compaction shrank history).
        if (typeof since === "number" && since >= 0 && since <= msgs.length) {
          this.onMessage?.({ type: "messages_result", messages: msgs.slice(since), fromIndex: since });
        } else {
          this.onMessage?.({ type: "messages_result", messages: msgs as any, fromIndex: 0 });
        }
        break;
      }
      case "get_last_assistant_text":
        this.onMessage?.({ type: "last_assistant_text_result", text: session.getLastAssistantText() ?? null });
        break;
      case "get_session_stats":
        this.onMessage?.({ type: "session_stats", stats: session.getSessionStats() as any });
        break;

      // ── Model ──
      case "set_model": {
        const model = session.modelRegistry.find(msg.provider, msg.modelId);
        if (!model) {
          this.onMessage?.({ type: "response", command: "set_model", success: false, error: `Model not found: ${msg.provider}/${msg.modelId}` });
          break;
        }
        await session.setModel(model);
        // SDK setModel() emits a `model_select` extension event (and a
        // `thinking_level_select` event when it re-clamps thinking), which we
        // intercept and translate into client model_changed / thinking_changed
        // messages. No manual broadcast needed here.
        this.onMessage?.({ type: "response", command: "set_model", success: true });
        break;
      }
      case "cycle_model": {
        await session.cycleModel();
        // cycleModel() emits model_select / thinking_level_select extension
        // events that we translate to model_changed / thinking_changed.
        this.onMessage?.({ type: "response", command: "cycle_model", success: true });
        break;
      }
      case "get_available_models": {
        // Shared registry is refreshed once in getSharedModelRegistry(), so a
        // first call after server start already sees loaded models.
        const models = session.modelRegistry.getAvailable();
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
        // setThinkingLevel() emits a thinking_level_select extension event
        // that we translate to thinking_changed.
        this.onMessage?.({ type: "response", command: "set_thinking_level", success: true });
        break;
      case "cycle_thinking_level": {
        session.cycleThinkingLevel();
        // cycleThinkingLevel() emits a thinking_level_select extension event
        // that we translate to thinking_changed.
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
        const result = await runtime.newSession({
          // The withSession callback fires inside the SDK's replacement
          // transaction, after runtime.session has been updated. We use it
          // to rekey the pool and broadcast session_loaded to clients.
          withSession: async () => {
            const sessionFile = this.runtime?.session?.sessionFile;
            if (sessionFile) this.notifySessionLoaded(sessionFile);
          },
        });
        this.onMessage?.({ type: "response", command: "new_session", success: !result.cancelled, data: result });
        break;
      }
      case "load_session":
      case "switch_session": {
        const result = await runtime.switchSession(msg.sessionPath, {
          withSession: async () => {
            const sessionFile = this.runtime?.session?.sessionFile;
            if (sessionFile) this.notifySessionLoaded(sessionFile);
          },
        });
        this.onMessage?.({ type: "response", command: msg.type, success: !result.cancelled, data: result });
        break;
      }
      case "fork": {
        const result = await runtime.fork(msg.entryId, {
          withSession: async () => {
            const sessionFile = this.runtime?.session?.sessionFile;
            if (sessionFile) this.notifySessionLoaded(sessionFile);
          },
        });
        this.onMessage?.({ type: "response", command: "fork", success: !result.cancelled, data: { text: result.selectedText, cancelled: result.cancelled } });
        break;
      }
      case "clone": {
        const leafId = session.sessionManager.getLeafId();
        if (!leafId) {
          this.onMessage?.({ type: "response", command: "clone", success: false, error: "Cannot clone session: no current entry selected" });
          break;
        }
        const result = await runtime.fork(leafId, {
          position: "at",
          withSession: async () => {
            const sessionFile = this.runtime?.session?.sessionFile;
            if (sessionFile) this.notifySessionLoaded(sessionFile);
          },
        });
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
