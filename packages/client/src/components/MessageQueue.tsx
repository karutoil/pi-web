interface MessageQueueProps {
  steering: string[];
  followUp: string[];
  pendingSteering?: string[];
  pendingFollowUp?: string[];
  onClear: () => void;
}

export function MessageQueue({ steering, followUp, pendingSteering = [], pendingFollowUp = [], onClear }: MessageQueueProps) {
  const steeringSet = new Set(steering.map((t) => t.trim()));
  const followUpSet = new Set(followUp.map((t) => t.trim()));
  const mergedSteering = [...steering, ...pendingSteering.filter((t) => !steeringSet.has(t.trim()))];
  const mergedFollowUp = [...followUp, ...pendingFollowUp.filter((t) => !followUpSet.has(t.trim()))];
  const hasQueue = mergedSteering.length > 0 || mergedFollowUp.length > 0;
  if (!hasQueue) return null;

  return (
    <div className="shrink-0 px-3 py-2 border-t border-ink-800/50 bg-ink-900/30">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className="text-[0.58rem] font-mono font-extrabold uppercase tracking-[0.1em] text-ink-500">
          Queued
        </span>
        <button
          type="button"
          onClick={onClear}
          className="text-[0.6rem] font-mono font-bold uppercase tracking-wider text-ink-500 hover:text-ink-200 transition-colors"
          title="Cancel all queued messages"
          aria-label="Cancel all queued messages"
        >
          Cancel all
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {mergedSteering.map((text, i) => (
          <span
            key={`steer-${i}`}
            className="inline-flex items-center gap-1.5 max-w-full px-2 py-1 rounded-full border border-amber-500/30 bg-amber-500/8 text-amber-400 text-[0.65rem] font-mono"
            title={`Steering: ${text}`}
          >
            <span className="truncate">{text}</span>
            <span className="shrink-0 text-amber-500/60">S</span>
          </span>
        ))}
        {mergedFollowUp.map((text, i) => (
          <span
            key={`follow-${i}`}
            className="inline-flex items-center gap-1.5 max-w-full px-2 py-1 rounded-full border border-violet-400/30 bg-violet-400/8 text-violet-300 text-[0.65rem] font-mono"
            title={`Follow-up: ${text}`}
          >
            <span className="truncate">{text}</span>
            <span className="shrink-0 text-violet-400/60">F</span>
          </span>
        ))}
      </div>
    </div>
  );
}
