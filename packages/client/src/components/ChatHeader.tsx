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
  /** Back navigation */
  onBack?: () => void;
  /** Preview panel toggle */
  onTogglePreview?: () => void;
  previewOpen?: boolean;
  /** Git panel toggle */
  onToggleGit?: () => void;
  gitOpen?: boolean;
  /** Files panel toggle */
  onToggleFiles?: () => void;
  filesOpen?: boolean;
  /** Extensions panel toggle */
  onToggleExtensions?: () => void;
  extensionsOpen?: boolean;
}

export function ChatHeader({ ws, cwd, sessionName, onToggleSidebar, showSidebar, onSessionActions, onToggleTerminal, showTerminal, onBack, onTogglePreview, previewOpen, onToggleGit, gitOpen, onToggleFiles, filesOpen, onToggleExtensions, extensionsOpen }: Props) {
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
        <div className="conversation-mobile-title-row">
          {onBack && (
            <button type="button" onClick={onBack} className="p-1.5 -ml-1 rounded-md hover:bg-ink-800 text-ink-400" aria-label="Back" title="Back">
              <Icon name="chevron-left" size={18} />
            </button>
          )}
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
              type="button"
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

          <div className="flex items-center gap-0.5 ml-auto">
            {onToggleTerminal && (
              <button type="button" onClick={onToggleTerminal} className={`p-1.5 rounded-md ${showTerminal ? 'text-amber-500 bg-amber-500/10' : 'text-ink-400 hover:bg-ink-800'}`} aria-label="Terminal" title="Terminal">
                <Icon name="terminal" size={14} />
              </button>
            )}
            {onTogglePreview && (
              <button type="button" onClick={onTogglePreview} className={`p-1.5 rounded-md ${previewOpen ? 'text-amber-500 bg-amber-500/10' : 'text-ink-400 hover:bg-ink-800'}`} aria-label="Preview" title="Preview">
                <span className="text-xs leading-none">◧</span>
              </button>
            )}
            {onToggleGit && (
              <button type="button" onClick={onToggleGit} className={`p-1.5 rounded-md ${gitOpen ? 'text-amber-500 bg-amber-500/10' : 'text-ink-400 hover:bg-ink-800'}`} aria-label="Git" title="Git">
                <Icon name="git" size={14} />
              </button>
            )}
            {onToggleFiles && (
              <button type="button" onClick={onToggleFiles} className={`p-1.5 rounded-md ${filesOpen ? 'text-amber-500 bg-amber-500/10' : 'text-ink-400 hover:bg-ink-800'}`} aria-label="Files" title="Files">
                <Icon name="file" size={14} />
              </button>
            )}
            {onToggleExtensions && (
              <button type="button" onClick={onToggleExtensions} className={`p-1.5 rounded-md ${extensionsOpen ? 'text-amber-500 bg-amber-500/10' : 'text-ink-400 hover:bg-ink-800'}`} aria-label="Extensions" title="Extensions">
                <Icon name="puzzle" size={14} />
              </button>
            )}
            {onSessionActions && (
              <button type="button" onClick={onSessionActions} className="p-1.5 rounded-md text-ink-400 hover:bg-ink-800" aria-label="Session actions" title="Session actions">
                <Icon name="more" size={14} />
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="conversation-header shrink-0">
      <div className="conversation-header-copy">
        <div className="conversation-header-row">
          {onToggleSidebar && !showSidebar && (
            <button type="button" onClick={onToggleSidebar} className="conversation-toolbar-pill" aria-label="Show sidebar" title="Show sidebar (⌘B)">
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
              type="button"
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
              <span title={`${stats.contextUsage.tokens.toLocaleString()} / ${stats.contextUsage.contextWindow?.toLocaleString() ?? "unknown"} tokens`}>
                {stats.contextUsage.percent.toFixed(0)}%
              </span>
            )}
            <span>${stats.cost?.toFixed(2) ?? '—'}</span>
          </div>
        )}

        {onSessionActions && (
          <button type="button" onClick={onSessionActions} className="conversation-toolbar-pill" aria-label="Session actions" title="Export, clone, compact…">
            <Icon name="more" size={14} />
          </button>
        )}

        {onToggleTerminal && (
          <button
            type="button"
            onClick={onToggleTerminal}
            className={`conversation-toolbar-pill ${showTerminal ? "conversation-toolbar-pill-active" : ""}`}
            aria-label="Toggle terminal"
            title="Terminal"
          >
            <Icon name="terminal" size={14} />
          </button>
        )}
        {onToggleFiles && (
          <button
            type="button"
            onClick={onToggleFiles}
            className={`conversation-toolbar-pill ${filesOpen ? "conversation-toolbar-pill-active" : ""}`}
            aria-label="Toggle files"
            title="Files"
          >
            <Icon name="file" size={14} />
          </button>
        )}
        {onTogglePreview && (
          <button
            type="button"
            onClick={onTogglePreview}
            className={`conversation-toolbar-pill ${previewOpen ? "conversation-toolbar-pill-active" : ""}`}
            aria-label="Toggle preview"
            title="Preview"
          >
            <span className="text-xs leading-none">◧</span>
          </button>
        )}
        {onToggleGit && (
          <button
            type="button"
            onClick={onToggleGit}
            className={`conversation-toolbar-pill ${gitOpen ? "conversation-toolbar-pill-active" : ""}`}
            aria-label="Toggle git"
            title="Git"
          >
            <Icon name="git" size={14} />
          </button>
        )}
        {onToggleExtensions && (
          <button
            type="button"
            onClick={onToggleExtensions}
            className={`conversation-toolbar-pill ${extensionsOpen ? "conversation-toolbar-pill-active" : ""}`}
            aria-label="Toggle extensions"
            title="Extensions"
          >
            <Icon name="puzzle" size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
