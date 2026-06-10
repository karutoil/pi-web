import { useState, useEffect } from "react";
import type { SessionStats } from "@pi-web/shared";
import type { WSBridge } from "../lib/types";
import { Icon } from "./Icon";
import { useIsMobile } from "../hooks/useIsMobile";

interface Props {
  ws: WSBridge;
  cwd: string;
  sessionName: string | null;
  onToggleSidebar?: () => void;
  showSidebar?: boolean;
  onSessionActions?: () => void;
  /** Terminal panel toggle */
  onToggleTerminal?: () => void;
  showTerminal?: boolean;
}

export function ChatHeader({ ws, cwd, sessionName, onToggleSidebar, showSidebar, onSessionActions, onToggleTerminal, showTerminal }: Props) {
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
      <div className="conversation-mobile-header shrink-0 max-h-[35vh] overflow-y-auto">
        {onToggleSidebar && !showSidebar && (
          <button onClick={onToggleSidebar} className="conversation-toolbar-pill" aria-label="Show sidebar" title="Show sidebar">
            <Icon name="chevron-right" size={18} />
          </button>
        )}

        <div className="conversation-mobile-title-row">
          {editingName ? (
            <input
              value={nameInput}
              onChange={e => setNameInput(e.target.value)}
              onBlur={handleSaveName}
              onKeyDown={e => { if (e.key === "Enter") handleSaveName(); if (e.key === "Escape") setEditingName(false); }}
              className="conversation-title-input"
              autoFocus
            />
          ) : (
            <button
              onClick={() => { setNameInput(sessionName || ""); setEditingName(true); }}
              className="conversation-mobile-title"
              title="Tap to rename"
              aria-label="Rename session"
            >
              {sessionName || "Chat"}
            </button>
          )}

          {!ws.isConnected && (
            <span className="conversation-status" data-status="offline" title="Offline">
              <span className="conversation-status-dot" />
              Offline
            </span>
          )}
          {ws.isStreaming && (
            <span className="conversation-status" data-status="live" title="Live">
              <span className="conversation-status-dot" />
              Live
            </span>
          )}
        </div>

        {onSessionActions && (
          <button onClick={onSessionActions} className="conversation-toolbar-pill" aria-label="Session actions" title="Session actions">
            <Icon name="more" size={18} />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="conversation-header shrink-0">
      <div className="conversation-header-copy">
        <div className="conversation-header-row">
          {onToggleSidebar && !showSidebar && (
            <button onClick={onToggleSidebar} className="conversation-toolbar-pill" aria-label="Show sidebar" title="Show sidebar (⌘B)">
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
              className="conversation-title-input"
              autoFocus
            />
          ) : (
            <button
              onClick={() => { setNameInput(sessionName || ""); setEditingName(true); }}
              className="conversation-title"
              title="Click to rename"
              aria-label="Rename session"
            >
              {sessionName || "Chat"}
            </button>
          )}
        </div>
        <div className="conversation-cwd" title={cwd}>{cwd}</div>
      </div>

      <div className="conversation-header-actions">
        {!ws.isConnected && (
          <span className="conversation-status" data-status="offline">
            <span className="conversation-status-dot" />
            Offline
          </span>
        )}
        {ws.isStreaming && (
          <span className="conversation-status" data-status="live">
            <span className="conversation-status-dot" />
            Live
          </span>
        )}

        {stats && (
          <div className="conversation-stats">
            {stats.contextUsage && (
              <span title={`${stats.contextUsage.tokens.toLocaleString()} / ${stats.contextUsage.contextWindow.toLocaleString()} tokens`}>
                {stats.contextUsage.percent.toFixed(0)}%
              </span>
            )}
            <span>${stats.cost?.toFixed(2) ?? '—'}</span>
          </div>
        )}

        {onSessionActions && (
          <button onClick={onSessionActions} className="conversation-toolbar-pill" aria-label="Session actions" title="Export, clone, compact…">
            <Icon name="more" size={14} />
          </button>
        )}

        {onToggleTerminal && (
          <button
            onClick={onToggleTerminal}
            className={`conversation-toolbar-pill ${showTerminal ? "conversation-toolbar-pill-active" : ""}`}
            aria-label="Toggle terminal"
            title="Terminal"
          >
            <Icon name="terminal" size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
