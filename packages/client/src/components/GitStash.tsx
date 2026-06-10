import { useState, useEffect, useCallback } from "react";
import { Icon } from "./Icon";
import { useIsMobile } from "../hooks/useIsMobile";

// ─── Types ───

export interface GitStashEntry {
  index: number;
  message: string;
  branch: string;
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
              onApply={() => handleAction("apply", stash.index)}
              onPop={() => handleAction("pop", stash.index)}
              onDrop={() => handleAction("drop", stash.index)}
            />
          ))}
        </>
      )}
    </div>
  );
}

// ─── Stash Row ───

function StashRow({
  stash,
  acting,
  onApply,
  onPop,
  onDrop,
}: {
  stash: GitStashEntry;
  acting: boolean;
  onApply: () => void;
  onPop: () => void;
  onDrop: () => void;
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
