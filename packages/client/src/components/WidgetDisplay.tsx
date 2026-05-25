interface WidgetDisplayProps {
  widgets: Record<string, { lines: string[]; placement: string }>;
  placement: "aboveEditor" | "belowEditor";
}

/** Strip ANSI escape sequences from text */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\].*?\x07/g, "");
}

export function WidgetDisplay({ widgets, placement }: WidgetDisplayProps) {
  const entries = Object.entries(widgets).filter(([, w]) => w.placement === placement);
  if (entries.length === 0) return null;

  return (
    <div className="flex flex-col gap-1 px-4 md:px-6 overflow-x-auto">
      {entries.map(([key, widget]) => (
        <div key={key} className="px-3 py-1.5 bg-ink-950/60 backdrop-blur-sm border border-ink-800/50 rounded-lg text-ink-400 text-xs font-mono">
          {widget.lines.map((line, i) => (
            <div key={i} className="whitespace-pre-wrap">{stripAnsi(line)}</div>
          ))}
        </div>
      ))}
    </div>
  );
}
