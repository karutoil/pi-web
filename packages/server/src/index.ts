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
  const dir = c.req.query("dir") || homedir();
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

// Health
app.get("/api/health", (c) => c.json({ status: "ok", time: Date.now(), pool: getPoolStats() }));

// ==================== WebSocket ====================

// Map: raw ServerWebSocket -> agentKey (for routing messages)
const wsToAgent = new Map<ServerWebSocket, string>();

app.get(
  "/ws/chat",
  upgradeWebSocket((c) => {
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
              console.error("Failed to start agent:", err);
              try { ws.send(JSON.stringify({ type: "error", message: `Failed to start agent: ${err.message}` })); } catch {}
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
            case "extension_ui_response": agent.send({ type: "extension_ui_response", id: msg.id, value: msg.value, confirmed: msg.confirmed, cancelled: msg.cancelled }); break;
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
