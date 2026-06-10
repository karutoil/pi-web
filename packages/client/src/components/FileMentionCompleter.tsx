import { useState, useEffect, useRef } from "react";

export interface FileEntry {
  path: string;
  name: string;
  relativePath: string;
  isDirectory: boolean;
}

interface Props {
  projectPath: string | undefined;
  filter: string; // text after "@"
  onSelect: (relativePath: string, isDirectory: boolean) => void;
  onClose: () => void;
}

export function FileMentionCompleter({ projectPath, filter, onSelect, onClose }: Props) {
  const [activeIdx, setActiveIdx] = useState(0);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!projectPath) { setFiles([]); return; }

    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (abortRef.current) abortRef.current.abort();

    debounceRef.current = setTimeout(() => {
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setLoading(true);

      const params = new URLSearchParams({ dir: projectPath, query: filter });
      fetch(`/api/fs/search-files?${params}`, { signal: ctrl.signal })
        .then(r => r.json())
        .then(data => {
          if (!ctrl.signal.aborted) {
            setFiles(data.files || []);
            setLoading(false);
          }
        })
        .catch(err => {
          if (err.name !== "AbortError") { setFiles([]); setLoading(false); }
        });
    }, 150);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, [projectPath, filter]);

  useEffect(() => { setActiveIdx(0); }, [files]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, Math.max(files.length - 1, 0))); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)); }
      else if (e.key === "Enter" && files[activeIdx]) { e.preventDefault(); onSelect(files[activeIdx].relativePath, files[activeIdx].isDirectory); }
      else if (e.key === "Escape") { onClose(); }
      else if (e.key === "Tab" && files[activeIdx]) { e.preventDefault(); onSelect(files[activeIdx].relativePath, files[activeIdx].isDirectory); }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [files, activeIdx, onSelect, onClose]);

  if (!projectPath) return null;

  const fileIcon = (_name: string, isDir: boolean): string => isDir ? "DIR" : "FILE";

  return (
    <div className="conversation-completer conversation-completer--wide">
      <div className="conversation-completer-header">
        <span>Files & dirs {filter ? `matching "${filter}"` : ""}</span>
        {loading && <span className="conversation-completer-hint">Searching…</span>}
      </div>
      {files.length === 0 && !loading && (
        <div className="conversation-completer-empty">
          {filter ? "No matches" : "Type to search files"}
        </div>
      )}
      {files.map((f, i) => (
        <button
          type="button"
          key={f.path + (f.isDirectory ? "/" : "")}
          onClick={() => onSelect(f.relativePath, f.isDirectory)}
          className="conversation-completer-item"
          data-active={i === activeIdx}
        >
          <span className="conversation-completer-icon">{fileIcon(f.name, f.isDirectory)}</span>
          <div className="min-w-0 flex-1">
            <div className="conversation-completer-title">
              {f.name}{f.isDirectory ? "/" : ""}
            </div>
            <div className="conversation-completer-meta">{f.relativePath}{f.isDirectory ? "/" : ""}</div>
          </div>
          {f.isDirectory && (
            <span className="conversation-completer-hint">TAB</span>
          )}
        </button>
      ))}
    </div>
  );
}
