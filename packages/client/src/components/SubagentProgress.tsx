import { useState, useCallback, useEffect, useMemo } from "react";
import type { ToolDetails } from "@pi-web/shared";
import { Icon } from "./Icon";
import { SubagentLiveModal } from "./SubagentLiveModal";
import { formatDuration, formatTokenCount } from "../lib/formatters";

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

function AgentProgressView({ progress, now, onClick }: { progress: AgentProgress; now: number; onClick?: () => void }) {
  const isRunning = progress.status === "running";
  const isDone = progress.status === "completed";
  const isFailed = progress.status === "failed";
  const elapsed = isRunning ? progress.durationMs + (now - (progress.currentToolStartedAt ?? progress.durationMs)) : progress.durationMs;

  return (
    <div className={`conversation-subagent-agent${onClick ? " conversation-subagent-agent-clickable" : ""}`} onClick={onClick} role={onClick ? "button" : undefined} tabIndex={onClick ? 0 : undefined} onKeyDown={onClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } : undefined}>
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

/**
 * Resolve the AgentProgress to display in the modal for a given selectedAgentIndex.
 * Checks live progress first, then falls back to constructing from result data.
 */
function resolveDisplayProgress(
  selectedAgentIndex: number,
  progressList: AgentProgress[],
  results: SubagentDetails["results"],
): AgentProgress | null {
  // Try live progress first
  const sp = progressList.find(p => p.index === selectedAgentIndex);
  if (sp) return sp;

  if (!results) return null;

  // Try r.progress on the result
  for (const r of results) {
    if (r.progress && r.progress.index === selectedAgentIndex) return r.progress;
    // Match by finding progress with same agent name
    const matched = progressList.find(p => p.agent === r.agent);
    if (matched?.index === selectedAgentIndex) return matched;
  }

  // Fallback: construct from result data — try matching by agent name first, then by index
  const result = results.find(r => {
    const matched = progressList.find(p => p.agent === r.agent);
    return matched?.index === selectedAgentIndex;
  }) ?? (progressList.length === 0 && selectedAgentIndex < results.length ? results[selectedAgentIndex] : null);

  if (!result) return null;

  return {
    index: selectedAgentIndex,
    agent: result.agent,
    status: (result.exitCode === 0 ? "completed" : "failed") as AgentProgress["status"],
    task: result.task,
    recentTools: [],
    recentOutput: [],
    toolCount: result.progressSummary?.toolCount ?? 0,
    tokens: result.progressSummary?.tokens ?? 0,
    durationMs: result.progressSummary?.durationMs ?? 0,
    error: result.error,
  } satisfies AgentProgress;
}

export function SubagentProgressView({ details, isRunning }: { details: ToolDetails; isRunning: boolean }) {
  if (!isSubagentDetails(details)) return null;

  const sub = details as SubagentDetails;
  const progressList = sub.progress || [];
  const results = sub.results || [];
  const now = Date.now();

  // Modal state for live view
  const [selectedAgentIndex, setSelectedAgentIndex] = useState<number | null>(null);

  // Reset selectedAgentIndex when the selected agent drops from progressList during running
  useEffect(() => {
    if (selectedAgentIndex !== null && isRunning && !progressList.find(p => p.index === selectedAgentIndex)) {
      setSelectedAgentIndex(null);
    }
  }, [selectedAgentIndex, progressList, isRunning]);

  // Resolve the display progress for the modal
  const displayProgress = useMemo(
    () => selectedAgentIndex !== null ? resolveDisplayProgress(selectedAgentIndex, progressList, results) : null,
    [selectedAgentIndex, progressList, results],
  );

  const handleCloseModal = useCallback(() => {
    setSelectedAgentIndex(null);
  }, []);

  const handleSelectAgent = useCallback((index: number) => {
    setSelectedAgentIndex(index);
  }, []);

  if (isRunning && progressList.length > 0) {
    return (
      <>
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
            <AgentProgressView key={p.index} progress={p} now={now} onClick={() => handleSelectAgent(p.index)} />
          ))}
        </div>
        {displayProgress && (
          <SubagentLiveModal
            progress={displayProgress}
            details={sub}
            onClose={handleCloseModal}
          />
        )}
      </>
    );
  }

  if (results.length > 0) {
    return (
      <>
        <div className="conversation-subagent-progress">
          <div className="conversation-subagent-progress-head">
            <span className="conversation-subagent-mode muted">{sub.mode}</span>
            {sub.context && <span className="conversation-subagent-context">{sub.context}</span>}
          </div>
          {results.map((r, i) => {
            const hasError = r.exitCode !== 0 || r.error;
            const resultProgress = r.progress || progressList.find(p => p.agent === r.agent);
            const handleClick = resultProgress ? () => handleSelectAgent(resultProgress.index) : undefined;
            return (
              <div key={i} className={`conversation-subagent-result${handleClick ? " conversation-subagent-result-clickable" : ""}`} onClick={handleClick} role={handleClick ? "button" : undefined} tabIndex={handleClick ? 0 : undefined} onKeyDown={handleClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleClick(); } } : undefined}>
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
        {displayProgress && (
          <SubagentLiveModal
            progress={displayProgress}
            details={sub}
            onClose={handleCloseModal}
          />
        )}
      </>
    );
  }

  return null;
}

export { isSubagentDetails };
export type { SubagentDetails, AgentProgress };
