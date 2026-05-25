import { useState, useEffect, useCallback } from "react";
import { Icon } from "./Icon";
import { useIsMobile } from "../hooks/useIsMobile";

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
  if (!iso) return "";
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

// ─── Component ───

export function GitBlame({ cwd, path, onClose }: GitBlameProps) {
  const [lines, setLines] = useState<GitBlameLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMobile = useIsMobile();

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

  // Escape key to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

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
        <div className="flex-1 overflow-y-auto overflow-x-auto custom-scrollbar font-mono text-xs leading-5 bg-ink-950">
          {lines.map((bl, i) => {
            const first = isNewGroup(lines, i);
            return (
              <div
                key={i}
                className="flex border-b border-ink-800/30 hover:bg-ink-800/20 transition-theme"
              >
                {/* Left column: blame metadata — hidden on mobile to save space */}
                {!isMobile && (
                <div className="w-[120px] shrink-0 border-r border-ink-800/40 px-2 py-px select-none">
                  {first ? (
                    <div className="flex flex-col gap-px">
                      <span className="text-amber-400 font-medium truncate">{bl.hash}</span>
                      <span className="text-ink-400 truncate">{bl.author}</span>
                      <span className="text-ink-500">{shortDate(bl.date)}</span>
                    </div>
                  ) : (
                    <span className="text-ink-500">│</span>
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
                <div className="w-8 shrink-0 text-right pr-2 py-px select-none text-ink-500">
                  {bl.line}
                </div>

                {/* Line content */}
                <div className="flex-1 py-px whitespace-pre-wrap break-words text-ink-200 min-w-0 text-xs sm:text-sm">
                  {bl.content}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
