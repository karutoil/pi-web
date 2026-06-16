import { useState, useCallback, useEffect } from "react";
import type { SearchResult, ReplaceChange } from "@pi-web/shared";
import { Icon } from "./Icon";

interface Props {
  projectId: string;
  projectPath: string;
  visible: boolean;
  onClose: () => void;
  embedded?: boolean;
}

interface ReplaceState {
  query: string;
  replacement: string;
  useRegex: boolean;
  preview: ReplaceChange[] | null;
  applying: boolean;
  error: string | null;
}

export function SearchPanel({ projectId, visible, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [glob, setGlob] = useState("");
  const [exclude, setExclude] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replace, setReplace] = useState<ReplaceState>({
    query: "",
    replacement: "",
    useRegex: false,
    preview: null,
    applying: false,
    error: null,
  });

  const performSearch = useCallback(async () => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        projectId,
        q: query.trim(),
      });
      if (caseSensitive) params.set("caseSensitive", "true");
      if (wholeWord) params.set("wholeWord", "true");
      if (regex) params.set("regex", "true");
      if (glob) params.set("glob", glob);
      if (exclude) params.set("exclude", exclude);
      const res = await fetch(`/api/search?${params}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setResults(data.results || []);
      if (data.truncated) setError("Results truncated. Refine your query.");
    } catch (e: any) {
      setError(e.message || "Search failed");
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [projectId, query, caseSensitive, wholeWord, regex, glob, exclude]);

  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(performSearch, 200);
    return () => clearTimeout(t);
  }, [visible, performSearch]);

  const grouped = results.reduce((map, r) => {
    map.set(r.path, [...(map.get(r.path) || []), r]);
    return map;
  }, new Map<string, SearchResult[]>());

  const previewReplace = useCallback(async () => {
    if (!query.trim()) return;
    setReplace(prev => ({ ...prev, applying: true, error: null }));
    try {
      const res = await fetch("/api/search/replace-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, query, replacement: replace.replacement, useRegex: regex }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setReplace(prev => ({ ...prev, query, preview: data.changes || [], useRegex: regex }));
    } catch (e: any) {
      setReplace(prev => ({ ...prev, error: e.message || "Preview failed" }));
    } finally {
      setReplace(prev => ({ ...prev, applying: false }));
    }
  }, [projectId, query, replace.replacement, regex]);

  const applyReplace = useCallback(async () => {
    if (!query.trim()) return;
    const changedPaths = (replace.preview || []).filter(c => c.replacements > 0).map(c => c.path);
    setReplace(prev => ({ ...prev, applying: true, error: null }));
    try {
      const res = await fetch("/api/search/replace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, query, replacement: replace.replacement, useRegex: regex, paths: changedPaths }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setReplace(prev => ({ ...prev, preview: null }));
      performSearch();
    } catch (e: any) {
      setReplace(prev => ({ ...prev, error: e.message || "Replace failed" }));
    } finally {
      setReplace(prev => ({ ...prev, applying: false }));
    }
  }, [projectId, query, replace.replacement, replace.preview, regex, performSearch]);

  if (!visible) return null;

  return (
    <div className="flex flex-col h-full">
      <div className="files-panel-header shrink-0">
        <div className="files-panel-title-row">
          <span className="files-panel-title">Search</span>
          <button type="button" onClick={onClose} className="files-panel-icon-button" aria-label="Close"><Icon name="close" size={12} /></button>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-3 space-y-3">
        <div className="space-y-2">
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") performSearch(); }}
            placeholder="Search across files…"
            className="files-panel-search-input w-full text-xs"
            spellCheck={false}
          />
          <div className="flex flex-wrap gap-2">
            <label className="inline-flex items-center gap-1 text-xs text-ink-300 cursor-pointer"><input type="checkbox" checked={caseSensitive} onChange={e => setCaseSensitive(e.target.checked)} /> Aa</label>
            <label className="inline-flex items-center gap-1 text-xs text-ink-300 cursor-pointer"><input type="checkbox" checked={wholeWord} onChange={e => setWholeWord(e.target.checked)} /> \b</label>
            <label className="inline-flex items-center gap-1 text-xs text-ink-300 cursor-pointer"><input type="checkbox" checked={regex} onChange={e => setRegex(e.target.checked)} /> . *</label>
          </div>
          <div className="flex gap-2">
            <input type="text" value={glob} onChange={e => setGlob(e.target.value)} placeholder="Include glob" className="files-panel-search-input w-full text-xs" />
            <input type="text" value={exclude} onChange={e => setExclude(e.target.value)} placeholder="Exclude glob" className="files-panel-search-input w-full text-xs" />
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-ink-200 text-xs font-medium">Replace</div>
          <input type="text" value={replace.replacement} onChange={e => setReplace(prev => ({ ...prev, replacement: e.target.value }))} placeholder="Replacement…" className="files-panel-search-input w-full text-xs" />
          <div className="flex gap-2">
            <button type="button" onClick={previewReplace} disabled={!query.trim() || replace.applying} className="modal-button modal-button--ghost text-xs">Preview</button>
            {replace.preview && (
              <button type="button" onClick={applyReplace} disabled={replace.applying} className="modal-button modal-button--primary text-xs">Apply {replace.preview.reduce((n, c) => n + c.replacements, 0)}</button>
            )}
          </div>
          {replace.error && <div className="text-xs text-rose-400">{replace.error}</div>}
        </div>

        {replace.preview && (
          <div className="space-y-2 border border-ink-800 rounded-md p-2 bg-ink-900/30">
            <div className="text-ink-200 text-xs font-medium">Preview</div>
            {replace.preview.map(c => (
              <div key={c.path} className="text-xs">
                <div className="text-ink-300 truncate" title={c.path}>{c.path} · {c.replacements} change{c.replacements !== 1 ? "s" : ""}</div>
                <pre className="mt-1 p-1.5 bg-ink-950 rounded text-ink-400 whitespace-pre-wrap font-mono">{c.diff.slice(0, 1000)}{c.diff.length > 1000 ? "…" : ""}</pre>
              </div>
            ))}
          </div>
        )}

        {loading && <div className="text-xs text-ink-500">Searching…</div>}
        {error && <div className="text-xs text-rose-400">{error}</div>}

        {Array.from(grouped.entries()).map(([path, matches]) => (
          <div key={path} className="space-y-1">
            <div className="text-amber-500 text-xs font-medium truncate" title={path}>{path}</div>
            {matches.map((m, i) => (
              <div key={i} className="pl-2 text-xs font-mono text-ink-300 border-l-2 border-ink-700">
                <span className="text-ink-500">{m.line}:</span> {m.preview}
              </div>
            ))}
          </div>
        ))}

        {!loading && results.length === 0 && !error && query.trim() && <div className="text-xs text-ink-500">No results</div>}
      </div>
    </div>
  );
}
