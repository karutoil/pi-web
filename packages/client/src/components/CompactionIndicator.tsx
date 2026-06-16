import { useEffect, useState } from "react";
import type { CompactionResultState } from "../lib/types";

interface CompactionIndicatorProps {
  compactionResult: CompactionResultState | null;
  isCompacting: boolean;
  onCompact: (customInstructions?: string) => void;
  onSetAutoCompaction: (enabled: boolean) => void;
  onDismiss?: () => void;
}

const AUTO_DISMISS_MS = 5 * 60 * 1000;

export function CompactionIndicator({ compactionResult, isCompacting, onCompact, onSetAutoCompaction, onDismiss }: CompactionIndicatorProps) {
  const [showCustomCompact, setShowCustomCompact] = useState(false);
  const [customInstructions, setCustomInstructions] = useState("");

  useEffect(() => {
    if (!compactionResult || isCompacting) return;
    const timer = setTimeout(() => {
      onDismiss?.();
    }, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [compactionResult, isCompacting, onDismiss]);

  if (isCompacting) {
    return (
      <div className="conversation-compaction-card" data-loading="true">
        <span className="conversation-loading-spinner conversation-loading-spinner--small" />
        <span>Compacting context...</span>
      </div>
    );
  }

  if (compactionResult && !compactionResult.aborted) {
    const tokensBefore = compactionResult.result?.tokensBefore;
    const summary = compactionResult.result?.summary;
    return (
      <div className="conversation-compaction-card" data-success="true">
        <span>✓</span>
        <div className="conversation-compaction-copy">
          <div>Compacted ({compactionResult.reason})</div>
          {tokensBefore != null && <div className="conversation-muted">Tokens before: {tokensBefore.toLocaleString()}</div>}
          {compactionResult.willRetry && <div className="conversation-warning">Will retry prompt...</div>}
          {summary && <div className="conversation-muted conversation-truncate" title={summary}>{summary.slice(0, 80)}</div>}
        </div>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className="conversation-compaction-dismiss"
            aria-label="Dismiss compaction notice"
          >
            ×
          </button>
        )}
      </div>
    );
  }

  if (compactionResult?.aborted) {
    return (
      <div className="conversation-compaction-card" data-error="true">
        <span>⊘</span>
        <div className="conversation-compaction-copy">
          <span>Compaction aborted</span>
        </div>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className="conversation-compaction-dismiss"
            aria-label="Dismiss compaction notice"
          >
            ×
          </button>
        )}
      </div>
    );
  }

  if (showCustomCompact) {
    return (
      <div className="conversation-compaction-card" data-loading="true">
        <div className="conversation-compaction-copy">
          <textarea
            value={customInstructions}
            onChange={e => setCustomInstructions(e.target.value)}
            placeholder="Custom compaction instructions (optional)..."
            className="conversation-compaction-textarea"
            rows={2}
          />
          <div className="conversation-compaction-actions">
            <button
              type="button"
              onClick={() => { onCompact(customInstructions || undefined); setShowCustomCompact(false); setCustomInstructions(""); }}
              className="conversation-small-button conversation-small-button--primary"
            >
              Compact
            </button>
            <button
              type="button"
              onClick={() => setShowCustomCompact(false)}
              className="conversation-small-button"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
