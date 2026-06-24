/**
 * Server-side reader for the pi-subagents extension's async run state.
 *
 * TODO(upstream): pi's RPC mode has no public extension command/tool for
 * status/interrupt yet, so we read the extension's private on-disk state
 * directly. Once the extension exposes a registered command (e.g.
 * `subagent({action:"status"})` / `subagent({action:"interrupt"})`), this
 * module should call that command instead of reaching into temp files.
 *
 * The extension (pi-subagents) launches background subagent runs and persists
 * per-run state to disk under a temp-scope root:
 *   {tmpdir}/pi-subagents-{scope}/async-subagent-runs/{runId}/status.json
 *   {tmpdir}/pi-subagents-{scope}/async-subagent-runs/{runId}/events.jsonl
 *   {tmpdir}/pi-subagents-{scope}/async-subagent-runs/{runId}/output-*.log
 *
 * We load resolveTempScopeId and ASYNC_DIR directly from the installed
 * extension so the server and the extension agree on the temp scope and run
 * directory without duplicating that logic.
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

// ─── Import from the installed pi-subagents extension source ───
//
// The extension is installed in pi's global npm tree, not in this project's
// node_modules, so we resolve it at runtime from an absolute path.  Using a
// non-literal specifier keeps `tsc -b` from trying to typecheck the extension's
// source files (which reference peer dependencies we don't depend on).
const PI_SUBAGENTS_TYPES_PATH = path.join(
  os.homedir(),
  ".pi/agent/npm/node_modules/pi-subagents/src/shared/types.ts",
);
const ext = await import(PI_SUBAGENTS_TYPES_PATH);

function assertExtensionShape(mod: Record<string, unknown>): void {
  if (typeof mod.resolveTempScopeId !== "function") {
    throw new Error("pi-subagents: resolveTempScopeId not exported");
  }
  if (typeof mod.ASYNC_DIR !== "string" || !mod.ASYNC_DIR.endsWith("async-subagent-runs")) {
    throw new Error("pi-subagents: ASYNC_DIR missing or unexpected");
  }
}
assertExtensionShape(ext);

const resolveTempScopeId = ext.resolveTempScopeId as (options?: {
  env?: NodeJS.ProcessEnv;
  getuid?: (() => number) | undefined;
  userInfo?: (() => { username?: string | null }) | undefined;
  homedir?: (() => string) | undefined;
}) => string;
const ASYNC_DIR: string = ext.ASYNC_DIR;

/** Root temp dir shared by the extension and this server (same scope = same user). */
export function getTempRootDir(): string {
  return path.dirname(ASYNC_DIR);
}

export function getAsyncDir(): string {
  return ASYNC_DIR;
}

// ─── Interrupt signal (mirrors the extension's ASYNC_INTERRUPT_SIGNAL) ───

const ASYNC_INTERRUPT_SIGNAL: NodeJS.Signals = process.platform === "win32" ? "SIGBREAK" : "SIGUSR2";

// ─── status.json shape ───
//
// Tracks `pi-subagents/src/shared/types.ts#AsyncStatus`. Kept as a structural
// copy because the extension source has no generated .d.ts and importing its
// .ts file directly would force `tsc -b` to typecheck its peer dependencies.
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
  const dir = path.join(ASYNC_DIR, runId);
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
  const asyncDirRoot = ASYNC_DIR;
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
  if (typeof pid !== "number" || !Number.isFinite(pid)) {
    return { runId, ok: false, message: "No PID recorded for this run" };
  }
  // Defensive: never signal init, self, or bogus PIDs. process.kill(pid, 0)
  // only tells us the process exists; it cannot verify same UID, so we at
  // least require a positive PID greater than 1.
  if (pid <= 1) {
    return { runId, ok: false, message: "Refusing to signal invalid PID" };
  }

  try {
    // process.kill(pid, 0) throws if the process is gone.
    process.kill(pid, 0);
  } catch {
    return { runId, ok: false, message: "Runner process is no longer running" };
  }

  try {
    process.kill(pid, ASYNC_INTERRUPT_SIGNAL);
    // Don't claim the run is paused here; the runner must write that state.
    return { runId, ok: true, message: "Interrupt signal sent" };
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
