import { useState, useEffect } from "react";
import type { SessionStats } from "@pi-web/shared";
import type { WSBridge } from "../lib/types";
import { Icon } from "./Icon";
import { useIsMobile } from "../hooks/useIsMobile";

interface Props {
  ws: WSBridge;
  cwd: string;
  sessionName: string | null;
  onToggleGit?: () => void;
  showGit?: boolean;
  onToggleSidebar?: () => void;
  showSidebar?: boolean;
  onSessionActions?: () => void;
  /** Preview panel toggle */
  onTogglePreview?: () => void;
  showPreview?: boolean;
}

export function ChatHeader({ ws, cwd, sessionName, onToggleGit, showGit, onToggleSidebar, showSidebar, onSessionActions, onTogglePreview, showPreview }: Props) {
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(sessionName || "");
  const isMobile = useIsMobile();

  // Fetch models on mount
  useEffect(() => {
    if (ws.isConnected) {
      ws.send({ type: "get_available_models" });
      ws.send({ type: "get_session_stats" });
    }
  }, [ws.isConnected]);

  // Refresh stats when streaming ends
  useEffect(() => {
    if (!ws.isStreaming && ws.isConnected) {
      const t = setTimeout(() => ws.send({ type: "get_session_stats" }), 500);
      return () => clearTimeout(t);
    }
  }, [ws.isStreaming, ws.isConnected]);

  const stats = ws.sessionStats;

  const handleSaveName = () => {
    const trimmed = nameInput.trim();
    if (trimmed) ws.send({ type: "set_session_name", name: trimmed });
    setEditingName(false);
  };

  // Mobile: compact two-row layout
  if (isMobile) {
    return (
      <>
        <div className="shrink-0 border-b border-ink-800 bg-ink-900/30 mobile-safe-top">
          {/* Row 1: hamburger + session name + status */}
          <div className="flex items-center gap-2 px-3 py-2">
            {onToggleSidebar && !showSidebar && (
              <button onClick={onToggleSidebar} className="p-1.5 -ml-1.5 rounded-lg text-ink-400 hover:text-ink-200 hover:bg-ink-800/50 active:bg-ink-800/70 transition-colors touch-target" aria-label="Show sidebar">
                <Icon name="chevron-right" size={18} />
              </button>
            )}

            <div className="flex-1 min-w-0 flex items-center gap-2">
              {editingName ? (
                <input
                  value={nameInput}
                  onChange={e => setNameInput(e.target.value)}
                  onBlur={handleSaveName}
                  onKeyDown={e => { if (e.key === "Enter") handleSaveName(); if (e.key === "Escape") setEditingName(false); }}
                  className="bg-ink-900 border border-ink-700 rounded-lg px-2.5 py-1 text-ink-100 text-sm font-medium outline-none focus:border-amber-500 flex-1 min-w-0"
                  autoFocus
                />
              ) : (
                <button
                  onClick={() => { setNameInput(sessionName || ""); setEditingName(true); }}
                  className="text-sm font-medium text-ink-200 truncate hover:text-amber-500 transition-colors text-left min-w-0"
                  title="Tap to rename"
                  aria-label="Rename session"
                >
                  {sessionName || "Chat"}
                </button>
              )}

              {/* Status dot — inline after name */}
              {!ws.isConnected && (
                <span className="w-2 h-2 rounded-full bg-rose-500 shrink-0" title="Offline" />
              )}
              {ws.isStreaming && (
                <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse shrink-0" title="Live" />
              )}
            </div>

            {/* Right actions — just the menu button */}
            {onSessionActions && (
              <button onClick={onSessionActions} className="p-1.5 -mr-1.5 rounded-lg text-ink-400 hover:text-ink-200 hover:bg-ink-800/50 active:bg-ink-800/70 transition-colors touch-target" aria-label="Session actions">
                <Icon name="more" size={18} />
              </button>
            )}
          </div>
        </div>
      </>
    );
  }

  // ─── Desktop layout — single row, model/thinking moved to ChatInput ───
  return (
    <>
      <div className="flex items-center gap-1.5 md:gap-2 px-3 md:px-4 py-2 border-b border-ink-800 bg-ink-900/30 shrink-0">
        {/* Logo + Session name */}
        <div className="flex-1 min-w-0 flex items-center gap-2">
          {onToggleSidebar && !showSidebar && (
            <button onClick={onToggleSidebar} className="icon-btn" aria-label="Show sidebar" title="Show sidebar (⌘B)">
              <Icon name="chevron-right" size={16} />
            </button>
          )}
          <img src="/pi-logo.svg" alt="" aria-hidden="true" className="w-4 h-4 shrink-0 opacity-60" />
          {editingName ? (
            <input
              value={nameInput}
              onChange={e => setNameInput(e.target.value)}
              onBlur={handleSaveName}
              onKeyDown={e => { if (e.key === "Enter") handleSaveName(); if (e.key === "Escape") setEditingName(false); }}
              className="bg-ink-900 border border-ink-700 rounded px-2 py-0.5 text-ink-100 text-sm font-medium outline-none focus:border-amber-500 w-32 lg:w-48"
              autoFocus
            />
          ) : (
            <button
              onClick={() => { setNameInput(sessionName || ""); setEditingName(true); }}
              className="text-sm font-medium text-ink-200 truncate hover:text-amber-500 transition-theme max-w-[120px] lg:max-w-[200px]"
              title="Click to rename"
              aria-label="Rename session"
            >
              {sessionName || "Chat"}
            </button>
          )}
          <span className="text-ink-500 text-xs font-mono truncate hidden sm:inline">{cwd}</span>
        </div>

        {/* Right controls */}
        <div className="flex items-center gap-1 shrink-0">
          {!ws.isConnected && (
            <span className="flex items-center gap-1 text-rose-500 text-xs font-mono">
              <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
              Offline
            </span>
          )}
          {ws.isStreaming && (
            <span className="flex items-center gap-1 text-amber-500 text-xs font-mono">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
              Live
            </span>
          )}

          {stats && (
            <div className="hidden md:flex items-center gap-2 text-ink-500 text-xs font-mono">
              {stats.contextUsage && (
                <span title={`${stats.contextUsage.tokens.toLocaleString()} / ${stats.contextUsage.contextWindow.toLocaleString()} tokens`}>
                  {stats.contextUsage.percent.toFixed(0)}%
                </span>
              )}
              <span>${stats.cost?.toFixed(2) ?? '—'}</span>
            </div>
          )}

          {onSessionActions && (
            <button onClick={onSessionActions} className="icon-btn" aria-label="Session actions" title="Export, clone, compact…">
              <Icon name="more" size={14} />
            </button>
          )}

          {onToggleGit && (
            <button onClick={onToggleGit} className={`icon-btn ${showGit ? "icon-btn-active" : ""}`} aria-label="Toggle git panel" title="Source Control">
              <Icon name="git" size={14} />
            </button>
          )}

          {onTogglePreview && (
            <button onClick={onTogglePreview} className={`icon-btn ${showPreview ? "icon-btn-active" : ""}`} aria-label="Toggle preview" title="Preview (⌘P)">
              <span className="text-xs">◧</span>
            </button>
          )}

        </div>
      </div>
    </>
  );
}
