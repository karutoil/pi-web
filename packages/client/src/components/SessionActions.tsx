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
  // Escape key to close
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
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh] bg-black/60" onClick={onClose}>
      <div className="w-full max-w-xs bg-ink-900 border border-ink-700 rounded-xl shadow-2xl overflow-hidden mobile-safe-top max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-ink-800 text-ink-200 text-sm font-medium">Session Actions</div>
        <div className="py-1">
          {actions.map(a => (
            <button key={a.label}
              onClick={() => { a.action(); onClose(); }}
              className="w-full text-left px-4 py-2.5 text-sm text-ink-300 hover:bg-ink-800 hover:text-ink-100 flex items-center gap-3 transition-theme">
              <Icon name={a.icon} size={14} className="text-ink-500 shrink-0" />
              <span>{a.label}</span>
            </button>
          ))}
        </div>
        <div className="px-4 py-2 border-t border-ink-800 text-xs text-ink-500 hidden sm:block">Esc to close</div>
      </div>
    </div>
  );
}
