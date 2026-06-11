import { useState, useEffect, useMemo, useRef, type RefObject } from "react";
import type { CommandInfo } from "@pi-web/shared";

interface Props {
  commands: CommandInfo[];
  filter: string; // text after "/"
  onSelect: (name: string) => void;
  onClose: () => void;
  anchorRef?: RefObject<HTMLElement | null>;
}

export function CommandCompleter({ commands, filter, onSelect, onClose, anchorRef }: Props) {
  const [activeIdx, setActiveIdx] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, width: 0, bottom: 0, maxHeight: 320 });

  const filtered = useMemo(() => {
    if (!filter) return commands.slice(0, 12);
    const q = filter.toLowerCase();
    return commands
      .filter(c => c.name.toLowerCase().includes(q) || c.description?.toLowerCase().includes(q))
      .slice(0, 12);
  }, [commands, filter]);

  useEffect(() => { setActiveIdx(0); }, [filter]);

  // Position the popup above the anchor using fixed positioning
  useEffect(() => {
    const gap = 8;
    const minTop = 12;
    const updatePosition = () => {
      const anchor = anchorRef?.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const availableHeight = Math.max(140, rect.top - gap - minTop);
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
  }, [anchorRef]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, Math.max(filtered.length - 1, 0))); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)); }
      else if (e.key === "Enter" && filtered[activeIdx]) { e.preventDefault(); onSelect(filtered[activeIdx].name); onClose(); }
      else if (e.key === "Escape") { onClose(); }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [filtered, activeIdx, onSelect, onClose]);

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  if (filtered.length === 0) {
    return (
      <div
        ref={panelRef}
        className="conversation-completer"
        style={{
          left: position.left,
          width: position.width,
          bottom: position.bottom,
          maxHeight: position.maxHeight,
        }}
      >
        <div className="conversation-completer-header">
          <span>Commands</span>
          <button type="button" onClick={onClose} className="conversation-completer-dismiss">Dismiss</button>
        </div>
        <div className="conversation-completer-empty">No matching commands</div>
      </div>
    );
  }

  const sourceIcons: Record<string, string> = {
    skill: "SK",
    prompt: "PR",
    extension: "EX",
  };

  return (
    <div
      ref={panelRef}
      className="conversation-completer"
      style={{
        left: position.left,
        width: position.width,
        bottom: position.bottom,
        maxHeight: position.maxHeight,
      }}
    >
      <div className="conversation-completer-header">
        <span>Commands {filter ? `matching "${filter}"` : ""}</span>
      </div>
      {filtered.map((c, i) => (
        <button
          type="button"
          key={c.name}
          onClick={() => onSelect(c.name)}
          className="conversation-completer-item"
          data-active={i === activeIdx}
        >
          <span className="conversation-completer-icon">{sourceIcons[c.source] || "•"}</span>
          <div className="min-w-0 flex-1">
            <div className="conversation-completer-title">/{c.name}</div>
            {c.description && (
              <div className="conversation-completer-meta">{c.description}</div>
            )}
          </div>
        </button>
      ))}
    </div>
  );
}
