import { useEffect, useCallback } from "react";
import { createPortal } from "react-dom";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Delete",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    },
    [onCancel]
  );

  useEffect(() => {
    if (!open) return;
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, handleKeyDown]);

  if (!open) return null;

  return createPortal(
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-60 bg-ink-950/60 backdrop-blur-sm animate-fade-in"
        onClick={onCancel}
      />
      {/* Dialog */}
      <div className="fixed inset-0 z-70 flex items-center justify-center animate-fade-in">
        <div
          className="bg-ink-900 border border-ink-800/60 rounded-lg shadow-xl max-w-sm w-full mx-4 p-5 mobile-safe-bottom"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-title"
        >
          <div className="overflow-y-auto max-h-[calc(60vh-2.5rem)]">
            <h3
              id="confirm-title"
              className="text-ink-100 text-sm font-semibold mb-2"
            >
              {title}
            </h3>
            <p className="text-ink-300 text-xs leading-relaxed mb-1">
              {message}
            </p>
            <p className="text-ink-500 text-[0.65rem] italic">
              This cannot be undone.
            </p>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <button
              onClick={onCancel}
              className="px-3 py-1.5 min-h-[44px] text-ink-400 hover:text-ink-200 text-xs rounded-md hover:bg-ink-800/40 transition-theme"
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              className="px-3 py-1.5 min-h-[44px] bg-amber-600/90 hover:bg-amber-500 text-ink-950 text-xs font-medium rounded-md transition-theme"
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body
  );
}
