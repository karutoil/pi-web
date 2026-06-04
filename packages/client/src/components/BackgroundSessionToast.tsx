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
  id: string; // unique key (sessionId + finishedAt)
  project: Project;
  session: SessionSummary;
  finishedAt: number;
}

const TOAST_DURATION_MS = 5000;
const POLL_INTERVAL_MS = 500;

/**
 * Background session toast — fires when an agent_end arrives for a session
 * that the user is not currently viewing. Click to navigate to it.
 *
 * Note: receives wsPool as a prop instead of calling useWebSocketPool()
 * directly, because each call to that hook creates a fresh pool Map. Sharing
 * the App's pool ensures we see the same connections the App sees.
 * TODO: pool API extension — once useWebSocketPool exposes a shared
 * pool/context, the prop can be removed.
 */
export function BackgroundSessionToast({
  wsPool,
  projects,
  activeProjectId,
  activeSessionId,
  onSelectProject,
  onSelectSession,
}: BackgroundSessionToastProps) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Track per-conn previous isActive to detect true → false transitions
  const prevIsActiveRef = useRef<Map<string, boolean>>(new Map());

  // Diff pool state on every render. The App's pool triggers a re-render on
  // every conn state change, so this effect re-runs naturally.
  useEffect(() => {
    const seen = new Set<string>();
    for (const [key, conn] of wsPool.pool.entries()) {
      seen.add(key);
      const wasActive = prevIsActiveRef.current.get(key) ?? false;
      const isActive = conn.isActive;
      if (wasActive && !isActive) {
        // Agent just finished — emit toast if not the active session
        const sessionId = conn.state?.sessionId;
        const projectId = key.split(":")[0];
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
    // Drop tracking entries for conns that have left the pool
    for (const k of Array.from(prevIsActiveRef.current.keys())) {
      if (!seen.has(k)) prevIsActiveRef.current.delete(k);
    }
  });

  // Auto-dismiss expired toasts
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
      className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm pointer-events-none"
      role="status"
      aria-live="polite"
    >
      {toasts.map(t => (
        <button
          key={t.id}
          onClick={() => handleClick(t)}
          className="pointer-events-auto text-left px-3 py-2 rounded-lg bg-ink-900/95 border border-teal-500/25 hover:border-teal-500/50 hover:bg-ink-900 transition-all animate-fade-in-up shadow-lg shadow-ink-950/50"
          title="Click to view this session"
        >
          <div className="flex items-start gap-2">
            <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-teal-400 mt-1.5" />
            <div className="min-w-0 flex-1">
              <div className="text-ink-200 text-xs font-medium truncate">
                {t.session.name || "Session finished"}
              </div>
              <div className="text-ink-500 text-[10px] font-mono truncate">
                in {t.project.name}
              </div>
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}
