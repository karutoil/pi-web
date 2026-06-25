import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface EditorTab {
  id: string;
  filePath: string;
  content: string;
  unsavedContent: string;
  dirty: boolean;
  loading: boolean;
  error: string | null;
  gotoLine?: number;
}

interface PersistedTabState {
  activeTabId: string | null;
  openPaths: string[];
}

export function makeEditorTabId(projectId: string, filePath: string) {
  return `${projectId}:${filePath}`;
}

function storageKey(projectId: string) {
  return `files-open:${projectId}`;
}

function loadPersisted(projectId: string): PersistedTabState | null {
  try {
    const raw = localStorage.getItem(storageKey(projectId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.openPaths)) {
      return { activeTabId: parsed.activeTabId || null, openPaths: parsed.openPaths };
    }
  } catch {}
  return null;
}

function persist(projectId: string, activeTabId: string | null, tabs: EditorTab[]) {
  try {
    const openPaths = tabs.map(t => t.filePath);
    localStorage.setItem(storageKey(projectId), JSON.stringify({ activeTabId, openPaths }));
  } catch {}
}

export function useEditorTabs(projectId: string, cwd: string) {
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [mru, setMru] = useState<string[]>([]);
  const readCacheRef = useRef<Map<string, string>>(new Map());

  const activeTab = useMemo(() => tabs.find(t => t.id === activeTabId) || null, [tabs, activeTabId]);

  const makeId = (filePath: string) => makeEditorTabId(projectId, filePath);

  const addToMru = useCallback((id: string) => {
    setMru(prev => {
      const next = prev.filter(x => x !== id);
      next.push(id);
      return next;
    });
  }, []);

  const readFile = useCallback(async (filePath: string): Promise<{ content: string; error?: string }> => {
    const cached = readCacheRef.current.get(filePath);
    if (cached !== undefined) return { content: cached };
    try {
      const res = await fetch(`/api/fs/read?path=${encodeURIComponent(filePath)}&projectId=${encodeURIComponent(projectId)}`);
      const data = await res.json();
      if (data.error) return { content: `// Error: ${data.error}`, error: data.error };
      readCacheRef.current.set(filePath, data.content);
      return { content: data.content };
    } catch (e: any) {
      return { content: `// Error loading file: ${e.message}`, error: e.message };
    }
  }, [projectId]);

  const openFile = useCallback(async (filePath: string) => {
    const id = makeId(filePath);
    const existing = tabs.find(t => t.id === id);
    if (existing) {
      setActiveTabId(id);
      addToMru(id);
      return;
    }
    const newTab: EditorTab = {
      id,
      filePath,
      content: "",
      unsavedContent: "",
      dirty: false,
      loading: true,
      error: null,
    };
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(id);
    addToMru(id);
    const { content, error } = await readFile(filePath);
    setTabs(prev => prev.map(t => (t.id === id ? { ...t, content, unsavedContent: content, loading: false, error: error ?? null } : t)));
  }, [tabs, readFile, addToMru, projectId]);

  const closeTab = useCallback((id: string, options?: { force?: boolean }) => {
    const tab = tabs.find(t => t.id === id);
    if (!tab) return;
    if (tab.dirty && !options?.force) {
      if (!confirm(`Discard unsaved changes in ${tab.filePath.split("/").pop() || tab.filePath}?`)) return;
    }
    setTabs(prev => prev.filter(t => t.id !== id));
    setMru(prev => prev.filter(x => x !== id));
    if (activeTabId === id) {
      const remaining = tabs.filter(t => t.id !== id);
      const nextId = mru.find(x => x !== id && remaining.some(t => t.id === x)) || remaining[remaining.length - 1]?.id || null;
      setActiveTabId(nextId);
    }
  }, [tabs, activeTabId, mru]);

  const closeActive = useCallback(() => {
    if (!activeTabId) return;
    closeTab(activeTabId);
  }, [activeTabId, closeTab]);

  const updateUnsaved = useCallback((id: string, value: string) => {
    setTabs(prev =>
      prev.map(t => {
        if (t.id !== id) return t;
        return { ...t, unsavedContent: value, dirty: value !== t.content };
      })
    );
  }, []);

  const markSaved = useCallback((id: string) => {
    setTabs(prev =>
      prev.map(t => {
        if (t.id !== id) return t;
        return { ...t, content: t.unsavedContent, dirty: false };
      })
    );
  }, []);

  // Re-point a tab to a new path in place — used after rename/move so that
  // unsaved edits are preserved. closeTab({force}) + openFile would re-read
  // from disk and discard the dirty buffer.
  const renameTab = useCallback((oldId: string, newId: string, newFilePath: string) => {
    setTabs(prev =>
      prev
        // A tab at the destination shouldn't exist after a move (the server
        // 409s on collision), but drop it defensively to avoid duplicate ids.
        .filter(t => t.id !== newId)
        .map(t => (t.id === oldId ? { ...t, id: newId, filePath: newFilePath } : t)));
    setMru(prev => prev.map(x => (x === oldId ? newId : x)));
    setActiveTabId(prev => (prev === oldId ? newId : prev));
  }, []);

  const setTabError = useCallback((id: string, error: string | null) => {
    setTabs(prev => prev.map(t => (t.id === id ? { ...t, error } : t)));
  }, []);

  const gotoTabLine = useCallback((id: string, line: number) => {
    setTabs(prev => prev.map(t => (t.id === id ? { ...t, gotoLine: line } : t)));
  }, []);

  const clearGotoLine = useCallback((id: string) => {
    setTabs(prev => prev.map(t => (t.id === id ? { ...t, gotoLine: undefined } : t)));
  }, []);

  useEffect(() => {
    persist(projectId, activeTabId, tabs);
  }, [projectId, activeTabId, tabs]);

  useEffect(() => {
    if (!projectId || !cwd) return;
    const persisted = loadPersisted(projectId);
    if (!persisted || persisted.openPaths.length === 0) return;
    let isCancelled = false;
    (async () => {
      const restored: EditorTab[] = [];
      for (const filePath of persisted.openPaths) {
        const { content, error } = await readFile(filePath);
        if (isCancelled) return;
        const id = makeId(filePath);
        restored.push({
          id,
          filePath,
          content,
          unsavedContent: content,
          dirty: false,
          loading: false,
          error: error ?? null,
        });
      }
      setTabs(restored);
      const validActive = persisted.activeTabId && restored.some(t => t.id === persisted.activeTabId);
      setActiveTabId(validActive ? persisted.activeTabId : restored[restored.length - 1]?.id || null);
      setMru(restored.map(t => t.id));
    })();
    return () => { isCancelled = true; };
  }, [projectId, cwd, readFile]);

  return {
    tabs,
    activeTab,
    activeTabId,
    openFile,
    closeTab,
    closeActive,
    setActiveTabId,
    updateUnsaved,
    markSaved,
    renameTab,
    setTabError,
    gotoTabLine,
    clearGotoLine,
    addToMru,
  };
}
