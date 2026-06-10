/**
 * PreviewPanel — Right-side developer viewport.
 *
 * Design direction: Flat "Viewfinder" — a focused observation tool
 * that adapts to both light and dark ink palettes. Uses the same ink,
 * brass, seam, blueprint, and rust tokens as the rest of the shell, with
 * no glow gradients.
 *
 * States:
 *   • Idle       — "Start Preview" button, project name hint
 *   • Starting   — Pulsing brass spinner, dev server logs
 *   • Running    — Iframe + bottom toolbar (picker, viewport, refresh, stop)
 *   • Crashed    — Red indicator, error message, retry button
 */

import { useState, useRef, useEffect, useCallback } from "react";
import type { PreviewInfo } from "@pi-web/shared";
import { usePreviewStore } from "../../hooks/usePreviewStore";
import { usePostMessageBridge } from "../../hooks/usePostMessageBridge";
import { useResizable } from "../../hooks/useResizable";
import { buildElementToken, buildElementContext } from "../../lib/elementMention";

/* ─── Inline SVG icons ─── */
const PlayIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M5 3l9 5-9 5V3z" fill="currentColor" />
  </svg>
);
const StopIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <rect x="2" y="2" width="10" height="10" rx="1.5" fill="currentColor" />
  </svg>
);
const CrosshairIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.5" />
    <circle cx="7" cy="7" r="1.5" fill="currentColor" />
    <path d="M7 1v3M7 10v3M1 7h3M10 7h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
  </svg>
);
const RefreshIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <path d="M1.5 7A5.5 5.5 0 0112.2 4M12.5 7A5.5 5.5 0 011.8 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <path d="M9 1.5L12.5 4 14 2M5 12.5L1.5 10 0 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const OpenIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <path d="M10.5 2H12a1 1 0 011 1v9a1 1 0 01-1 1H2a1 1 0 01-1-1V3a1 1 0 011-1h1.5M9 5L5 9M9 5H6.5M9 5v2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const SelectIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <rect x="1.5" y="1.5" width="11" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
    <path d="M4 7l2 2 4-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/* ─── Types ─── */
type Viewport = "fill" | "375" | "768" | "1280";
const VIEWPORT_LABELS: Record<Viewport, string> = {
  fill: "Fill",
  "375": "Mobile",
  "768": "Tablet",
  "1280": "Desktop",
};

interface PreviewPanelProps {
  projectId: string;
  projectName: string;
  projectPath: string;
  preview: PreviewInfo | null;
  onElementSelected?: (token: string, context: string) => void;
  onRefresh?: () => void;
  embedded?: boolean;
  width?: number;
}

export function PreviewPanel({
  projectId,
  projectName,
  projectPath,
  onElementSelected,
  preview,
  onRefresh,
  embedded = false,
  width,
}: PreviewPanelProps) {
  const isOpen = usePreviewStore((s) => s.isOpen);
  const setOpen = usePreviewStore((s) => s.setOpen);
  const pickedElements = usePreviewStore((s) => s.pickedElements);
  const pickerActive = usePreviewStore((s) => s.pickerActive);
  const togglePicker = usePreviewStore((s) => s.togglePicker);

  const [viewport, setViewport] = useState<Viewport>("fill");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [manualPort, setManualPort] = useState<string>("");
  const [remoteUrl, setRemoteUrl] = useState<string>("");
  const [inputMode, setInputMode] = useState<"port" | "url">("port");
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const { postMessage } = usePostMessageBridge(iframeRef);

  const { width: resizableWidth, isDragging, handleMouseDown } = useResizable({
    defaultWidth: embedded ? (width ?? 460) : 460,
    minWidth: 320,
    maxWidth: typeof window !== "undefined" ? window.innerWidth * 0.7 : 800,
    persistKey: embedded ? undefined : "pi-preview-width",
  });
  const panelWidth = embedded ? "100%" : resizableWidth;

  // Determine backend origin for preview iframe.
  const backendOrigin = (() => {
    try {
      if (import.meta.env?.DEV) return 'http://localhost:3069';
    } catch {}
    return window.location.origin;
  })();

  const iframeSrc = preview && preview.status === "running"
    ? `${backendOrigin}/preview/${projectId}/${preview.label}/`
    : null;

  // Notify parent about picked elements
  useEffect(() => {
    if (pickedElements.length > 0 && onElementSelected) {
      const latest = pickedElements[pickedElements.length - 1];
      onElementSelected(buildElementToken(latest), buildElementContext(latest));
    }
  }, [pickedElements.length]);

  // ── Actions ──
  const startPreview = useCallback(async (overridePort?: number, overrideRemoteUrl?: string) => {
    setStarting(true);
    setStartError(null);
    try {
      const body: any = { projectId, cwd: projectPath, label: "default" };
      if (overrideRemoteUrl) body.remoteUrl = overrideRemoteUrl;
      else if (overridePort) body.port = overridePort;
      const r = await fetch("/api/preview/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || `Failed (${r.status})`);
      }
      onRefresh?.();
    } catch (e: any) {
      setStartError(e.message);
    } finally {
      setStarting(false);
    }
  }, [projectId, projectPath, onRefresh]);

  const stopPreview = useCallback(async () => {
    if (!preview) return;
    try {
      await fetch(`/api/preview/${projectId}/${preview.label}/stop`, { method: "POST" });
      onRefresh?.();
    } catch {}
  }, [projectId, preview, onRefresh]);

  const handleRefresh = () => {
    if (iframeRef.current && iframeSrc) {
      iframeRef.current.src = iframeSrc;
    }
  };

  const selectPort = useCallback(async (newPort: number) => {
    if (!preview || preview.port === newPort) return;
    try {
      const r = await fetch(`/api/preview/${projectId}/${preview.label}/port`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ port: newPort }),
      });
      if (r.ok) onRefresh?.();
    } catch {}
  }, [projectId, preview, onRefresh]);

  const handleOpen = () => {
    if (!preview) return;
    fetch(`/api/preview/${projectId}/${preview.label}/open`, { method: "POST" }).catch(() => {});
  };

  const cycleViewport = () => {
    const order: Viewport[] = ["fill", "375", "768", "1280"];
    const idx = order.indexOf(viewport);
    setViewport(order[(idx + 1) % order.length]);
  };

  // ── Closed state: thin toggle strip ──
  if (!isOpen && !embedded) {
    return (
      <div className="preview-closed-rail" role="complementary">
        <button
          onClick={() => setOpen(true)}
          className="preview-closed-button group"
          aria-label="Open preview"
          title="Preview"
        >
          <span className="preview-closed-label">
            PREVIEW
          </span>
          {preview?.status === "running" && (
            <span className="preview-running-dot animate-pulse" />
          )}
        </button>
      </div>
    );
  }

  const isRunning = preview?.status === "running";
  const isDetecting = preview?.status === "detecting" || (starting && !preview);
  const isStarting = preview?.status === "starting" || (starting && preview?.status === "detecting");

  return (
    <div
      className="preview-panel-shell select-none"
      style={{
        width: panelWidth,
        ...(isDragging ? { userSelect: "none", transition: "none" } : {}),
      }}
    >
      {!embedded && (
      <div
        onMouseDown={handleMouseDown}
        className="preview-resize-handle group/handle"
        data-resizing={isDragging}
      >
        <div className="preview-resize-grip" />
      </div>
      )}

      {/* ── Header bar — matches Git/terminal panel styling ── */}
      <div className="preview-panel-header shrink-0">
        <div className="preview-panel-header-copy">
          <div className="preview-panel-eyebrow">Preview</div>
          <div className="preview-panel-heading" title={projectName}>
            {projectName}
          </div>
          <div className="preview-panel-badges">
            {isRunning && (
              <span className="preview-status-badge" data-status="live" title={preview?.remoteUrl}>
                <span className="preview-status-dot" />
                {preview?.remoteUrl ? "Remote" : "Live"}
              </span>
            )}
            {isRunning && preview?.remoteUrl && (
              <span className="preview-status-badge" title={preview.remoteUrl}>
                {preview.remoteUrl.replace(/^https?:\/\//, "")}
              </span>
            )}
            {isDetecting && (
              <span className="preview-status-badge" data-status="detecting">
                <span className="preview-status-dot" />
                Detecting
              </span>
            )}
            {isStarting && (
              <span className="preview-status-badge" data-status="starting">
                <span className="preview-status-dot" />
                Starting
              </span>
            )}
            {preview?.status === "crashed" && (
              <span className="preview-status-badge" data-status="crashed">
                <span className="preview-status-dot" />
                Crashed
              </span>
            )}
          </div>
        </div>

        {!embedded && (
        <button
          onClick={() => setOpen(false)}
          className="preview-panel-icon-button"
          aria-label="Close preview"
          title="Close"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
        </button>
        )}
      </div>

      {/* ── Content area ── */}
      <div className="preview-panel-content">

        {/* ── Idle / Detecting state (also shown when stopped) ── */}
        {(!preview || preview.status === "stopped" || isDetecting) && (
          <div className="preview-empty-state">
            {!isDetecting ? (
              /* ── Truly idle: show Start button + manual port/URL input ── */
              <>
                <div className="flex flex-col items-center gap-3">
                  <div className="preview-empty-icon">
                    <PlayIcon />
                  </div>
                  <p className="preview-empty-copy">
                    {inputMode === "url" ? "Proxy to a remote URL" : "Run your dev server"}
                  </p>
                </div>

                {/* Input mode toggle */}
                <div className="preview-segmented" role="tablist" aria-label="Preview source">
                  <button
                    type="button"
                    onClick={() => setInputMode("port")}
                    role="tab"
                    data-active={inputMode === "port"}
                  >
                    Port
                  </button>
                  <button
                    type="button"
                    onClick={() => setInputMode("url")}
                    role="tab"
                    data-active={inputMode === "url"}
                  >
                    URL
                  </button>
                </div>

                {/* Manual port or URL input */}
                {inputMode === "port" ? (
                  <div className="preview-form-row">
                    <input
                      type="number"
                      value={manualPort}
                      onChange={(e) => setManualPort(e.target.value)}
                      placeholder="Port (auto)"
                      className="preview-field"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const p = parseInt(manualPort, 10);
                        startPreview(p > 0 && p < 65536 ? p : undefined);
                      }}
                      disabled={starting}
                      className="preview-button preview-button--primary"
                    >
                      {starting ? (
                        <span className="flex items-center gap-2">
                          <span className="preview-start-spinner preview-start-spinner--small" />
                          Launching…
                        </span>
                      ) : (
                        <span className="flex items-center gap-2">
                          <PlayIcon />
                          Start Preview
                        </span>
                      )}
                    </button>
                  </div>
                ) : (
                  <div className="preview-form-row">
                    <input
                      type="text"
                      value={remoteUrl}
                      onChange={(e) => setRemoteUrl(e.target.value)}
                      placeholder="panel.catalystctl.com"
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && remoteUrl.trim()) {
                          startPreview(undefined, remoteUrl.trim());
                        }
                      }}
                      className="preview-field min-w-[16rem]"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        if (remoteUrl.trim()) startPreview(undefined, remoteUrl.trim());
                      }}
                      disabled={starting || !remoteUrl.trim()}
                      className="preview-button preview-button--primary"
                    >
                      {starting ? (
                        <span className="flex items-center gap-2">
                          <span className="preview-start-spinner preview-start-spinner--small" />
                          Connecting…
                        </span>
                      ) : (
                        <span className="flex items-center gap-2">
                          <PlayIcon />
                          Connect
                        </span>
                      )}
                    </button>
                  </div>
                )}

                {startError && (
                  <p className="preview-error-text">
                    {startError}
                  </p>
                )}
              </>
            ) : (
              /* ── Detecting: spinner + detected ports ── */
              <>
                <div className="preview-start-spinner" />
                <p className="preview-empty-copy">
                  {preview?.detectedPorts && preview.detectedPorts.length > 0
                    ? "Select a port"
                    : "Detecting ports…"}
                </p>

                {/* Port chips */}
                {preview?.detectedPorts && preview.detectedPorts.length > 0 && (
                  <div className="preview-port-grid">
                    <p className="preview-found-label">Found</p>
                    <div className="preview-port-chips">
                      {preview.detectedPorts.map((p) => (
                        <button
                          type="button"
                          key={p}
                          onClick={() => selectPort(p)}
                          className="preview-port-chip"
                          data-active={preview.port === p}
                        >
                          :{p}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Logs during detection */}
                {preview?.logs && preview.logs.length > 0 && (
                  <div className="preview-log-console">
                    {preview.logs.slice(-6).join("\n")}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ── Starting state: Spinner + logs ── */}
        {isStarting && (
          <div className="preview-start-state">
            <div className="preview-start-spinner" />
            <p className="preview-empty-copy">Starting dev server…</p>
            {preview?.logs && preview.logs.length > 0 && (
              <div className="preview-log-console">
                {preview.logs.slice(-8).join("\n")}
              </div>
            )}
          </div>
        )}

        {/* ── Running state: Iframe + toolbar ── */}
        {isRunning && iframeSrc && (
          <>
            {/* Viewport wrapper */}
            <div className="preview-stage">
              <div
                className="preview-stage-frame"
                style={{
                  width: viewport === "fill" ? "100%" : `${viewport}px`,
                  maxWidth: "100%",
                  height: viewport === "fill" ? "100%" : "100%",
                  minHeight: viewport === "fill" ? undefined : "400px",
                }}
              >
                <iframe
                  ref={iframeRef}
                  src={iframeSrc}
                  className="w-full h-full"
                  sandbox="allow-scripts allow-same-origin"
                  title={`Preview: ${projectName}`}
                />
              </div>
            </div>

            {/* ── Bottom toolbar ── */}
            <div className="preview-toolbar">
              {/* Element picker toggle */}
              <button
                type="button"
                onClick={togglePicker}
                className="preview-tool-button"
                data-active={pickerActive}
                title={pickerActive ? "Click an element in the preview" : "Enter element picker mode"}
              >
                <CrosshairIcon />
                {pickerActive ? "Picking…" : "Pick Element"}
              </button>

              <div className="flex-1" />

              {/* Port selector — shown when multiple ports detected */}
              {preview?.detectedPorts && preview.detectedPorts.length > 1 && (
                <>
                  <div className="preview-toolbar-port-chips">
                    {preview.detectedPorts.map((p) => (
                      <button
                        type="button"
                        key={p}
                        onClick={() => selectPort(p)}
                        className="preview-tool-button"
                        data-active={preview.port === p}
                        title={`Switch to port ${p}`}
                      >
                        :{p}
                      </button>
                    ))}
                  </div>
                  <div className="preview-tool-divider" />
                </>
              )}

              {/* Picked element count */}
              {pickedElements.length > 0 && (
                <span className="preview-tool-count">
                  <SelectIcon />
                  {pickedElements.length}
                </span>
              )}

              {/* Divider */}
              <div className="preview-tool-divider" />

              {/* Viewport cycle */}
              <button
                type="button"
                onClick={cycleViewport}
                className="preview-tool-button"
                title="Cycle viewport size"
              >
                {VIEWPORT_LABELS[viewport]}
              </button>

              {/* Refresh */}
              <button
                type="button"
                onClick={handleRefresh}
                className="preview-tool-button"
                title="Refresh"
              >
                <RefreshIcon />
              </button>

              {/* Open in browser */}
              <button
                type="button"
                onClick={handleOpen}
                className="preview-tool-button"
                title="Open in browser"
              >
                <OpenIcon />
              </button>

              {/* Stop */}
              <button
                type="button"
                onClick={stopPreview}
                className="preview-tool-button"
                title="Stop preview"
              >
                <StopIcon />
              </button>
            </div>
          </>
        )}

        {/* ── Crashed state ── */}
        {preview?.status === "crashed" && (
          <div className="preview-crash-state">
            <div className="preview-crash-icon">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M9 5v4M9 12h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
            </div>
            <p className="preview-error-text">Dev server crashed</p>
            {preview.logs.slice(-5).map((l, i) => (
              <p key={i} className="preview-crash-log">{l}</p>
            ))}
            <button
              type="button"
              onClick={() => startPreview()}
              disabled={starting}
              className="preview-button preview-button--primary"
            >
              {starting ? "Starting..." : "Restart"}
            </button>
          </div>
        )}


      </div>
    </div>
  );
}
