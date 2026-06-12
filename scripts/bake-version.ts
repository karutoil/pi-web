#!/usr/bin/env bun
/**
 * Bakes git version metadata into `.pi-web-version.json` during builds.
 * Used by Docker so the running image can report its commit/sync state
 * without copying the entire `.git` directory into the final layer.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_BRANCH = "main";
const root = dirname(fileURLToPath(import.meta.url));

interface GitRunResult {
  ok: boolean;
  stdout: string;
}

function runGit(...args: string[]): GitRunResult {
  try {
    const stdout = execFileSync("git", args, {
      cwd: root,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    })
      .toString()
      .replace(/\r/g, "")
      .trimEnd();
    return { ok: true, stdout };
  } catch (e: any) {
    return {
      ok: false,
      stdout: "",
    };
  }
}

function runGitTrimmed(...args: string[]): string {
  return runGit(...args).stdout;
}

const fullCommit = runGitTrimmed("rev-parse", "HEAD");
const commit = fullCommit.slice(0, 7);
const branch = fullCommit
  ? runGitTrimmed("rev-parse", "--abbrev-ref", "HEAD") || "HEAD"
  : "";
const commitMessage = fullCommit
  ? runGitTrimmed("log", "-1", "--pretty=%s")
  : "";

const dirty = runGitTrimmed("status", "--porcelain").length > 0;

const remoteRef = `origin/${DEFAULT_BRANCH}`;
const hasRemote = runGit(
  "rev-parse",
  "--verify",
  "--quiet",
  remoteRef,
).ok;
let ahead = 0;
let behind = 0;
if (hasRemote) {
  const ab = runGitTrimmed(
    "rev-list",
    "--left-right",
    "--count",
    `${remoteRef}...HEAD`,
  );
  if (ab) {
    const [b, a] = ab.split("\t").map((n) => Number(n) || 0);
    behind = b;
    ahead = a;
  }
}

let remoteUrl = "";
try {
  remoteUrl = execFileSync("git", ["remote", "get-url", "origin"], {
    cwd: root,
    encoding: "utf-8",
    timeout: 5000,
  })
    .toString()
    .trim();
} catch {
  // no remote configured
}

const upToDate = hasRemote && !dirty && ahead === 0 && behind === 0;

const data = {
  commit: commit || "—",
  fullCommit,
  branch,
  commitMessage,
  ahead,
  behind,
  dirty,
  upToDate,
  defaultBranch: DEFAULT_BRANCH,
  hasRemote,
  unavailable: !fullCommit,
  remoteUrl,
  fetchedAt: new Date().toISOString(),
};

writeFileSync(
  join(root, "..", ".pi-web-version.json"),
  JSON.stringify(data, null, 2),
);

console.log(`Baked version: ${data.commit} (${branch})`);
