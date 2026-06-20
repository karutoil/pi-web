import { readdir, stat, readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join, basename, resolve, normalize } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { SessionSummary, SessionDetail, SessionEntry, ChatMessage, ProjectUsage, UsageSummary } from "@pi-web/shared";

// ─── Index Cache ───
// Stores parsed summaries keyed by filePath+mtime to avoid re-parsing unchanged files.
// Located at ~/.pi-web/indexes/<sanitized-project-path>.json

interface IndexEntry {
  mtime: string;
  summary: SessionSummary;
}

interface SessionIndex {
  version: number;
  updatedAt: string;
  entries: Record<string, IndexEntry>; // filePath -> { mtime, summary }
}

const INDEX_VERSION = 1;

function getIndexDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || tmpdir();
  return join(home, ".pi-web", "indexes");
}

function getIndexFilePath(projectPath: string): string {
  const sanitized = sanitizePath(projectPath);
  return join(getIndexDir(), `${sanitized}.json`);
}

async function loadIndex(projectPath: string): Promise<SessionIndex> {
  try {
    const raw = await readFile(getIndexFilePath(projectPath), "utf-8");
    const index = JSON.parse(raw);
    // #85: Check index version mismatch — discard stale indexes
    if (index.version !== INDEX_VERSION) {
      console.log(`[sessions] index version mismatch (got ${index.version}, expected ${INDEX_VERSION}), rebuilding`);
      return { version: INDEX_VERSION, updatedAt: "", entries: {} };
    }
    return index;
  } catch {
    return { version: INDEX_VERSION, updatedAt: "", entries: {} };
  }
}

// #89: Atomic index write — write to tmp file then rename
async function saveIndex(projectPath: string, index: SessionIndex): Promise<void> {
  const dir = getIndexDir();
  await mkdir(dir, { recursive: true });
  index.updatedAt = new Date().toISOString();
  const targetPath = getIndexFilePath(projectPath);
  const tmpPath = targetPath + ".tmp";
  await writeFile(tmpPath, JSON.stringify(index));
  await rename(tmpPath, targetPath);
}

// ─── List Sessions (with index cache) ───

export async function listProjectSessions(projectPath: string): Promise<SessionSummary[]> {
  const home = process.env.HOME || process.env.USERPROFILE || tmpdir();
  const sanitized = sanitizePath(projectPath);
  const sessionDir = join(home, ".pi", "agent", "sessions", sanitized);
  const localSessionDir = join(projectPath, ".pi", "sessions");

  // Collect all .jsonl files with their mtimes
  const fileEntries: { filePath: string; mtime: string }[] = [];
  for (const dir of [sessionDir, localSessionDir]) {
    try {
      const files = await readdir(dir);
      for (const file of files.filter(f => f.endsWith(".jsonl"))) {
        const filePath = join(dir, file);
        try {
          const s = await stat(filePath);
          fileEntries.push({ filePath, mtime: s.mtime.toISOString() });
        } catch {}
      }
    } catch {}
  }

  // Load index and determine which files need re-parsing
  const index = await loadIndex(projectPath);
  const results: SessionSummary[] = [];
  const needsParse: { filePath: string; mtime: string }[] = [];
  const now = Date.now();

  for (const fe of fileEntries) {
    const cached = index.entries[fe.filePath];
    if (cached && cached.mtime === fe.mtime) {
      // Cache hit — but update isRecentlyActive dynamically
      const lastActive = cached.summary.lastActiveAt
        ? new Date(cached.summary.lastActiveAt).getTime()
        : new Date(cached.summary.timestamp).getTime();
      results.push({
        ...cached.summary,
        isRecentlyActive: (now - lastActive) < 5 * 60 * 1000,
      });
    } else {
      needsParse.push(fe);
    }
  }

  // Parse only the changed/new files (streaming, with early exit)
  if (needsParse.length > 0) {
    const parsed = await Promise.all(
      needsParse.map(fe => parseSessionSummaryFull(fe.filePath, fe.mtime))
    );
    for (let i = 0; i < parsed.length; i++) {
      const s = parsed[i];
      if (s) {
        results.push(s);
        index.entries[needsParse[i].filePath] = { mtime: needsParse[i].mtime, summary: s };
      }
    }
    // Save updated index
    await saveIndex(projectPath, index);
  }

  // Remove index entries for files that no longer exist
  const filePaths = new Set(fileEntries.map(f => f.filePath));
  let indexChanged = false;
  for (const key of Object.keys(index.entries)) {
    if (!filePaths.has(key)) {
      delete index.entries[key];
      indexChanged = true;
    }
  }
  if (indexChanged) await saveIndex(projectPath, index);

  // Deduplicate by id and sort
  const seen = new Set<string>();
  const unique = results.filter(s => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });
  unique.sort((a, b) => new Date(b.lastActiveAt || b.timestamp).getTime() - new Date(a.lastActiveAt || a.timestamp).getTime());
  return unique;
}

// ─── Full-file Parse (with index cache for speed) ───
// Reads full file, parses all lines. Fast enough when combined with index cache.
// Index cache avoids re-parsing unchanged files on subsequent loads.

async function parseSessionSummaryFull(filePath: string, mtime: string): Promise<SessionSummary | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    const lines = content.trim().split("\n");

    let header: any = null;
    let messageCount = 0;
    let lastMessage: string | null = null;
    let firstMessage: string | null = null;
    let model: string | null = null;
    let name: string | null = null;
    let totalTokens = 0;
    let totalCost = 0;
    let lastActiveAt = "";
    let firstUserTimestamp = "";

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === "session") {
          header = entry;
        } else if (entry.type === "message" && entry.message) {
          messageCount++;
          const msg = entry.message;
          if (msg.role === "user") {
            const text = extractText(msg.content);
            if (text && !firstMessage) {
              firstMessage = text.slice(0, 200);
              firstUserTimestamp = entry.timestamp || "";
            }
            if (text) {
              lastMessage = text.slice(0, 200);
            }
            lastActiveAt = entry.timestamp || lastActiveAt;
          }
          if (msg.role === "assistant") {
            lastActiveAt = entry.timestamp || lastActiveAt;
            if (msg.model) model = msg.model;
            if (msg.usage) {
              // #37: Use ?? defaults to prevent NaN accumulation
              totalTokens += (msg.usage.totalTokens ?? ((msg.usage.input ?? 0) + (msg.usage.output ?? 0)));
              totalCost += (msg.usage.cost?.total ?? 0);
            }
          }
        } else if (entry.type === "session_info" && entry.name) {
          name = entry.name;
          lastActiveAt = entry.timestamp || lastActiveAt;
        }
      } catch {}
    }

    const timestamp = header?.timestamp || mtime;
    const now = Date.now();
    const lastActive = lastActiveAt ? new Date(lastActiveAt).getTime() : new Date(timestamp).getTime();
    const isRecentlyActive = (now - lastActive) < 5 * 60 * 1000;

    return {
      id: header?.id || basename(filePath, ".jsonl"),
      filePath,
      cwd: header?.cwd || "",
      timestamp,
      name,
      messageCount,
      lastMessage,
      model,
      firstMessage,
      createdAt: firstUserTimestamp || timestamp,
      lastActiveAt: lastActiveAt || timestamp,
      tokenCount: totalTokens,
      cost: totalCost,
      isRecentlyActive,
    };
  } catch {
    return null;
  }
}

// ─── Read last N lines of a file efficiently ───
// Reads from the end of the file using a buffer, avoids loading full file into memory.

// ─── Session Detail (full parse, only loaded when user opens a session) ───

export async function getSessionDetail(filePath: string): Promise<SessionDetail | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    const lines = content.trim().split("\n");

    let header: any = null;
    const entries: SessionEntry[] = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === "session") {
          header = entry;
          continue;
        }

        const sessionEntry: SessionEntry = {
          id: entry.id || "",
          parentId: entry.parentId || null,
          type: entry.type || "message",
          timestamp: entry.timestamp || "",
        };

        if (entry.message) sessionEntry.message = normalizeMessage(entry.message);
        if (entry.provider) sessionEntry.provider = entry.provider;
        if (entry.modelId) sessionEntry.modelId = entry.modelId;
        if (entry.thinkingLevel) sessionEntry.thinkingLevel = entry.thinkingLevel;
        if (entry.summary) sessionEntry.summary = entry.summary;
        if (entry.label) sessionEntry.label = entry.label;
        if (entry.targetId) sessionEntry.targetId = entry.targetId;
        if (entry.fromId) sessionEntry.fromId = entry.fromId;
        if (entry.customType) sessionEntry.customType = entry.customType;
        if (entry.data !== undefined) sessionEntry.data = entry.data;
        if (entry.content !== undefined) sessionEntry.content = entry.content;
        if (entry.display !== undefined) sessionEntry.display = entry.display;

        entries.push(sessionEntry);
      } catch {}
    }

    return {
      id: header?.id || basename(filePath, ".jsonl"),
      filePath,
      cwd: header?.cwd || "",
      timestamp: header?.timestamp || "",
      name: findSessionName(entries),
      version: header?.version || 1,
      entries,
    };
  } catch {
    return null;
  }
}

// ─── Helpers ───

function normalizeMessage(msg: any): ChatMessage {
  const normalized: ChatMessage = {
    role: msg.role || "unknown",
    content: msg.content || "",
    timestamp: msg.timestamp || new Date().toISOString(),
  };

  if (msg.api) normalized.api = msg.api;
  if (msg.provider) normalized.provider = msg.provider;
  if (msg.model) normalized.model = msg.model;
  if (msg.usage) normalized.usage = msg.usage;
  if (msg.stopReason) normalized.stopReason = msg.stopReason;
  if (msg.errorMessage) normalized.errorMessage = msg.errorMessage;
  if (msg.toolCallId) normalized.toolCallId = msg.toolCallId;
  if (msg.toolName) normalized.toolName = msg.toolName;
  if (msg.isError !== undefined) normalized.isError = msg.isError;
  if (msg.details) normalized.details = msg.details;
  if (msg.command) normalized.command = msg.command;
  if (msg.output) normalized.output = msg.output;
  if (msg.exitCode !== undefined) normalized.exitCode = msg.exitCode;
  if (msg.cancelled !== undefined) normalized.cancelled = msg.cancelled;
  if (msg.truncated !== undefined) normalized.truncated = msg.truncated;
  if (msg.fullOutputPath) normalized.fullOutputPath = msg.fullOutputPath;
  if (msg.tokensBefore !== undefined) normalized.tokensBefore = msg.tokensBefore;
  if (msg.thinking) normalized.thinking = msg.thinking;

  if (Array.isArray(normalized.content)) {
    normalized.content = (normalized.content as any[]).map((block: any) => {
      if (typeof block === "string") return { type: "text", text: block };
      return block;
    });
  }

  return normalized;
}

function extractText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join(" ");
  }
  return null;
}

function findSessionName(entries: any[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === "session_info" && entries[i].name) return entries[i].name;
  }
  return null;
}

function sanitizePath(p: string): string {
  // #86: Normalize to absolute path before sanitizing
  const abs = resolve(normalize(p));
  let s = abs.replace(/^[\\/]/, "").replace(/[\\/]$/, "");
  s = s.replace(/[\\/:]/g, "-");
  return `--${s || "root"}--`;
}

// ─── Aggregate usage across sessions ───
// Sums token/cost/message counts from the per-project session index cache.

export function computeProjectUsage(sessions: SessionSummary[]): { sessionCount: number; totalTokens: number; totalCost: number; totalMessages: number } {
  let totalTokens = 0;
  let totalCost = 0;
  let totalMessages = 0;
  for (const s of sessions) {
    totalTokens += s.tokenCount || 0;
    totalCost += s.cost || 0;
    totalMessages += s.messageCount || 0;
  }
  return { sessionCount: sessions.length, totalTokens, totalCost, totalMessages };
}

/**
 * Build an aggregate UsageSummary across all known projects.
 * Reuses the per-project session index cache so repeated calls are cheap.
 */
export async function buildUsageSummary(projects: { id: string; name: string; path: string }[]): Promise<UsageSummary> {
  const perProject: ProjectUsage[] = [];
  let totalTokens = 0;
  let totalCost = 0;
  let totalSessions = 0;
  const byModel = new Map<string, { tokens: number; cost: number; sessions: number }>();

  // Iterate projects sequentially to avoid stampeding the index cache with
  // N concurrent full parses on a cold start.
  for (const p of projects) {
    let sessions: SessionSummary[] = [];
    try {
      sessions = await listProjectSessions(p.path);
    } catch {
      sessions = [];
    }
    const u = computeProjectUsage(sessions);
    perProject.push({ id: p.id, name: p.name, path: p.path, ...u });
    totalTokens += u.totalTokens;
    totalCost += u.totalCost;
    totalSessions += u.sessionCount;
    for (const s of sessions) {
      const model = s.model || "unknown";
      const entry = byModel.get(model) || { tokens: 0, cost: 0, sessions: 0 };
      entry.tokens += s.tokenCount || 0;
      entry.cost += s.cost || 0;
      entry.sessions += 1;
      byModel.set(model, entry);
    }
  }

  perProject.sort((a, b) => b.totalTokens - a.totalTokens);
  const byModelList = Array.from(byModel.entries())
    .map(([model, v]) => ({ model, ...v }))
    .sort((a, b) => b.tokens - a.tokens);

  return {
    totalSessions,
    totalTokens,
    totalCost,
    projects: perProject,
    byModel: byModelList,
    fetchedAt: new Date().toISOString(),
  };
}
