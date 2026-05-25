import { useState, useRef, useEffect, useCallback } from "react";
import { Icon } from "./Icon";

// ─── Types ───

interface GitBranchSelectorProps {
  cwd: string;
  currentBranch: string;
  ahead: number;
  behind: number;
  onRefresh: () => void;
}

interface RemoteInfo {
  name: string;
  url: string;
  type: "fetch" | "push";
}

// ─── Component ───

export function GitBranchSelector({ cwd, currentBranch, ahead, behind, onRefresh }: GitBranchSelectorProps) {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [remotes, setRemotes] = useState<RemoteInfo[]>([]);
  const [createInput, setCreateInput] = useState("");
  const [checkingOut, setCheckingOut] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRemotes, setShowRemotes] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const createInputRef = useRef<HTMLInputElement>(null);

  // Fetch branches, tags, remotes when dropdown opens
  useEffect(() => {
    if (!open) return;
    const enc = encodeURIComponent(cwd);
    fetch(`/api/git/branches?cwd=${enc}`)
      .then(r => r.json())
      .then(d => { if (d.branches) setBranches(d.branches); })
      .catch(() => {});
    fetch(`/api/git/tags?cwd=${enc}`)
      .then(r => r.json())
      .then(d => { if (d.tags) setTags(d.tags); })
      .catch(() => {});
    fetch(`/api/git/remotes?cwd=${enc}`)
      .then(r => r.json())
      .then(d => { if (d.remotes) setRemotes(d.remotes); })
      .catch(() => {});
    setCreateInput("");
    setError(null);
  }, [open, cwd]);

  // Focus create input when dropdown opens
  useEffect(() => {
    if (open) {
      // Small delay so dropdown renders first
      const t = setTimeout(() => createInputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Close on click outside or Escape
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent | TouchEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("touchend", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("touchend", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  // Checkout branch
  const handleCheckout = useCallback(async (branch: string) => {
    if (branch === currentBranch || checkingOut) return;
    setCheckingOut(true);
    setError(null);
    try {
      const r = await fetch("/api/git/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, branch }),
      });
      const d = await r.json();
      if (d.error) {
        setError(d.error);
      } else {
        setOpen(false);
        onRefresh();
      }
    } catch {
      setError("Checkout failed");
    } finally {
      setCheckingOut(false);
    }
  }, [cwd, currentBranch, checkingOut, onRefresh]);

  // Create branch
  const handleCreate = useCallback(async () => {
    const name = createInput.trim();
    if (!name || creating) return;
    setCreating(true);
    setError(null);
    try {
      const r = await fetch("/api/git/branch/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, name, checkout: true }),
      });
      const d = await r.json();
      if (d.error) {
        setError(d.error);
      } else {
        setCreateInput("");
        setOpen(false);
        onRefresh();
      }
    } catch {
      setError("Branch creation failed");
    } finally {
      setCreating(false);
    }
  }, [cwd, createInput, creating, onRefresh]);

  // Checkout tag (detached HEAD)
  const handleCheckoutTag = useCallback(async (tag: string) => {
    if (checkingOut) return;
    setCheckingOut(true);
    setError(null);
    try {
      const r = await fetch("/api/git/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, branch: `tags/${tag}` }),
      });
      const d = await r.json();
      if (d.error) {
        setError(d.error);
      } else {
        setOpen(false);
        onRefresh();
      }
    } catch {
      setError("Tag checkout failed");
    } finally {
      setCheckingOut(false);
    }
  }, [cwd, checkingOut, onRefresh]);

  return (
    <div className="relative inline-flex">
      {/* Trigger button */}
      <button
        ref={triggerRef}
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1.5 text-xs font-mono px-2 py-1 rounded bg-ink-850 border border-ink-750 hover:border-ink-600 text-ink-300 transition-theme"
        aria-label="Switch branch"
        aria-expanded={open}
      >
        <Icon name="git" size={12} className="text-amber-500" />
        <span className="text-amber-400 font-medium truncate max-w-[120px]">{currentBranch}</span>
        {(ahead > 0 || behind > 0) && (
          <span className="text-ink-500 text-[0.6rem]">
            {ahead > 0 && `↑${ahead}`}{behind > 0 && ` ↓${behind}`}
          </span>
        )}
      </button>

      {/* Dropdown */}
      {open && (
        <div
          ref={dropdownRef}
          className="absolute left-0 top-full mt-1 bg-ink-900 border border-ink-800 rounded-lg shadow-2xl z-40 min-w-[200px] md:min-w-[240px] max-w-[calc(100vw-1rem)] right-0 animate-fade-in-up"
        >
          {/* Create branch input */}
          <div className="px-2 py-2 border-b border-ink-800">
            <div className="flex items-center gap-1.5">
              <input
                ref={createInputRef}
                value={createInput}
                onChange={e => setCreateInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter") { e.preventDefault(); handleCreate(); }
                  if (e.key === "Escape") { e.stopPropagation(); setOpen(false); }
                }}
                placeholder="Create branch…"
                className="flex-1 bg-ink-850 border border-ink-700 rounded px-2 py-1 text-ink-200 text-xs font-mono placeholder-ink-500 outline-none focus:border-amber-500 transition-theme"
                aria-label="Create new branch"
                disabled={creating}
                enterKeyHint="done"
                autoCorrect="off"
              />
              <button
                onClick={handleCreate}
                disabled={!createInput.trim() || creating}
                className={`shrink-0 px-2 py-1 min-h-[44px] rounded text-xs font-medium transition-theme ${
                  createInput.trim() && !creating
                    ? "bg-amber-600 hover:bg-amber-500 text-ink-950"
                    : "bg-ink-800/40 text-ink-400 cursor-not-allowed"
                }`}
                aria-label="Create branch"
              >
                {creating ? "…" : "✓"}
              </button>
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="px-3 py-1.5 text-rose-400/80 text-xs font-mono border-b border-ink-800 truncate" title={error}>
              {error}
            </div>
          )}

          {/* Branches list */}
          <div className="max-h-48 overflow-y-auto custom-scrollbar py-0.5">
            {branches.length === 0 && (
              <div className="px-3 py-2 text-ink-500 text-xs font-mono">No branches</div>
            )}
            {branches.map(branch => (
              <button
                key={branch}
                onClick={() => handleCheckout(branch)}
                disabled={checkingOut}
                className={`w-full text-left px-3 py-1.5 text-xs font-mono hover:bg-ink-850 transition-theme flex items-center gap-2 min-h-[44px] ${
                  branch === currentBranch ? "text-amber-400 bg-amber-500/5" : "text-ink-300"
                }`}
              >
                <span className="shrink-0 w-3">
                  {branch === currentBranch && <span className="text-amber-500">●</span>}
                </span>
                <span className="truncate">{branch}</span>
                {branch === currentBranch && (
                  <span className="ml-auto text-amber-600 text-[0.6rem] shrink-0">current</span>
                )}
              </button>
            ))}
          </div>

          {/* Tags section */}
          {tags.length > 0 && (
            <>
              <div className="border-t border-ink-800 mx-2" />
              <div className="px-3 py-1 text-ink-500 text-[0.65rem] font-semibold tracking-wide uppercase">
                Tags
              </div>
              <div className="max-h-32 overflow-y-auto custom-scrollbar py-0.5">
                {tags.slice(0, 20).map(tag => (
                  <button
                    key={tag}
                    onClick={() => handleCheckoutTag(tag)}
                    disabled={checkingOut}
                    className="w-full text-left px-3 py-1 text-xs font-mono text-ink-400 hover:bg-ink-850 hover:text-ink-200 transition-theme truncate min-h-[44px]"
                  >
                    {tag}
                  </button>
                ))}
                {tags.length > 20 && (
                  <div className="px-3 py-1 text-ink-500 text-[0.6rem] font-mono">
                    +{tags.length - 20} more
                  </div>
                )}
              </div>
            </>
          )}

          {/* Remote info tooltip toggle */}
          {remotes.length > 0 && (
            <>
              <div className="border-t border-ink-800 mx-2" />
              <button
                onClick={() => setShowRemotes(v => !v)}
                className="w-full text-left px-3 py-1.5 text-xs text-ink-500 hover:text-ink-300 hover:bg-ink-850 transition-theme flex items-center gap-1.5"
              >
                <Icon name="chevron-right-sm" size={8} className={`transition-transform ${showRemotes ? "rotate-90" : ""}`} />
                Remotes
              </button>
              {showRemotes && (
                <div className="px-3 pb-1.5 space-y-0.5">
                  {remotes.map((r, i) => (
                    <div key={`${r.name}-${r.type}-${i}`} className="text-[0.65rem] font-mono text-ink-500 truncate" title={`${r.name} ${r.type} ${r.url}`}>
                      <span className="text-ink-500">{r.name}</span>
                      <span className="text-ink-500"> ({r.type})</span>
                      {" "}
                      <span className="text-ink-500">{r.url}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {/* Spinner overlay */}
          {checkingOut && (
            <div className="absolute inset-0 bg-ink-900/60 flex items-center justify-center rounded-lg">
              <div className="w-4 h-4 border-2 border-ink-700 border-t-amber-500 rounded-full animate-spin" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
