import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { createBunWebSocket } from "hono/bun";
import type { ServerWebSocket } from "bun";
import { join, basename } from "node:path";
import { existsSync, statSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";

import { addProject, removeProject, listProjects, getProject, touchProject } from "./db";
import { listProjectSessions, getSessionDetail } from "./pi-sessions";
import { getOrCreateAgent, stopAllAgents, getPoolStats, lookupAgent, detachFromAgent } from "./pi-agent";
import { createTerminal, getTerminal, listTerminals, killTerminal } from "./pi-terminal";
import { getGitStatus, getGitDiff, gitStage, gitUnstage, gitCommit, gitLog, gitCheckout, gitDiscard, gitBranches, gitPush, gitPull, gitFetch, gitCreateBranch, gitDeleteBranch, gitRenameBranch, gitTags, gitCreateTag, gitDeleteTag, gitStashList, gitStashPush, gitStashPop, gitStashApply, gitStashDrop, gitAmend, gitCherryPick, gitRevert, gitResolveConflict, getGitDiffStats, gitDiffWithRef, gitShowCommit, gitLogSearch, gitBlame, gitRemotes, gitUnstageAll } from "./pi-git";
import type { WSClientMessage, WSServerMessage } from "@pi-web/shared";

const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>();

const app = new Hono();

// ==================== REST API ====================

// List projects
app.get("/api/projects", async (c) => {
  const projects = listProjects();
  return c.json({ projects });
});

// Add project
app.post("/api/projects", async (c) => {
  const body = await c.req.json();
  const { path, name } = body;
  
  if (!path || typeof path !== "string") {
    return c.json({ error: "Path is required" }, 400);
  }
  
  // Verify path exists
  if (!existsSync(path)) {
    return c.json({ error: "Directory does not exist" }, 400);
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

// Remove project
app.delete("/api/projects/:id", (c) => {
  const { id } = c.req.param();
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

// Get session detail (messages, entries)
app.get("/api/sessions/detail", async (c) => {
  const filePath = c.req.query("path");
  if (!filePath) return c.json({ error: "path query required" }, 400);
  
  const detail = await getSessionDetail(filePath);
  if (!detail) return c.json({ error: "Session not found" }, 404);
  
  return c.json({ session: detail });
});

// Delete session file
app.delete("/api/sessions/:path", async (c) => {
  const sessionPath = decodeURIComponent(c.req.param("path"));
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(sessionPath);
    return c.json({ success: true });
  } catch (e: any) {
    if (e.code === "ENOENT") return c.json({ error: "Session not found" }, 404);
    return c.json({ error: e.message }, 500);
  }
});

// Rename session
app.patch("/api/sessions/rename", async (c) => {
  const { sessionPath, name } = await c.req.json();
  if (!sessionPath || !name) return c.json({ error: "sessionPath and name required" }, 400);
  
  try {
    const { readFile: rf, writeFile } = await import("node:fs/promises");
    const content = await rf(sessionPath, "utf-8");
    const lines = content.trim().split("\n");
    // Append a session_info entry with the name
    const renameEntry = JSON.stringify({ type: "session_info", name, timestamp: new Date().toISOString() });
    const newContent = content.trim() + "\n" + renameEntry + "\n";
    await writeFile(sessionPath, newContent);
    return c.json({ success: true, name });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Browse filesystem directories
app.get("/api/fs/browse", async (c) => {
  let dir = c.req.query("dir") || homedir();
  // Expand ~ to home directory
  if (dir.startsWith("~")) dir = homedir() + dir.slice(1);
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

// ── Git API ──
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
  gitStage(cwd, path);
  return c.json({ success: true });
});

app.post("/api/git/unstage", async (c) => {
  const { cwd, path } = await c.req.json();
  if (!cwd || !path) return c.json({ error: "cwd and path required" }, 400);
  gitUnstage(cwd, path);
  return c.json({ success: true });
});

app.post("/api/git/commit", async (c) => {
  const { cwd, message } = await c.req.json();
  if (!cwd || !message) return c.json({ error: "cwd and message required" }, 400);
  const result = gitCommit(cwd, message);
  if (!result) return c.json({ error: "Commit failed" }, 500);
  return c.json({ success: true, result });
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
  return c.json({ success: true, result });
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
  return c.json({ success: true, result });
});

app.post("/api/git/pull", async (c) => {
  const { cwd } = await c.req.json();
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  const result = gitPull(cwd);
  return c.json({ success: true, result });
});

app.post("/api/git/fetch", async (c) => {
  const { cwd } = await c.req.json();
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  const result = gitFetch(cwd);
  return c.json({ success: true, result });
});

// Create / Delete / Rename branch
app.post("/api/git/branch/create", async (c) => {
  const { cwd, name, checkout } = await c.req.json();
  if (!cwd || !name) return c.json({ error: "cwd and name required" }, 400);
  const result = gitCreateBranch(cwd, name, checkout !== false);
  return c.json({ success: true, result });
});

app.post("/api/git/branch/delete", async (c) => {
  const { cwd, name } = await c.req.json();
  if (!cwd || !name) return c.json({ error: "cwd and name required" }, 400);
  const result = gitDeleteBranch(cwd, name);
  return c.json({ success: true, result });
});

app.post("/api/git/branch/rename", async (c) => {
  const { cwd, oldName, newName } = await c.req.json();
  if (!cwd || !oldName || !newName) return c.json({ error: "cwd, oldName, and newName required" }, 400);
  const result = gitRenameBranch(cwd, oldName, newName);
  return c.json({ success: true, result });
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
  return c.json({ success: true, result });
});

app.post("/api/git/tag/delete", async (c) => {
  const { cwd, name } = await c.req.json();
  if (!cwd || !name) return c.json({ error: "cwd and name required" }, 400);
  const result = gitDeleteTag(cwd, name);
  return c.json({ success: true, result });
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
  return c.json({ success: true, result });
});

app.post("/api/git/stash/pop", async (c) => {
  const { cwd, index } = await c.req.json();
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  const result = gitStashPop(cwd, index);
  return c.json({ success: true, result });
});

app.post("/api/git/stash/apply", async (c) => {
  const { cwd, index } = await c.req.json();
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  const result = gitStashApply(cwd, index);
  return c.json({ success: true, result });
});

app.post("/api/git/stash/drop", async (c) => {
  const { cwd, index } = await c.req.json();
  if (!cwd || index === undefined) return c.json({ error: "cwd and index required" }, 400);
  const result = gitStashDrop(cwd, index);
  return c.json({ success: true, result });
});

// Amend commit
app.post("/api/git/amend", async (c) => {
  const { cwd, message } = await c.req.json();
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  const result = gitAmend(cwd, message);
  return c.json({ success: true, result });
});

// Cherry-pick / Revert
app.post("/api/git/cherry-pick", async (c) => {
  const { cwd, hash } = await c.req.json();
  if (!cwd || !hash) return c.json({ error: "cwd and hash required" }, 400);
  const result = gitCherryPick(cwd, hash);
  return c.json({ success: true, result });
});

app.post("/api/git/revert", async (c) => {
  const { cwd, hash, noCommit } = await c.req.json();
  if (!cwd || !hash) return c.json({ error: "cwd and hash required" }, 400);
  const result = gitRevert(cwd, hash, noCommit);
  return c.json({ success: true, result });
});

// Merge conflict resolution
app.post("/api/git/resolve-conflict", async (c) => {
  const { cwd, path, strategy } = await c.req.json();
  if (!cwd || !path || !strategy) return c.json({ error: "cwd, path, and strategy required" }, 400);
  const result = gitResolveConflict(cwd, path, strategy);
  return c.json({ success: true, result });
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
  return c.json({ diff: gitShowCommit(cwd, hash) });
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
  return c.json({ success: true, result });
});

// Health
app.get("/api/health", (c) => c.json({ status: "ok", time: Date.now(), pool: getPoolStats() }));

// ==================== WebSocket ====================

// Map: raw ServerWebSocket -> agentKey (for routing messages)
const wsToAgent = new Map<ServerWebSocket, string>();
// Map: raw ServerWebSocket -> terminalId (for terminal WS routing)
const wsToTerminal = new Map<ServerWebSocket, string>();

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

    return {
      async onOpen(_event, ws) {
        try {
          const project = projectId ? getProject(projectId) : null;
          const cwd = project?.path || process.cwd();

          if (project) touchProject(project.id);

          const { agent, isNew } = getOrCreateAgent(cwd, sessionPath || null, provider || undefined, model || undefined, newSessionId || undefined);
          const raw = (ws as any).raw as ServerWebSocket;

          // Track which agent this WS belongs to
          const agentKey = `${cwd}:${sessionPath || newSessionId || "__new__"}`;
          wsToAgent.set(raw, agentKey);

          // Attach this client to the pooled agent
          agent.attach(raw);

          // If agent is new, start it
          if (isNew) {
            try {
              await agent.start();
            } catch (err: any) {
              console.error("Failed to start agent:", err.message || err);
              try { if (ws.readyState === 1) ws.send(JSON.stringify({ type: "error", message: `Failed to start agent: ${err.message}` })); } catch {}
            }
          }
        } catch (fatalErr: any) {
          console.error("Fatal onOpen error:", fatalErr);
          try { ws.send(JSON.stringify({ type: "error", message: "Internal server error" })); } catch {}
        }
      },

      onMessage(event, ws) {
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
            case "steer": agent.send({ type: "steer", message: msg.message }); break;
            case "follow_up": agent.send({ type: "follow_up", message: msg.message }); break;
            case "new_session": agent.send({ type: "new_session" }); break;
            case "set_model": agent.send({ type: "set_model", provider: msg.provider, modelId: msg.modelId }); break;
            case "set_thinking": agent.send({ type: "set_thinking_level", level: msg.level }); break;
            case "fork": agent.send({ type: "fork", entryId: msg.entryId }); break;
            case "compact": agent.send({ type: "compact" }); break;
            case "get_state": agent.send({ type: "get_state" }); break;
            case "get_available_models": agent.send({ type: "get_available_models" }); break;
            case "get_commands": agent.send({ type: "get_commands" }); break;
            case "get_fork_messages": agent.send({ type: "get_fork_messages" }); break;
            case "get_session_stats": agent.send({ type: "get_session_stats" }); break;
            case "set_session_name": agent.send({ type: "set_session_name", name: msg.name }); break;
            case "extension_ui_response": agent.send({ type: "extension_ui_response", id: msg.id, value: msg.value, confirmed: msg.confirmed, cancelled: msg.cancelled, templates: msg.templates, behaviorOverrides: msg.behaviorOverrides, runInBackground: msg.runInBackground }); break;
            case "delete_session": {
              const sessionId = msg.sessionId;
              const proj = projectId ? getProject(projectId) : null;
              if (proj) {
                listProjectSessions(proj.path).then(list => {
                  const target = list.find(s => s.id === sessionId);
                  if (target) {
                    import("node:fs/promises").then(({ unlink }) => unlink(target.filePath))
                      .then(() => { if (raw.readyState === 1) raw.send(JSON.stringify({ type: "session_deleted", sessionId })); })
                      .catch((e: any) => { if (raw.readyState === 1) raw.send(JSON.stringify({ type: "error", message: `Failed to delete: ${e.message}` })); });
                  }
                });
              }
              break;
            }
            case "rename_session": {
              const { sessionId, name } = msg;
              const proj2 = projectId ? getProject(projectId) : null;
              if (proj2) {
                listProjectSessions(proj2.path).then(list => {
                  const target = list.find(s => s.id === sessionId);
                  if (target) {
                    import("node:fs/promises").then(({ readFile: rf, writeFile: wf }) =>
                      rf(target.filePath, "utf-8").then(content => {
                        const renameEntry = JSON.stringify({ type: "session_info", name, timestamp: new Date().toISOString() });
                        return wf(target.filePath, content.trim() + "\n" + renameEntry + "\n");
                      })
                    ).then(() => {
                      if (raw.readyState === 1) raw.send(JSON.stringify({ type: "session_renamed", sessionId, name }));
                    }).catch((e: any) => {
                      if (raw.readyState === 1) raw.send(JSON.stringify({ type: "error", message: `Failed to rename: ${e.message}` }));
                    });
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

// SPA fallback — serve index.html for any unmatched route
app.get("*", async (c) => {
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

export default {
  port: 3069,
  fetch: app.fetch,
  websocket,
};
