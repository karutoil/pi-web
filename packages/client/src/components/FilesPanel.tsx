import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { FileTree, useFileTree, useFileTreeSearch } from "@pierre/trees/react";
import type { GitStatusEntry } from "@pierre/trees";
import CodeMirror from "@uiw/react-codemirror";
import { vscodeDark, vscodeLight } from "@uiw/codemirror-theme-vscode";
import { EditorView } from "@codemirror/view";
import { LanguageDescription } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { languages } from "@codemirror/language-data";
import { useTheme } from "../hooks/useTheme";
import { Icon } from "./Icon";

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

function CodeEditor({ filePath, content, onSave, onClose, saveError }: {
  filePath: string;
  content: string;
  onSave: (content: string) => void;
  onClose: () => void;
  saveError?: string | null;
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
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await onSave(editContent);
      setDirty(false);
    } finally {
      setSaving(false);
    }
  }, [editContent, onSave]);

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
  const panelRef = useRef<HTMLDivElement>(null);
  const [paths, setPaths] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [diffContent, setDiffContent] = useState<string | null>(null);
  const [diffPath, setDiffPath] = useState<string | null>(null);
  const [gitStatusEntries, setGitStatusEntries] = useState<GitStatusEntry[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [explorerWidth, setExplorerWidth] = useState<number>(() => {
    try {
      const v = localStorage.getItem("files-panel-explorer-width");
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

  const handleFileSelect = useCallback(async (relativePath: string) => {
    const fullPath = joinPath(cwd, relativePath);
    setSelectedFile(fullPath);
    setSaveError(null);
    try {
      const res = await fetch(`/api/fs/read?path=${encodeURIComponent(fullPath)}&projectId=${encodeURIComponent(projectId)}`);
      const data = await res.json();
      if (data.error) {
        setFileContent(`// Error: ${data.error}`);
      } else {
        setFileContent(data.content);
      }
    } catch (e: any) {
      setFileContent(`// Error loading file: ${e.message}`);
    }
  }, [cwd, projectId]);

  const handleSaveFile = useCallback(async (content: string) => {
    if (!selectedFile) return;
    setSaveError(null);
    try {
      const res = await fetch("/api/fs/write", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: selectedFile, projectId, content, overwrite: true }),
      });
      const data = await res.json();
      if (!data.success) {
        setSaveError(data.error || "Failed to save file");
      } else {
        fetchGitStatus();
      }
    } catch (e: any) {
      setSaveError(e.message || "Failed to save file");
    }
  }, [selectedFile, projectId, fetchGitStatus]);

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
    if (selectedFile) {
      const relativePath = selectedFile.slice(cwd.length + 1);
      handleFileSelect(relativePath);
    }
  }, [fetchFiles, fetchGitStatus, selectedFile, cwd, handleFileSelect]);

  // Keep callbacks in refs so the model's stale closure still calls current versions
  const handleFileSelectRef = useRef(handleFileSelect);
  handleFileSelectRef.current = handleFileSelect;
  const handleViewDiffRef = useRef(handleViewDiff);
  handleViewDiffRef.current = handleViewDiff;

  const { model } = useFileTree({
    paths: [],
    gitStatus: [],
    renaming: false,
    onSelectionChange: (selectedPaths) => {
      if (selectedPaths.length > 0) {
        const path = selectedPaths[0];
        if (!path.endsWith("/")) {
          handleFileSelectRef.current(path);
        }
      }
    },
  });

  useEffect(() => {
    model.resetPaths(paths);
  }, [model, paths]);

  useEffect(() => {
    model.setGitStatus(gitStatusEntries);
  }, [model, gitStatusEntries]);

  const search = useFileTreeSearch(model);

  const handlePanelKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "p") {
      e.preventDefault();
      search.open();
    }
  }, [search]);

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

  if (!visible) return null;

  return (
    <div ref={panelRef} className="files-panel flex flex-col h-full outline-none" tabIndex={-1} onKeyDown={handlePanelKeyDown}>
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* File tree */}
        <div
          className="shrink-0 min-w-[160px] max-w-[60%] flex flex-col border-r border-ink-800"
          style={{ width: explorerWidth }}
        >
          <div className="files-panel-header shrink-0">
            <div className="files-panel-title-row">
              <span className="files-panel-title">Files</span>
              <div className="ml-auto flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => search.open()}
                  className="files-panel-icon-button"
                  aria-label="Search files"
                  title="Search (⌘P)"
                >
                  <Icon name="search" size={12} />
                </button>
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
            {search.isOpen && (
              <div className="files-panel-search">
                <input
                  type="text"
                  placeholder="Search files…"
                  aria-label="Search files"
                  value={search.value}
                  onChange={(e) => search.setValue(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Escape") search.close(); }}
                  className="files-panel-search-input"
                  autoFocus
                />
                {search.value && (
                  <span className="files-panel-search-count">
                    {search.matchingPaths.length} match{search.matchingPaths.length !== 1 ? "es" : ""}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => search.close()}
                  className="files-panel-search-clear"
                  aria-label="Close search"
                >
                  <Icon name="close" size={10} />
                </button>
              </div>
            )}
          </div>

          <div className="files-panel-tree flex-1 min-h-0 overflow-auto custom-scrollbar">
            {loading ? (
              <div className="files-panel-empty">
                <div className="files-panel-loading-spinner" />
                <span>Loading files…</span>
              </div>
            ) : error ? (
              <div className="files-panel-empty">
                <Icon name="close" size={16} />
                <span>{error}</span>
                <button type="button" onClick={handleRefresh} className="files-panel-retry">Retry</button>
              </div>
            ) : paths.length === 0 ? (
              <div className="files-panel-empty">
                <span>No files found</span>
              </div>
            ) : (
              <FileTree
                model={model}
                style={treeStyle}
                renderContextMenu={(item, context) => {
                  if (item.kind === "file") {
                    return (
                      <div
                        role="menu"
                        className="files-context-menu"
                        style={{
                          position: "fixed",
                          top: context.anchorRect.top,
                          left: context.anchorRect.left,
                        }}
                      >
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            context.close();
                            handleViewDiffRef.current(item.path);
                          }}
                          className="files-context-menu-item"
                        >
                          View diff
                        </button>
                      </div>
                    );
                  }
                  return null;
                }}
              />
            )}
          </div>
        </div>

        {/* Resizer */}
        <div
          className="w-1.5 shrink-0 cursor-col-resize touch-none bg-ink-900 hover:bg-ink-700 active:bg-ink-600 transition-colors z-10"
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
            try {
              localStorage.setItem("files-panel-explorer-width", String(explorerWidthRef.current));
            } catch {}
          }}
        />

        {/* Editor / diff */}
        <div className="flex-1 min-w-0 relative flex flex-col overflow-hidden">
          {selectedFile && fileContent !== null ? (
            <CodeEditor
              key={selectedFile}
              filePath={selectedFile}
              content={fileContent}
              onSave={handleSaveFile}
              onClose={() => { setSelectedFile(null); setFileContent(null); setSaveError(null); }}
              saveError={saveError}
            />
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-ink-500 text-xs select-none">
              <Icon name="file" size={24} />
              <span className="mt-2">Select a file to edit</span>
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
          <span className="files-panel-footer-text">
            {gitStatusEntries.length} changed file{gitStatusEntries.length !== 1 ? "s" : ""}
            {" · "}Right-click file → View diff
          </span>
        </div>
      )}
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
