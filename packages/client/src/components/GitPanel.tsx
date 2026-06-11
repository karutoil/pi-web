import { useState, useEffect, useRef, useCallback } from "react";
import { Icon } from "./Icon";
import { GitStash } from "./GitStash";
import { GitLog } from "./GitLog";
import { GitBlame } from "./GitBlame";
import { useIsMobile } from "../hooks/useIsMobile";
import { GitBranchSelector } from "./GitBranchSelector";
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
    <div className="git-diff-viewer">
      <div className="git-diff-toolbar shrink-0">
        <button onClick={onClose} className="git-panel-icon-button" aria-label="Back">
          <Icon name="chevron-left" size={12} />
        </button>
        <span className="git-diff-path">{path}</span>
        {showBlame && (
          <button onClick={() => showBlame(path)} className="git-panel-section-action">Blame</button>
        )}
        {showComparePrev && (
          <button onClick={() => showComparePrev(path)} className="git-panel-section-action">Prev</button>
        )}
        <button onClick={onClose} className="git-panel-section-action">Back</button>
      </div>
      <div className="git-diff-content custom-scrollbar">
        {lines.map((line, i) => {
          let kind = "plain";
          if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("diff ")) kind = "meta";
          else if (line.startsWith("@@")) kind = "hunk";
          else if (line.startsWith("+") && !line.startsWith("++")) kind = "add";
          else if (line.startsWith("-") && !line.startsWith("--")) kind = "remove";

          return (
            <div key={i} className="git-diff-line" data-kind={kind}>
              <span>{line}</span>
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
    <div className="git-conflict-banner">
      <p>Merge conflict: {path}</p>
      <div className="flex flex-wrap gap-2">
        <button onClick={() => onResolve("ours")}>Accept Current</button>
        <button onClick={() => onResolve("theirs")}>Accept Incoming</button>
        <button onClick={() => onResolve("both")}>Accept Both</button>
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
  projectId?: string;
}

export function GitPanel({ cwd, visible, onClose, embedded = false, width, projectId }: GitPanelProps) {
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
  const [generatingCommit, setGeneratingCommit] = useState(false);
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

  const handleGenerateCommit = useCallback(async () => {
    if (!cwd || generatingCommit) return;
    setGeneratingCommit(true);
    setError(null);
    try {
      // Fetch last-used model from sessions
      let model: string | undefined;
      if (projectId) {
        try {
          const sr = await fetch(`/api/projects/${encodeURIComponent(projectId)}/sessions`);
          if (sr.ok) {
            const sd = await sr.json();
            const sessions: any[] = sd.sessions || [];
            // Find the most recent session with a model
            const withModel = sessions.filter(s => s.model);
            if (withModel.length > 0) {
              model = withModel[0].model;
            }
          }
        } catch {}
      }

      const r = await fetch("/api/git/generate-commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, model }),
      });
      if (!r.ok) {
        try {
          const d = await r.json();
          setError(d.error || `Generate commit failed (${r.status})`);
        } catch {
          setError(`Generate commit failed (${r.status})`);
        }
        return;
      }
      const d = await r.json();
      if (d.message) setCommitMsg(d.message);
    } catch (err) {
      setError(String(err));
    } finally {
      setGeneratingCommit(false);
    }
  }, [cwd, projectId, generatingCommit, setCommitMsg]);

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

  return (
    <div
      className="git-panel-shell relative select-none"
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
        generatingCommit={generatingCommit}
        onGenerateCommit={handleGenerateCommit}
        onViewDiff={handleViewDiff}
        onBlame={handleBlame}
        onComparePrev={handleComparePrev}
        onResolveConflict={handleResolveConflict}
        onStageSelected={handleStageSelected}
        onUnstageSelected={handleUnstageSelected}
        onClearSelected={() => setSelectedFiles(new Set())}
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
  generatingCommit, onGenerateCommit,
  onViewDiff, onBlame, onComparePrev, onResolveConflict,
  onStageSelected, onUnstageSelected, onClearSelected, onToggleSelect,
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
  generatingCommit: boolean;
  onGenerateCommit: () => void;
  onViewDiff: (path: string, staged: boolean) => void;
  onBlame: (path: string) => void;
  onComparePrev: (path: string) => void;
  onResolveConflict: (path: string, strategy: "ours" | "theirs" | "both") => void;
  onStageSelected: () => void;
  onUnstageSelected: () => void;
  onClearSelected: () => void;
  onToggleSelect: (path: string, shiftKey: boolean) => void;
  onRefresh: () => void;
  onClose: () => void;
  embedded?: boolean;
}) {
  return (
    <>
      {/* ── Header bar — matches PreviewPanel header pattern ── */}
      <header className="git-panel-header shrink-0">
        <div className="min-w-0">
          <div className="git-panel-eyebrow">Source Control</div>
          <div className="git-panel-heading">Working tree ledger</div>
          {status && (
            <div className="git-panel-branchline">
              <span className="git-panel-branch" title={status.branch}>
                <Icon name="git" size={10} />
                <span className="truncate">{status.branch}</span>
              </span>
              {(status.ahead > 0 || status.behind > 0) && (
                <span className="git-panel-branch" title={`${status.ahead} ahead, ${status.behind} behind`}>
                  {status.ahead > 0 && <span>↑ {status.ahead}</span>}
                  {status.ahead > 0 && status.behind > 0 && <span>/</span>}
                  {status.behind > 0 && <span>↓ {status.behind}</span>}
                </span>
              )}
            </div>
          )}
        </div>

        <div className="git-panel-sync">
          <button onClick={onFetch} className="git-panel-icon-button" aria-label="Fetch" title="Fetch">
            <Icon name="refresh" size={12} />
          </button>
          <button onClick={onPull} className="git-panel-icon-button" aria-label="Pull" title="Pull">↓</button>
          <button onClick={onPush} className="git-panel-icon-button" aria-label="Push" title="Push">↑</button>
          <button onClick={onRefresh} className="git-panel-icon-button" aria-label="Refresh" title="Refresh">
            <Icon name="refresh" size={12} />
          </button>
        </div>
      </header>

      {!embedded && (
        <button
          onClick={onClose}
          className="git-panel-icon-button absolute right-3 top-3"
          aria-label="Close panel"
          title="Close"
        >
          <Icon name="close" size={12} />
        </button>
      )}

      {/* ── Branch selector ── */}
      {status && (
        <div className="git-panel-branch-selector shrink-0">
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
      <nav className="git-panel-tabs shrink-0" aria-label="Git panel views">
        <button
          onClick={() => setView("changes")}
          className="git-panel-tab"
          data-active={view === "changes"}
        >
          Changes {totalChanges > 0 && <span className="opacity-70">({totalChanges})</span>}
        </button>
        <button
          onClick={() => setView("log")}
          className="git-panel-tab"
          data-active={view === "log"}
        >
          Log
        </button>
      </nav>

      {selectedFiles.size > 0 && view === "changes" && (
        <div className="git-panel-selection-bar shrink-0">
          <span>{selectedFiles.size} selected</span>
          <button onClick={onStageSelected}>Stage</button>
          <button onClick={onUnstageSelected}>Unstage</button>
          <button className="ml-auto" onClick={onClearSelected}>Clear</button>
        </div>
      )}

      {/* ── Content ── */}
      <div className="git-panel-scroll">
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
      {view === "changes" && status && (
        <GitStash cwd={cwd} stashCount={status.stashCount} onRefresh={onRefresh} />
      )}

      {/* ── Commit input ── */}
      {view === "changes" && (
        <div className="git-commit-dock">
        <div className="flex items-center gap-2 mb-2">
          <div className="flex-1 min-w-0">
            <div className="text-ink-500 text-[0.58rem] font-mono uppercase tracking-[0.16em]">Commit</div>
            <div className="text-ink-300 text-xs mt-0.5">Stage first, then write the change.</div>
          </div>
        </div>
        <div className="relative">
          <textarea
            value={commitMsg}
            onChange={e => setCommitMsg(e.target.value)}
            placeholder={amend ? "Amend commit message" : "Commit message"}
            className="git-commit-textarea"
            onKeyDown={e => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onCommit(); }
            }}
            enterKeyHint="send"
          />
          <button
            onClick={onGenerateCommit}
            disabled={generatingCommit}
            className="git-commit-ai-btn"
            aria-label="Generate commit message with AI"
            title="Generate commit message with AI"
          >
            {generatingCommit ? (
              <span className="git-commit-ai-spinner" />
            ) : (
              <Icon name="spark" size={13} />
            )}
          </button>
        </div>
        <div className="git-commit-controls">
          <button
            onClick={onCommit}
            disabled={!commitMsg.trim() || committing || (!amend && !status?.staged.length)}
            className="git-commit-primary"
          >
            {committing ? "…" : amend ? "Amend" : "Commit"}
          </button>
          <label className="git-commit-meta">
            <input
              type="checkbox"
              checked={amend}
              onChange={e => setAmend(e.target.checked)}
              className="checkbox-ink"
            />
            <span>Amend</span>
          </label>
          <span className="git-commit-meta">⌘↵</span>
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
      <div className="git-empty-state">
        <div>
          <strong>Loading changes</strong>
          <span>Reading the working tree…</span>
        </div>
      </div>
    );
  }

  if (error) {
    return <div className="git-empty-state"><div><strong>Could not read Git</strong><span>{error}</span></div></div>;
  }

  if (!status) return null;

  return (
    <div>
      {status.staged.length > 0 && (
        <section className="git-panel-section">
          <button
            onClick={onToggleStaged}
            className="git-panel-section-header"
          >
            <span className="git-panel-section-title">
              <Icon name={expandedStaged ? "chevron-down" : "chevron-right"} size={8} />
              Staged Changes
            </span>
            <span className="git-panel-section-count">{status.staged.length}</span>
            {expandedStaged && (
              <button
                onClick={(e) => { e.stopPropagation(); onUnstageAll(); }}
                className="git-panel-section-action"
                aria-label="Unstage all"
                title="Unstage all"
              >
                <Icon name="minus" size={10} />
              </button>
            )}
          </button>
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
        </section>
      )}

      {(status.unstaged.length > 0 || status.untracked.length > 0) && (
        <section className="git-panel-section">
          <button
            onClick={onToggleChanges}
            className="git-panel-section-header"
          >
            <span className="git-panel-section-title">
              <Icon name={expandedChanges ? "chevron-down" : "chevron-right"} size={8} />
              Working Changes
            </span>
            <span className="git-panel-section-count">{status.unstaged.length + status.untracked.length}</span>
            {expandedChanges && (
              <button
                onClick={(e) => { e.stopPropagation(); onStageAll(); }}
                className="git-panel-section-action"
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
        </section>
      )}

      {status.staged.length === 0 && status.unstaged.length === 0 && status.untracked.length === 0 && (
        <div className="git-empty-state">
          <div>
            <strong>Working tree clean</strong>
            <span>Nothing needs staging right now.</span>
          </div>
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

  const diffStyle = stats
    ? {
        background: `linear-gradient(to bottom, rgba(94, 234, 212, ${Math.min(0.55, stats.additions / 24)}) 0 ${Math.min(50, stats.additions * 2)}%, transparent ${Math.min(50, stats.additions * 2)}% ${100 - Math.min(50, stats.deletions * 2)}%, rgba(242, 99, 110, ${Math.min(0.55, stats.deletions / 24)}) ${100 - Math.min(50, stats.deletions * 2)}% 100%)`,
      }
    : undefined;

  return (
    <div
      className="git-file-row"
      data-selected={selected}
      data-touch={isMobile}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={(e) => {
        if (e.shiftKey && onToggleSelect) { onToggleSelect(file.path, true); }
        else onViewDiff(file.path, !!staged);
      }}
    >
      <div
        className="git-file-diffbar"
        style={diffStyle}
        aria-hidden="true"
      />
      {onToggleSelect ? (
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelect(file.path, false)}
          onClick={(e) => e.stopPropagation()}
          className="checkbox-ink checkbox-ink-sm"
          aria-label={selected ? "Deselect file" : "Select file"}
        />
      ) : (
        <span className="sr-only" aria-hidden="true" />
      )}

      <span className={`git-file-status ${STATUS_COLORS[file.status] || "text-ink-500"}`}>
        {STATUS_LABELS[file.status] || file.status}
      </span>

      <span className="git-file-path" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
        {file.path.split("/").map((segment, i, arr) => (
          <span key={i}>
            {i < arr.length - 1 ? <span>{segment}/</span> : segment}
          </span>
        ))}
      </span>

      {stats && (stats.additions > 0 || stats.deletions > 0) && !showActions && (
        <span className="git-file-stats">
          {stats.additions > 0 && <span className="text-teal-400">+{stats.additions}</span>}
          {stats.deletions > 0 && <span className="text-rose-400">-{stats.deletions}</span>}
        </span>
      )}

      {showActions && (
        <div className="git-file-actions">
          {staged && onUnstage && (
            <button onClick={(e) => { e.stopPropagation(); onUnstage(file.path); }} className="git-file-action" aria-label="Unstage" title="Unstage">
              <Icon name="minus" size={10} />
            </button>
          )}
          {!staged && onStage && (
            <button onClick={(e) => { e.stopPropagation(); onStage(file.path); }} className="git-file-action" aria-label="Stage" title="Stage">
              <Icon name="plus" size={10} />
            </button>
          )}
          {!staged && onDiscard && file.status !== "?" && (
            <button onClick={(e) => { e.stopPropagation(); onDiscard(file.path); }} className="git-file-action" data-danger="true" aria-label="Discard" title="Discard">
              <Icon name="undo" size={10} />
            </button>
          )}
          {onBlame && file.status !== "?" && !isMobile && (
            <button onClick={(e) => { e.stopPropagation(); onBlame(file.path); }} className="git-file-action" aria-label="Blame" title="Blame">B</button>
          )}
          {onComparePrev && file.status !== "?" && !isMobile && (
            <button onClick={(e) => { e.stopPropagation(); onComparePrev(file.path); }} className="git-file-action" aria-label="Compare with previous" title="Compare with previous">⇄</button>
          )}
        </div>
      )}
    </div>
  );
}
