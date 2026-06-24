import { Hono } from "hono";
import { join, dirname, isAbsolute, relative } from "node:path";
import { homedir, platform } from "node:os";
import { readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  getAgentDir,
  loadSkills,
  SettingsManager,
  type Skill,
} from "@earendil-works/pi-coding-agent";

const HOME = homedir();
const AGENT_DIR = getAgentDir();
const AGENT_SKILLS_DIR = join(AGENT_DIR, "skills");
const PROJECT_SKILLS_REL = ".pi/skills";

const REGISTRY_SEARCH_URL = "https://skills.sh/api/search";
const SKILL_FETCH_TIMEOUT_MS = 15_000;
const SKILLS_EXEC_TIMEOUT_MS = 120_000;

interface InstalledSkill {
  id: string;
  name: string;
  path: string;
  scope: "global" | "project";
  agents: string[];
  enabled: boolean;
  source?: string;
}

interface SearchResult {
  id: string;
  skillId: string;
  name: string;
  source: string;
  installs: number;
}

function skillEntryName(name: string): string {
  return `skills/${name}/SKILL.md`;
}

function isSkillEnabled(skillPaths: readonly string[], name: string): boolean {
  const entry = skillEntryName(name);
  const found = skillPaths.find((s) => s.replace(/^[+-]/, "") === entry);
  if (found) return found.startsWith("+");
  // Installed but not explicitly listed => PI auto-discovers and enables it
  return true;
}

function buildEnvPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  return [
    join(home, ".bun/bin"),
    join(home, ".nvm/versions/node/v22.22.2/bin"),
    ...(platform() === "win32" ? [] : ["/usr/local/bin", "/usr/bin", "/bin"]),
    process.env.PATH || "",
  ].join(platform() === "win32" ? ";" : ":");
}

async function runSkills(
  args: string[],
  cwd?: string,
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(["bunx", "skills", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: buildEnvPath(), NO_COLOR: "1", FORCE_COLOR: "0" },
  });

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {}
  }, SKILLS_EXEC_TIMEOUT_MS);

  try {
    const code = await proc.exited;
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { ok: code === 0, stdout, stderr: timedOut ? "Timed out" : stderr, code };
  } finally {
    clearTimeout(timeout);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mapSkill(
  scope: "global" | "project",
  skill: Skill,
  skillPaths: readonly string[],
): InstalledSkill {
  return {
    id: `${scope}:${skill.name}`,
    name: skill.name,
    path: skill.baseDir,
    scope,
    agents: ["pi"],
    enabled: isSkillEnabled(skillPaths, skill.name),
    source: skill.sourceInfo.source,
  };
}

function createManager(cwd: string): SettingsManager {
  return SettingsManager.create(cwd, AGENT_DIR);
}

function listSkillPaths(manager: SettingsManager, scope: "global" | "project"): string[] {
  return scope === "project"
    ? manager.getProjectSettings().skills ?? []
    : manager.getSkillPaths();
}

export async function listProjectSkills(
  scope: "global" | "project",
  cwd?: string | null,
): Promise<InstalledSkill[]> {
  if (scope === "project" && (!cwd || !isAbsolute(cwd))) return [];
  const cwdPath = scope === "project" ? cwd! : HOME;
  const manager = createManager(cwdPath);
  const skillPaths = listSkillPaths(manager, scope);
  const { skills } = loadSkills({ cwd: cwdPath, agentDir: AGENT_DIR, skillPaths, includeDefaults: true });

  return skills
    .filter((skill) =>
      scope === "global"
        ? skill.sourceInfo.scope === "user"
        : skill.sourceInfo.scope === "project",
    )
    .map((skill) => mapSkill(scope, skill, skillPaths));
}

export async function searchSkills(query: string): Promise<SearchResult[]> {
  const url = `${REGISTRY_SEARCH_URL}?${new URLSearchParams({ q: query.trim() || "" })}`;
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(SKILL_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`skills.sh search failed (${res.status})`);
  const data = (await res.json()) as { skills?: Array<Record<string, unknown>> };
  return (data.skills || []).map((s) => ({
    id: String(s.id ?? ""),
    skillId: String(s.skillId ?? ""),
    name: String(s.name ?? ""),
    source: String(s.source ?? ""),
    installs: typeof s.installs === "number" ? s.installs : 0,
  }));
}

export async function installSkill(
  source: string,
  skillId: string,
  scope: "global" | "project",
  cwd?: string | null,
): Promise<void> {
  const cwdPath = scope === "project" && cwd ? cwd : HOME;
  const args = ["add", source, "--skill", skillId, "--agent", "pi", "-y"];
  args.push(scope === "global" ? "-g" : "--copy");
  const { ok, stderr } = await runSkills(args, cwdPath);
  if (!ok) throw new Error(stderr.trim() || "Installation failed");

  // Enable the skill in PI settings so new PI sessions pick it up
  const manager = createManager(cwdPath);
  const entry = skillEntryName(skillId);
  const paths = listSkillPaths(manager, scope);
  if (!paths.some((s) => s.replace(/^[+-]/, "") === entry)) {
    paths.push(`+${entry}`);
    if (scope === "project") {
      manager.setProjectSkillPaths(paths);
    } else {
      manager.setSkillPaths(paths);
    }
    await manager.flush();
  }
}

export async function uninstallSkill(
  name: string,
  scope: "global" | "project",
  cwd?: string | null,
): Promise<void> {
  const cwdPath = scope === "project" && cwd ? cwd : HOME;
  const args = ["remove", name, "--agent", "pi", "-y"];
  if (scope === "global") args.push("-g");
  const { ok, stderr } = await runSkills(args, cwdPath);
  if (!ok) throw new Error(stderr.trim() || "Remove failed");

  // Clean up the PI settings entry
  const manager = createManager(cwdPath);
  const entry = skillEntryName(name);
  const paths = listSkillPaths(manager, scope).filter(
    (s) => s.replace(/^[+-]/, "") !== entry,
  );
  if (scope === "project") {
    manager.setProjectSkillPaths(paths);
  } else {
    manager.setSkillPaths(paths);
  }
  await manager.flush();
}

export async function toggleSkill(
  name: string,
  enabled: boolean,
  scope: "global" | "project",
  cwd?: string | null,
): Promise<void> {
  const cwdPath = scope === "project" && cwd ? cwd : HOME;
  const entry = skillEntryName(name);
  const manager = createManager(cwdPath);
  const paths = listSkillPaths(manager, scope);
  const idx = paths.findIndex((s) => s.replace(/^[+-]/, "") === entry);
  if (idx >= 0) {
    paths[idx] = enabled ? `+${entry}` : `-${entry}`;
  } else {
    paths.push(enabled ? `+${entry}` : `-${entry}`);
  }
  if (scope === "project") {
    manager.setProjectSkillPaths(paths);
  } else {
    manager.setSkillPaths(paths);
  }
  await manager.flush();
}

function safeInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  if (!rel) return true;
  const first = rel.split(/[/\\]/)[0];
  return first !== ".." && !isAbsolute(rel);
}

function isSafeSkillPath(input: string, projectCwd?: string | null): boolean {
  if (!isAbsolute(input)) return false;
  const allowedRoots = [AGENT_SKILLS_DIR];
  if (projectCwd) {
    allowedRoots.push(join(projectCwd, PROJECT_SKILLS_REL));
    // ponytail: historical alias used by some installs; kept for compatibility.
    allowedRoots.push(join(projectCwd, ".agents", "skills"));
  }
  return allowedRoots.some((root) => safeInside(input, root));
}

async function fetchRemoteSkill(source: string, skillId: string): Promise<string | null> {
  const args = ["use", source, "--skill", skillId];
  const { ok, stdout } = await runSkills(args, HOME);
  if (!ok) return null;
  const start = stdout.indexOf("<SKILL.md>");
  const end = stdout.indexOf("</SKILL.md>");
  if (start >= 0 && end > start) {
    return stdout.slice(start + "<SKILL.md>".length, end).trim();
  }
  return null;
}

// ── Routes ──

export function createSkillsRoutes() {
  const app = new Hono();

  app.get("/", async (c) => {
    const cwd = c.req.query("cwd");
    try {
      const globalSkills = await listProjectSkills("global");
      const projectSkills =
        cwd && isAbsolute(cwd) && existsSync(cwd)
          ? await listProjectSkills("project", cwd)
          : [];
      return c.json({ skills: [...globalSkills, ...projectSkills] });
    } catch (e) {
      return c.json({ error: errorMessage(e) || "Failed to list skills" }, 500);
    }
  });

  app.get("/search", async (c) => {
    const q = c.req.query("q") || "";
    try {
      const results = await searchSkills(q);
      return c.json({ skills: results });
    } catch (e) {
      return c.json({ error: errorMessage(e) || "Search failed" }, 500);
    }
  });

  app.post("/install", async (c) => {
    let body: { source?: unknown; skillId?: unknown; scope?: unknown; cwd?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (typeof body.source !== "string" || !body.source) {
      return c.json({ error: "source is required" }, 400);
    }
    if (typeof body.skillId !== "string" || !body.skillId) {
      return c.json({ error: "skillId is required" }, 400);
    }
    const scope = body.scope === "project" ? "project" : "global";
    const projectCwd = typeof body.cwd === "string" && isAbsolute(body.cwd) ? body.cwd : null;
    if (scope === "project" && !projectCwd) {
      return c.json({ error: "cwd is required for project scope" }, 400);
    }

    try {
      await installSkill(body.source, body.skillId, scope, projectCwd);
      return c.json({ success: true, restartRequired: true });
    } catch (e) {
      console.warn("[skills] install failed:", e);
      return c.json({ error: errorMessage(e) || "Install failed" }, 500);
    }
  });

  app.post("/uninstall", async (c) => {
    let body: { name?: unknown; scope?: unknown; cwd?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (typeof body.name !== "string" || !body.name) {
      return c.json({ error: "name is required" }, 400);
    }
    const scope = body.scope === "project" ? "project" : "global";
    const projectCwd = typeof body.cwd === "string" && isAbsolute(body.cwd) ? body.cwd : null;
    if (scope === "project" && !projectCwd) {
      return c.json({ error: "cwd is required for project scope" }, 400);
    }

    try {
      await uninstallSkill(body.name, scope, projectCwd);
      return c.json({ success: true, restartRequired: true });
    } catch (e) {
      console.warn("[skills] uninstall failed:", e);
      return c.json({ error: errorMessage(e) || "Uninstall failed" }, 500);
    }
  });

  app.patch("/:name/toggle", async (c) => {
    let body: { enabled?: unknown; scope?: unknown; cwd?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (typeof body.enabled !== "boolean") {
      return c.json({ error: "enabled boolean is required" }, 400);
    }
    const scope = body.scope === "project" ? "project" : "global";
    const projectCwd = typeof body.cwd === "string" && isAbsolute(body.cwd) ? body.cwd : null;
    if (scope === "project" && !projectCwd) {
      return c.json({ error: "cwd is required for project scope" }, 400);
    }
    const name = decodeURIComponent(c.req.param("name"));
    try {
      await toggleSkill(name, body.enabled, scope, projectCwd);
      return c.json({ success: true, restartRequired: true });
    } catch (e) {
      console.warn("[skills] toggle failed:", e);
      return c.json({ error: errorMessage(e) || "Toggle failed" }, 500);
    }
  });

  app.get("/detail", async (c) => {
    const pathParam = c.req.query("path");
    const source = c.req.query("source");
    const skillIdParam = c.req.query("skillId");
    const cwd = c.req.query("cwd");
    if (!pathParam && (!source || !skillIdParam)) {
      return c.json({ error: "path or source+skillId is required" }, 400);
    }

    try {
      let content: string | null = null;
      let resolvedPath: string | undefined;
      let skillError: string | undefined;
      const name = typeof c.req.query("name") === "string" ? c.req.query("name")! : skillIdParam || "";

      if (pathParam) {
        if (!isSafeSkillPath(pathParam, typeof cwd === "string" && isAbsolute(cwd) ? cwd : undefined)) {
          return c.json({ error: "Invalid skill path" }, 400);
        }
        const skillFile = join(pathParam, "SKILL.md");
        try {
          content = await readFile(skillFile, "utf-8");
          resolvedPath = pathParam;
        } catch {
          skillError = "SKILL.md not found";
        }
      }

      if (!content && source && skillIdParam) {
        content = await fetchRemoteSkill(source, skillIdParam);
        if (!content) skillError = skillError || "Could not fetch SKILL.md";
      }

      if (!content) {
        return c.json({ error: skillError || "Skill detail not found" }, 404);
      }

      return c.json({
        name,
        source,
        skillId: skillIdParam,
        path: resolvedPath,
        content,
      });
    } catch (e) {
      console.warn("[skills] detail failed:", e);
      return c.json({ error: errorMessage(e) || "Failed to load skill detail" }, 500);
    }
  });

  return app;
}
