import { describe, it, expect } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getVersionInfo, findGitRoot } from "./pi-version";

/**
 * Tests for the version / update-checker module. The behaviour we care
 * about here:
 *
 *   1. `findGitRoot` walks up from a starting directory until it hits a
 *      `.git` entry (file or directory).
 *   2. `getVersionInfo` returns the `unavailable` sentinel when invoked
 *      outside any working tree.
 *   3. `getVersionInfo({ fetch: false })` does not touch the network,
 *      which keeps this test fast and offline-safe.
 */

describe("findGitRoot", () => {
  it("returns null when there is no .git directory above the start", () => {
    // tmpdir has no .git — guaranteed.
    const result = findGitRoot(tmpdir());
    expect(result).toBeNull();
  });

  it("locates a real .git directory by walking upward", () => {
    // Use this very repo as the target. We only need the lookup to succeed
    // and return a directory that contains `.git`.
    const root = findGitRoot(import.meta.dir);
    expect(root).not.toBeNull();
    if (root) expect(existsSync(join(root, ".git"))).toBe(true);
  });
});

describe("getVersionInfo", () => {
  it("returns the unavailable sentinel outside a git working tree", () => {
    const info = getVersionInfo(tmpdir(), { fetch: false });
    expect(info.unavailable).toBe(true);
    expect(info.commit).toBe("—");
    expect(info.upToDate).toBe(true);
    expect(info.hasRemote).toBe(false);
    expect(info.defaultBranch).toBe("main");
  });

  it("returns a populated snapshot when invoked from inside a repo", () => {
    const root = findGitRoot(import.meta.dir);
    if (!root) {
      // Skipping the assertion is the right call — we only have a meaningful
      // expectation when running from a checkout.
      return;
    }
    const info = getVersionInfo(root, { fetch: false });
    expect(info.unavailable).toBe(false);
    expect(info.commit).toMatch(/^[0-9a-f]{4,}$/);
    expect(info.fullCommit).toMatch(/^[0-9a-f]{7,}$/);
    expect(info.commit.length).toBeLessThanOrEqual(7);
    expect(info.fullCommit.startsWith(info.commit)).toBe(true);
    expect(info.defaultBranch).toBe("main");
    expect(typeof info.fetchedAt).toBe("string");
  });

  it("reads a synthetic repo with a known commit", () => {
    // Build a tiny throwaway git repo and verify the snapshot matches the
    // commit we just created.
    const dir = join(tmpdir(), `pi-version-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      const run = (args: string[]) => {
        const { spawnSync } = require("node:child_process");
        const res = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
        if (res.status !== 0) {
          throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
        }
        return res.stdout.trim();
      };
      run(["init", "-q", "-b", "main"]);
      run(["config", "user.email", "test@example.com"]);
      run(["config", "user.name", "Test"]);
      run(["config", "commit.gpgsign", "false"]);
      // Need an initial commit on main so rev-parse HEAD works.
      run(["commit", "--allow-empty", "-q", "-m", "initial"]);
      const head = run(["rev-parse", "HEAD"]);
      const info = getVersionInfo(dir, { fetch: false });
      expect(info.unavailable).toBe(false);
      expect(info.fullCommit).toBe(head);
      expect(info.commit).toBe(head.slice(0, 7));
      expect(info.commitMessage).toBe("initial");
      expect(info.branch).toBe("main");
      expect(info.hasRemote).toBe(false);
      expect(info.upToDate).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
