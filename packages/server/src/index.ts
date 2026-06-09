import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { createBunWebSocket } from "hono/bun";
import type { ServerWebSocket } from "bun";
import { join, basename, resolve, normalize } from "node:path";
import { existsSync, statSync, readdirSync, realpathSync } from "node:fs";
import { readFile, writeFile, unlink, rename as renameFs } from "node:fs/promises";
import { homedir } from "node:os";

import { addProject, removeProject, listProjects, getProject, touchProject } from "./db";
import { listProjectSessions, getSessionDetail } from "./pi-sessions";
import { getOrCreateAgent, stopAllAgents, getPoolStats, lookupAgent, detachFromAgent, deleteFromPool, rekeyAgent } from "./pi-agent";
import { createTerminal, getTerminal, listTerminals, killTerminal } from "./pi-terminal";
import { getGitStatus, getGitDiff, gitStage, gitUnstage, gitCommit, gitLog, gitCheckout, gitDiscard, gitBranches, gitPush, gitPull, gitFetch, gitCreateBranch, gitDeleteBranch, gitRenameBranch, gitTags, gitCreateTag, gitDeleteTag, gitStashList, gitStashPush, gitStashPop, gitStashApply, gitStashDrop, gitAmend, gitCherryPick, gitRevert, gitResolveConflict, getGitDiffStats, gitDiffWithRef, gitShowCommit, gitLogSearch, gitBlame, gitRemotes, gitUnstageAll } from "./pi-git";
import type { GitResult } from "./pi-git";
import { getVersionInfo } from "./pi-version";
import { startPreview, stopPreview, getPreview, listPreviews, addLogListener, stopAllPreviews, setPreviewPort, setPreviewRemoteUrl } from "./pi-preview";
import { handlePreviewRequest, parsePreviewPath } from "./pi-preview-proxy";
import { getOverlayJS, getOverlayCSS } from "./pi-preview-overlay";
import type { WSClientMessage, WSServerMessage } from "@pi-web/shared";

const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>();

const app = new Hono();

// ==================== Path Validation (#2) ====================

const HOME = homedir();

/** Known session roots for path validation */
function getSessionRoots(projectPath?: string): string[] {
  const roots = [join(HOME, ".pi", "agent", "sessions")];
  if (projectPath) {
    roots.push(join(projectPath, ".pi", "sessions"));
  }
  return roots;
}

/**
 * Validates that a user-provided path resolves to a location inside one of
 * the allowed session roots. Returns the resolved safe path or throws.
 * Prevents path traversal and symlink attacks (#2, #14).
 */
function validateSessionPath(userPath: string, projectPath?: string): string {
  const resolved = resolve(normalize(userPath));
  const roots = getSessionRoots(projectPath);

  // Follow symlinks via realpathSync (#14)
  let realPath: string;
  try {
    realPath = realpathSync(resolved);
  } catch {
    throw new Error("Path does not exist");
  }

  // Verify the real path is inside at least one allowed root
  const insideRoot = roots.some(root => {
    const realRoot = realpathSync(root);
    return realPath.startsWith(realRoot + "/") || realPath === realRoot;
  });

  if (!insideRoot) {
    throw new Error("Path is outside allowed session directory");
  }

  // Verify it's a regular file (not a directory or symlink to directory) (#14)
  const stat = statSync(realPath);
  if (stat.isDirectory()) {
    throw new Error("Path is a directory, not a file");
  }

  return realPath;
}

/** Validate a browse path is within home directory (#42) */
function validateBrowsePath(dir: string): string {
  const resolved = resolve(normalize(dir));
  const realHome = realpathSync(HOME);
  let realDir: string;
  try {
    realDir = realpathSync(resolved);
  } catch {
    // Path doesn't exist yet — still check the resolved path
    realDir = resolved;
  }
  if (!realDir.startsWith(realHome + "/") && realDir !== realHome) {
    throw new Error("Directory is outside allowed browse scope");
  }
  return resolved;
}

/** HTML-escape a string for safe interpolation (#84) */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Helper to format GitResult for REST responses (#38) */
function gitResponse(result: GitResult) {
  if (!result.ok) {
    return { success: false as const, error: result.stderr || "Git operation failed", stdout: result.stdout };
  }
  return { success: true as const, result: result.stdout };
}

// ==================== REST API ====================

// List projects
app.get("/api/projects", async (c) => {
  const projects = listProjects();
  return c.json({ projects });
});

// Add project (#43: check isDirectory)
app.post("/api/projects", async (c) => {
  const body = await c.req.json();
  const { path, name } = body;
  
  if (!path || typeof path !== "string") {
    return c.json({ error: "Path is required" }, 400);
  }
  
  // Verify path exists and is a directory
  if (!existsSync(path)) {
    return c.json({ error: "Directory does not exist" }, 400);
  }
  if (!statSync(path).isDirectory()) {
    return c.json({ error: "Path is not a directory" }, 400);
  }
  
  const dirName = name || basename(path);
  try {
    const project = addProject(dirName, path);
    return c.json({ project }, 201);
  } catch (e: any) {
    if (e.message?.includes("UNIQUE")) {
      return c.json({ error: "Project already added" }, 409);
    }
    throw e;
  }
});

// Remove project (#90: cascade cleanup — stop agents/terminals)
app.delete("/api/projects/:id", (c) => {
  const { id } = c.req.param();
  const project = getProject(id);
  if (project) {
    // Stop any agents for this project
    deleteFromPool(project.path);
    // Kill terminals for this project
    const terms = listTerminals(id);
    for (const t of terms) killTerminal(t.id);
  }
  const ok = removeProject(id);
  return c.json({ success: ok }, ok ? 200 : 404);
});

// List sessions for a project
app.get("/api/projects/:id/sessions", async (c) => {
  const { id } = c.req.param();
  const project = getProject(id);
  if (!project) return c.json({ error: "Project not found" }, 404);
  
  const sessions = await listProjectSessions(project.path);
  return c.json({ sessions, total: sessions.length });
});

// Get session detail (#2: validate path)
app.get("/api/sessions/detail", async (c) => {
  const filePath = c.req.query("path");
  if (!filePath) return c.json({ error: "path query required" }, 400);
  
  try {
    const safePath = validateSessionPath(filePath);
    const detail = await getSessionDetail(safePath);
    if (!detail) return c.json({ error: "Session not found" }, 404);
    return c.json({ session: detail });
  } catch (e: any) {
    return c.json({ error: e.message }, 403);
  }
});

// Delete session file (#2: validate path)
app.delete("/api/sessions/:path", async (c) => {
  const sessionPath = decodeURIComponent(c.req.param("path"));
  try {
    const safePath = validateSessionPath(sessionPath);
    await unlink(safePath);
    return c.json({ success: true });
  } catch (e: any) {
    if (e.code === "ENOENT") return c.json({ error: "Session not found" }, 404);
    return c.json({ error: e.message }, 403);
  }
});

// Rename session (#2: validate path)
app.patch("/api/sessions/rename", async (c) => {
  const { sessionPath, name } = await c.req.json();
  if (!sessionPath || !name) return c.json({ error: "sessionPath and name required" }, 400);
  
  try {
    const safePath = validateSessionPath(sessionPath);
    const content = await readFile(safePath, "utf-8");
    // Append a session_info entry with the name
    const renameEntry = JSON.stringify({ type: "session_info", name, timestamp: new Date().toISOString() });
    const newContent = content.trim() + "\n" + renameEntry + "\n";
    await writeFile(safePath, newContent);
    return c.json({ success: true, name });
  } catch (e: any) {
    return c.json({ error: e.message }, 403);
  }
});

// Browse filesystem directories (#42: validate against home dir)
app.get("/api/fs/browse", async (c) => {
  let dir = c.req.query("dir") || homedir();
  // Expand ~ to home directory
  if (dir.startsWith("~")) dir = homedir() + dir.slice(1);

  try {
    dir = validateBrowsePath(dir);
  } catch (e: any) {
    return c.json({ error: e.message }, 403);
  }

  try {
    if (!existsSync(dir)) return c.json({ error: "Directory does not exist" }, 400);
    const stat = statSync(dir);
    if (!stat.isDirectory()) return c.json({ error: "Not a directory" }, 400);

    const entries = readdirSync(dir, { withFileTypes: true })
      .filter(e => !e.name.startsWith(".") && e.isDirectory())
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

    const items = entries.map(e => ({
      name: e.name,
      path: join(dir, e.name),
      isDirectory: true,
    }));

    return c.json({
      currentPath: dir,
      parentPath: dir === "/" ? null : join(dir, ".."),
      items,
    });
  } catch (e: any) {
    // If we can't read the dir (permissions), return empty with error
    return c.json({
      currentPath: dir,
      parentPath: dir === "/" ? null : join(dir, ".."),
      items: [],
      error: e.code === "EACCES" ? "Permission denied" : e.message,
    });
  }
});

// List terminals for a project
app.get("/api/terminals", (c) => {
  const projectId = c.req.query("projectId");
  if (!projectId) return c.json({ error: "projectId required" }, 400);
  return c.json({ terminals: listTerminals(projectId) });
});

// Create a new terminal
app.post("/api/terminals", async (c) => {
  const { id, projectId, cwd, name } = await c.req.json() as any;
  if (!id || !projectId || !cwd) return c.json({ error: "id, projectId, and cwd required" }, 400);
  const info = createTerminal(id, projectId, cwd, name || "Terminal");
  return c.json({ terminal: info }, 201);
});

// Kill a terminal
app.delete("/api/terminals/:id", (c) => {
  const { id } = c.req.param();
  const ok = killTerminal(id);
  return c.json({ success: ok }, ok ? 200 : 404);
});

// ── Version / update checker (#160) ──
// Cheap endpoint — reads git state for the running server's repo, with a
// short network fetch attempt to refresh origin/main. Designed to be polled
// by the sidebar widget every few minutes.
app.get("/api/version", (c) => {
  // `?noFetch=1` skips the network round-trip (useful in tests / offline)
  const noFetch = c.req.query("noFetch") === "1";
  const info = getVersionInfo(undefined, { fetch: !noFetch });
  return c.json(info);
});

// ── Git API (#38: handle GitResult structured responses) ──
app.get("/api/git/status", (c) => {
  const cwd = c.req.query("cwd");
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  const status = getGitStatus(cwd);
  if (!status) return c.json({ error: "Not a git repository" }, 404);
  return c.json(status);
});

app.get("/api/git/diff", (c) => {
  const cwd = c.req.query("cwd");
  const path = c.req.query("path");
  const staged = c.req.query("staged") === "true";
  if (!cwd || !path) return c.json({ error: "cwd and path required" }, 400);
  return c.json({ diff: getGitDiff(cwd, path, staged) });
});

app.post("/api/git/stage", async (c) => {
  const { cwd, path } = await c.req.json();
  if (!cwd || !path) return c.json({ error: "cwd and path required" }, 400);
  const result = gitStage(cwd, path);
  if (!result.ok) return c.json({ success: false, error: result.stderr || "Stage failed" }, 500);
  return c.json({ success: true });
});

app.post("/api/git/unstage", async (c) => {
  const { cwd, path } = await c.req.json();
  if (!cwd || !path) return c.json({ error: "cwd and path required" }, 400);
  const result = gitUnstage(cwd, path);
  if (!result.ok) return c.json({ success: false, error: result.stderr || "Unstage failed" }, 500);
  return c.json({ success: true });
});

app.post("/api/git/commit", async (c) => {
  const { cwd, message } = await c.req.json();
  if (!cwd || !message) return c.json({ error: "cwd and message required" }, 400);
  const result = gitCommit(cwd, message);
  if (!result.ok) return c.json({ error: result.stderr || "Commit failed" }, 500);
  return c.json({ success: true, result: result.stdout });
});

app.get("/api/git/log", (c) => {
  const cwd = c.req.query("cwd");
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  const count = parseInt(c.req.query("count") || "50");
  return c.json({ log: gitLog(cwd, count) });
});

app.post("/api/git/checkout", async (c) => {
  const { cwd, branch } = await c.req.json();
  if (!cwd || !branch) return c.json({ error: "cwd and branch required" }, 400);
  const result = gitCheckout(cwd, branch);
  if (!result.ok) return c.json({ success: false, error: result.stderr || "Checkout failed" }, 500);
  return c.json({ success: true, result: result.stdout });
});

app.post("/api/git/discard", async (c) => {
  const { cwd, path } = await c.req.json();
  if (!cwd || !path) return c.json({ error: "cwd and path required" }, 400);
  const result = gitDiscard(cwd, path);
  return c.json({ success: true, result });
});

app.get("/api/git/branches", (c) => {
  const cwd = c.req.query("cwd");
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  return c.json({ branches: gitBranches(cwd) });
});

// Push / Pull / Fetch
app.post("/api/git/push", async (c) => {
  const { cwd } = await c.req.json();
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  const result = gitPush(cwd);
  if (!result.ok) return c.json({ success: false, error: result.stderr || "Push failed" }, 500);
  return c.json({ success: true, result: result.stdout });
});

app.post("/api/git/pull", async (c) => {
  const { cwd } = await c.req.json();
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  const result = gitPull(cwd);
  if (!result.ok) return c.json({ success: false, error: result.stderr || "Pull failed" }, 500);
  return c.json({ success: true, result: result.stdout });
});

app.post("/api/git/fetch", async (c) => {
  const { cwd } = await c.req.json();
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  const result = gitFetch(cwd);
  if (!result.ok) return c.json({ success: false, error: result.stderr || "Fetch failed" }, 500);
  return c.json({ success: true, result: result.stdout });
});

// Create / Delete / Rename branch
app.post("/api/git/branch/create", async (c) => {
  const { cwd, name, checkout } = await c.req.json();
  if (!cwd || !name) return c.json({ error: "cwd and name required" }, 400);
  const result = gitCreateBranch(cwd, name, checkout !== false);
  if (!result.ok) return c.json({ success: false, error: result.stderr || "Branch creation failed" }, 500);
  return c.json({ success: true, result: result.stdout });
});

app.post("/api/git/branch/delete", async (c) => {
  const { cwd, name } = await c.req.json();
  if (!cwd || !name) return c.json({ error: "cwd and name required" }, 400);
  const result = gitDeleteBranch(cwd, name);
  if (!result.ok) return c.json({ success: false, error: result.stderr || "Branch deletion failed" }, 500);
  return c.json({ success: true, result: result.stdout });
});

app.post("/api/git/branch/rename", async (c) => {
  const { cwd, oldName, newName } = await c.req.json();
  if (!cwd || !oldName || !newName) return c.json({ error: "cwd, oldName, and newName required" }, 400);
  const result = gitRenameBranch(cwd, oldName, newName);
  if (!result.ok) return c.json({ success: false, error: result.stderr || "Branch rename failed" }, 500);
  return c.json({ success: true, result: result.stdout });
});

// Tags
app.get("/api/git/tags", (c) => {
  const cwd = c.req.query("cwd");
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  return c.json({ tags: gitTags(cwd) });
});

app.post("/api/git/tag/create", async (c) => {
  const { cwd, name, message } = await c.req.json();
  if (!cwd || !name) return c.json({ error: "cwd and name required" }, 400);
  const result = gitCreateTag(cwd, name, message);
  if (!result.ok) return c.json({ success: false, error: result.stderr || "Tag creation failed" }, 500);
  return c.json({ success: true, result: result.stdout });
});

app.post("/api/git/tag/delete", async (c) => {
  const { cwd, name } = await c.req.json();
  if (!cwd || !name) return c.json({ error: "cwd and name required" }, 400);
  const result = gitDeleteTag(cwd, name);
  if (!result.ok) return c.json({ success: false, error: result.stderr || "Tag deletion failed" }, 500);
  return c.json({ success: true, result: result.stdout });
});

// Stash
app.get("/api/git/stash", (c) => {
  const cwd = c.req.query("cwd");
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  return c.json({ stash: gitStashList(cwd) });
});

app.post("/api/git/stash/push", async (c) => {
  const { cwd, message } = await c.req.json();
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  const result = gitStashPush(cwd, message);
  if (!result.ok) return c.json({ success: false, error: result.stderr || "Stash push failed" }, 500);
  return c.json({ success: true, result: result.stdout });
});

app.post("/api/git/stash/pop", async (c) => {
  const { cwd, index } = await c.req.json();
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  const result = gitStashPop(cwd, index);
  if (!result.ok) return c.json({ success: false, error: result.stderr || "Stash pop failed" }, 500);
  return c.json({ success: true, result: result.stdout });
});

app.post("/api/git/stash/apply", async (c) => {
  const { cwd, index } = await c.req.json();
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  const result = gitStashApply(cwd, index);
  if (!result.ok) return c.json({ success: false, error: result.stderr || "Stash apply failed" }, 500);
  return c.json({ success: true, result: result.stdout });
});

app.post("/api/git/stash/drop", async (c) => {
  const { cwd, index } = await c.req.json();
  if (!cwd || index === undefined) return c.json({ error: "cwd and index required" }, 400);
  const result = gitStashDrop(cwd, index);
  if (!result.ok) return c.json({ success: false, error: result.stderr || "Stash drop failed" }, 500);
  return c.json({ success: true, result: result.stdout });
});

// Amend commit
app.post("/api/git/amend", async (c) => {
  const { cwd, message } = await c.req.json();
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  const result = gitAmend(cwd, message);
  if (!result.ok) return c.json({ success: false, error: result.stderr || "Amend failed" }, 500);
  return c.json({ success: true, result: result.stdout });
});

// Cherry-pick / Revert
app.post("/api/git/cherry-pick", async (c) => {
  const { cwd, hash } = await c.req.json();
  if (!cwd || !hash) return c.json({ error: "cwd and hash required" }, 400);
  const result = gitCherryPick(cwd, hash);
  if (!result.ok) return c.json({ success: false, error: result.stderr || "Cherry-pick failed" }, 500);
  return c.json({ success: true, result: result.stdout });
});

app.post("/api/git/revert", async (c) => {
  const { cwd, hash, noCommit } = await c.req.json();
  if (!cwd || !hash) return c.json({ error: "cwd and hash required" }, 400);
  const result = gitRevert(cwd, hash, noCommit);
  if (!result.ok) return c.json({ success: false, error: result.stderr || "Revert failed" }, 500);
  return c.json({ success: true, result: result.stdout });
});

// Merge conflict resolution
app.post("/api/git/resolve-conflict", async (c) => {
  const { cwd, path, strategy } = await c.req.json();
  if (!cwd || !path || !strategy) return c.json({ error: "cwd, path, and strategy required" }, 400);
  const result = gitResolveConflict(cwd, path, strategy);
  if (!result.ok) return c.json({ success: false, error: result.stderr || "Conflict resolution failed" }, 500);
  return c.json({ success: true, result: result.stdout });
});

// Diff stats
app.get("/api/git/diff-stats", (c) => {
  const cwd = c.req.query("cwd");
  const path = c.req.query("path");
  const staged = c.req.query("staged") === "true";
  if (!cwd || !path) return c.json({ error: "cwd and path required" }, 400);
  return c.json(getGitDiffStats(cwd, path, staged));
});

// Compare with ref
app.get("/api/git/diff-ref", (c) => {
  const cwd = c.req.query("cwd");
  const path = c.req.query("path");
  const ref = c.req.query("ref");
  if (!cwd || !path || !ref) return c.json({ error: "cwd, path, and ref required" }, 400);
  return c.json({ diff: gitDiffWithRef(cwd, path, ref) });
});

// Show full commit
app.get("/api/git/show", (c) => {
  const cwd = c.req.query("cwd");
  const hash = c.req.query("hash");
  if (!cwd || !hash) return c.json({ error: "cwd and hash required" }, 400);
  const result = gitShowCommit(cwd, hash);
  if (!result.ok) return c.json({ error: result.stderr || "Show commit failed" }, 500);
  return c.json({ diff: result.stdout });
});

// Log search
app.get("/api/git/log-search", (c) => {
  const cwd = c.req.query("cwd");
  const query = c.req.query("query");
  if (!cwd || !query) return c.json({ error: "cwd and query required" }, 400);
  const count = parseInt(c.req.query("count") || "50");
  return c.json({ log: gitLogSearch(cwd, query, count) });
});

// Blame
app.get("/api/git/blame", (c) => {
  const cwd = c.req.query("cwd");
  const path = c.req.query("path");
  if (!cwd || !path) return c.json({ error: "cwd and path required" }, 400);
  return c.json({ blame: gitBlame(cwd, path) });
});

// Remotes
app.get("/api/git/remotes", (c) => {
  const cwd = c.req.query("cwd");
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  return c.json({ remotes: gitRemotes(cwd) });
});

// Unstage all
app.post("/api/git/unstage-all", async (c) => {
  const { cwd } = await c.req.json();
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  const result = gitUnstageAll(cwd);
  if (!result.ok) return c.json({ success: false, error: result.stderr || "Unstage all failed" }, 500);
  return c.json({ success: true, result: result.stdout });
});

// Export session HTML (#2: validate path, #84: proper HTML escaping)
app.post("/api/sessions/export-html", async (c) => {
  const { sessionPath } = await c.req.json();
  if (!sessionPath) return c.json({ error: "sessionPath required" }, 400);
  try {
    const safePath = validateSessionPath(sessionPath);
    const detail = await getSessionDetail(safePath);
    if (!detail) return c.json({ error: "Session not found" }, 404);
    const html = buildSessionHtml(detail);
    return c.json({ html });
  } catch (e: any) {
    return c.json({ error: e.message }, 403);
  }
});

// Search files in a project directory for @ mentions
app.get("/api/fs/search-files", (c) => {
  const dir = c.req.query("dir");
  const query = c.req.query("query") || "";
  if (!dir) return c.json({ error: "dir query required" }, 400);

  try {
    const safeDir = validateBrowsePath(dir.startsWith("~") ? homedir() + dir.slice(1) : dir);
  } catch (e: any) {
    return c.json({ error: e.message }, 403);
  }

  const safeDir = (() => {
    try { return validateBrowsePath(dir.startsWith("~") ? homedir() + dir.slice(1) : dir); }
    catch (e: any) { return null; }
  })();
  if (!safeDir) return c.json({ error: "Directory not allowed" }, 403);
  if (!existsSync(safeDir) || !statSync(safeDir).isDirectory()) return c.json({ files: [] });

  const q = query.toLowerCase();
  const results: Array<{ path: string; name: string; relativePath: string; isDirectory: boolean }> = [];
  const MAX_RESULTS = 30;
  const MAX_DEPTH = 5;

  // Directories to skip
  const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "target", "__pycache__", ".pi", ".cache", ".bun"]);

  function matches(name: string, relPath: string): boolean {
    if (!q) return true;
    return name.toLowerCase().includes(q) || relPath.toLowerCase().includes(q);
  }

  function walk(currentDir: string, depth: number, baseDir: string) {
    if (results.length >= MAX_RESULTS || depth > MAX_DEPTH) return;
    let entries;
    try { entries = readdirSync(currentDir, { withFileTypes: true }); }
    catch { return; } // permission denied

    // Collect dirs and files separately so dirs appear first
    const dirs: typeof entries = [];
    const files: typeof entries = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      if (entry.isDirectory()) dirs.push(entry); else if (entry.isFile()) files.push(entry);
    }

    // Add matching directories first (only direct children, not recursed)
    for (const entry of dirs) {
      if (results.length >= MAX_RESULTS) break;
      const fullPath = join(currentDir, entry.name);
      const relPath = fullPath.slice(baseDir.length + 1);
      // For top-level walk without query, only show dirs from depth 0 to avoid noise
      // With a query, show dirs at any depth if they match
      if (q ? matches(entry.name, relPath) : depth === 0) {
        results.push({ path: fullPath, name: entry.name, relativePath: relPath, isDirectory: true });
      }
    }

    // Add matching files
    for (const entry of files) {
      if (results.length >= MAX_RESULTS) break;
      const fullPath = join(currentDir, entry.name);
      const relPath = fullPath.slice(baseDir.length + 1);
      if (matches(entry.name, relPath)) {
        results.push({ path: fullPath, name: entry.name, relativePath: relPath, isDirectory: false });
      }
    }

    // Recurse into non-skipped dirs
    for (const entry of dirs) {
      if (results.length >= MAX_RESULTS) break;
      walk(join(currentDir, entry.name), depth + 1, baseDir);
    }
  }

  // If query has /, search from the implied subdirectory
  if (q.includes("/")) {
    const parts = q.split("/");
    const dirParts = parts.slice(0, -1); // everything except the filename
    const filePart = parts[parts.length - 1];
    const subDir = join(safeDir, ...dirParts);
    if (existsSync(subDir) && statSync(subDir).isDirectory()) {
      let subEntries;
      try { subEntries = readdirSync(subDir, { withFileTypes: true }); }
      catch { return c.json({ files: results }); }
      const dirs: typeof subEntries = [];
      const files: typeof subEntries = [];
      for (const entry of subEntries) {
        if (entry.name.startsWith(".")) continue;
        if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
        if (entry.isDirectory()) dirs.push(entry); else if (entry.isFile()) files.push(entry);
      }
      for (const entry of dirs) {
        if (results.length >= MAX_RESULTS) break;
        const fullPath = join(subDir, entry.name);
        const relPath = fullPath.slice(safeDir.length + 1);
        if (!filePart || entry.name.toLowerCase().includes(filePart)) {
          results.push({ path: fullPath, name: entry.name, relativePath: relPath, isDirectory: true });
        }
      }
      for (const entry of files) {
        if (results.length >= MAX_RESULTS) break;
        const fullPath = join(subDir, entry.name);
        const relPath = fullPath.slice(safeDir.length + 1);
        if (!filePart || entry.name.toLowerCase().includes(filePart)) {
          results.push({ path: fullPath, name: entry.name, relativePath: relPath, isDirectory: false });
        }
      }
      return c.json({ files: results });
    }
  }

  walk(safeDir, 0, safeDir);
  return c.json({ files: results });
});

// Health
app.get("/api/health", (c) => c.json({ status: "ok", time: Date.now(), pool: getPoolStats(), port: server.port }));

// ==================== Preview API ====================

// Serve overlay static assets
app.get("/__preview/overlay.js", (c) => {
  return c.text(getOverlayJS(), 200, {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "no-cache",
  });
});

app.get("/__preview/overlay.css", (c) => {
  return c.text(getOverlayCSS(), 200, {
    "Content-Type": "text/css; charset=utf-8",
    "Cache-Control": "no-cache",
  });
});

// List all previews or filter by project
app.get("/api/preview", (c) => {
  const projectId = c.req.query("projectId");
  const previews = listPreviews(projectId || undefined);
  return c.json({ previews });
});

// Get a specific preview
app.get("/api/preview/:projectId/:label", (c) => {
  const { projectId, label } = c.req.param();
  const preview = getPreview(projectId, label);
  if (!preview) return c.json({ error: "Preview not found" }, 404);
  return c.json({ preview });
});

// Start a preview
app.post("/api/preview/start", async (c) => {
  const body = await c.req.json() as any;
  const { projectId, cwd, label, command, port, remoteUrl } = body;
  if (!projectId || !cwd) return c.json({ error: "projectId and cwd are required" }, 400);
  if (!remoteUrl && !port && !command) {
    // Allow: just projectId + cwd (auto-detect) OR remoteUrl OR port OR command
  }

  try {
    const preview = await startPreview({ projectId, cwd, label, command, port, remoteUrl });
    return c.json({ preview }, 201);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Stop a preview
app.post("/api/preview/:projectId/:label/stop", async (c) => {
  const { projectId, label } = c.req.param();
  const preview = getPreview(projectId, label);
  if (!preview) return c.json({ error: "Preview not found" }, 404);
  await stopPreview(projectId, label);
  return c.json({ success: true });
});

// Switch proxy port for a running preview
app.post("/api/preview/:projectId/:label/port", async (c) => {
  const { projectId, label } = c.req.param();
  const { port } = await c.req.json() as any;
  if (!port || typeof port !== "number") return c.json({ error: "port (number) is required" }, 400);
  const preview = await setPreviewPort(projectId, label, port);
  if (!preview) return c.json({ error: "Preview not found" }, 404);
  return c.json({ preview });
});

// Update remote URL for a running preview
app.post("/api/preview/:projectId/:label/remote-url", async (c) => {
  const { projectId, label } = c.req.param();
  const { remoteUrl } = await c.req.json() as any;
  if (!remoteUrl || typeof remoteUrl !== "string") return c.json({ error: "remoteUrl (string) is required" }, 400);
  try {
    const preview = await setPreviewRemoteUrl(projectId, label, remoteUrl);
    if (!preview) return c.json({ error: "Preview not found" }, 404);
    return c.json({ preview });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

// Stop all previews for a project
app.post("/api/preview/:projectId/stop-all", async (c) => {
  const { projectId } = c.req.param();
  const previews = listPreviews(projectId);
  for (const p of previews) {
    await stopPreview(p.projectId, p.label);
  }
  return c.json({ success: true, stopped: previews.length });
});

// Open a preview in the system browser
app.post("/api/preview/:projectId/:label/open", async (c) => {
  const { projectId, label } = c.req.param();
  const preview = getPreview(projectId, label);
  if (!preview) return c.json({ error: "Preview not found" }, 404);
  if (preview.status !== "running") return c.json({ error: "Preview is not running" }, 503);

  try {
    const open = (await import("open")).default;
    const openUrl = preview.remoteUrl || `http://localhost:${preview.port}`;
    await open(openUrl);
    return c.json({ success: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Preview WS log stream
app.get(
  "/ws/preview/:projectId/:label",
  upgradeWebSocket(() => {
    return {
      onOpen(_event, ws) {
        // Params are extracted inside from the URL
      },
      onMessage(event, ws) {
        try {
          const msg = JSON.parse(event.data as string);
          if (msg.type === "subscribe" && msg.projectId && msg.label) {
            const raw = (ws as any).raw as ServerWebSocket;
            const key = `${msg.projectId}:${msg.label}`;
            wsToPreviewLog.set(raw, { projectId: msg.projectId, label: msg.label, unsub: null });

            // Send existing logs
            const preview = getPreview(msg.projectId, msg.label);
            if (preview) {
              for (const line of preview.logs) {
                try { ws.send(JSON.stringify({ type: "preview_log", projectId: msg.projectId, label: msg.label, text: line, stream: "stdout" })); } catch {}
              }
            }

            // Subscribe to new logs
            const unsub = addLogListener(msg.projectId, msg.label, (text, stream) => {
              try {
                if (raw.readyState === 1) {
                  raw.send(JSON.stringify({ type: "preview_log", projectId: msg.projectId, label: msg.label, text, stream }));
                }
              } catch {}
            });
            const entry = wsToPreviewLog.get(raw);
            if (entry) entry.unsub = unsub;
          }
        } catch {}
      },
      onClose(_event, ws) {
        const raw = (ws as any).raw as ServerWebSocket;
        const entry = wsToPreviewLog.get(raw);
        if (entry?.unsub) entry.unsub();
        wsToPreviewLog.delete(raw);
      },
    };
  })
);

// Proxy handler — extracts remaining path from the full URL for robustness
const previewProxyHandler = async (c: any) => {
  const { projectId, label } = c.req.param();
  const url = new URL(c.req.url);
  const prefix = `/preview/${projectId}/${label}`;
  let remaining = url.pathname.slice(prefix.length);
  if (!remaining || remaining === "/") remaining = "/";
  // Preserve query string
  if (url.search) remaining += url.search;
  console.log(`[preview-proxy] route matched: ${c.req.path} → projectId=${projectId} label=${label} remaining=${remaining}`);
  return handlePreviewRequest(c.req.raw, projectId, label, remaining);
};

// Catch-all proxy for /preview/:projectId/:label/* (anything after label)
app.all("/preview/:projectId/:label/*", previewProxyHandler);
// Also handle bare /preview/:projectId/:label (no trailing slash)
app.all("/preview/:projectId/:label", previewProxyHandler);
// And /preview/:projectId/:label/ (trailing slash, no additional path)
app.all("/preview/:projectId/:label/", previewProxyHandler);

// Simple HTML export builder (#84: use escapeHtml for all interpolated values)
function buildSessionHtml(detail: any): string {
  const entries = detail.entries || [];
  let body = "";
  for (const entry of entries) {
    if (!entry.message) continue;
    const msg = entry.message;
    const role = escapeHtml(msg.role || "unknown");
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    const escaped = escapeHtml(content).replace(/\n/g, "<br>");
    const bg = role === "user" ? "#1a1a2e" : role === "assistant" ? "#16213e" : "#0f3460";
    body += `<div style="padding:12px;margin:8px 0;border-radius:8px;background:${bg};"><b style="color:#a8d8ea">${role}</b><div style="color:#e2e2e2;margin-top:4px;">${escaped}</div></div>`;
  }
  const safeName = escapeHtml(detail.name || "Session Export");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(detail.name || "Session")}</title><style>body{font-family:system-ui;background:#0a0a0a;color:#e2e2e2;max-width:800px;margin:0 auto;padding:20px;}</style></head><body><h1>${safeName}</h1>${body}</body></html>`;
}

// ==================== WebSocket ====================

// Map: raw ServerWebSocket -> agentKey (for routing messages)
const wsToAgent = new Map<ServerWebSocket, string>();
// Map: raw ServerWebSocket -> terminalId (for terminal WS routing)
const wsToTerminal = new Map<ServerWebSocket, string>();
// Map: raw ServerWebSocket -> preview log subscription
const wsToPreviewLog = new Map<ServerWebSocket, { projectId: string; label: string; unsub: (() => void) | null }>();

// ── Unified WebSocket endpoint ──
// Routes to chat or terminal handler based on ?type= query param
app.get(
  "/ws",
  upgradeWebSocket((c) => {
    const wsType = c.req.query("type") || "chat";

    // ── Terminal route ──
    if (wsType === "terminal") {
      const terminalId = c.req.query("id");
      return {
        onOpen(_event, ws) {
          if (!terminalId) { ws.close(); return; }
          const term = getTerminal(terminalId);
          if (!term) {
            try { ws.send(JSON.stringify({ type: "term_exit", id: terminalId, exitCode: 1 })); } catch {}
            ws.close();
            return;
          }
          const raw = (ws as any).raw as ServerWebSocket;
          wsToTerminal.set(raw, terminalId);
          term.attach(raw);
          // Send buffer for scrollback on reattach
          if (term.buffer) {
            try { ws.send(JSON.stringify({ type: "term_output", id: terminalId, data: term.buffer })); } catch {}
          }
        },
        onMessage(event, ws) {
          const raw = (ws as any).raw as ServerWebSocket;
          const tid = wsToTerminal.get(raw);
          if (!tid) return;
          const term = getTerminal(tid);
          if (!term) return;
          try {
            const msg = JSON.parse(event.data as string);
            switch (msg.type) {
              case "term_input": term.write(msg.data); break;
              case "term_resize": term.resize(msg.cols, msg.rows); break;
            }
          } catch {}
        },
        onClose(_event, ws) {
          const raw = (ws as any).raw as ServerWebSocket;
          const tid = wsToTerminal.get(raw);
          wsToTerminal.delete(raw);
          if (tid) {
            const term = getTerminal(tid);
            if (term) term.detach(raw);
          }
        },
      };
    }

    // ── Chat route (default) ──
    const projectId = c.req.query("projectId");
    const sessionPath = c.req.query("sessionPath");
    const provider = c.req.query("provider");
    const model = c.req.query("model");
    const newSessionId = c.req.query("newSessionId");

    // #83: Reject WS connections lacking valid projectId
    if (!projectId) {
      return {
        onOpen(_event, ws) {
          try { ws.send(JSON.stringify({ type: "error", message: "projectId is required" })); } catch {}
          ws.close();
        },
        onMessage() {},
        onClose() {},
      };
    }

    return {
      async onOpen(_event, ws) {
        try {
          const project = getProject(projectId);
          // #2/#83: Reject if project not found — no fallback to process.cwd()
          if (!project) {
            try { ws.send(JSON.stringify({ type: "error", message: "Invalid projectId" })); } catch {}
            ws.close();
            return;
          }

          const cwd = project.path;
          touchProject(project.id);

          const { agent, isNew } = getOrCreateAgent(cwd, sessionPath || null, provider || undefined, model || undefined);
          const raw = (ws as any).raw as ServerWebSocket;

          // Track which agent this WS belongs to — keyed by (cwd, sessionPath) tuple
          const agentKey = agent.getKey();
          wsToAgent.set(raw, agentKey);

          // Attach this client to the pooled agent
          agent.attach(raw);

          // If agent is new, start it
          // #12: Delete from pool if start() fails
          if (isNew) {
            try {
              await agent.start();
            } catch (err: any) {
              console.error("Failed to start agent:", err.message || err);
              deleteFromPool(agentKey);
              try { if (ws.readyState === 1) ws.send(JSON.stringify({ type: "error", message: `Failed to start agent: ${err.message}` })); } catch {}
            }
          }

          // If client requested a new session (fresh WS connection), tell pi to create one
          if (newSessionId) {
            agent.send({ type: "new_session" });
          }
        } catch (fatalErr: any) {
          console.error("Fatal onOpen error:", fatalErr);
          try { ws.send(JSON.stringify({ type: "error", message: "Internal server error" })); } catch {}
        }
      },

      async onMessage(event, ws) {
        const raw = (ws as any).raw as ServerWebSocket;
        const agentKey = wsToAgent.get(raw);
        if (!agentKey) return;

        // Find the pooled agent
        const agent = lookupAgent(agentKey);
        if (!agent) return;

        try {
          const msg: WSClientMessage = JSON.parse(event.data as string);

          // Forward most commands directly to the agent
          switch (msg.type) {
            case "prompt": agent.send({ type: "prompt", message: msg.message, images: msg.images }); break;
            case "abort": agent.send({ type: "abort" }); break;
            case "steer": agent.send({ type: "steer", message: msg.message, ...(msg as any).images ? { images: (msg as any).images } : {} }); break;
            case "follow_up": agent.send({ type: "follow_up", message: msg.message, ...(msg as any).images ? { images: (msg as any).images } : {} }); break;
            case "new_session": agent.send({ type: "new_session" }); break;
            case "load_session": agent.loadSession(msg.sessionPath); break;
            case "switch_session": agent.switchSession((msg as any).sessionPath); break;
            case "rekey_session": {
              // Client is telling us the agent's session path has changed
              // (typically from `__new__` to the real path reported by PI).
              const { oldKey, newKey } = msg as { oldKey: string; newKey: string };
              const moved = rekeyAgent(oldKey, newKey);
              if (moved) {
                wsToAgent.set(raw, newKey);
                try {
                  if (ws.readyState === 1) ws.send(JSON.stringify({ type: "response", command: "rekey_session", success: true, id: (msg as any).id }));
                } catch {}
              } else {
                try {
                  if (ws.readyState === 1) ws.send(JSON.stringify({ type: "response", command: "rekey_session", success: false, error: "rekey failed", id: (msg as any).id }));
                } catch {}
              }
              break;
            }
            case "set_model": agent.send({ type: "set_model", provider: msg.provider, modelId: msg.modelId }); break;
            case "cycle_model": agent.send({ type: "cycle_model" }); break;
            case "set_thinking": {
              const level = msg.level;
              // #91: Nested try/catch around ws.send for set_thinking
              try {
                if (ws.readyState === 1) ws.send(JSON.stringify({ type: "thinking_changed", level }));
              } catch {}
              agent.send({ type: "set_thinking_level", level });
              break;
            }
            case "cycle_thinking_level": agent.send({ type: "cycle_thinking_level" }); break;
            case "fork": agent.send({ type: "fork", entryId: msg.entryId }); break;
            case "compact": agent.send({ type: "compact", ...(msg as any).customInstructions ? { customInstructions: (msg as any).customInstructions } : {} }); break;
            case "get_state": agent.send({ type: "get_state" }); break;
            case "get_available_models": agent.send({ type: "get_available_models" }); break;
            case "get_commands": agent.send({ type: "get_commands" }); break;
            case "get_fork_messages": agent.send({ type: "get_fork_messages" }); break;
            case "get_messages": agent.send({ type: "get_messages" }); break;
            case "get_last_assistant_text": agent.send({ type: "get_last_assistant_text" }); break;
            case "get_session_stats": agent.send({ type: "get_session_stats" }); break;
            case "set_session_name": agent.send({ type: "set_session_name", name: msg.name }); break;
            case "set_auto_compaction": agent.send({ type: "set_auto_compaction", enabled: (msg as any).enabled }); break;
            case "set_auto_retry": agent.send({ type: "set_auto_retry", enabled: (msg as any).enabled }); break;
            case "abort_retry": agent.send({ type: "abort_retry" }); break;
            case "set_steering_mode": agent.send({ type: "set_steering_mode", mode: (msg as any).mode }); break;
            case "set_follow_up_mode": agent.send({ type: "set_follow_up_mode", mode: (msg as any).mode }); break;
            case "export_html": agent.send({ type: "export_html", ...(msg as any).outputPath ? { outputPath: (msg as any).outputPath } : {} }); break;
            case "clone": agent.send({ type: "clone" }); break;
            case "bash": agent.send({ type: "bash", command: (msg as any).command }); break;
            case "abort_bash": agent.send({ type: "abort_bash" }); break;
            case "extension_ui_response": agent.send({ type: "extension_ui_response", id: msg.id, value: msg.value, confirmed: msg.confirmed, cancelled: msg.cancelled }); break;
            // #14: delete_session with symlink/realpath validation
            case "delete_session": {
              const sessionId = msg.sessionId;
              const proj = getProject(projectId);
              if (proj) {
                listProjectSessions(proj.path).then(list => {
                  const target = list.find(s => s.id === sessionId);
                  if (target) {
                    // Validate the resolved path is inside session roots (#14)
                    try {
                      const safePath = validateSessionPath(target.filePath, proj.path);
                      unlink(safePath)
                        .then(() => { if (raw.readyState === 1) raw.send(JSON.stringify({ type: "session_deleted", sessionId })); })
                        .catch((e: any) => { if (raw.readyState === 1) raw.send(JSON.stringify({ type: "error", message: `Failed to delete: ${e.message}` })); });
                    } catch (e: any) {
                      if (raw.readyState === 1) raw.send(JSON.stringify({ type: "error", message: `Invalid session path: ${e.message}` }));
                    }
                  }
                });
              }
              break;
            }
            // #14: rename_session with symlink/realpath validation
            case "rename_session": {
              const { sessionId, name } = msg;
              const proj2 = getProject(projectId);
              if (proj2) {
                listProjectSessions(proj2.path).then(list => {
                  const target = list.find(s => s.id === sessionId);
                  if (target) {
                    // Validate the resolved path is inside session roots (#14)
                    try {
                      const safePath = validateSessionPath(target.filePath, proj2.path);
                      readFile(safePath, "utf-8").then(content => {
                        const renameEntry = JSON.stringify({ type: "session_info", name, timestamp: new Date().toISOString() });
                        return writeFile(safePath, content.trim() + "\n" + renameEntry + "\n");
                      }).then(() => {
                        if (raw.readyState === 1) raw.send(JSON.stringify({ type: "session_renamed", sessionId, name }));
                      }).catch((e: any) => {
                        if (raw.readyState === 1) raw.send(JSON.stringify({ type: "error", message: `Failed to rename: ${e.message}` }));
                      });
                    } catch (e: any) {
                      if (raw.readyState === 1) raw.send(JSON.stringify({ type: "error", message: `Invalid session path: ${e.message}` }));
                    }
                  }
                });
              }
              break;
            }
            case "refresh_sessions": {
              const proj3 = msg.projectId ? getProject(msg.projectId) : null;
              if (proj3) {
                listProjectSessions(proj3.path).then(refreshed => {
                  if (raw.readyState === 1) raw.send(JSON.stringify({ type: "sessions_refreshed", sessions: refreshed }));
                });
              }
              break;
            }
            default:
              console.warn("Unknown WS message type:", (msg as any).type);
          }
        } catch (e) {
          console.error("WS message parse error:", e);
        }
      },

      onClose(_event, ws) {
        try {
          const raw = (ws as any).raw as ServerWebSocket;
          const agentKey = wsToAgent.get(raw);
          wsToAgent.delete(raw);

          if (agentKey) {
            // Detach client — agent stays alive with idle timeout
            detachFromAgent(agentKey, raw);
          }
        } catch (e) {
          console.error("Error in onClose:", e);
        }
      },
    };
  })
);

// ==================== Static Files (Production) ====================

const CLIENT_DIST = join(import.meta.dir, "..", "..", "client", "dist");

// Serve static assets from client dist (favicon, icons, /assets/*, etc.)
// serveStatic passes through if file not found, so API routes are unaffected
app.use("/*", serveStatic({ root: CLIENT_DIST }));

// Service Worker must be served with correct headers (no cache)
app.get("/sw.js", async (c) => {
  const swPath = join(CLIENT_DIST, "sw.js");
  try {
    const content = await readFile(swPath, "utf-8");
    return c.text(content, 200, {
      "Content-Type": "application/javascript; charset=utf-8",
      "Service-Worker-Allowed": "/",
      "Cache-Control": "no-cache, no-store, must-revalidate",
    });
  } catch {
    return c.notFound();
  }
});

// SPA fallback — serve index.html for any unmatched route
app.get("*", async (c) => {
  // Safety net: if we somehow reach here for a preview path, return a clear error
  if (c.req.path.startsWith("/preview/")) {
    console.error(`[preview-proxy] MISROUTE: SPA fallback caught preview path ${c.req.path}`);
    return c.html(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Preview Error</title><style>body{font-family:system-ui;background:#0a0a0a;color:#a0a0a0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:12px}h1{color:#d4a020;font-size:18px;margin:0}p{font-size:13px;color:#666}</style></head><body><h1>Preview proxy misrouted</h1><p>Path ${escapeHtml(c.req.path)} reached SPA fallback. Check server logs.</p></body></html>`, 500);
  }
  try {
    const indexPath = join(CLIENT_DIST, "index.html");
    const html = await readFile(indexPath, "utf-8");
    return c.html(html);
  } catch {
    // In dev mode, client is served separately by Vite
    return c.json({ 
      message: "PI Web Server running. Client served separately in dev mode.",
      docs: "Run 'bun run dev:client' in another terminal for the frontend." 
    });
  }
});

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 0;
const hostname = process.env.HOST || "127.0.0.1";

const server = Bun.serve({
  port,
  hostname,
  fetch: app.fetch,
  websocket,
});

// Graceful shutdown — kill all preview processes
process.on("SIGINT", () => { stopAllPreviews().catch(() => {}); process.exit(0); });
process.on("SIGTERM", () => { stopAllPreviews().catch(() => {}); process.exit(0); });

console.log(`PI Web server running at http://${hostname}:${server.port}`);
