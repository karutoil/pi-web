import { describe, it, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gitShowCommit } from "./pi-git";

/**
 * Regression tests for the git commit-diff endpoint (#161). The original
 * bug: `git show --stat -p -- <hash>` places the `--` *before* the hash,
 * which makes git treat the hash as a path filter and silently returns
 * empty stdout. The endpoint then served `{ diff: "" }` with HTTP 200,
 * so the client spinner dismissed and the user was left staring at the
 * commit list with no diff and no error.
 */

function makeRepo(): string {
  const dir = join(tmpdir(), `pi-git-show-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  const run = (args: string[]) => {
    const res = execFileSync("git", args, { cwd: dir, encoding: "utf-8" });
    return res.toString().trim();
  };
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  run(["config", "commit.gpgsign", "false"]);
  // Two commits so the second has a real diff
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: dir });
  writeFileSync(join(dir, "file.txt"), "hello\n");
  run(["add", "file.txt"]);
  run(["commit", "-q", "-m", "add file"]);
  return dir;
}

describe("gitShowCommit", () => {
  it("returns the full patch for a valid commit hash", () => {
    const dir = makeRepo();
    try {
      const head = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: dir,
        encoding: "utf-8",
      }).toString().trim();
      const result = gitShowCommit(dir, head);
      expect(result.ok).toBe(true);
      expect(result.stdout).toContain("add file");
      expect(result.stdout).toContain("file.txt");
      expect(result.stdout).toContain("+hello");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a real diff (not empty) — guards the `--` regression", () => {
    const dir = makeRepo();
    try {
      const head = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: dir,
        encoding: "utf-8",
      }).toString().trim();
      const result = gitShowCommit(dir, head);
      // The original bug returned `{ ok: true, stdout: "" }`. This
      // assertion would have caught it: the diff must contain at least
      // one `+` line and the file path.
      expect(result.stdout.length).toBeGreaterThan(0);
      expect(result.stdout).toMatch(/^\+hello/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects malformed hashes before invoking git", () => {
    const result = gitShowCommit(process.cwd(), "not-a-hash; rm -rf /");
    expect(result.ok).toBe(false);
    expect(result.stderr).toBe("Invalid commit hash");
  });

  it("accepts short hashes (4+ hex chars)", () => {
    const dir = makeRepo();
    try {
      const head = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: dir,
        encoding: "utf-8",
      }).toString().trim();
      const short = head.slice(0, 7);
      const result = gitShowCommit(dir, short);
      expect(result.ok).toBe(true);
      expect(result.stdout).toContain("add file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
