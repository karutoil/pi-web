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

  const viewportLabel = (v: Viewport) => {
    switch (v) {
      case "375px": return "M";
      case "768px": return "T";
      case "1280px": return "D";
      case "100%": return "F";
    }
  };

  return (
    <div className="preview-toolbar">
      {preview && (
        <span className="preview-status-badge" data-status={preview.status === "running" ? "live" : preview.status}>
          {preview.status}
        </span>
      )}

      <div className="preview-tool-divider" />

      <div className="preview-toolbar-port-chips">
        {(["375px", "768px", "1280px", "100%"] as Viewport[]).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setViewport(v)}
            className="preview-tool-button"
            data-active={viewport === v}
            title={`${viewportLabel(v)} viewport`}
          >
            {viewportLabel(v)}
          </button>
        ))}
      </div>

      {isRunning && (
        <button
          type="button"
          onClick={onTogglePicker}
          className="preview-tool-button"
          data-active={pickerActive}
          title="Toggle element picker"
        >
          Pick
        </button>
      )}

      <div className="preview-tool-divider" />

      <button
        type="button"
        onClick={handleRefresh}
        className="preview-tool-button"
        title="Refresh"
        disabled={!isRunning}
      >
        Refresh
      </button>

      <button
        type="button"
        onClick={handleOpen}
        className="preview-tool-button"
        title="Open in browser"
        disabled={!isRunning || loading.open}
      >
        Open
      </button>

      {preview && preview.status !== "stopped" && (
        <button
          type="button"
          onClick={handleStop}
          className="preview-tool-button"
          title="Stop preview"
          disabled={loading.stop}
        >
          Stop
        </button>
      )}
    </div>
  );
}
