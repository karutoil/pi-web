import { useState, useEffect, useRef, useCallback } from "react";
import type { ExtensionUIRequest } from "@pi-web/shared";

interface Props {
  request: ExtensionUIRequest;
  onRespond: (response: { value?: string; confirmed?: boolean; cancelled?: boolean }) => void;
}

export function ExtensionUIModal({ request, onRespond }: Props) {
  const [value, setValue] = useState(request.prefill || "");
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Auto-cancel on timeout
  useEffect(() => {
    if (request.timeout) {
      timerRef.current = setTimeout(() => onRespond({ cancelled: true }), request.timeout);
      return () => clearTimeout(timerRef.current);
    }
  }, [request.timeout, onRespond]);

  // Auto-focus
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

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
              ref={inputRef as any}
              value={value}
              onChange={e => setValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter") onRespond({ value: value || undefined });
                if (e.key === "Escape") onRespond({ cancelled: true });
              }}
              placeholder={request.placeholder}
              className="w-full bg-ink-900 border border-ink-700 rounded-lg px-3 py-2 text-ink-100 text-sm font-mono placeholder-ink-600 outline-none focus:border-amber-500"
            />
            <div className="flex gap-2">
              <button
                onClick={() => onRespond({ value: value || undefined })}
                className="flex-1 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-ink-950 text-sm font-medium transition-theme"
              >
                Submit
              </button>
              <button
                onClick={handleCancel}
                className="flex-1 py-2 rounded-lg bg-ink-850 hover:bg-ink-800 text-ink-400 text-sm transition-theme border border-ink-700"
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
              ref={inputRef as any}
              value={value}
              onChange={e => setValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Escape") onRespond({ cancelled: true });
              }}
              placeholder={request.placeholder}
              rows={8}
              className="w-full bg-ink-900 border border-ink-700 rounded-lg px-3 py-2 text-ink-100 text-sm font-mono placeholder-ink-600 outline-none focus:border-amber-500 resize-none"
            />
            <div className="flex gap-2">
              <button
                onClick={() => onRespond({ value: value || undefined })}
                className="flex-1 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-ink-950 text-sm font-medium transition-theme"
              >
                Submit
              </button>
              <button
                onClick={handleCancel}
                className="flex-1 py-2 rounded-lg bg-ink-850 hover:bg-ink-800 text-ink-400 text-sm transition-theme border border-ink-700"
              >
                Cancel
              </button>
            </div>
          </div>
        );
    }
  };

  if (request.method === "notify") {
    return (
      <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-lg shadow-lg border animate-fade-in-up max-w-sm ${
        request.notifyType === "error"
          ? "bg-rose-500/10 border-rose-500/30 text-rose-400"
          : request.notifyType === "warning"
          ? "bg-amber-500/10 border-amber-500/30 text-amber-400"
          : "bg-ink-900 border-ink-700 text-ink-300"
      }`}>
        <div className="flex items-start gap-2">
          <span className="text-sm">{request.message || request.title}</span>
          <button onClick={() => onRespond({})} className="shrink-0 text-ink-600 hover:text-ink-400 ml-2">×</button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/60 backdrop-blur-sm animate-fade-in-up">
      <div className="bg-ink-900 border border-ink-700 rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-ink-800 flex items-center justify-between">
          <h3 className="text-ink-200 font-medium text-sm">{request.title || "Extension"}</h3>
          {!request.timeout && (
            <button onClick={handleCancel} className="text-ink-600 hover:text-ink-400 transition-theme">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M4 4 L12 12 M12 4 L4 12" />
              </svg>
            </button>
          )}
        </div>
        {/* Body */}
        <div className="px-5 py-4">
          {renderContent()}
        </div>
        {/* Timeout indicator */}
        {request.timeout && (
          <div className="px-5 py-2 border-t border-ink-800">
            <div className="h-1 bg-ink-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-amber-500 rounded-full animate-shimmer"
                style={{ width: "100%", animationDuration: `${request.timeout}ms` }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
