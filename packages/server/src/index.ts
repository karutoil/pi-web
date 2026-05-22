import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { createBunWebSocket } from "hono/bun";
import type { ServerWebSocket } from "bun";
import { join, basename } from "node:path";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { addProject, removeProject, listProjects, getProject, touchProject } from "./db";
import { listProjectSessions, getSessionDetail } from "./pi-sessions";
import { PIAgent } from "./pi-agent";
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

// Health
app.get("/api/health", (c) => c.json({ status: "ok", time: Date.now() }));

// ==================== WebSocket ====================

// Map of active agent sessions: ws -> PIAgent
const activeAgents = new Map<ServerWebSocket, PIAgent>();

app.get(
  "/ws/chat",
  upgradeWebSocket((c) => {
    const projectId = c.req.query("projectId");
    const sessionPath = c.req.query("sessionPath");
    const provider = c.req.query("provider");
    const model = c.req.query("model");

    return {
      async onOpen(_event, ws) {
        try {
        const project = projectId ? getProject(projectId) : null;
        const cwd = project?.path || process.cwd();
        
        if (project) touchProject(project.id);

        const agent = new PIAgent({
          cwd,
          sessionPath: sessionPath || undefined,
          provider: provider || undefined,
          model: model || undefined,
        });

        agent.setHandler((msg) => {
          try {
            if (ws.readyState === 1) ws.send(JSON.stringify(msg));
          } catch (e) {
            console.error("Failed to send WS message:", e);
          }
        });

        // When PI exits unexpectedly, notify client and clean up
        agent.setExitHandler((code) => {
          const raw = (ws as any).raw as ServerWebSocket;
          if (raw && activeAgents.has(raw)) {
            try {
              if (raw.readyState === 1) {
                raw.send(JSON.stringify({
                  type: "error",
                  message: `PI agent exited (code ${code}). Reconnect to restore.`,
                }));
              }
            } catch {}
            activeAgents.delete(raw);
          }
        });

        try {
          await agent.start();
          activeAgents.set((ws as any).raw as ServerWebSocket, agent);
          
          // Send initial state
          setTimeout(() => agent.getState(), 300);
        } catch (err: any) {
          console.error("Failed to start agent:", err);
          try { ws.send(JSON.stringify({ type: "error", message: `Failed to start agent: ${err.message}` })); } catch {}
        }
        } catch (fatalErr: any) {
          console.error("Fatal onOpen error:", fatalErr);
          try { ws.send(JSON.stringify({ type: "error", message: "Internal server error" })); } catch {}
        }
      },

      onMessage(event, ws) {
        const agent = activeAgents.get((ws as any).raw as ServerWebSocket);
        if (!agent) return;

        try {
          const msg: WSClientMessage = JSON.parse(event.data as string);
          
          switch (msg.type) {
            case "prompt":
              agent.prompt(msg.message, msg.images);
              break;
            case "abort":
              agent.abort();
              break;
            case "steer":
              agent.steer(msg.message);
              break;
            case "follow_up":
              agent.followUp(msg.message);
              break;
            case "new_session":
              agent.newSession();
              break;
            case "set_model":
              agent.setModel(msg.provider, msg.modelId);
              break;
            case "set_thinking":
              agent.setThinking(msg.level);
              break;
            case "fork":
              agent.fork(msg.entryId);
              break;
            case "compact":
              agent.compact();
              break;
            case "get_state":
              agent.getState();
              break;
            case "get_available_models":
              agent.getAvailableModels();
              break;
            case "get_commands":
              agent.getCommands();
              break;
            case "get_fork_messages":
              agent.getForkMessages();
              break;
            case "get_session_stats":
              agent.getSessionStats();
              break;
            case "set_session_name":
              agent.setSessionName(msg.name);
              break;
            case "extension_ui_response":
              agent.extensionUIResponse(msg.id, {
                value: msg.value,
                confirmed: msg.confirmed,
                cancelled: msg.cancelled,
              });
              break;
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
          const agent = activeAgents.get(raw);
          if (agent) {
            agent.stop();
            activeAgents.delete(raw);
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

// Serve built client in production
app.use("/assets/*", serveStatic({ root: CLIENT_DIST }));
app.get("/*", async (c) => {
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
