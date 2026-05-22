import { useState, useRef, useEffect, useMemo } from "react";
import type { ModelInfo, SessionStats } from "@pi-web/shared";
import type { WSBridge } from "../lib/types";
import { Icon } from "./Icon";

interface Props {
  ws: WSBridge;
  cwd: string;
  sessionName: string | null;
  onToggleGit?: () => void;
  showGit?: boolean;
}

export function ChatHeader({ ws, cwd, sessionName, onToggleGit, showGit }: Props) {
  const [modelOpen, setModelOpen] = useState(false);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(sessionName || "");
  const modelRef = useRef<HTMLDivElement>(null);
  const thinkingRef = useRef<HTMLDivElement>(null);

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

  // Close dropdowns on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (modelRef.current && !modelRef.current.contains(e.target as Node)) setModelOpen(false);
      if (thinkingRef.current && !thinkingRef.current.contains(e.target as Node)) setThinkingOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const [modelSearch, setModelSearch] = useState("");

  const filteredModels = useMemo(() => {
    if (!modelSearch) return ws.models;
    const q = modelSearch.toLowerCase();
    return ws.models.filter(m =>
      m.name.toLowerCase().includes(q) ||
      m.provider.toLowerCase().includes(q) ||
      m.id.toLowerCase().includes(q)
    );
  }, [ws.models, modelSearch]);

  const currentModel = ws.models.find(m => m.id === ws.state?.model);
  const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh"];
  const stats = ws.sessionStats;

  const handleSaveName = () => {
    const trimmed = nameInput.trim();
    if (trimmed) ws.send({ type: "set_session_name", name: trimmed });
    setEditingName(false);
  };

  return (
    <div className="flex items-center gap-2 px-4 py-2.5 border-b border-ink-800 bg-ink-900/30 shrink-0 flex-wrap">
      {/* Logo + Session name */}
      <div className="flex-1 min-w-0 flex items-center gap-2">
        <img src="/pi-logo.svg" alt="" aria-hidden="true" className="w-4 h-4 shrink-0 opacity-60" />
        {editingName ? (
          <input
            value={nameInput}
            onChange={e => setNameInput(e.target.value)}
            onBlur={handleSaveName}
            onKeyDown={e => { if (e.key === "Enter") handleSaveName(); if (e.key === "Escape") setEditingName(false); }}
            className="bg-ink-900 border border-ink-700 rounded px-2 py-0.5 text-ink-100 text-sm font-medium outline-none focus:border-amber-500 w-48"
            autoFocus
          />
        ) : (
          <button
            onClick={() => { setNameInput(sessionName || ""); setEditingName(true); }}
            className="text-sm font-medium text-ink-200 truncate hover:text-amber-500 transition-theme max-w-[200px]"
            title="Click to rename"
            aria-label="Rename session"
          >
            {sessionName || "Chat"}
          </button>
        )}
        <span className="text-ink-600 text-xs font-mono truncate hidden sm:inline">{cwd}</span>
      </div>

      {/* Connection & streaming indicators */}
      <div className="flex items-center gap-2">
        {!ws.isConnected && (
          <span className="flex items-center gap-1 text-rose-500 text-xs font-mono">
            <span className="w-1.5 h-1.5 rounded-full bg-rose-500" /> Offline
          </span>
        )}
        {ws.isStreaming && (
          <span className="flex items-center gap-1 text-amber-500 text-xs font-mono">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" /> Live
          </span>
        )}

        {/* Stats */}
        {stats && (
          <div className="hidden md:flex items-center gap-2 text-ink-600 text-xs font-mono">
            {stats.contextUsage && (
              <span title={`${stats.contextUsage.tokens.toLocaleString()} / ${stats.contextUsage.contextWindow.toLocaleString()} tokens`}>
                {stats.contextUsage.percent.toFixed(0)}%
              </span>
            )}
            <span>${stats.cost.toFixed(2)}</span>
          </div>
        )}

        {/* Thinking level */}
        <div ref={thinkingRef} className="relative">

        {/* Git toggle */}
        {onToggleGit && (
          <button
            onClick={onToggleGit}
            className={`text-xs font-mono px-2 py-1 rounded border transition-theme ${
              showGit ? "bg-amber-600/20 border-amber-500/30 text-amber-500" : "bg-ink-850 border-ink-750 hover:border-ink-600 text-ink-400"
            }`}
            aria-label="Toggle git panel"
            title="Source Control"
          >
            <Icon name="git" size={14} />
          </button>
        )}

        <button
            onClick={() => { setThinkingOpen(o => !o); setModelOpen(false); }}
            className="text-xs font-mono px-2 py-1 rounded bg-ink-850 border border-ink-750 hover:border-ink-600 text-ink-400 transition-theme"
            aria-label="Thinking level"
          >
            {ws.state?.thinkingLevel || "off"}
          </button>
          {thinkingOpen && (
            <div className="absolute right-0 top-full mt-1 bg-ink-900 border border-ink-700 rounded-lg shadow-lg py-1 z-40 min-w-[100px]">
              {thinkingLevels.map(l => (
                <button
                  key={l}
                  onClick={() => { ws.send({ type: "set_thinking", level: l }); setThinkingOpen(false); }}
                  className={`w-full text-left px-3 py-1.5 text-xs font-mono hover:bg-ink-850 transition-theme ${
                    ws.state?.thinkingLevel === l ? "text-amber-500" : "text-ink-400"
                  }`}
                >
                  {l}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Model selector */}
        <div ref={modelRef} className="relative">
          <button
            onClick={() => { setModelOpen(o => !o); setThinkingOpen(false); }}
            className="text-xs font-mono px-2 py-1 rounded bg-ink-850 border border-ink-750 hover:border-ink-600 text-ink-300 transition-theme max-w-[160px] truncate"
            aria-label="Select model"
          >
            {currentModel?.name || ws.state?.model || (ws.models.length === 0 && ws.isConnected ? "Loading…" : "Model")}
          </button>
          {modelOpen && (
            <div className="absolute right-0 top-full mt-1 bg-ink-900 border border-ink-700 rounded-lg shadow-lg py-1 z-40 min-w-[240px]">
              {/* Search input */}
              <div className="px-2 py-1.5 border-b border-ink-800">
                <input
                  value={modelSearch}
                  onChange={e => setModelSearch(e.target.value)}
                  placeholder="Filter models..."
                  className="w-full bg-ink-850 border border-ink-700 rounded px-2 py-1 text-ink-200 text-xs font-mono placeholder-ink-600 outline-none focus:border-amber-500"
                  aria-label="Search models"
                  autoFocus
                  onKeyDown={e => e.stopPropagation()}
                />
              </div>
              <div className="max-h-56 overflow-y-auto custom-scrollbar">
              {filteredModels.length === 0 && (
                <div className="px-3 py-2 text-ink-600 text-xs">No models match "{modelSearch}"</div>
              )}
              {filteredModels.map(m => (
                <button
                  key={m.id}
                  onClick={() => {
                    ws.send({ type: "set_model", provider: m.provider, modelId: m.id });
                    setModelOpen(false);
                    setModelSearch("");
                  }}
                  className={`w-full text-left px-3 py-2 hover:bg-ink-850 transition-theme group ${
                    ws.state?.model === m.id ? "bg-ink-850" : ""
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className={`text-xs font-medium ${ws.state?.model === m.id ? "text-amber-500" : "text-ink-200"}`}>
                      {m.name}
                    </span>
                    <span className="text-ink-600 text-[0.65rem] font-mono hidden group-hover:inline">
                      {m.contextWindow >= 1000 ? `${(m.contextWindow / 1000).toFixed(0)}k` : m.contextWindow}
                    </span>
                  </div>
                  <div className="text-ink-600 text-[0.65rem] font-mono mt-0.5">
                    {m.provider} · {m.reasoning ? "reasoning" : "no reasoning"}
                  </div>
                </button>
              ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
