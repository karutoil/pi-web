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
      className="modal-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      onKeyDown={handleKeyDown}
    >
      <div className="modal-stage">
        <div
          className="modal-card modal-card--full explorer-modal animate-fade-in-up flex flex-col"
          style={{ maxHeight: "80vh" }}
        >
        <div className="modal-header mobile-safe-top">
          <div className="modal-header-icon">
            <Icon name="plus" size={14} />
          </div>
          <h2 className="modal-title">Add Project</h2>
          <button
            onClick={onCancel}
            className="modal-close"
            aria-label="Close"
          >
            <Icon name="close" size={14} />
          </button>
        </div>

        <form onSubmit={handlePathSubmit} className="modal-body modal-body--compact">
          <div className="explorer-pathbar">
            <span className="explorer-path-prefix">~/</span>
            <input
              ref={pathInputRef}
              type="text"
              value={pathInput}
              onChange={e => setPathInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Escape") { onCancel(); e.stopPropagation(); }
              }}
              className="explorer-path-input"
              placeholder="/home/user"
              spellCheck={false}
              enterKeyHint="go"
              autoCorrect="off"
            />
            <button
              type="submit"
              className="modal-close"
              aria-label="Go to path"
            >
              <Icon name="chevron-right" size={12} />
            </button>
          </div>
        </form>

        <div className="px-5 flex-1 min-h-0 flex flex-col">
          <div className="explorer-breadcrumb">
            {parentPath && (
              <button
                onClick={() => navigateTo(parentPath)}
                className="modal-button modal-button--ghost"
                aria-label="Go to parent directory"
              >
                <Icon name="chevron-left" size={10} />
                <span className="font-mono">..</span>
              </button>
            )}
            <span className="explorer-breadcrumb-path truncate flex-1 text-right">{currentPath}</span>
          </div>

          {/* File list */}
          <div
            ref={listRef}
            className="explorer-list custom-scrollbar"
            tabIndex={0}
            role="listbox"
            aria-label="Directory contents"
          >
            {loading ? (
              <div className="modal-empty">
                <strong>Scanning…</strong>
                <span>Reading the directory.</span>
              </div>
            ) : error ? (
              <div className="modal-empty">
                <strong>Could not browse</strong>
                <span>{error}</span>
              </div>
            ) : items.length === 0 ? (
              <div className="modal-empty">
                <strong>No subdirectories found</strong>
                <span>Choose another location.</span>
              </div>
            ) : (
              items.map((item, idx) => {
                const isSelected = selectedPath === item.path;
                const isFocused = focusedIdx === idx;
                return (
                  <div
                    key={item.path}
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => handleSelect(item)}
                    className={`explorer-item ${isSelected ? "explorer-item--selected" : isFocused ? "explorer-item--focused" : ""}`}
                  >
                    {/* Folder icon */}
                    <div className="explorer-folder-icon">
                      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" className="explorer-folder-svg">
                        <path d="M2 4.5C2 3.67 2.67 3 3.5 3H6L7.5 4.5H12.5C13.33 4.5 14 5.17 14 6V11.5C14 12.33 13.33 13 12.5 13H3.5C2.67 13 2 12.33 2 11.5V4.5Z" fill="currentColor" opacity="0.3"/>
                        <path d="M2 6H14V11.5C14 12.33 13.33 13 12.5 13H3.5C2.67 13 2 12.33 2 11.5V6Z" fill="currentColor"/>
                      </svg>
                    </div>
                    {/* Name + path hint */}
                    <div className="min-w-0 flex-1">
                      <div className="explorer-item-name">
                        {item.name}
                      </div>
                    </div>
                    {/* Enter arrow */}
                    {item.isDirectory ? (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleEnterDirectory(item); }}
                        className="explorer-item-arrow"
                        aria-label="Open directory"
                      >
                        <Icon
                          name="chevron-right-sm"
                          size={8}
                          className={isSelected ? "text-amber-500/60" : "text-ink-500 group-hover:text-ink-400"}
                        />
                      </button>
                    ) : (
                      <Icon
                        name="chevron-right-sm"
                        size={8}
                        className={`explorer-item-arrow ${isSelected ? "explorer-item-arrow--selected" : ""}`}
                      />
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div className="modal-footer mobile-safe-bottom">
          {selectedPath && (
            <div className="explorer-preview">
              <svg viewBox="0 0 16 16" width="12" height="12" fill="none" className="explorer-preview-icon">
                <path d="M2 4.5C2 3.67 2.67 3 3.5 3H6L7.5 4.5H12.5C13.33 4.5 14 5.17 14 6V11.5C14 12.33 13.33 13 12.5 13H3.5C2.67 13 2 12.33 2 11.5V4.5Z" fill="currentColor" opacity="0.3"/>
                <path d="M2 6H14V11.5C14 12.33 13.33 13 12.5 13H3.5C2.67 13 2 12.33 2 11.5V6Z" fill="currentColor"/>
              </svg>
              <span className="truncate">{selectedPath}</span>
            </div>
          )}

          <div className="explorer-name-row">
            <label className="text-ink-500 text-xs shrink-0" htmlFor="project-display-name">Name</label>
            <input
              id="project-display-name"
              type="text"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              placeholder={selectedName || "Folder name"}
              className="modal-field flex-1"
              spellCheck={false}
            />
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 w-full">
            <button
              onClick={handleSubmit}
              disabled={!selectedPath || isAdding}
              className={`modal-button modal-button--primary flex-1 ${!selectedPath || isAdding ? "opacity-45 cursor-not-allowed" : ""}`}
            >
              {isAdding ? "Adding..." : selectedPath ? "Add Project" : "Select a Directory"}
            </button>
            <button
              onClick={onCancel}
              className="modal-button modal-button--ghost"
            >
              Cancel
            </button>
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}
