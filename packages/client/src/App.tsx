import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import type { Project, SessionSummary, SessionDetail, ChatMessage, WorkspacePanelKind } from "@pi-web/shared";
import { formatTimeAgo } from "./lib/utils";
import { SESSION_CACHE_TTL, SESSION_FETCH_DELAY_MS } from "./lib/constants";
import { ChatView } from "./components/ChatView";
import { EmptyState } from "./components/EmptyState";
import { BackgroundSessionToast } from "./components/BackgroundSessionToast";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { AddProjectExplorer } from "./components/AddProjectExplorer";
import { SettingsModal } from "./components/SettingsModal";
import { useWebSocketPool } from "./hooks/useWebSocketPool";
import { PWABanner } from "./components/PWABanner";
import { PreviewPanel } from "./components/preview/PreviewPanel";
import { ProjectSessionSidebar } from "./components/ProjectSessionSidebar";
import { GitPanel } from "./components/GitPanel";
import { FilesPanel } from "./components/FilesPanel";
import { TerminalPanel, TerminalPanelHeader, type TerminalTab } from "./components/TerminalPanel";
import { usePreviewStore } from "./hooks/usePreviewStore";
import { useRightPanelStore } from "./hooks/useRightPanelStore";
import { useWorkspaceLayout } from "./hooks/useWorkspaceLayout";
import { useIsMobile } from "./hooks/useIsMobile";
import { ExtensionsPanel } from "./components/ExtensionsPanel";
import { WorkspaceDock } from "./components/WorkspaceDock";
import { MobileShell } from "./components/MobileShell";
import { Icon } from "./components/Icon";
import { uuidV4 } from "./lib/uuid";
import { sessionToMarkdown, copyToClipboard } from "./lib/markdownExport";

const MAX_SESSION_CACHE = 50;

export type ViewState = "projects" | "sessions" | "chat";

// Layout state for the dock shell:
// - "channels" contains Projects + Sessions

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSession, setActiveSession] = useState<SessionSummary | null>(null);
  const [sessionDetail, setSessionDetail] = useState<SessionDetail | null>(null);
  const [view, setView] = useState<ViewState>("projects");
  const [showAddProject, setShowAddProject] = useState(false);
  const [newSessionId, setNewSessionId] = useState<string | null>(null);
  const [isAddingProject, setIsAddingProject] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalTabs, setTerminalTabs] = useState<TerminalTab[]>([]);
  const [terminalActiveTabId, setTerminalActiveTabId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [channelSearch, setChannelSearch] = useState("");
  const [confirmDialog, setConfirmDialog] = useState<{ open: boolean; title: string; message: string; confirmLabel?: string; onConfirm: () => void }>({ open: false, title: "", message: "", onConfirm: () => {} });
  const [showSettings, setShowSettings] = useState(false);
  const workspaceLayout = useWorkspaceLayout();
  const isMobile = useIsMobile();
  const [activeMobilePanel, setActiveMobilePanel] = useState<WorkspacePanelKind>("chat");

  const requestWorkspaceReset = useCallback(() => {
    setConfirmDialog({
      open: true,
      title: "Reset workspace layout?",
      message: "This restores the default layout: Conversation stays in the center, the project/session rail returns to the left, and tool panels return to the right and bottom. Custom panel sizes, split positions, and panel order will be reset.",
      confirmLabel: "Reset layout",
      onConfirm: () => {
        workspaceLayout.reset();
        setConfirmDialog(s => ({ ...s, open: false }));
      },
    });
  }, [workspaceLayout.reset]);

  // Session detail cache with 30s TTL (capped at MAX_SESSION_CACHE entries)
  const sessionCacheRef = useRef<Map<string, { data: SessionDetail; timestamp: number }>>(new Map());

  // AbortController for fetchSessions — aborts previous in-flight request (#29)
  const fetchSessionsAbortRef = useRef<AbortController | null>(null);
  // AbortController for session detail fetch — aborts previous in-flight request (#30)
  const sessionDetailAbortRef = useRef<AbortController | null>(null);
  // Timer refs for setTimeout callbacks — cleared on unmount (#62)
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  function safeTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const id = setTimeout(fn, ms);
    timersRef.current.add(id);
    return id;
  }

  // WebSocket pool — multiple concurrent connections, agents keep streaming when navigating away.
  // Each (project, session) tuple gets its own pool entry so PI processes for background
  // sessions are not torn down when the user switches project/session. The server keeps an
  // agent alive while it is actively streaming or has running tools, and only starts the 5-minute
  // idle timeout after the run goes idle with no clients attached.
  const wsPool = useWebSocketPool();
  // Only attach a WS when we're actually viewing a chat. In sessions/projects views we don't
  // need (or want) a PI process running. Switching projects or sessions leaves the previous
  // conn in the pool — the user can come back and the stream is still live.
  const ws = view === "chat" && selectedProject
    ? wsPool.getOrConnect(
        selectedProject.id,
        activeSession?.filePath || null,
        newSessionId,
      )
    : null;

  const loadTerminals = useCallback(async () => {
    if (!selectedProject?.id || !terminalOpen) return;
    try {
      const res = await fetch(`/api/terminals?projectId=${encodeURIComponent(selectedProject.id)}`);
      const data = await res.json();
      const existing = data.terminals || [];
      if (existing.length > 0) {
        setTerminalTabs(existing);
        setTerminalActiveTabId(prev => prev && existing.some((t: TerminalTab) => t.id === prev) ? prev : existing[0].id);
      } else {
        setTerminalTabs([]);
        setTerminalActiveTabId(null);
      }
    } catch {}
  }, [selectedProject?.id, terminalOpen]);

  useEffect(() => {
    loadTerminals();
  }, [loadTerminals]);

  const addTerminal = useCallback(async () => {
    if (!selectedProject) return;
    const id = uuidV4();
    const name = `Terminal ${terminalTabs.length + 1}`;
    try {
      const res = await fetch("/api/terminals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, projectId: selectedProject.id, cwd: selectedProject.path, name }),
      });
      if (res.ok) {
        const tab: TerminalTab = { id, name, projectId: selectedProject.id, cwd: selectedProject.path };
        setTerminalTabs(prev => [...prev, tab]);
        setTerminalActiveTabId(id);
      }
    } catch {}
  }, [selectedProject, terminalTabs.length]);

  const removeTerminal = useCallback(async (tabId: string) => {
    try { await fetch(`/api/terminals/${tabId}`, { method: "DELETE" }); } catch {}
    setTerminalTabs(prev => {
      const next = prev.filter(t => t.id !== tabId);
      setTerminalActiveTabId(current => current === tabId ? (next[0]?.id || null) : current);
      return next;
    });
  }, []);

  const renameTerminal = useCallback((tabId: string, name: string) => {
    setTerminalTabs(prev => prev.map(t => t.id === tabId ? { ...t, name } : t));
  }, []);

  // Compute which sessions are actively streaming from the pool
  // Must be inline (not useMemo) — pool is a ref Map, its identity never changes,
  // but pool subscriptions trigger forceUpdate so we recompute on every render
  const streamingSessionIds = new Set<string>();
  const streamingProjectIds = new Set<string>();
  for (const [key, conn] of wsPool.pool.entries()) {
    if (conn.isActive && conn.state?.sessionId) {
      streamingSessionIds.add(conn.state.sessionId);
      // Pool key format: `${projectId}:${sessionPath}:${newSessionId}`.
      // Project IDs are UUIDs (no colons), so split on first ':' is safe.
      const projectId = key.split(":")[0];
      if (projectId) streamingProjectIds.add(projectId);
    }
  }

  // When the WS connection reports session info (from get_state or session_loaded),
  // stabilize the active session by updating filePath and clearing newSessionId
  useEffect(() => {
    if (!ws) return;
    const handleSessionLoaded = (session: SessionDetail) => {
      // Rekey the pool entry from pending (e.g. `projId::::uuid`) to the resolved
      // filePath form. This must run before setState so the next render's
      // getOrConnect() finds the existing conn under its new key.
      if (ws && session.filePath) {
        const oldKey = ws.key;
        const newKey = `${selectedProject?.id || ""}::${session.filePath}`;
        if (oldKey !== newKey) ws.rekey(newKey);
      }
      setActiveSession(prev => prev ? {
        ...prev,
        filePath: session.filePath,
        name: session.name || prev.name,
        id: session.id || prev.id,
      } : {
        id: session.id,
        name: session.name || "New Session",
        filePath: session.filePath,
        cwd: selectedProject?.path || "",
        timestamp: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        lastMessage: null,
        model: null,
        messageCount: 0,
        firstMessage: null,
        totalCost: 0,
        totalTokens: 0,
        tokenCount: 0,
        cost: 0,
        isRecentlyActive: true,
      });
      setSessionDetail(session);
      setNewSessionId(null);
    };
    ws.setOnSessionLoaded(handleSessionLoaded);

    // Also watch state changes — if sessionFile arrives via get_state, stabilize
    const listener = () => {
      const st = ws.state;
      if (st?.sessionFile && newSessionId) {
        setActiveSession(prev => {
          if (prev && prev.filePath !== st.sessionFile) {
            return { ...prev, filePath: st.sessionFile! };
          }
          if (!prev && st.sessionFile) {
            return {
              id: st.sessionId,
              name: st.sessionName || "New Session",
              filePath: st.sessionFile,
              cwd: selectedProject?.path || "",
              timestamp: new Date().toISOString(),
              createdAt: new Date().toISOString(),
              lastActiveAt: new Date().toISOString(),
              lastMessage: null,
              model: null,
              messageCount: 0,
              firstMessage: null,
              totalCost: 0,
              totalTokens: 0,
              tokenCount: 0,
              cost: 0,
              isRecentlyActive: true,
            };
          }
          return prev;
        });
        setNewSessionId(null);
      }
    };
    ws.subscribe(listener);
    return () => { ws.unsubscribe(listener); ws.setOnSessionLoaded(null); };
  }, [ws, newSessionId, selectedProject?.path]);

  // ── Right panel state (preview + git) ──
  const previewOpen = usePreviewStore((s) => s.isOpen);
  const rightPanel = useRightPanelStore();
  const gitOpen = rightPanel.isOpen("git");
  const filesOpen = rightPanel.isOpen("files");
  const extensionsOpen = rightPanel.isOpen("extensions");

  // Sync preview store → right panel store
  useEffect(() => {
    if (previewOpen && !rightPanel.isOpen("preview")) rightPanel.open("preview");
    if (!previewOpen && rightPanel.isOpen("preview")) rightPanel.close("preview");
  }, [previewOpen]);
  const setPreviews = usePreviewStore((s) => s.setPreviews);
  const previewMap = usePreviewStore((s) => s.previews);
  const activePreview = selectedProject
    ? previewMap.get(`${selectedProject.id}:default`)
    : null;

  const closedPanels = useMemo(() => [
    ...(!sidebarOpen ? [{
      id: "channels" as const,
      title: "Channels",
      icon: <Icon name="hash" size={10} />,
      children: null,
    }] : []),
    ...(selectedProject && !rightPanel.isOpen("preview") ? [{
      id: "preview" as const,
      title: "Preview",
      icon: <Icon name="preview" size={10} />,
      children: null,
    }] : []),
    ...(selectedProject && !gitOpen ? [{
      id: "git" as const,
      title: "Git",
      icon: <Icon name="git" size={10} />,
      children: null,
    }] : []),
    ...(selectedProject && !filesOpen ? [{
      id: "files" as const,
      title: "Files",
      icon: <Icon name="file" size={10} />,
      children: null,
    }] : []),
    ...(!extensionsOpen ? [{
      id: "extensions" as const,
      title: "Extensions",
      icon: <Icon name="puzzle" size={10} />,
      children: null,
    }] : []),
    ...(!terminalOpen ? [{
      id: "terminal" as const,
      title: "Terminal",
      icon: <Icon name="terminal" size={10} />,
      children: null,
    }] : []),
  ], [gitOpen, rightPanel, selectedProject, sidebarOpen, terminalOpen, filesOpen, extensionsOpen]);

  const reopenPanel = useCallback((panelId: WorkspacePanelKind) => {
    if (panelId === "channels") setSidebarOpen(true);
    if (panelId === "preview") rightPanel.open("preview");
    if (panelId === "git") rightPanel.open("git");
    if (panelId === "files") rightPanel.open("files");
    if (panelId === "extensions") rightPanel.open("extensions");
    if (panelId === "terminal") setTerminalOpen(true);
  }, [rightPanel]);

  const fetchPreviews = useCallback(() => {
    if (!selectedProject) return;
    fetch(`/api/preview?projectId=${selectedProject.id}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.previews) setPreviews(d.previews);
      })
      .catch(() => {});
  }, [selectedProject, setPreviews]);

  useEffect(() => {
    fetchPreviews();
    // Poll every 3 seconds
    const interval = setInterval(fetchPreviews, 3000);
    return () => clearInterval(interval);
  }, [fetchPreviews]);

  // Handle @element mention from picker
  const handleElementSelected = useCallback((token: string, _context: string) => {
    // Element tokens are resolved in ChatView.handleSend via the store.
  }, []);

  // Fetch sessions for selected project
  const fetchSessions = useCallback(() => {
    if (!selectedProject) return;
    // Abort previous in-flight request (#29)
    fetchSessionsAbortRef.current?.abort();
    const ctrl = new AbortController();
    fetchSessionsAbortRef.current = ctrl;
    fetch(`/api/projects/${selectedProject.id}/sessions`, { signal: ctrl.signal })
      .then(r => r.json())
      .then(d => setSessions(d.sessions || []))
      .catch(e => { if (e instanceof DOMException && e.name === 'AbortError') return; console.error(e); });
  }, [selectedProject]);

  // Refresh sessions when agent finishes a run
  const prevStreaming = useRef(false);
  useEffect(() => {
    if (prevStreaming.current && !ws?.isStreaming) {
      safeTimeout(() => fetchSessions(), 800);
    }
    prevStreaming.current = ws?.isStreaming || false;
  }, [ws?.isStreaming, fetchSessions]);

  // #27 — Clear session cache when project changes
  useEffect(() => {
    sessionCacheRef.current.clear();
  }, [selectedProject?.id]);
  const prevWsStreaming = useRef(false);
  useEffect(() => {
    if (prevWsStreaming.current && !ws?.isStreaming && activeSession) {
      sessionCacheRef.current.delete(activeSession.filePath);
    }
    prevWsStreaming.current = ws?.isStreaming || false;
  }, [ws?.isStreaming, activeSession]);

  // Load projects on mount
  useEffect(() => {
    fetch("/api/projects")
      .then(r => r.json())
      .then(d => setProjects(d.projects || []))
      .catch(console.error);
  }, []);

  // Load sessions when project selected
  useEffect(() => {
    if (!selectedProject) return;
    fetchSessions();
  }, [selectedProject, fetchSessions]);

  const handleSelectProject = useCallback((project: Project) => {
    setSelectedProject(project);
    setActiveSession(null);
    setSessionDetail(null);
    setView("sessions");
    if (isMobile) {
      setActiveMobilePanel("chat");
      setSidebarOpen(false);
    }
  }, [isMobile]);

  const handleSelectSession = useCallback(async (session: SessionSummary) => {
    setActiveSession(session);
    setView("chat");
    if (isMobile) setActiveMobilePanel("chat");
    if (isMobile) setSidebarOpen(false);

    // Do NOT call `ws.loadSession(...)` here. With the multi-session pool, each
    // session has its own PI process. Sending load_session on the OLD WS would
    // tell the OLD PI process to switch sessions, killing any in-flight work
    // for the previous session. Instead, the next render's getOrConnect() will
    // either find the existing pool entry for this session (if previously
    // opened) or create a new WS, which spawns a dedicated PI process for
    // this session.

    // Load session detail — check cache first
    const cached = sessionCacheRef.current.get(session.filePath);
    if (cached && Date.now() - cached.timestamp < SESSION_CACHE_TTL) {
      setSessionDetail(cached.data);
    } else {
      try {
        // Abort previous session detail fetch (#30)
        sessionDetailAbortRef.current?.abort();
        const ctrl = new AbortController();
        sessionDetailAbortRef.current = ctrl;
        const r = await fetch(`/api/sessions/detail?path=${encodeURIComponent(session.filePath)}`, { signal: ctrl.signal });
        const d = await r.json();
        const detail = d.session || null;
        setSessionDetail(detail);
        if (detail) {
          // #27 — Cap session cache to MAX_SESSION_CACHE entries
          const cache = sessionCacheRef.current;
          if (cache.size >= MAX_SESSION_CACHE) {
            // Evict oldest entry
            const firstKey = cache.keys().next().value;
            if (firstKey) cache.delete(firstKey);
          }
          cache.set(session.filePath, { data: detail, timestamp: Date.now() });
        }
      } catch (e) {
        console.error("Failed to load session detail:", e);
      }
    }
  }, [isMobile]);

  /**
   * Copy a session's full transcript to the clipboard as raw API markdown.
   * Uses the in-memory cache if the session is already loaded, otherwise
   * fetches the detail on demand. The resulting text mirrors the API's wire
   * format rendered as markdown (see lib/markdownExport).
   */
  const handleCopySession = useCallback(async (s: SessionSummary) => {
    try {
      const cached = sessionCacheRef.current.get(s.filePath);
      let detail = cached && Date.now() - cached.timestamp < SESSION_CACHE_TTL
        ? cached.data
        : null;
      if (!detail) {
        const r = await fetch(`/api/sessions/detail?path=${encodeURIComponent(s.filePath)}`);
        const d = await r.json();
        detail = d.session || null;
        if (detail) {
          const cache = sessionCacheRef.current;
          if (cache.size >= MAX_SESSION_CACHE) {
            const firstKey = cache.keys().next().value;
            if (firstKey) cache.delete(firstKey);
          }
          cache.set(s.filePath, { data: detail, timestamp: Date.now() });
        }
      }
      if (!detail) return;
      const messages = (detail.entries || [])
        .map(e => e.message)
        .filter((m): m is ChatMessage => !!m);
      copyToClipboard(sessionToMarkdown(messages, s.name || undefined));
    } catch (e) {
      console.error("Failed to copy session:", e);
    }
  }, []);

  const handleNewSession = useCallback(() => {
    const id = uuidV4();
    setNewSessionId(id);
    setActiveSession(null);
    setSessionDetail(null);
    // #64 — Only set view to 'chat' when a project is selected (ws requires projectId)
    if (selectedProject) {
      setView("chat");
      if (isMobile) setActiveMobilePanel("chat");
    }
    // Refresh session list after PI creates the new session file
    safeTimeout(() => fetchSessions(), SESSION_FETCH_DELAY_MS);
  }, [fetchSessions, selectedProject, isMobile, setActiveMobilePanel]);

  const handleBack = useCallback(() => {
    if (view === "chat") {
      setView("sessions");
      setActiveSession(null);
      setSessionDetail(null);
    } else if (view === "sessions") {
      setView("projects");
      setSelectedProject(null);
      setSessions([]);
    }
  }, [view]);

  // New: "go home" — collapse everything, no project selected
  const handleGoHome = useCallback(() => {
    setView("projects");
    setSelectedProject(null);
    setActiveSession(null);
    setSessionDetail(null);
    setSessions([]);
  }, []);

  const handleAddProject = useCallback(async (path: string, name: string) => {
    setIsAddingProject(true);
    try {
      const r = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, name }),
      });
      if (r.ok) {
        const d = await r.json();
        setProjects(prev => [d.project, ...prev]);
        setShowAddProject(false);
      } else {
        try {
          const d = await r.json();
          alert(d.error || "Failed to add project");
        } catch {
          alert(r.statusText || "Failed to add project");
        }
      }
    } catch (e) {
      console.error(e);
    } finally {
      setIsAddingProject(false);
    }
  }, []);

  const handleDeleteProject = useCallback(async (id: string) => {
    const r = await fetch(`/api/projects/${id}`, { method: "DELETE" });
    if (r.ok) {
      setProjects(prev => prev.filter(p => p.id !== id));
      if (selectedProject?.id === id) {
        setSelectedProject(null);
        setView("projects");
      }
    } else {
      alert("Failed to delete project");
    }
  }, [selectedProject]);

  // Delete session
  const handleDeleteSession = useCallback(async (session: SessionSummary) => {
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(session.filePath)}`, { method: "DELETE" });
      if (r.ok) {
        setSessions(prev => prev.filter(s => s.id !== session.id));
        if (activeSession?.id === session.id) {
          setActiveSession(null);
          setView("sessions");
        }
      } else {
        alert("Failed to delete session");
      }
    } catch (e) {
      console.error("Failed to delete session:", e);
      alert("Failed to delete session");
    }
  }, [activeSession]);

  // Rename session
  const handleRenameSession = useCallback(async (session: SessionSummary, name: string) => {
    try {
      const r = await fetch("/api/sessions/rename", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionPath: session.filePath, name }),
      });
      if (r.ok) {
        setSessions(prev => prev.map(s => s.id === session.id ? { ...s, name } : s));
        if (activeSession?.id === session.id) {
          setActiveSession(prev => prev ? { ...prev, name } : prev);
        }
      }
    } catch (e) {
      console.error("Failed to rename session:", e);
    }
  }, [activeSession]);

  // Fork session
  const handleForkSession = useCallback((entryId: string) => {
    if (ws) {
      ws.send({ type: "fork", entryId });
      safeTimeout(() => fetchSessions(), SESSION_FETCH_DELAY_MS);
    }
  }, [ws, fetchSessions]);

  // Refresh sessions manually
  const handleRefreshSessions = useCallback(() => {
    fetchSessions();
  }, [fetchSessions]);

  // Continue latest session
  const handleContinueLatest = useCallback(() => {
    if (sessions.length > 0) {
      handleSelectSession(sessions[0]);
    }
  }, [sessions, handleSelectSession]);

  const panels = useMemo(() => [
    ...(sidebarOpen ? [{
      id: "channels" as const,
      title: "Channels",
      icon: <Icon name="hash" size={12} />,
      children: (
        <ProjectSessionSidebar
          projects={projects}
          selectedProject={selectedProject}
          streamingProjectIds={streamingProjectIds}
          isAddingProject={isAddingProject}
          sessions={sessions}
          activeSession={activeSession}
          search={channelSearch}
          onSearch={setChannelSearch}
          onSelectProject={handleSelectProject}
          onSelectSession={handleSelectSession}
          onSelectHome={handleGoHome}
          onAddProject={() => setShowAddProject(true)}
          onNewSession={handleNewSession}
          onDeleteProject={(project) => handleDeleteProject(project.id)}
          onDeleteSession={handleDeleteSession}
          onRenameSession={handleRenameSession}
          onForkSession={handleForkSession}
          onCopySession={handleCopySession}
          onRefreshSessions={handleRefreshSessions}
          onContinueLatest={handleContinueLatest}
          streamingSessionIds={streamingSessionIds}
          onRequestConfirm={(title, message, onConfirm) => setConfirmDialog({ open: true, title, message, onConfirm })}
          onOpenSettings={() => setShowSettings(true)}
        />
      ),
      onClose: () => setSidebarOpen(false),
    }] : []),
    {
      id: "chat" as const,
      title: "Chat",
      icon: <Icon name="pi-logo" size={12} />,
      children: (
        <div className="flex-1 flex flex-col min-w-0 min-h-0 h-full overflow-hidden">
          {view === "chat" && ws ? (
            <ChatView
              ws={ws}
              sessionDetail={sessionDetail}
              project={selectedProject}
              session={activeSession}
              showSidebar={sidebarOpen}
              onToggleSidebar={() => setSidebarOpen((v) => !v)}
              onBack={handleBack}
              onToggleTerminal={() => { setTerminalOpen(v => !v); if (!terminalOpen && isMobile) setActiveMobilePanel("terminal"); }}
              onTogglePreview={() => { const wasOpen = rightPanel.isOpen("preview"); rightPanel.toggle("preview"); if (!wasOpen && isMobile) setActiveMobilePanel("preview"); }}
              onToggleGit={() => { const wasOpen = gitOpen; rightPanel.toggle("git"); if (!wasOpen && isMobile) setActiveMobilePanel("git"); }}
              onToggleFiles={() => { const wasOpen = filesOpen; rightPanel.toggle("files"); if (!wasOpen && isMobile) setActiveMobilePanel("files"); }}
              onToggleExtensions={() => { const wasOpen = extensionsOpen; rightPanel.toggle("extensions"); if (!wasOpen && isMobile) setActiveMobilePanel("extensions"); }}
              terminalOpen={terminalOpen}
              previewOpen={rightPanel.isOpen("preview")}
              gitOpen={gitOpen}
              filesOpen={filesOpen}
              extensionsOpen={extensionsOpen}
            />
          ) : view === "sessions" ? (
            <SessionWelcome
              project={selectedProject}
              sessions={sessions}
              onSelectSession={handleSelectSession}
              onNewSession={handleNewSession}
              onBack={handleBack}
              onViewAllSessions={() => { setSidebarOpen(true); if (isMobile) setActiveMobilePanel("channels"); }}
              onAddProject={() => setShowAddProject(true)}
            />
          ) : (
            <EmptyState
              projects={projects}
              onSelectProject={handleSelectProject}
              onAddProject={() => setShowAddProject(true)}
            />
          )}
        </div>
      ),
    },
    ...(rightPanel.isOpen("preview") && selectedProject ? [{
      id: "preview" as const,
      title: "Preview",
      icon: <Icon name="preview" size={12} />,
      children: (
        <PreviewPanel
          projectId={selectedProject.id}
          projectName={selectedProject.name}
          projectPath={selectedProject.path}
          preview={activePreview || null}
          onElementSelected={handleElementSelected}
          onRefresh={fetchPreviews}
          embedded
          compactHeader
        />
      ),
      onClose: () => rightPanel.close("preview"),
    }] : []),
    ...(gitOpen && selectedProject ? [{
      id: "git" as const,
      title: "Git",
      icon: <Icon name="git" size={12} />,
      children: (
        <GitPanel
          cwd={selectedProject.path}
          visible={true}
          onClose={() => rightPanel.close("git")}
          embedded
          projectId={selectedProject.id}
        />
      ),
      onClose: () => rightPanel.close("git"),
    }] : []),
    ...(filesOpen && selectedProject ? [{
      id: "files" as const,
      title: "Files",
      icon: <Icon name="file" size={12} />,
      children: (
        <FilesPanel
          cwd={selectedProject.path}
          projectId={selectedProject.id}
          visible={true}
          onClose={() => rightPanel.close("files")}
          embedded
        />
      ),
      onClose: () => rightPanel.close("files"),
    }] : []),
    ...(extensionsOpen ? [{
      id: "extensions" as const,
      title: "Extensions",
      icon: <Icon name="puzzle" size={12} />,
      children: (
        <ExtensionsPanel
          visible={true}
          onClose={() => rightPanel.close("extensions")}
          embedded
        />
      ),
      onClose: () => rightPanel.close("extensions"),
    }] : []),
    ...(terminalOpen ?[{
      id: "terminal" as const,
      title: "Terminal",
      icon: <Icon name="terminal" size={12} />,
      header: (
        <TerminalPanelHeader
          tabs={terminalTabs}
          activeTabId={terminalActiveTabId}
          onSelectTab={setTerminalActiveTabId}
          onAddTerminal={addTerminal}
          onRemoveTab={removeTerminal}
          onRenameTab={renameTerminal}
        />
      ),
      children: (
        <TerminalPanel
          visible={true}
          onClose={() => setTerminalOpen(false)}
          embedded
          tabs={terminalTabs}
          activeTabId={terminalActiveTabId}
          onAddTerminal={addTerminal}
        />
      ),
      onClose: () => setTerminalOpen(false),
    }] : []),
  ], [activePreview, addTerminal, channelSearch, extensionsOpen, filesOpen, gitOpen, handleDeleteProject, handleDeleteSession, handleElementSelected, handleForkSession, handleRefreshSessions, handleRenameSession, handleSelectProject, handleSelectSession, isAddingProject, projects, removeTerminal, renameTerminal, rightPanel, selectedProject, sessionDetail, sessions, sidebarOpen, streamingProjectIds, streamingSessionIds, terminalActiveTabId, terminalTabs, terminalOpen, view, ws]);

  // Reset active mobile tab when the panel it points to is closed
  useEffect(() => {
    const openIds = new Set(panels.map((p) => p.id) as WorkspacePanelKind[]);
    if (!openIds.has(activeMobilePanel)) {
      setActiveMobilePanel("chat");
    }
  }, [panels, activeMobilePanel]);

  // Listen for WS session events
  useEffect(() => {
    if (!ws) return;
    ws.setOnSessionEvent((event) => {
      if (event.type === "sessions_refreshed") {
        setSessions(event.sessions || []);
      }
    });
    // #4 — Cleanup: remove handler from old connection on ws change
    return () => ws.setOnSessionEvent(null);
  }, [ws]);

  // Cmd/Ctrl+N shortcut — new session
  // Cmd/Ctrl+K — quick project switcher (⌘P) by cycling through projects.
  // Cmd/Ctrl+B — toggle the project/session sidebar.
  // Cmd/Ctrl+1..9 — jump to a project by index.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isMobile) return;
      if ((e.metaKey || e.ctrlKey) && e.key === "n") {
        e.preventDefault();
        handleNewSession();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        // Cycle to next project (or home if no project selected)
        if (projects.length === 0) return;
        const idx = selectedProject
          ? projects.findIndex(p => p.id === selectedProject.id)
          : -1;
        const next = projects[(idx + 1) % projects.length];
        if (next) handleSelectProject(next);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "0") {
        e.preventDefault();
        handleGoHome();
      }
      if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        const n = parseInt(e.key, 10) - 1;
        if (projects[n]) handleSelectProject(projects[n]);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleNewSession, handleGoHome, handleSelectProject, isMobile, projects, selectedProject]);

  // #62 — Cleanup all safeTimeout timers on unmount
  useEffect(() => {
    return () => {
      for (const id of timersRef.current) clearTimeout(id);
      timersRef.current.clear();
    };
  }, []);

  return (
    <div className="flex h-[100dvh] overflow-hidden bg-ink-950">
      <PWABanner />
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:top-0 focus:left-0 focus:z-80 focus:bg-ink-900 focus:p-4 focus:text-amber-500">Skip to chat</a>
      <main id="main-content" className="flex-1 flex flex-row min-w-0 min-h-0 h-full overflow-hidden">
        {isMobile ? (
          <MobileShell
            panels={panels}
            closedPanels={closedPanels}
            activePanelId={activeMobilePanel}
            onActivatePanel={setActiveMobilePanel}
            onReopenPanel={reopenPanel}
          />
        ) : (
          <WorkspaceDock
          layout={workspaceLayout.layout}
          panels={panels}
          onMovePanel={workspaceLayout.movePanel}
          onResizeRegion={workspaceLayout.resizeRegion}
          onResizePanel={workspaceLayout.resizePanel}
          onReset={requestWorkspaceReset}
          closedPanels={closedPanels}
          onReopenPanel={reopenPanel}
          saving={workspaceLayout.saving}
          error={workspaceLayout.error}
        />
        )}
      </main>

      <BackgroundSessionToast
        wsPool={wsPool}
        projects={projects}
        activeProjectId={selectedProject?.id ?? null}
        activeSessionId={activeSession?.id ?? null}
        onSelectProject={handleSelectProject}
        onSelectSession={handleSelectSession}
      />
        <ConfirmDialog
          open={confirmDialog.open}
          title={confirmDialog.title}
          message={confirmDialog.message}
          confirmLabel={confirmDialog.confirmLabel}
          onConfirm={() => { confirmDialog.onConfirm(); setConfirmDialog(s => ({ ...s, open: false })); }}
          onCancel={() => setConfirmDialog(s => ({ ...s, open: false }))}
        />
      {showAddProject && (
        <AddProjectExplorer
          onAdd={(path, name) => { handleAddProject(path, name); setShowAddProject(false); }}
          onCancel={() => setShowAddProject(false)}
        />
      )}
      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          onResetWorkspace={requestWorkspaceReset}
          projectId={selectedProject?.id}
        />
      )}
    </div>
  );
}

function SessionWelcome({ project, sessions, onSelectSession, onNewSession, onBack, onViewAllSessions, onAddProject }: {
  project: Project | null;
  sessions: SessionSummary[];
  onSelectSession: (s: SessionSummary) => void;
  onNewSession?: () => void;
  onBack?: () => void;
  onViewAllSessions?: () => void;
  onAddProject?: () => void;
}) {
  return (
    <div className="conversation-session-welcome">
      <div className="conversation-session-welcome-card max-h-full overflow-y-auto custom-scrollbar">
        {project && onBack && (
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-1.5 mb-3 text-ink-500 hover:text-ink-200 text-xs font-mono transition-colors"
            aria-label="Back to projects"
          >
            <Icon name="chevron-left" size={12} />
            Projects
          </button>
        )}
        <div className="conversation-session-welcome-rule">
          <span className="conversation-session-welcome-label">
            {project ? "Project" : "Welcome"}
          </span>
        </div>

        <h1 className="conversation-session-welcome-title">
          {project?.name || "PI"}
        </h1>

        <p className="conversation-session-welcome-path">
          {project?.path}
        </p>

        <p className="conversation-session-welcome-count">
          {sessions.length === 0
            ? "No sessions yet — start a new one"
            : `${sessions.length} session${sessions.length === 1 ? "" : "s"} in this project`}
        </p>

        {sessions.length > 0 && (
          <div className="conversation-session-welcome-section">
            <div className="conversation-session-welcome-section-title">Recent</div>
            {onNewSession && (
              <button
                type="button"
                onClick={onNewSession}
                className="conversation-session-welcome-item"
                style={{ animationDelay: '80ms' }}
              >
                <div className="conversation-session-welcome-index" aria-hidden>+</div>
                <div className="conversation-session-welcome-copy">
                  <div className="conversation-session-welcome-item-title">New session</div>
                  <div className="conversation-session-welcome-meta">Start a new conversation</div>
                </div>
              </button>
            )}
            {sessions.slice(0, 8).map((s, i) => (
              <button
                type="button"
                key={s.id}
                onClick={() => onSelectSession(s)}
                className="conversation-session-welcome-item"
                style={{ animationDelay: `${80 + i * 40}ms` }}
              >
                <div className="conversation-session-welcome-index" aria-hidden>#</div>
                <div className="conversation-session-welcome-copy">
                  <div className="conversation-session-welcome-item-title">
                    {s.name || s.lastMessage || s.firstMessage || "Untitled session"}
                  </div>
                  <div className="conversation-session-welcome-meta">
                    {s.messageCount > 0 && <span>{s.messageCount} messages</span>}
                    {s.messageCount > 0 && s.model && <span className="conversation-session-welcome-separator">·</span>}
                    {s.model && <span>{s.model}</span>}
                    {s.messageCount === 0 && !s.model && <span>New session</span>}
                  </div>
                </div>
                <div className="conversation-session-welcome-time">
                  {formatTimeAgo(s.lastActiveAt || s.timestamp)}
                </div>
              </button>
            ))}
            {sessions.length > 8 && onViewAllSessions && (
              <button
                type="button"
                onClick={onViewAllSessions}
                className="conversation-session-welcome-item"
              >
                <div className="conversation-session-welcome-index" aria-hidden>→</div>
                <div className="conversation-session-welcome-copy">
                  <div className="conversation-session-welcome-item-title">View all {sessions.length} sessions</div>
                </div>
              </button>
            )}
          </div>
        )}

        {sessions.length === 0 && onNewSession && (
          <button
            type="button"
            onClick={onNewSession}
            className="conversation-session-welcome-item"
            style={{ animationDelay: '80ms' }}
          >
            <div className="conversation-session-welcome-index" aria-hidden>+</div>
            <div className="conversation-session-welcome-copy">
              <div className="conversation-session-welcome-item-title">New session</div>
              <div className="conversation-session-welcome-meta">Start a new conversation</div>
            </div>
          </button>
        )}
        {sessions.length === 0 && !onNewSession && (
          <div className="conversation-session-welcome-count conversation-session-welcome-shortcut">
            Press <kbd className="conversation-kbd">⌘N</kbd> to start a conversation
          </div>
        )}

        {onAddProject && !project && (
          <button
            type="button"
            onClick={onAddProject}
            className="conversation-session-welcome-item"
            style={{ animationDelay: '160ms' }}
          >
            <div className="conversation-session-welcome-index" aria-hidden>+</div>
            <div className="conversation-session-welcome-copy">
              <div className="conversation-session-welcome-item-title">Add a project</div>
              <div className="conversation-session-welcome-meta">Connect a codebase to get started</div>
            </div>
          </button>
        )}
      </div>
    </div>
  );
}


