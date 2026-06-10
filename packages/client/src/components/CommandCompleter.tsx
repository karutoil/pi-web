import { useState, useEffect, useMemo } from "react";
import type { CommandInfo } from "@pi-web/shared";

interface Props {
  commands: CommandInfo[];
  filter: string; // text after "/"
  onSelect: (name: string) => void;
  onClose: () => void;
}

export function CommandCompleter({ commands, filter, onSelect, onClose }: Props) {
  const [activeIdx, setActiveIdx] = useState(0);

  const filtered = useMemo(() => {
    if (!filter) return commands.slice(0, 12);
    const q = filter.toLowerCase();
    return commands
      .filter(c => c.name.toLowerCase().includes(q) || c.description?.toLowerCase().includes(q))
      .slice(0, 12);
  }, [commands, filter]);

  useEffect(() => { setActiveIdx(0); }, [filter]);

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

  if (filtered.length === 0) {
    return (
      <div className="conversation-completer">
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
    <div className="conversation-completer">
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
