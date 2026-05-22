import { useState, useEffect, useRef, useCallback } from "react";
import { Icon } from "./Icon";

// ─── Types ───

interface GitFile {
  path: string;
  status: string;
  oldPath?: string;
}

interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  staged: GitFile[];
  unstaged: GitFile[];
  untracked: string[];
  stashCount: number;
  headCommit: string | null;
  headMessage: string | null;
}

interface GitLogEntry {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  message: string;
}

type ViewMode = "changes" | "log";

// ─── Status badge colors ───

const STATUS_COLORS: Record<string, string> = {
  M: "text-amber-400",     // Modified
  A: "text-emerald-400",   // Added
  D: "text-rose-400",      // Deleted
  R: "text-sky-400",       // Renamed
  C: "text-sky-400",       // Copied
  U: "text-rose-500",      // Unmerged
  "?": "text-ink-400",     // Untracked
};

const STATUS_LABELS: Record<string, string> = {
  M: "M", A: "A", D: "D", R: "R", C: "C", U: "U", "?": "U",
};

// ─── Diff Viewer ───

function DiffViewer({ diff, path, onClose }: { diff: string; path: string; onClose: () => void }) {
  const lines = diff.split("\n");

  // Escape to close diff
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
        <button onClick={onClose} className="p-1 text-ink-500 hover:text-ink-300 hover:bg-ink-800/50 rounded transition-theme" aria-label="Close diff">
          <Icon name="chevron-left" size={12} />
        </button>
        <span className="text-ink-200 text-xs font-mono truncate flex-1">{path}</span>
        <button onClick={onClose} className="px-2.5 py-1 text-xs text-ink-400 hover:text-ink-200 bg-ink-800/40 hover:bg-ink-800/60 rounded transition-theme">Back</button>
      </div>
      <div className="flex-1 overflow-y-auto custom-scrollbar font-mono text-xs leading-5 bg-ink-950">
        {lines.map((line, i) => {
          let cls = "text-ink-400";
          if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("diff ")) cls = "text-amber-500 font-bold";
          else if (line.startsWith("@@")) cls = "text-sky-400/60";
          else if (line.startsWith("+")) cls = "text-emerald-400";
          else if (line.startsWith("-")) cls = "text-rose-400";

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

// ─── Git Panel ───

interface GitPanelProps {
  cwd: string | null;
  visible: boolean;
  onClose: () => void;
}

export function GitPanel({ cwd, visible, onClose }: GitPanelProps) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>("changes");
  const [log, setLog] = useState<GitLogEntry[]>([]);
  const [commitMsg, setCommitMsg] = useState("");
  const [diffView, setDiffView] = useState<{ path: string; staged: boolean; diff: string } | null>(null);
  const [expandedStaged, setExpandedStaged] = useState(true);
  const [expandedChanges, setExpandedChanges] = useState(true);
  const [committing, setCommitting] = useState(false);
  const [width, setWidth] = useState(340);
  const isResizing = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  // Fetch status
  const refresh = useCallback(() => {
    if (!cwd || !visible) return;
    setLoading(true);
    setError(null);
    fetch(`/api/git/status?cwd=${encodeURIComponent(cwd)}`)
      .then(r => r.json())
      .then(d => {
        if (d.error) { setError(d.error); setStatus(null); }
        else setStatus(d);
      })
      .catch(() => setError("Failed to fetch git status"))
      .finally(() => setLoading(false));
  }, [cwd, visible]);

  useEffect(() => { refresh(); }, [refresh]);

  // Fetch log when switching to log view
  useEffect(() => {
    if (view === "log" && cwd && visible) {
      fetch(`/api/git/log?cwd=${encodeURIComponent(cwd)}&count=50`)
        .then(r => r.json())
        .then(d => setLog(d.log || []))
        .catch(() => {});
    }
  }, [view, cwd, visible]);

  // Resize handler
  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    startX.current = e.clientX;
    startWidth.current = width;

    const handleMouseMove = (ev: MouseEvent) => {
      const delta = startX.current - ev.clientX;
      setWidth(Math.max(260, Math.min(600, startWidth.current + delta)));
    };
    const handleMouseUp = () => {
      isResizing.current = false;
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  }, [width]);

  // Actions
  const handleStage = useCallback(async (path: string) => {
    if (!cwd) return;
    await fetch("/api/git/stage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd, path }) });
    refresh();
  }, [cwd, refresh]);

  const handleUnstage = useCallback(async (path: string) => {
    if (!cwd) return;
    await fetch("/api/git/unstage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd, path }) });
    refresh();
  }, [cwd, refresh]);

  const handleStageAll = useCallback(async () => {
    if (!cwd) return;
    await fetch("/api/git/stage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd, path: "-A" }) });
    refresh();
  }, [cwd, refresh]);

  const handleDiscard = useCallback(async (path: string) => {
    if (!cwd) return;
    await fetch("/api/git/discard", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd, path }) });
    refresh();
  }, [cwd, refresh]);

  const handleCommit = useCallback(async () => {
    if (!cwd || !commitMsg.trim()) return;
    setCommitting(true);
    const result = await fetch("/api/git/commit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd, message: commitMsg.trim() }) });
    if (result.ok) { setCommitMsg(""); refresh(); }
    setCommitting(false);
  }, [cwd, commitMsg, refresh]);

  const handleViewDiff = useCallback(async (path: string, staged: boolean) => {
    if (!cwd) return;
    const r = await fetch(`/api/git/diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}&staged=${staged}`);
    const d = await r.json();
    setDiffView({ path, staged, diff: d.diff || "" });
  }, [cwd]);

  // Keyboard shortcut: Escape to close
  useEffect(() => {
    if (!visible) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !diffView) onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [visible, onClose, diffView]);

  if (!visible || !cwd) return null;

  const totalChanges = (status?.staged.length || 0) + (status?.unstaged.length || 0) + (status?.untracked.length || 0);

  return (
    <div
      className="flex flex-col bg-ink-950 border-l border-ink-800/60 shrink-0 select-none h-full"
      style={{ width: `${width}px` }}
    >
      {/* ── Resize handle ── */}
      <div
        className="w-1 cursor-ew-resize absolute left-0 top-0 bottom-0 z-10 hover:bg-amber-500/20 transition-theme"
        onMouseDown={handleResizeMouseDown}
      />

      {/* ── Header ── */}
      <div className="px-3 py-2.5 border-b border-ink-800/60 bg-ink-900/20 shrink-0">
        <div className="flex items-center gap-2 mb-1.5">
          <Icon name="git" size={14} className="text-amber-500" />
          <span className="text-ink-200 text-xs font-semibold tracking-wide flex-1">Source Control</span>
          <button onClick={refresh} className="p-1 text-ink-600 hover:text-amber-500 transition-theme rounded hover:bg-ink-800/50" aria-label="Refresh" title="Refresh">
            <Icon name="refresh" size={12} />
          </button>
          <button onClick={onClose} className="p-1 text-ink-600 hover:text-ink-300 transition-theme rounded hover:bg-ink-800/50" aria-label="Close panel">
            <Icon name="close" size={12} />
          </button>
        </div>

        {status && (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-amber-400 font-mono font-medium">{status.branch}</span>
            {(status.ahead > 0 || status.behind > 0) && (
              <span className="text-ink-500 font-mono">
                {status.ahead > 0 && `↑${status.ahead}`} {status.behind > 0 && `↓${status.behind}`}
              </span>
            )}
            {status.stashCount > 0 && (
              <span className="text-ink-500 font-mono" title={`${status.stashCount} stash(es)`}>📚{status.stashCount}</span>
            )}
            {status.headCommit && (
              <span className="text-ink-600 font-mono truncate" title={status.headMessage || undefined}>{status.headCommit}</span>
            )}
          </div>
        )}
      </div>

      {/* ── View tabs ── */}
      <div className="flex border-b border-ink-800/40 shrink-0">
        <button
          onClick={() => setView("changes")}
          className={`flex-1 py-2 text-xs font-medium transition-theme border-b-2 ${
            view === "changes" ? "text-amber-400 border-b-amber-500" : "text-ink-500 border-b-transparent hover:text-ink-300"
          }`}
        >
          Changes {totalChanges > 0 && <span className="text-ink-600 ml-1">({totalChanges})</span>}
        </button>
        <button
          onClick={() => setView("log")}
          className={`flex-1 py-2 text-xs font-medium transition-theme border-b-2 ${
            view === "log" ? "text-amber-400 border-b-amber-500" : "text-ink-500 border-b-transparent hover:text-ink-300"
          }`}
        >
          Log
        </button>
      </div>

      {/* ── Content ── */}
      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
        {diffView ? (
          <DiffViewer diff={diffView.diff} path={diffView.path} onClose={() => setDiffView(null)} />
        ) : view === "changes" ? (
          <ChangesView
            status={status}
            loading={loading}
            error={error}
            expandedStaged={expandedStaged}
            expandedChanges={expandedChanges}
            onToggleStaged={() => setExpandedStaged(v => !v)}
            onToggleChanges={() => setExpandedChanges(v => !v)}
            onStage={handleStage}
            onStageAll={handleStageAll}
            onUnstage={handleUnstage}
            onDiscard={handleDiscard}
            onViewDiff={handleViewDiff}
          />
        ) : (
          <LogView log={log} />
        )}
      </div>

      {/* ── Commit input ── */}
      {view === "changes" && (
        <div className="px-3 py-2.5 border-t border-ink-800/60 bg-ink-900/20 shrink-0">
          <textarea
            value={commitMsg}
            onChange={e => setCommitMsg(e.target.value)}
            placeholder="Commit message"
            rows={2}
            className="w-full bg-ink-900/60 border border-ink-800/50 rounded-md px-2.5 py-1.5 text-ink-200 text-xs placeholder-ink-600 outline-none focus:border-amber-500/50 resize-none transition-theme font-mono"
            onKeyDown={e => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleCommit(); }
            }}
          />
          <div className="flex items-center gap-1.5 mt-1.5">
            <button
              onClick={handleCommit}
              disabled={!commitMsg.trim() || committing || !status?.staged.length}
              className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-theme ${
                commitMsg.trim() && status?.staged.length && !committing
                  ? "bg-amber-600 hover:bg-amber-500 text-ink-950"
                  : "bg-ink-800/40 text-ink-600 cursor-not-allowed"
              }`}
            >
              {committing ? "Committing…" : "Commit"}
            </button>
            <span className="text-ink-700 text-[0.6rem] font-mono">⌘↵</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Changes View ───

function ChangesView({ status, loading, error, expandedStaged, expandedChanges, onToggleStaged, onToggleChanges, onStage, onStageAll, onUnstage, onDiscard, onViewDiff }: {
  status: GitStatus | null;
  loading: boolean;
  error: string | null;
  expandedStaged: boolean;
  expandedChanges: boolean;
  onToggleStaged: () => void;
  onToggleChanges: () => void;
  onStage: (path: string) => void;
  onStageAll: () => void;
  onUnstage: (path: string) => void;
  onDiscard: (path: string) => void;
  onViewDiff: (path: string, staged: boolean) => void;
}) {
  if (loading && !status) {
    return (
      <div className="flex items-center justify-center py-12 gap-2">
        <div className="w-3 h-3 border-2 border-ink-700 border-t-amber-500 rounded-full animate-spin" />
        <span className="text-ink-500 text-xs font-mono">Loading…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-8 text-center">
        <span className="text-rose-400/80 text-xs font-mono">{error}</span>
      </div>
    );
  }

  if (!status) return null;

  return (
    <div>
      {/* Staged changes */}
      {status.staged.length > 0 && (
        <div>
          <button
            onClick={onToggleStaged}
            className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-ink-300 hover:bg-ink-900/30 transition-theme"
          >
            <Icon name={expandedStaged ? "chevron-down" : "chevron-right"} size={8} />
            Staged Changes
            <span className="text-ink-600 font-normal ml-auto">{status.staged.length}</span>
          </button>
          {expandedStaged && status.staged.map(f => (
            <FileRow
              key={`staged-${f.path}`}
              file={f}
              staged
              onUnstage={onUnstage}
              onViewDiff={onViewDiff}
            />
          ))}
        </div>
      )}

      {/* Unstaged changes */}
      {(status.unstaged.length > 0 || status.untracked.length > 0) && (
        <div>
          <button
            onClick={onToggleChanges}
            className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-ink-300 hover:bg-ink-900/30 transition-theme"
          >
            <Icon name={expandedChanges ? "chevron-down" : "chevron-right"} size={8} />
            Changes
            <span className="text-ink-600 font-normal ml-auto">{status.unstaged.length + status.untracked.length}</span>
            {status.unstaged.length + status.untracked.length > 0 && (
              <button
                onClick={(e) => { e.stopPropagation(); onStageAll(); }}
                className="text-ink-600 hover:text-amber-500 transition-theme ml-1 p-0.5"
                aria-label="Stage all changes"
                title="Stage all"
              >
                <Icon name="plus" size={10} />
              </button>
            )}
          </button>
          {expandedChanges && (
            <>
              {status.unstaged.map(f => (
                <FileRow
                  key={`unstaged-${f.path}`}
                  file={f}
                  onStage={onStage}
                  onDiscard={onDiscard}
                  onViewDiff={onViewDiff}
                />
              ))}
              {status.untracked.map(path => (
                <FileRow
                  key={`untracked-${path}`}
                  file={{ path, status: "?" }}
                  onStage={onStage}
                  onViewDiff={onViewDiff}
                />
              ))}
            </>
          )}
        </div>
      )}

      {/* Empty state */}
      {status.staged.length === 0 && status.unstaged.length === 0 && status.untracked.length === 0 && (
        <div className="py-12 text-center">
          <p className="text-ink-600 text-xs font-mono">No changes detected</p>
          <p className="text-ink-700 text-[0.65rem] font-mono mt-1">Working tree clean</p>
        </div>
      )}
    </div>
  );
}

// ─── File Row ───

function FileRow({ file, staged, onStage, onUnstage, onDiscard, onViewDiff }: {
  file: GitFile;
  staged?: boolean;
  onStage?: (path: string) => void;
  onUnstage?: (path: string) => void;
  onDiscard?: (path: string) => void;
  onViewDiff: (path: string, staged: boolean) => void;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      className="flex items-center gap-1 px-3 py-1 hover:bg-ink-900/30 transition-theme group cursor-pointer"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => onViewDiff(file.path, !!staged)}
    >
      {/* Status badge */}
      <span className={`text-[0.6rem] font-mono font-bold w-3 text-center shrink-0 ${STATUS_COLORS[file.status] || "text-ink-500"}`}>
        {STATUS_LABELS[file.status] || file.status}
      </span>

      {/* Path */}
      <span className="text-ink-300 text-xs truncate flex-1 font-mono" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
        {file.path.split("/").map((segment, i, arr) => (
          <span key={i}>
            {i < arr.length - 1 ? (
              <span className="text-ink-600">{segment}/</span>
            ) : (
              segment
            )}
          </span>
        ))}
      </span>

      {/* Action buttons on hover */}
      {hovered && (
        <div className="flex items-center gap-0.5 shrink-0">
          {staged && onUnstage && (
            <button
              onClick={(e) => { e.stopPropagation(); onUnstage(file.path); }}
              className="p-0.5 text-ink-500 hover:text-amber-500 transition-theme"
              aria-label="Unstage"
              title="Unstage"
            >
              <Icon name="minus" size={10} />
            </button>
          )}
          {!staged && onStage && (
            <button
              onClick={(e) => { e.stopPropagation(); onStage(file.path); }}
              className="p-0.5 text-ink-500 hover:text-amber-500 transition-theme"
              aria-label="Stage"
              title="Stage"
            >
              <Icon name="plus" size={10} />
            </button>
          )}
          {!staged && onDiscard && file.status !== "?" && (
            <button
              onClick={(e) => { e.stopPropagation(); onDiscard(file.path); }}
              className="p-0.5 text-ink-500 hover:text-rose-400 transition-theme"
              aria-label="Discard changes"
              title="Discard"
            >
              <Icon name="undo" size={10} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Log View ───

function LogView({ log }: { log: GitLogEntry[] }) {
  if (log.length === 0) {
    return <div className="py-8 text-center text-ink-600 text-xs font-mono">No commits found</div>;
  }

  return (
    <div>
      {log.map(entry => (
        <div key={entry.hash} className="px-3 py-2 hover:bg-ink-900/30 transition-theme border-b border-ink-800/20">
          <div className="flex items-center gap-2">
            <span className="text-amber-500/70 text-[0.65rem] font-mono shrink-0">{entry.shortHash}</span>
            <span className="text-ink-200 text-xs truncate flex-1">{entry.message}</span>
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-ink-600 text-[0.65rem] font-mono">{entry.author}</span>
            <span className="text-ink-700 text-[0.65rem] font-mono">{formatRelativeDate(entry.date)}</span>
          </div>
        </div>
      ))}
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
