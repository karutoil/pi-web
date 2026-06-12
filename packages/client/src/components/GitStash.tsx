import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";
import { useIsMobile } from "../hooks/useIsMobile";
import { DiffRenderer } from "./DiffRenderer";

// ─── Types ───

export interface GitStashEntry {
  index: number;
  message: string;
  branch: string;
}

export interface GitStashFileChange {
  status: string;
  path: string;
  oldPath?: string;
}

interface GitStashShowResult {
  files: GitStashFileChange[];
  diff: string;
}

interface GitStashProps {
  cwd: string;
  stashCount: number;
  onRefresh: () => void;
}

// ─── GitStash Component ───

export function GitStash({ cwd, stashCount, onRefresh }: GitStashProps) {
  const [stashes, setStashes] = useState<GitStashEntry[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stashMsg, setStashMsg] = useState("");
  const [stashing, setStashing] = useState(false);
  const [showStashInput, setShowStashInput] = useState(false);
  const [actingIndex, setActingIndex] = useState<number | null>(null);
  const [modalViewingIndex, setModalViewingIndex] = useState<number | null>(null);
  const [modalTab, setModalTab] = useState<"files" | "diff">("files");
  const [stashView, setStashView] = useState<GitStashShowResult | null>(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [viewError, setViewError] = useState<string | null>(null);

  // Fetch stashes when expanded
  useEffect(() => {
    if (!expanded) return;
    setLoading(true);
    setError(null);
    fetch(`/api/git/stash?cwd=${encodeURIComponent(cwd)}`)
      .then(r => r.json())
      .then(d => {
        if (d.error) { setError(d.error); setStashes([]); }
        else setStashes(d.stashes || d.stash || []);
      })
      .catch(() => setError("Failed to fetch stashes"))
      .finally(() => setLoading(false));
  }, [expanded, cwd]);

  // Re-fetch when stashCount changes (parent status refresh)
  useEffect(() => {
    if (!expanded) return;
    fetch(`/api/git/stash?cwd=${encodeURIComponent(cwd)}`)
      .then(r => r.json())
      .then(d => {
        if (!d.error) setStashes(d.stashes || d.stash || []);
      })
      .catch(() => {});
  }, [stashCount, expanded, cwd]);

  useEffect(() => {
    if (modalViewingIndex == null) return;
    setViewLoading(true);
    setViewError(null);
    fetch(`/api/git/stash/show?cwd=${encodeURIComponent(cwd)}&index=${modalViewingIndex}`)
      .then(r => r.json())
      .then(d => {
        if (d.error) setViewError(d.error);
        else setStashView({ files: d.files || [], diff: d.diff || "" });
      })
      .catch(() => setViewError("Failed to load stash"))
      .finally(() => setViewLoading(false));
  }, [modalViewingIndex, cwd]);

  useEffect(() => {
    if (modalViewingIndex == null) return;
    setModalTab("files");
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setModalViewingIndex(null);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [modalViewingIndex]);

  // ── Actions ──

  const handleStash = useCallback(async () => {
    setStashing(true);
    try {
      const body: Record<string, string> = { cwd };
      if (stashMsg.trim()) body.message = stashMsg.trim();
      const r = await fetch("/api/git/stash/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (r.ok) {
        setStashMsg("");
        setShowStashInput(false);
        onRefresh();
      } else {
        try { const d = await r.json(); setError(d.error || 'Stash failed'); } catch { setError('Stash failed'); }
      }
    } catch (err) { setError(String(err)); }
    finally {
      setStashing(false);
    }
  }, [cwd, stashMsg, onRefresh]);

  const handleAction = useCallback(async (action: "apply" | "pop" | "drop", index: number) => {
    setActingIndex(index);
    try {
      const r = await fetch(`/api/git/stash/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, index }),
      });
      if (r.ok) onRefresh();
      else { try { const d = await r.json(); setError(d.error || `${action} failed`); } catch { setError(`${action} failed`); } }
    } catch (err) { setError(String(err)); }
    finally {
      setActingIndex(null);
    }
  }, [cwd, onRefresh]);

  return (
    <div className="git-panel-section mt-3">
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="git-panel-section-header"
      >
        <span>Stashes</span>
        {stashCount > 0 && (
          <span className="git-panel-section-count">{stashCount}</span>
        )}
        {stashCount > 0 && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setShowStashInput(v => !v);
            }}
            className="git-panel-section-action"
            aria-label="New stash"
            title="Stash"
          >
            <Icon name="plus" size={10} />
          </button>
        )}
      </button>

      {expanded && showStashInput && (
        <div className="px-3 py-2 border-b border-ink-800/20">
          <div className="flex items-center gap-2">
            <input
              value={stashMsg}
              onChange={e => setStashMsg(e.target.value)}
              placeholder="Stash message (optional)"
              className="git-stash-input flex-1"
              onKeyDown={e => {
                if (e.key === "Enter") { e.preventDefault(); handleStash(); }
                if (e.key === "Escape") setShowStashInput(false);
              }}
              autoFocus
              enterKeyHint="done"
            />
            <button
              type="button"
              onClick={handleStash}
              disabled={stashing}
              className={`px-2 py-1 rounded text-xs font-medium transition-theme ${
                stashing
                  ? "bg-ink-800/40 text-ink-400 cursor-not-allowed"
                  : "bg-amber-600 hover:bg-amber-500 text-ink-950"
              }`}
            >
              {stashing ? "…" : "Stash"}
            </button>
          </div>
        </div>
      )}

      {expanded && (
        <>
          {loading && stashes.length === 0 && (
            <div className="flex items-center justify-center py-4 gap-2">
              <div className="w-3 h-3 border-2 border-ink-700 border-t-amber-500 rounded-full animate-spin" />
              <span className="text-ink-500 text-xs font-mono">Loading…</span>
            </div>
          )}

          {error && (
            <div className="py-4 text-center">
              <span className="text-rose-400/80 text-xs font-mono">{error}</span>
            </div>
          )}

          {!loading && !error && stashes.length === 0 && (
            <div className="py-6 text-center">
              <p className="text-ink-500 text-xs font-mono">No stashes</p>
            </div>
          )}

          {stashes.map(stash => (
            <StashRow
              key={stash.index}
              stash={stash}
              acting={actingIndex === stash.index}
              viewing={modalViewingIndex === stash.index}
              onApply={() => handleAction("apply", stash.index)}
              onPop={() => handleAction("pop", stash.index)}
              onDrop={() => handleAction("drop", stash.index)}
              onView={() => setModalViewingIndex(modalViewingIndex === stash.index ? null : stash.index)}
            />
          ))}

          {modalViewingIndex != null && createPortal(
            <div className="git-stash-view-modal-backdrop" onMouseDown={() => setModalViewingIndex(null)}>
              <div className="git-stash-view-modal" onMouseDown={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Stash view">
                <StashViewModal
                  stash={stashes.find(s => s.index === modalViewingIndex)}
                  view={stashView}
                  loading={viewLoading}
                  error={viewError}
                  tab={modalTab}
                  onTabChange={setModalTab}
                  onClose={() => setModalViewingIndex(null)}
                />
              </div>
            </div>,
            document.body
          )}
        </>
      )}
    </div>
  );
}

// ─── Stash Row ───

function StashRow({
  stash,
  acting,
  viewing,
  onApply,
  onPop,
  onDrop,
  onView,
}: {
  stash: GitStashEntry;
  acting: boolean;
  viewing: boolean;
  onApply: () => void;
  onPop: () => void;
  onDrop: () => void;
  onView: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const isMobile = useIsMobile();
  const showActions = hovered || acting || isMobile;

  return (
    <div
      className="git-file-row git-file-row--stash group"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="git-file-diffbar git-file-diffbar--blank" aria-hidden="true" />
      <span className="git-file-index">{stash.index}</span>
      <span className="sr-only" aria-hidden="true" />

      <div className="flex-1 min-w-0">
        <span className="text-ink-300 text-xs font-mono truncate block" title={stash.message}>
          {stash.message}
        </span>
        <span className="text-ink-500 text-[0.6rem] font-mono truncate block">
          {stash.branch}
        </span>
      </div>

      {showActions && (
        <div className="git-stash-actions">
          <button
            type="button"
            onClick={onView}
            disabled={acting}
            title="View stash"
            className={viewing ? "active" : ""}
          >
            View
          </button>
          <button
            type="button"
            onClick={onApply}
            disabled={acting}
            title="Apply stash"
          >
            Apply
          </button>
          <button
            type="button"
            onClick={onPop}
            disabled={acting}
            title="Pop stash"
          >
            Pop
          </button>
          <button
            type="button"
            onClick={onDrop}
            disabled={acting}
            data-danger="true"
            title="Drop stash"
          >
            Drop
          </button>
        </div>
      )}
    </div>
  );
}

function StashViewModal({ stash, view, loading, error, tab, onTabChange, onClose }: {
  stash?: GitStashEntry;
  view: GitStashShowResult | null;
  loading: boolean;
  error: string | null;
  tab: "files" | "diff";
  onTabChange: (tab: "files" | "diff") => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="git-stash-view-modal-header">
        <div className="git-stash-view-modal-copy">
          <span className="git-stash-view-kicker">Stash View</span>
          <strong>{stash?.message || `stash@{...}`}</strong>
        </div>
        <div className="git-stash-view-modal-tabs" role="tablist" aria-label="Stash view tabs">
          <button type="button" className={tab === "files" ? "active" : ""} onClick={() => onTabChange("files")}>Files</button>
          <button type="button" className={tab === "diff" ? "active" : ""} onClick={() => onTabChange("diff")}>Diff</button>
        </div>
        <button type="button" className="git-stash-view-close" onClick={onClose} aria-label="Close stash view">
          <Icon name="close" size={12} />
        </button>
      </div>

      <div className="git-stash-view-modal-body">
        {loading && (
          <div className="git-stash-view-loading">
            <div className="git-stash-view-spinner" />
            <span>Loading stash…</span>
          </div>
        )}

        {error && <div className="git-stash-view-error">{error}</div>}

        {!loading && !error && view && tab === "files" && (
          <div className="git-stash-view-files git-stash-view-modal-files">
            <div className="git-stash-view-section-title">Files</div>
            {view.files.length === 0 && <div className="git-stash-view-empty">No file changes</div>}
            {view.files.map((file, i) => (
              <div key={`${file.status}-${file.path}-${i}`} className="git-stash-file-row">
                <span className={`git-stash-file-status git-stash-file-status--${file.status.toLowerCase()}`}>{file.status}</span>
                <span className="git-stash-file-path" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
                  {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                </span>
              </div>
            ))}
          </div>
        )}

        {!loading && !error && view && tab === "diff" && (
          <div className="git-stash-view-diff git-stash-view-modal-diff">
            <div className="git-stash-view-section-title">Edits</div>
            {view.diff ? (
              <div className="git-stash-view-modal-diff-scroll">
                <DiffRenderer key={view.diff} content={view.diff} collapsible={false} />
              </div>
            ) : <div className="git-stash-view-empty">No patch available</div>}
          </div>
        )}
      </div>
    </>
  );
}


