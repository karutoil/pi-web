/**
 * SelectionChips — renders picked elements as chips above the chat input.
 *
 * Mirrors the FileMentionCompleter flow but for @element mentions.
 */

import { usePreviewStore } from "../../hooks/usePreviewStore";
import { buildElementToken } from "../../lib/elementMention";

interface SelectionChipsProps {
  /** Called when user clicks on a chip — should highlight element in iframe */
  onChipClick?: (selector: string) => void;
  /** Called when user removes a chip */
  onRemove?: (token: string) => void;
}

export function SelectionChips({ onChipClick, onRemove }: SelectionChipsProps) {
  const pickedElements = usePreviewStore((s) => s.pickedElements);
  const removePickedElement = usePreviewStore((s) => s.removePickedElement);

  if (pickedElements.length === 0) return null;

  return (
    <div className="flex gap-1.5 px-4 pt-2 pb-1 flex-wrap max-w-3xl mx-auto w-full">
      {pickedElements.map((el) => {
        const token = buildElementToken(el);
        return (
          <div
            key={el.token}
            className="flex items-center gap-1 px-2 py-1 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400 font-mono text-[0.65rem] group cursor-pointer hover:bg-amber-500/15 transition-theme"
            title={`${el.tagName} — ${el.selector.slice(0, 60)}`}
            onClick={() => onChipClick?.(el.selector)}
          >
            <span className="text-amber-500/70 text-[0.55rem] font-semibold">&lt;{el.tagName}&gt;</span>
            <span className="text-amber-400/50 truncate max-w-[120px]">
              {el.selector.replace(/^html>body>/, "").slice(0, 30)}
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                removePickedElement(el.token);
                onRemove?.(el.token);
              }}
              className="text-amber-500/40 hover:text-red-400 transition-theme ml-0.5"
              aria-label={`Remove ${el.tagName}`}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
