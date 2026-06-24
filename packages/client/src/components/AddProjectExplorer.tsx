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
  onAdd: (path: string, name: string, create?: boolean) => void;
  onCancel: () => void;
  initialPath?: string;
}

function FolderGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" className={className} aria-hidden>
      <path d="M2 4.5C2 3.67 2.67 3 3.5 3H6L7.5 4.5H12.5C13.33 4.5 14 5.17 14 6V11.5C14 12.33 13.33 13 12.5 13H3.5C2.67 13 2 12.33 2 11.5V4.5Z" fill="currentColor" opacity="0.3" />
      <path d="M2 6H14V11.5C14 12.33 13.33 13 12.5 13H3.5C2.67 13 2 12.33 2 11.5V6Z" fill="currentColor" />
    </svg>
  );
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

  const browse = useCallback(async (dir: string, opts?: { select?: boolean }) => {
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
        if (opts?.select) {
          const name = data.currentPath.split(/[\\/]/).filter(Boolean).pop() || "";
          setSelectedPath(data.currentPath);
          setSelectedName(name);
          setDisplayName(prev => prev || name);
        }
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
      // Re-selecting the current item opens it.
      navigateTo(item.path);
      return;
    }
    setSelectedPath(item.path);
    setSelectedName(item.name);
    setDisplayName(prev => prev || item.name);
  }, [selectedPath, navigateTo]);

  const handleEnterDirectory = useCallback((item: FsItem) => {
    navigateTo(item.path);
  }, [navigateTo]);

  const handlePathSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = pathInput.trim();
    if (trimmed) browse(trimmed, { select: true });
  }, [pathInput, browse]);

  // Add the SELECTED existing directory. Never creates — fixes the bug where
  // an existing folder was reported as "will create". Name is just the label.
  const handleAddExisting = useCallback(() => {
    if (isAdding || !selectedPath) return;
    setIsAdding(true);
    onAdd(selectedPath, displayName.trim() || selectedName || "", false);
  }, [isAdding, selectedPath, displayName, selectedName, onAdd]);

  // Create a brand-new folder inside the current location, then add it. Joins
  // with the server's native separator (inferred from currentPath) so the path
  // is correct on any platform. Refuses names that already exist here.
  const handleCreateNew = useCallback(() => {
    if (isAdding) return;
    const name = displayName.trim();
    const exists = items.some(i => i.name.toLowerCase() === name.toLowerCase());
    const valid = !!name && !!currentPath && !/[\\/]/.test(name) && name !== "." && name !== ".." && !exists;
    if (!valid) return;
    const sep = currentPath.includes("\\") ? "\\" : "/";
    const target = currentPath.replace(/[\\/]+$/, "") + sep + name;
    setIsAdding(true);
    onAdd(target, name, true);
  }, [isAdding, displayName, currentPath, items, onAdd]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const listFocused = document.activeElement === listRef.current;
    const pathFocused = document.activeElement?.id === "explorer-path-input";
    switch (e.key) {
      case "ArrowDown":
        if (!listFocused) return;
        e.preventDefault();
        setFocusedIdx(i => Math.min(i + 1, items.length - 1));
        break;
      case "ArrowUp":
        if (!listFocused) return;
        e.preventDefault();
        setFocusedIdx(i => Math.max(i - 1, 0));
        break;
      case "Enter":
        if (listFocused) {
          e.preventDefault();
          if (focusedIdx >= 0 && focusedIdx < items.length) handleSelect(items[focusedIdx]);
        } else if (!pathFocused) {
          // Enter from the name field adds the selected dir, or creates one.
          e.preventDefault();
          if (selectedPath) handleAddExisting(); else handleCreateNew();
        }
        break;
      case "Backspace":
        if (listFocused && parentPath) { e.preventDefault(); navigateTo(parentPath); }
        break;
      case "Escape":
        e.preventDefault();
        onCancel();
        break;
    }
  }, [focusedIdx, items, handleSelect, handleAddExisting, handleCreateNew, selectedPath, parentPath, navigateTo, onCancel]);

  useEffect(() => {
    if (focusedIdx >= 0 && listRef.current) {
      const el = listRef.current.children[focusedIdx] as HTMLElement;
      el?.scrollIntoView({ block: "nearest" });
    }
  }, [focusedIdx]);

  const trimmedName = displayName.trim();
  const nameIsValid = trimmedName.length > 0 && !/[\\/]/.test(trimmedName) && trimmedName !== "." && trimmedName !== "..";
  const nameExists = items.some(i => i.name.toLowerCase() === trimmedName.toLowerCase());
  const canCreate = !isAdding && nameIsValid && !!currentPath && !nameExists;
  const canAddExisting = !isAdding && !!selectedPath;
  const addLabel = isAdding
    ? "Adding…"
    : selectedPath
      ? "Add Project"
      : "Select a Directory";
  const newFolderTitle = !trimmedName
    ? "Type a folder name below, then create it here"
    : nameExists
      ? "A folder with this name already exists here"
      : `Create “${trimmedName}” in ${currentPath}`;

  return (
    <div
      className="modal-backdrop explorer-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      onKeyDown={handleKeyDown}
    >
      <div className="modal-stage explorer-stage">
        <div className="modal-card explorer-modal flex flex-col">
          {/* ── Header ──────────────────────────────────────────── */}
          <div className="modal-header mobile-safe-top">
            <div className="modal-header-icon">
              <Icon name="plus" size={14} />
            </div>
            <div className="modal-title-wrap">
              <h2 className="modal-title">Add Project</h2>
              <div className="modal-subtitle">Pick a directory to add, or create a new folder here.</div>
            </div>
            <button onClick={onCancel} className="modal-close explorer-iconbtn" aria-label="Close">
              <Icon name="close" size={14} />
            </button>
          </div>

          {/* ── Path bar: up · editable path · go ───────────────── */}
          <form onSubmit={handlePathSubmit} className="explorer-pathbar" role="search">
            <button
              type="button"
              onClick={() => parentPath && navigateTo(parentPath)}
              disabled={!parentPath}
              className="explorer-iconbtn explorer-up"
              aria-label="Go to parent directory"
              title="Up one level"
            >
              <Icon name="chevron-left" size={14} />
            </button>
            <input
              id="explorer-path-input"
              type="text"
              value={pathInput}
              onChange={e => setPathInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Escape") { onCancel(); e.stopPropagation(); } }}
              className="explorer-path-input"
              placeholder="/home/user/projects"
              spellCheck={false}
              enterKeyHint="go"
              autoCorrect="off"
              autoCapitalize="off"
              aria-label="Directory path"
            />
            <button
              type="submit"
              className="explorer-iconbtn explorer-go"
              aria-label="Go to path"
              title="Go"
            >
              <Icon name="chevron-right" size={14} />
            </button>
          </form>

          {/* ── Toolbar: new-folder action + current location ─── */}
          <div className="explorer-toolbar">
            <span className="explorer-location" title={currentPath || ""}>
              {currentPath || "—"}
            </span>
            <button
              type="button"
              onClick={handleCreateNew}
              disabled={!canCreate}
              className="explorer-newfolder-btn"
              title={newFolderTitle}
            >
              <Icon name="folder" size={13} />
              <span>New Folder</span>
            </button>
          </div>

          {/* ── File list (scrolls) ────────────────────────────── */}
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
                    className={`explorer-item ${isSelected ? "explorer-item--selected" : ""} ${isFocused ? "explorer-item--focused" : ""}`}
                  >
                    <div className="explorer-folder-icon">
                      <FolderGlyph />
                    </div>
                    <div className="explorer-item-name min-w-0 truncate">{item.name}</div>
                    {item.isDirectory && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleEnterDirectory(item); }}
                        className="explorer-item-arrow"
                        aria-label={`Open ${item.name}`}
                      >
                        <Icon name="chevron-right-sm" size={10} />
                      </button>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* ── Footer: name · selected path · actions ─────────── */}
          <div className="modal-footer explorer-footer mobile-safe-bottom">
            <label className="explorer-name-field" htmlFor="project-display-name">
              <span className="explorer-name-label">Name</span>
              <input
                id="project-display-name"
                type="text"
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                placeholder={selectedName || "New folder name"}
                className="modal-field explorer-name-input"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
            </label>

            {selectedPath && (
              <div className="explorer-selected" title={selectedPath}>
                <FolderGlyph className="explorer-selected-icon" />
                <span className="truncate">{selectedPath}</span>
              </div>
            )}

            <div className="explorer-actions">
              <button onClick={onCancel} className="modal-button modal-button--ghost">
                Cancel
              </button>
              <button
                onClick={handleAddExisting}
                disabled={!canAddExisting}
                className="modal-button modal-button--primary explorer-add"
              >
                {addLabel}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
