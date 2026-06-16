import { Database } from "bun:sqlite";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import type { Project, WorkspaceLayout } from "@pi-web/shared";

// #80: Resolve DB path to $HOME/.pi-web/.pi-web.db
const DB_PATH = join(homedir(), ".pi-web", ".pi-web.db");

// Ensure parent directory exists (bun:sqlite doesn't create intermediate dirs)
mkdirSync(dirname(DB_PATH), { recursive: true });

let db: Database;

export function getDb(): Database {
  if (!db) {
    db = new Database(DB_PATH, { create: true });
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA foreign_keys = ON");
    initSchema();
  }
  return db;
}

function initSchema() {
  db.run(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_opened_at TEXT
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS app_layouts (
      key TEXT PRIMARY KEY,
      layout TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS project_settings (
      project_id TEXT PRIMARY KEY,
      system_prompt TEXT DEFAULT '',
      project_instructions TEXT DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
  `);
}

export function getProjectSettings(projectId: string): { systemPrompt: string; projectInstructions: string } {
  const d = getDb();
  const row = d.query("SELECT system_prompt, project_instructions FROM project_settings WHERE project_id = ?").get(projectId) as { system_prompt?: string; project_instructions?: string } | undefined;
  return {
    systemPrompt: row?.system_prompt || "",
    projectInstructions: row?.project_instructions || "",
  };
}

export function saveProjectSettings(projectId: string, settings: { systemPrompt?: string; projectInstructions?: string }) {
  const d = getDb();
  d.run(
    `INSERT INTO project_settings (project_id, system_prompt, project_instructions, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(project_id) DO UPDATE SET
       system_prompt = COALESCE(excluded.system_prompt, system_prompt),
       project_instructions = COALESCE(excluded.project_instructions, project_instructions),
       updated_at = datetime('now')`,
    [projectId, settings.systemPrompt ?? null, settings.projectInstructions ?? null],
  );
}

export function addProject(name: string, path: string): Project {
  const d = getDb();
  const id = Bun.randomUUIDv7();
  const addedAt = new Date().toISOString();
  d.run("INSERT INTO projects (id, name, path, added_at) VALUES (?, ?, ?, ?)", [
    id, name, path, addedAt,
  ]);
  return { id, name, path, addedAt, lastOpenedAt: null, sessionCount: 0, lastActiveAt: null, totalTokens: 0, totalCost: 0 };
}

export function removeProject(id: string): boolean {
  const d = getDb();
  const result = d.run("DELETE FROM projects WHERE id = ?", [id]);
  return result.changes > 0;
}

export function listProjects(): Project[] {
  const d = getDb();
  const rows = d.query("SELECT * FROM projects ORDER BY last_opened_at DESC, added_at DESC").all() as any[];
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    path: r.path,
    addedAt: r.added_at,
    lastOpenedAt: r.last_opened_at,
    sessionCount: 0,
    lastActiveAt: r.last_opened_at,
    totalTokens: 0,
    totalCost: 0,
  }));
}

export function getProject(id: string): Project | null {
  const d = getDb();
  const row = d.query("SELECT * FROM projects WHERE id = ?").get(id) as any;
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    addedAt: row.added_at,
    lastOpenedAt: row.last_opened_at,
    sessionCount: 0,
    lastActiveAt: row.last_opened_at,
    totalTokens: 0,
    totalCost: 0,
  };
}

export function touchProject(id: string) {
  const d = getDb();
  d.run("UPDATE projects SET last_opened_at = datetime('now') WHERE id = ?", [id]);
}

export function getLayout(key = "workspace"): WorkspaceLayout | null {
  const d = getDb();
  const row = d.query("SELECT layout FROM app_layouts WHERE key = ?").get(key) as { layout?: string } | undefined;
  if (!row?.layout) return null;
  try {
    return JSON.parse(row.layout) as WorkspaceLayout;
  } catch {
    return null;
  }
}

export function saveLayout(key: string, layout: WorkspaceLayout) {
  const d = getDb();
  d.run(
    `INSERT INTO app_layouts (key, layout, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET layout = excluded.layout, updated_at = datetime('now')`,
    [key, JSON.stringify(layout)],
  );
}

export function deleteLayout(key = "workspace") {
  const d = getDb();
  d.run("DELETE FROM app_layouts WHERE key = ?", [key]);
}
