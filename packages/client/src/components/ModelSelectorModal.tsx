import { useState, useEffect, useRef, useMemo } from "react";
import type { ModelInfo } from "@pi-web/shared";
import type { WSBridge } from "../lib/types";
import { Icon } from "./Icon";

interface Props {
  ws: WSBridge;
  open: boolean;
  onClose: () => void;
}

export function ModelSelectorModal({ ws, open, onClose }: Props) {
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setSearch("");
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const filtered = useMemo(() => {
    if (!search) return ws.models;
    const q = search.toLowerCase();
    return ws.models.filter(m =>
      m.name.toLowerCase().includes(q) ||
      m.provider.toLowerCase().includes(q) ||
      m.id.toLowerCase().includes(q)
    );
  }, [ws.models, search]);

  const currentModelId = ws.state?.model;
  const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh"];

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    if (open) window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] animate-fade-in-up" onClick={onClose}>
      {/* Backdrop */}
      <div className="absolute inset-0 bg-ink-950/70 backdrop-blur-sm" />

      {/* Modal */}
      <div
        className="relative bg-ink-900 border border-ink-700 rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden animate-fade-in-up"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-4 pt-4 pb-2">
          <Icon name="pi-logo" size={18} className="text-amber-500 opacity-70" />
          <h3 className="text-ink-200 font-medium text-sm flex-1">Select Model</h3>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-ink-500 hover:text-ink-300 hover:bg-ink-800/50 transition-theme"
            aria-label="Close"
          >
            <Icon name="close" size={16} />
          </button>
        </div>

        {/* Search */}
        <div className="px-4 pb-2">
          <input
            ref={inputRef}
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Filter by name, provider, or id..."
            className="w-full bg-ink-950 border border-ink-700 rounded-xl px-3 py-2.5 text-ink-100 text-sm font-mono placeholder-ink-500 outline-none focus:border-amber-500/60 transition-theme"
            aria-label="Search models"
          />
        </div>

        {/* Thinking level pills */}
        <div className="px-4 pb-2 flex flex-wrap gap-1.5">
          <span className="text-ink-600 text-[0.6rem] font-mono uppercase tracking-wider self-center mr-1">Think</span>
          {thinkingLevels.map(l => (
            <button
              key={l}
              onClick={() => ws.send({ type: "set_thinking", level: l })}
              className={`px-2.5 py-1 text-xs font-mono rounded-lg transition-theme ${
                ws.state?.thinkingLevel === l
                  ? "bg-amber-600/25 text-amber-400 border border-amber-500/30"
                  : "bg-ink-850 text-ink-500 border border-ink-800 hover:text-ink-300 hover:border-ink-700"
              }`}
            >
              {l}
            </button>
          ))}
        </div>

        {/* Divider */}
        <div className="border-t border-ink-800" />

        {/* Model list */}
        <div ref={listRef} className="max-h-[50vh] overflow-y-auto custom-scrollbar">
          {filtered.length === 0 && (
            <div className="px-4 py-8 text-center text-ink-500 text-sm font-mono">
              No models match "<span className="text-ink-300">{search}</span>"
            </div>
          )}
          {filtered.map(m => {
            const active = currentModelId === m.id;
            return (
              <button
                key={m.id}
                onClick={() => {
                  ws.send({ type: "set_model", provider: m.provider, modelId: m.id });
                  onClose();
                }}
                className={`w-full text-left px-4 py-3 hover:bg-ink-850 transition-theme flex items-center gap-3 ${
                  active ? "bg-ink-850/60" : ""
                }`}
              >
                {/* Active indicator */}
                <span className={`w-2 h-2 rounded-full shrink-0 ${active ? "bg-amber-500" : "bg-ink-700"}`} />

                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className={`text-sm font-medium truncate ${active ? "text-amber-400" : "text-ink-200"}`}>
                      {m.name}
                    </span>
                    <span className="text-ink-600 text-[0.65rem] font-mono shrink-0">
                      {m.contextWindow >= 1000 ? `${(m.contextWindow / 1000).toFixed(0)}k` : m.contextWindow} ctx
                    </span>
                  </div>
                  <div className="text-ink-500 text-xs font-mono mt-0.5">
                    {m.provider}{m.reasoning ? " · reasoning" : ""}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        {/* Footer */}
        <div className="border-t border-ink-800 px-4 py-2.5 flex items-center justify-between text-ink-600 text-[0.65rem] font-mono">
          <span>{ws.models.length} models</span>
          <span>↻ cycles model · Tab</span>
        </div>
      </div>
    </div>
  );
}
