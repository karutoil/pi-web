import { useState } from "react";
import type { ClarifyData, ClarifyStep, ClarifyResult } from "@pi-web/shared";
import { Icon } from "./Icon";

interface Props {
  data: ClarifyData;
  onRespond: (result: ClarifyResult) => void;
}

function StepEditor({
  step,
  index,
  onChange,
}: {
  step: ClarifyStep;
  index: number;
  onChange: (index: number, updated: Partial<ClarifyStep>) => void;
}) {
  return (
    <div className="space-y-2 p-3 bg-ink-950 rounded-lg border border-ink-800">
      {/* Agent header */}
      <div className="flex items-center gap-2">
        <span className="text-amber-400 font-mono text-xs font-medium">{step.agent}</span>
        <span className="text-ink-600 font-mono text-[0.65rem]">step {index + 1}</span>
      </div>

      {/* Task template (editable) */}
      <textarea
        value={step.task}
        onChange={e => onChange(index, { task: e.target.value })}
        className="w-full bg-ink-900 border border-ink-700 rounded px-2 py-1.5 text-ink-100 text-xs font-mono placeholder-ink-600 outline-none focus:border-amber-500 resize-none"
        rows={3}
      />

      {/* Model + output row */}
      <div className="flex gap-2">
        {step.model && (
          <div className="flex-1">
            <label className="text-ink-600 text-[0.6rem] font-mono block mb-0.5">model</label>
            <input
              value={step.model}
              onChange={e => onChange(index, { model: e.target.value })}
              className="w-full bg-ink-900 border border-ink-700 rounded px-2 py-1 text-ink-200 text-xs font-mono outline-none focus:border-amber-500"
            />
          </div>
        )}
        {step.output !== undefined && (
          <div className="flex-1">
            <label className="text-ink-600 text-[0.6rem] font-mono block mb-0.5">output</label>
            <input
              value={step.output || ""}
              onChange={e => onChange(index, { output: e.target.value })}
              className="w-full bg-ink-900 border border-ink-700 rounded px-2 py-1 text-ink-200 text-xs font-mono outline-none focus:border-amber-500"
              placeholder="inline"
            />
          </div>
        )}
      </div>

      {/* Skills */}
      {step.skills && step.skills.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {step.skills.map(s => (
            <span key={s} className="text-[0.6rem] font-mono px-1.5 py-0.5 rounded bg-ink-800 text-ink-400">{s}</span>
          ))}
        </div>
      )}
    </div>
  );
}

export function ClarifyDialog({ data, onRespond }: Props) {
  const [steps, setSteps] = useState<ClarifyStep[]>(data.steps);
  const [runInBackground, setRunInBackground] = useState(false);

  const handleStepChange = (index: number, updates: Partial<ClarifyStep>) => {
    setSteps(prev => prev.map((s, i) => i === index ? { ...s, ...updates } : s));
  };

  const handleConfirm = () => {
    onRespond({
      confirmed: true,
      templates: steps.map(s => s.task),
      behaviorOverrides: steps.map(s => ({
        output: s.output as string | false | undefined,
        reads: s.reads as string[] | false | undefined,
        progress: s.progress,
        model: s.model,
        skills: s.skills as string[] | false | undefined,
      })),
      runInBackground,
    });
  };

  const handleCancel = () => {
    onRespond({
      confirmed: false,
      templates: [],
      behaviorOverrides: [],
    });
  };

  const modeLabel: Record<string, string> = {
    single: "Single Agent",
    parallel: "Parallel Execution",
    chain: "Chain Execution",
  };

  const modeColor: Record<string, string> = {
    single: "text-teal-400 border-teal-500/20 bg-teal-500/5",
    parallel: "text-amber-400 border-amber-500/20 bg-amber-500/5",
    chain: "text-purple-400 border-purple-500/20 bg-purple-500/5",
  };

  return (
    <div className="fixed inset-0 z-60 flex items-center justify-center bg-ink-950/60 backdrop-blur-sm animate-fade-in-up">
      <div className="relative z-70 bg-ink-900 border border-ink-700 rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden mobile-safe-bottom">
        {/* Header */}
        <div className="px-5 py-4 border-b border-ink-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h3 className="text-ink-200 font-medium text-sm">Confirm Execution</h3>
            <span className={`text-[0.65rem] font-mono px-1.5 py-0.5 rounded border ${modeColor[data.mode] || "text-ink-400 border-ink-700 bg-ink-800"}`}>
              {modeLabel[data.mode] || data.mode}
            </span>
          </div>
          <button onClick={handleCancel} className="text-ink-600 hover:text-ink-400 transition-theme" aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </div>

        {/* Original task */}
        {data.originalTask && (
          <div className="px-5 py-2 border-b border-ink-800 bg-ink-950/50">
            <p className="text-ink-500 text-[0.65rem] font-mono mb-0.5">original task</p>
            <p className="text-ink-300 text-xs font-mono line-clamp-2">{data.originalTask}</p>
          </div>
        )}

        {/* Steps */}
        <div className="px-5 py-4 space-y-3 max-h-[50vh] overflow-y-auto custom-scrollbar">
          {/* Chain step indicator */}
          {data.mode === "chain" && steps.length > 1 && (
            <div className="flex items-center gap-1 text-xs font-mono">
              {steps.map((s, i) => (
                <span key={i} className="flex items-center gap-1">
                  {i > 0 && <Icon name="chevron-right-sm" size={8} className="text-ink-700" />}
                  <span className="text-purple-400">{s.agent}</span>
                </span>
              ))}
            </div>
          )}

          {steps.map((step, i) => (
            <StepEditor key={i} step={step} index={i} onChange={handleStepChange} />
          ))}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-ink-800 flex items-center justify-between">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={runInBackground}
              onChange={e => setRunInBackground(e.target.checked)}
              className="accent-amber-500"
            />
            <span className="text-ink-500 text-xs font-mono">Run in background</span>
          </label>
          <div className="flex gap-2">
            <button
              onClick={handleCancel}
              className="px-4 py-1.5 rounded-lg bg-ink-850 hover:bg-ink-800 text-ink-400 text-xs font-mono transition-theme border border-ink-700"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              className="px-4 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-ink-950 text-xs font-mono font-medium transition-theme"
            >
              Confirm {steps.length > 1 ? `${steps.length} steps` : ""}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
