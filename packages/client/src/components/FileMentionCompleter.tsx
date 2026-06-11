import { useState, useEffect, useRef, type RefObject } from "react";

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
  anchorRef?: RefObject<HTMLElement | null>;
}

export function FileMentionCompleter({ projectPath, filter, onSelect, onClose, anchorRef }: Props) {
  const [activeIdx, setActiveIdx] = useState(0);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, width: 0, bottom: 0, maxHeight: 320 });

  // Position the popup above the anchor using fixed positioning
  useEffect(() => {
    const gap = 8;
    const minTop = 12;
    const updatePosition = () => {
      const anchor = anchorRef?.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const availableHeight = Math.max(140, rect.top - gap - minTop);
      setPosition({
        left: rect.left,
        width: rect.width,
        bottom: window.innerHeight - rect.top + gap,
        maxHeight: availableHeight,
      });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [anchorRef]);

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

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

  const positionStyle = {
    left: position.left,
    width: position.width,
    bottom: position.bottom,
    maxHeight: position.maxHeight,
  };

  return (
    <div
      ref={panelRef}
      className="conversation-completer conversation-completer--wide"
      style={positionStyle}
    >
      <div className="conversation-completer-header">
        <span>Files &amp; dirs {filter ? `matching "${filter}"` : ""}</span>
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
