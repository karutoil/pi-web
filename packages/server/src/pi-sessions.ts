import { readdir, stat, readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import type { SessionSummary, SessionDetail, SessionEntry, ChatMessage } from "@pi-web/shared";

const SESSIONS_DIR = join(import.meta.dir, "..", ".sessions-cache");

export async function listProjectSessions(projectPath: string): Promise<SessionSummary[]> {
  // PI stores sessions in ~/.pi/agent/sessions/<sanitized-path>/
  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
  const sanitized = sanitizePath(projectPath);
  const sessionDir = join(home, ".pi", "agent", "sessions", sanitized);
  
  // Also check the project-local .pi/sessions if it exists
  const localSessionDir = join(projectPath, ".pi", "sessions");
  
  let allSessions: SessionSummary[] = [];
  
  for (const dir of [sessionDir, localSessionDir]) {
    try {
      const files = await readdir(dir);
      const jsonlFiles = files.filter(f => f.endsWith(".jsonl"));
      
      const summaries = await Promise.all(
        jsonlFiles.map(async (file) => {
          const filePath = join(dir, file);
          try {
            const s = await stat(filePath);
            return await parseSessionSummary(filePath, s.mtime.toISOString());
          } catch {
            return null;
          }
        })
      );
      
      for (const s of summaries) {
        if (s) allSessions.push(s);
      }
    } catch {
      // Directory doesn't exist, skip
    }
  }
  
  // Deduplicate by id and sort by timestamp desc
  const seen = new Set<string>();
  const unique = allSessions.filter(s => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });
  
  unique.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return unique;
}

async function parseSessionSummary(filePath: string, mtime: string): Promise<SessionSummary> {
  const content = await readFile(filePath, "utf-8");
  const lines = content.trim().split("\n");
  
  let header: any = null;
  let messageCount = 0;
  let lastMessage: string | null = null;
  let model: string | null = null;
  let name: string | null = null;
  
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
          if (text && (!lastMessage || entry.timestamp > (header?.timestamp || ""))) {
            lastMessage = text.slice(0, 200);
          }
        }
        if (msg.role === "assistant" && msg.model) {
          model = msg.model;
        }
      } else if (entry.type === "session_info" && entry.name) {
        name = entry.name;
      }
    } catch {
      // skip malformed lines
    }
  }
  
  return {
    id: header?.id || basename(filePath, ".jsonl"),
    filePath,
    cwd: header?.cwd || "",
    timestamp: header?.timestamp || mtime,
    name,
    messageCount,
    lastMessage,
    model,
  };
}

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
        
        if (entry.message) {
          sessionEntry.message = normalizeMessage(entry.message);
        }
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
      } catch {
        // skip
      }
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
  
  // Normalize content blocks
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
    if (entries[i].type === "session_info" && entries[i].name) {
      return entries[i].name;
    }
  }
  return null;
}

function sanitizePath(p: string): string {
  // PI session dirs are: --<path-with-dashes>--
  let s = p.replace(/^\//, "").replace(/\/$/, "");
  s = s.replace(/\//g, "-");
  return `--${s || "root"}--`;
}
