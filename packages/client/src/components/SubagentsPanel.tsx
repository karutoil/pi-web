import { useState, useEffect, useCallback, useRef } from "react";
import type { Project, SubagentAsyncRun, SubagentRunListResponse } from "@pi-web/shared";
import { Icon } from "./Icon";
import { formatDuration, formatTokenCount } from "../lib/formatters";

const POLL_MS = 2500;

interface SubagentsPanelProps {
  visible: boolean;
  project: Project | null;
  /** WebSocket pool — used to send a resume prompt to the agent. */
  onSendPrompt?: (text: string) => void;
  onClose?: () => void;
  embedded?: boolean;
}

type RunState = SubagentAsyncRun["state"];

function stateLabel(s: RunState): string {
  switch (s) {
    case "queued": return "Queued";
    case "running": return "Running";
    case "complete": return "Complete";
    case "failed": return "Failed";
    case "paused": return "Paused";
    default: return s;
  }
}

function stateClass(s: RunState): string {
  switch (s) {
    case "running": return "conversation-status-running";
    case "complete": return "conversation-status-done";
    case "failed": return "conversation-status-failed";
    case "paused": return "conversation-status-pending";
    case "queued": return "conversation-status-pending";
    default: return "";
  }
}

function activityLabel(a: SubagentAsyncRun["activityState"]): string | null {
  if (a === "needs_attention") return "⚠ Needs attention";
  if (a === "active_long_running") return "⏳ Long running";
  return null;
}

function nowElapsed(startedAt: number, endedAt?: number, currentToolStartedAt?: number): number {
  if (endedAt) return endedAt - startedAt;
  const ref = currentToolStartedAt ?? Date.now();
  return Math.max(0, ref - startedAt);
}

function RunCard({
  run,
  onInterrupt,
  onResume,
  onToggleOutput,
  expanded,
  output,
  loadingOutput,
}: {
  run: SubagentAsyncRun;
  onInterrupt: (runId: string) => void;
  onResume: (runId: string, agent?: string) => void;
  onToggleOutput: (runId: string) => void;
  expanded: boolean;
  output: string[];
  loadingOutput: boolean;
}) {
  const isRunning = run.state === "running";
  const isPaused = run.state === "paused";
  const isFailed = run.state === "failed";
  const elapsed = nowElapsed(run.startedAt, run.endedAt, run.currentToolStartedAt);
  const canInterrupt = isRunning && typeof run.pid === "number";
  const canResume = isPaused || isFailed;
  const activity = activityLabel(run.activityState);
  const totalTokens = run.totalTokens?.total ?? run.steps.reduce((sum, s) => sum + (s.tokens?.total ?? 0), 0);

  return (
    <div className={`subagents-panel-card${isRunning ? " subagents-panel-card-running" : ""}`}>
      <div className="subagents-panel-card-head">
        <span className={`subagents-panel-badge ${stateClass(run.state)}`}>{stateLabel(run.state)}</span>
        <span className="subagents-panel-mode">{run.mode}</span>
        {activity && <span className="subagents-panel-activity">{activity}</span>}
      </div>

      <div className="subagents-panel-agents">
        {(run.agents && run.agents.length > 0 ? run.agents : run.agent ? [run.agent] : run.steps.map(s => s.agent)).map((a, i) => (
          <span key={i} className="subagents-panel-agent-chip">{a}</span>
        ))}
      </div>

      {isRunning && run.currentTool && (
        <div className="subagents-panel-current-tool">
          <Icon name="chevron-right-sm" size={8} className="conversation-status-running" />
          <span>{run.currentTool}</span>
          {run.currentPath && <span className="subagents-panel-tool-path">{run.currentPath}</span>}
        </div>
      )}

      {(run.chainStepCount ?? run.steps.length) > 1 && (
        <div className="subagents-panel-chain" aria-label="chain steps">
          {run.steps.map((step, i) => {
            const cur = run.currentStep === i;
            const done = (run.currentStep ?? -1) > i || step.status === "completed" || step.status === "complete";
            return (
              <span key={i} className="subagents-panel-chain-step">
                {i > 0 && <Icon name="chevron-right-sm" size={8} />}
                <span className={done ? "conversation-status-done" : cur ? "conversation-status-running font-semibold" : ""}>{step.agent}</span>
                {cur && <span className="subagents-panel-dot conversation-status-running animate-pulse" />}
              </span>
            );
          })}
        </div>
      )}

      <div className="subagents-panel-stats">
        <span title="elapsed">{formatDuration(elapsed)}</span>
        {run.toolCount !== undefined && run.toolCount > 0 && <span>{run.toolCount} tools</span>}
        {run.turnCount !== undefined && run.turnCount > 0 && <span>{run.turnCount} turns</span>}
        {totalTokens > 0 && <span>{formatTokenCount(totalTokens)} tok</span>}
      </div>

      {run.error && <div className="subagents-panel-error">{run.error}</div>}

      <div className="subagents-panel-actions">
        {canInterrupt && (
          <button className="subagents-panel-action" onClick={() => onInterrupt(run.runId)} title="Soft-interrupt the current turn (run pauses)">
            Interrupt
          </button>
        )}
        {canResume && (
          <button className="subagents-panel-action" onClick={() => onResume(run.runId, run.agent)} title="Ask the agent to resume this run">
            Resume
          </button>
        )}
        <button className="subagents-panel-action subagents-panel-action-secondary" onClick={() => onToggleOutput(run.runId)}>
          {expanded ? "Hide output" : "View output"}
        </button>
      </div>

      {expanded && (
        <div className="subagents-panel-output">
          {loadingOutput ? (
            <div className="subagents-panel-output-loading">Loading…</div>
          ) : output.length > 0 ? (
            output.map((line, i) => <div key={i} className={line.startsWith("▸") ? "subagents-panel-output-event" : ""}>{line}</div>)
          ) : (
            <div className="subagents-panel-output-empty">No output yet</div>
          )}
        </div>
      )}
    </div>
  );
}

export function SubagentsPanel({ visible, project, onSendPrompt, onClose, embedded }: SubagentsPanelProps) {
  const [runs, setRuns] = useState<SubagentAsyncRun[]>([]);
  const [available, setAvailable] = useState(true);
  const [asyncDirRoot, setAsyncDirRoot] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [output, setOutput] = useState<Record<string, string[]>>({});
  const [loadingOutput, setLoadingOutput] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const projectId = project?.id;

  const flash = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }, []);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/subagents`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: SubagentRunListResponse & { available?: boolean } = await res.json();
      setRuns(data.runs);
      setAvailable(data.available ?? true);
      setAsyncDirRoot(data.asyncDirRoot ?? "");
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [projectId]);

  // Poll while the panel is visible.
  useEffect(() => {
    if (!visible) return;
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [visible, refresh]);

  const handleInterrupt = useCallback(async (runId: string) => {
    if (!projectId) return;
    setBusy(b => ({ ...b, [runId]: true }));
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/subagents/${encodeURIComponent(runId)}/interrupt`, { method: "POST" });
      const data = await res.json();
      flash(data.message ?? (data.ok ? "Interrupted" : "Failed"));
      if (data.ok) setTimeout(refresh, 400);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(b => ({ ...b, [runId]: false }));
    }
  }, [projectId, refresh, flash]);

  const handleResume = useCallback((runId: string, _agent?: string) => {
    // Resume must go through the agent (revives a child from its session file).
    const instruction = `subagent({ action: "resume", id: "${runId}" })`;
    if (onSendPrompt) {
      onSendPrompt(`Please resume the background subagent run ${runId}.\n\n\`${instruction}\``);
      flash(`Asked agent to resume ${runId.slice(0, 8)}`);
    } else {
      flash("No agent connection available to resume");
    }
  }, [onSendPrompt, flash]);

  const handleToggleOutput = useCallback(async (runId: string) => {
    setExpandedRun(prev => (prev === runId ? null : runId));
    if (output[runId] !== undefined) return;
    if (!projectId) return;
    setLoadingOutput(b => ({ ...b, [runId]: true }));
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/subagents/${encodeURIComponent(runId)}/output`);
      const data = await res.json();
      setOutput(prev => ({ ...prev, [runId]: data.lines ?? [] }));
    } catch {
      setOutput(prev => ({ ...prev, [runId]: [] }));
    } finally {
      setLoadingOutput(b => ({ ...b, [runId]: false }));
    }
  }, [projectId, output]);

  const running = runs.filter(r => r.state === "running").length;
  const others = runs.filter(r => r.state !== "running").length;

  return (
    <div className={`subagents-panel${embedded ? " subagents-panel-embedded" : ""}`}>
      <div className="subagents-panel-header">
        <div className="subagents-panel-header-left">
          <span className="subagents-panel-title">Subagents</span>
          {running > 0 && <span className="subagents-panel-count conversation-status-running">{running} running</span>}
          {others > 0 && <span className="subagents-panel-count">{others} other</span>}
        </div>
        <button className="subagents-panel-refresh" onClick={refresh} title="Refresh" aria-label="Refresh">
          <Icon name="refresh" size={12} />
        </button>
      </div>

      {toast && <div className="subagents-panel-toast">{toast}</div>}
      {error && <div className="subagents-panel-error">Failed to load: {error}</div>}

      {runs.length === 0 ? (
        <div className="subagents-panel-empty">
          <Icon name="pi-logo" size={32} className="subagents-panel-empty-icon" />
          <p className="subagents-panel-empty-title">No background runs</p>
          <p className="subagents-panel-empty-copy">
            {available
              ? "Async subagent runs will appear here live. Launch one with subagent({ async: true, ... }) and watch its progress."
              : "Install the pi-subagents extension to enable background subagents."}
          </p>
          {asyncDirRoot && (
            <p className="subagents-panel-empty-meta" title={asyncDirRoot}>scanning: {asyncDirRoot}</p>
          )}
        </div>
      ) : (
        <div className="subagents-panel-list">
          {runs.map(run => (
            <RunCard
              key={run.runId}
              run={run}
              onInterrupt={handleInterrupt}
              onResume={handleResume}
              onToggleOutput={handleToggleOutput}
              expanded={expandedRun === run.runId}
              output={output[run.runId] ?? []}
              loadingOutput={!!loadingOutput[run.runId]}
            />
          ))}
        </div>
      )}
    </div>
  );
}
