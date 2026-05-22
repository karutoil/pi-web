import { useState, useEffect, useCallback, useRef } from "react";
import { Icon } from "./Icon";

interface FsItem {
  name: string;
  path: string;
  isDirectory: boolean;
}

interface BrowseResult {
  currentPath: string;
  parentPath: string | null;
  items: FsItem[];
  error?: string;
}

interface Props {
  onAdd: (path: string, name: string) => void;
  onCancel: () => void;
  initialPath?: string;
}

export function AddProjectExplorer({ onAdd, onCancel, initialPath }: Props) {
  const [currentPath, setCurrentPath] = useState(initialPath || "");
  const [items, setItems] = useState<FsItem[]>([]);
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [pathInput, setPathInput] = useState(currentPath);
  const [focusedIdx, setFocusedIdx] = useState(-1);
  const [isAdding, setIsAdding] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const pathInputRef = useRef<HTMLInputElement>(null);

  const browse = useCallback(async (dir: string) => {
    setLoading(true);
    setError(null);
    setSelectedPath(null);
    setSelectedName(null);
    setFocusedIdx(-1);
    try {
      const r = await fetch(`/api/fs/browse?dir=${encodeURIComponent(dir)}`);
      const data: BrowseResult = await r.json();
      if (data.error) {
        setError(data.error);
        setItems([]);
      } else {
        setItems(data.items);
        setCurrentPath(data.currentPath);
        setPathInput(data.currentPath);
        setParentPath(data.parentPath);
      }
    } catch {
      setError("Failed to browse directory");
      setItems([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    browse(currentPath);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const navigateTo = useCallback((dir: string) => {
    browse(dir);
  }, [browse]);

  const handleSelect = useCallback((item: FsItem) => {
    if (selectedPath === item.path) {
      // Double-click / double-select: enter directory
      navigateTo(item.path);
      return;
    }
    setSelectedPath(item.path);
    setSelectedName(item.name);
    if (!displayName) {
      setDisplayName(item.name);
    }
  }, [selectedPath, navigateTo, displayName]);

  const handleEnterDirectory = useCallback((item: FsItem) => {
    navigateTo(item.path);
  }, [navigateTo]);

  const handlePathSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = pathInput.trim();
    if (trimmed) {
      browse(trimmed);
    }
  }, [pathInput, browse]);

  const handleSubmit = useCallback(async () => {
    if (!selectedPath) return;
    setIsAdding(true);
    const name = displayName.trim() || selectedName || "";
    onAdd(selectedPath, name);
  }, [selectedPath, displayName, selectedName, onAdd]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setFocusedIdx(i => Math.min(i + 1, items.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setFocusedIdx(i => Math.max(i - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        if (focusedIdx >= 0 && focusedIdx < items.length) {
          handleSelect(items[focusedIdx]);
        } else if (selectedPath) {
          handleSubmit();
        }
        break;
      case "Backspace":
        if (document.activeElement === listRef.current && parentPath) {
          e.preventDefault();
          navigateTo(parentPath);
        }
        break;
      case "Escape":
        e.preventDefault();
        onCancel();
        break;
    }
  }, [focusedIdx, items, handleSelect, handleSubmit, selectedPath, parentPath, navigateTo, onCancel]);

  // Scroll focused item into view
  useEffect(() => {
    if (focusedIdx >= 0 && listRef.current) {
      const el = listRef.current.children[focusedIdx] as HTMLElement;
      el?.scrollIntoView({ block: "nearest" });
    }
  }, [focusedIdx]);

  return (
    <div
      className="fixed inset-0 z-60 flex items-center justify-center bg-ink-950/70 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      onKeyDown={handleKeyDown}
    >
      <div
        className="relative z-70 bg-ink-950 border border-ink-800/60 rounded-2xl shadow-2xl w-full max-w-xl mx-4 overflow-hidden animate-fade-in-up flex flex-col"
        style={{ maxHeight: "80vh" }}
      >
        {/* ── Header ── */}
        <div className="px-5 pt-5 pb-3 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-amber-600/15 flex items-center justify-center">
              <Icon name="plus" size={14} className="text-amber-500" />
            </div>
            <h2 className="text-ink-100 text-sm font-semibold tracking-wide">Add Project</h2>
          </div>
          <button
            onClick={onCancel}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-ink-600 hover:text-ink-300 hover:bg-ink-800/50 transition-theme"
            aria-label="Close"
          >
            <Icon name="close" size={14} />
          </button>
        </div>

        {/* ── Path bar ── */}
        <form onSubmit={handlePathSubmit} className="px-5 pb-2">
          <div className="flex items-center gap-1.5 bg-ink-900/80 border border-ink-800/50 rounded-lg px-2.5 py-1.5">
            <span className="text-ink-600 text-xs font-mono shrink-0">~/</span>
            <input
              ref={pathInputRef}
              type="text"
              value={pathInput}
              onChange={e => setPathInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Escape") { onCancel(); e.stopPropagation(); }
              }}
              className="flex-1 bg-transparent text-ink-200 text-xs font-mono placeholder-ink-600 outline-none min-w-0"
              placeholder="/home/user"
              spellCheck={false}
            />
            <button
              type="submit"
              className="shrink-0 text-ink-500 hover:text-amber-500 transition-theme"
              aria-label="Go to path"
            >
              <Icon name="chevron-right" size={12} />
            </button>
          </div>
        </form>

        {/* ── Directory listing ── */}
        <div className="px-5 flex-1 min-h-0 flex flex-col">
          {/* Navigation breadcrumb */}
          <div className="flex items-center gap-1 mb-2 text-xs">
            {parentPath && (
              <button
                onClick={() => navigateTo(parentPath)}
                className="flex items-center gap-1 text-ink-500 hover:text-amber-400 transition-theme"
                aria-label="Go to parent directory"
              >
                <Icon name="chevron-left" size={10} />
                <span className="font-mono">..</span>
              </button>
            )}
            <span className="text-ink-700 font-mono truncate flex-1 text-right">{currentPath}</span>
          </div>

          {/* File list */}
          <div
            ref={listRef}
            className="flex-1 min-h-0 overflow-y-auto custom-scrollbar rounded-lg border border-ink-800/30 bg-ink-900/40"
            tabIndex={0}
            role="listbox"
            aria-label="Directory contents"
          >
            {loading ? (
              <div className="flex items-center justify-center py-12 gap-2">
                <div className="w-3 h-3 border-2 border-ink-700 border-t-amber-500 rounded-full animate-spin" />
                <span className="text-ink-500 text-xs font-mono">Scanning...</span>
              </div>
            ) : error ? (
              <div className="py-12 text-center">
                <span className="text-rose-400/80 text-xs font-mono">{error}</span>
              </div>
            ) : items.length === 0 ? (
              <div className="py-12 text-center">
                <span className="text-ink-600 text-xs font-mono">No subdirectories found</span>
              </div>
            ) : (
              items.map((item, idx) => {
                const isSelected = selectedPath === item.path;
                const isFocused = focusedIdx === idx;
                return (
                  <button
                    key={item.path}
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => handleSelect(item)}
                    onDoubleClick={() => handleEnterDirectory(item)}
                    className={`w-full text-left flex items-center gap-2.5 px-3 py-2 transition-theme group ${
                      isSelected
                        ? "bg-amber-500/10 border-l-2 border-l-amber-500"
                        : isFocused
                        ? "bg-ink-800/30 border-l-2 border-l-transparent"
                        : "border-l-2 border-l-transparent hover:bg-ink-800/20"
                    }`}
                  >
                    {/* Folder icon */}
                    <div className={`shrink-0 w-5 h-5 rounded flex items-center justify-center transition-theme ${
                      isSelected ? "bg-amber-500/20" : "bg-ink-800/40 group-hover:bg-ink-800/60"
                    }`}>
                      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" className={isSelected ? "text-amber-400" : "text-ink-500 group-hover:text-ink-400"}>
                        <path d="M2 4.5C2 3.67 2.67 3 3.5 3H6L7.5 4.5H12.5C13.33 4.5 14 5.17 14 6V11.5C14 12.33 13.33 13 12.5 13H3.5C2.67 13 2 12.33 2 11.5V4.5Z" fill="currentColor" opacity="0.3"/>
                        <path d="M2 6H14V11.5C14 12.33 13.33 13 12.5 13H3.5C2.67 13 2 12.33 2 11.5V6Z" fill="currentColor"/>
                      </svg>
                    </div>
                    {/* Name + path hint */}
                    <div className="min-w-0 flex-1">
                      <div className={`text-xs font-medium truncate transition-theme ${
                        isSelected ? "text-amber-300" : "text-ink-200"
                      }`}>
                        {item.name}
                      </div>
                    </div>
                    {/* Enter arrow */}
                    <Icon
                      name="chevron-right-sm"
                      size={8}
                      className={`shrink-0 transition-theme ${
                        isSelected ? "text-amber-500/60" : "text-ink-700 group-hover:text-ink-500"
                      }`}
                    />
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* ── Footer: selection + display name + submit ── */}
        <div className="px-5 pt-3 pb-4 mt-3 border-t border-ink-800/40">
          {/* Selected path preview */}
          {selectedPath && (
            <div className="mb-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/5 border border-amber-500/15">
              <svg viewBox="0 0 16 16" width="12" height="12" fill="none" className="text-amber-500 shrink-0">
                <path d="M2 4.5C2 3.67 2.67 3 3.5 3H6L7.5 4.5H12.5C13.33 4.5 14 5.17 14 6V11.5C14 12.33 13.33 13 12.5 13H3.5C2.67 13 2 12.33 2 11.5V4.5Z" fill="currentColor" opacity="0.3"/>
                <path d="M2 6H14V11.5C14 12.33 13.33 13 12.5 13H3.5C2.67 13 2 12.33 2 11.5V6Z" fill="currentColor"/>
              </svg>
              <span className="text-amber-400/80 text-xs font-mono truncate">{selectedPath}</span>
            </div>
          )}

          {/* Display name input */}
          <div className="flex items-center gap-2 mb-3">
            <label className="text-ink-500 text-xs shrink-0" htmlFor="project-display-name">Name</label>
            <input
              id="project-display-name"
              type="text"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              placeholder={selectedName || "Folder name"}
              className="flex-1 bg-ink-900/60 border border-ink-800/50 rounded-md px-2.5 py-1.5 text-ink-200 text-xs placeholder-ink-600 outline-none focus:border-amber-500/50 transition-theme"
              spellCheck={false}
            />
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2">
            <button
              onClick={handleSubmit}
              disabled={!selectedPath || isAdding}
              className={`flex-1 py-2 rounded-lg text-xs font-medium transition-theme ${
                selectedPath && !isAdding
                  ? "bg-amber-600 hover:bg-amber-500 text-ink-950"
                  : "bg-ink-800/40 text-ink-600 cursor-not-allowed"
              }`}
            >
              {isAdding ? "Adding..." : selectedPath ? "Add Project" : "Select a Directory"}
            </button>
            <button
              onClick={onCancel}
              className="px-4 py-2 rounded-lg bg-ink-800/30 hover:bg-ink-800/50 text-ink-400 hover:text-ink-200 text-xs transition-theme"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
