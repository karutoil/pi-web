import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { relative, isAbsolute, resolve as pathResolve, normalize } from "node:path";
import { getProject } from "../db";

export interface SearchOptions {
  q: string;
  regex?: boolean;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  glob?: string;
  exclude?: string;
  maxResults?: number;
}

export interface SearchResult {
  path: string;
  line: number;
  column: number;
  preview: string;
  matchRanges: Array<{ start: number; end: number }>;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  if (!rel) return true;
  const first = rel.split(/[/\\]/)[0];
  return first !== ".." && !isAbsolute(rel);
}

export async function searchProject(projectId: string, options: SearchOptions): Promise<{ results: SearchResult[]; truncated: boolean; error?: string }> {
  const project = getProject(projectId);
  if (!project) return { results: [], truncated: false, error: "Project not found" };
  const projectBase = realpathSync(project.path);

  const args = ["--json", "--line-number", "--column"];
  if (!options.regex) args.push("--fixed-strings");
  if (options.caseSensitive) args.push("--case-sensitive");
  if (options.wholeWord) args.push("--word-regexp");
  if (options.glob) args.push("--glob", options.glob);
  if (options.exclude) args.push("--glob", `!${options.exclude}`);
  args.push(options.q, ".");

  const maxResults = Math.max(1, Math.min(options.maxResults || 200, 500));

  return new Promise((resolve) => {
    const child = spawn("rg", args, { cwd: projectBase, timeout: 10_000 });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const maxBytes = 2 * 1024 * 1024;
    let trimmedResult = false;
    const collected: SearchResult[] = [];

    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");

    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > maxBytes && !killed) {
        killed = true;
        trimmedResult = true;
        child.kill();
      }
    });

    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (err) => {
      resolve({ results: collected, truncated: trimmedResult, error: err.message.includes("ENOENT") ? "ripgrep (rg) not found" : err.message });
    });

    child.on("close", () => {
      const lines = stdout.split("\n");
      for (const line of lines) {
        if (collected.length >= maxResults) {
          trimmedResult = true;
          break;
        }
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.type !== "match" || !parsed.data) continue;
          const absPath = pathResolve(projectBase, parsed.data.path.text);
          const real = realpathSync(absPath);
          if (!isInside(projectBase, real)) continue;
          const text: string = parsed.data.lines.text.replace(/\r?\n$/, "");
          const result: SearchResult = {
            path: relative(projectBase, real),
            line: parsed.data.line_number ?? 1,
            column: parsed.data.submatches?.[0]?.start ?? 0,
            preview: text,
            matchRanges: (parsed.data.submatches || []).map((m: { start: number; end: number }) => ({ start: m.start, end: m.end })),
          };
          collected.push(result);
        } catch {
          // Ignore malformed JSON lines
        }
      }
      const error = stderr.trim().slice(0, 200) || undefined;
      resolve({ results: collected, truncated: trimmedResult, error });
    });
  });
}

export function applyReplace(content: string, query: string, replacement: string, useRegex: boolean, global = false): { content: string; replacements: number } {
  let count = 0;
  if (useRegex) {
    const flags = global ? "g" : "";
    const re = new RegExp(query, flags);
    const result = content.replace(re, () => { count++; return replacement; });
    return { content: result, replacements: count };
  }
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(escaped, global ? "g" : "");
  const out = content.replace(re, () => { count++; return replacement; });
  return { content: out, replacements: count };
}
