import { execFileSync } from "child_process";
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

export interface GitStashEntry {
  index: number;
  message: string;
  branch: string;
}

export interface GitStashFileChange {
  status: string;
  path: string;
  oldPath?: string;
}

export interface GitStashShowResult {
  files: GitStashFileChange[];
  diff: string;
  error?: string;
}

export interface GitDiffStats {
  additions: number;
  deletions: number;
}

export interface GitRemote {
  name: string;
  url: string;
  type: "fetch" | "push";
}

// ─── Structured git result (#38) ───
export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr?: string;
}

function runGit(cwd: string, ...args: string[]): GitResult {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      maxBuffer: 5 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return { ok: true, stdout };
  } catch (e: any) {
    return { ok: false, stdout: "", stderr: e.stderr?.toString()?.trim() || e.message };
  }
}

/** Convenience: return just the stdout string (empty on failure) */
function runGitStr(cwd: string, ...args: string[]): string {
  return runGit(cwd, ...args).stdout;
}

export function getGitStatus(cwd: string): GitStatus | null {
  // Check if it's a git repo
  if (!runGitStr(cwd, "rev-parse", "--is-inside-work-tree")) return null;

  const branch = runGitStr(cwd, "rev-parse", "--abbrev-ref", "HEAD") || "HEAD";
  const tracking = runGitStr(cwd, "rev-parse", "--abbrev-ref", "@{upstream}") || "";
  
  let ahead = 0, behind = 0;
  if (tracking) {
    const abRaw = runGitStr(cwd, "rev-list", "--left-right", "--count", `${tracking}...HEAD`);
    if (abRaw) {
      const [b, a] = abRaw.split("\t").map(Number);
      behind = b || 0;
      ahead = a || 0;
    }
  }

  // Porcelain status
  const raw = runGitStr(cwd, "status", "--porcelain=v2", "--branch", "--renames");
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
  const stashList = runGitStr(cwd, "stash", "list");
  const stashCount = stashList ? stashList.split("\n").length : 0;

  // HEAD commit
  const headCommit = runGitStr(cwd, "rev-parse", "--short", "HEAD") || null;
  const headMessage = headCommit ? runGitStr(cwd, "log", "-1", "--format=%s") : null;

  return { branch, ahead, behind, staged, unstaged, untracked, stashCount, headCommit, headMessage };
}

export function getGitDiff(cwd: string, path: string, staged: boolean): string {
  if (staged) {
    return runGitStr(cwd, "diff", "--cached", "--", path);
  }
  return runGitStr(cwd, "diff", "--", path);
}

/** Get combined diff for all staged changes, or all changes if nothing staged */
export function getGitDiffForCommit(cwd: string): string {
  const stagedDiff = runGitStr(cwd, "diff", "--cached");
  if (stagedDiff) return stagedDiff;
  // Nothing staged — fall back to all tracked changes
  return runGitStr(cwd, "diff");
}

export function gitStage(cwd: string, path: string): GitResult {
  return runGit(cwd, "add", "--", path);
}

// ── Stage all ──
export function gitStageAll(cwd: string): GitResult {
  return runGit(cwd, "add", "-A");
}

export function gitUnstage(cwd: string, path: string): GitResult {
  return runGit(cwd, "reset", "HEAD", "--", path);
}

export function gitCommit(cwd: string, message: string): GitResult {
  return runGit(cwd, "commit", "-m", message);
}

export function gitLog(cwd: string, count: number = 50): GitLogEntry[] {
  const raw = runGitStr(cwd, "log", `--max-count=${count}`, "--format=%H|%h|%an|%aI|%s%d");
  if (!raw) return [];
  return raw.split("\n").map(line => {
    const [hash, shortHash, author, date, ...msgParts] = line.split("|");
    return { hash, shortHash, author, date, message: msgParts.join("|") };
  });
}

// #38/#40: checkout now uses -- separator before user-controlled branch
export function gitCheckout(cwd: string, branch: string): GitResult {
  return runGit(cwd, "checkout", "--", branch);
}

export function gitDiscard(cwd: string, path: string): string {
  // Discard working tree changes
  return runGitStr(cwd, "checkout", "--", path);
}

export function gitBranches(cwd: string): string[] {
  const raw = runGitStr(cwd, "branch", "--format=%(refname:short)");
  return raw ? raw.split("\n") : [];
}

// ── Push / Pull / Sync ──

export function gitPush(cwd: string): GitResult {
  return runGit(cwd, "push");
}

export function gitPull(cwd: string): GitResult {
  return runGit(cwd, "pull");
}

export function gitFetch(cwd: string): GitResult {
  return runGit(cwd, "fetch");
}

// ── Branch operations ──

// #38: branch creation + checkout use -- separator
export function gitCreateBranch(cwd: string, name: string, checkout: boolean = true): GitResult {
  const result = runGit(cwd, "branch", "--", name);
  if (checkout && result.ok) return runGit(cwd, "checkout", "--", name);
  return result;
}

// #38: deleteBranch uses -- separator
export function gitDeleteBranch(cwd: string, name: string): GitResult {
  return runGit(cwd, "branch", "-d", "--", name);
}

export function gitRenameBranch(cwd: string, oldName: string, newName: string): GitResult {
  return runGit(cwd, "branch", "-m", "--", oldName, newName);
}

// ── Tag operations ──

export function gitTags(cwd: string): string[] {
  const raw = runGitStr(cwd, "tag", "--sort=-creatordate");
  return raw ? raw.split("\n") : [];
}

export function gitCreateTag(cwd: string, name: string, message?: string): GitResult {
  if (message) return runGit(cwd, "tag", "-a", "--", name, "-m", message);
  return runGit(cwd, "tag", "--", name);
}

export function gitDeleteTag(cwd: string, name: string): GitResult {
  return runGit(cwd, "tag", "-d", "--", name);
}

// ── Stash operations ──

export function gitStashList(cwd: string): GitStashEntry[] {
  const raw = runGitStr(cwd, "stash", "list");
  if (!raw) return [];
  return raw.split("\n").map((line, idx) => {
    // Format: stash@{0}: On branch: message
    const match = line.match(/^stash@\{(\d+)\}: (?:WIP on |On )(?:([^:]+): )?(.+)$/);
    return {
      index: parseInt(match?.[1] || "0"),
      branch: match?.[2] || "",
      message: match?.[3] || line,
    };
  });
}

function parseStashNameStatus(raw: string): GitStashFileChange[] {
  return raw
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [status, ...parts] = line.split("\t");
      if (parts.length === 0) return { status, path: line };
      if (parts.length === 1) return { status, path: parts[0] };
      return { status, oldPath: parts[0], path: parts[1] };
    });
}

export function gitStashShow(cwd: string, index: number): GitStashShowResult {
  const ref = `stash@{${index}}`;
  const filesResult = runGit(cwd, "stash", "show", "--name-status", ref);
  const diffResult = runGit(cwd, "stash", "show", "--patch", ref);
  if (!filesResult.ok) {
    return {
      files: [],
      diff: "",
      error: filesResult.stderr || `Failed to read stash@{${index}}`,
    };
  }
  return {
    files: parseStashNameStatus(filesResult.stdout),
    diff: diffResult.ok ? diffResult.stdout : "",
  };
}

export function gitStashPush(cwd: string, message?: string): GitResult {
  if (message) return runGit(cwd, "stash", "push", "-m", message);
  return runGit(cwd, "stash", "push");
}

export function gitStashPop(cwd: string, index?: number): GitResult {
  if (index !== undefined) return runGit(cwd, "stash", "pop", `stash@{${index}}`);
  return runGit(cwd, "stash", "pop");
}

export function gitStashApply(cwd: string, index?: number): GitResult {
  if (index !== undefined) return runGit(cwd, "stash", "apply", `stash@{${index}}`);
  return runGit(cwd, "stash", "apply");
}

export function gitStashDrop(cwd: string, index: number): GitResult {
  return runGit(cwd, "stash", "drop", `stash@{${index}}`);
}

// ── Amend commit ──

export function gitAmend(cwd: string, message?: string): GitResult {
  if (message) return runGit(cwd, "commit", "--amend", "-m", message);
  return runGit(cwd, "commit", "--amend", "--no-edit");
}

// ── Cherry-pick / Revert ──

// #38: cherry-pick and revert use -- separator before hash
export function gitCherryPick(cwd: string, hash: string): GitResult {
  return runGit(cwd, "cherry-pick", "--", hash);
}

export function gitRevert(cwd: string, hash: string, noCommit: boolean = false): GitResult {
  const args = ["revert"];
  if (noCommit) args.push("--no-commit");
  args.push("--", hash);
  return runGit(cwd, ...args);
}

// ── Merge conflict resolution ──

export function gitResolveConflict(cwd: string, path: string, strategy: "ours" | "theirs" | "both" | "none"): GitResult {
  if (strategy === "ours") {
    runGit(cwd, "checkout", "--ours", "--", path);
    return runGit(cwd, "add", "--", path);
  } else if (strategy === "theirs") {
    runGit(cwd, "checkout", "--theirs", "--", path);
    return runGit(cwd, "add", "--", path);
  } else if (strategy === "both") {
    // Accept both changes — just mark as resolved
    return runGit(cwd, "add", "--", path);
  } else {
    // "none" — mark as unresolved (remove from index)
    return runGit(cwd, "reset", "--", path);
  }
}

// ── Diff stats ──

export function getGitDiffStats(cwd: string, path: string, staged: boolean): GitDiffStats {
  const raw = staged
    ? runGitStr(cwd, "diff", "--cached", "--numstat", "--", path)
    : runGitStr(cwd, "diff", "--numstat", "--", path);
  
  if (!raw) return { additions: 0, deletions: 0 };
  const [add, del] = raw.split("\t").map(Number);
  return { additions: add || 0, deletions: del || 0 };
}

// ── Compare with previous commit ──

export function gitDiffWithRef(cwd: string, path: string, ref: string): string {
  return runGitStr(cwd, "diff", ref, "--", path);
}

// ── Commit diff (show full commit) ──
//
// NOTE: the `--` rev/path separator must come *after* the object, not
// before it. Placing it before the hash tells git to treat the hash as a
// path filter, which silently produces empty output and breaks the
// "click a commit, see the diff" flow in the UI (#161). The hash is also
// validated up-front so a malformed value fails fast with a clear error
// instead of an empty diff.
function isSafeHash(hash: string): boolean {
  return /^[0-9a-f]{4,64}$/i.test(hash);
}

export function gitShowCommit(cwd: string, hash: string): GitResult {
  if (!isSafeHash(hash)) {
    return { ok: false, stdout: "", stderr: "Invalid commit hash" };
  }
  return runGit(cwd, "show", "--stat", "-p", hash);
}

// ── Commit search ──

export function gitLogSearch(cwd: string, query: string, count: number = 50): GitLogEntry[] {
  const raw = runGitStr(cwd, "log", `--max-count=${count}`, `--grep=${query}`, "--format=%H|%h|%an|%aI|%s%d");
  if (!raw) return [];
  return raw.split("\n").map(line => {
    const [hash, shortHash, author, date, ...msgParts] = line.split("|");
    return { hash, shortHash, author, date, message: msgParts.join("|") };
  });
}

// ── Blame ──

export interface GitBlameLine {
  hash: string;
  author: string;
  date: string;
  line: number;
  content: string;
}

export function gitBlame(cwd: string, path: string): GitBlameLine[] {
  const raw = runGitStr(cwd, "blame", "--porcelain", "--", path);
  if (!raw) return [];
  
  const lines: GitBlameLine[] = [];
  const commits = new Map<string, { author: string; date: string }>();
  let currentHash = "";
  let lineNum = 0;
  
  for (const line of raw.split("\n")) {
    if (line.startsWith("author ")) {
      const author = line.substring(7);
      if (currentHash) { const c = commits.get(currentHash); if (c) c.author = author; }
    } else if (line.startsWith("author-time ")) {
      const time = parseInt(line.substring(12));
      if (currentHash) { const c = commits.get(currentHash); if (c) c.date = new Date(time * 1000).toISOString(); }
    } else if (/^[0-9a-f]{40}/.test(line)) {
      const parts = line.split(" ");
      currentHash = parts[0];
      lineNum = parseInt(parts[2]);
      if (!commits.has(currentHash)) commits.set(currentHash, { author: "", date: "" });
    } else if (line.startsWith("\t")) {
      const commit = commits.get(currentHash);
      if (commit && lineNum > 0) {
        lines.push({
          hash: currentHash.substring(0, 7),
          author: commit.author,
          date: commit.date,
          line: lineNum,
          content: line.substring(1),
        });
      }
    }
  }
  return lines;
}

// ── Remotes ──

export function gitRemotes(cwd: string): GitRemote[] {
  const raw = runGitStr(cwd, "remote", "-v");
  if (!raw) return [];
  const remotes: GitRemote[] = [];
  for (const line of raw.split("\n")) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)/);
    if (match) remotes.push({ name: match[1], url: match[2], type: match[3] as "fetch" | "push" });
  }
  return remotes;
}

// ── Unstage all ──

export function gitUnstageAll(cwd: string): GitResult {
  return runGit(cwd, "reset", "HEAD");
}
