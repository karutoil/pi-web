import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import type { Project, SessionSummary, SessionDetail } from "@pi-web/shared";
import { formatTimeAgo } from "./lib/utils";
import { SESSION_CACHE_TTL, SESSION_FETCH_DELAY_MS } from "./lib/constants";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { EmptyState } from "./components/EmptyState";
import { useWebSocketPool } from "./hooks/useWebSocketPool";
import { useTheme } from "./hooks/useTheme";

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
  const [showSidebar, setShowSidebar] = useState(true);

  // Session detail cache with 30s TTL
  const sessionCacheRef = useRef<Map<string, { data: SessionDetail; timestamp: number }>>(new Map());

  // WebSocket pool — multiple concurrent connections, agents keep streaming when navigating away
  const wsPool = useWebSocketPool();
  const ws = wsPool.getOrConnect(
    selectedProject?.id || null,
    activeSession?.filePath || null,
    newSessionId,
  );

  // Compute which sessions are actively streaming from the pool
  // Must be inline (not useMemo) — pool is a ref Map, its identity never changes,
  // but pool subscriptions trigger forceUpdate so we recompute on every render
  const streamingSessionIds = new Set<string>();
  for (const conn of wsPool.pool.values()) {
    if (conn.isActive && conn.state?.sessionId) {
      streamingSessionIds.add(conn.state.sessionId);
    }
  }

  // When the WS connection reports session info (from get_state or session_loaded),
  // stabilize the active session by updating filePath and clearing newSessionId
  useEffect(() => {
    if (!ws) return;
    const handleSessionLoaded = (session: SessionDetail) => {
      setActiveSession(prev => prev ? { ...prev, filePath: session.filePath } : prev);
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
    fetch(`/api/projects/${selectedProject.id}/sessions`)
      .then(r => r.json())
      .then(d => setSessions(d.sessions || []))
      .catch(console.error);
  }, [selectedProject]);

  // Refresh sessions when agent finishes a run
  const prevStreaming = useRef(false);
  useEffect(() => {
    if (prevStreaming.current && !ws?.isStreaming) {
      setTimeout(() => fetchSessions(), 800);
    }
    prevStreaming.current = ws?.isStreaming || false;
  }, [ws?.isStreaming, fetchSessions]);

  // Invalidate session cache when streaming ends (agent_end)
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
  }, []);

  const handleSelectSession = useCallback(async (session: SessionSummary) => {
    setActiveSession(session);
    setView("chat");

    // Load session detail — check cache first
    const cached = sessionCacheRef.current.get(session.filePath);
    if (cached && Date.now() - cached.timestamp < SESSION_CACHE_TTL) {
      setSessionDetail(cached.data);
    } else {
      try {
        const r = await fetch(`/api/sessions/detail?path=${encodeURIComponent(session.filePath)}`);
        const d = await r.json();
        const detail = d.session || null;
        setSessionDetail(detail);
        if (detail) {
          sessionCacheRef.current.set(session.filePath, {
            data: detail,
            timestamp: Date.now(),
          });
        }
      } catch (e) {
        console.error("Failed to load session detail:", e);
      }
    }
  }, []);

  const handleNewSession = useCallback(() => {
    // Generate a unique ID for the new session — this creates a fresh WS/agent
    const id = crypto.randomUUID();
    setNewSessionId(id);
    setActiveSession(null);
    setSessionDetail(null);
    setView("chat");
    // Refresh session list after PI creates the new session file
    setTimeout(() => fetchSessions(), SESSION_FETCH_DELAY_MS);
  }, [fetchSessions]);

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
        const d = await r.json();
        alert(d.error || "Failed to add project");
      }
    } catch (e) {
      console.error(e);
    } finally {
      setIsAddingProject(false);
    }
  }, []);

  const handleDeleteProject = useCallback(async (id: string) => {
    await fetch(`/api/projects/${id}`, { method: "DELETE" });
    setProjects(prev => prev.filter(p => p.id !== id));
    if (selectedProject?.id === id) {
      setSelectedProject(null);
      setView("projects");
    }
  }, [selectedProject]);

  // Delete session
  const handleDeleteSession = useCallback(async (session: SessionSummary) => {
    try {
      await fetch(`/api/sessions/${encodeURIComponent(session.filePath)}`, { method: "DELETE" });
      setSessions(prev => prev.filter(s => s.id !== session.id));
      if (activeSession?.id === session.id) {
        setActiveSession(null);
        setView("sessions");
      }
    } catch (e) {
      console.error("Failed to delete session:", e);
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
      setTimeout(() => fetchSessions(), SESSION_FETCH_DELAY_MS);
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

  return (
    <div className="flex h-screen overflow-hidden bg-ink-950">
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:top-0 focus:left-0 focus:z-80 focus:bg-ink-900 focus:p-4 focus:text-amber-500">Skip to chat</a>
      {showSidebar && (
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
        onRefreshSessions={handleRefreshSessions}
        onContinueLatest={handleContinueLatest}
        streamingSessionIds={streamingSessionIds}
        onToggleSidebar={() => setShowSidebar(false)}
      />
      )}
      {!showSidebar && (
        <button
          onClick={() => setShowSidebar(true)}
          className="absolute left-0 top-0 z-20 p-2 m-2 rounded-lg bg-ink-900/80 hover:bg-ink-800 text-ink-500 hover:text-amber-500 border border-ink-800/50 hover:border-ink-700 transition-theme backdrop-blur-sm"
          aria-label="Show sidebar"
          title="Show sidebar (⌘B)"
        >
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <line x1="3" y1="2" x2="3" y2="14" />
            <line x1="7" y1="5" x2="13" y2="5" />
            <line x1="7" y1="8" x2="11" y2="8" />
            <line x1="7" y1="11" x2="13" y2="11" />
          </svg>
        </button>
      )}
      
      <main id="main-content" className="flex-1 flex flex-col min-w-0">
        {view === "chat" && ws ? (
          <ChatView
            ws={ws}
            sessionDetail={sessionDetail}
            project={selectedProject}
            session={activeSession}
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
    </div>
  );
}

function SessionWelcome({ project, sessions, onSelectSession }: {
  project: Project | null;
  sessions: SessionSummary[];
  onSelectSession: (s: SessionSummary) => void;
}) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8">
      <div className="max-w-lg w-full text-center animate-fade-in-up">
        <h2 className="text-2xl font-semibold text-ink-100 mb-2">
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
                  <div className="text-ink-600 text-xs shrink-0 mt-0.5">
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


