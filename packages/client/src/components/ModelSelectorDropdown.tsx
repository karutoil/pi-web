import { useState, useEffect, useRef, useMemo, type RefObject } from "react";
import type { ModelInfo } from "@pi-web/shared";
import type { WSBridge } from "../lib/types";
import { Icon } from "./Icon";

interface Props {
  ws: WSBridge;
  open: boolean;
  onClose: () => void;
  anchorRef?: RefObject<HTMLElement | null>;
}

export function ModelSelectorDropdown({ ws, open, onClose, anchorRef }: Props) {
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, width: 0, bottom: 0, maxHeight: 0 });

  useEffect(() => {
    if (open) {
      setSearch("");
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const gap = 8;
    const minTop = 12;
    const updatePosition = () => {
      const anchor = anchorRef?.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const availableHeight = Math.max(140, (rect.top - gap - minTop) / 2);
      setPosition({
        left: rect.left,
        width: rect.width,
        bottom: window.innerHeight - rect.top + gap,
        maxHeight: availableHeight,
      });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, anchorRef]);

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
  const activeModel = ws.models.find(m => m.id === currentModelId);
  const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh"];

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    if (open) window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={panelRef}
      className="conversation-model-dropdown animate-slide-down"
      style={{
        left: position.left,
        width: position.width,
        bottom: position.bottom,
        maxHeight: position.maxHeight,
      }}
      onClick={e => e.stopPropagation()}
    >
      <div className="conversation-model-header">
        <div className="conversation-model-header-copy">
          <div className="conversation-model-kicker">Model registry</div>
          <div className="conversation-model-title">Select model</div>
        </div>
        <div className="conversation-model-count">{ws.models.length} available</div>
        <button
          type="button"
          className="conversation-model-close"
          onClick={onClose}
          aria-label="Close model selector"
        >
          <Icon name="close" size={12} />
        </button>
      </div>

      <div className="conversation-model-search">
        <input
          ref={inputRef}
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Filter models..."
          className="conversation-input conversation-model-input"
          aria-label="Search models"
        />
      </div>

      <div className="conversation-model-thinking">
        <span className="conversation-model-section-label">Think</span>
        {thinkingLevels.map(l => (
          <button
            type="button"
            key={l}
            onClick={() => ws.setThinkingLevel(l)}
            className={ws.state?.thinkingLevel === l ? "active" : ""}
          >
            {l}
          </button>
        ))}
      </div>

      <div className="conversation-model-list" role="listbox" aria-label="Models">
        {filtered.length === 0 && (
          <div className="conversation-model-empty">
            No models match "<span>{search}</span>"
          </div>
        )}
        {filtered.map(m => {
          const active = currentModelId === m.id;
          return (
            <button
              type="button"
              key={m.id}
              onClick={() => {
                ws.setModel(m.provider, m.id);
                onClose();
              }}
              className={`conversation-model-row ${active ? "active" : ""}`}
              role="option"
              aria-selected={active}
            >
              <span className="conversation-model-dot" />
              <div className="conversation-model-row-copy">
                <div className="conversation-model-row-head">
                  <span className={active ? "active" : ""}>{m.name}</span>
                  <span>{m.contextWindow >= 1000 ? `${(m.contextWindow / 1000).toFixed(0)}k` : m.contextWindow} ctx</span>
                </div>
                <div className="conversation-model-row-meta">
                  <span>{m.provider}</span>
                  {m.reasoning && <span>reasoning</span>}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <div className="conversation-model-footer">
        <span>{activeModel?.name || "No active model"}</span>
        <span>Tab cycles · Esc closes</span>
      </div>
    </div>
  );
}
