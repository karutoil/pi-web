/**
 * PreviewPanel — Right-side developer viewport.
 *
 * Design direction: Theme-aware "Viewfinder" — a focused observation tool
 * that adapts to both light and dark ink palettes. Uses the same ink color
 * tokens as the rest of the shell, with amber glow accents and monospace
 * precision. No hardcoded dark-mode colors.
 *
 * States:
 *   • Idle       — "Start Preview" button, project name hint
 *   • Starting   — Pulsing amber spinner, dev server logs
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
      <div className="flex flex-col items-center shrink-0 border-l border-ink-800/70 bg-ink-900/35" role="complementary">
        <button
          onClick={() => setOpen(true)}
          className="flex-1 flex flex-col items-center justify-center gap-1.5 px-2 w-9
                     text-ink-500 hover:text-amber-500 hover:bg-ink-850/40 transition-theme
                     group"
          aria-label="Open preview"
          title="Preview"
        >
          <span className="text-xs font-mono opacity-60 group-hover:opacity-100 transition-opacity rotate-90 writing-mode-vertical-rl tracking-widest"
                style={{ textOrientation: "mixed" }}>
            PREVIEW
          </span>
          {preview?.status === "running" && (
            <span className="w-1.5 h-1.5 rounded-full bg-teal-400 animate-pulse shrink-0" />
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
      className="flex flex-col shrink-0 h-full min-h-0 min-w-0 max-h-full max-w-full relative select-none border-l border-ink-800/70 bg-ink-900/35"
      style={{
        width: panelWidth,
        ...(isDragging ? { userSelect: "none", transition: "none" } : {}),
      }}
    >
      {!embedded && (
      <div
        onMouseDown={handleMouseDown}
        className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize z-10 group/handle"
      >
        <div className="absolute left-0 top-1/2 -translate-y-1/2 w-full flex justify-center opacity-0 group-hover/handle:opacity-100 transition-opacity">
          <div className="w-0.5 h-10 rounded-full bg-ink-600/60" />
        </div>
      </div>
      )}

      {/* ── Header bar — matches ChannelList project header pattern ── */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-ink-800/40 shrink-0"
           style={{ paddingLeft: "1.25rem" }}>
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="text-ink-500 font-mono text-[0.65rem] tracking-[0.15em] uppercase truncate">
            {projectName}
          </span>
          {isRunning && (
            <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[0.55rem] font-mono
                           bg-teal-400/10 text-teal-500 border border-teal-400/20">
              <span className="w-1 h-1 rounded-full bg-teal-400" />
              {preview?.remoteUrl ? "Remote" : "Live"}
            </span>
          )}
          {isRunning && preview?.remoteUrl && (
            <span className="text-ink-600 font-mono text-[0.55rem] truncate" title={preview.remoteUrl}>
              {preview.remoteUrl.replace(/^https?:\/\//, "")}
            </span>
          )}
          {isDetecting && (
            <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[0.55rem] font-mono
                           bg-ink-400/10 text-ink-500 border border-ink-400/20">
              <span className="w-1 h-1 rounded-full bg-ink-500 animate-pulse" />
              Detecting
            </span>
          )}
          {isStarting && (
            <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[0.55rem] font-mono
                           bg-amber-400/10 text-amber-500 border border-amber-400/20">
              <span className="w-1 h-1 rounded-full bg-amber-500 animate-pulse" />
              Starting
            </span>
          )}
          {preview?.status === "crashed" && (
            <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[0.55rem] font-mono
                           bg-rose-400/10 text-rose-400 border border-rose-400/20">
              <span className="w-1 h-1 rounded-full bg-rose-400" />
              Crashed
            </span>
          )}
        </div>

        {!embedded && (
        <button
          onClick={() => setOpen(false)}
          className="p-1.5 rounded-md text-ink-500 hover:text-ink-200 hover:bg-ink-800/50 transition-theme"
          aria-label="Close preview"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
        </button>
        )}
      </div>

      {/* ── Content area ── */}
      <div className="flex-1 flex flex-col min-h-0 min-w-0">

        {/* ── Idle / Detecting state (also shown when stopped) ── */}
        {(!preview || preview.status === "stopped" || isDetecting) && (
          <div className="flex-1 flex flex-col items-center justify-center gap-5 p-6 relative">
            {/* Ambient glow — uses ink tokens for theme-safe tinting */}
            <div className="absolute inset-0 overflow-hidden pointer-events-none">
              <div className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2
                            w-48 h-48 rounded-full bg-amber-500/[0.03] blur-3xl" />
            </div>

            {!isDetecting ? (
              /* ── Truly idle: show Start button + manual port/URL input ── */
              <>
                <div className="flex flex-col items-center gap-3 relative">
                  <div className="w-12 h-12 rounded-2xl border border-ink-700/60 flex items-center justify-center
                                bg-ink-850/40 shadow-[0_0_32px_rgba(212,160,32,0.04)]
                                text-amber-500">
                    <PlayIcon />
                  </div>
                  <p className="text-ink-400 text-sm font-mono text-center leading-relaxed max-w-[220px]">
                    {inputMode === "url" ? "Proxy to a remote URL" : "Run your dev server"}
                  </p>
                </div>

                {/* Input mode toggle — mirrors ChannelList search bar styling */}
                <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-ink-950/40 border border-ink-800/40">
                  <button
                    onClick={() => setInputMode("port")}
                    className={`px-3 py-1 rounded-md font-mono text-[0.65rem] transition-all
                      ${inputMode === "port"
                        ? "bg-ink-800/80 text-ink-200"
                        : "text-ink-500 hover:text-ink-300"
                      }`}
                  >
                    Port
                  </button>
                  <button
                    onClick={() => setInputMode("url")}
                    className={`px-3 py-1 rounded-md font-mono text-[0.65rem] transition-all
                      ${inputMode === "url"
                        ? "bg-ink-800/80 text-ink-200"
                        : "text-ink-500 hover:text-ink-300"
                      }`}
                  >
                    URL
                  </button>
                </div>

                {/* Manual port or URL input */}
                {inputMode === "port" ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      value={manualPort}
                      onChange={(e) => setManualPort(e.target.value)}
                      placeholder="Port (auto)"
                      className="w-28 px-3 py-2 rounded-lg bg-ink-950/40 border border-ink-700/60
                               font-mono text-xs text-ink-300 placeholder:text-ink-600
                               focus:border-amber-500/40 focus:outline-none transition-theme"
                    />
                    <button
                      onClick={() => {
                        const p = parseInt(manualPort, 10);
                        startPreview(p > 0 && p < 65536 ? p : undefined);
                      }}
                      disabled={starting}
                      className="relative px-5 py-2 rounded-xl font-mono text-sm font-medium
                               bg-amber-500/[0.08] border border-amber-500/25
                               text-amber-500
                               hover:border-amber-400/45 hover:bg-amber-500/[0.14]
                               active:scale-[0.97]
                               transition-all duration-200
                               shadow-[0_8px_24px_-8px_rgba(212,160,32,0.08)]
                               disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {starting ? (
                        <span className="flex items-center gap-2">
                          <span className="w-3 h-3 border-2 border-amber-500/40 border-t-amber-500 rounded-full animate-spin" />
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
                  <div className="flex items-center gap-2">
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
                      className="w-52 px-3 py-2 rounded-lg bg-ink-950/40 border border-ink-700/60
                               font-mono text-xs text-ink-300 placeholder:text-ink-600
                               focus:border-amber-500/40 focus:outline-none transition-theme"
                    />
                    <button
                      onClick={() => {
                        if (remoteUrl.trim()) startPreview(undefined, remoteUrl.trim());
                      }}
                      disabled={starting || !remoteUrl.trim()}
                      className="relative px-5 py-2 rounded-xl font-mono text-sm font-medium
                               bg-amber-500/[0.08] border border-amber-500/25
                               text-amber-500
                               hover:border-amber-400/45 hover:bg-amber-500/[0.14]
                               active:scale-[0.97]
                               transition-all duration-200
                               shadow-[0_8px_24px_-8px_rgba(212,160,32,0.08)]
                               disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {starting ? (
                        <span className="flex items-center gap-2">
                          <span className="w-3 h-3 border-2 border-amber-500/40 border-t-amber-500 rounded-full animate-spin" />
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
                  <p className="text-rose-400 text-xs font-mono text-center max-w-[260px] leading-relaxed">
                    {startError}
                  </p>
                )}
              </>
            ) : (
              /* ── Detecting: spinner + detected ports ── */
              <>
                <div className="w-10 h-10 border-2 border-ink-700 border-t-amber-500 rounded-full animate-spin" />
                <p className="text-ink-400 text-sm font-mono">
                  {preview?.detectedPorts && preview.detectedPorts.length > 0
                    ? "Select a port"
                    : "Detecting ports…"}
                </p>

                {/* Port chips */}
                {preview?.detectedPorts && preview.detectedPorts.length > 0 && (
                  <div className="flex flex-col items-center gap-2 mt-1">
                    <p className="text-ink-500 text-[0.55rem] font-mono uppercase tracking-widest">Found</p>
                    <div className="flex gap-1.5 flex-wrap justify-center">
                      {preview.detectedPorts.map((p) => (
                        <button
                          key={p}
                          onClick={() => selectPort(p)}
                          className={`px-3 py-1.5 rounded-lg font-mono text-sm transition-all
                            ${preview.port === p
                              ? "bg-amber-500/[0.12] text-amber-500 border border-amber-500/25 shadow-[0_0_12px_rgba(212,160,32,0.06)]"
                              : "bg-ink-850/40 text-ink-400 border border-ink-800 hover:border-ink-600 hover:text-ink-200"
                            }`}
                        >
                          :{p}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Logs during detection */}
                {preview?.logs && preview.logs.length > 0 && (
                  <div className="mt-4 w-full max-w-xs max-h-24 overflow-y-auto rounded-lg bg-ink-950/40 border border-ink-800/40 p-3
                                font-mono text-[0.6rem] text-ink-500 leading-relaxed whitespace-pre-wrap">
                    {preview.logs.slice(-6).join("\n")}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ── Starting state: Spinner + logs ── */}
        {isStarting && (
          <div className="flex-1 flex flex-col items-center justify-center gap-4 p-6">
            <div className="w-10 h-10 border-2 border-ink-700 border-t-amber-500 rounded-full animate-spin" />
            <p className="text-ink-400 text-sm font-mono">Starting dev server…</p>
            {preview?.logs && preview.logs.length > 0 && (
              <div className="mt-4 w-full max-w-xs max-h-32 overflow-y-auto rounded-lg bg-ink-950/40 border border-ink-800/40 p-3
                            font-mono text-[0.6rem] text-ink-500 leading-relaxed whitespace-pre-wrap">
                {preview.logs.slice(-8).join("\n")}
              </div>
            )}
          </div>
        )}

        {/* ── Running state: Iframe + toolbar ── */}
        {isRunning && iframeSrc && (
          <>
            {/* Viewport wrapper — uses ink tokens instead of bg-white */}
            <div className="flex-1 flex items-start justify-center overflow-auto bg-ink-950/40 p-1">
              <div
                className="relative transition-all duration-300 overflow-hidden rounded-md shadow-2xl
                          border border-ink-800/50"
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
                  className="w-full h-full border-0 bg-ink-950"
                  sandbox="allow-scripts allow-same-origin"
                  title={`Preview: ${projectName}`}
                />
              </div>
            </div>

            {/* ── Bottom toolbar — matches ChannelList footer pattern ── */}
            <div className="flex items-center gap-0.5 px-2 py-1.5 border-t border-ink-800/40 shrink-0
                          bg-ink-950/40">
              {/* Element picker toggle */}
              <button
                onClick={togglePicker}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg font-mono text-[0.65rem] font-medium
                          transition-all duration-200
                          ${pickerActive
                            ? "bg-amber-500/[0.12] text-amber-500 border border-amber-400/40 shadow-[0_0_12px_rgba(212,160,32,0.08)]"
                            : "text-ink-500 hover:text-ink-200 hover:bg-ink-800/50 border border-transparent"
                          }`}
                title={pickerActive ? "Click an element in the preview" : "Enter element picker mode"}
              >
                <CrosshairIcon />
                {pickerActive ? "Picking…" : "Pick Element"}
              </button>

              <div className="flex-1" />

              {/* Port selector — shown when multiple ports detected */}
              {preview?.detectedPorts && preview.detectedPorts.length > 1 && (
                <>
                  <div className="flex items-center gap-0.5">
                    {preview.detectedPorts.map((p) => (
                      <button
                        key={p}
                        onClick={() => selectPort(p)}
                        className={`px-2 py-1 rounded font-mono text-[0.6rem] transition-all
                          ${preview.port === p
                            ? "bg-amber-500/[0.1] text-amber-500 border border-amber-500/20"
                            : "text-ink-500 hover:text-ink-200 hover:bg-ink-800/50 border border-transparent"
                          }`}
                        title={`Switch to port ${p}`}
                      >
                        :{p}
                      </button>
                    ))}
                  </div>
                  <div className="w-px h-5 bg-ink-800/60 mx-1" />
                </>
              )}

              {/* Picked element count */}
              {pickedElements.length > 0 && (
                <span className="flex items-center gap-1 px-2 py-1 rounded-lg font-mono text-[0.6rem]
                               bg-amber-500/[0.08] text-amber-500 border border-amber-500/20">
                  <SelectIcon />
                  {pickedElements.length}
                </span>
              )}

              {/* Divider */}
              <div className="w-px h-5 bg-ink-800/60 mx-1" />

              {/* Viewport cycle */}
              <button
                onClick={cycleViewport}
                className="px-2 py-1.5 rounded-lg font-mono text-[0.6rem] text-ink-500
                         hover:text-ink-200 hover:bg-ink-800/50 transition-theme min-w-[48px]"
                title="Cycle viewport size"
              >
                {VIEWPORT_LABELS[viewport]}
              </button>

              {/* Refresh */}
              <button
                onClick={handleRefresh}
                className="p-1.5 rounded-lg text-ink-500 hover:text-ink-200 hover:bg-ink-800/50 transition-theme"
                title="Refresh"
              >
                <RefreshIcon />
              </button>

              {/* Open in browser */}
              <button
                onClick={handleOpen}
                className="p-1.5 rounded-lg text-ink-500 hover:text-ink-200 hover:bg-ink-800/50 transition-theme"
                title="Open in browser"
              >
                <OpenIcon />
              </button>

              {/* Stop */}
              <button
                onClick={stopPreview}
                className="p-1.5 rounded-lg text-ink-500 hover:text-rose-400 hover:bg-rose-400/10 transition-theme"
                title="Stop preview"
              >
                <StopIcon />
              </button>
            </div>
          </>
        )}

        {/* ── Crashed state ── */}
        {preview?.status === "crashed" && (
          <div className="flex-1 flex flex-col items-center justify-center gap-4 p-6">
            <div className="w-10 h-10 rounded-full bg-rose-400/10 border border-rose-400/20 flex items-center justify-center text-rose-400">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M9 5v4M9 12h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
            </div>
            <p className="text-rose-400 text-sm font-mono text-center">Dev server crashed</p>
            {preview.logs.slice(-5).map((l, i) => (
              <p key={i} className="text-ink-500 text-[0.6rem] font-mono max-w-xs text-center truncate">{l}</p>
            ))}
            <button
              onClick={() => startPreview()}
              disabled={starting}
              className="px-5 py-2 rounded-xl font-mono text-sm font-medium
                       bg-amber-500/[0.08] border border-amber-500/25 text-amber-500
                       hover:border-amber-400/45 hover:bg-amber-500/[0.14]
                       transition-all duration-200
                       disabled:opacity-50"
            >
              {starting ? "Starting..." : "Restart"}
            </button>
          </div>
        )}


      </div>
    </div>
  );
}
