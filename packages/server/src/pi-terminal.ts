import { spawn, type IPty } from "@homebridge/node-pty-prebuilt-multiarch";
import type { ServerWebSocket } from "bun";

// ─── Terminal Manager ───
// Manages persistent PTY instances scoped per project.
// Terminals survive client disconnects — reattach on reconnect.

export interface TerminalInfo {
  id: string;
  projectId: string;
  cwd: string;
  name: string;
  createdAt: number;
}

const terminals = new Map<string, TerminalInstance>();

class TerminalInstance {
  pty: IPty;
  info: TerminalInfo;
  clients = new Set<ServerWebSocket>();
  buffer: string = "";
  private maxBuffer = 50000; // Keep last 50K chars for reattach scrollback

  constructor(info: TerminalInfo, pty: IPty) {
    this.info = info;
    this.pty = pty;

    this.pty.onData((data: string) => {
      // Append to buffer, trim if too large
      this.buffer += data;
      if (this.buffer.length > this.maxBuffer) {
        this.buffer = this.buffer.slice(this.buffer.length - this.maxBuffer);
      }
      // Broadcast to all connected clients
      for (const ws of this.clients) {
        try {
          ws.send(JSON.stringify({ type: "term_output", id: this.info.id, data }));
        } catch {}
      }
    });

    this.pty.onExit(({ exitCode }) => {
      for (const ws of this.clients) {
        try {
          ws.send(JSON.stringify({ type: "term_exit", id: this.info.id, exitCode }));
        } catch {}
      }
      terminals.delete(this.info.id);
    });
  }

  attach(ws: ServerWebSocket) {
    this.clients.add(ws);
  }

  detach(ws: ServerWebSocket) {
    this.clients.delete(ws);
  }

  write(data: string) {
    this.pty.write(data);
  }

  resize(cols: number, rows: number) {
    try { this.pty.resize(cols, rows); } catch {}
  }

  kill() {
    try { this.pty.kill(); } catch {}
    terminals.delete(this.info.id);
  }
}

export function createTerminal(id: string, projectId: string, cwd: string, name: string): TerminalInfo {
  const existing = terminals.get(id);
  if (existing) return existing.info;

  const pty = spawn(process.env.SHELL || "/bin/bash", [], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd,
    env: { ...process.env, TERM: "xterm-256color" },
  });

  const info: TerminalInfo = { id, projectId, cwd, name, createdAt: Date.now() };
  const instance = new TerminalInstance(info, pty);
  terminals.set(id, instance);
  return info;
}

export function getTerminal(id: string): TerminalInstance | undefined {
  return terminals.get(id);
}

export function listTerminals(projectId: string): TerminalInfo[] {
  return Array.from(terminals.values())
    .filter(t => t.info.projectId === projectId)
    .map(t => t.info);
}

export function killTerminal(id: string): boolean {
  const t = terminals.get(id);
  if (t) { t.kill(); return true; }
  return false;
}
