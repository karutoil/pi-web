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

  // Fetch files when filter changes (debounced)
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

  // Reset active index when files change
  useEffect(() => { setActiveIdx(0); }, [files]);

  // Keyboard navigation
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

  // File icon based on extension
  const fileIcon = (name: string, isDir: boolean): string => {
    if (isDir) return "📁";
    const ext = name.split(".").pop()?.toLowerCase() || "";
    const icons: Record<string, string> = {
      ts: "🔷", tsx: "🔷", js: "🟨", jsx: "🟨", mjs: "🟨",
      py: "🐍", rs: "🦀", go: "🔵", java: "☕", rb: "💎",
      html: "🌐", css: "🎨", scss: "🎨", json: "📋", yaml: "📋", yml: "📋",
      md: "📝", txt: "📄", sh: "⚙️", bash: "⚙️",
      png: "🖼️", jpg: "🖼️", jpeg: "🖼️", gif: "🖼️", svg: "🖼️", webp: "🖼️",
      sql: "🗃️", graphql: "🔶", gql: "🔶",
      toml: "📋", ini: "📋", env: "🔒",
    };
    return icons[ext] || "📄";
  };

  return (
    <div className="absolute bottom-full left-0 mb-2 bg-ink-900 border border-ink-700 rounded-lg shadow-lg py-1 z-50 w-[calc(100vw-2rem)] md:w-96 max-h-64 overflow-y-auto custom-scrollbar">
      <div className="px-3 py-1.5 text-ink-500 text-[0.65rem] font-mono uppercase tracking-wider border-b border-ink-800 flex items-center justify-between">
        <span>Files & dirs {filter ? `matching "${filter}"` : ""}</span>
        {loading && <span className="text-amber-500 normal-case tracking-normal">Searching...</span>}
      </div>
      {files.length === 0 && !loading && (
        <div className="px-3 py-3 text-ink-500 text-xs font-mono">
          {filter ? "No matches" : "Type to search files"}
        </div>
      )}
      {files.map((f, i) => (
        <button
          key={f.path + (f.isDirectory ? "/" : "")}
          onClick={() => onSelect(f.relativePath, f.isDirectory)}
          className={`w-full text-left px-3 py-2 hover:bg-ink-850 transition-theme flex items-center gap-2 min-h-[40px] ${
            i === activeIdx ? "bg-ink-850" : ""
          }`}
        >
          <span className="text-xs shrink-0">{fileIcon(f.name, f.isDirectory)}</span>
          <div className="min-w-0 flex-1">
            <div className="text-ink-200 text-xs font-mono font-medium truncate">
              {f.name}{f.isDirectory ? "/" : ""}
            </div>
            <div className="text-ink-500 text-[0.6rem] truncate">{f.relativePath}{f.isDirectory ? "/" : ""}</div>
          </div>
          {f.isDirectory && (
            <span className="text-ink-600 text-[0.55rem] shrink-0">TAB</span>
          )}
        </button>
      ))}
    </div>
  );
}
