import { Database } from "bun:sqlite";
import type { Project } from "@pi-web/shared";

const DB_PATH = ".pi-web.db";

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
}

export function addProject(name: string, path: string): Project {
  const d = getDb();
  const id = Bun.randomUUIDv7();
  const addedAt = new Date().toISOString();
  d.run("INSERT INTO projects (id, name, path, added_at) VALUES (?, ?, ?, ?)", [
    id, name, path, addedAt,
  ]);
  return { id, name, path, addedAt, lastOpenedAt: null, sessionCount: 0 };
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
  };
}

export function touchProject(id: string) {
  const d = getDb();
  d.run("UPDATE projects SET last_opened_at = datetime('now') WHERE id = ?", [id]);
}
