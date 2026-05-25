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
        else setStashes(d.stashes || []);
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
        if (!d.error) setStashes(d.stashes || []);
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
      }
    } finally {
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
    } finally {
      setActingIndex(null);
    }
  }, [cwd, onRefresh]);

  return (
    <div>
      {/* ── Collapsible header ── */}
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-ink-300 hover:bg-ink-900/30 transition-theme"
      >
        <Icon name={expanded ? "chevron-down" : "chevron-right"} size={8} />
        Stashes
        {stashCount > 0 && (
          <span className="text-ink-500 font-normal ml-auto">{stashCount}</span>
        )}
        {stashCount > 0 && (
          <button
            onClick={(e) => { e.stopPropagation(); setShowStashInput(v => !v); }}
            className="text-ink-500 hover:text-amber-500 transition-theme ml-1 p-0.5"
            aria-label="New stash"
            title="Stash"
          >
            <Icon name="plus" size={10} />
          </button>
        )}
      </button>

      {/* ── Stash input ── */}
      {expanded && showStashInput && (
        <div className="px-3 py-1.5 border-b border-ink-800/20">
          <div className="flex items-center gap-1.5">
            <input
              value={stashMsg}
              onChange={e => setStashMsg(e.target.value)}
              placeholder="Stash message (optional)"
              className="flex-1 bg-ink-900/60 border border-ink-800/50 rounded px-2 py-1 text-ink-200 text-xs placeholder-ink-500 outline-none focus:border-amber-500/50 transition-theme font-mono"
              onKeyDown={e => {
                if (e.key === "Enter") { e.preventDefault(); handleStash(); }
                if (e.key === "Escape") setShowStashInput(false);
              }}
              autoFocus
              enterKeyHint="done"
            />
            <button
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

      {/* ── Stash list ── */}
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

          {!loading && !error && stashes.length === 0 && stashCount === 0 && (
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
      className="flex items-center gap-1.5 px-3 py-1.5 hover:bg-ink-900/30 transition-theme group cursor-default"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Index badge */}
      <span className="text-amber-500/70 text-[0.6rem] font-mono font-bold w-3 text-center shrink-0">
        {stash.index}
      </span>

      {/* Message + branch */}
      <div className="flex-1 min-w-0">
        <span className="text-ink-300 text-xs font-mono truncate block" title={stash.message}>
          {stash.message}
        </span>
        <span className="text-ink-500 text-[0.6rem] font-mono truncate block">
          {stash.branch}
        </span>
      </div>

      {/* Hover actions */}
      {showActions && (
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            onClick={onApply}
            disabled={acting}
            className="px-2 py-1 md:px-1.5 md:py-0.5 text-xs md:text-[0.65rem] font-mono text-ink-400 hover:text-amber-500 hover:bg-ink-800/50 rounded transition-theme disabled:opacity-40 min-h-[44px] md:min-h-0"
            title="Apply stash"
          >
            Apply
          </button>
          <button
            onClick={onPop}
            disabled={acting}
            className="px-2 py-1 md:px-1.5 md:py-0.5 text-xs md:text-[0.65rem] font-mono text-ink-400 hover:text-amber-500 hover:bg-ink-800/50 rounded transition-theme disabled:opacity-40 min-h-[44px] md:min-h-0"
            title="Pop stash"
          >
            Pop
          </button>
          <button
            onClick={onDrop}
            disabled={acting}
            className="px-2 py-1 md:px-1.5 md:py-0.5 text-xs md:text-[0.65rem] font-mono text-ink-400 hover:text-rose-400 hover:bg-ink-800/50 rounded transition-theme disabled:opacity-40 min-h-[44px] md:min-h-0"
            title="Drop stash"
          >
            Drop
          </button>
        </div>
      )}
    </div>
  );
}
