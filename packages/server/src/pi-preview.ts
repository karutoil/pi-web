/**
 * Preview Manager — manages dev server processes for the preview pane.
 *
 * Keyed by (projectId, label) so a single project can host multiple
 * previews (e.g. main app on "default" + storybook on "storybook").
 *
 * Process lifecycle:
 *  1. User calls POST /api/preview/start  →  spawn dev command
 *  2. Health-poll target URL every 300ms until 200
 *  3. Mark status = "running" → proxy becomes available
 *  4. User calls POST /api/preview/stop   →  tree-kill + cleanup
 *  5. On server shutdown, kill all previews
 */

import { spawn, type Subprocess } from "bun";
import type { PreviewInfo, PreviewStatus } from "@pi-web/shared";
import { nanoid } from "nanoid";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { existsSync, statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import treeKill from "tree-kill";
import isPortReachable from "is-port-reachable";
import getPort from "get-port";

const PREVIEWS_FILE = join(homedir(), ".pi", "previews.json");

// ─── In-memory store ───
const previews = new Map<string, PreviewInfo>();

// Active subprocess handles keyed by `projectId:label`
const processes = new Map<string, Subprocess>();

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

// ─── Port scanning ───

/**
 * Get all currently listening TCP ports (system-wide).
 * Used for before/after diffing to detect newly opened ports after process spawn.
 */
function allListeningPorts(): Set<number> {
  const ports = new Set<number>();
  try {
    const out = execSync(`lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null || ss -tlnp 2>/dev/null || true`, {
      encoding: "utf-8",
      timeout: 3000,
    });
    const lines = out.trim().split("\n").filter(Boolean);
    for (const line of lines) {
      // Match either lsof format (*:PORT) or ss format (IP:PORT)
      const m = line.match(/:(\d+)(?:\s|$)/);
      if (m) {
        const p = parseInt(m[1], 10);
        if (!isNaN(p) && p > 0 && p < 65536) ports.add(p);
      }
    }
  } catch { /* ignore */ }
  return ports;
}

/**
 * Detect new ports opened after spawning a process.
 * Takes a pre-spawn snapshot, waits for the process to start, then diffs.
 */
async function detectNewPorts(
  preSpawnPorts: Set<number>,
  maxWaitMs = 12000,
): Promise<number[]> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const current = allListeningPorts();
    const newPorts = Array.from(current).filter((p) => !preSpawnPorts.has(p)).sort((a, b) => a - b);
    if (newPorts.length > 0) return newPorts;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return [];
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
  if (existing && (existing.status === "running" || existing.status === "starting")) {
    await stopPreview(opts.projectId, label);
  }

  // ── Remote URL mode: no dev server spawned, just proxy to a public URL ──
  if (opts.remoteUrl) {
    let remoteUrl = opts.remoteUrl;
    // Ensure the URL has a protocol
    if (!/^https?:\/\//i.test(remoteUrl)) remoteUrl = "https://" + remoteUrl;
    // Validate that the URL parses
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
  let port = opts.port;

  // ── Safety checks ──

  // If no command specified, detect framework or fall back to "npm run dev"
  if (!command) {
    const framework = detectFramework(opts.cwd);
    if (framework) {
      command = framework.command;
      if (!opts.port) port = framework.defaultPort;
    }
  }
  if (!command) command = "npm run dev";
  if (!port) port = await getPort({ port: 3000 });

  // If the target port is already reachable, attach to the existing server
  // instead of spawning a new process (user likely already has dev server running)
  if (await isPortReachable(port, { host: "127.0.0.1", timeout: 500 })) {
    const id = nanoid(12);
    const info: PreviewInfo = {
      id,
      projectId: opts.projectId,
      label,
      port,
      url: `/preview/${opts.projectId}/${label}/`,
      status: "running",
      logs: [`[system] Attached to existing dev server on port ${port}`],
      startedAt: Date.now(),
      command: null,
      process: null,
      cwd: opts.cwd,
      detectedPorts: [port],
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

  // No existing server: spawn the dev command

  const id = nanoid(12);
  const info: PreviewInfo = {
    id,
    projectId: opts.projectId,
    label,
    port,
    url: `/preview/${opts.projectId}/${label}/`,
    status: "detecting" as PreviewStatus,
    logs: [],
    startedAt: Date.now(),
    command,
    process: null,
    cwd: opts.cwd,
    detectedPorts: [],  // Empty until real ports are found
    healthTimer: null,
  };

  previews.set(k, info);
  await persistPreviews();

  // Snapshot all ports BEFORE spawning (for diff-based detection)
  const preSpawnPorts = allListeningPorts();

  // Spawn the dev server
  const shell = process.env.SHELL || "/bin/bash";
  const proc = spawn({
    cmd: [shell, "-c", command],
    cwd: opts.cwd,
    env: { ...process.env, PORT: String(port) },
    stdout: "pipe",
    stderr: "pipe",
  });

  processes.set(k, proc);
  
  // Store PID for port scanning
  if (proc.pid) {
    info.process = proc.pid;
  }

  // Pipe stdout/stderr to logs
  const textDecoder = new TextDecoder();
  const onData = (stream: "stdout" | "stderr") => (chunk: Uint8Array) => {
    const text = textDecoder.decode(chunk);
    const lines = text.split("\n").filter(l => l.trim());
    for (const line of lines) {
      info.logs.push(`[${stream}] ${line}`);
      if (info.logs.length > 500) info.logs.shift();
      // Notify log listeners
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

  // Register log listener
  if (opts.onLog) {
    let set = logCallbacks.get(k);
    if (!set) { set = new Set(); logCallbacks.set(k, set); }
    set.add(opts.onLog);
  }

  // Start port detection in the background (runs for ~12s after spawn)
  (async () => {
    info.logs.push("[system] Detecting new ports from dev server...");
    const ports = await detectNewPorts(preSpawnPorts, 12000);
    const current = previews.get(k);
    if (!current) return;
    
    if (ports.length > 0) {
      current.detectedPorts = ports;
      // If the guessed port matches a detected port, use it. Otherwise use the first detected.
      if (!ports.includes(current.port)) {
        current.port = ports[0];
        current.logs.push(`[system] Guessed port ${port} not found, using detected port ${ports[0]}`);
      }
      current.logs.push(`[system] Detected ports: ${ports.join(", ")}`);
      current.status = "starting";
      startHealthCheck();
    } else {
      current.logs.push("[system] No listening ports detected — trying guessed port");
      current.status = "starting";
      startHealthCheck();
    }
    await persistPreviews();
  })().catch(() => {
    // If port detection crashes, fall back to health check
    const current = previews.get(k);
    if (current && current.status === "detecting") {
      current.status = "starting";
      startHealthCheck();
    }
  });

  // Health-poll function (extracted so it can be started after port detection)
  const checkHealth = async (): Promise<boolean> => {
    const current = previews.get(k);
    if (!current || current.status === "stopped" || current.status === "crashed") {
      return false;
    }
    // Use the current port (may have been updated by port detection)
    const targetPort = current.port;
    const reachable = await isPortReachable(targetPort, { host: "127.0.0.1", timeout: 500 });
    if (reachable) {
      current.status = "running";
      current.logs.push(`[system] Dev server ready on port ${targetPort}`);
      await persistPreviews();
      return true;
    }
    // Check if process is still alive
    const p = processes.get(k);
    if (p && p.exitCode !== undefined && p.exitCode !== null) {
      current.status = "crashed";
      current.logs.push(`[system] Dev server exited with code ${p.exitCode}`);
      await persistPreviews();
      return false;
    }
    return false;
  };

  // Start health polling (called after port detection completes)
  const startTime = Date.now();
  let healthInterval: ReturnType<typeof setInterval> | null = null;
  
  function startHealthCheck() {
    if (healthInterval) return; // Already started
    const current = previews.get(k);
    if (!current || current.status === "stopped" || current.status === "crashed") return;
    
    healthInterval = setInterval(async () => {
      const ok = await checkHealth();
      const current = previews.get(k);
      if (ok || !current) {
        if (healthInterval) clearInterval(healthInterval);
        if (current) current.healthTimer = null;
        return;
      }
      // Timeout after 60s
      if (Date.now() - startTime > 60000) {
        if (healthInterval) clearInterval(healthInterval);
        if (current && current.status === "starting") {
          current.status = "crashed";
          current.logs.push("[system] Health check timed out after 60s");
          await persistPreviews();
        }
      }
    }, 300);
    info.healthTimer = healthInterval as unknown as ReturnType<typeof setInterval>;
  }

  return info;
}

export async function stopPreview(projectId: string, label: string): Promise<void> {
  const k = key(projectId, label);
  const info = previews.get(k);
  if (!info) return;

  info.status = "stopped";
  if (info.healthTimer) clearInterval(info.healthTimer);
  info.healthTimer = null;

  // Kill the process and children
  const proc = processes.get(k);
  if (proc) {
    const pid = proc.pid;
    if (pid) {
      await new Promise<void>((resolve) => {
        treeKill(pid, "SIGTERM", (err) => {
          if (err) {
            // Fallback: force kill
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

/** Switch the proxy target port for a running preview */
export async function setPreviewPort(projectId: string, label: string, newPort: number): Promise<PreviewInfo | null> {
  const k = key(projectId, label);
  const info = previews.get(k);
  if (!info) return null;
  info.port = newPort;
  info.logs.push(`[system] Switched proxy to port ${newPort}`);
  
  // If still detecting/starting, trigger health check against the new port
  if (info.status === "detecting" || info.status === "starting") {
    info.status = "starting";
    // Kick off health check — the startHealthCheck function is internal to startPreview
    // We do a simple health poll here for 30s
    const startTime = Date.now();
    const healthTimer = setInterval(async () => {
      const current = previews.get(k);
      if (!current || current.status === "stopped" || current.status === "crashed") {
        clearInterval(healthTimer);
        return;
      }
      const reachable = await isPortReachable(current.port, { host: "127.0.0.1", timeout: 500 });
      if (reachable) {
        current.status = "running";
        current.logs.push(`[system] Dev server ready on port ${current.port}`);
        clearInterval(healthTimer);
        await persistPreviews();
      } else if (Date.now() - startTime > 30000) {
        current.status = "crashed";
        current.logs.push("[system] Health check timed out after 30s");
        clearInterval(healthTimer);
        await persistPreviews();
      }
    }, 300);
    info.healthTimer = healthTimer as unknown as ReturnType<typeof setInterval>;
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
  // Ensure URL has protocol
  if (!/^https?:\/\//i.test(newRemoteUrl)) newRemoteUrl = "https://" + newRemoteUrl;
  try { new URL(newRemoteUrl); } catch { throw new Error(`Invalid remote URL: ${newRemoteUrl}`); }
  info.remoteUrl = newRemoteUrl;
  info.logs.push(`[system] Switched proxy to remote URL: ${newRemoteUrl}`);
  await persistPreviews();
  return info;
}

export function listPreviews(projectId?: string): PreviewInfo[] {
  const all = Array.from(previews.values());
  if (projectId) return all.filter(p => p.projectId === projectId);
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
