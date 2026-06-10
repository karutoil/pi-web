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
    <div className="modal-stage modal-stage--top animate-fade-in-up" onClick={onClose}>
      <div className="modal-backdrop" />

      <div
        className="modal-card modal-card--wide"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="modal-header">
          <Icon name="pi-logo" size={18} className="modal-header-icon" />
          <h3 className="modal-title">Select Model</h3>
          <button
            onClick={onClose}
            className="modal-close"
            aria-label="Close"
          >
            <Icon name="close" size={16} />
          </button>
        </div>

        {/* Search */}
        <div className="modal-body modal-body--compact">
          <input
            ref={inputRef}
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Filter by name, provider, or id..."
            className="modal-field"
            aria-label="Search models"
          />
          </div>

        {/* Thinking level pills */}
        <div className="modal-body modal-body--compact">
          <div className="modal-tag-row">
            <span className="text-ink-600 text-[0.6rem] font-mono uppercase tracking-wider self-center">Think</span>
            {thinkingLevels.map(l => (
              <button
                key={l}
                onClick={() => ws.send({ type: "set_thinking", level: l })}
                className={`modal-tag ${ws.state?.thinkingLevel === l ? "modal-tag--active" : ""}`}
              >
                {l}
              </button>
            ))}
          </div>
        </div>

        {/* Divider */}
        <div className="border-t border-ink-800" />

        {/* Model list */}
        <div ref={listRef} className="modal-list custom-scrollbar">
          {filtered.length === 0 && (
            <div className="modal-empty">
              <strong>No matches</strong>
              <span>No models match "<span className="text-ink-300">{search}</span>"</span>
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
                className={`modal-model-row ${active ? "modal-model-row--active" : ""}`}
              >
                <span className="modal-model-dot" />

                <div className="modal-model-copy">
                  <div className="modal-model-name">
                    {m.name}
                  </div>
                  <div className="modal-model-meta">
                    {m.provider}{m.reasoning ? " · reasoning" : ""}
                  </div>
                </div>
                <span className="modal-model-context">
                  {m.contextWindow >= 1000 ? `${(m.contextWindow / 1000).toFixed(0)}k` : m.contextWindow} ctx
                </span>
              </button>
            );
          })}
        </div>

        <div className="modal-footer-meta">
          <span>{ws.models.length} models</span>
          <span>↻ cycles model · Tab</span>
        </div>
      </div>
    </div>
  );
}
