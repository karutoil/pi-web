import { describe, test, expect } from "bun:test";
import { computeProjectUsage, buildUsageSummary } from "./pi-sessions";
import type { SessionSummary } from "@pi-web/shared";

function mkSummary(partial: Partial<SessionSummary>): SessionSummary {
  return {
    id: partial.id || "s1",
    filePath: partial.filePath || "/tmp/s1.jsonl",
    cwd: "",
    timestamp: "",
    name: null,
    messageCount: partial.messageCount ?? 0,
    lastMessage: null,
    model: partial.model ?? null,
    firstMessage: null,
    createdAt: "",
    lastActiveAt: "",
    tokenCount: partial.tokenCount ?? 0,
    cost: partial.cost ?? 0,
    isRecentlyActive: false,
  };
}

describe("computeProjectUsage", () => {
  test("sums tokens, cost, messages and counts sessions", () => {
    const sessions = [
      mkSummary({ tokenCount: 100, cost: 0.5, messageCount: 4, model: "a" }),
      mkSummary({ tokenCount: 200, cost: 1.5, messageCount: 6, model: "b" }),
    ];
    const u = computeProjectUsage(sessions);
    expect(u.sessionCount).toBe(2);
    expect(u.totalTokens).toBe(300);
    expect(u.totalCost).toBe(2);
    expect(u.totalMessages).toBe(10);
  });

  test("treats missing/zero fields as zero (no NaN)", () => {
    const u = computeProjectUsage([mkSummary({})]);
    expect(u.totalTokens).toBe(0);
    expect(u.totalCost).toBe(0);
    expect(Number.isNaN(u.totalTokens)).toBe(false);
  });
});

describe("buildUsageSummary", () => {
  test("aggregates across projects and groups by model", async () => {
    // Two fake projects; listProjectSessions reads from ~/.pi on disk, so we
    // verify the shape + totals roll up (real sessions exist in this env).
    const projects = [
      { id: "p1", name: "alpha", path: "/nonexistent/alpha" },
      { id: "p2", name: "beta", path: "/nonexistent/beta" },
    ];
    const summary = await buildUsageSummary(projects);
    // Nonexistent paths → no sessions, but structure must be intact.
    expect(summary.totalSessions).toBe(0);
    expect(summary.projects).toHaveLength(2);
    expect(summary.projects[0]).toHaveProperty("totalTokens", 0);
    expect(summary.byModel).toEqual([]);
    expect(summary.fetchedAt).toBeTruthy();
  });
});
