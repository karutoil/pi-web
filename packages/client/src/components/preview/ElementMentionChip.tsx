/**
 * ElementMentionChip — renders an @element mention as a non-editable
 * chip inside the ChatInput, mirroring the @file mention pattern.
 *
 * Used when the user picks an element from the preview iframe.
 */

interface ElementMentionChipProps {
  token: string;
  tagName: string;
  onRemove: () => void;
  onClick: () => void;
}

export function ElementMentionChip({
  token,
  tagName,
  onRemove,
  onClick,
}: ElementMentionChipProps) {
  return (
    <span
      className="preview-mention-chip"
      title={`Selected element: ${token}`}
      onClick={onClick}
    >
      <span className="preview-mention-chip-tag">&lt;{tagName}&gt;</span>
      <span className="preview-mention-chip-token">{token.replace(/^@element:/, "").slice(0, 20)}</span>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        className="preview-mention-remove"
        aria-label="Remove element mention"
      >
        ×
      </button>
    </span>
  );
}
