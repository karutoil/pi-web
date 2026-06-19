import { useEffect, useCallback } from "react";
import { createPortal } from "react-dom";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  destructiveHint?: string | false;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Delete",
  destructiveHint = "This cannot be undone.",
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
      <div
        className="modal-backdrop animate-fade-in"
        onClick={onCancel}
      />
      <div className="modal-stage animate-fade-in">
        <div
          className="modal-card"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-title"
        >
          <div className="modal-header">
            <div className="modal-title-wrap">
              <h3
                id="confirm-title"
                className="modal-title"
              >
                {title}
              </h3>
            </div>
          </div>
          <div className="modal-body modal-body--compact">
            <p className="text-ink-300 text-xs leading-relaxed mb-1">
              {message}
            </p>
            {destructiveHint && (
              <p className="text-ink-500 text-[0.65rem] italic">
                {destructiveHint}
              </p>
            )}
          </div>
          <div className="modal-footer modal-footer--justify-end">
            <button
              onClick={onCancel}
              className="modal-button modal-button--ghost"
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              className="modal-button modal-button--danger"
              autoFocus
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
