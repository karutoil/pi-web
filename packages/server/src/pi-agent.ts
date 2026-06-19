import { spawn, type ChildProcess } from "node:child_process";
import { join, delimiter, normalize } from "node:path";
import { platform, homedir } from "node:os";
import type { WSServerMessage } from "@pi-web/shared";
import type { ServerWebSocket } from "bun";
import treeKill from "tree-kill";

// ─── Pooled Agent ───
// Wraps a PIAgent with multi-client broadcast + idle cleanup.
// Survives WebSocket disconnects — agents keep running until idle timeout.

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
// #LIVE: watchdog for wedged PI processes. A run that is "streaming" but has
// produced no message activity for this long AND has no clients is treated as
// hung (e.g. PI blocked on an unanswered extension_ui_request whose client
// disconnected, or a stuck tool / hung model call). Left un-reaped it lingers
// forever — the "server requires a reboot" failure mode. Force-stopped here.
const STALE_STREAMING_MS = 10 * 60 * 1000; // 10 minutes
// #LIVE: cadence at which the watchdog sweeps a single agent. Kept coarse so
// the per-agent timer is cheap; STALE_STREAMING_MS is what bounds recovery.
const WATCHDOG_TICK_MS = 60 * 1000; // 1 minute

export interface IPIAgent {
  setHandler(handler: (msg: WSServerMessage) => void): void;
  setExitHandler(handler: (code: number | null) => void): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  getOptions(): PIAgentOptions;
  getState(): void;
  doSend(msg: unknown): void;
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
  // never notifies us of the new path (no pushed state, no session_start to
  // subscribers, and clone_result carries no sessionPath). We poll get_state
  // and rekey to whatever new sessionFile comes back. Cleared on first rekey
  // or after the poll budget runs out.
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
  readonly originalNewSessionId: string | null;
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
  createAgent: (options: PIAgentOptions) => IPIAgent = (opts) => new PIAgent(opts),
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

    // Handle unexpected PI exit
    this.agent.setExitHandler((code) => {
      console.log(`[pool] agent ${this.agentKey} exited (code ${code})`);
      this.broadcast({ type: "error", message: `PI agent exited (code ${code}).` });
      // #1: Close every attached client WS so the client's onclose fires and
      // its reconnect logic kicks in. Without this the WS stays 'open' while
      // the agent is gone from the pool — every subsequent send is silently
      // dropped and the user thinks they're talking to a live agent.
      this.closeClients();
      // #LIVE: drop any orphaned dialog + stop the watchdog — the process is gone.
      this.pendingDialog = null;
      this.cancelWatchdog();
      // #REKEY-EXIT: delete by the CURRENT key (this.agentKey), not the closure
      // `agentKey` captured at construction. A new-session agent is rekeyed
      // from `__new__:<uuid>` to the resolved `${cwd}::${sessionFile}` once PI
      // reports the sessionFile; deleting the stale original key left the
      // rekeyed entry in the pool with a dead PI underneath — a reconnect
      // reused the dead agent and every send was silently dropped. That is
      // the "server requires a reboot" failure mode.
      agentPool.delete(this.agentKey);
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

  /** Forward a command to the underlying agent */
  send(msg: unknown) {
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

  /** Restart the agent with a new session path. Detaches all clients first. */
  async restartWithSession(sessionPath: string): Promise<void> {
    this.cancelIdleTimer();
    await this.agent.stop();
    const opts = this.agent.getOptions();
    this.agent = this.createAgent({
      cwd: opts.cwd,
      sessionPath,
      provider: opts.provider,
      model: opts.model,
    });
    this.agent.setHandler((msg) => this.handleAgentMessage(msg));
    this.agent.setExitHandler((code) => {
      console.log(`[pool] agent ${this.agentKey} exited (code ${code})`);
      this.broadcast({ type: "error", message: `PI agent exited (code ${code}).` });
      this.closeClients();
      agentPool.delete(this.agentKey);
    });
    await this.agent.start();
    // Re-send state to all attached clients
    setTimeout(() => this.agent.getState(), 200);
  }

  /**
   * Send a `load_session` RPC to the running agent — let PI handle the
   * in-process switch instead of killing the process. Use `restartWithSession`
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
    await this.agent.stop();
    agentPool.delete(this.agentKey);
  }

  private broadcast(msg: WSServerMessage) {
    const data = JSON.stringify(msg);
    for (const ws of this.clients) {
      try {
        if (ws.readyState === 1) ws.send(data);
      } catch {}
    }
  }

  /** Send a pre-serialized payload to every attached client. */
  sendToClients(data: string) {
    for (const ws of this.clients) {
      try {
        if (ws.readyState === 1) ws.send(data);
      } catch {}
    }
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
          this.isPendingNewSession = false;
          // #4: Rekey the server pool from the pending `__new__:<uuid>` key to
          // the resolved `${cwd}::${sessionFile}` so a client reconnecting
          // after resolution reattaches to THIS agent instead of spawning a
          // fresh new-session agent.
          this.rekeyToSessionPath(cwd, sessionFile);
          projectSessionsChangedHandler?.(cwd);
        } else if (this.isPendingCloneRekey) {
          // #CLONE: PI rebinding to the forked session reports it via get_state.
          // Rekey to the NEW path the moment it differs from our current key so a
          // reconnect lands on THIS agent (PI is now live on the forked file).
          const currentPath = agentKeySessionPath(this.agentKey);
          if (sessionFile && sessionFile !== currentPath) {
            this.isPendingCloneRekey = false;
            this.rekeyToSessionPath(cwd, sessionFile);
            projectSessionsChangedHandler?.(cwd);
          }
        }
      } else if (msg.type === "session_loaded") {
        // #REATTACH: switch_session / load_session switch the PI process to a
        // DIFFERENT session in-place (used by the clone flow). The client
        // rekeys its pool entry to the loaded filePath (App.handleSessionLoaded),
        // so the SERVER must rekey too — otherwise the keys desync and a
        // reconnect spawns a fresh agent, orphaning this in-process-switched PI
        // (and running two PIs on the cloned session file -> corruption).
        const loadedPath = (msg as any).session?.filePath;
        if (loadedPath) this.rekeyToSessionPath(cwd, loadedPath);
        projectSessionsChangedHandler?.(cwd);
      } else if (msg.type === "clone_result") {
        // #CLONE: PI forks to a new session file async and never reports the path;
        // arm the poll so a reconnect lands on THIS agent (see rekeyAfterClone).
        // ponytail: !cancelled gates it (a failed clone just polls harmlessly; the
        // state branch's sessionFile!==currentPath guard blocks any spurious rekey).
        if (!msg.cancelled) this.rekeyAfterClone();
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
  private rekeyToSessionPath(cwd: string, sessionPath: string) {
    const oldKey = this.agentKey;
    const newKey = buildAgentKey(cwd, sessionPath);
    if (newKey === oldKey) return;
    if (rekeyAgent(oldKey, newKey)) {
      this.rekeyHandler?.(oldKey, newKey);
    }
  }

  /**
   * #CLONE: after a successful clone, PI asynchronously rebinds to the forked
   * session file. It never pushes the new path, so poll get_state a few times
   * and rekey to the first sessionFile that differs from our current key.
   * The actual rekey happens in handleAgentMessage (state branch) via the
   * isPendingCloneRekey flag; this method just arms the flag and drives the
   * polls. Bounded: stops after a few attempts so a stuck PI can't loop us.
   */
  private rekeyAfterClone() {
    if (this.isPendingCloneRekey) return;
    this.isPendingCloneRekey = true;
    // PI's rebind is async — the first get_state may still report the OLD path,
    // so retry a handful of times with short delays until the forked path lands.
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
      try {
        if (this.clients.size === 0 && !this.isActive()) {
          console.log(`[pool] agent ${this.agentKey} idle timeout, stopping`);
          await this.agent.stop();
          agentPool.delete(this.agentKey);
        }
      } catch (err: any) {
        console.error(`[pool] idle stop error for ${this.agentKey}:`, err.message);
        agentPool.delete(this.agentKey);
      }
    }, this.idleTimeoutMs);
  }

  private cancelIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  // #LIVE: watchdog — reaps a PI process that is "streaming" but has gone
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

  // #LIVE: stop a possibly-unresponsive PI process and drop it from the
  // pool. Uses tree-kill on the SIGKILL escalation so PI's own child
  // processes (bash, dev servers, …) don't survive the kill and leak.
  private async forceStopAndRemove() {
    this.cancelWatchdog();
    this.cancelIdleTimer();
    try { await this.agent.stop(); } catch (err: any) {
      console.error(`[pool] force-stop error for ${this.agentKey}:`, err.message);
    }
    agentPool.delete(this.agentKey);
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
  return normalize(p).replace(/\/+$/, "") || p;
}

/** Pull the <uuid> out of a pending `__new__:<uuid>` key (or null). */
function extractNewSessionId(key: string): string | null {
  const i = key.indexOf("__new__:");
  return i === -1 ? null : key.slice(i + "__new__:".length);
}


export function getOrCreateAgent(
  cwd: string,
  sessionPath: string | null,
  newSessionId?: string | null,
  provider?: string,
  model?: string,
  // ponytail: test injection — lets tests drive the real module pool with a
  // FakeAgent instead of spawning the `pi` binary. Defaults to the real PIAgent.
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
 * Delete an agent from the pool AND stop its underlying PI process.
 * #REATTACH: previously this only removed the pool entry without stopping PI,
 * leaving a live PI process with no pool entry — the client could NEVER
 * reattach (a reconnect would spawn a duplicate). Now it stops the agent so
 * no orphaned PI lingers. Callers: start-failure cleanup, project deletion.
 */
export function deleteFromPool(agentKey: string) {
  const agent = agentPool.get(agentKey);
  agentPool.delete(agentKey);
  if (agent) {
    // Fire-and-forget the async stop; the pool entry is already gone so a
    // reconnect won't reuse it. Stopping kills the PI tree (tree-kill).
    agent.stop().catch((e) => console.error(`[pool] deleteFromPool stop error for ${agentKey}:`, e));
  }
}

/** Stop every agent whose key starts with `${cwd}::` (project deletion).
 * #REATTACH: project deletion previously called deleteFromPool(project.path)
 * with the BARE cwd, but keys are `${cwd}::${sessionPath}` — so it matched
 * nothing and left every agent for the project running in the pool (and its PI
 * processes alive). This stops them all cleanly. */
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

// ─── PIAgent (internal, wraps PI RPC process) ───

function createJsonlReader(stream: NodeJS.ReadableStream, onLine: (line: string) => void) {
  // #13: Accumulate raw Buffer chunks, split on 0x0A newline byte,
  // then decode each complete line to UTF-8. This prevents split-encoding
  // corruption when multi-byte UTF-8 characters span chunk boundaries.
  let buffer = Buffer.alloc(0);
  stream.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const idx = buffer.indexOf(0x0A); // newline byte
      if (idx === -1) break;
      let lineBuf = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      // Strip trailing CR if present
      if (lineBuf.length > 0 && lineBuf[lineBuf.length - 1] === 0x0D) {
        lineBuf = lineBuf.slice(0, -1);
      }
      if (lineBuf.length > 0) {
        onLine(lineBuf.toString("utf-8"));
      }
    }
  });
  stream.on("end", () => {
    if (buffer.length > 0) {
      let lineBuf = buffer;
      if (lineBuf.length > 0 && lineBuf[lineBuf.length - 1] === 0x0D) {
        lineBuf = lineBuf.slice(0, -1);
      }
      if (lineBuf.length > 0) onLine(lineBuf.toString("utf-8"));
    }
  });
}

export interface PIAgentOptions {
  cwd: string;
  sessionPath?: string;
  model?: string;
  provider?: string;
}

class PIAgent {
  private proc: ChildProcess | null = null;
  private sendFn: (msg: unknown) => void = () => {};
  private onMessage: ((msg: WSServerMessage) => void) | null = null;
  private onExit: ((code: number | null) => void) | null = null;
  private messageQueue: unknown[] = [];
  private ready = false;
  private explicitlyStopped = false;

  constructor(private options: PIAgentOptions) {}

  setHandler(handler: (msg: WSServerMessage) => void) {
    this.onMessage = handler;
  }

  setExitHandler(handler: (code: number | null) => void) {
    this.onExit = handler;
  }

  getOptions(): PIAgentOptions {
    return this.options;
  }

  async start(): Promise<void> {
    if (this.proc) await this.stop();
    this.explicitlyStopped = false;

    const args: string[] = ["--mode", "rpc"];
    if (this.options.sessionPath) args.push("--session", this.options.sessionPath);
    if (this.options.provider) args.push("--provider", this.options.provider);
    if (this.options.model) args.push("--model", this.options.model);

    // #88: Use process.env.HOME for envPath instead of hardcoded paths
    const home = process.env.HOME || process.env.USERPROFILE || homedir();
    const envPath = [
      join(home, ".bun/bin"),
      join(home, ".nvm/versions/node/v22.22.2/bin"),
      ...(platform() === "win32" ? [] : ["/usr/local/bin", "/usr/bin", "/bin"]),
      process.env.PATH || "",
    ].join(delimiter);

    const piBin = platform() === "win32" ? "pi.cmd" : "pi";

    return new Promise<void>((resolve, reject) => {
      try {
        this.proc = spawn(piBin, args, {
          cwd: this.options.cwd,
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, PATH: envPath },
          detached: false,
        });
      } catch (err: any) {
        this.proc = null;
        this.onMessage?.({ type: "error", message: `Failed to spawn PI: ${err.message}` });
        reject(err);
        return;
      }

      this.sendFn = (msg: unknown) => {
        if (this.proc?.stdin?.writable && !this.proc.stdin.destroyed) {
          try {
            this.proc.stdin.write(JSON.stringify(msg) + "\n");
          } catch {}
        }
      };

      this.ready = true;
      for (const msg of this.messageQueue) this.sendFn(msg);
      this.messageQueue = [];

      if (this.proc.stdout) {
        this.proc.stdout.on("error", (err) => {
          console.error("[pi stdout error]", err.message);
        });
        createJsonlReader(this.proc.stdout, (line) => {
          try {
            const event = JSON.parse(line);
            this.handleRPCEvent(event);
          } catch {}
        });
      }

      if (this.proc.stderr) {
        this.proc.stderr.on("error", (err) => {
          console.error("[pi stderr error]", err.message);
        });
        this.proc.stderr.on("data", (data: Buffer) => {
          const text = data.toString("utf-8").trim();
          if (text) console.error("[pi stderr]", text.slice(0, 500));
        });
      }

      this.proc.on("error", (err: NodeJS.ErrnoException) => {
        console.error("[pi] process error:", err.message);
        if (err.code === "ENOENT") {
          this.onMessage?.({ type: "error", message: "PI binary not found. Is PI installed?" });
        } else {
          this.onMessage?.({ type: "error", message: `PI process error: ${err.message}` });
        }
        this.cleanup();
        reject(err);
      });

      this.proc.on("exit", (code, signal) => {
        console.log(`[pi] exited code=${code} signal=${signal} explicitStop=${this.explicitlyStopped}`);
        const wasExplicit = this.explicitlyStopped;
        this.cleanup();

        if (!wasExplicit && code !== 0 && code !== null) {
          this.onMessage?.({ type: "error", message: `PI process exited with code ${code}.` });
        }
        if (!wasExplicit && this.onExit) {
          this.onExit(code);
        }
      });

      resolve();
    });
  }

  private cleanup() {
    this.proc = null;
    this.ready = false;
    this.sendFn = () => {};
  }

  private handleRPCEvent(event: any) {
    const handler = this.onMessage;
    if (!handler) return;


    try {
      switch (event.type) {
        case "agent_start":
          handler({ type: "agent_start" }); break;
        case "agent_end":
          handler({ type: "agent_end", messages: event.messages || [] }); break;
        case "message_start":
          handler({ type: "message_start", message: event.message }); break;
        case "message_update": {
          const delta = event.assistantMessageEvent;
          if (delta) {
            handler({
              type: "message_update", message: event.message,
              delta: {
                type: delta.type, contentIndex: delta.contentIndex || 0,
                delta: delta.delta || "",
                ...(delta.type === "toolcall_end" ? { toolCall: delta.toolCall } : {}),
              },
            });
          }
          break;
        }
        case "message_end":
          handler({ type: "message_end", message: event.message }); break;
        case "tool_execution_start":
          handler({ type: "tool_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args || {} }); break;
        case "tool_execution_update":
          handler({ type: "tool_update", toolCallId: event.toolCallId, partialResult: event.partialResult || { content: [], details: undefined } }); break;
        case "tool_execution_end":
          handler({ type: "tool_end", toolCallId: event.toolCallId, toolName: event.toolName, result: event.result || { content: [] }, isError: event.isError || false }); break;
        case "turn_start": handler({ type: "turn_start" }); break;
        case "turn_end":
          handler({ type: "turn_end", message: event.message, toolResults: event.toolResults || [] }); break;
        case "queue_update":
          handler({ type: "queue_update", steering: event.steering || [], followUp: event.followUp || [] }); break;
        case "compaction_start":
          handler({ type: "compaction_start", reason: event.reason || "manual" }); break;
        case "compaction_end":
          handler({
            type: "compaction_end",
            reason: event.reason || "unknown",
            aborted: event.aborted || false,
            result: event.result || undefined,
            willRetry: event.willRetry || false,
            errorMessage: event.errorMessage,
          }); break;
        case "extension_ui_request":
          handler({
            type: "extension_ui_request",
            ui: {
              id: event.id, method: event.method, title: event.title,
              message: event.message, options: event.options,
              placeholder: event.placeholder, prefill: event.prefill,
              timeout: event.timeout, notifyType: event.notifyType,
              // setStatus fields
              statusKey: event.statusKey, statusText: event.statusText,
              // setWidget fields
              widgetKey: event.widgetKey, widgetLines: event.widgetLines,
              widgetPlacement: event.widgetPlacement,
              // set_editor_text fields
              text: event.text,
            },
          });
          break;
        case "auto_retry_start":
          handler({
            type: "auto_retry_start",
            attempt: event.attempt || 1,
            maxAttempts: event.maxAttempts || 3,
            delayMs: event.delayMs || 2000,
            errorMessage: event.errorMessage || "",
          }); break;
        case "auto_retry_end":
          handler({
            type: "auto_retry_end",
            success: event.success ?? true,
            attempt: event.attempt || 1,
            finalError: event.finalError,
          }); break;
        case "extension_error":
          handler({
            type: "extension_error",
            extensionPath: event.extensionPath || "",
            event: event.event || "",
            error: event.error || "",
          }); break;
        case "response":
          this.bridgeResponse(event, handler);
          break;
      }
    } catch (err) {
      console.error("[pi] handler error:", err);
    }
  }

  extensionUIResponse(id: string, response: { value?: string; confirmed?: boolean; cancelled?: boolean }) {
    this.doSend({ type: "extension_ui_response", id, ...response });
  }

  private bridgeResponse(event: any, handler: (msg: WSServerMessage) => void) {
    try {
      // Forward failed responses so client knows about failures
      if (!event.success) {
        handler({ type: "response", command: event.command, success: false, error: event.error, id: event.id });
        return;
      }

      switch (event.command) {
        case "get_state": {
          const data = event.data || {};
          handler({
            type: "state",
            data: {
              isStreaming: data.isStreaming || false, isCompacting: data.isCompacting || false,
              sessionFile: data.sessionFile || null, sessionId: data.sessionId || "",
              sessionName: data.sessionName || null, model: data.model?.id || null,
              thinkingLevel: data.thinkingLevel || "off", messageCount: data.messageCount || 0,
              pendingMessageCount: data.pendingMessageCount || 0, steering: [], followUp: [],
            },
          });
          break;
        }
        case "get_available_models":
          handler({ type: "available_models", models: (event.data?.models || []).map((m: any) => ({
            id: m.id, name: m.name, api: m.api, provider: m.provider,
            contextWindow: m.contextWindow, maxTokens: m.maxTokens,
            reasoning: m.reasoning, input: m.input, cost: m.cost,
          })) });
          break;
        case "get_commands":
          handler({ type: "available_commands", commands: event.data?.commands || [] }); break;
        case "get_fork_messages":
          handler({ type: "fork_messages", messages: event.data?.messages || [] }); break;
        case "get_session_stats":
          handler({ type: "session_stats", stats: event.data || {} }); break;
        case "set_model":
          if (event.data) handler({ type: "model_changed", provider: event.data.provider, modelId: event.data.id });
          break;
        case "set_thinking_level":
          if (event.data) handler({ type: "thinking_changed", level: event.data.level });
          break;
        case "set_session_name":
          handler({ type: "session_name_changed", name: event.data?.name || "" }); break;
        case "new_session":
          // new_session response only has {cancelled: false} — no session data.
          // Request get_state to fetch actual new session details.
          if (event.success && !event.data?.cancelled) this.getState();
          break;
        case "load_session":
          if (event.data) handler({ type: "session_loaded", session: event.data });
          break;
        case "switch_session":
          if (event.data && !event.data.cancelled) handler({ type: "session_loaded", session: event.data });
          break;
        case "clone": {
          handler({ type: "clone_result", cancelled: event.data?.cancelled || false, sessionPath: event.data?.sessionPath });
          break;
        }
        case "export_html":
          handler({ type: "export_html_result", path: event.data?.path || "" });
          break;
        case "get_messages":
          handler({ type: "messages_result", messages: event.data?.messages || [] });
          break;
        case "get_last_assistant_text":
          handler({ type: "last_assistant_text_result", text: event.data?.text ?? null });
          break;
        case "cycle_model":
          if (event.data?.model) handler({ type: "model_changed", provider: event.data.model.provider, modelId: event.data.model.id });
          if (event.data?.thinkingLevel) handler({ type: "thinking_changed", level: event.data.thinkingLevel });
          break;
        case "cycle_thinking_level":
          if (event.data?.level) handler({ type: "thinking_changed", level: event.data.level });
          break;
        // Commands that just return success/failure — forward generic response
        case "compact":
        case "set_auto_compaction":
        case "set_auto_retry":
        case "set_steering_mode":
        case "set_follow_up_mode":
        case "clear_queue":
        case "abort_retry":
        case "abort_bash":
        case "bash":
          handler({ type: "response", command: event.command, success: true, id: event.id });
          break;
      }
    } catch (err) {
      console.error("[pi] bridge error:", err);
    }
  }

  // ─── Command senders ───

  getAvailableModels() { this.doSend({ type: "get_available_models" }); }
  getCommands() { this.doSend({ type: "get_commands" }); }
  getForkMessages() { this.doSend({ type: "get_fork_messages" }); }
  getSessionStats() { this.doSend({ type: "get_session_stats" }); }
  getMessages() { this.doSend({ type: "get_messages" }); }
  getLastAssistantText() { this.doSend({ type: "get_last_assistant_text" }); }
  setSessionName(name: string) { this.doSend({ type: "set_session_name", name }); }
  prompt(message: string, images?: any[]) { this.doSend({ type: "prompt", message, images }); }
  steer(message: string, images?: any[]) { this.doSend({ type: "steer", message, images }); }
  followUp(message: string, images?: any[]) { this.doSend({ type: "follow_up", message, images }); }
  clearQueue() { this.doSend({ type: "clear_queue" }); }
  abort() { this.doSend({ type: "abort" }); }
  newSession() { this.doSend({ type: "new_session" }); }
  fork(entryId: string) { this.doSend({ type: "fork", entryId }); }
  setModel(provider: string, modelId: string) { this.doSend({ type: "set_model", provider, modelId }); }
  setThinking(level: string) { this.doSend({ type: "set_thinking_level", level }); }
  compact(customInstructions?: string) { this.doSend({ type: "compact", ...(customInstructions ? { customInstructions } : {}) }); }
  getState() { this.doSend({ type: "get_state" }); }
  cycleModel() { this.doSend({ type: "cycle_model" }); }
  cycleThinkingLevel() { this.doSend({ type: "cycle_thinking_level" }); }
  setAutoCompaction(enabled: boolean) { this.doSend({ type: "set_auto_compaction", enabled }); }
  setAutoRetry(enabled: boolean) { this.doSend({ type: "set_auto_retry", enabled }); }
  abortRetry() { this.doSend({ type: "abort_retry" }); }
  setSteeringMode(mode: string) { this.doSend({ type: "set_steering_mode", mode }); }
  setFollowUpMode(mode: string) { this.doSend({ type: "set_follow_up_mode", mode }); }
  exportHtml(outputPath?: string) { this.doSend({ type: "export_html", ...(outputPath ? { outputPath } : {}) }); }
  switchSession(sessionPath: string) { this.doSend({ type: "switch_session", sessionPath }); }
  clone() { this.doSend({ type: "clone" }); }
  bash(command: string) { this.doSend({ type: "bash", command }); }
  abortBash() { this.doSend({ type: "abort_bash" }); }

  doSend(msg: unknown) {
    if (this.ready) {
      this.sendFn(msg);
    } else {
      this.messageQueue.push(msg);
    }
  }

  async stop(): Promise<void> {
    this.explicitlyStopped = true;
    this.ready = false;
    if (this.proc) {
      try { this.proc.stdin?.end(); } catch {}
      try { this.proc.kill("SIGTERM"); } catch {}
      // #45: Remove listeners immediately after SIGTERM, before the 300ms sleep,
      // to prevent old exit events from racing with new agent startup.
      try {
        this.proc.removeAllListeners();
        this.proc.stdout?.removeAllListeners();
        this.proc.stderr?.removeAllListeners();
      } catch {}
      await new Promise(r => setTimeout(r, 300));
      try {
        if (this.proc && !this.proc.killed && this.proc.pid) {
          // #LIVE: tree-kill the whole process group on the SIGKILL escalation
          // so PI's own children (bash, dev servers, …) don't survive and
          // leak — a leftover child holding the session file / port is what
          // makes a restart wedge and "require a reboot".
          await new Promise<void>((resolve) => {
            treeKill(this.proc!.pid!, "SIGKILL", () => resolve());
          });
        }
      } catch {}
      this.proc = null;
    }
  }
}
