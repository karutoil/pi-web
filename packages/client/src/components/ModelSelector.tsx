import { useState, useRef, useEffect } from "react";
import type { ModelInfo } from "@pi-web/shared";

interface ModelSelectorProps {
  models: ModelInfo[];
  currentModel: string | null;
  thinkingLevel: string;
  onSelect: (provider: string, modelId: string) => void;
  onCycleModel: () => void;
  onCycleThinking: () => void;
  onClose: () => void;
}

export function ModelSelector({ models, currentModel, thinkingLevel, onSelect, onCycleModel, onCycleThinking, onClose }: ModelSelectorProps) {
  const [filter, setFilter] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = models.filter(m =>
    m.name.toLowerCase().includes(filter.toLowerCase()) ||
    m.provider.toLowerCase().includes(filter.toLowerCase()) ||
    m.id.toLowerCase().includes(filter.toLowerCase())
  );

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { setSelectedIndex(0); }, [filter]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSelectedIndex(i => Math.min(i + 1, filtered.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSelectedIndex(i => Math.max(i - 1, 0)); }
    else if (e.key === "Enter" && filtered[selectedIndex]) {
      onSelect(filtered[selectedIndex].provider, filtered[selectedIndex].id);
      onClose();
    }
    else if (e.key === "Escape") onClose();
    else if (e.key === "Tab" && !e.shiftKey) { e.preventDefault(); onCycleModel(); onClose(); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/60" onClick={onClose}>
      <div className="w-full max-w-md bg-ink-900 border border-ink-700 rounded-xl shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="p-3 border-b border-ink-800">
          <input
            ref={inputRef}
            type="text"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search models..."
            className="w-full bg-ink-800 text-ink-100 px-3 py-2 rounded-lg border border-ink-700 focus:border-accent-500 focus:outline-none text-sm"
          />
        </div>
        <div className="max-h-64 overflow-y-auto">
          {filtered.length === 0 && (
            <div className="px-4 py-6 text-center text-ink-500 text-sm">No models found</div>
          )}
          {filtered.map((m, i) => (
            <button
              key={`${m.provider}/${m.id}`}
              onClick={() => { onSelect(m.provider, m.id); onClose(); }}
              className={`w-full text-left px-4 py-2.5 text-sm flex items-center gap-3 transition-theme
                ${i === selectedIndex ? "bg-ink-800" : "hover:bg-ink-850"}
                ${currentModel === m.id ? "text-accent-400" : "text-ink-200"}`}
            >
              <span className="flex-1 truncate">
                <span className="font-medium">{m.name}</span>
                <span className="text-ink-500 ml-2 text-xs">{m.provider}</span>
              </span>
              {m.reasoning && <span className="text-xs text-ink-500">💭</span>}
              {currentModel === m.id && <span className="text-accent-400 text-xs">✓</span>}
            </button>
          ))}
        </div>
        <div className="px-4 py-2 border-t border-ink-800 flex items-center gap-4 text-xs text-ink-500">
          <span>Tab: cycle</span>
          <span>Enter: select</span>
          <span>Esc: close</span>
        </div>
      </div>
    </div>
  );
}
