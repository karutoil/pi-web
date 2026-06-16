import { useState, useEffect, useMemo } from "react";
import { Icon } from "./Icon";
import { useIsMobile } from "../hooks/useIsMobile";
import { useTheme } from "../hooks/useTheme";
import { codeToHtml, getFiletypeFromFileName } from "@pierre/diffs";
import "../themes/piDiffTheme";

// ─── Types ───

export interface GitBlameLine {
  hash: string;
  author: string;
  date: string;
  line: number;
  content: string;
}

interface GitBlameProps {
  cwd: string;
  path: string;
  onClose: () => void;
}

// ─── Helpers ───

/** Format ISO date to short readable form (e.g. "2024-03-15") */
function shortDate(iso: string): string {
  if (!iso || iso === "null") return "";
  try {
    const d = new Date(iso);
    return d.toISOString().slice(0, 10);
  } catch {
    return iso;
  }
}

/** Determine if this line starts a new blame group (different hash from previous) */
function isNewGroup(lines: GitBlameLine[], index: number): boolean {
  if (index === 0) return true;
  return lines[index].hash !== lines[index - 1].hash;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Generate a consistent, subtle background color for a blame group from its hash.
 * We use hue from the hash and keep low saturation so it stays theme-agnostic.
 */
function groupColor(hash: string, dark: boolean): string {
  let hue = 0;
  for (let i = 0; i < hash.length; i++) {
    hue = (hue + hash.charCodeAt(i) * 37) % 360;
  }
  return dark
    ? `hsla(${hue}, 55%, 30%, 0.18)`
    : `hsla(${hue}, 60%, 82%, 0.35)`;
}

// ─── Component ───

export function GitBlame({ cwd, path, onClose }: GitBlameProps) {
  const [lines, setLines] = useState<GitBlameLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [highlights, setHighlights] = useState<Map<number, string>>(new Map());
  const [theme] = useTheme();
  const isMobile = useIsMobile();
  const isDark = theme === "dark";

  // Fetch blame data
  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/git/blame?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(d => {
        setLines(d.blame || []);
        setLoading(false);
      })
      .catch(err => {
        setError(err.message);
        setLoading(false);
      });
  }, [cwd, path]);

  // Syntax-highlight the full file, then split into per-line HTML.
  useEffect(() => {
    setHighlights(new Map());
    if (lines.length === 0) return;

    let canceled = false;
    const contents = lines.map(l => l.content).join("\n");
    const lang = getFiletypeFromFileName(path) ?? "text";

    (async () => {
      try {
        const html = await codeToHtml(contents, {
          lang,
          theme: isDark ? "pi-web-diff-dark" : "pi-web-diff-light",
          structure: "classic",
        });
        if (canceled) return;
        const doc = new DOMParser().parseFromString(html, "text/html");
        const spans = doc.querySelectorAll("code > .line");
        const map = new Map<number, string>();
        spans.forEach((el, i) => {
          const lineNum = lines[i]?.line ?? i + 1;
          map.set(lineNum, el.innerHTML);
        });
        setHighlights(map);
      } catch {
        const fallback = new Map<number, string>();
        lines.forEach(l => fallback.set(l.line, escapeHtml(l.content)));
        setHighlights(fallback);
      }
    })();

    return () => { canceled = true; };
  }, [lines, path, isDark]);

  // Escape key to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const groupIndexMap = useMemo(() => {
    const map = new Map<number, number>();
    let group = -1;
    lines.forEach((line, i) => {
      if (isNewGroup(lines, i)) group++;
      map.set(line.line, group);
    });
    return map;
  }, [lines]);

  // ── Render ──

  return (
    <div className="flex flex-col h-full">
      {/* Header bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-ink-800/60 bg-ink-900/30 shrink-0">
        <button
          onClick={onClose}
          className="p-1 text-ink-400 hover:text-ink-300 hover:bg-ink-800/50 rounded transition-theme touch-target"
          aria-label="Close blame"
        >
          <Icon name="chevron-left" size={12} />
        </button>
        <span className="text-ink-200 text-xs font-mono truncate flex-1">{path}</span>
        <button
          onClick={onClose}
          className="px-2.5 py-1 text-xs text-ink-400 hover:text-ink-200 bg-ink-800/40 hover:bg-ink-800/60 rounded transition-theme"
        >
          Back
        </button>
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 border-2 border-ink-700 border-t-amber-500 rounded-full animate-spin" />
            <span className="text-ink-500 text-xs font-mono">Loading blame…</span>
          </div>
        </div>
      ) : error ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-rose-400 text-xs font-mono">{error}</p>
        </div>
      ) : lines.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-ink-500 text-xs font-mono">No blame data</p>
        </div>
      ) : (
        <div className="flex-1 overflow-auto custom-scrollbar font-mono text-sm leading-5 bg-ink-950">
          {lines.map((bl, i) => {
            const first = isNewGroup(lines, i);
            const group = groupIndexMap.get(bl.line) ?? 0;
            const groupBg = groupColor(bl.hash, isDark);
            return (
              <div
                key={bl.line}
                className="flex border-b border-ink-800/30 hover:brightness-110 transition-theme"
                style={{ backgroundColor: groupBg }}
              >
                {/* Left column: blame metadata — hidden on mobile to save space */}
                {!isMobile && (
                  <div className="w-[132px] shrink-0 border-r border-ink-800/40 px-2 py-px select-none">
                    {first ? (
                      <div className="flex flex-col gap-px">
                        <span className="text-amber-400 font-medium truncate text-xs">{bl.hash}</span>
                        <span className="text-ink-300 truncate text-xs">{bl.author}</span>
                        <span className="text-ink-500 text-xs">{shortDate(bl.date)}</span>
                      </div>
                    ) : (
                      <span className="text-ink-600 text-xs">│</span>
                    )}
                  </div>
                )}

                {/* Mobile: compact inline metadata */}
                {isMobile && first && (
                  <div className="shrink-0 px-2 py-px select-none border-r border-ink-800/40">
                    <span className="text-amber-400 text-[0.7rem] sm:text-xs font-medium">{bl.hash.slice(0, 7)}</span>
                    <span className="text-ink-500 text-[0.65rem] sm:text-xs ml-1">{bl.author.split(" ")[0]}</span>
                  </div>
                )}

                {/* Line number */}
                <div className="w-10 shrink-0 text-right pr-2 py-px select-none text-ink-500 text-xs">
                  {bl.line}
                </div>

                {/* Line content */}
                <div
                  className="flex-1 py-px whitespace-pre-wrap break-words text-ink-200 min-w-0"
                  dangerouslySetInnerHTML={{ __html: highlights.get(bl.line) ?? escapeHtml(bl.content) }}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
