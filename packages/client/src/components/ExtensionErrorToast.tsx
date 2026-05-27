import { useState, useEffect } from "react";
import type { ExtensionErrorEntry } from "../lib/types";

interface ExtensionErrorToastProps {
  errors: ExtensionErrorEntry[];
  onDismiss: (index: number) => void;
  onClearAll?: () => void;
}

export function ExtensionErrorToast({ errors, onDismiss, onClearAll }: ExtensionErrorToastProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [visible, setVisible] = useState(false);

  // Stagger entrance on mount
  useEffect(() => {
    setVisible(true);
  }, []);

  const recent = errors.slice(-3);
  if (recent.length === 0) return null;

  return (
    <div
      className={`px-3 md:px-5 pb-1.5 transition-all duration-300 ease-out ${visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"}`}
    >
      {/* Collapsed: single pill */}
      {recent.length > 1 && collapsed ? (
        <div className="flex items-center gap-2">
          <button
            onClick={() => setCollapsed(false)}
            className="flex items-center gap-2 px-2.5 py-1.5 rounded-full bg-ink-900/95 border border-rose-500/20 text-ink-400 text-[11px] font-mono hover:border-rose-500/35 hover:text-ink-300 transition-all"
            role="alert"
          >
            <span className="w-4 h-4 rounded-full bg-rose-500/20 border border-rose-500/40 flex items-center justify-center">
              <span className="text-rose-400 text-[9px] leading-none font-bold">{recent.length}</span>
            </span>
            errors
          </button>
          <button
            onClick={() => { if (onClearAll) onClearAll(); else recent.forEach((_, i) => onDismiss(errors.length - recent.length + i)); }}
            className="text-ink-600 hover:text-ink-400 text-[10px] font-mono px-1 py-0.5 transition-colors"
          >
            clear all
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {recent.length > 1 && (
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => { if (onClearAll) onClearAll(); else recent.forEach((_, i) => onDismiss(errors.length - recent.length + i)); }}
                className="text-ink-600 hover:text-ink-400 text-[10px] font-mono px-1 py-0.5 transition-colors"
              >
                clear all
              </button>
              <button
                onClick={() => setCollapsed(true)}
                className="text-ink-600 hover:text-ink-400 text-[10px] font-mono px-1 py-0.5 transition-colors"
              >
                collapse
              </button>
            </div>
          )}
          {recent.map((err, i) => {
            const idx = errors.length - recent.length + i;
            return (
              <div
                key={`${err.extensionPath}-${idx}`}
                className="flex items-start gap-2 px-3 py-2 rounded-lg bg-ink-900/95 border border-rose-500/20"
                role="alert"
              >
                <div className="shrink-0 mt-px w-1 h-1 rounded-full bg-rose-500" />
                <div className="min-w-0 flex-1">
                  <span className="text-ink-300 text-[11px] font-mono truncate" title={err.extensionPath}>
                    {err.extensionPath.split("/").pop()}
                  </span>
                  <span className="text-ink-500 text-[11px] font-mono ml-1.5 line-clamp-1" title={err.error}>
                    {err.error}
                  </span>
                </div>
                <button
                  onClick={() => onDismiss(idx)}
                  className="shrink-0 text-ink-600 hover:text-ink-400 transition-colors p-0.5"
                  aria-label="Dismiss"
                >
                  <svg width="8" height="8" viewBox="0 0 10 10" fill="none" className="stroke-current" strokeWidth="2" strokeLinecap="round">
                    <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" />
                  </svg>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
