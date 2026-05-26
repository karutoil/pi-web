import { useState, useEffect } from "react";
import type { ModelInfo, SessionStats } from "@pi-web/shared";
import type { WSBridge } from "../lib/types";
import { Icon } from "./Icon";
import { useIsMobile } from "../hooks/useIsMobile";
import { ModelSelectorModal } from "./ModelSelectorModal";

interface Props {
  ws: WSBridge;
  cwd: string;
  sessionName: string | null;
  onToggleGit?: () => void;
  showGit?: boolean;
  onToggleSidebar?: () => void;
  showSidebar?: boolean;
  onSessionActions?: () => void;
}

export function ChatHeader({ ws, cwd, sessionName, onToggleGit, showGit, onToggleSidebar, showSidebar, onSessionActions }: Props) {
  const [modelOpen, setModelOpen] = useState(false);
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

  const currentModel = ws.models.find(m => m.id === ws.state?.model);
  const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh"];
  const stats = ws.sessionStats;

  const handleSaveName = () => {
    const trimmed = nameInput.trim();
    if (trimmed) ws.send({ type: "set_session_name", name: trimmed });
    setEditingName(false);
  };

  return (
    <>
      <div className="flex items-center gap-1.5 md:gap-2 px-3 md:px-4 py-2.5 border-b border-ink-800 bg-ink-900/30 shrink-0 mobile-safe-top overflow-hidden">
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
              className="bg-ink-900 border border-ink-700 rounded px-2 py-0.5 text-ink-100 text-sm font-medium outline-none focus:border-amber-500 w-24 md:w-32 lg:w-48"
              autoFocus
            />
          ) : (
            <button
              onClick={() => { setNameInput(sessionName || ""); setEditingName(true); }}
              className="text-sm font-medium text-ink-200 truncate hover:text-amber-500 transition-theme max-w-[80px] md:max-w-[120px] lg:max-w-[200px]"
              title="Click to rename"
              aria-label="Rename session"
            >
              {sessionName || "Chat"}
            </button>
          )}
          <span className="text-ink-500 text-xs font-mono truncate hidden sm:inline">{cwd}</span>
        </div>

        {/* Connection & streaming indicators */}
        <div className="flex items-center gap-1 shrink-0">
          {!ws.isConnected && (
            <span className="flex items-center gap-1 text-rose-500 text-xs font-mono">
              <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
              <span className="hidden md:inline">Offline</span>
            </span>
          )}
          {ws.isStreaming && (
            <span className="flex items-center gap-1 text-amber-500 text-xs font-mono">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
              <span className="hidden md:inline">Live</span>
            </span>
          )}

          {stats && (
            <div className="hidden md:flex items-center gap-2 text-ink-500 text-xs font-mono">
              {stats.contextUsage && (
                <span title={`${stats.contextUsage.tokens.toLocaleString()} / ${stats.contextUsage.contextWindow.toLocaleString()} tokens`}>
                  {stats.contextUsage.percent.toFixed(0)}%
                </span>
              )}
              <span>${stats.cost.toFixed(2)}</span>
            </div>
          )}

          {onToggleSidebar && !showSidebar && !isMobile && (
            <button onClick={onToggleSidebar} className="icon-btn" aria-label="Show sidebar" title="Show sidebar (⌘B)">
              <Icon name="chevron-right" size={14} />
            </button>
          )}

          {onSessionActions && (
            <button onClick={onSessionActions} className="icon-btn" aria-label="Session actions" title="Export, clone, compact...">
              <Icon name="more" size={14} />
            </button>
          )}

          {onToggleGit && (
            <button onClick={onToggleGit} className={`icon-btn ${showGit ? "icon-btn-active" : ""}`} aria-label="Toggle git panel" title="Source Control">
              <Icon name="git" size={14} />
            </button>
          )}

          {/* Thinking level — desktop only */}
          {!isMobile && (
            <button
              onClick={() => {
                const cur = ws.state?.thinkingLevel || "off";
                const idx = thinkingLevels.indexOf(cur);
                const next = thinkingLevels[(idx + 1) % thinkingLevels.length];
                ws.send({ type: "set_thinking", level: next });
              }}
              className="icon-btn"
              aria-label="Cycle thinking level"
              title="Cycle thinking level"
            >
              {ws.state?.thinkingLevel || "off"}
            </button>
          )}

          {/* Model selector — opens full modal */}
          <div className="flex items-center gap-0.5">
            <button
              onClick={() => setModelOpen(true)}
              className="icon-btn max-w-[100px] md:max-w-[160px] truncate text-xs font-mono"
              aria-label="Select model"
            >
              {currentModel?.name || ws.state?.model || (ws.models.length === 0 && ws.isConnected ? "Loading…" : "Model")}
            </button>
            <button
              onClick={() => ws.cycleModel()}
              className="icon-btn"
              title="Cycle to next model (Tab)"
              aria-label="Cycle model"
            >↻</button>
          </div>
        </div>
      </div>

      {/* Modal overlay — renders outside header flow */}
      <ModelSelectorModal ws={ws} open={modelOpen} onClose={() => setModelOpen(false)} />
    </>
  );
}
