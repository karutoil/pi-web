import { useEffect } from "react";
import { Icon } from "./Icon";

interface SessionActionsProps {
  onCompact: (customInstructions?: string) => void;
  onExportHtml: () => void;
  onClone: () => void;
  onSetAutoCompaction: (enabled: boolean) => void;
  onClose: () => void;
}

export function SessionActions({ onCompact, onExportHtml, onClone, onSetAutoCompaction, onClose }: SessionActionsProps) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const actions = [
    { label: "Compact context", icon: "compress" as const, action: () => onCompact() },
    { label: "Compact (custom)...", icon: "compress" as const, action: () => { const instructions = prompt("Custom compaction instructions:") || undefined; onCompact(instructions); } },
    { label: "Enable auto-compaction", icon: "auto-compact" as const, action: () => onSetAutoCompaction(true) },
    { label: "Disable auto-compaction", icon: "auto-compact" as const, action: () => onSetAutoCompaction(false) },
    { label: "Export HTML", icon: "export" as const, action: onExportHtml },
    { label: "Clone session", icon: "clone" as const, action: onClone },
  ];

  return (
    <div className="session-actions-backdrop" onClick={onClose}>
      <div className="session-actions-card" onClick={e => e.stopPropagation()}>
        <div className="session-actions-title">Session Actions</div>
        <div>
          {actions.map(a => (
            <button
              type="button"
              key={a.label}
              onClick={() => { a.action(); onClose(); }}
              className="session-actions-row"
            >
              <Icon name={a.icon} size={14} className="shrink-0" />
              <span>{a.label}</span>
            </button>
          ))}
        </div>
        <div className="session-actions-hint">Esc to close</div>
      </div>
    </div>
  );
}
