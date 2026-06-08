/**
 * PreviewControls — toolbar for the preview panel.
 *
 * Contains: refresh, viewport switcher, picker toggle, stop, open-in-browser.
 */

import { useState, useCallback } from "react";
import type { PreviewInfo } from "@pi-web/shared";


type Viewport = "100%" | "375px" | "768px" | "1280px";

interface PreviewControlsProps {
  projectId: string;
  preview: PreviewInfo | null;
  pickerActive: boolean;
  onTogglePicker: () => void;
  onRefresh?: () => void;
}

export function PreviewControls({
  projectId,
  preview,
  pickerActive,
  onTogglePicker,
  onRefresh,
}: PreviewControlsProps) {
  const [viewport, setViewport] = useState<Viewport>("100%");
  const [loading, setLoading] = useState<Record<string, boolean>>({});

  const isRunning = preview?.status === "running";

  const handleAction = useCallback(
    async (action: string, url: string, key: string) => {
      setLoading((s) => ({ ...s, [key]: true }));
      try {
        const r = await fetch(url, { method: "POST" });
        if (r.ok && onRefresh) onRefresh();
      } catch {}
      setLoading((s) => ({ ...s, [key]: false }));
    },
    [onRefresh],
  );

  const handleStop = () => {
    if (!preview) return;
    handleAction(
      "stop",
      `/api/preview/${projectId}/${preview.label}/stop`,
      "stop",
    );
  };

  const handleRefresh = () => {
    if (onRefresh) onRefresh();
  };

  const handleOpen = () => {
    if (!preview) return;
    handleAction(
      "open",
      `/api/preview/${projectId}/${preview.label}/open`,
      "open",
    );
  };

  const viewportBtnClass = (v: Viewport) =>
    "px-1.5 py-0.5 rounded text-[0.6rem] font-mono transition-theme " +
    (viewport === v
      ? "bg-amber-500/20 text-amber-500"
      : "text-ink-500 hover:text-ink-300 hover:bg-ink-900");

  return (
    <div className="flex items-center gap-1 px-3 py-1.5 border-b border-ink-800 shrink-0 pl-5">
      {/* Status badge */}
      {preview && (
        <span
          className={
            "px-1.5 py-0.5 rounded text-[0.6rem] font-mono leading-none mr-1 " +
            (preview.status === "running"
              ? "bg-emerald-500/20 text-emerald-400"
              : preview.status === "starting"
              ? "bg-amber-500/20 text-amber-400 animate-pulse"
              : preview.status === "crashed"
              ? "bg-red-500/20 text-red-400"
              : "bg-ink-800 text-ink-500")
          }
        >
          {preview.status}
        </span>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Viewport switcher */}
      <div className="flex items-center gap-0.5">
        <button onClick={() => setViewport("375px")} className={viewportBtnClass("375px")}>M</button>
        <button onClick={() => setViewport("768px")} className={viewportBtnClass("768px")}>T</button>
        <button onClick={() => setViewport("1280px")} className={viewportBtnClass("1280px")}>D</button>
        <button onClick={() => setViewport("100%")} className={viewportBtnClass("100%")}>F</button>
      </div>

      {/* Element picker toggle */}
      {isRunning && (
        <button
          onClick={onTogglePicker}
          className={
            "px-2 py-0.5 rounded text-[0.6rem] font-mono transition-theme " +
            (pickerActive
              ? "bg-blue-500/30 text-blue-400 border border-blue-500/40"
              : "text-ink-500 hover:text-ink-300 hover:bg-ink-900 border border-transparent")
          }
          title="Toggle element picker"
        >
          <span className="mr-1">⌘</span>Pick
        </button>
      )}

      {/* Refresh */}
      <button
        onClick={handleRefresh}
        className="p-1 rounded hover:bg-ink-900 text-ink-500 hover:text-ink-200 transition-theme"
        title="Refresh"
        disabled={!isRunning}
      >
        <span className="text-[0.7rem]">↻</span>
      </button>

      {/* Open in browser */}
      <button
        onClick={handleOpen}
        className="p-1 rounded hover:bg-ink-900 text-ink-500 hover:text-ink-200 transition-theme"
        title="Open in browser"
        disabled={!isRunning || loading.open}
      >
        <span className="text-[0.7rem]">↗</span>
      </button>

      {/* Stop */}
      {preview && preview.status !== "stopped" && (
        <button
          onClick={handleStop}
          className="p-1 rounded hover:bg-red-500/10 text-ink-500 hover:text-red-400 transition-theme"
          title="Stop preview"
          disabled={loading.stop}
        >
          <span className="text-xs">×</span>
        </button>
      )}
    </div>
  );
}
