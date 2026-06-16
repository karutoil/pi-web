#!/usr/bin/env bun
/**
 * PI Web automated screenshot harness.
 *
 * Captures PNGs of the main UI states:
 *   1. First-run empty state
 *   2. Add-project modal
 *   3. Project selected, no session
 *   4. Project + session selected (chat)
 *   5. Each workspace panel opened individually
 *   6. All workspace panels opened together
 *
 * Run with a clean HOME so the real ~/.pi-web database is untouched.
 * The harness injects a stub WebSocket that pretends to be a connected
 * PI agent, so no PI binary / API key is required.
 */

import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve, normalize } from "node:path";
import { chromium, type Browser, type Page } from "playwright";

// ─── Configuration ───────────────────────────────────────────────────────────

async function getFreePort(): Promise<number> {
  const net = await import("node:net");
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as { port: number };
      srv.close(() => resolve(addr.port));
    });
    srv.on("error", reject);
  });
}

const SERVER_PORT = process.env.SCREENSHOT_PORT ? parseInt(process.env.SCREENSHOT_PORT, 10) : await getFreePort();
const CLIENT_URL = `http://localhost:${SERVER_PORT}`;
const SCREENSHOTS_DIR = process.env.SCREENSHOTS_DIR ?? join(process.cwd(), "screenshots");
const SKIP_BUILD = process.env.SKIP_BUILD === "1";
const VIEWPORT = { width: 1920, height: 1080 };

const PROJECT_NAME = "Demo Project";
const SESSION_NAME = "Welcome session";

const SIDEBAR_PANELS = ["preview", "git", "files", "extensions", "terminal"] as const;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(url: string, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return;
    } catch {}
    await sleep(300);
  }
  throw new Error(`Server did not become ready at ${url}`);
}

// ─── Project / session seeding ───────────────────────────────────────────────

function seedProjectDir(projectPath: string) {
  mkdirSync(projectPath, { recursive: true });

  // Some realistic files for the file tree / outline.
  writeFileSync(
    join(projectPath, "README.md"),
    "# Demo Project\n\nThis is a sample project used for PI Web screenshots.\n",
  );
  mkdirSync(join(projectPath, "src"), { recursive: true });
  writeFileSync(
    join(projectPath, "src", "index.ts"),
    'export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n',
  );

  // Initialise git so the Git panel has something to render.
  const git = (cmd: string) => {
    const result = Bun.spawnSync(["bash", "-c", cmd], { cwd: projectPath });
    if (result.exitCode !== 0) {
      console.warn(`git setup warning: ${new TextDecoder().decode(result.stderr)}`);
    }
  };
  git("git init -q");
  git("git config user.email 'screenshots@pi.dev'");
  git("git config user.name 'PI Screenshots'");
  git("git add .");
  git("git commit -q -m 'initial commit'");
}

async function addProject(projectPath: string, serverUrl: string) {
  const res = await fetch(`${serverUrl}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: projectPath, name: PROJECT_NAME }),
  });
  if (!res.ok) throw new Error(`Failed to add project: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { project: { id: string } };
  return data.project.id;
}

function sanitizeProjectPath(p: string): string {
  // Mirrors packages/server/src/pi-sessions.ts sanitizePath.
  const abs = resolve(normalize(p));
  let s = abs.replace(/^[\\/]/, "").replace(/[\\/]$/g, "");
  s = s.replace(/[\\/:]/g, "-");
  return `--${s || "root"}--`;
}

async function seedSession(homeDir: string, projectPath: string, projectId: string, serverUrl: string) {
  // The /api/sessions/detail endpoint only accepts files inside the global
  // ~/.pi/agent/sessions/<sanitized-project-path> directory, so store the demo
  // session there instead of in the project-local .pi/sessions folder.
  const sessionsDir = join(homeDir, ".pi", "agent", "sessions", sanitizeProjectPath(projectPath));
  mkdirSync(sessionsDir, { recursive: true });

  const sessionFile = join(sessionsDir, "welcome.jsonl");
  const now = new Date().toISOString();
  const sessionId = "welcome-session";

  const lines = [
    JSON.stringify({
      type: "session",
      id: sessionId,
      timestamp: now,
      version: 1,
      cwd: projectPath,
    }),
    JSON.stringify({
      type: "message",
      id: "msg-user-1",
      timestamp: now,
      message: {
        role: "user",
        content: "Explain the project structure",
        timestamp: now,
      },
    }),
    JSON.stringify({
      type: "message",
      id: "msg-assistant-1",
      timestamp: now,
      message: {
        role: "assistant",
        content:
          "This demo project contains a `README.md` and a small `src/index.ts` module. " +
          "You can ask PI to read files, edit code, run tests, or manage git from the workspace panels.",
        timestamp: now,
        model: "claude-sonnet-4",
      },
    }),
    JSON.stringify({
      type: "session_info",
      name: SESSION_NAME,
      timestamp: now,
    }),
  ];

  writeFileSync(sessionFile, lines.join("\n") + "\n");

  // Create a terminal so the Terminal panel has content to show.
  const termRes = await fetch(`${serverUrl}/api/terminals`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: "screenshot-terminal",
      projectId,
      cwd: projectPath,
      name: "Demo shell",
    }),
  });
  if (!termRes.ok) console.warn(`Failed to create terminal: ${termRes.status}`);

  return sessionFile;
}

// ─── Playwright helpers ──────────────────────────────────────────────────────

function injectMockWebSocket(page: Page, sessionFile: string) {
  return page.addInitScript((file: string) => {
    const RealWS = window.WebSocket;
    if (!RealWS) return;

    class MockWebSocket extends EventTarget {
      url: string;
      readyState: number;
      CONNECTING = 0;
      OPEN = 1;
      CLOSING = 2;
      CLOSED = 3;
      bufferedAmount = 0;
      private openTimer: ReturnType<typeof setTimeout> | null = null;
      private state = {
        isStreaming: false,
        isCompacting: false,
        sessionFile: file,
        sessionId: file.split("/").pop()?.replace(".jsonl", "") || "demo",
        sessionName: "Welcome session",
        model: "claude-sonnet-4",
        thinkingLevel: "off",
        messageCount: 2,
        pendingMessageCount: 0,
        steering: [],
        followUp: [],
      };

      constructor(url: string) {
        super();
        this.url = url;
        this.readyState = this.CONNECTING;
        console.log("[mock ws] constructing", url);
        this.openTimer = setTimeout(() => {
          this.readyState = this.OPEN;
          console.log("[mock ws] open");
          if (this.onopen) this.onopen({ target: this } as any);
          this.dispatchEvent(new Event("open"));
          this.emit({ type: "state", data: this.state });
        }, 40);
      }

      private emit(obj: unknown) {
        const data = JSON.stringify(obj);
        const ev = new MessageEvent("message", { data });
        if (this.onmessage) this.onmessage(ev);
        this.dispatchEvent(ev);
      }

      send(raw: unknown) {
        try {
          const msg = typeof raw === "string" ? JSON.parse(raw) : raw;
          switch (msg.type) {
            case "get_state":
              this.emit({ type: "state", data: this.state });
              break;
            case "get_messages":
              this.emit({ type: "messages_result", messages: [] });
              break;
            case "get_last_assistant_text":
              this.emit({ type: "last_assistant_text_result", text: null });
              break;
            case "get_available_models":
              this.emit({
                type: "available_models",
                models: [
                  {
                    id: "claude-sonnet-4",
                    name: "Claude Sonnet 4",
                    api: "anthropic",
                    provider: "anthropic",
                    contextWindow: 200000,
                    maxTokens: 8192,
                    reasoning: false,
                    input: ["text"],
                  },
                ],
              });
              break;
            case "get_commands":
              this.emit({ type: "available_commands", commands: [] });
              break;
            case "get_session_stats":
              this.emit({
                type: "session_stats",
                stats: {
                  cost: 0.01,
                  contextUsage: { tokens: 124, contextWindow: 200000, percent: 0.1 },
                },
              });
              break;
            case "prompt":
            case "steer":
            case "follow_up":
              setTimeout(() => {
                const reply = {
                  role: "assistant",
                  content: "Mock reply from the screenshot harness.",
                  timestamp: new Date().toISOString(),
                };
                this.emit({ type: "agent_start" });
                this.emit({ type: "message_start", message: reply });
                this.emit({ type: "message_end", message: reply });
                this.emit({ type: "agent_end", messages: [reply] });
              }, 150);
              break;
            default:
              break;
          }
        } catch {}
      }

      close() {
        this.readyState = this.CLOSED;
        if (this.openTimer) clearTimeout(this.openTimer);
        if (this.onclose) this.onclose({} as any);
      }
    }

    window.WebSocket = new Proxy(RealWS, {
      construct(_Target, args) {
        const url = String(args[0]);
        const pathname = new URL(url, location.href).pathname;
        if (pathname.startsWith("/ws/preview") || pathname.startsWith("/ws?type=terminal")) {
          return new RealWS(...args);
        }
        return new MockWebSocket(url);
      },
    }) as typeof RealWS;
  }, sessionFile);
}

// ─── Main ────────────────────────────────────────────────────────────────────

function findNodeDir(): string | null {
  const result = Bun.spawnSync(["bash", "-c", "command -v node"]);
  if (result.exitCode !== 0) return null;
  const p = new TextDecoder().decode(result.stdout).trim();
  return p ? dirname(p) : null;
}

function withNodePath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const nodeDir = findNodeDir();
  if (!nodeDir) return env;
  const path = env.PATH ?? "";
  if (path.includes(nodeDir)) return env;
  return { ...env, PATH: `${nodeDir}${path ? os.delimiter + path : ""}` };
}

async function main() {
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  // Sandbox HOME so we don't touch the user's real DB / sessions.
  const homeDir = join(process.cwd(), ".screenshot-home");
  rmSync(homeDir, { recursive: true, force: true });
  mkdirSync(homeDir, { recursive: true });

  // Build once so the server can serve the static client.
  if (!SKIP_BUILD) {
    console.log("Building client…");
    const build = Bun.spawnSync(["bun", "run", "build"], { cwd: process.cwd(), env: withNodePath(process.env) });
    if (build.exitCode !== 0) {
      throw new Error(`Build failed:\n${new TextDecoder().decode(build.stderr)}`);
    }
  }

  const env = { ...withNodePath(process.env), HOME: homeDir, PORT: String(SERVER_PORT), HOST: "127.0.0.1" };
  console.log(`Starting server on port ${SERVER_PORT} with HOME=${homeDir}`);
  const server = spawn("bun", ["run", "--cwd", "packages/server", "start"], {
    cwd: process.cwd(),
    env,
    stdio: "ignore",
  });

  let browser: Browser | undefined;
  let page: Page | undefined;

  try {
    await waitForServer(CLIENT_URL);

    const projectPath = join(homeDir, "sample-project");
    const sessionFile = join(projectPath, ".pi", "sessions", "welcome.jsonl");

    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: VIEWPORT });
    page.on("console", (msg) => console.log("[page]", msg.text()));
    page.on("pageerror", (err) => console.warn("[page error]", err.message));
    page.on("response", (res) => {
      if (res.url().includes("/api/sessions/detail")) {
        console.log("[network] sessions/detail", res.status(), res.url());
      }
    });
    await injectMockWebSocket(page, sessionFile);

    // 1. First screen — empty state, no projects.
    await page.goto(CLIENT_URL);
    await page.waitForSelector(".empty-state-shell", { state: "visible" });
    await sleep(300);
    await page.screenshot({ path: join(SCREENSHOTS_DIR, "01-first-screen.png") });
    console.log("Captured 01-first-screen.png");

    // Create the sample directory now so the directory picker can browse it.
    await seedProjectDir(projectPath);

    // 2. Adding a project — open the directory picker modal.
    await page.locator('button:has-text("Add a project directory")').click();
    await page.waitForSelector(".explorer-modal", { state: "visible" });
    await page.locator(".explorer-path-input").fill(projectPath);
    await page.locator(".explorer-path-input").press("Enter");
    await page.waitForSelector(".explorer-item", { state: "visible" });
    await page.locator(".explorer-item").filter({ hasText: "sample-project" }).first().click();
    await page.locator("#project-display-name").fill(PROJECT_NAME);
    await sleep(300);
    await page.screenshot({ path: join(SCREENSHOTS_DIR, "02-adding-project.png") });
    console.log("Captured 02-adding-project.png");

    // Close the modal so it doesn't block later shots.
    await page.getByRole("button", { name: /Cancel/i }).click();
    await page.waitForSelector(".explorer-modal", { state: "hidden" });

    // Add the project via API and create a session for the remaining shots.
    const projectId = await addProject(projectPath, CLIENT_URL);
    await seedSession(homeDir, projectPath, projectId, CLIENT_URL);

    // 3. Project selected, no session.
    await page.goto(CLIENT_URL);
    await page.waitForSelector(".empty-state-shell", { state: "visible" });
    await page.locator(".empty-state-project").filter({ hasText: PROJECT_NAME }).first().click();
    await page.waitForSelector(".conversation-session-welcome", { state: "visible" });
    await sleep(300);
    await page.screenshot({ path: join(SCREENSHOTS_DIR, "03-project-selected-no-session.png") });
    console.log("Captured 03-project-selected-no-session.png");

    // 4. Project + session selected.
    await page.locator(".project-session-item").filter({ hasText: SESSION_NAME }).first().click();
    await page.waitForSelector(".conversation-header", { state: "visible" });
    // Ensure the chat messages are rendered before capturing.
    await page.waitForSelector(".conversation-bubble, .conversation-user-bubble", { state: "visible" });
    await sleep(600);
    await page.screenshot({ path: join(SCREENSHOTS_DIR, "04-project-and-session-selected.png") });
    console.log("Captured 04-project-and-session-selected.png");

    // Dismiss the "Update available" toast so it doesn't clutter panel shots.
    await page.locator('button[aria-label="Close"]').first().click().catch(() => {});

    // 5. Each panel opened one by one.
    // Channels are already visible in the default layout.
    await sleep(300);
    await page.screenshot({ path: join(SCREENSHOTS_DIR, "05-panel-channels.png") });
    console.log("Captured 05-panel-channels.png");

    for (const panel of SIDEBAR_PANELS) {
      const title = panel[0].toUpperCase() + panel.slice(1);
      await page.locator(`button[aria-label="Reopen ${title}"]`).dispatchEvent("click");
      await sleep(400);
      await page.screenshot({ path: join(SCREENSHOTS_DIR, `05-panel-${panel}.png`) });
      console.log(`Captured 05-panel-${panel}.png`);
      await page.locator(`button[aria-label="Close ${title}"]`).dispatchEvent("click");
      await sleep(200);
    }

    // 6. All panels opened together.
    for (const panel of SIDEBAR_PANELS) {
      const title = panel[0].toUpperCase() + panel.slice(1);
      await page.locator(`button[aria-label="Reopen ${title}"]`).dispatchEvent("click");
      await sleep(100);
    }
    await sleep(500);
    await page.screenshot({ path: join(SCREENSHOTS_DIR, "06-all-panels-opened.png") });
    console.log("Captured 06-all-panels-opened.png");

    console.log(`\nDone — screenshots written to ${SCREENSHOTS_DIR}`);
  } finally {
    await page?.close().catch(() => {});
    await browser?.close().catch(() => {});
    server.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        server.kill("SIGKILL");
        resolve();
      }, 3000);
      server.on("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
