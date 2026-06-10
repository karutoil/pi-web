/**
 * SelectionChips — renders picked elements as chips above the chat input.
 *
 * Mirrors the FileMentionCompleter flow but for @element mentions.
 */

import { usePreviewStore } from "../../hooks/usePreviewStore";

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
    <div className="preview-selection-row">
      {pickedElements.map((el) => (
        <div
          key={el.token}
          className="preview-selection-chip"
          title={`${el.tagName} — ${el.selector.slice(0, 60)}`}
          onClick={() => onChipClick?.(el.selector)}
        >
          <span className="preview-selection-chip-tag">&lt;{el.tagName}&gt;</span>
          <span className="preview-selection-chip-path">
            {el.selector.replace(/^html>body>/, "").slice(0, 30)}
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              removePickedElement(el.token);
              onRemove?.(el.token);
            }}
            className="preview-selection-remove"
            aria-label={`Remove ${el.tagName}`}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
