import type { AutoRetryState } from "../lib/types";

interface AutoRetryIndicatorProps {
  autoRetry: AutoRetryState | null;
  onAbort: () => void;
}

export function AutoRetryIndicator({ autoRetry, onAbort }: AutoRetryIndicatorProps) {
  if (!autoRetry) return null;

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-900/60 border border-amber-700/50 rounded-lg text-amber-200 text-xs animate-pulse-subtle">
      <span className="animate-spin-slow">⟳</span>
      <span>Retrying ({autoRetry.attempt}/{autoRetry.maxAttempts})...</span>
      <span className="text-amber-400/70 truncate max-w-32" title={autoRetry.errorMessage}>
        {[...autoRetry.errorMessage].slice(0, 40).join('')}
      </span>
      <button onClick={onAbort}
        className="ml-auto text-amber-400 hover:text-amber-200 transition-colors">Cancel</button>
    </div>
  );
}
