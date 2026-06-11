import { useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import type { AgentProgress, SubagentDetails } from "./SubagentProgress";
import { Icon } from "./Icon";
import { useIsMobile } from "../hooks/useIsMobile";
import { formatDuration, formatTokenCount } from "../lib/formatters";

function formatTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function statusLabel(s: AgentProgress["status"]): string {
  switch (s) {
    case "pending": return "Pending";
    case "running": return "Running";
    case "completed": return "Completed";
    case "failed": return "Failed";
    case "detached": return "Detached";
    default: return s;
  }
}

function statusClass(s: AgentProgress["status"]): string {
  switch (s) {
    case "running": return "conversation-status-running";
    case "completed": return "conversation-status-done";
    case "failed": return "conversation-status-failed";
    case "pending": return "conversation-status-pending";
    default: return "";
  }
}

// ─── Tool History Item ───

function ToolHistoryItem({ tool, args, endMs }: { tool: string; args: string; endMs: number }) {
  const isMobile = useIsMobile();
  const argsDisplay = args.length > (isMobile ? 60 : 120) ? args.slice(0, isMobile ? 60 : 120) + "…" : args;

  return (
    <div className="subagent-modal-history-item">
      <span className="subagent-modal-history-time">{formatTime(endMs)}</span>
      <span className="subagent-modal-history-tool">{tool}</span>
      {argsDisplay && <span className="subagent-modal-history-args">{argsDisplay}</span>}
    </div>
  );
}

// ─── Main Modal ───

interface SubagentLiveModalProps {
  progress: AgentProgress;
  details: SubagentDetails;
  onClose: () => void;
}

export function SubagentLiveModal({ progress, details, onClose }: SubagentLiveModalProps) {
  const outputRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const now = Date.now();
  const isAgentRunning = progress.status === "running";
  const isAgentDone = progress.status === "completed";
  const isAgentFailed = progress.status === "failed";
  const elapsed = isAgentRunning ? progress.durationMs + (now - (progress.currentToolStartedAt ?? progress.durationMs)) : progress.durationMs;

  // Auto-scroll output to bottom
  useEffect(() => {
    if (outputRef.current && isAgentRunning) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [progress.recentOutput, isAgentRunning]);

  // Close on Escape with preventDefault
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // Prevent body scroll when modal is open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Focus management: save previous focus, set initial focus, restore on unmount
  // Also apply `inert` to the app root to create a focus trap
  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement;
    // Set inert on the app root to prevent focus from escaping behind the modal
    const appRoot = document.getElementById('root');
    if (appRoot) appRoot.inert = true;
    // Focus the container on next tick to allow portal mount
    requestAnimationFrame(() => {
      containerRef.current?.focus();
    });
    return () => {
      if (appRoot) appRoot.inert = false;
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, []);

  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  }, [onClose]);

  const recentTools = [...progress.recentTools].reverse(); // newest first

  return createPortal(
    <div className="subagent-modal-backdrop" onClick={handleBackdropClick}>
      <div
        ref={containerRef}
        className="subagent-modal-container"
        role="dialog"
        aria-modal="true"
        aria-label={`Subagent ${progress.agent} live view`}
        tabIndex={-1}
      >
        {/* Header */}
        <div className="subagent-modal-header">
          <div className="subagent-modal-header-left">
            <span className={`subagent-modal-agent-name ${statusClass(progress.status)}`}>
              {progress.agent}
            </span>
            {isAgentRunning && <span className="subagent-modal-dot conversation-status-running animate-pulse" />}
            {isAgentDone && <span className="subagent-modal-dot conversation-status-done">✓</span>}
            {isAgentFailed && <span className="subagent-modal-dot conversation-status-failed">✗</span>}
            <span className={`subagent-modal-status-badge ${statusClass(progress.status)}`}>
              {statusLabel(progress.status)}
            </span>
          </div>
          <div className="subagent-modal-header-right">
            <span className="subagent-modal-stat">{formatDuration(elapsed)}</span>
            {progress.toolCount > 0 && <span className="subagent-modal-stat">{progress.toolCount} tools</span>}
            {progress.tokens > 0 && <span className="subagent-modal-stat">{formatTokenCount(progress.tokens)} tok</span>}
            {progress.turnCount !== undefined && progress.turnCount > 0 && (
              <span className="subagent-modal-stat">{progress.turnCount} turns</span>
            )}
            <button className="subagent-modal-close" onClick={onClose} aria-label="Close">
              <Icon name="close" size={14} />
            </button>
          </div>
        </div>

        {/* Task */}
        <div className="subagent-modal-section">
          <div className="subagent-modal-section-label">Task</div>
          <div className="subagent-modal-task">{progress.task}</div>
        </div>

        {/* Current Tool (only while running) */}
        {isAgentRunning && progress.currentTool && (
          <div className="subagent-modal-section subagent-modal-current-tool">
            <div className="subagent-modal-section-label">
              <Icon name="chevron-right-sm" size={8} className="conversation-status-running" />
              Active Tool
            </div>
            <div className="subagent-modal-tool-name">{progress.currentTool}</div>
            {progress.currentToolArgs && (
              <pre className="subagent-modal-tool-args">{progress.currentToolArgs}</pre>
            )}
            {progress.currentPath && (
              <div className="subagent-modal-tool-path">{progress.currentPath}</div>
            )}
          </div>
        )}

        {/* Activity State */}
        {progress.activityState && (
          <div className="subagent-modal-activity">
            <span className={`subagent-modal-activity-badge subagent-modal-activity-${progress.activityState}`}>
              {progress.activityState === "active_long_running" ? "⏳ Long Running" : "⚠️ Needs Attention"}
            </span>
          </div>
        )}

        {/* Live Output */}
        {progress.recentOutput.length > 0 && (
          <div className="subagent-modal-section subagent-modal-output-section">
            <div className="subagent-modal-section-label">
              Output
              {isAgentRunning && <span className="subagent-modal-live-indicator">LIVE</span>}
            </div>
            <div className="subagent-modal-output" ref={outputRef} aria-live="polite" aria-atomic="false">
              {progress.recentOutput.map((line, i) => (
                <div key={i} className="subagent-modal-output-line">{line}</div>
              ))}
              {isAgentRunning && <span className="subagent-modal-cursor">▌</span>}
            </div>
          </div>
        )}

        {/* Tool History */}
        {recentTools.length > 0 && (
          <div className="subagent-modal-section">
            <div className="subagent-modal-section-label">
              Tool History
              <span className="subagent-modal-count">{recentTools.length}</span>
            </div>
            <div className="subagent-modal-history">
              {recentTools.map((t, i) => (
                <ToolHistoryItem key={i} tool={t.tool} args={t.args} endMs={t.endMs} />
              ))}
            </div>
          </div>
        )}

        {/* Error */}
        {progress.error && (
          <div className="subagent-modal-section">
            <div className="subagent-modal-section-label">Error</div>
            <div className="subagent-modal-error">{progress.error}</div>
          </div>
        )}

        {/* Context info */}
        <div className="subagent-modal-footer">
          <span className="subagent-modal-footer-item">
            {details.mode} mode
          </span>
          {details.context && (
            <span className="subagent-modal-footer-item">
              {details.context} context
            </span>
          )}
          {details.runId && (
            <span className="subagent-modal-footer-item">
              run: {details.runId.slice(0, 8)}
            </span>
          )}
          {details.asyncId && (
            <span className="subagent-modal-footer-item">
              async: {details.asyncId.slice(0, 8)}
            </span>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
