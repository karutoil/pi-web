import { execFileSync } from "child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { VersionInfo } from "@pi-web/shared";

/**
 * Walks up from `start` looking for a directory that contains a `.git` entry
 * (file or directory — worktrees use a `.git` file pointing at gitdir).
 *
 * The server runs from `packages/server` by default, so the project root is
 * two directories up. This stays robust if the server is launched from
 * elsewhere (Docker, monorepo tooling, etc).
 */
export function findGitRoot(start: string = process.cwd()): string | null {
  let dir = resolve(start);
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, ".git");
    if (existsSync(candidate)) {
      try {
        const st = statSync(candidate);
        if (st.isDirectory() || st.isFile()) return dir;
      } catch {
        // ignore
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

interface GitRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function runGit(cwd: string, ...args: string[]): GitRunResult {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      maxBuffer: 1 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    }).toString().replace(/\r/g, "").trimEnd();
    return { ok: true, stdout, stderr: "" };
  } catch (e: any) {
    return {
      ok: false,
      stdout: "",
      stderr: e?.stderr?.toString?.()?.trim() || e?.message || "git error",
    };
  }
}

const DEFAULT_BRANCH = "main";

/**
 * Build a VersionInfo snapshot for the running server. Cheap reads; only
 * the optional `git fetch` touches the network and is bounded by a timeout
 * so a hung remote cannot block the response.
 */
export function getVersionInfo(
  rootOverride?: string,
  options: { fetch?: boolean; fetchTimeoutMs?: number } = {},
): VersionInfo {
  const now = () => new Date().toISOString();
  const root = rootOverride ?? findGitRoot();

  const unavailable: VersionInfo = {
    commit: "—",
    fullCommit: "",
    branch: "",
    commitMessage: "",
    ahead: 0,
    behind: 0,
    dirty: false,
    upToDate: true,
    defaultBranch: DEFAULT_BRANCH,
    hasRemote: false,
    unavailable: true,
    fetchedAt: now(),
  };

  if (!root) return unavailable;

  // HEAD identity
  const headFull = runGit(root, "rev-parse", "HEAD").stdout;
  if (!headFull) return unavailable;
  const fullCommit = headFull.split("\n")[0];
  const commit = fullCommit.slice(0, 7);

  // Branch — fall back to "HEAD" when detached
  let branch = runGit(root, "rev-parse", "--abbrev-ref", "HEAD").stdout;
  if (!branch || branch === "HEAD") branch = "HEAD";

  // Commit message subject
  const commitMessage = runGit(root, "log", "-1", "--pretty=%s").stdout || "";

  // Optionally refresh remote refs. We do this once per call but bound the
  // network attempt so a slow origin doesn't stall the UI. Failures are
  // swallowed — we just compare against whatever refs are already cached.
  if (options.fetch !== false) {
    const timeout = options.fetchTimeoutMs ?? 1500;
    try {
      execFileSync("git", ["fetch", "origin", DEFAULT_BRANCH, "--quiet"], {
        cwd: root,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout,
      });
    } catch {
      // network may be down, offline mode, or no remote configured — ignore
    }
  }

  // Compare against origin/<defaultBranch> when it exists
  const remoteRef = `origin/${DEFAULT_BRANCH}`;
  const hasRemote = runGit(root, "rev-parse", "--verify", "--quiet", remoteRef).ok;
  let ahead = 0;
  let behind = 0;
  if (hasRemote) {
    const ab = runGit(
      root,
      "rev-list",
      "--left-right",
      "--count",
      `${remoteRef}...HEAD`,
    ).stdout;
    if (ab) {
      const [b, a] = ab.split("\t").map((n) => Number(n) || 0);
      behind = b;
      ahead = a;
    }
  }

  // Dirty = uncommitted changes in the work tree (ignored files don't count)
  const porcelain = runGit(root, "status", "--porcelain").stdout;
  const dirty = porcelain.length > 0;

  // upToDate is only meaningful when we have a remote to compare against;
  // otherwise we still report the local working-tree state.
  const upToDate =
    hasRemote && !dirty && ahead === 0 && behind === 0;

  return {
    commit,
    fullCommit,
    branch,
    commitMessage,
    ahead,
    behind,
    dirty,
    upToDate,
    defaultBranch: DEFAULT_BRANCH,
    hasRemote,
    unavailable: false,
    fetchedAt: now(),
  };
}
