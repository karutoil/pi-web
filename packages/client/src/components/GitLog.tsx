import { useState, useEffect, useCallback, useRef } from "react";
import { Icon } from "./Icon";
import { ContextMenuPortal, ContextMenuItem, ContextMenuDivider, useLongPress } from "./ContextMenu";

// ─── Types ───

export interface GitLogEntry {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  message: string;
  refs?: string;
}

export interface GitLogProps {
  cwd: string;
  onRefresh: () => void;
}

interface RefBadge {
  label: string;
  type: "head" | "branch" | "tag" | "remote";
}

// ─── Ref parsing ───

function parseRefs(raw: string | undefined): RefBadge[] {
  if (!raw) return [];
  const refs: RefBadge[] = [];
  // git %d format: " (HEAD -> main, origin/main, tag: v1.0)"
  const content = raw.replace(/^\s*\(/, "").replace(/\)\s*$/, "");
  if (!content) return refs;

  const parts = content.split(",").map(s => s.trim()).filter(Boolean);
  for (const part of parts) {
    if (part.startsWith("tag: ")) {
      refs.push({ label: part.slice(5), type: "tag" });
    } else if (part === "HEAD") {
      refs.push({ label: "HEAD", type: "head" });
    } else if (part.startsWith("HEAD -> ")) {
      refs.push({ label: part.slice(8), type: "head" });
    } else if (part.includes("/")) {
      refs.push({ label: part, type: "remote" });
    } else {
      refs.push({ label: part, type: "branch" });
    }
  }
  return refs;
}

// Parse message + refs from the combined %s%d output
function splitMessageRefs(rawMessage: string): { message: string; refs: string } {
  // %d output starts with " (" if refs exist
  const match = rawMessage.match(/^(.*?)\s+\(([^)]*)\)\s*$/);
  if (match) return { message: match[1], refs: match[2] };
  return { message: rawMessage, refs: "" };
}

// ─── Ref badge styling ───

const REF_STYLES: Record<string, string> = {
  head: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  branch: "bg-sky-500/10 text-sky-400 border-sky-500/20",
  tag: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  remote: "bg-ink-600/20 text-ink-400 border-ink-600/30",
};

function RefBadges({ refs }: { refs: RefBadge[] }) {
  if (refs.length === 0) return null;
  return (
    <span className="inline-flex items-center gap-1 ml-1.5 flex-shrink-0 overflow-hidden">
      {refs.map((r, i) => (
        <span
          key={i}
          className={`inline-flex items-center px-1 py-px text-[0.6rem] font-mono border rounded ${REF_STYLES[r.type] || REF_STYLES.branch}`}
        >
          {r.type === "head" && <span className="mr-0.5">●</span>}
          {r.type === "tag" && <span className="mr-0.5">tag:</span>}
          {r.label}
        </span>
      ))}
    </span>
  );
}

// ─── Diff Viewer (shared style with GitPanel) ───

function CommitDiffViewer({ diff, hash, onClose }: { diff: string; hash: string; onClose: () => void }) {
  const lines = diff.split("\n");

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-ink-800/60 bg-ink-900/30 shrink-0">
        <button onClick={onClose} className="p-1 text-ink-400 hover:text-ink-300 hover:bg-ink-800/50 rounded transition-theme" aria-label="Close diff">
          <Icon name="chevron-left" size={12} />
        </button>
        <span className="text-amber-500/80 text-xs font-mono">{hash.slice(0, 7)}</span>
        <span className="text-ink-500 text-[0.6rem] font-mono">commit diff</span>
        <span className="flex-1" />
        <button onClick={onClose} className="px-2.5 py-1 text-xs text-ink-400 hover:text-ink-200 bg-ink-800/40 hover:bg-ink-800/60 rounded transition-theme">Back</button>
      </div>
      <div className="flex-1 overflow-y-auto custom-scrollbar font-mono text-xs leading-5 bg-ink-950">
        {lines.map((line, i) => {
          let cls = "text-ink-400";
          if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("diff ")) cls = "text-amber-500 font-bold";
          else if (line.startsWith("@@")) cls = "text-sky-400/60";
          else if (line.startsWith("+")) cls = "text-emerald-400";
          else if (line.startsWith("-")) cls = "text-rose-400";
          else if (line.startsWith("commit ")) cls = "text-amber-500/60";
          else if (line.startsWith("Author: ")) cls = "text-ink-300";
          else if (line.startsWith("Date: ")) cls = "text-ink-400";

          return (
            <div key={i} className={`px-3 whitespace-pre ${line.startsWith("+") && !line.startsWith("++") ? "bg-emerald-500/5" : line.startsWith("-") && !line.startsWith("--") ? "bg-rose-500/5" : ""}`}>
              <span className={cls}>{line}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Commit Row ───

function CommitRow({
  entry,
  expanded,
  onToggle,
  onContextMenu,
}: {
  entry: GitLogEntry;
  expanded: boolean;
  onToggle: () => void;
  onContextMenu: (e: React.MouseEvent, entry: GitLogEntry) => void;
}) {
  const { message, refs: rawRefs } = splitMessageRefs(entry.message);
  const refBadges = parseRefs(rawRefs || entry.refs);
  const longPress = useLongPress((e) => onContextMenu({ preventDefault: () => {}, clientX: e.clientX, clientY: e.clientY } as React.MouseEvent, entry));

  return (
    <div
      className={`border-b border-ink-800/20 transition-theme cursor-pointer ${
        expanded ? "bg-ink-900/40" : "hover:bg-ink-900/30"
      }`}
      onClick={onToggle}
      onContextMenu={e => onContextMenu(e, entry)}
      {...longPress}
    >
      <div className="px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-amber-500/70 text-[0.65rem] font-mono shrink-0">{entry.shortHash}</span>
          <span className="text-ink-200 text-xs truncate flex-1">{message}</span>
          <RefBadges refs={refBadges} />
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-ink-500 text-[0.65rem] font-mono">{entry.author}</span>
          <span
            className="text-ink-500 text-[0.65rem] font-mono"
            title={new Date(entry.date).toLocaleString()}
          >
            {formatRelativeDate(entry.date)}
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── Main GitLog Component ───

export function GitLog({ cwd, onRefresh }: GitLogProps) {
  const [log, setLog] = useState<GitLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [expandedHash, setExpandedHash] = useState<string | null>(null);
  const [commitDiff, setCommitDiff] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; entry: GitLogEntry } | null>(null);
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch log
  const fetchLog = useCallback(() => {
    if (!cwd) return;
    setLoading(true);
    fetch(`/api/git/log?cwd=${encodeURIComponent(cwd)}&count=100`)
      .then(r => r.json())
      .then(d => setLog(d.log || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [cwd]);

  useEffect(() => { fetchLog(); }, [fetchLog]);

  // Search with debounce
  useEffect(() => {
    if (!searchQuery.trim()) {
      fetchLog();
      return;
    }
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setSearching(true);
      fetch(`/api/git/log-search?cwd=${encodeURIComponent(cwd)}&query=${encodeURIComponent(searchQuery.trim())}`)
        .then(r => r.json())
        .then(d => setLog(d.log || []))
        .catch(() => {})
        .finally(() => setSearching(false));
    }, 300);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [searchQuery, cwd]);

  // Expand commit → fetch diff
  const handleExpand = useCallback(async (entry: GitLogEntry) => {
    if (expandedHash === entry.hash) {
      setExpandedHash(null);
      setCommitDiff(null);
      return;
    }
    setExpandedHash(entry.hash);
    setDiffLoading(true);
    setCommitDiff(null);
    try {
      const r = await fetch(`/api/git/show?cwd=${encodeURIComponent(cwd)}&hash=${encodeURIComponent(entry.hash)}`);
      const d = await r.json();
      setCommitDiff(d.diff || "");
    } catch {
      setCommitDiff("Failed to load diff");
    } finally {
      setDiffLoading(false);
    }
  }, [cwd, expandedHash]);

  // Close expanded
  const handleCloseDiff = useCallback(() => {
    setExpandedHash(null);
    setCommitDiff(null);
  }, []);

  // Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && expandedHash) {
        handleCloseDiff();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [expandedHash, handleCloseDiff]);

  // Context menu actions
  const handleCherryPick = useCallback(async (entry: GitLogEntry) => {
    setCtxMenu(null);
    setActionStatus(`Cherry-picking ${entry.shortHash}…`);
    try {
      const r = await fetch("/api/git/cherry-pick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, hash: entry.hash }),
      });
      const d = await r.json();
      if (d.error) setActionStatus(`Cherry-pick failed: ${d.error}`);
      else { setActionStatus(null); onRefresh(); fetchLog(); }
    } catch {
      setActionStatus("Cherry-pick failed");
    }
  }, [cwd, onRefresh, fetchLog]);

  const handleRevert = useCallback(async (entry: GitLogEntry) => {
    setCtxMenu(null);
    setActionStatus(`Reverting ${entry.shortHash}…`);
    try {
      const r = await fetch("/api/git/revert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, hash: entry.hash }),
      });
      const d = await r.json();
      if (d.error) setActionStatus(`Revert failed: ${d.error}`);
      else { setActionStatus(null); onRefresh(); fetchLog(); }
    } catch {
      setActionStatus("Revert failed");
    }
  }, [cwd, onRefresh, fetchLog]);

  const handleContextMenu = useCallback((e: React.MouseEvent, entry: GitLogEntry) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, entry });
  }, []);

  // Keyboard shortcut: / to focus search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "/" && !expandedHash && document.activeElement?.tagName !== "INPUT" && document.activeElement?.tagName !== "TEXTAREA") {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [expandedHash]);

  const expandedEntry = expandedHash ? log.find(e => e.hash === expandedHash) : null;

  return (
    <div className="flex flex-col h-full">
      {/* ── Search bar ── */}
      <div className="px-3 py-2 border-b border-ink-800/40 bg-ink-900/20 shrink-0">
        <div className="flex items-center gap-1.5 bg-ink-900/60 border border-ink-800/50 rounded-md px-2 py-1.5 focus-within:border-amber-500/40 transition-theme">
          <Icon name="search" size={12} className="text-ink-500 shrink-0" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search commits…"
            className="flex-1 bg-transparent text-ink-200 text-xs placeholder-ink-500 outline-none font-mono"
          />
          {searching && (
            <div className="w-3 h-3 border-2 border-ink-700 border-t-amber-500 rounded-full animate-spin shrink-0" />
          )}
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="text-ink-500 hover:text-ink-300 transition-theme shrink-0"
            >
              <Icon name="close" size={10} />
            </button>
          )}
        </div>
        <div className="flex items-center justify-between mt-1">
          <span className="text-ink-500 text-[0.6rem] font-mono">Press / to search</span>
          <span className="text-ink-500 text-[0.6rem] font-mono">{log.length} commits</span>
        </div>
      </div>

      {/* ── Action status toast ── */}
      {actionStatus && (
        <div className="px-3 py-1.5 bg-amber-600/10 border-b border-amber-600/20 text-amber-400 text-xs font-mono flex items-center gap-2 shrink-0">
          <div className="w-2.5 h-2.5 border-2 border-amber-700 border-t-amber-400 rounded-full animate-spin" />
          {actionStatus}
          <button onClick={() => setActionStatus(null)} className="ml-auto text-ink-500 hover:text-ink-300 transition-theme">
            <Icon name="close" size={10} />
          </button>
        </div>
      )}

      {/* ── Commit list / Diff view ── */}
      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
        {commitDiff && expandedEntry ? (
          <CommitDiffViewer diff={commitDiff} hash={expandedEntry.hash} onClose={handleCloseDiff} />
        ) : loading ? (
          <div className="flex items-center justify-center py-12 gap-2">
            <div className="w-3 h-3 border-2 border-ink-700 border-t-amber-500 rounded-full animate-spin" />
            <span className="text-ink-500 text-xs font-mono">Loading…</span>
          </div>
        ) : log.length === 0 ? (
          <div className="py-8 text-center text-ink-500 text-xs font-mono">
            {searchQuery ? "No commits match search" : "No commits found"}
          </div>
        ) : (
          log.map(entry => (
            <CommitRow
              key={entry.hash}
              entry={entry}
              expanded={expandedHash === entry.hash}
              onToggle={() => handleExpand(entry)}
              onContextMenu={handleContextMenu}
            />
          ))
        )}
      </div>

      {/* ── Diff loading overlay ── */}
      {diffLoading && !commitDiff && (
        <div className="absolute inset-0 flex items-center justify-center bg-ink-950/60 z-10">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 border-2 border-ink-700 border-t-amber-500 rounded-full animate-spin" />
            <span className="text-ink-400 text-xs font-mono">Loading diff…</span>
          </div>
        </div>
      )}

      {/* ── Context menu ── */}
      {ctxMenu && (
        <ContextMenuPortal x={ctxMenu.x} y={ctxMenu.y} onClose={() => setCtxMenu(null)}>
          <div className="px-2.5 py-1 text-[0.6rem] font-mono text-ink-500 truncate max-w-[200px]">
            {ctxMenu.entry.shortHash} {splitMessageRefs(ctxMenu.entry.message).message.slice(0, 30)}
          </div>
          <ContextMenuDivider />
          <ContextMenuItem
            label="Cherry-pick"
            icon={<span className="text-amber-400 text-[0.6rem]">🍒</span>}
            onClick={() => handleCherryPick(ctxMenu.entry)}
          />
          <ContextMenuItem
            label="Revert"
            icon={<span className="text-rose-400 text-[0.6rem]">↩</span>}
            danger
            onClick={() => handleRevert(ctxMenu.entry)}
          />
        </ContextMenuPortal>
      )}
    </div>
  );
}

// ─── Helpers ───

function formatRelativeDate(isoDate: string): string {
  const d = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return d.toLocaleDateString();
}
