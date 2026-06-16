import { Hono } from "hono";
import { join, dirname, isAbsolute, relative } from "node:path";
import { homedir, platform } from "node:os";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";

const HOME = homedir();
const PI_SETTINGS_PATH = join(HOME, ".pi", "agent", "settings.json");
const projectSettingsPath = (cwd: string) => join(cwd, ".pi", "settings.json");

const REGISTRY_SEARCH_URL = "https://skills.sh/api/search";
const SKILL_FETCH_TIMEOUT_MS = 15_000;
const SKILLS_EXEC_TIMEOUT_MS = 120_000;

interface PiSettings {
  skills?: string[];
  [key: string]: unknown;
}

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

async function readSettings(path: string): Promise<PiSettings> {
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as PiSettings;
  } catch {
    return {};
  }
}

async function writeSettings(path: string, settings: PiSettings): Promise<void> {
  const raw = JSON.stringify(settings, null, 2) + "\n";
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, raw, "utf-8");
}

function readPiSettings(): Promise<PiSettings> {
  return readSettings(PI_SETTINGS_PATH);
}

function writePiSettings(settings: PiSettings): Promise<void> {
  return writeSettings(PI_SETTINGS_PATH, settings);
}

function readProjectPiSettings(cwd: string): Promise<PiSettings> {
  return readSettings(projectSettingsPath(cwd));
}

function writeProjectPiSettings(cwd: string, settings: PiSettings): Promise<void> {
  return writeSettings(projectSettingsPath(cwd), settings);
}

function skillEntryName(name: string): string {
  return `skills/${name}/SKILL.md`;
}

function isSkillEnabled(settings: PiSettings, name: string): boolean {
  const entry = skillEntryName(name);
  const found = (settings.skills || []).find((s) => s.replace(/^[+-]/, "") === entry);
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

async function listInstalledSkills(
  scope: "global" | "project",
  cwd?: string | null,
): Promise<InstalledSkill[]> {
  if (scope === "project" && (!cwd || !isAbsolute(cwd))) return [];
  const args = ["ls", "-a", "pi", "--json"];
  if (scope === "global") args.push("-g");
  const cwdPath = scope === "project" && cwd ? cwd : HOME;
  const { ok, stdout, stderr } = await runSkills(args, cwdPath);
  if (!ok) {
    console.warn("[skills] failed to list skills:", stderr);
    return [];
  }
  try {
    const raw = JSON.parse(stdout);
    if (!Array.isArray(raw)) return [];
    const settings = await (scope === "global"
      ? readPiSettings()
      : readProjectPiSettings(cwd!));
    return raw.map((item: any) => ({
      id: `${scope}:${item.name}`,
      name: item.name,
      path: item.path,
      scope: scope === "global" ? "global" : "project",
      agents: item.agents || [],
      enabled: isSkillEnabled(settings, item.name),
      source: item.source,
    }));
  } catch (e) {
    console.warn("[skills] failed to parse skill list:", e);
    return [];
  }
}

async function searchSkills(query: string): Promise<SearchResult[]> {
  const url = `${REGISTRY_SEARCH_URL}?${new URLSearchParams({ q: query.trim() || "" })}`;
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(SKILL_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`skills.sh search failed (${res.status})`);
  const data = (await res.json()) as { skills?: any[] };
  return (data.skills || []).map((s) => ({
    id: s.id,
    skillId: s.skillId,
    name: s.name,
    source: s.source,
    installs: typeof s.installs === "number" ? s.installs : 0,
  }));
}

async function installSkill(
  source: string,
  skillId: string,
  scope: "global" | "project",
  cwd?: string | null,
): Promise<void> {
  const args = ["add", source, "--skill", skillId, "--agent", "pi", "-y"];
  args.push(scope === "global" ? "-g" : "--copy");
  const cwdPath = scope === "project" && cwd ? cwd : HOME;
  const { ok, stderr } = await runSkills(args, cwdPath);
  if (!ok) throw new Error(stderr.trim() || "Installation failed");

  // Enable the skill in PI settings so new PI sessions pick it up
  if (scope === "global") {
    const settings = await readPiSettings();
    const entry = skillEntryName(skillId);
    const skills = settings.skills || [];
    if (!skills.some((s) => s.replace(/^[+-]/, "") === entry)) {
      settings.skills = [...skills, `+${entry}`];
      await writePiSettings(settings);
    }
  } else if (cwd) {
    const settings = await readProjectPiSettings(cwd);
    const entry = skillEntryName(skillId);
    const skills = settings.skills || [];
    if (!skills.some((s) => s.replace(/^[+-]/, "") === entry)) {
      settings.skills = [...skills, `+${entry}`];
      await writeProjectPiSettings(cwd, settings);
    }
  }
}

async function uninstallSkill(
  name: string,
  scope: "global" | "project",
  cwd?: string | null,
): Promise<void> {
  const args = ["remove", name, "--agent", "pi", "-y"];
  if (scope === "global") args.push("-g");
  const cwdPath = scope === "project" && cwd ? cwd : HOME;
  const { ok, stderr } = await runSkills(args, cwdPath);
  if (!ok) throw new Error(stderr.trim() || "Remove failed");

  // Clean up the PI settings entry
  if (scope === "global") {
    const settings = await readPiSettings();
    const entry = skillEntryName(name);
    settings.skills = (settings.skills || []).filter((s) => s.replace(/^[+-]/, "") !== entry);
    await writePiSettings(settings);
  } else if (cwd) {
    const settings = await readProjectPiSettings(cwd);
    const entry = skillEntryName(name);
    settings.skills = (settings.skills || []).filter((s) => s.replace(/^[+-]/, "") !== entry);
    await writeProjectPiSettings(cwd, settings);
  }
}

async function toggleSkill(
  name: string,
  enabled: boolean,
  scope: "global" | "project",
  cwd?: string | null,
): Promise<void> {
  const entry = skillEntryName(name);
  if (scope === "global") {
    const settings = await readPiSettings();
    const skills = settings.skills || [];
    const idx = skills.findIndex((s) => s.replace(/^[+-]/, "") === entry);
    if (idx >= 0) {
      skills[idx] = enabled ? `+${entry}` : `-${entry}`;
    } else {
      skills.push(enabled ? `+${entry}` : `-${entry}`);
    }
    settings.skills = skills;
    await writePiSettings(settings);
  } else if (cwd) {
    const settings = await readProjectPiSettings(cwd);
    const skills = settings.skills || [];
    const idx = skills.findIndex((s) => s.replace(/^[+-]/, "") === entry);
    if (idx >= 0) {
      skills[idx] = enabled ? `+${entry}` : `-${entry}`;
    } else {
      skills.push(enabled ? `+${entry}` : `-${entry}`);
    }
    settings.skills = skills;
    await writeProjectPiSettings(cwd, settings);
  }
}

function safeInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  if (!rel) return true;
  const first = rel.split(/[/\\]/)[0];
  return first !== ".." && !isAbsolute(rel);
}

function isSafeSkillPath(input: string, projectCwd?: string | null): boolean {
  if (!isAbsolute(input)) return false;
  const allowedRoots = [join(HOME, ".pi", "agent", "skills"), join(HOME, ".agents", "skills")];
  if (projectCwd) allowedRoots.push(join(projectCwd, ".pi", "skills"), join(projectCwd, ".agents", "skills"));
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
      const globalSkills = await listInstalledSkills("global");
      const projectSkills =
        cwd && isAbsolute(cwd) && existsSync(cwd)
          ? await listInstalledSkills("project", cwd)
          : [];
      return c.json({ skills: [...globalSkills, ...projectSkills] });
    } catch (e: any) {
      return c.json({ error: e.message || "Failed to list skills" }, 500);
    }
  });

  app.get("/search", async (c) => {
    const q = c.req.query("q") || "";
    try {
      const results = await searchSkills(q);
      return c.json({ skills: results });
    } catch (e: any) {
      return c.json({ error: e.message || "Search failed" }, 500);
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
    } catch (e: any) {
      console.warn("[skills] install failed:", e);
      return c.json({ error: e.message || "Install failed" }, 500);
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
    } catch (e: any) {
      console.warn("[skills] uninstall failed:", e);
      return c.json({ error: e.message || "Uninstall failed" }, 500);
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
    } catch (e: any) {
      console.warn("[skills] toggle failed:", e);
      return c.json({ error: e.message || "Toggle failed" }, 500);
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
      let error: string | undefined;
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
          error = "SKILL.md not found";
        }
      }

      if (!content && source && skillIdParam) {
        content = await fetchRemoteSkill(source, skillIdParam);
        if (!content) error = error || "Could not fetch SKILL.md";
      }

      if (!content) {
        return c.json({ error: error || "Skill detail not found" }, 404);
      }

      return c.json({
        name,
        source,
        skillId: skillIdParam,
        path: resolvedPath,
        content,
      });
    } catch (e: any) {
      console.warn("[skills] detail failed:", e);
      return c.json({ error: e.message || "Failed to load skill detail" }, 500);
    }
  });

  return app;
}
