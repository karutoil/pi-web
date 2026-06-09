import { useState, useEffect, useRef, useCallback } from "react";
import { Icon } from "./Icon";
import { GitStash } from "./GitStash";
import { GitLog } from "./GitLog";
import { GitBlame } from "./GitBlame";
import { GitBranchSelector } from "./GitBranchSelector";
import { useIsMobile } from "../hooks/useIsMobile";
import { useResizable } from "../hooks/useResizable";

// ─── Types ───

interface GitFile {
  path: string;
  status: string;
  oldPath?: string;
}

interface GitDiffStats {
  additions: number;
  deletions: number;
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

type ViewMode = "changes" | "log";

// ─── Status badge colors — theme-aware tokens ───

const STATUS_COLORS: Record<string, string> = {
  M: "text-amber-500",
  A: "text-teal-400",
  D: "text-rose-400",
  R: "text-sky-400",
  C: "text-sky-400",
  U: "text-rose-500",
  "?": "text-ink-400",
};

const STATUS_LABELS: Record<string, string> = {
  M: "M", A: "A", D: "D", R: "R", C: "C", U: "U", "?": "U",
};

// ─── Diff Viewer ───

function DiffViewer({ diff, path, onClose, showBlame, showComparePrev }: {
  diff: string;
  path: string;
  onClose: () => void;
  showBlame?: (path: string) => void;
  showComparePrev?: (path: string) => void;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const lines = diff.split("\n");

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-ink-800/40 bg-ink-900/30 shrink-0">
        <button onClick={onClose} className="p-1 text-ink-400 hover:text-ink-300 hover:bg-ink-800/50 rounded transition-theme" aria-label="Back">
          <Icon name="chevron-left" size={12} />
        </button>
        <span className="text-ink-200 text-xs font-mono truncate flex-1">{path}</span>
        {showBlame && (
          <button onClick={() => showBlame(path)} className="px-2 py-0.5 text-[0.65rem] text-ink-400 hover:text-amber-500 bg-ink-800/30 hover:bg-ink-800/60 rounded transition-theme">Blame</button>
        )}
        {showComparePrev && (
          <button onClick={() => showComparePrev(path)} className="px-2 py-0.5 text-[0.65rem] text-ink-400 hover:text-amber-500 bg-ink-800/30 hover:bg-ink-800/60 rounded transition-theme">Compare with Prev</button>
        )}
        <button onClick={onClose} className="px-2.5 py-1 text-xs text-ink-400 hover:text-ink-200 bg-ink-800/40 hover:bg-ink-800/60 rounded transition-theme">Back</button>
      </div>
      <div className="flex-1 overflow-y-auto overflow-x-auto custom-scrollbar font-mono text-xs leading-5 bg-ink-950/40">
        {lines.map((line, i) => {
          let cls = "text-ink-400";
          if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("diff ")) cls = "text-amber-500 font-bold";
          else if (line.startsWith("@@")) cls = "text-ink-500/60";
          else if (line.startsWith("+")) cls = "text-teal-400";
          else if (line.startsWith("-")) cls = "text-rose-400";

          return (
            <div key={i} className={`px-3 whitespace-pre ${line.startsWith("+") && !line.startsWith("++") ? "bg-teal-500/5" : line.startsWith("-") && !line.startsWith("--") ? "bg-rose-500/5" : ""}`}>
              <span className={cls}>{line}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Conflict Resolution Banner ───

function ConflictBanner({ path, onResolve }: { path: string; onResolve: (strategy: "ours" | "theirs" | "both") => void }) {
  return (
    <div className="px-3 py-2 bg-rose-400/5 border-b border-rose-400/20">
      <p className="text-rose-400 text-xs font-mono mb-1.5">Merge conflict: {path}</p>
      <div className="flex gap-1.5">
        <button onClick={() => onResolve("ours")} className="px-2.5 py-1.5 text-xs min-h-[36px] bg-ink-800/60 hover:bg-ink-800 text-ink-300 hover:text-ink-100 rounded transition-theme">Accept Current</button>
        <button onClick={() => onResolve("theirs")} className="px-2.5 py-1.5 text-xs min-h-[36px] bg-ink-800/60 hover:bg-ink-800 text-ink-300 hover:text-ink-100 rounded transition-theme">Accept Incoming</button>
        <button onClick={() => onResolve("both")} className="px-2.5 py-1.5 text-xs min-h-[36px] bg-ink-800/60 hover:bg-ink-800 text-ink-300 hover:text-ink-100 rounded transition-theme">Accept Both</button>
      </div>
    </div>
  );
}

// ─── Git Panel — right-side panel matching PreviewPanel styling ───

interface GitPanelProps {
  cwd: string | null;
  visible: boolean;
  onClose: () => void;
  embedded?: boolean;
  width?: number;
}

export function GitPanel({ cwd, visible, onClose, embedded = false, width }: GitPanelProps) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>("changes");
  const [commitMsg, setCommitMsg] = useState("");
  const [amend, setAmend] = useState(false);
  const [diffView, setDiffView] = useState<{ path: string; staged: boolean; diff: string } | null>(null);
  const [blameView, setBlameView] = useState<string | null>(null);
  const [compareRef, setCompareRef] = useState<string | null>(null);
  const [expandedStaged, setExpandedStaged] = useState(true);
  const [expandedChanges, setExpandedChanges] = useState(true);
  const [committing, setCommitting] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [diffStats, setDiffStats] = useState<Map<string, GitDiffStats>>(new Map());
  const isMobile = useIsMobile();

  const { width: resizableWidth, isDragging, handleMouseDown } = useResizable({
    defaultWidth: embedded ? (width ?? 380) : 380,
    minWidth: 260,
    maxWidth: typeof window !== "undefined" ? window.innerWidth * 0.7 : 600,
    persistKey: embedded ? undefined : "pi-git-width",
  });
  const panelWidth = embedded ? "100%" : resizableWidth;

  // Fetch status
  const refresh = useCallback(() => {
    if (!cwd || !visible) return;
    setLoading(true);
    setError(null);
    fetch(`/api/git/status?cwd=${encodeURIComponent(cwd)}`)
      .then(r => r.json())
      .then(d => {
        if (d.error) { setError(d.error); setStatus(null); }
        else {
          setStatus(d);
          const allFiles = [...(d.staged || []), ...(d.unstaged || [])];
          allFiles.forEach((f: GitFile) => {
            const isStaged = (d.staged || []).some((sf: GitFile) => sf.path === f.path);
            fetch(`/api/git/diff-stats?cwd=${encodeURIComponent(cwd!)}&path=${encodeURIComponent(f.path)}&staged=${isStaged}`)
              .then(r => r.json())
              .then(stats => {
                setDiffStats(prev => new Map(prev).set(f.path, stats));
              })
              .catch(() => {});
          });
        }
      })
      .catch(() => setError("Failed to fetch git status"))
      .finally(() => setLoading(false));
  }, [cwd, visible]);

  useEffect(() => { refresh(); }, [refresh]);

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

  const handleUnstageAll = useCallback(async () => {
    if (!cwd) return;
    await fetch("/api/git/unstage-all", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd }) });
    refresh();
  }, [cwd, refresh]);

  const handleDiscard = useCallback(async (path: string) => {
    if (!cwd) return;
    if (!confirm(`Discard changes to ${path}? This cannot be undone.`)) return;
    await fetch("/api/git/discard", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd, path }) });
    refresh();
  }, [cwd, refresh]);

  const handleCommit = useCallback(async () => {
    if (!cwd || !commitMsg.trim()) return;
    setCommitting(true);
    try {
      const endpoint = amend ? "/api/git/amend" : "/api/git/commit";
      const result = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd, message: commitMsg.trim() }) });
      if (result.ok) { setCommitMsg(""); refresh(); }
      else {
        try { const d = await result.json(); setError(d.error || `Commit failed (${result.status})`); }
        catch { setError(`Commit failed (${result.status})`); }
      }
    } catch (err) { setError(String(err)); }
    finally { setCommitting(false); }
  }, [cwd, commitMsg, amend, refresh]);

  const handlePush = useCallback(async () => {
    if (!cwd) return;
    try {
      const r = await fetch("/api/git/push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd }) });
      if (!r.ok) { try { const d = await r.json(); setError(d.error || `Push failed (${r.status})`); } catch { setError(`Push failed (${r.status})`); } }
      else refresh();
    } catch (err) { setError(String(err)); }
  }, [cwd, refresh]);

  const handlePull = useCallback(async () => {
    if (!cwd) return;
    try {
      const r = await fetch("/api/git/pull", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd }) });
      if (!r.ok) { try { const d = await r.json(); setError(d.error || `Pull failed (${r.status})`); } catch { setError(`Pull failed (${r.status})`); } }
      else refresh();
    } catch (err) { setError(String(err)); }
  }, [cwd, refresh]);

  const handleFetch = useCallback(async () => {
    if (!cwd) return;
    try {
      const r = await fetch("/api/git/fetch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd }) });
      if (!r.ok) { try { const d = await r.json(); setError(d.error || `Fetch failed (${r.status})`); } catch { setError(`Fetch failed (${r.status})`); } }
      else refresh();
    } catch (err) { setError(String(err)); }
  }, [cwd, refresh]);

  const handleViewDiff = useCallback(async (path: string, staged: boolean) => {
    if (!cwd) return;
    const r = await fetch(`/api/git/diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}&staged=${staged}`);
    const d = await r.json();
    setDiffView({ path, staged, diff: d.diff || "" });
  }, [cwd]);

  const handleBlame = useCallback((path: string) => {
    setBlameView(path);
  }, []);

  const handleComparePrev = useCallback(async (path: string) => {
    if (!cwd) return;
    const r = await fetch(`/api/git/diff-ref?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}&ref=HEAD~1`);
    const d = await r.json();
    setDiffView({ path: `${path} (vs previous)`, staged: false, diff: d.diff || "" });
    setCompareRef(null);
  }, [cwd]);

  const handleResolveConflict = useCallback(async (path: string, strategy: "ours" | "theirs" | "both") => {
    if (!cwd) return;
    await fetch("/api/git/resolve-conflict", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd, path, strategy }) });
    refresh();
  }, [cwd, refresh]);

  const handleStageSelected = useCallback(async () => {
    if (!cwd || selectedFiles.size === 0) return;
    for (const path of selectedFiles) await handleStage(path);
    setSelectedFiles(new Set());
  }, [cwd, selectedFiles, handleStage]);

  const handleUnstageSelected = useCallback(async () => {
    if (!cwd || selectedFiles.size === 0) return;
    for (const path of selectedFiles) await handleUnstage(path);
    setSelectedFiles(new Set());
  }, [cwd, selectedFiles, handleUnstage]);

  const toggleFileSelect = useCallback((path: string, shiftKey: boolean) => {
    setSelectedFiles(prev => {
      const next = new Set(prev);
      if (shiftKey && next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // Escape to close
  useEffect(() => {
    if (!visible) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !diffView && !blameView) onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [visible, onClose, diffView, blameView]);

  if (!visible || !cwd) return null;

  const totalChanges = (status?.staged.length || 0) + (status?.unstaged.length || 0) + (status?.untracked.length || 0);
  const hasConflicts = !!(status?.unstaged.some(f => f.status === "U") || status?.staged.some(f => f.status === "U"));

  // ── Mobile: full-screen overlay ──
  if (isMobile) {
    return (
      <div className="fixed inset-0 z-45 bg-ink-900/35 border-l-0 flex flex-col select-none mobile-safe-top mobile-safe-bottom">
        <GitPanelContent
          cwd={cwd}
          status={status}
          loading={loading}
          error={error}
          view={view}
          setView={setView}
          commitMsg={commitMsg}
          setCommitMsg={setCommitMsg}
          amend={amend}
          setAmend={setAmend}
          committing={committing}
          diffView={diffView}
          setDiffView={setDiffView}
          blameView={blameView}
          setBlameView={setBlameView}
          expandedStaged={expandedStaged}
          expandedChanges={expandedChanges}
          selectedFiles={selectedFiles}
          diffStats={diffStats}
          totalChanges={totalChanges}
          hasConflicts={hasConflicts}
          onToggleStaged={() => setExpandedStaged(v => !v)}
          onToggleChanges={() => setExpandedChanges(v => !v)}
          onStage={handleStage}
          onStageAll={handleStageAll}
          onUnstage={handleUnstage}
          onUnstageAll={handleUnstageAll}
          onDiscard={handleDiscard}
          onCommit={handleCommit}
          onPush={handlePush}
          onPull={handlePull}
          onFetch={handleFetch}
          onViewDiff={handleViewDiff}
          onBlame={handleBlame}
          onComparePrev={handleComparePrev}
          onResolveConflict={handleResolveConflict}
          onStageSelected={handleStageSelected}
          onUnstageSelected={handleUnstageSelected}
          onToggleSelect={toggleFileSelect}
          onRefresh={refresh}
          onClose={onClose}
          embedded={embedded}
        />
      </div>
    );
  }

  // ── Desktop: right-side panel matching PreviewPanel ──
  return (
    <div
      className="flex flex-col shrink-0 h-full min-h-0 min-w-0 max-h-full max-w-full relative select-none border-l border-ink-800/70 bg-ink-900/35"
      style={{
        width: panelWidth,
        ...(isDragging ? { userSelect: "none", transition: "none" } : {}),
      }}
    >
      {!embedded && (
      <div
        onMouseDown={handleMouseDown}
        className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize z-10 group/handle"
      >
        <div className="absolute left-0 top-1/2 -translate-y-1/2 w-full flex justify-center opacity-0 group-hover/handle:opacity-100 transition-opacity">
          <div className="w-0.5 h-10 rounded-full bg-ink-600/60" />
        </div>
      </div>
      )}

      <GitPanelContent
        cwd={cwd}
        status={status}
        loading={loading}
        error={error}
        view={view}
        setView={setView}
        commitMsg={commitMsg}
        setCommitMsg={setCommitMsg}
        amend={amend}
        setAmend={setAmend}
        committing={committing}
        diffView={diffView}
        setDiffView={setDiffView}
        blameView={blameView}
        setBlameView={setBlameView}
        expandedStaged={expandedStaged}
        expandedChanges={expandedChanges}
        selectedFiles={selectedFiles}
        diffStats={diffStats}
        totalChanges={totalChanges}
        hasConflicts={hasConflicts}
        onToggleStaged={() => setExpandedStaged(v => !v)}
        onToggleChanges={() => setExpandedChanges(v => !v)}
        onStage={handleStage}
        onStageAll={handleStageAll}
        onUnstage={handleUnstage}
        onUnstageAll={handleUnstageAll}
        onDiscard={handleDiscard}
        onCommit={handleCommit}
        onPush={handlePush}
        onPull={handlePull}
        onFetch={handleFetch}
        onViewDiff={handleViewDiff}
        onBlame={handleBlame}
        onComparePrev={handleComparePrev}
        onResolveConflict={handleResolveConflict}
        onStageSelected={handleStageSelected}
        onUnstageSelected={handleUnstageSelected}
          onToggleSelect={toggleFileSelect}
          onRefresh={refresh}
          onClose={onClose}
          embedded={embedded}
        />
    </div>
  );
}

// ─── Shared content (used by both desktop right-side and mobile full-screen) ───

function GitPanelContent({
  cwd, status, loading, error, view, setView,
  commitMsg, setCommitMsg, amend, setAmend, committing,
  diffView, setDiffView, blameView, setBlameView,
  expandedStaged, expandedChanges, selectedFiles, diffStats,
  totalChanges, hasConflicts,
  onToggleStaged, onToggleChanges,
  onStage, onStageAll, onUnstage, onUnstageAll, onDiscard,
  onCommit, onPush, onPull, onFetch,
  onViewDiff, onBlame, onComparePrev, onResolveConflict,
  onStageSelected, onUnstageSelected, onToggleSelect,
  onRefresh, onClose, embedded,
}: {
  cwd: string;
  status: GitStatus | null;
  loading: boolean;
  error: string | null;
  view: ViewMode;
  setView: (v: ViewMode) => void;
  commitMsg: string;
  setCommitMsg: (v: string) => void;
  amend: boolean;
  setAmend: (v: boolean) => void;
  committing: boolean;
  diffView: { path: string; staged: boolean; diff: string } | null;
  setDiffView: (v: { path: string; staged: boolean; diff: string } | null) => void;
  blameView: string | null;
  setBlameView: (v: string | null) => void;
  expandedStaged: boolean;
  expandedChanges: boolean;
  selectedFiles: Set<string>;
  diffStats: Map<string, GitDiffStats>;
  totalChanges: number;
  hasConflicts: boolean;
  onToggleStaged: () => void;
  onToggleChanges: () => void;
  onStage: (path: string) => void;
  onStageAll: () => void;
  onUnstage: (path: string) => void;
  onUnstageAll: () => void;
  onDiscard: (path: string) => void;
  onCommit: () => void;
  onPush: () => void;
  onPull: () => void;
  onFetch: () => void;
  onViewDiff: (path: string, staged: boolean) => void;
  onBlame: (path: string) => void;
  onComparePrev: (path: string) => void;
  onResolveConflict: (path: string, strategy: "ours" | "theirs" | "both") => void;
  onStageSelected: () => void;
  onUnstageSelected: () => void;
  onToggleSelect: (path: string, shiftKey: boolean) => void;
  onRefresh: () => void;
  onClose: () => void;
  embedded?: boolean;
}) {
  return (
    <>
      {/* ── Header bar — matches PreviewPanel header pattern ── */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-ink-800/40 shrink-0"
           style={{ paddingLeft: "1.25rem" }}>
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="text-ink-500 font-mono text-[0.65rem] tracking-[0.15em] uppercase">
            Source Control
          </span>
          {status && (
            <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[0.55rem] font-mono
                           bg-amber-500/[0.08] text-amber-500 border border-amber-500/20">
              {status.branch}
            </span>
          )}
          {status && (status.ahead > 0 || status.behind > 0) && (
            <span className="text-ink-600 font-mono text-[0.55rem]">
              {status.ahead > 0 && `↑${status.ahead}`}
              {status.ahead > 0 && status.behind > 0 && " "}
              {status.behind > 0 && `↓${status.behind}`}
            </span>
          )}
        </div>

        {/* Sync buttons */}
        <div className="flex items-center gap-0.5">
          <button onClick={onFetch} className="p-1 text-ink-500 hover:text-ink-200 hover:bg-ink-800/50 rounded transition-theme" aria-label="Fetch" title="Fetch">
            <Icon name="refresh" size={11} />
          </button>
          <button onClick={onPull} className="p-1 text-ink-500 hover:text-teal-400 hover:bg-ink-800/50 rounded transition-theme" aria-label="Pull" title="Pull">↓</button>
          <button onClick={onPush} className="p-1 text-ink-500 hover:text-amber-500 hover:bg-ink-800/50 rounded transition-theme" aria-label="Push" title="Push">↑</button>
          <button onClick={onRefresh} className="p-1 text-ink-500 hover:text-amber-500 hover:bg-ink-800/50 rounded transition-theme" aria-label="Refresh" title="Refresh">
            <Icon name="refresh" size={11} />
          </button>
        </div>

        {!embedded && (
        <button
          onClick={onClose}
          className="p-1.5 rounded-md text-ink-500 hover:text-ink-200 hover:bg-ink-800/50 transition-theme"
          aria-label="Close panel"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
        </button>
        )}
      </div>

      {/* ── Branch selector ── */}
      {status && (
        <div className="px-3 py-1.5 border-b border-ink-800/30 shrink-0">
          <GitBranchSelector
            cwd={cwd}
            currentBranch={status.branch}
            ahead={status.ahead}
            behind={status.behind}
            onRefresh={onRefresh}
          />
        </div>
      )}

      {/* ── Conflict banners ── */}
      {hasConflicts && status && (
        <>
          {status.staged.filter(f => f.status === "U").map(f => (
            <ConflictBanner key={f.path} path={f.path} onResolve={(s) => onResolveConflict(f.path, s)} />
          ))}
          {status.unstaged.filter(f => f.status === "U").map(f => (
            <ConflictBanner key={f.path} path={f.path} onResolve={(s) => onResolveConflict(f.path, s)} />
          ))}
        </>
      )}

      {/* ── View tabs ── */}
      <div className="flex border-b border-ink-800/40 shrink-0">
        <button
          onClick={() => setView("changes")}
          className={`flex-1 py-2 text-xs font-medium transition-theme border-b-2 min-h-[36px]
            ${view === "changes" ? "text-amber-500 border-b-amber-500" : "text-ink-500 border-b-transparent hover:text-ink-300"}`}
        >
          Changes {totalChanges > 0 && <span className="text-ink-500 ml-1">({totalChanges})</span>}
        </button>
        <button
          onClick={() => setView("log")}
          className={`flex-1 py-2 text-xs font-medium transition-theme border-b-2 min-h-[36px]
            ${view === "log" ? "text-amber-500 border-b-amber-500" : "text-ink-500 border-b-transparent hover:text-ink-300"}`}
        >
          Log
        </button>
      </div>

      {/* ── Multi-select actions bar ── */}
      {selectedFiles.size > 0 && view === "changes" && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-500/[0.06] border-b border-amber-500/10 shrink-0">
          <span className="text-amber-500 text-[0.65rem] font-mono">{selectedFiles.size} selected</span>
          <button onClick={onStageSelected} className="px-2 py-1 text-xs min-h-[36px] bg-amber-600/30 hover:bg-amber-600/50 text-amber-300 rounded transition-theme">Stage</button>
          <button onClick={onUnstageSelected} className="px-2 py-1 text-xs min-h-[36px] bg-ink-800/40 hover:bg-ink-800/60 text-ink-300 rounded transition-theme">Unstage</button>
          <button onClick={() => selectedFiles && (() => {})} className="ml-auto text-xs min-h-[36px] text-ink-400 hover:text-ink-300 transition-theme">Clear</button>
        </div>
      )}

      {/* ── Content ── */}
      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
        {blameView ? (
          <GitBlame cwd={cwd} path={blameView} onClose={() => setBlameView(null)} />
        ) : diffView ? (
          <DiffViewer
            diff={diffView.diff}
            path={diffView.path}
            onClose={() => setDiffView(null)}
            showBlame={onBlame}
            showComparePrev={onComparePrev}
          />
        ) : view === "changes" ? (
          <ChangesView
            cwd={cwd}
            status={status}
            loading={loading}
            error={error}
            expandedStaged={expandedStaged}
            expandedChanges={expandedChanges}
            selectedFiles={selectedFiles}
            diffStats={diffStats}
            onToggleStaged={onToggleStaged}
            onToggleChanges={onToggleChanges}
            onStage={onStage}
            onStageAll={onStageAll}
            onUnstage={onUnstage}
            onUnstageAll={onUnstageAll}
            onDiscard={onDiscard}
            onViewDiff={onViewDiff}
            onBlame={onBlame}
            onComparePrev={onComparePrev}
            onToggleSelect={onToggleSelect}
          />
        ) : (
          <GitLog cwd={cwd} onRefresh={onRefresh} />
        )}
      </div>

      {/* ── Stash section ── */}
      {view === "changes" && status && status.stashCount > 0 && (
        <GitStash cwd={cwd} stashCount={status.stashCount} onRefresh={onRefresh} />
      )}

      {/* ── Commit input ── */}
      {view === "changes" && (
        <div className="px-3 py-2.5 border-t border-ink-800/40 bg-ink-900/20 shrink-0">
          <div className="flex items-center gap-2 mb-1.5">
            <textarea
              value={commitMsg}
              onChange={e => setCommitMsg(e.target.value)}
              placeholder={amend ? "Amend commit message" : "Commit message"}
              rows={2}
              className="flex-1 bg-ink-950/40 border border-ink-800/40 rounded-md px-2.5 py-1.5 text-ink-200 text-xs placeholder-ink-500 outline-none focus:border-amber-500/40 resize-none transition-theme font-mono"
              onKeyDown={e => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onCommit(); }
              }}
              enterKeyHint="send"
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onCommit}
              disabled={!commitMsg.trim() || committing || (!amend && !status?.staged.length)}
              className={`flex-1 py-1.5 min-h-[36px] rounded-md text-xs font-medium transition-theme
                ${commitMsg.trim() && (amend || status?.staged.length) && !committing
                  ? "bg-amber-600 hover:bg-amber-500 text-ink-950"
                  : "bg-ink-800/40 text-ink-400 cursor-not-allowed"
                }`}
            >
              {committing ? "…" : amend ? "Amend" : "Commit"}
            </button>
            <label className="flex items-center gap-1 cursor-pointer">
              <input
                type="checkbox"
                checked={amend}
                onChange={e => setAmend(e.target.checked)}
                className="checkbox-ink"
              />
              <span className="text-ink-500 text-[0.65rem]">Amend</span>
            </label>
            <span className="text-ink-500 text-[0.6rem] font-mono ml-auto hidden md:inline">⌘↵</span>
          </div>
        </div>
      )}
    </>
  );
}

// ─── Changes View ───

function ChangesView({ cwd, status, loading, error, expandedStaged, expandedChanges, selectedFiles, diffStats, onToggleStaged, onToggleChanges, onStage, onStageAll, onUnstage, onUnstageAll, onDiscard, onViewDiff, onBlame, onComparePrev, onToggleSelect }: {
  cwd: string;
  status: GitStatus | null;
  loading: boolean;
  error: string | null;
  expandedStaged: boolean;
  expandedChanges: boolean;
  selectedFiles: Set<string>;
  diffStats: Map<string, GitDiffStats>;
  onToggleStaged: () => void;
  onToggleChanges: () => void;
  onStage: (path: string) => void;
  onStageAll: () => void;
  onUnstage: (path: string) => void;
  onUnstageAll: () => void;
  onDiscard: (path: string) => void;
  onViewDiff: (path: string, staged: boolean) => void;
  onBlame: (path: string) => void;
  onComparePrev: (path: string) => void;
  onToggleSelect: (path: string, shiftKey: boolean) => void;
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
    return <div className="py-8 text-center"><span className="text-rose-400/80 text-xs font-mono">{error}</span></div>;
  }

  if (!status) return null;

  return (
    <div>
      {/* Staged changes */}
      {status.staged.length > 0 && (
        <div>
          <button
            onClick={onToggleStaged}
            className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-ink-300 hover:bg-ink-900/30 transition-theme relative"
          >
            <Icon name={expandedStaged ? "chevron-down" : "chevron-right"} size={8} />
            Staged Changes
            <span className="text-ink-500 font-normal ml-auto">{status.staged.length}</span>
          </button>
          {status.staged.length > 0 && (
            <button
              onClick={onUnstageAll}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-500 hover:text-amber-500 transition-theme p-0.5"
              aria-label="Unstage all"
              title="Unstage all"
            >
              <Icon name="minus" size={10} />
            </button>
          )}
          {expandedStaged && status.staged.map(f => (
            <FileRow
              key={`staged-${f.path}`}
              file={f}
              stats={diffStats.get(f.path)}
              staged
              selected={selectedFiles.has(f.path)}
              onUnstage={onUnstage}
              onViewDiff={onViewDiff}
              onBlame={onBlame}
              onComparePrev={onComparePrev}
              onToggleSelect={onToggleSelect}
            />
          ))}
        </div>
      )}

      {/* Unstaged changes */}
      {(status.unstaged.length > 0 || status.untracked.length > 0) && (
        <div>
          <button
            onClick={onToggleChanges}
            className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-ink-300 hover:bg-ink-900/30 transition-theme relative"
          >
            <Icon name={expandedChanges ? "chevron-down" : "chevron-right"} size={8} />
            Changes
            <span className="text-ink-500 font-normal ml-auto">{status.unstaged.length + status.untracked.length}</span>
          </button>
          {status.unstaged.length + status.untracked.length > 0 && (
            <button
              onClick={onStageAll}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-500 hover:text-amber-500 transition-theme p-0.5"
              aria-label="Stage all changes"
              title="Stage all"
            >
              <Icon name="plus" size={10} />
            </button>
          )}
          {expandedChanges && (
            <>
              {status.unstaged.map(f => (
                <FileRow
                  key={`unstaged-${f.path}`}
                  file={f}
                  stats={diffStats.get(f.path)}
                  selected={selectedFiles.has(f.path)}
                  onStage={onStage}
                  onDiscard={onDiscard}
                  onViewDiff={onViewDiff}
                  onBlame={onBlame}
                  onComparePrev={onComparePrev}
                  onToggleSelect={onToggleSelect}
                />
              ))}
              {status.untracked.map(path => (
                <FileRow
                  key={`untracked-${path}`}
                  file={{ path, status: "?" }}
                  selected={selectedFiles.has(path)}
                  onStage={onStage}
                  onViewDiff={onViewDiff}
                  onToggleSelect={onToggleSelect}
                />
              ))}
            </>
          )}
        </div>
      )}

      {/* Empty state */}
      {status.staged.length === 0 && status.unstaged.length === 0 && status.untracked.length === 0 && (
        <div className="py-12 text-center">
          <p className="text-ink-500 text-xs font-mono">No changes detected</p>
          <p className="text-ink-500 text-[0.65rem] font-mono mt-1">Working tree clean</p>
        </div>
      )}
    </div>
  );
}

// ─── File Row ───

function FileRow({ file, stats, staged, selected, onStage, onUnstage, onDiscard, onViewDiff, onBlame, onComparePrev, onToggleSelect }: {
  file: GitFile;
  stats?: GitDiffStats;
  staged?: boolean;
  selected?: boolean;
  onStage?: (path: string) => void;
  onUnstage?: (path: string) => void;
  onDiscard?: (path: string) => void;
  onViewDiff: (path: string, staged: boolean) => void;
  onBlame?: (path: string) => void;
  onComparePrev?: (path: string) => void;
  onToggleSelect?: (path: string, shiftKey: boolean) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const isMobile = useIsMobile();
  const showActions = hovered || isMobile;

  return (
    <div
      className={`flex items-center gap-1 px-3 py-1 hover:bg-ink-900/30 transition-theme group cursor-pointer ${selected ? "bg-amber-500/[0.06]" : ""}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={(e) => {
        if (e.shiftKey && onToggleSelect) { onToggleSelect(file.path, true); }
        else onViewDiff(file.path, !!staged);
      }}
    >
      {/* Selection checkbox */}
      {onToggleSelect && (
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelect(file.path, false)}
          onClick={(e) => e.stopPropagation()}
          className="checkbox-ink checkbox-ink-sm"
        />
      )}

      {/* Status badge */}
      <span className={`text-[0.6rem] font-mono font-bold w-3 text-center shrink-0 ${STATUS_COLORS[file.status] || "text-ink-500"}`}>
        {STATUS_LABELS[file.status] || file.status}
      </span>

      {/* Path */}
      <span className="text-ink-300 text-xs truncate flex-1 font-mono" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
        {file.path.split("/").map((segment, i, arr) => (
          <span key={i}>
            {i < arr.length - 1 ? <span className="text-ink-500">{segment}/</span> : segment}
          </span>
        ))}
      </span>

      {/* Diff stats */}
      {stats && (stats.additions > 0 || stats.deletions > 0) && !showActions && (
        <span className="text-[0.6rem] font-mono shrink-0">
          <span className="text-teal-400">+{stats.additions}</span>
          <span className="text-rose-400">-{stats.deletions}</span>
        </span>
      )}

      {/* Action buttons on hover or mobile */}
      {showActions && (
        <div className="flex items-center gap-0.5 shrink-0">
          {staged && onUnstage && (
            <button onClick={(e) => { e.stopPropagation(); onUnstage(file.path); }} className="p-1 md:p-0.5 text-ink-500 hover:text-amber-500 transition-theme touch-target" aria-label="Unstage" title="Unstage">
              <Icon name="minus" size={10} />
            </button>
          )}
          {!staged && onStage && (
            <button onClick={(e) => { e.stopPropagation(); onStage(file.path); }} className="p-1 md:p-0.5 text-ink-500 hover:text-amber-500 transition-theme touch-target" aria-label="Stage" title="Stage">
              <Icon name="plus" size={10} />
            </button>
          )}
          {!staged && onDiscard && file.status !== "?" && (
            <button onClick={(e) => { e.stopPropagation(); onDiscard(file.path); }} className="p-1 md:p-0.5 text-ink-500 hover:text-rose-400 transition-theme touch-target" aria-label="Discard" title="Discard">
              <Icon name="undo" size={10} />
            </button>
          )}
          {onBlame && file.status !== "?" && !isMobile && (
            <button onClick={(e) => { e.stopPropagation(); onBlame(file.path); }} className="p-1 md:p-0.5 text-ink-500 hover:text-ink-200 transition-theme touch-target" aria-label="Blame" title="Blame">B</button>
          )}
          {onComparePrev && file.status !== "?" && !isMobile && (
            <button onClick={(e) => { e.stopPropagation(); onComparePrev(file.path); }} className="p-1 md:p-0.5 text-ink-500 hover:text-amber-400 transition-theme touch-target" aria-label="Compare with previous" title="Compare with previous">⇄</button>
          )}
        </div>
      )}
    </div>
  );
}
