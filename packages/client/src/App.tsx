import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import type { Project, SessionSummary, SessionDetail, ChatMessage } from "@pi-web/shared";
import { formatTimeAgo } from "./lib/utils";
import { SESSION_CACHE_TTL, SESSION_FETCH_DELAY_MS } from "./lib/constants";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { EmptyState } from "./components/EmptyState";
import { BackgroundSessionToast } from "./components/BackgroundSessionToast";
import { useWebSocketPool } from "./hooks/useWebSocketPool";
import { useTheme } from "./hooks/useTheme";
import { useIsMobile } from "./hooks/useIsMobile";
import { PWABanner } from "./components/PWABanner";
import { uuidV4 } from "./lib/uuid";
import { sessionToMarkdown, copyToClipboard } from "./lib/markdownExport";

const MAX_SESSION_CACHE = 50;

export type ViewState = "projects" | "sessions" | "chat";

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
  const [showSidebar, setShowSidebar] = useState(false);
  useEffect(() => {
    setShowSidebar(typeof window !== "undefined" ? window.innerWidth >= 768 : false);
  }, []);
  const isMobile = useIsMobile();

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
  // sessions are not torn down when the user switches project/session. The server-side 5-minute
  // idle timeout cleans up abandoned sessions.
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

  const [theme, toggleTheme] = useTheme();

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
    if (isMobile) safeTimeout(() => setShowSidebar(false), 150);
  }, [isMobile]);

  const handleSelectSession = useCallback(async (session: SessionSummary) => {
    setActiveSession(session);
    setView("chat");
    if (isMobile) safeTimeout(() => setShowSidebar(false), 150);

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
  }, [ws, isMobile]);

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
    if (selectedProject) setView("chat");
    if (isMobile) safeTimeout(() => setShowSidebar(false), 150);
    // Refresh session list after PI creates the new session file
    safeTimeout(() => fetchSessions(), SESSION_FETCH_DELAY_MS);
  }, [fetchSessions, isMobile, selectedProject]);

  const handleBack = useCallback(() => {
    if (view === "chat") {
      setView("sessions");
      setActiveSession(null);
      setSessionDetail(null);
      if (isMobile) setShowSidebar(true);
    } else if (view === "sessions") {
      setView("projects");
      setSelectedProject(null);
      setSessions([]);
      if (isMobile) setShowSidebar(true);
    }
  }, [view, isMobile]);

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
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "n") {
        e.preventDefault();
        handleNewSession();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "b") {
        e.preventDefault();
        setShowSidebar(v => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleNewSession]);

  // #62 — Cleanup all safeTimeout timers on unmount
  useEffect(() => {
    return () => {
      for (const id of timersRef.current) clearTimeout(id);
      timersRef.current.clear();
    };
  }, []);

  return (
    <div className="flex h-screen overflow-hidden bg-ink-950">
      <PWABanner />
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:top-0 focus:left-0 focus:z-80 focus:bg-ink-900 focus:p-4 focus:text-amber-500">Skip to chat</a>
      {showSidebar && (
      <>
        {/* Mobile: overlay backdrop */}
        {isMobile && (
          <div
            className="fixed inset-0 z-20 bg-ink-950/60 backdrop-blur-sm"
            onClick={() => setShowSidebar(false)}
          />
        )}
        <Sidebar
          projects={projects}
          sessions={sessions}
          selectedProject={selectedProject}
          activeSession={activeSession}
          view={view}
          showAddProject={showAddProject}
          theme={theme}
          onSelectProject={handleSelectProject}
          onSelectSession={handleSelectSession}
          onBack={handleBack}
          onNewSession={handleNewSession}
          onAddProject={handleAddProject}
          isAddingProject={isAddingProject}
          onDeleteProject={handleDeleteProject}
          onToggleAddProject={() => setShowAddProject(v => !v)}
          onToggleTheme={toggleTheme}
          onDeleteSession={handleDeleteSession}
          onRenameSession={handleRenameSession}
          onForkSession={handleForkSession}
          onCopySession={handleCopySession}
          onRefreshSessions={handleRefreshSessions}
          onContinueLatest={handleContinueLatest}
          streamingSessionIds={streamingSessionIds}
          streamingProjectIds={streamingProjectIds}
          onToggleSidebar={() => setShowSidebar(false)}
          isMobile={isMobile}
        />
      </>
      )}


      <main id="main-content" className="flex-1 flex flex-col min-w-0">
        {view === "chat" && ws ? (
          <ChatView
            ws={ws}
            sessionDetail={sessionDetail}
            project={selectedProject}
            session={activeSession}
            onToggleSidebar={() => setShowSidebar(true)}
            showSidebar={showSidebar}
          />
        ) : view === "sessions" ? (
          <SessionWelcome
            project={selectedProject}
            sessions={sessions}
            onSelectSession={handleSelectSession}
          />
        ) : (
          <EmptyState
            projects={projects}
            onSelectProject={handleSelectProject}
            onAddProject={() => setShowAddProject(true)}
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
    </div>
  );
}

function SessionWelcome({ project, sessions, onSelectSession }: {
  project: Project | null;
  sessions: SessionSummary[];
  onSelectSession: (s: SessionSummary) => void;
}) {
  const isMobileScreen = useIsMobile();
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-4 md:p-8 mobile-safe-top">
      <div className="max-w-lg w-full text-center animate-fade-in-up">
        {/* Mobile back hint */}
        {isMobileScreen && (
          <p className="text-ink-500 text-xs font-mono mb-4">Tap ☰ to browse sessions</p>
        )}
        <h2 className="text-xl md:text-2xl font-semibold text-ink-100 mb-2">
          {project?.name || "Sessions"}
        </h2>
        <p className="text-ink-400 text-lg italic mb-8">
          {sessions.length === 0
            ? "No sessions yet. Start a new one."
            : `${sessions.length} session${sessions.length === 1 ? "" : "s"}`}
        </p>
        
        {sessions.length > 0 && (
          <div className="space-y-2 text-left">
            {sessions.slice(0, 10).map(s => (
              <button
                key={s.id}
                onClick={() => onSelectSession(s)}
                className="w-full text-left p-4 rounded-lg bg-ink-900 hover:bg-ink-850 border border-ink-800 hover:border-ink-700 transition-theme group"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-ink-200 font-medium text-sm truncate">
                      {s.name || s.lastMessage || "Untitled session"}
                    </div>
                    <div className="text-ink-500 text-xs mt-1 font-mono">
                      {s.messageCount} messages
                      {s.model && ` · ${s.model}`}
                    </div>
                  </div>
                  <div className="text-ink-500 text-xs shrink-0 mt-0.5">
                    {formatTimeAgo(s.timestamp)}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}


