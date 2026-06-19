/**
 * Server-side reader for the pi-subagents extension's async run state.
 *
 * The extension (pi-subagents) launches background subagent runs and persists
 * per-run state to disk under a temp-scope root:
 *   {tmpdir}/pi-subagents-{scope}/async-subagent-runs/{runId}/status.json
 *   {tmpdir}/pi-subagents-{scope}/async-subagent-runs/{runId}/events.jsonl
 *   {tmpdir}/pi-subagents-{scope}/async-subagent-runs/{runId}/output-*.log
 *
 * pi's RPC mode has no "invoke tool" command, so we cannot ask the agent to run
 * `subagent({action:"status"})` directly. Instead we read these files straight
 * from disk (same user → same temp scope) and, to interrupt, send the runner's
 * interrupt signal (SIGUSR2 on unix, SIGBREAK on win32) to the PID recorded in
 * status.json — the runner registers a handler for exactly that signal.
 *
 * Resume must go through the agent (it revives a child from the persisted
 * session file), so the UI sends a prompt for that — not handled here.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type {
  SubagentAsyncRun,
  SubagentParallelGroup,
  SubagentRunListResponse,
  SubagentRunOutputResponse,
  SubagentRunStep,
  SubagentInterruptResponse,
} from "@pi-web/shared";

// ─── Temp-scope resolution (mirrors pi-subagents resolveTempScopeId) ───

function sanitizeScopeSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "unknown";
}

function resolveTempScopeId(env: NodeJS.ProcessEnv = process.env): string {
  const getuid = process.getuid?.bind(process);
  if (typeof getuid === "function") return `uid-${getuid()}`;

  for (const key of ["USERNAME", "USER", "LOGNAME"] as const) {
    const value = env[key];
    if (value) return `user-${sanitizeScopeSegment(value)}`;
  }

  try {
    const username = os.userInfo()?.username;
    if (username) return `user-${sanitizeScopeSegment(username)}`;
  } catch {
    // fall through to home-dir scoping
  }

  const home = env.USERPROFILE ?? env.HOME;
  if (home) return `home-${sanitizeScopeSegment(home)}`;

  try {
    const fallbackHome = os.homedir();
    if (fallbackHome) return `home-${sanitizeScopeSegment(fallbackHome)}`;
  } catch {
    // ignore
  }

  return "shared";
}

/** Root temp dir shared by the extension and this server (same scope = same user). */
export function getTempRootDir(): string {
  return path.join(os.tmpdir(), `pi-subagents-${resolveTempScopeId()}`);
}

export function getAsyncDir(): string {
  return path.join(getTempRootDir(), "async-subagent-runs");
}

// ─── Interrupt signal (mirrors the extension's ASYNC_INTERRUPT_SIGNAL) ───

const ASYNC_INTERRUPT_SIGNAL: NodeJS.Signals = process.platform === "win32" ? "SIGBREAK" : "SIGUSR2";

// ─── status.json shape (subset we care about) ───

interface AsyncStatusFile {
  runId?: string;
  sessionId?: string;
  state?: "queued" | "running" | "complete" | "failed" | "paused";
  activityState?: "active_long_running" | "needs_attention";
  lastActivityAt?: number;
  currentTool?: string;
  currentToolStartedAt?: number;
  currentPath?: string;
  turnCount?: number;
  toolCount?: number;
  mode?: "single" | "parallel" | "chain";
  agent?: string;
  agents?: string[];
  cwd?: string;
  pid?: number;
  startedAt?: number;
  endedAt?: number;
  lastUpdate?: number;
  currentStep?: number;
  chainStepCount?: number;
  parallelGroups?: SubagentParallelGroup[];
  steps?: Array<Record<string, unknown>>;
  outputFile?: string;
  sessionFile?: string;
  totalTokens?: { input: number; output: number; total: number };
  error?: string;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

/** Resolve a run by id (exact asyncDir match) — returns the dir path or null. */
function resolveRunDir(runId: string): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) return null; // ponytail: guard path traversal
  const dir = path.join(getAsyncDir(), runId);
  return isDir(dir) ? dir : null;
}

function statusToRun(asyncDir: string, status: AsyncStatusFile): SubagentAsyncRun {
  const runId = status.runId ?? path.basename(asyncDir);
  const steps: SubagentRunStep[] = (status.steps ?? []).map((step, index) => ({
    index,
    agent: String(step.agent ?? "unknown"),
    ...(typeof step.phase === "string" ? { phase: step.phase } : {}),
    ...(typeof step.label === "string" ? { label: step.label } : {}),
    ...(typeof step.outputName === "string" ? { outputName: step.outputName } : {}),
    status: (step.status as SubagentRunStep["status"]) ?? "pending",
    ...(typeof step.activityState === "string" ? { activityState: step.activityState as SubagentRunStep["activityState"] } : {}),
    ...(typeof step.lastActivityAt === "number" ? { lastActivityAt: step.lastActivityAt } : {}),
    ...(typeof step.currentTool === "string" ? { currentTool: step.currentTool } : {}),
    ...(typeof step.currentToolArgs === "string" ? { currentToolArgs: step.currentToolArgs } : {}),
    ...(typeof step.currentToolStartedAt === "number" ? { currentToolStartedAt: step.currentToolStartedAt } : {}),
    ...(typeof step.currentPath === "string" ? { currentPath: step.currentPath } : {}),
    ...(typeof step.turnCount === "number" ? { turnCount: step.turnCount } : {}),
    ...(typeof step.toolCount === "number" ? { toolCount: step.toolCount } : {}),
    ...(typeof step.durationMs === "number" ? { durationMs: step.durationMs } : {}),
    ...(step.tokens ? { tokens: step.tokens as SubagentRunStep["tokens"] } : {}),
    ...(Array.isArray(step.skills) ? { skills: step.skills as string[] } : {}),
    ...(typeof step.model === "string" ? { model: step.model } : {}),
    ...(typeof step.error === "string" ? { error: step.error } : {}),
  }));

  return {
    runId,
    asyncDir,
    ...(status.sessionId ? { sessionId: status.sessionId } : {}),
    state: status.state ?? "running",
    ...(status.activityState ? { activityState: status.activityState } : {}),
    ...(typeof status.lastActivityAt === "number" ? { lastActivityAt: status.lastActivityAt } : {}),
    ...(status.currentTool ? { currentTool: status.currentTool } : {}),
    ...(typeof status.currentToolStartedAt === "number" ? { currentToolStartedAt: status.currentToolStartedAt } : {}),
    ...(status.currentPath ? { currentPath: status.currentPath } : {}),
    ...(typeof status.turnCount === "number" ? { turnCount: status.turnCount } : {}),
    ...(typeof status.toolCount === "number" ? { toolCount: status.toolCount } : {}),
    mode: status.mode ?? (steps.length > 1 ? "chain" : "single"),
    ...(status.agent ? { agent: status.agent } : {}),
    ...(Array.isArray(status.agents) ? { agents: status.agents } : {}),
    ...(status.cwd ? { cwd: status.cwd } : {}),
    ...(typeof status.pid === "number" ? { pid: status.pid } : {}),
    startedAt: status.startedAt ?? Date.now(),
    ...(typeof status.endedAt === "number" ? { endedAt: status.endedAt } : {}),
    ...(typeof status.lastUpdate === "number" ? { lastUpdate: status.lastUpdate } : {}),
    ...(typeof status.currentStep === "number" ? { currentStep: status.currentStep } : {}),
    ...(typeof status.chainStepCount === "number" ? { chainStepCount: status.chainStepCount } : {}),
    ...(Array.isArray(status.parallelGroups) ? { parallelGroups: status.parallelGroups } : {}),
    steps,
    ...(status.outputFile ? { outputFile: status.outputFile } : {}),
    ...(status.sessionFile ? { sessionFile: status.sessionFile } : {}),
    ...(status.totalTokens ? { totalTokens: status.totalTokens } : {}),
    ...(status.error ? { error: status.error } : {}),
  };
}

/**
 * List all async runs on disk, newest first. Reads every status.json under the
 * async runs root. Cheap enough to poll every couple seconds.
 */
export function listSubagentRuns(): SubagentRunListResponse {
  const asyncDirRoot = getAsyncDir();
  const runs: SubagentAsyncRun[] = [];
  if (isDir(asyncDirRoot)) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(asyncDirRoot);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      const dir = path.join(asyncDirRoot, entry);
      if (!isDir(dir)) continue;
      const statusPath = path.join(dir, "status.json");
      const status = readJsonFile<AsyncStatusFile>(statusPath);
      if (!status) continue;
      try {
        runs.push(statusToRun(dir, status));
      } catch {
        // skip malformed
      }
    }
  }
  runs.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return { runs, asyncDirRoot };
}

/**
 * Interrupt an async run by sending the runner's interrupt signal to the PID in
 * its status.json. The runner pauses the current turn; it does not fail the run.
 */
export function interruptSubagentRun(runId: string): SubagentInterruptResponse {
  const dir = resolveRunDir(runId);
  if (!dir) return { runId, ok: false, message: "Run not found" };

  const status = readJsonFile<AsyncStatusFile>(path.join(dir, "status.json"));
  if (!status) return { runId, ok: false, message: "status.json not found" };

  if (status.state && status.state !== "running") {
    return { runId, ok: false, message: `Run is not running (state: ${status.state})` };
  }

  const pid = status.pid;
  if (typeof pid !== "number" || pid <= 0) {
    return { runId, ok: false, message: "No PID recorded for this run" };
  }

  try {
    // process.kill(pid, 0) throws if the process is gone.
    process.kill(pid, 0);
  } catch {
    return { runId, ok: false, message: "Runner process is no longer running" };
  }

  try {
    process.kill(pid, ASYNC_INTERRUPT_SIGNAL);
    return { runId, ok: true, message: "Interrupt signal sent — run will pause" };
  } catch (err) {
    return { runId, ok: false, message: `Failed to signal: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Read the tail of a run's output log (and events.jsonl) for the panel's
 * expanded view. Keeps the last ~400 lines combined.
 */
export function readSubagentRunOutput(runId: string): SubagentRunOutputResponse {
  const dir = resolveRunDir(runId);
  if (!dir) return { runId, lines: [], truncated: false };

  const lines: string[] = [];
  const MAX_LINES = 400;

  // Collect output-*.log files (newest by mtime) plus events.jsonl.
  const files: Array<{ path: string; mtime: number }> = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      if ((name.startsWith("output-") && name.endsWith(".log")) || name === "events.jsonl") {
        const full = path.join(dir, name);
        try {
          const st = fs.statSync(full);
          if (st.isFile()) files.push({ path: full, mtime: st.mtimeMs });
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }
  files.sort((a, b) => a.mtime - b.mtime);

  let truncated = false;
  for (const file of files) {
    if (lines.length >= MAX_LINES) {
      truncated = true;
      break;
    }
    try {
      const content = fs.readFileSync(file.path, "utf-8");
      const fileLines = content.split(/\r?\n/).filter((l) => l.length > 0);
      // Tag events.jsonl lines so the panel can style control events.
      const isEvents = path.basename(file.path) === "events.jsonl";
      for (const line of fileLines) {
        if (lines.length >= MAX_LINES) {
          truncated = true;
          break;
        }
        if (isEvents) {
          try {
            const evt = JSON.parse(line);
            const kind = evt.type ?? "event";
            const msg = evt.message ?? evt.summary ?? JSON.stringify(evt);
            lines.push(`▸ ${kind}: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`);
            continue;
          } catch {
            lines.push(`▸ ${line}`);
            continue;
          }
        }
        lines.push(line);
      }
    } catch {
      // ignore unreadable
    }
  }

  return { runId, lines, truncated };
}

/** Whether the subagent extension appears installed/active (temp root exists). */
export function isSubagentExtensionAvailable(): boolean {
  return isDir(getTempRootDir());
}
