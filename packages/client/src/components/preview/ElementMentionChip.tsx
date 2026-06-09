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
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/[0.08] border border-amber-500/20 text-amber-500 font-mono text-[0.65rem] cursor-pointer hover:bg-amber-500/[0.14] transition-theme align-middle mx-0.5"
      title={`Selected element: ${token}`}
      onClick={onClick}
    >
      <span className="text-amber-600/70">&lt;{tagName}&gt;</span>
      <span className="text-amber-500/50">{token.replace(/^@element:/, "").slice(0, 20)}</span>
      <button
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        className="text-amber-500/40 hover:text-rose-400 transition-theme leading-none"
        aria-label="Remove element mention"
      >
        ×
      </button>
    </span>
  );
}
