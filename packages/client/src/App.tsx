import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import type { Project, SessionSummary, SessionDetail } from "@pi-web/shared";
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

  // WebSocket pool — multiple concurrent connections, agents keep streaming when navigating away
  const wsPool = useWebSocketPool();
  const ws = wsPool.getOrConnect(
    selectedProject?.id || null,
    activeSession?.filePath || null,
    newSessionId,
  );

  // Compute which sessions are actively streaming from the pool
  const streamingSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const conn of wsPool.pool.values()) {
      if (conn.isStreaming && conn.state?.sessionId) {
        ids.add(conn.state.sessionId);
      }
    }
    return ids;
  }, [wsPool.pool]);

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
    
    // Load session detail
    try {
      const r = await fetch(`/api/sessions/detail?path=${encodeURIComponent(session.filePath)}`);
      const d = await r.json();
      setSessionDetail(d.session || null);
    } catch (e) {
      console.error("Failed to load session detail:", e);
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
    setTimeout(() => fetchSessions(), 1500);
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
      setTimeout(() => fetchSessions(), 1500);
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

  return (
    <div className="flex h-screen overflow-hidden bg-ink-950">
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
        onDeleteProject={handleDeleteProject}
        onToggleAddProject={() => setShowAddProject(v => !v)}
        onToggleTheme={toggleTheme}
        onDeleteSession={handleDeleteSession}
        onRenameSession={handleRenameSession}
        onForkSession={handleForkSession}
        onRefreshSessions={handleRefreshSessions}
        onContinueLatest={handleContinueLatest}
        streamingSessionIds={streamingSessionIds}
      />
      
      <main className="flex-1 flex flex-col min-w-0">
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

function formatTimeAgo(ts: string): string {
  const d = new Date(ts);
  const now = Date.now();
  const diff = now - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return d.toLocaleDateString();
}
