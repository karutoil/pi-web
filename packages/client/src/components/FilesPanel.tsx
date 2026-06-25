import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { FileTree, useFileTree, useFileTreeSelection, useFileTreeSearch } from "@pierre/trees/react";
import type { GitStatusEntry, FileTreeDropResult, FileTreeDropTarget } from "@pierre/trees";
import CodeMirror from "@uiw/react-codemirror";
import { vscodeDark, vscodeLight } from "@uiw/codemirror-theme-vscode";
import { EditorView } from "@codemirror/view";
import { LanguageDescription } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { languages } from "@codemirror/language-data";
import { useTheme } from "../hooks/useTheme";
import { useIsMobile } from "../hooks/useIsMobile";
import { useEditorTabs, makeEditorTabId } from "../hooks/useEditorTabs";
import { piWebStorage } from "../lib/piWebStorage";
import { Icon } from "./Icon";
import { OutlineSection } from "./OutlineSection";
import { ConfirmDialog } from "./ConfirmDialog";
import type { SearchResult } from "@pi-web/shared";
import type { SymbolOutline } from "../lib/symbolParser";

// ─── Types ───

interface FilesPanelProps {
  cwd: string;
  projectId: string;
  visible: boolean;
  onClose: () => void;
  embedded?: boolean;
}

// ─── Helpers ───

function joinPath(a: string, b: string) {
  return a.replace(/\/+$/, "") + "/" + b.replace(/^\/+/, "");
}

// ponytail: mirror the model's getPathBasename/resolveMoveDestinationPath
// (not exported) to compute each dragged path's destination inside a folder.
function computeMoveDest(draggedPath: string, target: FileTreeDropTarget): string {
  const dir = target.directoryPath;
  const isDir = draggedPath.endsWith("/");
  const base = draggedPath.replace(/\/+$/, "").split("/").pop();
  if (!base) return draggedPath;
  const name = isDir ? base + "/" : base;
  return dir ? joinPath(dir, name) : name;
}

// ponytail: the model already rejects self/descendant drops before reaching
// onDropComplete/canDrop (isSelfOrDescendantDrop in dragAndDrop.js); this is a
// defensive prefix guard. Upgrade path: rely on the model alone.
function isMoveIntoSelfOrDescendant(draggedPath: string, destRel: string): boolean {
  const src = draggedPath.replace(/\/+$/, "");
  return destRel === draggedPath || destRel === src || destRel.startsWith(src + "/");
}

async function loadLanguageExtension(fileName: string): Promise<Extension> {
  const desc = LanguageDescription.matchFilename(languages, fileName);
  if (!desc) return [];
  try {
    const support = await desc.load();
    return support;
  } catch {
    return [];
  }
}

// ─── Code Editor ───

function CodeEditor({ filePath, content, onChange, onSave, onClose, saveError, gotoLine, onGotoLine }: {
  filePath: string;
  content: string;
  onChange?: (value: string) => void;
  onSave: () => void;
  onClose: () => void;
  saveError?: string | null;
  gotoLine?: number | null;
  onGotoLine?: (line: number) => void;
}) {
  const [editContent, setEditContent] = useState(content);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [theme] = useTheme();

  const chromeTheme = useMemo(() => {
    return EditorView.theme({
      "&": {
        backgroundColor: "var(--files-bg)",
        color: "var(--files-text)",
        height: "100%",
      },
      ".cm-gutters": {
        backgroundColor: "var(--files-bg)",
        color: "var(--files-text-muted)",
        borderRight: "1px solid var(--files-border)",
      },
      ".cm-activeLine": { backgroundColor: "var(--files-surface)" },
      ".cm-activeLineGutter": { backgroundColor: "var(--files-surface)" },
      ".cm-cursor": { borderLeftColor: "var(--files-accent)" },
      ".cm-selectionBackground": {
        backgroundColor: "color-mix(in srgb, var(--files-accent) 15%, transparent)",
      },
      "&.cm-focused .cm-selectionBackground": {
        backgroundColor: "color-mix(in srgb, var(--files-accent) 25%, var(--files-surface))",
      },
      ".cm-scroller": { fontFamily: "var(--font-mono)" },
    });
  }, []);

  const [extensions, setExtensions] = useState<Extension[]>([chromeTheme, theme === "dark" ? vscodeDark : vscodeLight]);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    if (!gotoLine || !viewRef.current) return;
    const view = viewRef.current;
    try {
      const pos = view.state.doc.line(gotoLine).from;
      view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: "center" }),
      });
      onGotoLine?.(gotoLine);
    } catch {}
  }, [gotoLine, onGotoLine]);

  useEffect(() => {
    setEditContent(content);
    setDirty(false);
  }, [content]);

  useEffect(() => {
    let active = true;
    const base = [chromeTheme, theme === "dark" ? vscodeDark : vscodeLight];
    setExtensions(base as Extension[]);
    loadLanguageExtension(filePath).then((ext) => {
      if (active) setExtensions([...base, ext].filter(Boolean) as Extension[]);
    });
    return () => { active = false; };
  }, [filePath, chromeTheme, theme]);

  const handleChange = useCallback((value: string) => {
    setEditContent(value);
    setDirty(true);
    onChange?.(value);
  }, [onChange]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await onSave();
    } finally {
      setSaving(false);
    }
  }, [onSave]);

  const handleEditorKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      if (dirty) handleSave();
    }
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    }
  }, [dirty, handleSave, onClose]);

  const fileName = filePath.split("/").pop() || filePath;
  const lineCount = editContent.split("\n").length;

  return (
    <div className="files-editor flex flex-col h-full" onKeyDown={handleEditorKeyDown}>
      <div className="files-editor-toolbar shrink-0">
        <button type="button" onClick={onClose} className="files-panel-icon-button" aria-label="Close editor">
          <Icon name="chevron-left" size={12} />
        </button>
        <span className="files-editor-path truncate">{fileName}</span>
        {dirty && <span className="files-editor-dirty">●</span>}
        <div className="ml-auto flex items-center gap-1">
          <span className="files-editor-lines">{lineCount} lines</span>
          <button
            type="button"
            onClick={handleSave}
            disabled={!dirty || saving}
            className={`files-editor-save ${dirty ? "files-editor-save-active" : ""}`}
          >
            {saving ? "…" : "Save"}
          </button>
        </div>
      </div>
      {saveError && (
        <div className="shrink-0 px-3 py-2 text-xs text-rose-400 bg-rose-500/10 border-b border-ink-800">
          {saveError}
        </div>
      )}
      <div className="files-editor-content flex-1 min-h-0 relative">
        <CodeMirror
          value={editContent}
          height="100%"
          extensions={extensions}
          onChange={handleChange}
          onCreateEditor={(view) => { viewRef.current = view; }}
          className="h-full"
          basicSetup={{ lineNumbers: true, highlightActiveLineGutter: true, highlightActiveLine: true }}
        />
      </div>
    </div>
  );
}

// ─── Diff Viewer ───

function DiffViewer({ diff, path, onClose }: {
  diff: string;
  path: string;
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const handleDiffKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    }
  }, [onClose]);

  useEffect(() => {
    containerRef.current?.focus({ preventScroll: true });
  }, []);

  const lines = diff.split("\n");
  const fileName = path.split("/").pop() || path;

  return (
    <div ref={containerRef} className="files-diff-viewer flex flex-col h-full outline-none" tabIndex={-1} onKeyDown={handleDiffKeyDown}>
      <div className="files-editor-toolbar shrink-0">
        <button type="button" onClick={onClose} className="files-panel-icon-button" aria-label="Back">
          <Icon name="chevron-left" size={12} />
        </button>
        <span className="files-editor-path truncate">{fileName}</span>
        <span className="files-diff-badge">diff</span>
      </div>
      <div className="files-diff-content custom-scrollbar flex-1 min-h-0 overflow-auto">
        {lines.map((line, i) => {
          let kind = "plain";
          if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("diff ")) kind = "meta";
          else if (line.startsWith("@@")) kind = "hunk";
          else if (line.startsWith("+") && !line.startsWith("++")) kind = "add";
          else if (line.startsWith("-") && !line.startsWith("--")) kind = "remove";

          return (
            <div key={i} className={`files-diff-line files-diff-line-${kind}`}>
              <span>{line}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main Panel ───

export function FilesPanel({ cwd, projectId, visible, onClose, embedded }: FilesPanelProps) {
  const isMobile = useIsMobile();
  const panelRef = useRef<HTMLDivElement>(null);
  const [paths, setPaths] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [diffContent, setDiffContent] = useState<string | null>(null);
  const [diffPath, setDiffPath] = useState<string | null>(null);
  const [gitStatusEntries, setGitStatusEntries] = useState<GitStatusEntry[]>([]);
  const [leftMode, setLeftMode] = useState<"files" | "search">("files");
  const [outlineCollapsed, setOutlineCollapsed] = useState(false);

  // File operations (create/rename/delete/duplicate)
  const [pendingDelete, setPendingDelete] = useState<
    | { kind: "single"; relativePath: string; fullPath: string; isFolder: boolean }
    | { kind: "bulk"; paths: string[] }
    | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [fsError, setFsError] = useState<string | null>(null);
  // Project-wide search state
  const [searchQuery, setSearchQuery] = useState("");
  const [searchRegex, setSearchRegex] = useState(false);
  const [searchCase, setSearchCase] = useState(false);
  const [searchWord, setSearchWord] = useState(false);
  const [searchGlob, setSearchGlob] = useState("");
  const [searchExclude, setSearchExclude] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const {
    tabs,
    activeTab,
    activeTabId,
    openFile,
    closeTab,
    setActiveTabId,
    updateUnsaved,
    markSaved,
    renameTab,
    setTabError,
    gotoTabLine,
    clearGotoLine,
  } = useEditorTabs(projectId, cwd);

  const [explorerWidth, setExplorerWidth] = useState<number>(() => {
    try {
      const v = piWebStorage.getItem("files-panel-explorer-width");
      if (v) return Math.max(160, parseInt(v, 10) || 192);
    } catch {}
    return 192;
  });
  const explorerWidthRef = useRef(explorerWidth);
  explorerWidthRef.current = explorerWidth;
  const dragStateRef = useRef<{ startX: number; startWidth: number; panelWidth: number } | null>(null);

  const fetchFiles = useCallback(async () => {
    if (!cwd) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/fs/list?dir=${encodeURIComponent(cwd)}&projectId=${encodeURIComponent(projectId)}`);
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        setPaths(data.paths || []);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [cwd, projectId]);

  const fetchGitStatus = useCallback(async () => {
    if (!cwd) return;
    try {
      const res = await fetch(`/api/git/status?cwd=${encodeURIComponent(cwd)}`);
      const data = await res.json();
      const entries: GitStatusEntry[] = [];
      for (const f of data.staged || []) {
        const status = mapGitStatus(f.status);
        if (status) entries.push({ path: f.path, status });
      }
      for (const f of data.unstaged || []) {
        const status = mapGitStatus(f.status);
        if (status) entries.push({ path: f.path, status });
      }
      setGitStatusEntries(entries);
    } catch {
      setGitStatusEntries([]);
    }
  }, [cwd]);

  useEffect(() => {
    if (visible) {
      fetchFiles();
      fetchGitStatus();
      panelRef.current?.focus({ preventScroll: true });
    }
  }, [visible, fetchFiles, fetchGitStatus]);

  const handleFileSelect = useCallback((relativePath: string) => {
    const fullPath = joinPath(cwd, relativePath);
    openFile(fullPath);
  }, [cwd, openFile]);

  const handleSaveFile = useCallback(async () => {
    if (!activeTab) return;
    setTabError(activeTab.id, null);
    try {
      const res = await fetch("/api/fs/write", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: activeTab.filePath, projectId, content: activeTab.unsavedContent, overwrite: true }),
      });
      const data = await res.json();
      if (!data.success) {
        setTabError(activeTab.id, data.error || "Failed to save file");
      } else {
        markSaved(activeTab.id);
        fetchGitStatus();
      }
    } catch (e: any) {
      setTabError(activeTab.id, e.message || "Failed to save file");
    }
  }, [activeTab, projectId, markSaved, fetchGitStatus, setTabError]);

  const handleViewDiff = useCallback(async (relativePath: string) => {
    const fullPath = joinPath(cwd, relativePath);
    setDiffPath(fullPath);
    try {
      const res = await fetch(`/api/git/diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(relativePath)}`);
      const data = await res.json();
      setDiffContent(data.diff || "No changes");
    } catch (e: any) {
      setDiffContent(`Error loading diff: ${e.message}`);
    }
  }, [cwd]);

  const handleRefresh = useCallback(() => {
    fetchFiles();
    fetchGitStatus();
  }, [fetchFiles, fetchGitStatus]);

  const showFsError = useCallback((e: any) => {
    const msg = e?.message || typeof e === "string" ? e : "Operation failed";
    setFsError(msg);
    setTimeout(() => setFsError(null), 4000);
  }, []);

  // Track the most recent tree paths + git status so model-callback closures
  // (which are created once via refs) read fresh values.
  const pathsRef = useRef(paths);
  pathsRef.current = paths;

  // Full refresh that also closes any open editor tabs for deleted paths.
  const refreshAfterMutation = useCallback(async (opts?: { deletedPaths?: string[] }) => {
    await fetchFiles();
    fetchGitStatus();
    if (opts?.deletedPaths?.length) {
      const deleted = opts.deletedPaths.map(p => joinPath(cwd, p).toLowerCase());
      for (const t of tabs) {
        if (deleted.some(dp => t.filePath.toLowerCase() === dp || t.filePath.toLowerCase().startsWith(dp + "/"))) {
          closeTab(t.id, { force: true });
        }
      }
    }
  }, [fetchFiles, fetchGitStatus, cwd, tabs, closeTab]);

  // ── Create ──
  const handleCreate = useCallback(async (kind: "file" | "folder", dirRelPath: string) => {
    const base = dirRelPath.replace(/\/+$/, "");
    const promptLabel = kind === "folder" ? "Folder name" : "File name";
    // ponytail: window.prompt is the simplest inline name entry. Replace with
    // a styled modal if/when the editor gets a richer prompt component.
    const name = window.prompt(promptLabel, kind === "folder" ? "new-folder" : "new-file.txt");
    if (!name) return;
    const relativePath = base ? `${base}/${name}` : name;
    const fullPath = joinPath(cwd, relativePath);
    setBusy(true);
    try {
      const res = await fetch("/api/fs/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: fullPath, projectId, kind }),
      });
      const data = await res.json();
      if (!data.success) { showFsError(data.error); return; }
      await refreshAfterMutation();
      if (kind === "file") openFile(fullPath);
    } catch (e: any) { showFsError(e); } finally { setBusy(false); }
  }, [cwd, projectId, refreshAfterMutation, openFile, showFsError]);

  // ── Rename / move (called by the tree's renaming hook) ──
  const handleRename = useCallback(async (sourcePath: string, destinationPath: string) => {
    const fromFull = joinPath(cwd, sourcePath);
    const toFull = joinPath(cwd, destinationPath);
    setBusy(true);
    try {
      const res = await fetch("/api/fs/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: fromFull, destination: toFull, projectId }),
      });
      const data = await res.json();
      if (!data.success) {
        showFsError(data.error);
        // The tree already moved the path in memory; re-sync from server.
        await refreshAfterMutation();
        return;
      }
      await refreshAfterMutation();
      // If an editor tab was open for the old path, re-point it to the new path
      // in place — preserving any unsaved edits (closeTab+openFile would
      // discard them).
      const oldId = makeEditorTabId(projectId, fromFull);
      const newId = makeEditorTabId(projectId, toFull);
      if (tabs.some(t => t.id === oldId)) {
        renameTab(oldId, newId, toFull);
      }
    } catch (e: any) { showFsError(e); } finally { setBusy(false); }
  }, [cwd, projectId, refreshAfterMutation, tabs, renameTab, showFsError]);

  // ── Delete ──
  const handleDelete = useCallback(async (relativePath: string) => {
    const fullPath = joinPath(cwd, relativePath);
    const isFolder = relativePath.endsWith("/");
    setBusy(true);
    try {
      const res = await fetch("/api/fs/delete", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: fullPath, projectId }),
      });
      const data = await res.json();
      if (!data.success) { showFsError(data.error); return; }
      await refreshAfterMutation({ deletedPaths: [relativePath] });
    } catch (e: any) { showFsError(e); } finally { setBusy(false); }
  }, [cwd, projectId, refreshAfterMutation, showFsError]);

  // ── Bulk delete (loops /api/fs/delete via Promise.allSettled) ──
  const handleBulkDelete = useCallback(async (relativePaths: string[]) => {
    if (relativePaths.length === 0) return;
    setBusy(true);
    try {
      const results = await Promise.allSettled(
        relativePaths.map((p) =>
          fetch("/api/fs/delete", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: joinPath(cwd, p), projectId }),
          }).then((r) => r.json()),
        ),
      );
      const deleted: string[] = [];
      const errors: string[] = [];
      results.forEach((res, i) => {
        const p = relativePaths[i];
        if (res.status === "rejected") errors.push(`${p}: ${res.reason?.message ?? "failed"}`);
        else if (!res.value?.success) errors.push(`${p}: ${res.value?.error ?? "failed"}`);
        else deleted.push(p);
      });
      if (errors.length) {
        // ponytail: surface only the first error in the toast; a per-path
        // results list would need a richer UI. Add when bulk ops grow.
        showFsError(`Failed to delete ${errors.length} of ${relativePaths.length}: ${errors[0]}`);
      }
      await refreshAfterMutation({ deletedPaths: deleted });
    } catch (e: any) {
      showFsError(e);
    } finally {
      setBusy(false);
    }
  }, [cwd, projectId, refreshAfterMutation, showFsError]);

  // ── Duplicate (read + create copy) ──
  const handleDuplicate = useCallback(async (relativePath: string) => {
    const isFolder = relativePath.endsWith("/");
    if (isFolder) {
      showFsError("Folder duplication is not supported.");
      return;
    }
    const fullPath = joinPath(cwd, relativePath);
    const dot = relativePath.lastIndexOf(".");
    const slash = relativePath.lastIndexOf("/");
    const stem = dot > slash ? relativePath.slice(0, dot) : relativePath;
    const ext = dot > slash ? relativePath.slice(dot) : "";
    const copyRel = `${stem}-copy${ext}`;
    const copyFull = joinPath(cwd, copyRel);
    setBusy(true);
    try {
      const readRes = await fetch(`/api/fs/read?path=${encodeURIComponent(fullPath)}&projectId=${encodeURIComponent(projectId)}`);
      const readData = await readRes.json();
      if (readData.error) { showFsError(readData.error); return; }
      const writeRes = await fetch("/api/fs/write", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: copyFull, projectId, content: readData.content, overwrite: false }),
      });
      const writeData = await writeRes.json();
      if (!writeData.success) { showFsError(writeData.error); return; }
      await refreshAfterMutation();
    } catch (e: any) { showFsError(e); } finally { setBusy(false); }
  }, [cwd, projectId, refreshAfterMutation, showFsError]);
  // ── Drag-to-folder move (loops /api/fs/rename; same endpoint as handleRename) ──
  const handleDropMove = useCallback(async (event: FileTreeDropResult) => {
    const { draggedPaths, target } = event;
    if (draggedPaths.length === 0) return;
    // Build the move list (relative source → relative destination), skipping
    // self/descendant moves defensively. The model already blocks these, so
    // this guard is defense-in-depth (see ponytail on dragAndDrop.canDrop).
    const moves: { fromRel: string; toRel: string }[] = [];
    for (const draggedPath of draggedPaths) {
      const toRel = computeMoveDest(draggedPath, target);
      if (isMoveIntoSelfOrDescendant(draggedPath, toRel)) continue;
      moves.push({ fromRel: draggedPath, toRel });
    }
    if (moves.length === 0) return;
    setBusy(true);
    try {
      const results = await Promise.allSettled(
        moves.map((m) =>
          fetch("/api/fs/rename", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: joinPath(cwd, m.fromRel), destination: joinPath(cwd, m.toRel), projectId }),
          }).then((r) => r.json()),
        ),
      );
      const errors: string[] = [];
      moves.forEach((m, i) => {
        const res = results[i];
        if (res.status === "rejected") errors.push(`${m.fromRel}: ${res.reason?.message ?? "failed"}`);
        else if (!res.value?.success && !res.value?.noop) errors.push(`${m.fromRel}: ${res.value?.error ?? "failed"}`);
      });
      if (errors.length) {
        // ponytail: surface only the first error (e.g. a 409 collision).
        showFsError(`Failed to move ${errors.length} of ${moves.length}: ${errors[0]}`);
      }
      await refreshAfterMutation();
      // Follow moved editor tabs: close the old path's tab and reopen at the
      // new location, mirroring handleRename. Skips failed moves.
      for (let i = 0; i < moves.length; i++) {
        const res = results[i];
        if (res.status !== "fulfilled" || (!res.value?.success && !res.value?.noop)) continue;
        const { fromRel, toRel } = moves[i];
        const oldId = makeEditorTabId(projectId, joinPath(cwd, fromRel));
        const newId = makeEditorTabId(projectId, joinPath(cwd, toRel));
        if (tabs.some((t) => t.id === oldId)) {
          // Re-point in place to preserve unsaved edits (see handleRename).
          renameTab(oldId, newId, joinPath(cwd, toRel));
        }
      }
    } catch (e: any) {
      showFsError(e);
    } finally {
      setBusy(false);
    }
  }, [cwd, projectId, refreshAfterMutation, tabs, renameTab, showFsError]);

// Keep callbacks in refs so the model's stale closure still calls current versions
  const handleFileSelectRef = useRef(handleFileSelect);
  handleFileSelectRef.current = handleFileSelect;
  const handleViewDiffRef = useRef(handleViewDiff);
  handleViewDiffRef.current = handleViewDiff;
  const handleRenameRef = useRef(handleRename);
  handleRenameRef.current = handleRename;
  const handleDropMoveRef = useRef(handleDropMove);
  handleDropMoveRef.current = handleDropMove;

  const handleRenameError = useCallback((error: string) => {
    showFsError(error);
  }, [showFsError]);

  const { model } = useFileTree({
    paths: [],
    gitStatus: [],
    dragAndDrop: {
      // ponytail: the model already blocks self/descendant drops via
      // isSelfOrDescendantDrop (dragAndDrop.js); canDrop is a defensive guard
      // so the intent is explicit at the boundary. Upgrade path: rely on the
      // model alone and drop canDrop.
      canDrop: (event) => {
        for (const draggedPath of event.draggedPaths) {
          if (isMoveIntoSelfOrDescendant(draggedPath, computeMoveDest(draggedPath, event.target))) return false;
        }
        return true;
      },
      onDropComplete: (event) => {
        handleDropMoveRef.current(event);
      },
    },
    renaming: {
      canRename: () => true,
      onRename: (event) => {
        handleRenameRef.current(event.sourcePath, event.destinationPath);
      },
      onError: handleRenameError,
    },
    onSelectionChange: (selectedPaths) => {
      // Open the clicked file only for a single-file selection. Extending a
      // selection (cmd/ctrl- or shift-click → length > 1) must not open files.
      if (selectedPaths.length === 1) {
        const path = selectedPaths[0];
        if (!path.endsWith("/")) {
          handleFileSelectRef.current(path);
        }
      }
    },
  });

  // Live selection array for the toolbar + bulk ops. The model already supports
  // cmd/ctrl-click (toggle) and shift-click (range) out of the box — no option
  // needs to be toggled on (see rowClickPlan.js).
  const selectedPaths = useFileTreeSelection(model);
  const selectedPathsRef = useRef(selectedPaths);
  selectedPathsRef.current = selectedPaths;
  const treeAreaRef = useRef<HTMLDivElement>(null);
  const clearSelection = useCallback(() => {
    // ponytail: no bulk clearSelection on the model; loop deselect per path.
    // Each deselect emits → N selected yields N renders. Upgrade path: a model
    // clearSelection() if multi-select churn becomes visible.
    for (const p of selectedPathsRef.current) {
      model.getItem(p)?.deselect();
    }
  }, [model]);

  useEffect(() => {
    model.resetPaths(paths);
  }, [model, paths]);

  useEffect(() => {
    model.setGitStatus(gitStatusEntries);
  }, [model, gitStatusEntries]);

  const fileSearch = useFileTreeSearch(model);

  const performSearch = useCallback(async () => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    setSearchLoading(true);
    setSearchError(null);
    try {
      const params = new URLSearchParams({ projectId, q: searchQuery.trim() });
      if (searchCase) params.set("caseSensitive", "true");
      if (searchWord) params.set("wholeWord", "true");
      if (searchRegex) params.set("regex", "true");
      if (searchGlob) params.set("glob", searchGlob);
      if (searchExclude) params.set("exclude", searchExclude);
      const res = await fetch(`/api/search?${params}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setSearchResults(data.results || []);
    } catch (e: any) {
      setSearchError(e.message || "Search failed");
      setSearchResults([]);
    } finally {
      setSearchLoading(false);
    }
  }, [projectId, searchQuery, searchCase, searchWord, searchRegex, searchGlob, searchExclude]);

  useEffect(() => {
    if (leftMode !== "search") return;
    const t = setTimeout(performSearch, 250);
    return () => clearTimeout(t);
  }, [leftMode, performSearch]);

  const handleResultClick = useCallback(async (relativePath: string, line: number) => {
    const fullPath = joinPath(cwd, relativePath);
    await openFile(fullPath);
    gotoTabLine(makeEditorTabId(projectId, fullPath), line);
    setLeftMode("files");
  }, [cwd, projectId, openFile, gotoTabLine]);

  const groupedResults = useMemo(() => {
    const map = new Map<string, SearchResult[]>();
    for (const r of searchResults) {
      map.set(r.path, [...(map.get(r.path) || []), r]);
    }
    return Array.from(map.entries());
  }, [searchResults]);

  const handlePanelKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "p") {
      e.preventDefault();
      fileSearch.open();
      return;
    }
    const inInput = e.nativeEvent.composedPath().some((el) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement);
    const treeFocused = !!treeAreaRef.current?.contains(document.activeElement);
    // Delete / Backspace on the tree (not inside the rename input) deletes the
    // current selection — single → existing confirm flow, multi → bulk flow.
    if ((e.key === "Delete" || e.key === "Backspace") && treeFocused && !inInput) {
      const sel = selectedPathsRef.current;
      if (sel.length === 0) return;
      e.preventDefault();
      if (sel.length >= 2) {
        setPendingDelete({ kind: "bulk", paths: [...sel] });
      } else {
        const p = sel[0];
        setPendingDelete({ kind: "single", relativePath: p, fullPath: joinPath(cwd, p), isFolder: p.endsWith("/") });
      }
      return;
    }
    // Esc clears a multi-selection when the tree has focus and no dialog is open.
    if (e.key === "Escape" && treeFocused && !inInput && !pendingDelete && selectedPathsRef.current.length >= 2) {
      e.preventDefault();
      clearSelection();
    }
  }, [fileSearch, cwd, clearSelection, pendingDelete]);

  const treeStyle = useMemo(() => ({
    ["--trees-bg-override" as string]: "var(--files-bg)",
    ["--trees-fg-override" as string]: "var(--files-text)",
    ["--trees-fg-muted-override" as string]: "var(--files-text-muted)",
    ["--trees-border-color-override" as string]: "var(--files-border)",
    ["--trees-bg-muted-override" as string]: "var(--files-surface)",
    ["--trees-accent-override" as string]: "var(--files-accent)",
    ["--trees-selected-fg-override" as string]: "var(--files-text)",
    ["--trees-selected-bg-override" as string]: "var(--files-surface)",
    ["--trees-selected-focused-border-color-override" as string]: "var(--files-accent)",
    ["--trees-focus-ring-color-override" as string]: "var(--files-accent)",
    ["--trees-search-bg-override" as string]: "var(--files-surface)",
    ["--trees-search-fg-override" as string]: "var(--files-text)",
    ["--trees-font-family-override" as string]: "var(--font-mono)",
    ["--trees-status-added-override" as string]: "var(--color-teal-500)",
    ["--trees-status-modified-override" as string]: "var(--color-amber-500)",
    ["--trees-status-renamed-override" as string]: "var(--color-amber-500)",
    ["--trees-status-deleted-override" as string]: "var(--color-rose-500)",
    ["--trees-status-untracked-override" as string]: "var(--color-teal-500)",
    ["--trees-status-ignored-override" as string]: "var(--files-text-muted)",
  } as React.CSSProperties), []);

  const showDiff = diffContent !== null && diffPath;
  const showMobileOverlay = isMobile && (!!activeTab || showDiff);

  if (!visible) return null;

  return (
    <div ref={panelRef} className="files-panel relative flex flex-col h-full outline-none" tabIndex={-1} onKeyDown={handlePanelKeyDown}>
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* File tree */}
        <div
          className={isMobile ? "flex-1 min-w-0 flex flex-col border-r border-ink-800" : "shrink-0 min-w-[160px] max-w-[60%] flex flex-col border-r border-ink-800"}
          style={isMobile ? undefined : { width: explorerWidth }}
        >
          <div className="files-panel-header shrink-0">
            <div className="files-panel-title-row">
              <div className="files-panel-segmented" role="tablist" aria-label="Files view">
                <button
                  type="button"
                  role="tab"
                  aria-selected={leftMode === "files"}
                  onClick={() => setLeftMode("files")}
                  className={`files-panel-segment ${leftMode === "files" ? "files-panel-segment-active" : ""}`}
                >
                  <Icon name="file" size={11} />
                  <span>Files</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={leftMode === "search"}
                  onClick={() => setLeftMode("search")}
                  className={`files-panel-segment ${leftMode === "search" ? "files-panel-segment-active" : ""}`}
                >
                  <Icon name="search" size={11} />
                  <span>Find</span>
                </button>
              </div>
              <div className="files-panel-title-actions">
                {leftMode === "files" && (
                  <>
                    <button
                      type="button"
                      onClick={() => handleCreate("file", "")}
                      className="files-panel-icon-button"
                      aria-label="New file"
                      title="New file"
                      disabled={busy}
                    >
                      <Icon name="plus" size={12} />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleCreate("folder", "")}
                      className="files-panel-icon-button"
                      aria-label="New folder"
                      title="New folder"
                      disabled={busy}
                    >
                      <Icon name="folder" size={12} />
                    </button>
                    <button
                      type="button"
                      onClick={() => fileSearch.open()}
                      className="files-panel-icon-button"
                      aria-label="Filter files"
                      title="Filter files (⌘P)"
                    >
                      <Icon name="search" size={12} />
                    </button>
                  </>
                )}
                <button
                  type="button"
                  onClick={handleRefresh}
                  className="files-panel-icon-button"
                  aria-label="Refresh"
                  title="Refresh"
                >
                  <Icon name="refresh" size={12} />
                </button>
                {embedded && (
                  <button type="button" onClick={onClose} className="files-panel-icon-button" aria-label="Close">
                    <Icon name="close" size={12} />
                  </button>
                )}
              </div>
            </div>
            {fileSearch.isOpen && (
              <div className="files-panel-search">
                <input
                  type="text"
                  placeholder="Filter files…"
                  aria-label="Filter files"
                  value={fileSearch.value}
                  onChange={(e) => fileSearch.setValue(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Escape") fileSearch.close(); }}
                  className="files-panel-search-input"
                  autoFocus
                />
                {fileSearch.value && (
                  <span className="files-panel-search-count">
                    {fileSearch.matchingPaths.length} match{fileSearch.matchingPaths.length !== 1 ? "es" : ""}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => fileSearch.close()}
                  className="files-panel-search-clear"
                  aria-label="Close search"
                >
                  <Icon name="close" size={10} />
                </button>
              </div>
            )}
          </div>

          {leftMode === "search" && (
            <div className="files-search-controls">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") performSearch(); }}
                placeholder="Find in files…"
                className="files-panel-search-input files-panel-search-input-wide"
                spellCheck={false}
              />
              <div className="files-search-toggles">
                <label className="files-search-toggle"><input type="checkbox" checked={searchCase} onChange={e => setSearchCase(e.target.checked)} /> <span>Aa</span></label>
                <label className="files-search-toggle"><input type="checkbox" checked={searchWord} onChange={e => setSearchWord(e.target.checked)} /> <span>\b</span></label>
                <label className="files-search-toggle"><input type="checkbox" checked={searchRegex} onChange={e => setSearchRegex(e.target.checked)} /> <span>.*</span></label>
                <input type="text" value={searchGlob} onChange={e => setSearchGlob(e.target.value)} placeholder="Include" className="files-search-glob" />
                <input type="text" value={searchExclude} onChange={e => setSearchExclude(e.target.value)} placeholder="Exclude" className="files-search-glob" />
              </div>
            </div>
          )}

          {leftMode === "files" ? (
            <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
              {selectedPaths.length >= 2 && (
                <div className="shrink-0 flex items-center gap-2 px-2 py-1.5 text-xs" style={{ background: "var(--files-surface)", borderBottom: "1px solid var(--files-border)", color: "var(--files-text)" }}>
                  <span className="files-panel-footer-dot" aria-hidden />
                  <span>{selectedPaths.length} selected</span>
                  <div className="ml-auto flex items-center gap-1">
                    <button type="button" disabled={busy} onClick={() => setPendingDelete({ kind: "bulk", paths: [...selectedPaths] })} className="files-panel-icon-button" title="Delete selected" aria-label="Delete selected">
                      <Icon name="trash" size={12} />
                    </button>
                    <button type="button" onClick={clearSelection} className="files-panel-icon-button" title="Clear selection (Esc)" aria-label="Clear selection">
                      <Icon name="close" size={12} />
                    </button>
                  </div>
                </div>
              )}
              <div ref={treeAreaRef} className="files-panel-tree flex-1 min-h-0 overflow-auto custom-scrollbar">
            {loading ? (
              <div className="files-panel-empty">
                <div className="files-panel-loading-spinner" />
                <span>Loading files…</span>
              </div>
            ) : error ? (
              <div className="files-panel-empty files-panel-empty-card">
                <div className="files-panel-empty-icon files-panel-empty-icon-error">
                  <Icon name="close" size={16} />
                </div>
                <strong>Couldn’t load files</strong>
                <span>{error}</span>
                <button type="button" onClick={handleRefresh} className="files-panel-retry">
                  <Icon name="refresh" size={11} />
                  Retry
                </button>
              </div>
            ) : paths.length === 0 ? (
              <div className="files-panel-empty files-panel-empty-card">
                <div className="files-panel-empty-icon">
                  <Icon name="folder" size={16} />
                </div>
                <strong>No files found</strong>
                <span>This directory is empty.</span>
              </div>
            ) : (
              <FileTree
                model={model}
                style={treeStyle}
                renderContextMenu={(item, context) => {
                  const isFolder = item.kind === "directory";
                  // Clamp into viewport so the menu never renders off-screen.
                  const top = Math.min(context.anchorRect.top, window.innerHeight - 230);
                  const left = Math.min(context.anchorRect.left, window.innerWidth - 200);
                  return (
                    <div
                      role="menu"
                      className="files-context-menu"
                      style={{ position: "fixed", top, left }}
                    >
                      {isFolder && (
                        <>
                          <button type="button" role="menuitem" disabled={busy} className="files-context-menu-item" onClick={() => { context.close(); handleCreate("file", item.path.replace(/\/+$/, "")); }}>
                            <Icon name="plus" size={11} /> New File…
                          </button>
                          <button type="button" role="menuitem" disabled={busy} className="files-context-menu-item" onClick={() => { context.close(); handleCreate("folder", item.path.replace(/\/+$/, "")); }}>
                            <Icon name="folder" size={11} /> New Folder…
                          </button>
                          <div className="files-context-menu-separator" />
                        </>
                      )}
                      <button type="button" role="menuitem" disabled={busy} className="files-context-menu-item" onClick={() => { context.close({ restoreFocus: false }); model.startRenaming(item.path); }}>
                        <Icon name="pencil" size={11} /> Rename…
                      </button>
                      {!isFolder && (
                        <button type="button" role="menuitem" disabled={busy} className="files-context-menu-item" onClick={() => { context.close(); handleDuplicate(item.path); }}>
                          <Icon name="file" size={11} /> Duplicate
                        </button>
                      )}
                      {!isFolder && (
                        <button type="button" role="menuitem" className="files-context-menu-item" onClick={() => { context.close(); handleViewDiffRef.current(item.path); }}>
                          <Icon name="git" size={11} /> View diff
                        </button>
                      )}
                      <div className="files-context-menu-separator" />
                      {(() => {
                        const sel = selectedPathsRef.current;
                        const inMulti = sel.length >= 2 && sel.includes(item.path);
                        return (
                          <button type="button" role="menuitem" disabled={busy} className="files-context-menu-item files-context-menu-item-danger" onClick={() => { context.close(); setPendingDelete(inMulti ? { kind: "bulk", paths: [...sel] } : { kind: "single", relativePath: item.path, fullPath: joinPath(cwd, item.path), isFolder }); }}>
                            <Icon name="trash" size={11} /> {inMulti ? `Delete ${sel.length} items` : "Delete"}
                          </button>
                        );
                      })()}
                    </div>
                  );
                }}
              />
            )}
          </div>
              {activeTab && (
                <OutlineSection
                  content={activeTab.unsavedContent}
                  collapsed={outlineCollapsed}
                  onToggle={() => setOutlineCollapsed(v => !v)}
                  onSelect={(s: SymbolOutline) => gotoTabLine(activeTab.id, s.line)}
                />
              )}
            </div>
          ) : (
            <div className="files-search-results custom-scrollbar flex-1 min-h-0 overflow-auto p-2 space-y-2">
              {searchLoading && <div className="files-search-status"><span className="files-search-spinner" /> Searching…</div>}
              {searchError && <div className="files-search-error">{searchError}</div>}
              {searchQuery.trim() && !searchLoading && searchResults.length === 0 && !searchError && (
                <div className="files-search-empty">
                  <Icon name="search" size={14} />
                  <span>No results</span>
                </div>
              )}
              {groupedResults.map(([path, matches]) => (
                <div key={path} className="files-search-group">
                  <div className="files-search-file" title={path}>
                    <Icon name="file" size={10} />
                    <span>{path}</span>
                  </div>
                  {matches.map((m, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => handleResultClick(path, m.line)}
                      className="files-search-match"
                    >
                      <span className="files-search-line">{m.line}</span>
                      <span className="files-search-preview">{m.preview}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Resizer */}
        {/* Resizer */}
        {!isMobile && <div
          className="files-resizer"
          onPointerDown={(e) => {
            const target = e.currentTarget;
            target.setPointerCapture(e.pointerId);
            dragStateRef.current = {
              startX: e.clientX,
              startWidth: explorerWidthRef.current,
              panelWidth: panelRef.current?.clientWidth || 800,
            };
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
          }}
          onPointerMove={(e) => {
            if (!dragStateRef.current) return;
            const dx = e.clientX - dragStateRef.current.startX;
            const next = Math.min(
              Math.max(dragStateRef.current.startWidth + dx, 160),
              dragStateRef.current.panelWidth - 240
            );
            setExplorerWidth(next);
          }}
          onPointerUp={(e) => {
            e.currentTarget.releasePointerCapture(e.pointerId);
            dragStateRef.current = null;
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
            piWebStorage.setItem("files-panel-explorer-width", String(explorerWidthRef.current));
          }}
        />}

        {/* Editor / diff */}
        <div className={showMobileOverlay ? "absolute inset-0 z-20 flex flex-col overflow-hidden bg-ink-950" : isMobile ? "hidden" : "flex-1 min-w-0 relative flex flex-col overflow-hidden"}>
          {tabs.length > 0 && (
            <div className="files-editor-tabs shrink-0 custom-scrollbar">
              {tabs.map(tab => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTabId(tab.id)}
                  className={`files-editor-tab ${tab.id === activeTabId ? "files-editor-tab-active" : ""}`}
                  title={tab.filePath}
                >
                  <Icon name="file" size={10} className="files-editor-tab-icon" />
                  <span className="files-editor-tab-label">{tab.filePath.split("/").pop() || tab.filePath}</span>
                  {tab.dirty && <span className="files-editor-tab-dirty" aria-label="Unsaved changes">●</span>}
                  <span
                    onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
                    className="files-editor-tab-close"
                    aria-label={`Close ${tab.filePath}`}
                    role="button"
                  >
                    <Icon name="close" size={9} />
                  </span>
                </button>
              ))}
            </div>
          )}

          {activeTab ? (
            <CodeEditor
              key={activeTab.id}
              filePath={activeTab.filePath}
              content={activeTab.unsavedContent}
              onChange={(value) => updateUnsaved(activeTab.id, value)}
              onSave={handleSaveFile}
              onClose={() => closeTab(activeTab.id)}
              saveError={activeTab.error}
              gotoLine={activeTab.gotoLine}
              onGotoLine={() => clearGotoLine(activeTab.id)}
            />
          ) : showDiff ? null : (
            <div className="files-editor-placeholder">
              <div className="files-editor-placeholder-icon">
                <Icon name="file" size={22} />
              </div>
              <span className="files-editor-placeholder-title">Select a file to edit</span>
              <span className="files-editor-placeholder-copy">Choose a file from the tree, or use Find to search across the project.</span>
            </div>
          )}


          {diffContent !== null && diffPath && (
            <div className="absolute inset-0 z-30 bg-ink-900">
              <DiffViewer diff={diffContent} path={diffPath} onClose={() => setDiffContent(null)} />
            </div>
          )}
        </div>
      </div>

      {gitStatusEntries.length > 0 && (
        <div className="files-panel-footer shrink-0">
          <span className="files-panel-footer-dot" aria-hidden />
          <span className="files-panel-footer-text">
            {gitStatusEntries.length} changed file{gitStatusEntries.length !== 1 ? "s" : ""}
          </span>
          <span className="files-panel-footer-hint">Right-click for actions</span>
        </div>
      )}
      {fsError && (
        <div className="files-panel-toast" role="alert">
          <Icon name="close" size={11} />
          <span>{fsError}</span>
          <button type="button" className="files-panel-toast-close" aria-label="Dismiss" onClick={() => setFsError(null)}>
            <Icon name="close" size={10} />
          </button>
        </div>
      )}
      <ConfirmDialog
        open={!!pendingDelete}
        title={
          pendingDelete?.kind === "bulk"
            ? `Delete ${pendingDelete.paths.length} items?`
            : `Delete ${pendingDelete?.isFolder ? "folder" : "file"}?`
        }
        message={
          pendingDelete?.kind === "bulk"
            ? `Are you sure you want to delete ${pendingDelete.paths.length} selected item${pendingDelete.paths.length !== 1 ? "s" : ""}? Folders and everything inside them will be removed.`
            : pendingDelete
            ? `Are you sure you want to delete “${pendingDelete.relativePath.replace(/\/+$/, "").split("/").pop()}”?${pendingDelete.isFolder ? " This will remove the folder and everything inside it." : ""}`
            : ""
        }
        confirmLabel="Delete"
        onConfirm={() => {
          if (!pendingDelete) return;
          if (pendingDelete.kind === "bulk") {
            const paths = pendingDelete.paths;
            setPendingDelete(null);
            handleBulkDelete(paths);
          } else {
            const p = pendingDelete;
            setPendingDelete(null);
            handleDelete(p.relativePath);
          }
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}

// ─── Helpers ───

function mapGitStatus(status: string): GitStatusEntry["status"] | undefined {
  switch (status) {
    case "M": return "modified";
    case "R": return "renamed";
    case "A": return "added";
    case "D": return "deleted";
    case "?": return "untracked";
    case "!!": return "ignored";
    default: return undefined;
  }
}
