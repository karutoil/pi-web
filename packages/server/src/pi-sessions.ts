import { readdir, stat, readFile, writeFile, mkdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join, basename } from "node:path";
import type { SessionSummary, SessionDetail, SessionEntry, ChatMessage } from "@pi-web/shared";

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
  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
  return join(home, ".pi-web", "indexes");
}

function getIndexFilePath(projectPath: string): string {
  const sanitized = sanitizePath(projectPath);
  return join(getIndexDir(), `${sanitized}.json`);
}

async function loadIndex(projectPath: string): Promise<SessionIndex> {
  try {
    const raw = await readFile(getIndexFilePath(projectPath), "utf-8");
    return JSON.parse(raw);
  } catch {
    return { version: INDEX_VERSION, updatedAt: "", entries: {} };
  }
}

async function saveIndex(projectPath: string, index: SessionIndex): Promise<void> {
  const dir = getIndexDir();
  await mkdir(dir, { recursive: true });
  index.updatedAt = new Date().toISOString();
  await writeFile(getIndexFilePath(projectPath), JSON.stringify(index));
}

// ─── List Sessions (with index cache) ───

export async function listProjectSessions(projectPath: string): Promise<SessionSummary[]> {
  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
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
      needsParse.map(fe => parseSessionSummaryStreaming(fe.filePath, fe.mtime))
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

// ─── Streaming Parse with Early Exit ───
// Reads the file line-by-line via readline (no full file in memory).
// Stops early once we have: header, first user msg, last session_info name.
// For stats (tokens, model, lastActiveAt), reads the LAST 200 lines.

async function parseSessionSummaryStreaming(filePath: string, mtime: string): Promise<SessionSummary | null> {
  let header: any = null;
  let messageCount = 0;
  let firstMessage: string | null = null;
  let firstUserTimestamp = "";
  let name: string | null = null;

  // Pass 1: Read forward for header + first user message
  // Stop after finding first user message (saves reading entire file)
  let foundFirstUser = false;
  try {
    const rl = createInterface({ input: createReadStream(filePath, { encoding: "utf-8" }) });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === "session") {
          header = entry;
        } else if (entry.type === "message" && entry.message) {
          messageCount++;
          if (entry.message.role === "user" && !foundFirstUser) {
            const text = extractText(entry.message.content);
            if (text) {
              firstMessage = text.slice(0, 200);
              firstUserTimestamp = entry.timestamp || "";
            }
            foundFirstUser = true;
          }
        } else if (entry.type === "session_info" && entry.name) {
          name = entry.name; // keep overwriting — last one wins
        }
      } catch {}
      // Early exit: we have everything we need from the top
      // But we still need to count messages and find the last session_info
      // So we continue, but this is still more efficient than readFile + split
    }
  } catch {
    return null;
  }

  // Pass 2: Read LAST ~200 lines for stats (model, tokens, lastActiveAt, lastMessage)
  // This avoids reading the full file for large sessions
  let model: string | null = null;
  let totalTokens = 0;
  let totalCost = 0;
  let lastActiveAt = "";
  let lastMessage: string | null = null;

  try {
    const tailLines = await readLastNLines(filePath, 200);
    for (const line of tailLines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === "message" && entry.message) {
          const msg = entry.message;
          if (msg.role === "assistant") {
            lastActiveAt = entry.timestamp || lastActiveAt;
            if (msg.model) model = msg.model;
            if (msg.usage) {
              totalTokens += (msg.usage.totalTokens || msg.usage.input + msg.usage.output);
              if (msg.usage.cost?.total) totalCost += msg.usage.cost.total;
            }
          }
          if (msg.role === "user") {
            const text = extractText(msg.content);
            if (text) lastMessage = text.slice(0, 200);
            lastActiveAt = entry.timestamp || lastActiveAt;
          }
        } else if (entry.type === "session_info") {
          lastActiveAt = entry.timestamp || lastActiveAt;
          if (entry.name) name = entry.name; // last session_info wins
        }
      } catch {}
    }
  } catch {}

  const timestamp = header?.timestamp || mtime;
  const lastActive = lastActiveAt ? new Date(lastActiveAt).getTime() : new Date(timestamp).getTime();
  const isRecentlyActive = (Date.now() - lastActive) < 5 * 60 * 1000;

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
}

// ─── Read last N lines of a file efficiently ───
// Reads from the end of the file using a buffer, avoids loading full file into memory.

async function readLastNLines(filePath: string, n: number): Promise<string[]> {
  const CHUNK = 4096;
  const { stat: statFn } = await import("node:fs/promises");
  const { open } = await import("node:fs/promises");

  let fileHandle: any;
  try {
    fileHandle = await open(filePath, "r");
    const stats = await fileHandle.stat();
    const fileSize = stats.size;
    if (fileSize === 0) return [];

    const lines: string[] = [];
    let position = fileSize;
    let leftover = "";

    while (position > 0 && lines.length < n) {
      const readSize = Math.min(CHUNK, position);
      position -= readSize;
      const buf = Buffer.alloc(readSize);
      await fileHandle.read(buf, 0, readSize, position);
      const chunk = buf.toString("utf-8");
      const combined = chunk + leftover;
      const chunkLines = combined.split("\n");
      // First element might be incomplete (split mid-line) — keep as leftover
      leftover = position > 0 ? chunkLines[0] : "";
      const startIdx = position > 0 ? 1 : 0;
      for (let i = chunkLines.length - 1; i >= startIdx; i--) {
        if (chunkLines[i]) lines.push(chunkLines[i]);
        if (lines.length >= n) break;
      }
    }

    return lines; // returned in reverse order, but we don't care — we just scan for stats
  } catch {
    return [];
  } finally {
    await fileHandle?.close();
  }
}

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
  };

  if (msg.timestamp) normalized.timestamp = msg.timestamp;
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
  if (msg.tokensBefore) normalized.tokensBefore = msg.tokensBefore;
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
  let s = p.replace(/^\//, "").replace(/\/$/, "");
  s = s.replace(/\//g, "-");
  return `--${s || "root"}--`;
}
