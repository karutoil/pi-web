import { useState, useEffect, useRef, useCallback } from "react";
import type { ExtensionUIRequest } from "@pi-web/shared";
import { Icon } from "./Icon";

interface Props {
  request: ExtensionUIRequest;
  onRespond: (response: { value?: string; confirmed?: boolean; cancelled?: boolean }) => void;
}

export function ExtensionUIModal({ request, onRespond }: Props) {
  const [value, setValue] = useState(request.prefill || "");
  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const isDialog = ["select", "confirm", "input", "editor"].includes(request.method);
  const isNotify = request.method === "notify";

  // Auto-cancel on timeout — ONLY for notify method.
  // Dialog methods (confirm, select, input, editor) wait indefinitely for user action.
  // The server-side pi process handles its own timeout; auto-cancelling from the UI
  // was causing subagent clarify confirmations to be silently dismissed.
  useEffect(() => {
    if (isNotify && request.timeout) {
      timerRef.current = setTimeout(() => onRespond({ cancelled: true }), request.timeout);
      return () => clearTimeout(timerRef.current);
    }
  }, [isNotify, request.timeout, onRespond]);

  // Auto-focus
  useEffect(() => {
    if (isDialog) {
      if (request.method === "editor") textareaRef.current?.focus();
      else inputRef.current?.focus();
    }
  }, [isDialog, request.method]);

  const handleCancel = useCallback(() => onRespond({ cancelled: true }), [onRespond]);

  const renderContent = () => {
    switch (request.method) {
      case "select":
        return (
          <div className="modal-list custom-scrollbar space-y-1">
            {(request.options || []).map(opt => (
              <button
                key={opt}
                onClick={() => onRespond({ value: opt })}
                className="modal-option"
              >
                {opt}
              </button>
            ))}
          </div>
        );

      case "confirm":
        return (
          <div className="space-y-3">
            {request.message && (
              <p className="text-ink-400 text-sm leading-relaxed">{request.message}</p>
            )}
            <div className="flex gap-2">
              <button
                onClick={() => onRespond({ confirmed: true })}
                className="modal-button modal-button--primary flex-1"
              >
                Confirm
              </button>
              <button
                onClick={() => onRespond({ cancelled: true })}
                className="modal-button modal-button--ghost flex-1"
              >
                Cancel
              </button>
            </div>
          </div>
        );

      case "input":
        return (
          <div className="space-y-3">
            <input
              ref={inputRef}
              value={value}
              onChange={e => setValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter") onRespond({ value: value || undefined });
                if (e.key === "Escape") onRespond({ cancelled: true });
              }}
              placeholder={request.placeholder}
              className="modal-field"
              enterKeyHint="done"
            />
            <div className="flex gap-2">
              <button
                onClick={() => onRespond({ value: value || undefined })}
                className="modal-button modal-button--primary flex-1"
              >
                Submit
              </button>
              <button
                onClick={handleCancel}
                className="modal-button modal-button--ghost flex-1"
              >
                Cancel
              </button>
            </div>
          </div>
        );

      case "editor":
        return (
          <div className="space-y-3">
            <textarea
              ref={textareaRef}
              value={value}
              onChange={e => setValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Escape") onRespond({ cancelled: true });
              }}
              placeholder={request.placeholder}
              className="modal-field resize-none min-h-[120px] md:min-h-[200px]"
            />
            <div className="flex gap-2">
              <button
                onClick={() => onRespond({ value: value || undefined })}
                className="modal-button modal-button--primary flex-1"
              >
                Submit
              </button>
              <button
                onClick={handleCancel}
                className="modal-button modal-button--ghost flex-1"
              >
                Cancel
              </button>
            </div>
          </div>
        );
      default:
        return <div className="text-ink-500 text-sm">Unknown dialog type: {request.method}</div>;
    }
  };

  if (isNotify) {
    const notifyColors = {
      error:   { dot: "bg-rose-500", text: "text-rose-300", subtext: "text-rose-400/70" },
      warning: { dot: "bg-amber-500", text: "text-amber-300", subtext: "text-amber-400/70" },
      success: { dot: "bg-teal-500", text: "text-teal-300", subtext: "text-teal-400/70" },
      info:    { dot: "bg-ink-400", text: "text-ink-200", subtext: "text-ink-400" },
    };
    const variant = (request.notifyType && notifyColors[request.notifyType]) ? request.notifyType! : "info";
    const c = notifyColors[variant];

    return (
      <div className="modal-extension-notify animate-fade-in-up pointer-events-auto">
        <div className="modal-extension-notify-card">
          <div className={`modal-extension-notify-dot ${c.dot}`} />
          <div className="flex-1 min-w-0">
            {request.title && (
              <p className={`modal-extension-notify-title ${c.text}`}>{request.title}</p>
            )}
            <p className={`modal-extension-notify-message ${request.title ? c.subtext : c.text}`}>
              {request.message || request.title}
            </p>
          </div>
          <button
            onClick={() => onRespond({ cancelled: true })}
            className="modal-extension-notify-close"
            aria-label="Dismiss notification"
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop animate-fade-in-up">
      <div className="modal-stage">
        <div className="modal-card relative z-70 mobile-safe-bottom">
          <div className="modal-header">
            <h3 className="modal-title">{request.title || "Extension"}</h3>
            <button onClick={handleCancel} className="modal-close" aria-label="Close">
              <Icon name="close" size={16} />
            </button>
          </div>
          <div className="modal-body">
            {renderContent()}
          </div>
        </div>
      </div>
    </div>
  );
}
