import { useState, useEffect, useRef } from "react";
import type { Project, SessionSummary } from "@pi-web/shared";
import type { WSConnection } from "../hooks/useWebSocketPool";

interface BackgroundSessionToastProps {
  wsPool: { pool: Map<string, WSConnection> };
  projects: Project[];
  activeProjectId: string | null;
  activeSessionId: string | null;
  onSelectProject: (p: Project) => void;
  onSelectSession: (s: SessionSummary) => void;
}

interface Toast {
  id: string;
  project: Project;
  session: SessionSummary;
  finishedAt: number;
}

const TOAST_DURATION_MS = 5000;
const POLL_INTERVAL_MS = 500;

export function BackgroundSessionToast({
  wsPool,
  projects,
  activeProjectId,
  activeSessionId,
  onSelectProject,
  onSelectSession,
}: BackgroundSessionToastProps) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const prevIsActiveRef = useRef<Map<string, boolean>>(new Map());

  useEffect(() => {
    const seen = new Set<string>();
    for (const [key, conn] of wsPool.pool.entries()) {
      seen.add(key);
      const wasActive = prevIsActiveRef.current.get(key) ?? false;
      const isActive = conn.isActive;
      if (wasActive && !isActive) {
        const sessionId = conn.state?.sessionId;
        const projectId = key.split("::")[0];
        if (
          sessionId &&
          (sessionId !== activeSessionId || projectId !== activeProjectId)
        ) {
          const project = projects.find(p => p.id === projectId);
          const sessionFile = conn.state?.sessionFile;
          if (project && sessionFile) {
            const session: SessionSummary = {
              id: sessionId,
              filePath: sessionFile,
              cwd: project.path,
              timestamp: new Date().toISOString(),
              name: conn.state?.sessionName || null,
              messageCount: 0,
              lastMessage: null,
              model: null,
              firstMessage: null,
              createdAt: new Date().toISOString(),
              lastActiveAt: new Date().toISOString(),
              tokenCount: 0,
              cost: 0,
              isRecentlyActive: true,
            };
            setToasts(prev => {
              if (prev.some(t => t.id === sessionId)) return prev;
              return [
                ...prev,
                {
                  id: sessionId,
                  project,
                  session,
                  finishedAt: Date.now(),
                },
              ];
            });
          }
        }
      }
      prevIsActiveRef.current.set(key, isActive);
    }
    for (const k of Array.from(prevIsActiveRef.current.keys())) {
      if (!seen.has(k)) prevIsActiveRef.current.delete(k);
    }
  });

  useEffect(() => {
    if (toasts.length === 0) return;
    const interval = setInterval(() => {
      const now = Date.now();
      setToasts(prev => prev.filter(t => now - t.finishedAt < TOAST_DURATION_MS));
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [toasts.length]);

  if (toasts.length === 0) return null;

  const handleClick = (t: Toast) => {
    onSelectProject(t.project);
    onSelectSession(t.session);
    setToasts(prev => prev.filter(x => x.id !== t.id));
  };

  return (
    <div
      className="conversation-session-toast-stack"
      role="status"
      aria-live="polite"
    >
      {toasts.map(t => (
        <button
          type="button"
          key={t.id}
          onClick={() => handleClick(t)}
          className="conversation-session-toast"
          title="Click to view this session"
        >
          <div className="flex items-start gap-2">
            <span className="conversation-session-toast-dot" />
            <div className="min-w-0 flex-1">
              <div className="conversation-session-toast-title">
                {t.session.name || "Session finished"}
              </div>
              <div className="conversation-session-toast-meta">
                in {t.project.name}
              </div>
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}
