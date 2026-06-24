import { stat, readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join, resolve, normalize, basename } from "node:path";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  getAgentDir,
  SessionManager,
  type SessionEntry,
  type SessionInfo,
  type SessionHeader,
  type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import type { UserMessage, AssistantMessage, ToolResultMessage, TextContent, ImageContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";
import type {
  SessionSummary,
  SessionDetail,
  SessionEntry as SharedSessionEntry,
  ChatMessage,
  ContentBlock,
  ProjectUsage,
  UsageSummary,
} from "@pi-web/shared";

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
    const index = JSON.parse(raw) as SessionIndex;
    if (index.version !== INDEX_VERSION) {
      console.log(`[sessions] index version mismatch (got ${index.version}, expected ${INDEX_VERSION}), rebuilding`);
      return { version: INDEX_VERSION, updatedAt: "", entries: {} };
    }
    return index;
  } catch {
    return { version: INDEX_VERSION, updatedAt: "", entries: {} };
  }
}

async function saveIndex(projectPath: string, index: SessionIndex): Promise<void> {
  const dir = getIndexDir();
  await mkdir(dir, { recursive: true });
  index.updatedAt = new Date().toISOString();
  const targetPath = getIndexFilePath(projectPath);
  const tmpPath = targetPath + ".tmp";
  await writeFile(tmpPath, JSON.stringify(index));
  await rename(tmpPath, targetPath);
}

// ─── SDK helpers ───

function getAgentSessionsDir(): string {
  return join(getAgentDir(), "sessions");
}

async function collectSessionInfos(cwd: string): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = [];
  try {
    const defaultSessions = await SessionManager.list(cwd);
    sessions.push(...defaultSessions);
  } catch (err) {
    console.warn(`[sessions] failed to list default sessions for ${cwd}:`, err);
  }

  const localSessionDir = join(cwd, ".pi", "sessions");
  if (existsSync(localSessionDir)) {
    try {
      const localSessions = await SessionManager.list(cwd, localSessionDir);
      sessions.push(...localSessions);
    } catch (err) {
      console.warn(`[sessions] failed to list local sessions for ${cwd}:`, err);
    }
  }

  return sessions;
}

function extractText(content: string | (TextContent | ImageContent)[] | unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is TextContent => typeof b === "object" && b !== null && "type" in b && b.type === "text")
      .map((b) => b.text)
      .join(" ");
  }
  return null;
}

interface SummaryMetrics {
  messageCount: number;
  lastMessage: string | null;
  firstMessage: string | null;
  model: string | null;
  createdAt: string;
  lastActiveAt: string;
  tokenCount: number;
  cost: number;
}

function deriveSummaryMetrics(entries: SessionEntry[], mtime: string): SummaryMetrics {
  let messageCount = 0;
  let lastMessage: string | null = null;
  let firstMessage: string | null = null;
  let model: string | null = null;
  let totalTokens = 0;
  let totalCost = 0;
  let lastActiveAt = "";
  let createdAt = "";

  for (const entry of entries) {
    if (entry.type === "message") {
      const msg = (entry as SessionMessageEntry).message;
      messageCount++;

      if (msg.role === "user") {
        const text = extractText((msg as UserMessage).content);
        if (text && !firstMessage) {
          firstMessage = text.slice(0, 200);
          createdAt = entry.timestamp || createdAt;
        }
        if (text) {
          lastMessage = text.slice(0, 200);
        }
        if (entry.timestamp) {
          lastActiveAt = entry.timestamp;
        }
      } else if (msg.role === "assistant") {
        const assistant = msg as AssistantMessage;
        if (assistant.model) {
          model = assistant.model;
        }
        if (assistant.usage) {
          totalTokens += assistant.usage.totalTokens ?? (assistant.usage.input + assistant.usage.output);
          totalCost += assistant.usage.cost.total ?? 0;
        }
        if (entry.timestamp) {
          lastActiveAt = entry.timestamp;
        }
      }
    } else if (entry.type === "session_info") {
      if (entry.timestamp) {
        lastActiveAt = entry.timestamp;
      }
    }
  }

  return {
    messageCount,
    lastMessage,
    model,
    firstMessage,
    createdAt,
    lastActiveAt: lastActiveAt || mtime,
    tokenCount: totalTokens,
    cost: totalCost,
  };
}

async function buildSessionSummary(filePath: string, mtime: string, info: SessionInfo): Promise<SessionSummary | null> {
  try {
    const manager = SessionManager.open(filePath);
    const header = manager.getHeader();
    const entries = manager.getEntries();

    const derived = deriveSummaryMetrics(entries, mtime);
    const timestamp = header?.timestamp ?? info.created.toISOString();
    const lastActive = derived.lastActiveAt || timestamp;
    const isRecentlyActive = Date.now() - new Date(lastActive).getTime() < 5 * 60 * 1000;

    return {
      id: info.id || basename(filePath, ".jsonl"),
      filePath: info.path,
      cwd: info.cwd || "",
      timestamp,
      name: info.name ?? null,
      messageCount: info.messageCount ?? derived.messageCount,
      lastMessage: derived.lastMessage,
      model: derived.model,
      firstMessage: derived.firstMessage ?? info.firstMessage ?? null,
      createdAt: derived.createdAt || info.created.toISOString(),
      lastActiveAt: lastActive,
      tokenCount: derived.tokenCount,
      cost: derived.cost,
      isRecentlyActive,
    };
  } catch (err) {
    console.warn(`[sessions] failed to summarize ${filePath}:`, err);
    return null;
  }
}

function refreshRecentlyActive(summary: SessionSummary): SessionSummary {
  const lastActive = summary.lastActiveAt || summary.timestamp;
  return {
    ...summary,
    isRecentlyActive: Date.now() - new Date(lastActive).getTime() < 5 * 60 * 1000,
  };
}

// ─── List Project Sessions ───

export async function listProjectSessions(projectPath: string): Promise<SessionSummary[]> {
  const infos = await collectSessionInfos(projectPath);

  // Unique by path; SDK list may overlap between default and local dirs.
  const byPath = new Map<string, SessionInfo>();
  for (const info of infos) {
    byPath.set(info.path, info);
  }

  // Collect mtimes for cache keying
  const mtimes = new Map<string, string>();
  for (const filePath of byPath.keys()) {
    try {
      const s = await stat(filePath);
      mtimes.set(filePath, s.mtime.toISOString());
    } catch {
      mtimes.set(filePath, new Date().toISOString());
    }
  }

  const index = await loadIndex(projectPath);
  const results: SessionSummary[] = [];
  const toParse: SessionInfo[] = [];

  for (const info of byPath.values()) {
    const filePath = info.path;
    const mtime = mtimes.get(filePath) || new Date().toISOString();
    const cached = index.entries[filePath];
    if (cached && cached.mtime === mtime) {
      results.push(refreshRecentlyActive(cached.summary));
    } else {
      toParse.push(info);
    }
  }

  if (toParse.length > 0) {
    const parsed = await Promise.all(
      toParse.map((info) => buildSessionSummary(info.path, mtimes.get(info.path) || new Date().toISOString(), info))
    );
    for (let i = 0; i < parsed.length; i++) {
      const summary = parsed[i];
      if (!summary) continue;
      results.push(summary);
      index.entries[toParse[i].path] = { mtime: mtimes.get(toParse[i].path) || summary.timestamp, summary };
    }
    await saveIndex(projectPath, index);
  }

  // Remove stale index entries
  const filePaths = new Set(byPath.keys());
  let indexChanged = false;
  for (const key of Object.keys(index.entries)) {
    if (!filePaths.has(key)) {
      delete index.entries[key];
      indexChanged = true;
    }
  }
  if (indexChanged) await saveIndex(projectPath, index);

  results.sort((a, b) => new Date(b.lastActiveAt || b.timestamp).getTime() - new Date(a.lastActiveAt || a.timestamp).getTime());
  return results;
}

// ─── Session Detail ───

export async function getSessionDetail(filePath: string): Promise<SessionDetail | null> {
  try {
    const manager = SessionManager.open(filePath);
    const header = manager.getHeader();
    const sdkEntries = manager.getEntries();

    const entries: SharedSessionEntry[] = sdkEntries.map(mapSdkEntry);

    return {
      id: header?.id ?? basename(filePath, ".jsonl"),
      filePath,
      cwd: header?.cwd ?? "",
      timestamp: header?.timestamp ?? "",
      name: manager.getSessionName() ?? null,
      version: header?.version ?? 1,
      entries,
    };
  } catch (err) {
    console.warn(`[sessions] failed to load detail ${filePath}:`, err);
    return null;
  }
}

function mapSdkEntry(entry: SessionEntry): SharedSessionEntry {
  const base: SharedSessionEntry = {
    id: entry.id,
    parentId: entry.parentId,
    type: entry.type,
    timestamp: entry.timestamp,
  };

  switch (entry.type) {
    case "message": {
      const msg = entry.message;
      base.message = normalizeMessage(msg);
      break;
    }
    case "model_change": {
      base.provider = entry.provider;
      base.modelId = entry.modelId;
      break;
    }
    case "thinking_level_change": {
      base.thinkingLevel = entry.thinkingLevel;
      break;
    }
    case "compaction": {
      base.summary = entry.summary;
      break;
    }
    case "branch_summary": {
      base.fromId = entry.fromId;
      base.summary = entry.summary;
      break;
    }
    case "label": {
      base.targetId = entry.targetId;
      base.label = entry.label;
      break;
    }
    case "custom": {
      base.customType = entry.customType;
      base.data = entry.data;
      break;
    }
    case "custom_message": {
      base.customType = entry.customType;
      base.content = entry.content;
      base.display = entry.display;
      base.data = entry.details;
      break;
    }
    case "session_info": {
      // name is surfaced at the session level, not on the entry itself.
      break;
    }
  }

  return base;
}

function normalizeContent(content: string | (TextContent | ImageContent)[] | (TextContent | ThinkingContent | ToolCall)[] | unknown): string | ContentBlock[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block): ContentBlock | null => {
      if (typeof block === "string") return { type: "text", text: block };
      if (!block || typeof block !== "object" || !("type" in block)) return null;
      const b = block as { type: string };
      switch (b.type) {
        case "text": {
          const t = b as TextContent;
          return { type: "text", text: t.text };
        }
        case "image": {
          const img = b as ImageContent;
          return { type: "image", data: img.data, mimeType: img.mimeType };
        }
        case "thinking": {
          const th = b as ThinkingContent;
          return { type: "thinking", thinking: th.thinking };
        }
        case "toolCall": {
          const tc = b as ToolCall;
          return { type: "toolCall", id: tc.id, name: tc.name, arguments: tc.arguments };
        }
      }
      return null;
    })
    .filter((c): c is ContentBlock => c !== null);
}

function normalizeMessage(msg: SessionMessageEntry["message"]): ChatMessage {
  const role = msg.role;
  const timestamp = typeof msg.timestamp === "number" ? new Date(msg.timestamp).toISOString() : new Date().toISOString();
  const base: ChatMessage = { role, content: "", timestamp };

  if (role === "user") {
    const user = msg as UserMessage;
    base.content = normalizeContent(user.content);
  } else if (role === "assistant") {
    const assistant = msg as AssistantMessage;
    base.content = normalizeContent(assistant.content);
    if (assistant.api) base.api = assistant.api;
    if (assistant.provider) base.provider = assistant.provider;
    if (assistant.model) base.model = assistant.model;
    if (assistant.usage) base.usage = assistant.usage;
    if (assistant.stopReason) base.stopReason = assistant.stopReason;
    if (assistant.errorMessage) base.errorMessage = assistant.errorMessage;
  } else if (role === "toolResult") {
    const tool = msg as ToolResultMessage;
    base.content = normalizeContent(tool.content);
    base.toolCallId = tool.toolCallId;
    base.toolName = tool.toolName;
    base.isError = tool.isError;
    if (tool.details) base.details = tool.details as Record<string, unknown>;
  } else if (role === "bashExecution") {
    const bash = msg as { command?: string; output?: string; exitCode?: number; cancelled?: boolean; truncated?: boolean; fullOutputPath?: string };
    base.content = bash.command ?? "";
    if (bash.command) base.command = bash.command;
    if (bash.output) base.output = bash.output;
    if (bash.exitCode !== undefined) base.exitCode = bash.exitCode;
    if (bash.cancelled !== undefined) base.cancelled = bash.cancelled;
    if (bash.truncated !== undefined) base.truncated = bash.truncated;
    if (bash.fullOutputPath) base.fullOutputPath = bash.fullOutputPath;
  } else if (role === "custom") {
    const custom = msg as { content: string | (TextContent | ImageContent)[]; details?: unknown };
    base.content = normalizeContent(custom.content);
    if (custom.details) base.details = custom.details as Record<string, unknown>;
  } else if (role === "branchSummary" || role === "compactionSummary") {
    const summaryMsg = msg as { summary?: string; tokensBefore?: number };
    base.content = summaryMsg.summary ?? "";
    if (summaryMsg.tokensBefore !== undefined) base.tokensBefore = summaryMsg.tokensBefore;
  }

  return base;
}

// ─── Helpers ───

function sanitizePath(p: string): string {
  const abs = resolve(normalize(p));
  let s = abs.replace(/^[\\/]/, "").replace(/[\\/]$/, "");
  s = s.replace(/[\\/:]/g, "-");
  return `--${s || "root"}--`;
}

// ─── Rename Session ───

export async function renameSession(filePath: string, name: string): Promise<void> {
  SessionManager.open(filePath).appendSessionInfo(name);
}

// ─── Aggregate usage across sessions ───

export interface ProjectSessionUsage {
  sessionCount: number;
  totalTokens: number;
  totalCost: number;
  totalMessages: number;
}

export function computeProjectUsage(sessions: SessionSummary[]): ProjectSessionUsage {
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

  for (const p of projects) {
    let sessions: SessionSummary[] = [];
    try {
      sessions = await listProjectSessions(p.path);
    } catch {
      sessions = [];
    }
    const u: ProjectSessionUsage = computeProjectUsage(sessions);
    perProject.push({ id: p.id, name: p.name, path: p.path, sessionCount: u.sessionCount, totalTokens: u.totalTokens, totalCost: u.totalCost, totalMessages: u.totalMessages });
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
