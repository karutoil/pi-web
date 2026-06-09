/**
 * ConsolePanel — displays captured console logs from the preview iframe.
 */

import { useRef, useEffect } from "react";
import type { ConsoleEntry } from "../../hooks/usePreviewStore";

interface ConsolePanelProps {
  logs: ConsoleEntry[];
  onClear: () => void;
}

const LEVEL_STYLES: Record<ConsoleEntry["level"], string> = {
  error: "text-rose-400 bg-rose-400/5 border-rose-400/15",
  warn: "text-amber-500 bg-amber-400/5 border-amber-400/15",
  log: "text-ink-300 border-ink-800",
};

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
    <div className="flex flex-col flex-1 min-h-0">
      {/* Summary bar */}
      <div className="flex items-center gap-3 px-3 py-2 border-b border-ink-800/40 shrink-0 pl-5">
        <span className="flex items-center gap-1 text-[0.6rem] font-mono text-rose-400">
          <span className="w-2 h-2 rounded-full bg-rose-400 inline-block" />
          {errors.length}
        </span>
        <span className="flex items-center gap-1 text-[0.6rem] font-mono text-amber-500">
          <span className="w-2 h-2 rounded-full bg-amber-500 inline-block" />
          {warnings.length}
        </span>
        <span className="flex items-center gap-1 text-[0.6rem] font-mono text-ink-500">
          {info.length} logs
        </span>
        <div className="flex-1" />
        <button
          onClick={onClear}
          className="text-ink-500 hover:text-ink-200 hover:bg-ink-800/40 px-1.5 py-0.5 rounded font-mono text-[0.6rem] transition-theme"
        >
          Clear
        </button>
      </div>

      {/* Log list */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {logs.length === 0 ? (
          <div className="text-ink-500 text-xs font-mono text-center mt-8">
            No console output yet.
          </div>
        ) : (
          <div className="divide-y divide-ink-800/30">
            {logs.map((entry, i) => (
              <div
                key={i}
                className={`px-3 py-2 font-mono text-[0.7rem] leading-relaxed border-l-2 ${LEVEL_STYLES[entry.level]} pl-5`}
              >
                <div className="flex items-start gap-2">
                  <span
                    className={
                      "text-[0.55rem] font-semibold uppercase shrink-0 mt-px " +
                      (entry.level === "error"
                        ? "text-rose-400"
                        : entry.level === "warn"
                        ? "text-amber-500"
                        : "text-ink-500")
                    }
                  >
                    {LEVEL_LABELS[entry.level]}
                  </span>
                  <span className="whitespace-pre-wrap break-all">
                    {entry.message}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
