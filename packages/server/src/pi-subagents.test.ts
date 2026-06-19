import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  getTempRootDir,
  getAsyncDir,
  listSubagentRuns,
  interruptSubagentRun,
  readSubagentRunOutput,
  isSubagentExtensionAvailable,
} from "./pi-subagents";

/**
 * Tests for the pi-subagents server reader.
 *
 * The module reads the extension's per-run status.json from a temp-scope dir.
 * These tests create real run directories under that resolved root, then clean
 * up, so they exercise the exact path the extension would write to.
 */

const CREATED_DIRS: string[] = [];

function makeRunDir(runId: string): string {
  const dir = join(getAsyncDir(), runId);
  mkdirSync(dir, { recursive: true });
  CREATED_DIRS.push(dir);
  return dir;
}

function writeStatus(runId: string, status: Record<string, unknown>): string {
  const dir = makeRunDir(runId);
  writeFileSync(join(dir, "status.json"), JSON.stringify({ runId, ...status }));
  return dir;
}

beforeEach(() => {
  // Ensure the temp root exists so isSubagentExtensionAvailable is true.
  mkdirSync(getTempRootDir(), { recursive: true });
});

afterEach(() => {
  for (const dir of CREATED_DIRS.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

describe("pi-subagents temp scope", () => {
  it("resolves a non-empty temp root dir", () => {
    expect(getTempRootDir()).toContain("pi-subagents-");
    expect(getAsyncDir()).toContain("async-subagent-runs");
    expect(isSubagentExtensionAvailable()).toBe(true);
  });
});

describe("listSubagentRuns", () => {
  it("reads status.json files into run summaries, newest first", () => {
    writeStatus("run-old", {
      state: "complete",
      mode: "single",
      agent: "worker",
      startedAt: 1000,
      endedAt: 2000,
      steps: [{ agent: "worker", status: "completed", toolCount: 3, tokens: { input: 10, output: 20, total: 30 } }],
    });
    writeStatus("run-new", {
      state: "running",
      mode: "chain",
      agents: ["scout", "planner"],
      pid: 999999,
      startedAt: 5000,
      currentTool: "read",
      steps: [
        { agent: "scout", status: "completed" },
        { agent: "planner", status: "running" },
      ],
    });

    const { runs } = listSubagentRuns();
    const ids = runs.map((r) => r.runId);
    expect(ids).toContain("run-old");
    expect(ids).toContain("run-new");
    // newest first
    expect(ids.indexOf("run-new")).toBeLessThan(ids.indexOf("run-old"));

    const running = runs.find((r) => r.runId === "run-new")!;
    expect(running.state).toBe("running");
    expect(running.mode).toBe("chain");
    expect(running.currentTool).toBe("read");
    expect(running.steps).toHaveLength(2);
    expect(running.steps[1].agent).toBe("planner");
  });

  it("skips run directories without a readable status.json", () => {
    // Directory with no status.json
    makeRunDir("run-no-status");
    const { runs } = listSubagentRuns();
    expect(runs.find((r) => r.runId === "run-no-status")).toBeUndefined();
  });
});

describe("interruptSubagentRun", () => {
  it("refuses a run that is not running", () => {
    writeStatus("run-done", { state: "complete", pid: 999999 });
    const res = interruptSubagentRun("run-done");
    expect(res.ok).toBe(false);
    expect(res.message).toContain("not running");
  });

  it("rejects path-traversal run ids", () => {
    const res = interruptSubagentRun("../escape");
    expect(res.ok).toBe(false);
    expect(res.message).toBe("Run not found");
  });

  it("reports a missing PID for a running run", () => {
    writeStatus("run-nopid", { state: "running" });
    const res = interruptSubagentRun("run-nopid");
    expect(res.ok).toBe(false);
    expect(res.message).toContain("No PID");
  });

  it("detects a dead runner PID", () => {
    writeStatus("run-deadpid", { state: "running", pid: 999999 });
    const res = interruptSubagentRun("run-deadpid");
    // PID 999999 almost certainly does not exist
    expect(res.ok).toBe(false);
    expect(res.message).toContain("no longer running");
  });
});

describe("readSubagentRunOutput", () => {
  it("reads and tags output + events lines", () => {
    const dir = makeRunDir("run-out");
    writeFileSync(join(dir, "output-0.log"), "first line\nsecond line\n");
    writeFileSync(join(dir, "events.jsonl"), JSON.stringify({ type: "control-event", message: "needs attention" }) + "\n");
    const res = readSubagentRunOutput("run-out");
    expect(res.runId).toBe("run-out");
    expect(res.lines.some((l) => l.includes("first line"))).toBe(true);
    expect(res.lines.some((l) => l.startsWith("▸ control-event"))).toBe(true);
    expect(res.lines.some((l) => l.includes("needs attention"))).toBe(true);
  });

  it("returns empty for a non-existent run", () => {
    const res = readSubagentRunOutput("does-not-exist-zzz");
    expect(res.lines).toEqual([]);
    expect(res.truncated).toBe(false);
  });
});

describe("runId safety", () => {
  it("existsSync check uses sanitized ids only", () => {
    expect(existsSync(join(getAsyncDir(), ".."))).toBe(true); // parent exists
    // But resolveRunDir rejects traversal, so interrupt/output are safe:
    expect(interruptSubagentRun("../..").ok).toBe(false);
  });
});
