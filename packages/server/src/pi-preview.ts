/**
 * Preview Manager — manages dev server processes for the preview pane.
 *
 * Keyed by (projectId, label) so a single project can host multiple
 * previews (e.g. main app on "default" + storybook on "storybook").
 *
 * Process lifecycle:
 *  1. User calls POST /api/preview/start  →  spawn dev command
 *  2. Scan listening ports owned by the spawned process tree
 *  3. Once scanning finishes, status = "selecting" and the UI shows a list
 *     of detected ports for the user to choose from.
 *  4. User calls POST /api/preview/:id/:label/port to pick a port
 *  5. Health-poll target URL every 300ms until 200
 *  6. Mark status = "running" → proxy becomes available
 *  7. User calls POST /api/preview/:id/:label/stop → tree-kill + cleanup
 *  8. On server shutdown, kill all previews
 */

import { spawn, type Subprocess } from "bun";
import type { PreviewInfo, PreviewStatus } from "@pi-web/shared";
import { nanoid } from "nanoid";
import { execFileSync, execSync } from "node:child_process";
import { join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import {
  existsSync,
  statSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import treeKill from "tree-kill";
import isPortReachable from "is-port-reachable";

const PREVIEWS_FILE = join(homedir(), ".pi", "previews.json");
const PORT_SCAN_INTERVAL_MS = 1000;
const PORT_SCAN_TIMEOUT_MS = 12000;

// ─── In-memory store ───
const previews = new Map<string, PreviewInfo>();

// Active subprocess handles keyed by `projectId:label`
const processes = new Map<string, Subprocess>();

// Active health-poll timers keyed by `projectId:label`
const healthTimers = new Map<string, ReturnType<typeof setInterval>>();

type LogCallback = (text: string, stream: "stdout" | "stderr") => void;
const logCallbacks = new Map<string, Set<LogCallback>>();

// ─── Persistence ───

async function loadPreviews(): Promise<void> {
  try {
    if (!existsSync(PREVIEWS_FILE)) return;
    const raw = await readFile(PREVIEWS_FILE, "utf-8");
    const list: PreviewInfo[] = JSON.parse(raw);
    for (const p of list) {
      p.process = null;
      p.healthTimer = null;
      p.logs = p.logs || [];
      previews.set(key(p.projectId, p.label), p);
    }
  } catch {}
}

async function persistPreviews(): Promise<void> {
  const list = Array.from(previews.values()).map(p => ({
    ...p,
    healthTimer: null,
    process: null,
  }));
  await mkdir(join(homedir(), ".pi"), { recursive: true });
  await writeFile(PREVIEWS_FILE, JSON.stringify(list, null, 2));
}

function key(projectId: string, label: string): string {
  return `${projectId}:${label}`;
}

// ─── Framework detection ───

interface FrameworkConfig {
  framework: string;
  command: string;
  defaultPort: number;
  portEnv: string | null;
}

function detectFramework(cwd: string): FrameworkConfig | null {
  const checks: Array<{ file: string; config: FrameworkConfig }> = [
    { file: "next.config.js", config: { framework: "Next.js", command: "npx next dev", defaultPort: 3000, portEnv: "PORT" } },
    { file: "next.config.mjs", config: { framework: "Next.js", command: "npx next dev", defaultPort: 3000, portEnv: "PORT" } },
    { file: "next.config.ts", config: { framework: "Next.js", command: "npx next dev", defaultPort: 3000, portEnv: "PORT" } },
    { file: "astro.config.mjs", config: { framework: "Astro", command: "npx astro dev", defaultPort: 4321, portEnv: "PORT" } },
    { file: "astro.config.ts", config: { framework: "Astro", command: "npx astro dev", defaultPort: 4321, portEnv: "PORT" } },
    { file: "remix.config.js", config: { framework: "Remix", command: "npm run dev", defaultPort: 3000, portEnv: "PORT" } },
    { file: "nuxt.config.ts", config: { framework: "Nuxt", command: "npm run dev", defaultPort: 3000, portEnv: "PORT" } },
    { file: "nuxt.config.js", config: { framework: "Nuxt", command: "npm run dev", defaultPort: 3000, portEnv: "PORT" } },
    { file: "svelte.config.js", config: { framework: "SvelteKit", command: "npm run dev", defaultPort: 5173, portEnv: "PORT" } },
    { file: "svelte.config.ts", config: { framework: "SvelteKit", command: "npm run dev", defaultPort: 5173, portEnv: "PORT" } },
  ];

  for (const { file, config } of checks) {
    const fp = join(cwd, file);
    try { if (statSync(fp).isFile()) return config; } catch {}
  }

  // Default: try Vite via package.json "dev" script
  const pkgPath = join(cwd, "package.json");
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const devScript = pkg.scripts?.dev || "";
    if (devScript.includes("vite")) {
      return { framework: "Vite", command: "npm run dev", defaultPort: 5173, portEnv: null };
    }
    if (devScript) {
      return { framework: "Custom", command: "npm run dev", defaultPort: 3000, portEnv: "PORT" };
    }
  } catch {}
  return null;
}

// ─── Platform shell for spawning commands ───

function getPlatformShell(): { shell: string; flag: string } {
  if (platform() === "win32") {
    return { shell: process.env.COMSPEC || "cmd.exe", flag: "/c" };
  }
  return { shell: process.env.SHELL || "/bin/bash", flag: "-c" };
}

// ─── Process-tree port scanning ───

export function getProcessChildren(pid: number, depth = 0): number[] {
  if (depth > 10) return [];
  const children: number[] = [];
  const plat = platform();
  try {
    if (plat === "win32") {
      let out = "";
      try {
        out = execFileSync("wmic", ["process", "where", `ParentProcessId=${pid}`, "get", "ProcessId"], {
          encoding: "utf-8",
          timeout: 2000,
        }).toString();
      } catch {
        // Fallback to PowerShell when wmic is unavailable
        const script = `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}' | Select-Object -ExpandProperty ProcessId`;
        out = execFileSync("powershell", ["-NoProfile", "-Command", script], {
          encoding: "utf-8",
          timeout: 2000,
        }).toString();
      }
      for (const line of out.split("\n")) {
        const p = parseInt(line.trim(), 10);
        if (!isNaN(p)) children.push(p, ...getProcessChildren(p, depth + 1));
      }
    } else if (plat === "darwin") {
      const out = execFileSync("pgrep", ["-P", String(pid)], {
        encoding: "utf-8",
        timeout: 2000,
      }).toString();
      for (const line of out.split("\n")) {
        const p = parseInt(line.trim(), 10);
        if (!isNaN(p)) children.push(p, ...getProcessChildren(p, depth + 1));
      }
    } else {
      // Linux: prefer /proc/<pid>/task/*/children
      if (existsSync(`/proc/${pid}`)) {
        try {
          const taskDir = `/proc/${pid}/task`;
          for (const tid of readdirSync(taskDir)) {
            const childrenFile = `${taskDir}/${tid}/children`;
            if (existsSync(childrenFile)) {
              const data = readFileSync(childrenFile, "utf-8").trim();
              for (const cpid of data.split(/\s+/).filter(Boolean)) {
                const p = parseInt(cpid, 10);
                if (!isNaN(p)) children.push(p, ...getProcessChildren(p, depth + 1));
              }
            }
          }
        } catch {}
      }
    }
  } catch {
    // ignore lookup failures
  }
  return [...new Set(children)];
}

function parseLsofPorts(out: string): Set<number> {
  const ports = new Set<number>();
  for (const line of out.split("\n")) {
    const m = line.match(/:(\d+)(?:\s|$)/);
    if (m) {
      const p = parseInt(m[1], 10);
      if (!isNaN(p) && p > 0 && p < 65536) ports.add(p);
    }
  }
  return ports;
}

function parseNetstatPorts(out: string, pids: Set<number>): Set<number> {
  const ports = new Set<number>();
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    const m = trimmed.match(/^TCP\s+\S+:(\d+)\s+\S+:\d+\s+LISTENING\s+(\d+)/i);
    if (m && pids.has(parseInt(m[2], 10))) {
      const p = parseInt(m[1], 10);
      if (!isNaN(p) && p > 0 && p < 65536) ports.add(p);
    }
  }
  return ports;
}

/**
 * Returns listening TCP ports owned by any of the given PIDs.
 * Works cross-platform: lsof on Unix, netstat on Windows.
 */
export function listeningPortsForPids(pids: number[]): Set<number> {
  if (pids.length === 0) return new Set<number>();
  const pidSet = new Set(pids);
  try {
    if (platform() === "win32") {
      const out = execSync("netstat -ano", { encoding: "utf-8", timeout: 5000 });
      return parseNetstatPorts(out, pidSet);
    }
    const pidList = [...pidSet].join(",");
    try {
      const out = execFileSync(
        "lsof",
        ["-a", "-iTCP", "-sTCP:LISTEN", "-P", "-n", "-p", pidList],
        { encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] },
      ).toString();
      return parseLsofPorts(out);
    } catch {
      // Fallback to ss for Linux
      const out = execFileSync("ss", ["-tlnp"], {
        encoding: "utf-8",
        timeout: 3000,
        stdio: ["pipe", "pipe", "pipe"],
      }).toString();
      const ports = new Set<number>();
      for (const line of out.split("\n")) {
        const pidM = line.match(/pid=(\d+)/);
        if (pidM && pidSet.has(parseInt(pidM[1], 10))) {
          const portM = line.match(/:(\d+)(?:\s|$)/);
          if (portM) ports.add(parseInt(portM[1], 10));
        }
      }
      return ports;
    }
  } catch {
    return new Set<number>();
  }
}

/**
 * Scan a process tree for listening ports, updating the preview entry in place.
 * Returns the set of unique ports found after scanning completes.
 */
async function scanProcessPorts(
  k: string,
  rootPid: number,
  maxWaitMs = PORT_SCAN_TIMEOUT_MS,
): Promise<Set<number>> {
  const found = new Set<number>();
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    const current = previews.get(k);
    if (!current || current.status === "stopped" || current.status === "crashed") break;

    try {
      const tree = [rootPid, ...getProcessChildren(rootPid)];
      const ports = listeningPortsForPids(tree);
      let changed = false;
      for (const p of ports) {
        if (!found.has(p)) {
          found.add(p);
          changed = true;
        }
      }
      if (changed) {
        current.detectedPorts = [...found].sort((a, b) => a - b);
        await persistPreviews();
      }
    } catch {
      // ignore scan errors; we will try again on the next tick
    }

    await new Promise((r) => setTimeout(r, PORT_SCAN_INTERVAL_MS));
  }

  return found;
}

// ─── Health polling ───

function startHealthCheck(k: string): void {
  const info = previews.get(k);
  if (!info) return;
  if (info.status === "running" || info.status === "stopped" || info.status === "crashed") return;
  if (healthTimers.has(k)) return;

  const startTime = Date.now();
  const timer = setInterval(async () => {
    const current = previews.get(k);
    if (!current || current.status === "stopped" || current.status === "crashed") {
      clearInterval(timer);
      healthTimers.delete(k);
      return;
    }

    const reachable = await isPortReachable(current.port, {
      host: "127.0.0.1",
      timeout: 500,
    });

    if (reachable) {
      current.status = "running";
      current.logs.push(`[system] Dev server ready on port ${current.port}`);
      clearInterval(timer);
      healthTimers.delete(k);
      await persistPreviews();
      return;
    }

    // Check if process is still alive
    const p = processes.get(k);
    if (p && p.exitCode !== undefined && p.exitCode !== null) {
      current.status = "crashed";
      current.logs.push(`[system] Dev server exited with code ${p.exitCode}`);
      clearInterval(timer);
      healthTimers.delete(k);
      await persistPreviews();
      return;
    }

    if (Date.now() - startTime > 60000) {
      current.status = "crashed";
      current.logs.push("[system] Health check timed out after 60s");
      clearInterval(timer);
      healthTimers.delete(k);
      await persistPreviews();
    }
  }, 300);

  healthTimers.set(k, timer);
  info.healthTimer = timer;
}

// ─── Public API ───

export async function startPreview(opts: {
  projectId: string;
  cwd: string;
  label?: string;
  port?: number;
  command?: string;
  remoteUrl?: string;
  onLog?: LogCallback;
}): Promise<PreviewInfo> {
  const label = opts.label || "default";
  const k = key(opts.projectId, label);

  // Stop existing preview for this key
  const existing = previews.get(k);
  if (existing && (existing.status === "running" || existing.status === "starting" || existing.status === "detecting" || existing.status === "selecting")) {
    await stopPreview(opts.projectId, label);
  }

  // ── Remote URL mode: no dev server spawned, just proxy to a public URL ──
  if (opts.remoteUrl) {
    let remoteUrl = opts.remoteUrl;
    if (!/^https?:\/\//i.test(remoteUrl)) remoteUrl = "https://" + remoteUrl;
    try { new URL(remoteUrl); } catch { throw new Error(`Invalid remote URL: ${remoteUrl}`); }

    const id = nanoid(12);
    const info: PreviewInfo = {
      id,
      projectId: opts.projectId,
      label,
      port: 0,
      url: `/preview/${opts.projectId}/${label}/`,
      status: "running",
      logs: [`[system] Proxying to remote URL: ${remoteUrl}`],
      startedAt: Date.now(),
      command: null,
      process: null,
      cwd: opts.cwd,
      detectedPorts: [],
      healthTimer: null,
      remoteUrl,
    };
    previews.set(k, info);
    await persistPreviews();
    return info;
  }

  let command = opts.command;
  let requestedPort = opts.port;
  const framework = detectFramework(opts.cwd);
  if (!command && framework) {
    command = framework.command;
    if (!requestedPort) requestedPort = framework.defaultPort;
  }
  if (!command) command = "npm run dev";

  // If the caller explicitly supplied a port and a server is already there,
  // attach to it instead of spawning.
  if (requestedPort && await isPortReachable(requestedPort, { host: "127.0.0.1", timeout: 500 })) {
    const id = nanoid(12);
    const info: PreviewInfo = {
      id,
      projectId: opts.projectId,
      label,
      port: requestedPort,
      url: `/preview/${opts.projectId}/${label}/`,
      status: "running",
      logs: [`[system] Attached to existing dev server on port ${requestedPort}`],
      startedAt: Date.now(),
      command: null,
      process: null,
      cwd: opts.cwd,
      detectedPorts: [requestedPort],
      healthTimer: null,
    };
    previews.set(k, info);
    await persistPreviews();
    if (opts.onLog) {
      let set = logCallbacks.get(k);
      if (!set) { set = new Set(); logCallbacks.set(k, set); }
      set.add(opts.onLog);
    }
    return info;
  }

  const id = nanoid(12);
  const info: PreviewInfo = {
    id,
    projectId: opts.projectId,
    label,
    port: requestedPort || 0,
    url: `/preview/${opts.projectId}/${label}/`,
    status: "detecting" as PreviewStatus,
    logs: [],
    startedAt: Date.now(),
    command,
    process: null,
    cwd: opts.cwd,
    detectedPorts: [],
    healthTimer: null,
  };

  previews.set(k, info);
  await persistPreviews();

  // Spawn the dev server; pass the user/default port as a hint.
  const sh = getPlatformShell();
  const proc = spawn({
    cmd: [sh.shell, sh.flag, command],
    cwd: opts.cwd,
    env: { ...process.env, PORT: String(requestedPort || 0) },
    stdout: "pipe",
    stderr: "pipe",
  });

  processes.set(k, proc);
  if (proc.pid) info.process = proc.pid;

  // Pipe stdout/stderr to logs
  const textDecoder = new TextDecoder();
  const onData = (stream: "stdout" | "stderr") => (chunk: Uint8Array) => {
    const text = textDecoder.decode(chunk);
    const lines = text.split("\n").filter((l) => l.trim());
    for (const line of lines) {
      info.logs.push(`[${stream}] ${line}`);
      if (info.logs.length > 500) info.logs.shift();
      const listeners = logCallbacks.get(k);
      if (listeners) {
        for (const cb of listeners) cb(line, stream);
      }
    }
  };

  const stdoutReader = proc.stdout?.getReader();
  const stderrReader = proc.stderr?.getReader();
  (async () => {
    while (stdoutReader) {
      const { done, value } = await stdoutReader.read();
      if (done) break;
      onData("stdout")(value);
    }
  })().catch(() => {});
  (async () => {
    while (stderrReader) {
      const { done, value } = await stderrReader.read();
      if (done) break;
      onData("stderr")(value);
    }
  })().catch(() => {});

  proc.exited.then((exitCode) => {
    processes.delete(k);
    const current = previews.get(k);
    if (current) {
      if (exitCode !== 0 && current.status !== "stopped") {
        current.status = "crashed";
        current.logs.push(`[system] Process exited with code ${exitCode}`);
      }
    }
  });

  if (opts.onLog) {
    let set = logCallbacks.get(k);
    if (!set) { set = new Set(); logCallbacks.set(k, set); }
    set.add(opts.onLog);
  }

  // Scan process tree for ports, then wait for the user to select one.
  (async () => {
    const rootPid = proc.pid;
    if (!rootPid) {
      info.status = "selecting";
      info.logs.push("[system] Could not read process PID — please enter a port manually.");
      await persistPreviews();
      return;
    }

    info.logs.push("[system] Detecting ports from dev server...");
    const ports = await scanProcessPorts(k, rootPid);

    const current = previews.get(k);
    if (!current) return;

    if (current.status === "stopped" || current.status === "crashed") return;

    if (ports.size > 0) {
      current.status = "selecting";
      const list = [...ports].sort((a, b) => a - b).join(", ");
      current.logs.push(`[system] Dev server ports: ${list}. Select one to open preview.`);
    } else {
      current.status = "selecting";
      current.logs.push("[system] No listening ports detected. Enter a port manually or check logs.");
    }
    current.detectedPorts = [...ports].sort((a, b) => a - b);
    await persistPreviews();
  })().catch(async () => {
    const current = previews.get(k);
    if (current && current.status === "detecting") {
      current.status = "selecting";
      current.logs.push("[system] Port detection ran into an error. Enter a port manually to proceed.");
      await persistPreviews();
    }
  });

  return info;
}

export async function stopPreview(projectId: string, label: string): Promise<void> {
  const k = key(projectId, label);
  const info = previews.get(k);
  if (!info) return;

  info.status = "stopped";
  const timer = healthTimers.get(k);
  if (timer) {
    clearInterval(timer);
    healthTimers.delete(k);
  }
  info.healthTimer = null;

  const proc = processes.get(k);
  if (proc) {
    const pid = proc.pid;
    if (pid) {
      await new Promise<void>((resolve) => {
        treeKill(pid, "SIGTERM", (err) => {
          if (err) {
            try { proc.kill("SIGKILL"); } catch {}
          }
          resolve();
        });
      });
    } else {
      try { proc.kill("SIGKILL"); } catch {}
    }
    processes.delete(k);
  }

  info.process = null;
  info.logs.push("[system] Preview stopped");
  await persistPreviews();
}

/** Select or switch the preview port and start health checking. */
export async function setPreviewPort(projectId: string, label: string, newPort: number): Promise<PreviewInfo | null> {
  const k = key(projectId, label);
  const info = previews.get(k);
  if (!info) return null;

  info.port = newPort;
  info.logs.push(`[system] Selected port ${newPort}`);

  if (info.status === "detecting" || info.status === "selecting" || info.status === "starting") {
    info.status = "starting";
    startHealthCheck(k);
  }

  await persistPreviews();
  return info;
}

export function getPreview(projectId: string, label: string): PreviewInfo | null {
  return previews.get(key(projectId, label)) || null;
}

/** Update the remote URL for a running preview */
export async function setPreviewRemoteUrl(projectId: string, label: string, newRemoteUrl: string): Promise<PreviewInfo | null> {
  const k = key(projectId, label);
  const info = previews.get(k);
  if (!info) return null;
  if (!/^https?:\/\//i.test(newRemoteUrl)) newRemoteUrl = "https://" + newRemoteUrl;
  try { new URL(newRemoteUrl); } catch { throw new Error(`Invalid remote URL: ${newRemoteUrl}`); }
  info.remoteUrl = newRemoteUrl;
  info.logs.push(`[system] Switched proxy to remote URL: ${newRemoteUrl}`);
  await persistPreviews();
  return info;
}

export function listPreviews(projectId?: string): PreviewInfo[] {
  const all = Array.from(previews.values());
  if (projectId) return all.filter((p) => p.projectId === projectId);
  return all;
}

export function addLogListener(
  projectId: string,
  label: string,
  cb: LogCallback,
): () => void {
  const k = key(projectId, label);
  let set = logCallbacks.get(k);
  if (!set) { set = new Set(); logCallbacks.set(k, set); }
  set.add(cb);
  return () => {
    set?.delete(cb);
    if (set && set.size === 0) logCallbacks.delete(k);
  };
}

// Cleanup on server shutdown
export async function stopAllPreviews(): Promise<void> {
  const all = Array.from(previews.entries());
  for (const [k, info] of all) {
    await stopPreview(info.projectId, info.label);
  }
}

// Initialize: load persisted previews on import
loadPreviews().catch(() => {});

// Mark persisted previews as stopped on restart (processes don't survive)
for (const [, info] of previews) {
  info.status = "stopped";
  info.process = null;
  info.healthTimer = null;
  info.logs.push("[system] Server restart — preview process not preserved");
}
persistPreviews().catch(() => {});
