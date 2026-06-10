/**
 * ConsolePanel — displays captured console logs from the preview iframe.
 */

import { useRef, useEffect } from "react";
import type { ConsoleEntry } from "../../hooks/usePreviewStore";

interface ConsolePanelProps {
  logs: ConsoleEntry[];
  onClear: () => void;
}

const LEVEL_LABELS: Record<ConsoleEntry["level"], string> = {
  error: "ERR",
  warn: "WRN",
  log: "LOG",
};

export function ConsolePanel({ logs, onClear }: ConsolePanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs.length]);

  const errors = logs.filter((l) => l.level === "error");
  const warnings = logs.filter((l) => l.level === "warn");
  const info = logs.filter((l) => l.level === "log");

  return (
    <div className="preview-console-shell">
      {/* Summary bar */}
      <div className="preview-console-summary">
        <span className="preview-console-count" data-level="error">
          {errors.length}
        </span>
        <span className="preview-console-count" data-level="warn">
          {warnings.length}
        </span>
        <span className="preview-console-count">{info.length} logs</span>
        <button
          type="button"
          onClick={onClear}
          className="preview-console-clear"
        >
          Clear
        </button>
      </div>

      {/* Log list */}
      <div ref={scrollRef} className="preview-console-list">
        {logs.length === 0 ? (
          <div className="preview-console-empty">
            No console output yet.
          </div>
        ) : (
          logs.map((entry, i) => (
            <div
              key={i}
              className="preview-console-entry"
              data-level={entry.level}
            >
              <div className="flex items-start gap-2">
                <span className="preview-console-level">
                  {LEVEL_LABELS[entry.level]}
                </span>
                <span className="whitespace-pre-wrap break-all">
                  {entry.message}
                </span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
