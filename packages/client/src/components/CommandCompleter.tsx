import { useMemo } from "react";
import type { CommandInfo } from "@pi-web/shared";

interface Props {
  commands: CommandInfo[];
  filter: string; // text after "/"
  onSelect: (name: string) => void;
  onClose: () => void;
}

export function CommandCompleter({ commands, filter, onSelect, onClose }: Props) {
  const filtered = useMemo(() => {
    if (!filter) return commands.slice(0, 12);
    const q = filter.toLowerCase();
    return commands
      .filter(c => c.name.toLowerCase().includes(q) || c.description?.toLowerCase().includes(q))
      .slice(0, 12);
  }, [commands, filter]);

  if (filtered.length === 0) {
    return (
      <div className="absolute bottom-full left-0 mb-2 bg-ink-900 border border-ink-700 rounded-lg shadow-lg py-2 px-3 z-50 w-[calc(100vw-2rem)] md:w-80">
        <p className="text-ink-500 text-xs font-mono">No matching commands</p>
        <button onClick={onClose} className="text-ink-400 text-xs mt-1 hover:text-ink-400">Dismiss</button>
      </div>
    );
  }

  const sourceIcons: Record<string, string> = {
    skill: "⚡",
    prompt: "📄", 
    extension: "🔌",
  };

  return (
    <div className="absolute bottom-full left-0 mb-2 bg-ink-900 border border-ink-700 rounded-lg shadow-lg py-1 z-50 w-[calc(100vw-2rem)] md:w-80 max-h-64 overflow-y-auto custom-scrollbar">
      <div className="px-3 py-1.5 text-ink-500 text-[0.65rem] font-mono uppercase tracking-wider border-b border-ink-800">
        Commands {filter ? `matching "${filter}"` : ""}
      </div>
      {filtered.map(c => (
        <button
          key={c.name}
          onClick={() => onSelect(c.name)}
          className="w-full text-left px-3 py-2 hover:bg-ink-850 transition-theme flex items-start gap-2 min-h-[44px]"
        >
          <span className="text-xs shrink-0 mt-0.5">{sourceIcons[c.source] || "•"}</span>
          <div className="min-w-0">
            <div className="text-ink-200 text-xs font-mono font-medium">/{c.name}</div>
            {c.description && (
              <div className="text-ink-500 text-[0.65rem] truncate">{c.description}</div>
            )}
          </div>
        </button>
      ))}
    </div>
  );
}
