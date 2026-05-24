import { useState } from "react";
import type { CompactionResultState } from "../lib/types";

interface CompactionIndicatorProps {
  compactionResult: CompactionResultState | null;
  isCompacting: boolean;
  onCompact: (customInstructions?: string) => void;
  onSetAutoCompaction: (enabled: boolean) => void;
}

export function CompactionIndicator({ compactionResult, isCompacting, onCompact, onSetAutoCompaction }: CompactionIndicatorProps) {
  const [showCustomCompact, setShowCustomCompact] = useState(false);
  const [customInstructions, setCustomInstructions] = useState("");

  if (isCompacting) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 bg-blue-900/40 border border-blue-700/30 rounded-lg text-blue-300 text-xs">
        <span className="animate-spin-slow">⏳</span>
        <span>Compacting context...</span>
      </div>
    );
  }

  if (compactionResult && !compactionResult.aborted) {
    const tokensBefore = compactionResult.result?.tokensBefore;
    const summary = compactionResult.result?.summary;
    return (
      <div className="flex items-start gap-2 px-3 py-2 bg-green-900/30 border border-green-700/30 rounded-lg text-green-300 text-xs">
        <span>✓</span>
        <div className="flex-1 min-w-0">
          <div>Compacted ({compactionResult.reason})</div>
          {tokensBefore != null && <div className="text-green-400/60">Tokens before: {tokensBefore.toLocaleString()}</div>}
          {compactionResult.willRetry && <div className="text-amber-400">Will retry prompt...</div>}
          {summary && <div className="text-green-400/60 mt-1 truncate" title={summary}>{summary.slice(0, 80)}</div>}
        </div>
      </div>
    );
  }

  if (compactionResult?.aborted) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 bg-ink-800 border border-ink-700 rounded-lg text-ink-400 text-xs">
        <span>⊘</span>
        <span>Compaction aborted</span>
      </div>
    );
  }

  // No compaction in progress — show manual trigger
  if (showCustomCompact) {
    return (
      <div className="flex flex-col gap-2 px-3 py-2 bg-ink-800 border border-ink-700 rounded-lg text-xs">
        <textarea
          value={customInstructions}
          onChange={e => setCustomInstructions(e.target.value)}
          placeholder="Custom compaction instructions (optional)..."
          className="w-full bg-ink-900 text-ink-200 px-2 py-1.5 rounded border border-ink-700 focus:border-accent-500 focus:outline-none text-xs resize-none"
          rows={2}
        />
        <div className="flex items-center gap-2">
          <button onClick={() => { onCompact(customInstructions || undefined); setShowCustomCompact(false); setCustomInstructions(""); }}
            className="px-3 py-1 bg-accent-600 hover:bg-accent-500 text-white rounded transition-colors">
            Compact
          </button>
          <button onClick={() => setShowCustomCompact(false)}
            className="px-3 py-1 text-ink-400 hover:text-ink-200 transition-colors">
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return null;
}
