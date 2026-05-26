import { useState, useEffect, useRef, useCallback } from "react";
import type { ExtensionUIRequest } from "@pi-web/shared";
import { Icon } from "./Icon";

interface Props {
  request: ExtensionUIRequest;
  onRespond: (response: { value?: string; confirmed?: boolean; cancelled?: boolean }) => void;
}

export function ExtensionUIModal({ request, onRespond }: Props) {
  const [value, setValue] = useState(request.prefill || "");
  const [selected, setSelected] = useState<string | undefined>(undefined);
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
          <div className="space-y-1 max-h-60 overflow-y-auto custom-scrollbar">
            {(request.options || []).map(opt => (
              <button
                key={opt}
                onClick={() => onRespond({ value: opt })}
                className={`w-full text-left px-3 py-2 rounded text-sm transition-theme ${
                  selected === opt
                    ? "bg-amber-500/20 text-amber-400 border border-amber-500/30"
                    : "hover:bg-ink-850 text-ink-300"
                }`}
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
                className="flex-1 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-ink-950 text-sm font-medium transition-theme"
              >
                Confirm
              </button>
              <button
                onClick={() => onRespond({ cancelled: true })}
                className="flex-1 py-2 rounded-lg bg-ink-850 hover:bg-ink-800 text-ink-400 text-sm transition-theme border border-ink-700"
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
              className="w-full bg-ink-900 border border-ink-700 rounded-lg px-3 py-2 text-ink-100 text-sm font-mono placeholder-ink-500 outline-none focus:border-amber-500"
              enterKeyHint="done"
            />
            <div className="flex gap-2">
              <button
                onClick={() => onRespond({ value: value || undefined })}
                className="flex-1 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-ink-950 text-sm font-medium transition-theme min-h-[44px]"
              >
                Submit
              </button>
              <button
                onClick={handleCancel}
                className="flex-1 py-2 rounded-lg bg-ink-850 hover:bg-ink-800 text-ink-400 text-sm transition-theme border border-ink-700 min-h-[44px]"
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
              className="w-full bg-ink-900 border border-ink-700 rounded-lg px-3 py-2 text-ink-100 text-sm font-mono placeholder-ink-500 outline-none focus:border-amber-500 resize-none min-h-[120px] md:min-h-[200px]"
            />
            <div className="flex gap-2">
              <button
                onClick={() => onRespond({ value: value || undefined })}
                className="flex-1 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-ink-950 text-sm font-medium transition-theme min-h-[44px]"
              >
                Submit
              </button>
              <button
                onClick={handleCancel}
                className="flex-1 py-2 rounded-lg bg-ink-850 hover:bg-ink-800 text-ink-400 text-sm transition-theme border border-ink-700 min-h-[44px]"
              >
                Cancel
              </button>
            </div>
          </div>
        );
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
      <div className="absolute top-2 left-3 right-3 md:left-1/2 md:right-auto md:-translate-x-1/2 md:max-w-sm z-30 animate-fade-in-up pointer-events-auto">
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-ink-900/95 border border-ink-800 shadow-lg backdrop-blur-sm">
          <div className={`shrink-0 mt-1.5 w-1.5 h-1.5 rounded-full ${c.dot}`} />
          <div className="flex-1 min-w-0">
            {request.title && (
              <p className={`text-xs font-medium leading-tight ${c.text}`}>{request.title}</p>
            )}
            <p className={`text-[11px] font-mono leading-snug ${request.title ? c.subtext : c.text} mt-0.5`}>
              {request.message || request.title}
            </p>
          </div>
          <button
            onClick={() => onRespond({ cancelled: true })}
            className="shrink-0 mt-0.5 text-ink-600 hover:text-ink-400 transition-colors p-1"
            aria-label="Dismiss notification"
          >
            <svg width="8" height="8" viewBox="0 0 10 10" fill="none" className="stroke-current" strokeWidth="2" strokeLinecap="round">
              <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" />
            </svg>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-60 flex items-center justify-center bg-ink-950/60 backdrop-blur-sm animate-fade-in-up">
      <div className="relative z-70 bg-ink-900 border border-ink-700 rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden mobile-safe-bottom">
        {/* Header */}
        <div className="px-5 py-4 border-b border-ink-800 flex items-center justify-between">
          <h3 className="text-ink-200 font-medium text-sm">{request.title || "Extension"}</h3>
          <button onClick={handleCancel} className="text-ink-500 hover:text-ink-400 transition-theme p-1.5 touch-target-sm" aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </div>
        {/* Body */}
        <div className="px-5 py-4">
          {renderContent()}
        </div>
      </div>
    </div>
  );
}
