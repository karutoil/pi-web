import { Icon } from "./Icon";
import { parseSymbols, type SymbolOutline } from "../lib/symbolParser";

interface Props {
  content: string;
  collapsed: boolean;
  onToggle: () => void;
  onSelect: (symbol: SymbolOutline) => void;
}

export function OutlineSection({ content, collapsed, onToggle, onSelect }: Props) {
  const symbols = parseSymbols(content);
  if (!content || symbols.length === 0) return null;
  return (
    <div className="border-t border-ink-800 flex flex-col min-h-0 bg-ink-950/30">
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center gap-1.5 px-2 py-1.5 text-xs font-medium text-ink-300 hover:text-ink-100 hover:bg-ink-800/40"
      >
        <Icon name="hash" size={10} />
        <span className="flex-1 text-left">Outline</span>
        <Icon name={collapsed ? "chevron-right" : "chevron-down"} size={10} />
      </button>
      {!collapsed && (
        <div className="flex-1 min-h-0 overflow-auto px-1.5 pb-1.5 space-y-0.5">
          {symbols.map((s, i) => (
            <button
              key={`${s.name}-${i}`}
              type="button"
              onClick={() => onSelect(s)}
              className="w-full flex items-center gap-1.5 text-xs text-ink-300 hover:text-ink-100 hover:bg-ink-800/60 rounded px-1.5 py-1 text-left"
              title={`${s.kind} · line ${s.line}`}
            >
              <span className="text-amber-500 text-[0.6rem] w-3 text-center">{s.kind[0].toUpperCase()}</span>
              <span className="truncate flex-1">{s.name}</span>
              <span className="text-ink-600 text-[0.6rem]">{s.line}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
