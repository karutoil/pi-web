import { execSync } from "child_process";
import { join } from "node:path";

// ─── Git API ───
// All operations are synchronous for simplicity — git CLI is fast for repo queries.

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  staged: GitFile[];
  unstaged: GitFile[];
  untracked: string[];
  stashCount: number;
  headCommit: string | null;
  headMessage: string | null;
}

export interface GitFile {
  path: string;
  status: string; // M, A, D, R, C, ??
  oldPath?: string; // for renames
}

export interface GitDiff {
  path: string;
  staged: string;  // diff text
  unstaged: string; // diff text
}

export interface GitLogEntry {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  message: string;
  refs?: string;
}

function runGit(cwd: string, ...args: string[]): string {
  try {
    return execSync(`git ${args.join(" ")}`, { cwd, encoding: "utf-8", maxBuffer: 5 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (e: any) {
    return "";
  }
}

export function getGitStatus(cwd: string): GitStatus | null {
  // Check if it's a git repo
  if (!runGit(cwd, "rev-parse", "--is-inside-work-tree")) return null;

  const branch = runGit(cwd, "rev-parse", "--abbrev-ref", "HEAD") || "HEAD";
  const tracking = runGit(cwd, "rev-parse", "--abbrev-ref", "@{upstream}") || "";
  
  let ahead = 0, behind = 0;
  if (tracking) {
    const abRaw = runGit(cwd, "rev-list", "--left-right", "--count", `${tracking}...HEAD`);
    if (abRaw) {
      const [b, a] = abRaw.split("\t").map(Number);
      behind = b || 0;
      ahead = a || 0;
    }
  }

  // Porcelain status
  const raw = runGit(cwd, "status", "--porcelain=v2", "--branch", "--renames");
  const staged: GitFile[] = [];
  const unstaged: GitFile[] = [];
  const untracked: string[] = [];

  if (raw) {
    for (const line of raw.split("\n")) {
      if (line.startsWith("# branch.")) continue;
      if (line.startsWith("1 ")) {
        // Ordinary changed entry: 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
        const parts = line.split(" ");
        const xy = parts[1];
        const path = parts.slice(8).join(" ");
        const indexStatus = xy[0];
        const workTreeStatus = xy[1];

        if (indexStatus !== "." && indexStatus !== "?") {
          staged.push({ path, status: indexStatus });
        }
        if (workTreeStatus !== "." && workTreeStatus !== "?") {
          unstaged.push({ path, status: workTreeStatus });
        }
      } else if (line.startsWith("2 ")) {
        // Rename/copy: 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><path> <sep><origPath>
        const parts = line.split(" ");
        const xy = parts[1];
        const paths = parts.slice(8).join(" ");
        const sepIdx = paths.indexOf("\t");
        const newPath = paths.substring(0, sepIdx);
        const oldPath = paths.substring(sepIdx + 1);

        if (xy[0] !== ".") staged.push({ path: newPath, status: xy[0], oldPath });
        if (xy[1] !== ".") unstaged.push({ path: newPath, status: xy[1], oldPath });
      } else if (line.startsWith("u ")) {
        // Unmerged — treat as both staged and unstaged
        const parts = line.split(" ");
        const path = parts.slice(8).join(" ");
        staged.push({ path, status: "U" });
        unstaged.push({ path, status: "U" });
      } else if (line.startsWith("? ")) {
        untracked.push(line.substring(2));
      }
    }
  }

  // Stash count
  const stashList = runGit(cwd, "stash", "list");
  const stashCount = stashList ? stashList.split("\n").length : 0;

  // HEAD commit
  const headCommit = runGit(cwd, "rev-parse", "--short", "HEAD") || null;
  const headMessage = headCommit ? runGit(cwd, "log", "-1", "--format=%s") : null;

  return { branch, ahead, behind, staged, unstaged, untracked, stashCount, headCommit, headMessage };
}

export function getGitDiff(cwd: string, path: string, staged: boolean): string {
  if (staged) {
    return runGit(cwd, "diff", "--cached", "--", path);
  }
  return runGit(cwd, "diff", "--", path);
}

export function gitStage(cwd: string, path: string): boolean {
  return !!runGit(cwd, "add", "--", path);
}

export function gitUnstage(cwd: string, path: string): boolean {
  return !!runGit(cwd, "reset", "HEAD", "--", path);
}

export function gitCommit(cwd: string, message: string): string | null {
  const result = runGit(cwd, "commit", "-m", JSON.stringify(message));
  return result || null;
}

export function gitLog(cwd: string, count: number = 50): GitLogEntry[] {
  const raw = runGit(cwd, "log", `--max-count=${count}`, "--format=%H|%h|%an|%aI|%s%d");
  if (!raw) return [];
  return raw.split("\n").map(line => {
    const [hash, shortHash, author, date, ...msgParts] = line.split("|");
    return { hash, shortHash, author, date, message: msgParts.join("|") };
  });
}

export function gitCheckout(cwd: string, branch: string): string {
  return runGit(cwd, "checkout", branch);
}

export function gitDiscard(cwd: string, path: string): string {
  // Discard working tree changes
  return runGit(cwd, "checkout", "--", path);
}

export function gitBranches(cwd: string): string[] {
  const raw = runGit(cwd, "branch", "--format=%(refname:short)");
  return raw ? raw.split("\n") : [];
}
