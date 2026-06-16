import { readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { resolve, relative, normalize, isAbsolute, join } from "node:path";
import type { ReplaceChange } from "@pi-web/shared";
import { searchProject, applyReplace } from "./search";
import { getProject } from "../db";

export interface ReplaceOptions {
  projectId: string;
  query: string;
  replacement: string;
  useRegex?: boolean;
  paths?: string[];
  dryRun?: boolean;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  if (!rel) return true;
  const first = rel.split(/[/\\]/)[0];
  return first !== ".." && !isAbsolute(rel);
}

export async function previewReplace(options: ReplaceOptions): Promise<{ changes: ReplaceChange[]; errors: string[] }> {
  const search = await searchProject(options.projectId, { q: options.query, regex: options.useRegex, maxResults: 500 });
  if (!search.results.length) return { changes: [], errors: [] };
  return applyReplaceToPaths(options, search.results.map(r => r.path), true);
}

export async function executeReplace(options: ReplaceOptions): Promise<{ changedFiles: Array<{ path: string; replacements: number }>; errors: string[] }> {
  const { changes } = await applyReplaceToPaths(options, options.paths || [], false);
  const changed = changes.filter(c => c.replacements > 0).map(c => ({ path: c.path, replacements: c.replacements }));
  return { changedFiles: changed, errors: [] };
}

async function applyReplaceToPaths(options: ReplaceOptions, paths: string[], dryRun: boolean): Promise<{ changes: ReplaceChange[]; errors: string[] }> {
  const project = getProject(options.projectId);
  if (!project) return { changes: [], errors: ["Project not found"] };
  const projectBase = realpathSync(project.path);
  const changes: ReplaceChange[] = [];
  const errors: string[] = [];

  const targetPaths = paths.length > 0 ? paths : undefined;
  // If explicit paths provided, use them; otherwise search has already filtered.

  const affected = new Set(paths);
  for (const relPath of affected) {
    const normalized = normalize(relPath.replace(/^[/\\]+/, ""));
    const fullPath = resolve(projectBase, normalized);
    let realPath: string;
    try {
      realPath = realpathSync(fullPath);
    } catch (e: any) {
      errors.push(`${relPath}: ${e.message}`);
      continue;
    }
    if (!isInside(projectBase, realPath)) {
      errors.push(`${relPath}: outside project directory`);
      continue;
    }
    try {
      const original = await readFile(realPath, "utf-8");
      const { content, replacements } = applyReplace(original, options.query, options.replacement, !!options.useRegex, true);
      if (!dryRun) {
        if (replacements > 0) await writeFile(realPath, content, "utf-8");
      }
      changes.push({
        path: relPath,
        replacements,
        diff: replacements > 0 ? makeUnifiedDiff(relPath, original, content) : "",
      });
    } catch (e: any) {
      errors.push(`${relPath}: ${e.message}`);
    }
  }
  return { changes, errors };
}

function makeUnifiedDiff(path: string, original: string, modified: string): string {
  const oldLines = original.split("\n");
  const newLines = modified.split("\n");
  const head = `--- a/${path}\n+++ b/${path}\n`;
  const body: string[] = [];
  let i = 0;
  let oldStart = 0;
  let oldCount = 0;
  let newCount = 0;
  let inHunk = false;
  const flush = () => {
    if (!inHunk) return;
    body.push(`@@ -${oldStart + 1},${oldCount} +${oldStart + 1},${newCount} @@`);
    for (const line of hunkLines) body.push(line);
    hunkLines.length = 0;
    oldCount = 0;
    newCount = 0;
    inHunk = false;
  };
  const hunkLines: string[] = [];
  while (i < Math.max(oldLines.length, newLines.length)) {
    const a = oldLines[i];
    const b = newLines[i];
    if (i < oldLines.length && i < newLines.length && a === b) {
      flush();
      i++;
      continue;
    }
    if (!inHunk) {
      inHunk = true;
      oldStart = i;
    }
    if (i < oldLines.length && i < newLines.length) {
      hunkLines.push("-" + a);
      hunkLines.push("+" + b);
      oldCount++;
      newCount++;
    } else if (i < oldLines.length) {
      hunkLines.push("-" + a);
      oldCount++;
    } else {
      hunkLines.push("+" + b);
      newCount++;
    }
    i++;
  }
  flush();
  return head + body.join("\n");
}
