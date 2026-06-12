import { spawn, type ChildProcess } from "node:child_process";
import { join, delimiter } from "node:path";
import { platform, homedir } from "node:os";
import type { WSServerMessage } from "@pi-web/shared";
import type { ServerWebSocket } from "bun";

// ─── Pooled Agent ───
// Wraps a PIAgent with multi-client broadcast + idle cleanup.
// Survives WebSocket disconnects — agents keep running until idle timeout.

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class PooledAgent {
  private agent: PIAgent;
  private clients = new Set<ServerWebSocket>();
  private idleTimer: Timer | null = null;
  private agentKey: string;

  /** Get the current pool key for this agent. */
  getKey(): string {
    return this.agentKey;
  }

  /** Update the pool key (called by rekeyAgent). */
  setKey(newKey: string) {
    this.agentKey = newKey;
  }

  constructor(
    agentKey: string,
    options: PIAgentOptions,
  ) {
    this.agentKey = agentKey;
    this.agent = new PIAgent(options);

    // Broadcast all agent messages to attached clients
    this.agent.setHandler((msg) => this.broadcast(msg));

    // Handle unexpected PI exit
    this.agent.setExitHandler((code) => {
      console.log(`[pool] agent ${agentKey} exited (code ${code})`);
      this.broadcast({ type: "error", message: `PI agent exited (code ${code}).` });
      // Remove from pool — will be recreated if someone reconnects
      agentPool.delete(agentKey);
    });
  }

  async start(): Promise<void> {
    await this.agent.start();
    // Send initial state to any already-attached clients
    setTimeout(() => this.agent.getState(), 300);
  }

  /** Attach a WebSocket client. Cancels idle timer if running. */
  attach(ws: ServerWebSocket) {
    this.clients.add(ws);
    this.cancelIdleTimer();
    // Send current state to the newly attached client
    setTimeout(() => this.agent.getState(), 100);
  }

  /** Detach a WebSocket client. Starts idle timer if no clients remain. */
  detach(ws: ServerWebSocket) {
    this.clients.delete(ws);
    if (this.clients.size === 0) {
      this.startIdleTimer();
    }
  }

  /** Get number of attached clients */
  get clientCount() { return this.clients.size; }

  /** Forward a command to the underlying agent */
  send(msg: unknown) {
    this.agent.doSend(msg);
  }

  /** Restart the agent with a new session path. Detaches all clients first. */
  async restartWithSession(sessionPath: string): Promise<void> {
    this.cancelIdleTimer();
    await this.agent.stop();
    const opts = this.agent.getOptions();
    this.agent = new PIAgent({
      cwd: opts.cwd,
      sessionPath,
      provider: opts.provider,
      model: opts.model,
    });
    this.agent.setHandler((msg) => this.broadcast(msg));
    this.agent.setExitHandler((code) => {
      console.log(`[pool] agent ${this.agentKey} exited (code ${code})`);
      this.broadcast({ type: "error", message: `PI agent exited (code ${code}).` });
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

  private startIdleTimer() {
    this.cancelIdleTimer();
    console.log(`[pool] agent ${this.agentKey} idle, starting ${IDLE_TIMEOUT_MS / 1000}s timeout`);
    this.idleTimer = setTimeout(async () => {
      if (this.clients.size === 0) {
        console.log(`[pool] agent ${this.agentKey} idle timeout, stopping`);
        await this.agent.stop();
        agentPool.delete(this.agentKey);
      }
    }, IDLE_TIMEOUT_MS);
  }

  private cancelIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}

// ─── Agent Pool ───
// Global singleton. Keys are `${cwd}::${sessionPath || "__new__"}` —
// one agent per (project, session) tuple so multiple sessions in the same
// project can run concurrently and keep streaming while the user navigates
// away.

const agentPool = new Map<string, PooledAgent>();

/** Build the pool key for a (cwd, sessionPath) pair. */
export function buildAgentKey(cwd: string, sessionPath: string | null | undefined): string {
  return `${cwd}::${sessionPath || "__new__"}`;
}

export function getOrCreateAgent(
  cwd: string,
  sessionPath: string | null,
  provider?: string,
  model?: string,
): { agent: PooledAgent; isNew: boolean } {
  const key = buildAgentKey(cwd, sessionPath);
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
  });
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

/** Delete an agent from the pool (#12: for cleanup on start failure) */
export function deleteFromPool(agentKey: string) {
  agentPool.delete(agentKey);
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
        case "clone":
          handler({ type: "clone_result", cancelled: event.data?.cancelled || false, sessionPath: event.data?.sessionPath });
          break;
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
        if (this.proc && !this.proc.killed) {
          this.proc.kill("SIGKILL");
        }
      } catch {}
      this.proc = null;
    }
  }
}
