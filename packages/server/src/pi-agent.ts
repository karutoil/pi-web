import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
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
// Global singleton. Keys are `${cwd}:${sessionPath}`.

const agentPool = new Map<string, PooledAgent>();

export function getOrCreateAgent(
  cwd: string,
  sessionPath: string | null,
  provider?: string,
  model?: string,
  newSessionId?: string,
): { agent: PooledAgent; isNew: boolean } {
  const key = `${cwd}:${sessionPath || newSessionId || "__new__"}`;
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

/** Detach a client from an agent by key */
export function detachFromAgent(agentKey: string, ws: ServerWebSocket) {
  const agent = agentPool.get(agentKey);
  if (agent) agent.detach(ws);
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
  let buffer = "";
  stream.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf-8");
    while (true) {
      const idx = buffer.indexOf("\n");
      if (idx === -1) break;
      let line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) onLine(line);
    }
  });
  stream.on("end", () => {
    if (buffer.length > 0) {
      let line = buffer;
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) onLine(line);
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

  async start(): Promise<void> {
    if (this.proc) await this.stop();
    this.explicitlyStopped = false;

    const args: string[] = ["--mode", "rpc"];
    if (this.options.sessionPath) args.push("--session", this.options.sessionPath);
    if (this.options.provider) args.push("--provider", this.options.provider);
    if (this.options.model) args.push("--model", this.options.model);

    const envPath = [
      "/home/karutoil/.bun/bin",
      "/home/karutoil/.nvm/versions/node/v22.22.2/bin",
      "/usr/local/bin", "/usr/bin", "/bin",
      process.env.PATH || "",
    ].join(":");

    // Inject RPC bridge preload to patch custom() for clarify support
    const bridgePath = join(__dirname, "pi-web-rpc-bridge.js");
    const nodeOptions = [
      process.env.NODE_OPTIONS || "",
      `--require=${bridgePath}`,
    ].filter(Boolean).join(" ");

    return new Promise<void>((resolve, reject) => {
      try {
        this.proc = spawn("pi", args, {
          cwd: this.options.cwd,
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, PATH: envPath, NODE_OPTIONS: nodeOptions },
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
          handler({ type: "compaction_end", reason: event.reason || "unknown", aborted: event.aborted || false }); break;
        case "extension_ui_request":
          handler({
            type: "extension_ui_request",
            ui: {
              id: event.id, method: event.method, title: event.title,
              message: event.message, options: event.options,
              placeholder: event.placeholder, prefill: event.prefill,
              timeout: event.timeout, notifyType: event.notifyType,
              // Clarify protocol fields
              overlay: event.overlay, overlayOptions: event.overlayOptions,
              clarifyData: event.clarifyData,
            },
          });
          break;
        case "response":
          this.bridgeResponse(event);
          break;
      }
    } catch (err) {
      console.error("[pi] handler error:", err);
    }
  }

  extensionUIResponse(id: string, response: { value?: string; confirmed?: boolean; cancelled?: boolean }) {
    this.doSend({ type: "extension_ui_response", id, ...response });
  }

  private bridgeResponse(event: any) {
    const handler = this.onMessage;
    if (!handler || !event.success) return;
    try {
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
      }
    } catch (err) {
      console.error("[pi] bridge error:", err);
    }
  }

  getAvailableModels() { this.doSend({ type: "get_available_models" }); }
  getCommands() { this.doSend({ type: "get_commands" }); }
  getForkMessages() { this.doSend({ type: "get_fork_messages" }); }
  getSessionStats() { this.doSend({ type: "get_session_stats" }); }
  setSessionName(name: string) { this.doSend({ type: "set_session_name", name }); }
  prompt(message: string, images?: any[]) { this.doSend({ type: "prompt", message, images }); }
  steer(message: string) { this.doSend({ type: "steer", message }); }
  followUp(message: string) { this.doSend({ type: "follow_up", message }); }
  abort() { this.doSend({ type: "abort" }); }
  newSession() { this.doSend({ type: "new_session" }); }
  fork(entryId: string) { this.doSend({ type: "fork", entryId }); }
  setModel(provider: string, modelId: string) { this.doSend({ type: "set_model", provider, modelId }); }
  setThinking(level: string) { this.doSend({ type: "set_thinking_level", level }); }
  compact() { this.doSend({ type: "compact" }); }
  getState() { this.doSend({ type: "get_state" }); }

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
      await new Promise(r => setTimeout(r, 300));
      try {
        if (this.proc && !this.proc.killed) {
          this.proc.kill("SIGKILL");
        }
      } catch {}
      try {
        this.proc.removeAllListeners();
        this.proc.stdout?.removeAllListeners();
        this.proc.stderr?.removeAllListeners();
      } catch {}
      this.proc = null;
    }
  }
}
