import { spawn, type IPty } from "bun-pty";
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
  private maxBuffer = 50000;
  private dataDisposable: { dispose: () => void } | null = null;
  private exitDisposable: { dispose: () => void } | null = null;

  constructor(info: TerminalInfo, pty: IPty) {
    this.info = info;
    this.pty = pty;

    this.dataDisposable = this.pty.onData((data: string) => {
      this.buffer += data;
      if (this.buffer.length > this.maxBuffer) {
        this.buffer = this.buffer.slice(this.buffer.length - this.maxBuffer);
      }
      for (const ws of this.clients) {
        try {
          ws.send(JSON.stringify({ type: "term_output", id: this.info.id, data }));
        } catch {}
      }
    });

    this.exitDisposable = this.pty.onExit(({ exitCode }: { exitCode: number }) => {
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
    this.dataDisposable?.dispose();
    this.exitDisposable?.dispose();
    try { this.pty.kill(); } catch {}
    terminals.delete(this.info.id);
  }
}

export function createTerminal(id: string, projectId: string, cwd: string, name: string): TerminalInfo {
  const existing = terminals.get(id);
  if (existing) {
    // #40: Validate projectId/cwd match on terminal ID reuse
    if (existing.info.projectId !== projectId || existing.info.cwd !== cwd) {
      throw new Error(`Terminal ID '${id}' already exists with different projectId/cwd`);
    }
    return existing.info;
  }

  const shell = process.platform === "win32" ? (process.env.COMSPEC || "cmd.exe") : (process.env.SHELL || "/bin/bash");
  const pty = spawn(shell, [], {
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
