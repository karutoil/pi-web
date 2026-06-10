import { useState, useRef, useEffect, useCallback } from "react";
import { Icon } from "./Icon";

interface GitBranchSelectorProps {
  cwd: string;
  currentBranch: string;
  ahead: number;
  behind: number;
  onRefresh: () => void;
  dropdownPosition?: "above" | "below";
}

interface RemoteInfo {
  name: string;
  url: string;
  type: "fetch" | "push";
}

export function GitBranchSelector({ cwd, currentBranch, ahead, behind, onRefresh, dropdownPosition = "below" }: GitBranchSelectorProps) {
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

  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    const enc = encodeURIComponent(cwd);
    fetch(`/api/git/branches?cwd=${enc}`, { signal: ctrl.signal })
      .then(r => r.json())
      .then(d => { if (d.branches) setBranches(d.branches); })
      .catch(() => {});
    fetch(`/api/git/tags?cwd=${enc}`, { signal: ctrl.signal })
      .then(r => r.json())
      .then(d => { if (d.tags) setTags(d.tags); })
      .catch(() => {});
    fetch(`/api/git/remotes?cwd=${enc}`, { signal: ctrl.signal })
      .then(r => r.json())
      .then(d => { if (d.remotes) setRemotes(d.remotes); })
      .catch(() => {});
    setCreateInput("");
    setError(null);
    return () => ctrl.abort();
  }, [open, cwd]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => createInputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [open]);

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
    <div className="git-branch-selector-root">
      <button
        ref={triggerRef}
        onClick={() => setOpen(v => !v)}
        className="git-branch-selector-trigger"
        aria-label="Switch branch"
        aria-expanded={open}
      >
        <Icon name="git" size={12} className="git-branch-selector-icon" />
        <span className="git-branch-selector-name">{currentBranch}</span>
        {(ahead > 0 || behind > 0) && (
          <span className="git-branch-selector-sync">
            {ahead > 0 && `↑${ahead}`}{behind > 0 && ` ↓${behind}`}
          </span>
        )}
        <Icon name="chevron-down" size={10} className="git-branch-selector-chevron" />
      </button>

      {open && (
        <div
          ref={dropdownRef}
          className={`git-branch-selector-dropdown ${dropdownPosition === "above" ? "git-branch-selector-dropdown--above" : "git-branch-selector-dropdown--below"}`}
        >
          <div className="git-branch-selector-header">
            <div className="git-branch-selector-header-copy">
              <div className="git-branch-selector-kicker">Git ref</div>
              <div className="git-branch-selector-title">Switch branch</div>
            </div>
            <button
              type="button"
              className="git-branch-selector-icon-button"
              onClick={onRefresh}
              aria-label="Refresh branch data"
              title="Refresh"
            >
              <Icon name="refresh" size={12} />
            </button>
          </div>

          <div className="git-branch-selector-create">
            <input
              ref={createInputRef}
              value={createInput}
              onChange={e => setCreateInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter") { e.preventDefault(); handleCreate(); }
                if (e.key === "Escape") { e.stopPropagation(); setOpen(false); }
              }}
              placeholder="Create branch…"
              className="git-branch-selector-input"
              aria-label="Create new branch"
              disabled={creating}
              enterKeyHint="done"
              autoCorrect="off"
            />
            <button
              type="button"
              onClick={handleCreate}
              disabled={!createInput.trim() || creating}
              className="git-branch-selector-create-button"
              aria-label="Create branch"
            >
              {creating ? "…" : "✓"}
            </button>
          </div>

          {error && (
            <div className="git-branch-selector-error" title={error}>
              {error}
            </div>
          )}

          <div className="git-branch-selector-section">
            <div className="git-branch-selector-section-head">
              <span>Branches</span>
              <span>{branches.length}</span>
            </div>
            <div className="git-branch-selector-list">
              {branches.length === 0 && (
                <div className="git-branch-selector-empty">No branches</div>
              )}
              {branches.map(branch => (
                <button
                  key={branch}
                  onClick={() => handleCheckout(branch)}
                  disabled={checkingOut}
                  className={`git-branch-selector-row ${branch === currentBranch ? "active" : ""}`}
                >
                  <span className="git-branch-selector-dot" />
                  <span className="git-branch-selector-row-name">{branch}</span>
                  {branch === currentBranch && (
                    <span className="git-branch-selector-current">current</span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {tags.length > 0 && (
            <div className="git-branch-selector-section">
              <div className="git-branch-selector-section-head">
                <span>Tags</span>
                <span>{tags.length}</span>
              </div>
              <div className="git-branch-selector-list">
                {tags.slice(0, 20).map(tag => (
                  <button
                    key={tag}
                    onClick={() => handleCheckoutTag(tag)}
                    disabled={checkingOut}
                    className="git-branch-selector-row"
                  >
                    <span className="git-branch-selector-dot" />
                    <span className="git-branch-selector-row-name">{tag}</span>
                  </button>
                ))}
                {tags.length > 20 && (
                  <div className="git-branch-selector-more">+{tags.length - 20} more</div>
                )}
              </div>
            </div>
          )}

          {remotes.length > 0 && (
            <div className="git-branch-selector-section">
              <button
                type="button"
                onClick={() => setShowRemotes(v => !v)}
                className="git-branch-selector-remote-toggle"
              >
                <Icon name="chevron-right-sm" size={8} className={`git-branch-selector-remote-chevron ${showRemotes ? "active" : ""}`} />
                <span>Remotes</span>
              </button>
              {showRemotes && (
                <div className="git-branch-selector-remotes">
                  {remotes.map((r, i) => (
                    <div key={`${r.name}-${r.type}-${i}`} className="git-branch-selector-remote" title={`${r.name} ${r.type} ${r.url}`}>
                      <span>{r.name}</span>
                      <span>({r.type})</span>
                      <span>{r.url}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="git-branch-selector-footer">
            <span>{cwd}</span>
            <span>{branches.length} branches</span>
          </div>

          {checkingOut && (
            <div className="git-branch-selector-overlay">
              <div className="git-branch-selector-spinner" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
