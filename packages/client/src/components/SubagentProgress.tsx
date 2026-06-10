import type { ToolDetails } from "@pi-web/shared";
import { Icon } from "./Icon";

// ─── Types matching pi-subagents AgentProgress/Details ───

interface AgentProgress {
  index: number;
  agent: string;
  status: "pending" | "running" | "completed" | "failed" | "detached";
  activityState?: "active_long_running" | "needs_attention";
  task: string;
  skills?: string[];
  currentTool?: string;
  currentToolArgs?: string;
  currentToolStartedAt?: number;
  currentPath?: string;
  recentTools: Array<{ tool: string; args: string; endMs: number }>;
  recentOutput: string[];
  toolCount: number;
  turnCount?: number;
  tokens: number;
  durationMs: number;
  error?: string;
}

interface SubagentDetails {
  mode: "single" | "parallel" | "chain" | "management";
  runId?: string;
  context?: "fresh" | "fork";
  results?: Array<{
    agent: string;
    task: string;
    exitCode: number;
    error?: string;
    progress?: AgentProgress;
    progressSummary?: { toolCount: number; tokens: number; durationMs: number };
    finalOutput?: string;
    toolCalls?: Array<{ text: string; expandedText: string }>;
    sessionFile?: string;
  }>;
  progress?: AgentProgress[];
  progressSummary?: { toolCount: number; tokens: number; durationMs: number };
  controlEvents?: Array<{
    type: string;
    agent: string;
    message: string;
    ts: number;
  }>;
  asyncId?: string;
  asyncDir?: string;
  chainAgents?: string[];
  totalSteps?: number;
  currentStepIndex?: number;
}

function isSubagentDetails(d: ToolDetails | undefined): d is ToolDetails & { mode: string; results?: unknown[]; progress?: unknown[] } {
  if (!d) return false;
  return "mode" in d && typeof (d as { mode: unknown }).mode === "string";
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m < 60) return `${m}m ${remS}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

function AgentProgressView({ progress, now }: { progress: AgentProgress; now: number }) {
  const isRunning = progress.status === "running";
  const isDone = progress.status === "completed";
  const isFailed = progress.status === "failed";
  const elapsed = isRunning ? progress.durationMs + (now - (progress.currentToolStartedAt || progress.durationMs)) : progress.durationMs;

  return (
    <div className="conversation-subagent-agent">
      <div className="conversation-subagent-agent-head">
        <span className={`conversation-subagent-agent-name ${isRunning ? "conversation-status-running" : isDone ? "conversation-status-done" : isFailed ? "conversation-status-failed" : ""}`}>
          {progress.agent}
        </span>
        {isRunning && <span className="conversation-subagent-dot conversation-status-running animate-pulse" />}
        {isDone && <span className="conversation-subagent-dot conversation-status-done">✓</span>}
        {isFailed && <span className="conversation-subagent-dot conversation-status-failed">✗</span>}
        {isRunning && <span className="conversation-subagent-meta">{formatDuration(elapsed)}</span>}
        {progress.toolCount > 0 && <span className="conversation-subagent-meta">{progress.toolCount} tools</span>}
        {progress.tokens > 0 && <span className="conversation-subagent-meta">{formatTokenCount(progress.tokens)} tok</span>}
      </div>

      {isRunning && progress.currentTool && (
        <div className="conversation-subagent-tool">
          <Icon name="chevron-right-sm" size={8} className="conversation-status-running" />
          <span>{progress.currentTool}</span>
          {progress.currentToolArgs && <span>{progress.currentToolArgs.slice(0, 60)}</span>}
        </div>
      )}

      {progress.recentOutput.length > 0 && (
        <div className="conversation-subagent-output">
          {progress.recentOutput.slice(-3).map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}

      {progress.error && <div className="conversation-subagent-error">{progress.error}</div>}
    </div>
  );
}

function ChainStepIndicator({
  chainAgents,
  totalSteps,
  currentStepIndex,
}: {
  chainAgents?: string[];
  totalSteps?: number;
  currentStepIndex?: number;
}) {
  if (!chainAgents || chainAgents.length === 0) return null;
  const current = currentStepIndex ?? -1;

  return (
    <div className="conversation-subagent-chain" aria-label={`${current + 1} of ${totalSteps ?? chainAgents.length} steps`}>
      {chainAgents.map((agent, i) => (
        <span key={i} className="conversation-subagent-chain-step">
          {i > 0 && <Icon name="chevron-right-sm" size={8} />}
          <span className={
            i < current ? "conversation-status-done" :
            i === current ? "conversation-status-running font-semibold" :
            ""
          }>
            {agent}
          </span>
          {i === current && <span className="conversation-subagent-dot conversation-status-running animate-pulse" />}
        </span>
      ))}
    </div>
  );
}

export function SubagentProgressView({ details, isRunning }: { details: ToolDetails; isRunning: boolean }) {
  if (!isSubagentDetails(details)) return null;

  const sub = details as SubagentDetails;
  const progressList = sub.progress || [];
  const now = Date.now();

  if (isRunning && progressList.length > 0) {
    return (
      <div className="conversation-subagent-progress">
        <div className="conversation-subagent-progress-head">
          <span className="conversation-subagent-mode">{sub.mode}</span>
          {sub.context && <span className="conversation-subagent-context">{sub.context}</span>}
        </div>
        <ChainStepIndicator
          chainAgents={sub.chainAgents}
          totalSteps={sub.totalSteps}
          currentStepIndex={sub.currentStepIndex}
        />
        {progressList.map((p) => (
          <AgentProgressView key={p.index} progress={p} now={now} />
        ))}
      </div>
    );
  }

  const results = sub.results || [];
  if (results.length > 0) {
    return (
      <div className="conversation-subagent-progress">
        <div className="conversation-subagent-progress-head">
          <span className="conversation-subagent-mode muted">{sub.mode}</span>
          {sub.context && <span className="conversation-subagent-context">{sub.context}</span>}
        </div>
        {results.map((r, i) => {
          const hasError = r.exitCode !== 0 || r.error;
          return (
            <div key={i} className="conversation-subagent-result">
              <div className="conversation-subagent-result-head">
                <span className={hasError ? "conversation-status-failed" : "conversation-status-done"}>
                  {hasError ? "✗" : "✓"}
                </span>
                <span className="conversation-subagent-agent-name">{r.agent}</span>
                {r.progressSummary && (
                  <>
                    <span>{r.progressSummary.toolCount} tools</span>
                    <span>{formatTokenCount(r.progressSummary.tokens)} tok</span>
                    <span>{formatDuration(r.progressSummary.durationMs)}</span>
                  </>
                )}
              </div>
              {r.error && <div className="conversation-subagent-error">{r.error}</div>}
            </div>
          );
        })}
      </div>
    );
  }

  return null;
}

export { isSubagentDetails };
export type { SubagentDetails, AgentProgress };
