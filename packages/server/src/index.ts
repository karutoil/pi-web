import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { createBunWebSocket } from "hono/bun";
import type { ServerWebSocket } from "bun";
import { join, basename, resolve, normalize, relative, isAbsolute, delimiter, dirname } from "node:path";
import { existsSync, statSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { readdir, stat, readFile, writeFile, unlink, rename as renameFs, mkdir } from "node:fs/promises";
import { homedir, platform } from "node:os";

import { addProject, removeProject, listProjects, getProject, touchProject, getLayout, saveLayout, deleteLayout } from "./db";
import { listProjectSessions, getSessionDetail } from "./pi-sessions";
import { buildSessionHtmlPretty } from "./sessionExportPretty";
import { getOrCreateAgent, stopAllAgents, getPoolStats, lookupAgent, detachFromAgent, deleteFromPool, rekeyAgent } from "./pi-agent";
import { createTerminal, getTerminal, listTerminals, killTerminal } from "./pi-terminal";
import { getGitStatus, getGitDiff, getGitDiffForCommit, gitStage, gitUnstage, gitCommit, gitLog, gitCheckout, gitDiscard, gitBranches, gitPush, gitPull, gitFetch, gitCreateBranch, gitDeleteBranch, gitRenameBranch, gitTags, gitCreateTag, gitDeleteTag, gitStashList, gitStashShow, gitStashPush, gitStashPop, gitStashApply, gitStashDrop, gitAmend, gitCherryPick, gitRevert, gitResolveConflict, getGitDiffStats, gitDiffWithRef, gitShowCommit, gitLogSearch, gitBlame, gitRemotes, gitUnstageAll } from "./pi-git";
import type { GitResult } from "./pi-git";
import { getVersionInfo } from "./pi-version";
import { startPreview, stopPreview, getPreview, listPreviews, addLogListener, stopAllPreviews, setPreviewPort, setPreviewRemoteUrl } from "./pi-preview";
import { handlePreviewRequest, parsePreviewPath } from "./pi-preview-proxy";
import { getOverlayJS, getOverlayCSS } from "./pi-preview-overlay";
import type { WSClientMessage, WSServerMessage, WorkspaceLayout } from "@pi-web/shared";

// ─── Rate limiting for file writes ─────────────────────────────

const WRITE_RATE_LIMIT = { max: 30, windowMs: 60_000 };
const writeRateLimitBuckets = new Map<string, { tokens: number; lastRefill: number }>();

function checkWriteRateLimit(projectId: string): boolean {
  const now = Date.now();
  let bucket = writeRateLimitBuckets.get(projectId);
  if (!bucket) {
    bucket = { tokens: WRITE_RATE_LIMIT.max, lastRefill: now };
    writeRateLimitBuckets.set(projectId, bucket);
  }
  const tokensToAdd = Math.floor((now - bucket.lastRefill) / WRITE_RATE_LIMIT.windowMs) * WRITE_RATE_LIMIT.max;
  if (tokensToAdd > 0) {
    bucket.tokens = Math.min(WRITE_RATE_LIMIT.max, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;
  }
  if (bucket.tokens > 0) {
    bucket.tokens--;
    return true;
  }
  return false;
}


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

/** Returns true when `child` is inside `parent`, robust across platforms. */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  if (!rel) return true;
  const first = rel.split(/[/\\]/)[0];
  return first !== ".." && !isAbsolute(rel);
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
    return isInside(realRoot, realPath) || realPath === realRoot;
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
  if (!isInside(realHome, realDir) && realDir !== realHome) {
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

const DEFAULT_WORKSPACE_LAYOUT: WorkspaceLayout = {
  version: 2,
  regions: [
    { id: "left", size: 352, mode: "split" },
    { id: "center", size: 100, mode: "tabs" },
    { id: "right", size: 420, mode: "tabs" },
    { id: "top", size: 220, mode: "tabs" },
    { id: "bottom", size: 260, mode: "tabs" },
  ],
  panels: [
    { id: "channels", region: "left", order: 0, size: 100 },
    { id: "chat", region: "center", order: 0, size: 100 },
    { id: "terminal", region: "bottom", order: 0, size: 100 },
    { id: "preview", region: "right", order: 0, size: 100 },
    { id: "git", region: "right", order: 1, size: 100 },
    { id: "files", region: "right", order: 2, size: 100 },
    { id: "extensions", region: "right", order: 3, size: 100 },
  ],
  updatedAt: null,
};

const WORKSPACE_PANEL_IDS = new Set(["channels", "chat", "terminal", "preview", "git", "files", "rail", "extensions"]);
const WORKSPACE_REGION_IDS = new Set(["left", "center", "right", "top", "bottom"]);

function normalizeLayout(input: unknown): WorkspaceLayout {
  const source = input as Partial<WorkspaceLayout> | null;
  const regionIds = ["left", "center", "right", "top", "bottom"] as const;
  const panelIds = ["channels", "chat", "terminal", "preview", "git", "files", "rail", "extensions"] as const;
  const seenPanels = new Set<string>();

  const normalizedRegions = regionIds.map((id, index) => {
    const fallback = DEFAULT_WORKSPACE_LAYOUT.regions[index];
    const region = Array.isArray(source?.regions) ? source.regions.find(r => r?.id === id) : undefined;
    const size = typeof region?.size === "number" ? region.size : Number(region?.size);
    const mode: WorkspaceLayout["regions"][number]["mode"] = region?.mode === "split" ? "split" : "tabs";
    return {
      id,
      size: Number.isFinite(size) ? Math.max(id === "center" ? 80 : 0, Math.min(size, id === "center" ? 100 : 720)) : fallback.size,
      mode,
    };
  });

  const normalizedPanels = Array.isArray(source?.panels)
    ? source.panels.map((panel, index) => {
        const id = typeof panel?.id === "string" && WORKSPACE_PANEL_IDS.has(panel.id) ? panel.id : null;
        if (!id || seenPanels.has(id)) return null;
        seenPanels.add(id);
        const fallbackPanel = DEFAULT_WORKSPACE_LAYOUT.panels.find(p => p.id === id);
        const region = typeof panel?.region === "string" && WORKSPACE_REGION_IDS.has(panel.region) ? panel.region : fallbackPanel?.region ?? "center";
        const order = Number.isFinite(Number(panel?.order)) ? Number(panel.order) : index;
        const size = typeof panel?.size === "number" ? panel.size : Number(panel?.size);
        return {
          id: id as WorkspaceLayout["panels"][number]["id"],
          region: region as WorkspaceLayout["panels"][number]["region"],
          order,
          size: Number.isFinite(size) ? Math.max(8, Math.min(size, 100)) : fallbackPanel?.size ?? 100,
        };
      }).filter((panel): panel is WorkspaceLayout["panels"][number] => panel !== null)
    : [...DEFAULT_WORKSPACE_LAYOUT.panels];

  const hasRail = normalizedPanels.some(panel => panel.id === "rail");
  const hasChannels = normalizedPanels.some(panel => panel.id === "channels");
  if (hasRail && hasChannels) {
    const merged = normalizedPanels.filter(panel => panel.id !== "rail");
    normalizedPanels.splice(0, normalizedPanels.length, ...merged);
    seenPanels.delete("rail");
  } else if (hasRail && !hasChannels) {
    normalizedPanels.splice(0, normalizedPanels.length, ...normalizedPanels.map(panel => panel.id === "rail" ? { ...panel, id: "channels" as const } : panel));
    seenPanels.delete("rail");
    seenPanels.add("channels");
  }

  for (const panel of DEFAULT_WORKSPACE_LAYOUT.panels) {
    if (!seenPanels.has(panel.id)) normalizedPanels.push({ ...panel });
  }

  return {
    version: 2,
    regions: normalizedRegions,
    panels: normalizedPanels,
    updatedAt: typeof source?.updatedAt === "string" ? source.updatedAt : null,
  };
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

app.get("/api/layout", (c) => {
  const key = c.req.query("key") || "workspace";
  const saved = getLayout(key);
  return c.json({ layout: saved ? normalizeLayout(saved) : DEFAULT_WORKSPACE_LAYOUT });
});

app.put("/api/layout", async (c) => {
  const key = c.req.query("key") || "workspace";
  const body = await c.req.json().catch(() => ({}));
  const layout = normalizeLayout(body.layout || body);
  const saved = { ...layout, updatedAt: new Date().toISOString() };
  saveLayout(key, saved);
  return c.json({ layout: saved });
});

app.delete("/api/layout", (c) => {
  const key = c.req.query("key") || "workspace";
  deleteLayout(key);
  return c.json({ layout: DEFAULT_WORKSPACE_LAYOUT });
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

// Browse filesystem directories (used by directory pickers; not restricted to home)
app.get("/api/fs/browse", async (c) => {
  let dir = c.req.query("dir") || homedir();
  // Expand ~ to home directory
  if (dir.startsWith("~")) dir = join(homedir(), dir.slice(1));

  dir = resolve(normalize(dir));

  function parentOf(d: string): string | null {
    const p = resolve(join(d, ".."));
    return p === resolve(d) ? null : p;
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
      parentPath: parentOf(dir),
      items,
    });
  } catch (e: any) {
    // If we can't read the dir (permissions), return empty with error
    return c.json({
      currentPath: dir,
      parentPath: parentOf(dir),
      items: [],
      error: e.code === "EACCES" ? "Permission denied" : e.message,
    });
  }
});

// ── File Explorer API ──

// List files in a project directory (recursive, for tree view)
app.get("/api/fs/list", async (c) => {
  const dir = c.req.query("dir");
  const projectId = c.req.query("projectId");
  if (!dir) return c.json({ error: "dir required" }, 400);
  if (!projectId) return c.json({ error: "projectId required" }, 400);

  try {
    const project = getProject(projectId);
    if (!project) return c.json({ error: "Project not found" }, 404);
    const projectBase = realpathSync(project.path);

    const safeDir = validateBrowsePath(dir.startsWith("~") ? join(homedir(), dir.slice(1)) : dir);
    if (!isInside(projectBase, safeDir)) {
      return c.json({ error: "Path is outside project directory" }, 403);
    }

    const dirStat = await stat(safeDir).catch(() => null);
    if (!dirStat?.isDirectory()) {
      return c.json({ error: "Not a directory" }, 400);
    }

    const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "target", "__pycache__", ".pi", ".cache", ".bun", ".turbo", ".vercel"]);
    const MAX_DEPTH = 8;
    const paths: string[] = [];

    async function walk(currentDir: string, depth: number) {
      if (depth > MAX_DEPTH) return;
      let entries;
      try { entries = await readdir(currentDir, { withFileTypes: true }); } catch { return; }

      // Sort: dirs first, then files, alphabetical
      const dirs: typeof entries = [];
      const files: typeof entries = [];
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
        if (entry.isSymbolicLink()) continue; // avoid symlink traversal in tree
        if (entry.isDirectory()) dirs.push(entry); else if (entry.isFile()) files.push(entry);
      }

      dirs.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
      files.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

      for (const entry of [...dirs, ...files]) {
        const fullPath = join(currentDir, entry.name);
        const relativePath = fullPath.slice(safeDir.length + 1);
        paths.push(relativePath + (entry.isDirectory() ? "/" : ""));
        if (entry.isDirectory()) await walk(fullPath, depth + 1);
      }
    }

    await walk(safeDir, 0);
    return c.json({ paths });
  } catch (e: any) {
    return c.json({ error: e.message }, 403);
  }
});

// Read a file's contents
app.get("/api/fs/read", async (c) => {
  const filePath = c.req.query("path");
  const projectId = c.req.query("projectId");
  if (!filePath) return c.json({ error: "path required" }, 400);
  if (!projectId) return c.json({ error: "projectId required" }, 400);

  try {
    const project = getProject(projectId);
    if (!project) return c.json({ error: "Project not found" }, 404);
    const projectBase = realpathSync(project.path);

    const safePath = validateBrowsePath(filePath.startsWith("~") ? join(homedir(), filePath.slice(1)) : filePath);
    if (!isInside(projectBase, safePath)) {
      return c.json({ error: "Path is outside project directory" }, 403);
    }
    if (!existsSync(safePath)) return c.json({ error: "File not found" }, 404);
    const stat = statSync(safePath);
    if (stat.isDirectory()) return c.json({ error: "Path is a directory" }, 400);
    // Limit file size to 2MB
    if (stat.size > 2 * 1024 * 1024) return c.json({ error: "File too large (max 2MB)" }, 400);

    const buffer = await readFile(safePath);
    if (buffer.includes(0)) {
      return c.json({ error: "Binary files cannot be edited", binary: true, size: stat.size }, 415);
    }
    const content = buffer.toString("utf-8");
    return c.json({ content, size: stat.size });
  } catch (e: any) {
    return c.json({ error: e.message }, 403);
  }
});

// Write/save a file
app.put("/api/fs/write", async (c) => {
  const { path: filePath, content, projectId, overwrite } = await c.req.json();
  if (typeof filePath !== "string" || typeof content !== "string") return c.json({ error: "path and content required" }, 400);
  if (!projectId || typeof projectId !== "string") return c.json({ error: "projectId required" }, 400);
  // Body size limit (~10 MB)
  if (Buffer.byteLength(content, "utf8") > 10 * 1024 * 1024) return c.json({ error: "content too large (max 10MB)" }, 400);

  if (!checkWriteRateLimit(projectId)) {
    return c.json({ error: "Write rate limit exceeded. Try again later." }, 429);
  }

  try {
    const project = getProject(projectId);
    if (!project) return c.json({ error: "Project not found" }, 404);
    const projectBase = realpathSync(project.path);

    // Resolve robustly: relative paths are resolved under the project root;
    // absolute paths are resolved as-is.
    const normalizedFilePath = filePath.startsWith("~") ? join(homedir(), filePath.slice(1)) : filePath;
    const targetResolved = isAbsolute(filePath)
      ? resolve(normalize(normalizedFilePath))
      : resolve(projectBase, normalize(normalizedFilePath));

    // Harden against symlinks: when target exists, ensure its real path stays
    // inside the project. Whether it exists or not, its parent must be inside.
    const targetRealParent = realpathSync(join(targetResolved, ".."));
    if (!isInside(projectBase, targetRealParent)) {
      return c.json({ error: "Path is outside project directory" }, 403);
    }

    let finalTarget = targetResolved;
    // If the target path (or a symlink leading to it) exists, verify the real
    // resolved target stays inside the project. Broken symlinks are caught with
    // lstat so they cannot be used to create files outside the project.
    let targetLstat;
    try { targetLstat = lstatSync(targetResolved); } catch { targetLstat = null; }
    if (targetLstat) {
      const targetReal = realpathSync(targetResolved);
      if (!isInside(projectBase, targetReal)) {
        return c.json({ error: "Path resolves outside project directory" }, 403);
      }
      if (targetLstat.isDirectory()) return c.json({ error: "Cannot overwrite a directory" }, 400);
      if (!overwrite) return c.json({ error: "File already exists; set overwrite: true to replace" }, 409);
      finalTarget = targetReal;
    }

    await writeFile(finalTarget, content, "utf-8");
    return c.json({ success: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 403);
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
  return c.json({ stashes: gitStashList(cwd) });
});

app.get("/api/git/stash/show", (c) => {
  const cwd = c.req.query("cwd");
  const index = parseInt(c.req.query("index") || "0");
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  if (isNaN(index) || index < 0) return c.json({ error: "invalid index" }, 400);
  const result = gitStashShow(cwd, index);
  return c.json(result);
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

// Generate a commit message using PI
app.post("/api/git/generate-commit", async (c) => {
  const { cwd, model } = await c.req.json();
  if (!cwd) return c.json({ error: "cwd required" }, 400);

  const diff = getGitDiffForCommit(cwd);
  const status = getGitStatus(cwd);
  const hasChanges = diff.trim() || (status && status.untracked.length > 0);
  if (!hasChanges) {
    return c.json({ error: "No changes to generate a commit message for" }, 400);
  }

  // Build a brief file summary alongside the diff
  let fileSummary = "";
  if (status) {
    const stagedFiles = status.staged.map(f => `${f.status} ${f.path}`);
    const unstagedFiles = status.unstaged.map(f => `${f.status} ${f.path}`);
    const untrackedFiles = status.untracked.map(p => `? ${p}`);
    const all = [...stagedFiles, ...unstagedFiles, ...untrackedFiles];
    if (all.length) fileSummary = `Files changed:\n${all.join("\n")}\n\n`;
  }

  const combined = fileSummary + diff;

  // Truncate diff if too long (keep first 8KB for prompt)
  const maxDiffLen = 8192;
  const truncatedDiff = combined.length > maxDiffLen
    ? combined.slice(0, maxDiffLen) + "\n... (diff truncated)"
    : combined;

  const prompt = `Generate a concise git commit message for the following diff. Use conventional commits format (e.g. "feat:", "fix:", "chore:", etc.). Only output the commit message, nothing else. Do not use backticks or quotes around the message.\n\n${truncatedDiff}`;

  // Build pi CLI args
  const args = ["-p", "--no-session"];
  if (model) args.push("--model", model);
  args.push(prompt);

  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const envPath = [
    join(home, ".bun/bin"),
    join(home, ".nvm/versions/node/v22.22.2/bin"),
    ...(platform() === "win32" ? [] : ["/usr/local/bin", "/usr/bin", "/bin"]),
    process.env.PATH || "",
  ].join(delimiter);

  const piBin = platform() === "win32" ? "pi.cmd" : "pi";
  try {
    const proc = Bun.spawn([piBin, ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PATH: envPath },
    });

    const timeoutMs = 30_000;
    const exitCode = await Promise.race([
      proc.exited,
      new Promise<null>((_, reject) =>
        setTimeout(() => { proc.kill(); reject(new Error("Timeout")); }, timeoutMs)
      ),
    ]);

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      return c.json({ error: stderr.trim() || `PI exited with code ${exitCode}` }, 500);
    }

    const stdout = await new Response(proc.stdout).text();
    const message = stdout.trim();
    if (!message) return c.json({ error: "PI returned empty response" }, 500);
    return c.json({ message });
  } catch (err: any) {
    return c.json({ error: err.message || "Failed to generate commit message" }, 500);
  }
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

// Pretty export — matches the live PI web-chat styling
app.post("/api/sessions/export-html-pretty", async (c) => {
  const { sessionPath } = await c.req.json();
  if (!sessionPath) return c.json({ error: "sessionPath required" }, 400);
  try {
    const safePath = validateSessionPath(sessionPath);
    const detail = await getSessionDetail(safePath);
    if (!detail) return c.json({ error: "Session not found" }, 404);
    const html = await buildSessionHtmlPretty(detail);
    return c.json({ html });
  } catch (e: any) {
    return c.json({ error: e.message }, 403);
  }
});

// Export raw session JSONL file
app.post("/api/sessions/export-jsonl", async (c) => {
  const { sessionPath } = await c.req.json();
  if (!sessionPath) return c.json({ error: "sessionPath required" }, 400);
  try {
    const safePath = validateSessionPath(sessionPath);
    const jsonl = await readFile(safePath, "utf-8");
    return c.json({ jsonl });
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
    const safeDir = validateBrowsePath(dir.startsWith("~") ? join(homedir(), dir.slice(1)) : dir);
  } catch (e: any) {
    return c.json({ error: e.message }, 403);
  }

  const safeDir = (() => {
    try { return validateBrowsePath(dir.startsWith("~") ? join(homedir(), dir.slice(1)) : dir); }
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

// ==================== PI config files ====================

const PI_CONFIG_FILES = new Set(["settings", "models"]);
const PI_CONFIG_PATHS: Record<string, string> = {
  settings: join(HOME, ".pi", "agent", "settings.json"),
  models: join(HOME, ".pi", "agent", "models.json"),
};

async function safeReadJsonFile(filePath: string): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (e: any) {
    if (e.code === "ENOENT") return "{}";
    throw new Error(`Failed to read config: ${e.message}`);
  }
  try {
    JSON.parse(raw);
  } catch (e: any) {
    throw new Error(`Invalid JSON in ${filePath}: ${e.message}`);
  }
  return raw;
}

async function safeWriteJsonFile(filePath: string, content: string): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (e: any) {
    throw new Error(`Invalid JSON: ${e.message}`);
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("Config must be a JSON object");
  }
  const raw = JSON.stringify(parsed, null, 2) + "\n";
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, raw, "utf-8");
  await renameFs(tmp, filePath);
}

app.get("/api/pi-config/:file", async (c) => {
  const file = c.req.param("file");
  if (!PI_CONFIG_FILES.has(file)) {
    return c.json({ error: "Unknown config file" }, 400);
  }
  try {
    const content = await safeReadJsonFile(PI_CONFIG_PATHS[file]);
    return c.json({ content });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

app.put("/api/pi-config/:file", async (c) => {
  const file = c.req.param("file");
  if (!PI_CONFIG_FILES.has(file)) {
    return c.json({ error: "Unknown config file" }, 400);
  }
  let body: { content?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (typeof body.content !== "string") {
    return c.json({ error: "content string is required" }, 400);
  }
  try {
    await safeWriteJsonFile(PI_CONFIG_PATHS[file], body.content);
    return c.json({ success: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

// ==================== Extensions API ====================

const PI_SETTINGS_PATH = join(HOME, ".pi", "agent", "settings.json");
const PI_EXTENSIONS_DIR = join(HOME, ".pi", "agent", "extensions");

interface PiPackageEntry {
  source: string;
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
}

interface PiSettings {
  packages?: (string | PiPackageEntry)[];
  extensions?: string[];
  skills?: string[];
  [key: string]: unknown;
}

async function readPiSettings(): Promise<PiSettings> {
  try {
    const raw = await readFile(PI_SETTINGS_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writePiSettings(settings: PiSettings): Promise<void> {
  const raw = JSON.stringify(settings, null, 2) + "\n";
  await mkdir(dirname(PI_SETTINGS_PATH), { recursive: true });
  await writeFile(PI_SETTINGS_PATH, raw, "utf-8");
}

const MAX_README_LENGTH = 256_000;
const REGISTRY_FETCH_TIMEOUT_MS = 15_000;
const EXTENSION_CACHE_MAX_ENTRIES = 20;

/** Validate an npm package name or scoped npm package name. */
function isValidNpmPackageName(name: string): boolean {
  if (!name || typeof name !== "string") return false;
  if (name.length > 214) return false;
  if (name.startsWith(".") || name.startsWith("_")) return false;
  if (name.trim().toLowerCase() === "node_modules") return false;
  if (name.includes("/")) {
    const [scope, pkg, ...rest] = name.split("/");
    if (rest.length > 0) return false;
    if (!scope || !pkg) return false;
    if (!scope.startsWith("@")) return false;
    const scopeBody = scope.slice(1);
    return /^[a-zA-Z0-9_.-]+$/.test(scopeBody) && /^[a-zA-Z0-9_.~-]+$/.test(pkg);
  }
  return /^[a-zA-Z0-9_.~-]+$/.test(name);
}

/** Validate `npm:<pkg>` or just package name. */
function parseNpmSource(source: string): { ok: true; name: string } | { ok: false } {
  const name = source.startsWith("npm:") ? source.slice(4) : source;
  if (isValidNpmPackageName(name)) return { ok: true, name };
  return { ok: false };
}

/** Ensure a local extension path resolves inside PI_EXTENSIONS_DIR. */
function safeLocalExtensionPath(inputPath: string): string | null {
  let cleaned = inputPath;
  // Strip optional leading +/- prefix
  cleaned = cleaned.replace(/^[+-]/, "");
  // Strip optional legacy extensions/ prefix
  cleaned = cleaned.replace(/^extensions\//, "");
  // Reject absolute paths or traversal attempts
  if (isAbsolute(cleaned)) return null;
  if (/\.\.(\/|\\|$)/.test(cleaned) || cleaned.includes("/../")) return null;
  const resolved = resolve(join(PI_EXTENSIONS_DIR, cleaned));
  const base = resolve(PI_EXTENSIONS_DIR);
  const rel = relative(base, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return resolved;
}

function normalizeLicense(input: unknown): string | null {
  if (typeof input === "string") return input || null;
  if (input && typeof input === "object" && "type" in input && typeof (input as any).type === "string") {
    return (input as any).type || null;
  }
  return null;
}

const ALLOWED_URL_SCHEMES = new Set(["http", "https", "git", "git+https", "git+ssh"]);

function normalizeUrl(input: unknown): string | null {
  let url: string | null = null;
  if (typeof input === "string" && input.trim()) {
    url = input.trim();
  } else if (input && typeof input === "object" && "url" in input && typeof (input as any).url === "string") {
    url = (input as any).url.trim();
  }
  if (!url) return null;
  const colon = url.indexOf(":");
  if (colon < 0) return null;
  const scheme = url.slice(0, colon).toLowerCase();
  if (!ALLOWED_URL_SCHEMES.has(scheme)) return null;
  return url.replace(/^git\+/, "");
}

function normalizeRepository(input: unknown): { type: string; url: string } | null {
  const url = normalizeUrl(input);
  if (!url) return null;
  const type = (input && typeof input === "object" && typeof (input as any).type === "string")
    ? (input as any).type
    : "git";
  return { type, url };
}

function normalizeAuthor(input: unknown): { name: string; email?: string; url?: string } | null {
  if (!input) return null;
  if (typeof input === "string") {
    const match = input.match(/^([^<(]+)/);
    const name = match ? match[1].trim() : input.trim();
    if (!name) return null;
    const emailMatch = input.match(/<([^>]+)>/);
    const urlMatch = input.match(/\(([^)]+)\)/);
    return { name, email: emailMatch?.[1], url: urlMatch?.[1] };
  }
  if (typeof input === "object" && "name" in input && typeof (input as any).name === "string") {
    return {
      name: (input as any).name,
      email: typeof (input as any).email === "string" ? (input as any).email : undefined,
      url: typeof (input as any).url === "string" ? (input as any).url : undefined,
    };
  }
  return null;
}

interface InstalledExtension {
  id: string;
  name: string;
  source: string;
  type: "package" | "local";
  enabled: boolean;
  version?: string;
  description?: string;
  path?: string;
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
}

// List installed extensions
app.get("/api/extensions", async (c) => {
  const settings = await readPiSettings();
  const extensions: InstalledExtension[] = [];

  // Parse packages from settings
  const packages = settings.packages || [];
  for (const entry of packages) {
    const source = typeof entry === "string" ? entry : entry.source;
    const filters = typeof entry === "string" ? {} : { extensions: entry.extensions, skills: entry.skills, prompts: entry.prompts, themes: entry.themes };
    const name = source.startsWith("npm:") ? source.slice(4) : source;

    // Reject malformed package sources to prevent path traversal
    if (!isValidNpmPackageName(name)) continue;

    // Check if any extensions are disabled (prefixed with -)
    const extFilters = filters.extensions || [];
    const hasDisabled = extFilters.some((f: string) => f.startsWith("-"));
    const hasEnabled = extFilters.some((f: string) => f.startsWith("+"));

    // Try to read package.json from the npm install dir
    let version: string | undefined;
    let description: string | undefined;
    let pkgPath: string | undefined;
    try {
      const pkgName = name.includes("/") ? name : name;
      // Resolve the actual installed path
      const possiblePaths = [
        join(HOME, ".pi", "agent", "npm", "node_modules", pkgName, "package.json"),
      ];
      for (const pp of possiblePaths) {
        if (existsSync(pp)) {
          const pkgJson = JSON.parse(await readFile(pp, "utf-8"));
          version = pkgJson.version;
          description = pkgJson.description;
          pkgPath = join(pp, "..");
          break;
        }
      }
    } catch {}

    extensions.push({
      id: source,
      name,
      source,
      type: "package",
      enabled: !hasDisabled || hasEnabled,
      version,
      description,
      path: pkgPath,
      extensions: filters.extensions,
      skills: filters.skills,
      prompts: filters.prompts,
      themes: filters.themes,
    });
  }

  // Parse local extensions from settings.extensions
  const localExts = settings.extensions || [];
  for (const ext of localExts) {
    const isDisabled = ext.startsWith("-");
    const isEnabled = ext.startsWith("+");
    const cleanPath = ext.replace(/^[+-]/, "");
    const safePath = safeLocalExtensionPath(cleanPath);
    if (!safePath) continue;
    const name = cleanPath.split("/").pop() || cleanPath;

    extensions.push({
      id: `local:${cleanPath}`,
      name,
      source: cleanPath,
      type: "local",
      enabled: isEnabled || !isDisabled,
      path: safePath,
    });
  }

  // Also scan local extensions directory for auto-discovered extensions
  try {
    if (existsSync(PI_EXTENSIONS_DIR)) {
      const entries = readdirSync(PI_EXTENSIONS_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "__tests__") continue;
        const extPath = entry.isDirectory()
          ? join(PI_EXTENSIONS_DIR, entry.name, "index.ts")
          : join(PI_EXTENSIONS_DIR, entry.name);
        if (!entry.isDirectory() && !entry.name.endsWith(".ts") && !entry.name.endsWith(".js")) continue;
        const localId = `local:${entry.isDirectory() ? `extensions/${entry.name}` : `extensions/${entry.name}`}`;
        // Skip if already listed from settings
        if (extensions.some(e => e.id === localId || e.path === extPath || e.path === join(PI_EXTENSIONS_DIR, entry.name))) continue;

        let description: string | undefined;
        let version: string | undefined;
        try {
          const pkgJsonPath = join(PI_EXTENSIONS_DIR, entry.name, "package.json");
          if (existsSync(pkgJsonPath)) {
            const pkgJson = JSON.parse(await readFile(pkgJsonPath, "utf-8"));
            description = pkgJson.description;
            version = pkgJson.version;
          }
        } catch {}

        extensions.push({
          id: localId,
          name: entry.name.replace(/\.(ts|js)$/, ""),
          source: entry.isDirectory() ? `extensions/${entry.name}` : `extensions/${entry.name}`,
          type: "local",
          enabled: true, // auto-discovered = enabled by default
          version,
          description,
          path: join(PI_EXTENSIONS_DIR, entry.name),
        });
      }
    }
  } catch {}

  return c.json({ extensions });
});

// Toggle extension enabled/disabled
app.patch("/api/extensions/:id/toggle", async (c) => {
  let body: { enabled?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (typeof body?.enabled !== "boolean") {
    return c.json({ error: "enabled boolean is required" }, 400);
  }
  const rawId = decodeURIComponent(c.req.param("id"));
  const { enabled } = body;
  const settings = await readPiSettings();

  // Handle package entries (validate npm source shape when matched)
  if (!rawId.startsWith("local:")) {
    const parsed = parseNpmSource(rawId);
    if (!parsed.ok) return c.json({ error: "Invalid extension id" }, 400);
    const packages = settings.packages || [];
    let found = false;
    const updated = packages.map(entry => {
      const source = typeof entry === "string" ? entry : entry.source;
      if (source === rawId) {
        found = true;
        if (typeof entry === "string") {
          // Convert to object form with filter
          return { source, extensions: enabled ? ["+index.ts"] : ["-index.ts"] };
        } else {
          const extFilters = entry.extensions || [];
          if (enabled) {
            // Replace - with + or add +
            const hasAny = extFilters.length > 0;
            return { ...entry, extensions: hasAny ? extFilters.map((f: string) => f.startsWith("-") ? `+${f.slice(1)}` : f) : ["+index.ts"] };
          } else {
            const hasAny = extFilters.length > 0;
            return { ...entry, extensions: hasAny ? extFilters.map((f: string) => f.startsWith("+") ? `-${f.slice(1)}` : f.startsWith("-") ? f : `-${f}`) : ["-index.ts"] };
          }
        }
      }
      return entry;
    });

    if (found) {
      settings.packages = updated;
      await writePiSettings(settings);
      return c.json({ success: true, restartRequired: true });
    }
  }

  // Handle local extension entries
  if (rawId.startsWith("local:")) {
    const extPath = rawId.slice(6);
    if (!safeLocalExtensionPath(extPath)) {
      return c.json({ error: "Invalid local extension path" }, 400);
    }
    const localExts = settings.extensions || [];
    const existingIndex = localExts.findIndex((e: string) => {
      const clean = e.replace(/^[+-]/, "");
      return clean === extPath;
    });

    if (existingIndex >= 0) {
      localExts[existingIndex] = enabled ? `+${extPath}` : `-${extPath}`;
    } else {
      localExts.push(enabled ? `+${extPath}` : `-${extPath}`);
    }
    settings.extensions = localExts;
    await writePiSettings(settings);
    return c.json({ success: true, restartRequired: true });
  }

  return c.json({ error: "Extension not found" }, 404);
});

// Install an extension via pi install
app.post("/api/extensions/install", async (c) => {
  let body: { source?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const { source } = body;
  if (!source || typeof source !== "string" || !source.startsWith("npm:")) {
    return c.json({ error: "source is required and must be npm:<package-name>" }, 400);
  }
  const parsed = parseNpmSource(source);
  if (!parsed.ok) {
    return c.json({ error: "Invalid npm package name" }, 400);
  }

  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const envPath = [
    join(home, ".bun/bin"),
    join(home, ".nvm/versions/node/v22.22.2/bin"),
    ...(platform() === "win32" ? [] : ["/usr/local/bin", "/usr/bin", "/bin"]),
    process.env.PATH || "",
  ].join(delimiter);

  const piBin = platform() === "win32" ? "pi.cmd" : "pi";
  try {
    const proc = Bun.spawn([piBin, "install", source], {
      cwd: HOME,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PATH: envPath },
    });

    const timeoutMs = 60_000;
    const exitCode = await Promise.race([
      proc.exited,
      new Promise<null>((_, reject) =>
        setTimeout(() => { proc.kill(); reject(new Error("Installation timed out")); }, timeoutMs)
      ),
    ]);

    const stderr = await new Response(proc.stderr).text();
    if (exitCode !== 0) {
      return c.json({ error: stderr.trim() || `pi install exited with code ${exitCode}` }, 500);
    }

    return c.json({ success: true, restartRequired: true });
  } catch (err: any) {
    console.warn("[extensions] pi install failed", err);
    return c.json({ error: err.message || "Failed to install extension" }, 500);
  }
});

// Uninstall an extension via pi remove
app.post("/api/extensions/uninstall", async (c) => {
  let body: { source?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const { source } = body;
  if (!source || typeof source !== "string" || !source.startsWith("npm:")) {
    return c.json({ error: "source is required and must be npm:<package-name>" }, 400);
  }
  const parsed = parseNpmSource(source);
  if (!parsed.ok) {
    return c.json({ error: "Invalid npm package name" }, 400);
  }

  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const envPath = [
    join(home, ".bun/bin"),
    join(home, ".nvm/versions/node/v22.22.2/bin"),
    ...(platform() === "win32" ? [] : ["/usr/local/bin", "/usr/bin", "/bin"]),
    process.env.PATH || "",
  ].join(delimiter);

  const piBin = platform() === "win32" ? "pi.cmd" : "pi";
  try {
    const proc = Bun.spawn([piBin, "remove", source], {
      cwd: HOME,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PATH: envPath },
    });

    const timeoutMs = 30_000;
    const exitCode = await Promise.race([
      proc.exited,
      new Promise<null>((_, reject) =>
        setTimeout(() => { proc.kill(); reject(new Error("Removal timed out")); }, timeoutMs)
      ),
    ]);

    const stderr = await new Response(proc.stderr).text();
    if (exitCode !== 0) {
      return c.json({ error: stderr.trim() || `pi remove exited with code ${exitCode}` }, 500);
    }

    return c.json({ success: true, restartRequired: true });
  } catch (err: any) {
    console.warn("[extensions] pi remove failed", err);
    return c.json({ error: err.message || "Failed to remove extension" }, 500);
  }
});

// Restart all running PI agent processes (and any external `pi` CLI instances).
app.post("/api/extensions/restart", async (c) => {
  try {
    // Stop agents managed by this PI Web instance
    await stopAllAgents();
    // Kill any other `pi` processes spawned elsewhere on the machine
    await killExternalPiProcesses();
    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ error: err.message || "Failed to restart PI instances" }, 500);
  }
});

/**
 * Best-effort kill of external `pi` CLI processes across platforms.
 * NOTE: This intentionally kills any process named `pi` on the machine,
 * matching the user-approved restart behavior. Hardening to exclude the
 * current process would require tracking child PIDs, which is not available.
 */
async function killExternalPiProcesses(): Promise<void> {
  const isWin = platform() === "win32";
  const commands: string[][] = isWin
    ? [["taskkill", "/F", "/IM", "pi.cmd"], ["taskkill", "/F", "/IM", "pi.exe"]]
    : [["pkill", "-x", "pi"]];

  await Promise.all(commands.map((args) => new Promise<void>((resolve) => {
    try {
      const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
      const timeout = setTimeout(() => { try { proc.kill(); } catch {} resolve(); }, 3000);
      proc.exited.then(() => { clearTimeout(timeout); resolve(); }).catch(() => resolve());
    } catch {
      resolve();
    }
  })));
}

// Search npm for pi-compatible extensions
// ── Extension search cache ──────────────────────────────────
// Caches npm search + download data so sort changes don't re-hit npm APIs.
// Keyed by search query; TTL = 5 minutes.
interface SearchCacheEntry {
  packages: Array<{
    name: string;
    version: string;
    description: string;
    keywords: string[];
    date?: string;
    publisher?: string;
    links: Record<string, string>;
    pi?: Record<string, unknown>;
    downloads: number;
    weeklyDownloads: number;
  }>;
  fetchedAt: number;
  version: number;
}
const extensionSearchCache = new Map<string, SearchCacheEntry>();
const EXTENSION_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const EXTENSION_CACHE_VERSION = 2; // bump when download-count semantics change

async function fetchExtensionSearchResults(query: string): Promise<SearchCacheEntry["packages"]> {
  const cacheKey = query || "__default__";
  const cached = extensionSearchCache.get(cacheKey);
  const hasStaleData = cached && (
    cached.version !== EXTENSION_CACHE_VERSION ||
    !cached.packages.every(p => typeof p.weeklyDownloads === "number" && typeof p.downloads === "number")
  );
  if (cached && !hasStaleData && Date.now() - cached.fetchedAt < EXTENSION_CACHE_TTL_MS) {
    return cached.packages;
  }

  // Query the npm registry search API directly so we can retrieve more than
  // the ~50 results the `npm search` CLI is capped at. We search both the
  // pi-package and pi-extension keywords and merge/dedupe the results.
  const rawQuery = query.trim();
  const buildUrl = (keyword: string) => {
    const text = rawQuery ? `keywords:${keyword}+${encodeURIComponent(rawQuery)}` : `keywords:${keyword}`;
    return `https://registry.npmjs.org/-/v1/search?text=${text}&size=250`;
  };

  const searchRes = await Promise.all([
    fetch(buildUrl("pi-package"), { signal: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS) }),
    fetch(buildUrl("pi-extension"), { signal: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS) }),
  ]);

  const seenResults = new Set<string>();
  const filtered: Array<{ package: any; downloads?: { monthly?: number; weekly?: number } }> = [];
  for (const res of searchRes) {
    if (!res.ok) {
      console.warn(`[extensions] registry search failed: ${res.status} ${res.statusText}`);
      continue;
    }
    const data = await res.json() as { objects?: Array<{ package: any; downloads?: { monthly?: number; weekly?: number } }> };
    for (const obj of data.objects || []) {
      const pkg = obj.package;
      if (!pkg || seenResults.has(pkg.name)) continue;
      if (!pkg.keywords?.includes("pi-package") && !pkg.keywords?.includes("pi-extension")) continue;
      seenResults.add(pkg.name);
      filtered.push({ package: pkg, downloads: obj.downloads });
    }
  }

  // If a free-text query was supplied, keep only results whose name or a
  // keyword contains the query. This keeps broad registry matches (e.g.
  // descriptions) from overwhelming exact package-name searches.
  const q = query.trim().toLowerCase();
  if (q) {
    const kept = filtered.filter(({ package: pkg }: any) => {
      const name = String(pkg.name || "").toLowerCase();
      if (name.includes(q)) return true;
      const keywords: string[] = pkg.keywords || [];
      return keywords.some((k: string) => k.toLowerCase().includes(q));
    });
    filtered.length = 0;
    filtered.push(...kept);
  }

  // Use the download counts already returned by the npm registry search API
  // (monthly / weekly). This avoids the npm downloads API rate limits that
  // hit when we bulk/individual fetch hundreds of packages.
  const packages = filtered.map(({ package: pkg, downloads }) => ({
    name: pkg.name,
    version: pkg.version,
    description: pkg.description || "",
    keywords: (pkg.keywords || []).filter((k: string) => k !== "pi-package" && k !== "pi-extension"),
    date: pkg.date,
    publisher: pkg.publisher?.username,
    links: pkg.links || {},
    pi: pkg.pi || undefined,
    downloads: downloads?.monthly ?? 0,
    weeklyDownloads: downloads?.weekly ?? 0,
  }));

  // Store in cache, capping the total number of cached queries
  if (extensionSearchCache.size >= EXTENSION_CACHE_MAX_ENTRIES) {
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [key, entry] of extensionSearchCache) {
      if (entry.fetchedAt < oldestAt) {
        oldestAt = entry.fetchedAt;
        oldestKey = key;
      }
    }
    if (oldestKey) extensionSearchCache.delete(oldestKey);
  }
  extensionSearchCache.set(cacheKey, { packages, fetchedAt: Date.now(), version: EXTENSION_CACHE_VERSION });

  return packages;
}

// Most downloaded = monthly npm downloads
// Recently uploaded = package publish date (newest first)

app.get("/api/extensions/search", async (c) => {
  const query = c.req.query("q") || "";
  const sort = c.req.query("sort") || "mostDownloaded"; // mostDownloaded | recentlyUploaded | name
  try {
    // Fetch (or read from cache) — heavy npm API calls only happen once per query per 5 min
    const packages = await fetchExtensionSearchResults(query);

    // Sort a copy so the cache stays pristine
    const sorted = [...packages];
    switch (sort) {
      case "mostDownloaded":
      case "popular":
        sorted.sort((a, b) => b.downloads - a.downloads);
        break;
      case "recentlyUploaded":
      case "newest":
        sorted.sort((a, b) => {
          const da = a.date ? new Date(a.date).getTime() : 0;
          const db = b.date ? new Date(b.date).getTime() : 0;
          return db - da;
        });
        break;
      case "name":
        sorted.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case "trending":
      default:
        sorted.sort((a, b) => (b.weeklyDownloads || 0) - (a.weeklyDownloads || 0));
        break;
    }

    return c.json({ packages: sorted });
  } catch (err: any) {
    return c.json({ error: err.message || "Search failed" }, 500);
  }
});

// ── Extension package detail ──────────────────────────────
app.get("/api/extensions/detail", async (c) => {
  const name = c.req.query("name");
  if (!name) return c.json({ error: "name query required" }, 400);

  try {
    const registryUrl = `https://registry.npmjs.org/${encodeURIComponent(name)}`;
    const res = await fetch(registryUrl, { signal: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      if (res.status === 404) return c.json({ error: "Package not found" }, 404);
      return c.json({ error: `Registry returned ${res.status}` }, 502);
    }

    const data = await res.json() as any;
    if (data.error) return c.json({ error: data.error }, 404);

    const latestVersion = data["dist-tags"]?.latest;
    const latest = latestVersion ? data.versions?.[latestVersion] : null;

    // Build version history from time map (skip created/modified entries)
    const timeMap = data.time || {};
    const versions: Array<{ version: string; date: string }> = [];
    for (const [ver, date] of Object.entries(timeMap)) {
      if (ver === "created" || ver === "modified") continue;
      versions.push({ version: ver, date: date as string });
    }
    versions.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    const detail = {
      name: data.name,
      description: data.description || latest?.description || "",
      latestVersion,
      license: normalizeLicense(latest?.license) || normalizeLicense(data.license),
      homepage: normalizeUrl(latest?.homepage) || normalizeUrl(data.homepage),
      repository: normalizeRepository(latest?.repository) || normalizeRepository(data.repository),
      author: normalizeAuthor(latest?.author) || normalizeAuthor(data.author),
      maintainers: (data.maintainers || []).map((m: any) => ({
        name: m.name,
        email: m.email || null,
      })),
      keywords: latest?.keywords || data.keywords || [],
      pi: latest?.pi || null,
      dependencies: latest?.dependencies ? Object.keys(latest.dependencies) : [],
      peerDependencies: latest?.peerDependencies ? Object.keys(latest.peerDependencies) : [],
      readme: typeof data.readme === "string" && data.readme.length <= MAX_README_LENGTH
        ? data.readme
        : (typeof data.readme === "string" ? data.readme.slice(0, MAX_README_LENGTH) : null),
      versions: versions.slice(0, 20),
      created: timeMap.created || null,
      modified: timeMap.modified || null,
      downloads: 0 as number,
      weeklyDownloads: 0 as number,
    };

    // Enrich with download counts
    try {
      const [dlRes, wkRes] = await Promise.all([
        fetch(`https://api.npmjs.org/downloads/point/last-year/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS) }),
        fetch(`https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS) }),
      ]);
      if (dlRes.ok) {
        const dlData = await dlRes.json() as { downloads?: number; package?: string } | Record<string, { downloads: number }>;
        if ("downloads" in dlData && typeof dlData.downloads === "number") {
          detail.downloads = dlData.downloads;
        } else {
          const entry = (dlData as Record<string, { downloads: number }>)[name];
          if (entry?.downloads !== undefined) detail.downloads = entry.downloads;
        }
      }
      if (wkRes.ok) {
        const wkData = await wkRes.json() as { downloads?: number; package?: string } | Record<string, { downloads: number }>;
        if ("downloads" in wkData && typeof wkData.downloads === "number") {
          detail.weeklyDownloads = wkData.downloads;
        } else {
          const entry = (wkData as Record<string, { downloads: number }>)[name];
          if (entry?.downloads !== undefined) detail.weeklyDownloads = entry.downloads;
        }
      }
    } catch {}

    return c.json({ detail });
  } catch (err: any) {
    return c.json({ error: err.message || "Failed to fetch package detail" }, 500);
  }
});

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
