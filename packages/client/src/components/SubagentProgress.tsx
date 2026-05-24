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

// ─── Progress badge for a single running agent ───

function AgentProgressView({ progress, now }: { progress: AgentProgress; now: number }) {
  const isRunning = progress.status === "running";
  const isDone = progress.status === "completed";
  const isFailed = progress.status === "failed";
  const elapsed = isRunning ? (now - progress.durationMs) : progress.durationMs;

  return (
    <div className="space-y-1.5">
      {/* Agent header */}
      <div className="flex items-center gap-2 text-xs font-mono">
        <span className={`font-medium ${isRunning ? "text-amber-400" : isDone ? "text-teal-400" : isFailed ? "text-rose-400" : "text-ink-400"}`}>
          {progress.agent}
        </span>
        {isRunning && <span className="animate-pulse text-amber-400">●</span>}
        {isDone && <span className="text-teal-400">✓</span>}
        {isFailed && <span className="text-rose-400">✗</span>}
        {isRunning && (
          <span className="text-ink-500">{formatDuration(elapsed)}</span>
        )}
        {progress.toolCount > 0 && (
          <span className="text-ink-500">{progress.toolCount} tools</span>
        )}
        {progress.tokens > 0 && (
          <span className="text-ink-500">{formatTokenCount(progress.tokens)} tok</span>
        )}
      </div>

      {/* Current tool indicator */}
      {isRunning && progress.currentTool && (
        <div className="flex items-center gap-1.5 text-xs font-mono pl-2">
          <Icon name="chevron-right-sm" size={8} className="text-amber-400" />
          <span className="text-ink-300">{progress.currentTool}</span>
          {progress.currentToolArgs && (
            <span className="text-ink-500 truncate max-w-[200px]">{progress.currentToolArgs.slice(0, 60)}</span>
          )}
        </div>
      )}

      {/* Recent output tail */}
      {progress.recentOutput.length > 0 && (
        <div className="pl-2 text-xs font-mono text-ink-500 max-h-16 overflow-hidden">
          {progress.recentOutput.slice(-3).map((line, i) => (
            <div key={i} className="truncate">{line}</div>
          ))}
        </div>
      )}

      {/* Error */}
      {progress.error && (
        <div className="pl-2 text-xs font-mono text-rose-400 truncate">{progress.error}</div>
      )}
    </div>
  );
}

// ─── Chain step indicator ───

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
    <div className="flex items-center gap-1 text-xs font-mono mb-2">
      {chainAgents.map((agent, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <Icon name="chevron-right-sm" size={8} className="text-ink-500" />}
          <span className={
            i < current ? "text-teal-400" :
            i === current ? "text-amber-400 font-medium" :
            "text-ink-500"
          }>
            {agent}
          </span>
          {i === current && <span className="animate-pulse text-amber-400">●</span>}
        </span>
      ))}
    </div>
  );
}

// ─── Main subagent progress renderer ───

export function SubagentProgressView({ details, isRunning }: { details: ToolDetails; isRunning: boolean }) {
  if (!isSubagentDetails(details)) return null;

  const sub = details as SubagentDetails;
  const progressList = sub.progress || [];
  const now = Date.now();

  // Running state — show progress for each agent
  if (isRunning && progressList.length > 0) {
    return (
      <div className="space-y-2">
        {/* Mode badge */}
        <div className="flex items-center gap-2">
          <span className="text-[0.65rem] font-mono px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/20">
            {sub.mode}
          </span>
          {sub.context && (
            <span className="text-[0.65rem] font-mono text-ink-500">{sub.context}</span>
          )}
        </div>

        {/* Chain step indicator */}
        <ChainStepIndicator
          chainAgents={sub.chainAgents}
          totalSteps={sub.totalSteps}
          currentStepIndex={sub.currentStepIndex}
        />

        {/* Agent progress cards */}
        {progressList.map((p) => (
          <AgentProgressView key={p.index} progress={p} now={now} />
        ))}
      </div>
    );
  }

  // Completed state — show summary
  const results = sub.results || [];
  if (results.length > 0) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-[0.65rem] font-mono px-1.5 py-0.5 rounded bg-ink-800 text-ink-400 border border-ink-700">
            {sub.mode}
          </span>
          {sub.context && (
            <span className="text-[0.65rem] font-mono text-ink-500">{sub.context}</span>
          )}
        </div>
        {results.map((r, i) => {
          const hasError = r.exitCode !== 0 || r.error;
          return (
            <div key={i} className="space-y-0.5">
              <div className="flex items-center gap-2 text-xs font-mono">
                <span className={hasError ? "text-rose-400" : "text-teal-400"}>
                  {hasError ? "✗" : "✓"}
                </span>
                <span className="font-medium text-ink-300">{r.agent}</span>
                {r.progressSummary && (
                  <>
                    <span className="text-ink-500">{r.progressSummary.toolCount} tools</span>
                    <span className="text-ink-500">{formatTokenCount(r.progressSummary.tokens)} tok</span>
                    <span className="text-ink-500">{formatDuration(r.progressSummary.durationMs)}</span>
                  </>
                )}
              </div>
              {r.error && (
                <div className="pl-4 text-xs font-mono text-rose-400 truncate">{r.error}</div>
              )}
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
