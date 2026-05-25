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
    return (
      <div className={`fixed top-4 left-1/2 -translate-x-1/2 z-80 min-w-[280px] max-w-lg animate-fade-in-up mobile-safe-top`}>
        <div className={`flex items-center gap-3 px-4 py-3 rounded-xl shadow-2xl border backdrop-blur-md ${
          request.notifyType === "error"
            ? "bg-rose-500/15 border-rose-500/30 text-rose-300"
            : request.notifyType === "warning"
            ? "bg-amber-500/15 border-amber-500/30 text-amber-300"
            : request.notifyType === "success"
            ? "bg-emerald-500/15 border-emerald-500/30 text-emerald-300"
            : "bg-ink-900/90 border-ink-700/60 text-ink-300"
        }`}>
          {/* Icon */}
          <div className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center ${
            request.notifyType === "error"
              ? "bg-rose-500/20"
              : request.notifyType === "warning"
              ? "bg-amber-500/20"
              : request.notifyType === "success"
              ? "bg-emerald-500/20"
              : "bg-ink-700/50"
          }`}>
            <Icon name={
              request.notifyType === "error" ? "close" :
              request.notifyType === "warning" ? "check" :
              request.notifyType === "success" ? "check" :
              "check"
            } size={14} />
          </div>
          {/* Content */}
          <div className="flex-1 min-w-0">
            {request.title && (
              <p className="text-sm font-medium leading-snug">{request.title}</p>
            )}
            <p className={`text-sm leading-snug ${request.title ? "text-ink-400 mt-0.5" : ""}`}>
              {request.message || request.title}
            </p>
          </div>
          {/* Dismiss button */}
          <button
            onClick={() => onRespond({ cancelled: true })}
            className="shrink-0 w-6 h-6 rounded-md flex items-center justify-center text-ink-400 hover:text-ink-300 hover:bg-ink-800/50 transition-theme"
            aria-label="Dismiss notification"
          >
            <Icon name="close" size={12} />
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
