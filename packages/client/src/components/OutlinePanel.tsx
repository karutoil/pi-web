import { useActiveEditorStore } from "../hooks/useActiveEditorStore";
import { parseSymbols } from "../lib/symbolParser";

interface Props {
  visible: boolean;
  projectId: string;
  onClose: () => void;
}

export function OutlinePanel({ visible, onClose }: Props) {
  const { filePath, content } = useActiveEditorStore();
  const symbols = content ? parseSymbols(content) : [];

  if (!visible) return null;
  return (
    <div className="flex flex-col h-full">
      <div className="files-panel-header shrink-0">
        <div className="files-panel-title-row">
          <span className="files-panel-title">Outline</span>
          <button type="button" onClick={onClose} className="files-panel-icon-button" aria-label="Close">×</button>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-2">
        {!filePath && (
          <div className="text-xs text-ink-500">Open a file in the editor to see its symbol outline.</div>
        )}
        {filePath && symbols.length === 0 && (
          <div className="text-xs text-ink-500">No symbols found.</div>
        )}
        <div className="space-y-0.5">
          {symbols.map((s, i) => (
            <div key={`${s.name}-${i}`} className="flex items-center gap-1.5 text-xs text-ink-300 hover:text-ink-100 hover:bg-ink-800/60 rounded px-1.5 py-1" title={`${s.kind} · line ${s.line}`}>
              <span className="text-amber-500 text-[0.65rem]">{s.kind[0].toUpperCase()}</span>
              <span className="truncate">{s.name}</span>
              <span className="ml-auto text-ink-600 text-[0.6rem]">{s.line}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
