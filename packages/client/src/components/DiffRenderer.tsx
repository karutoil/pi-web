import { useState, useMemo } from "react";

interface DiffLine {
  type: "add" | "remove" | "context" | "hunk" | "meta";
  content: string;
  lineNum?: { old?: number; new?: number };
}

interface SideBySideRow {
  type: "add" | "remove" | "context" | "hunk" | "meta";
  leftLine?: DiffLine;
  rightLine?: DiffLine;
}

interface Props {
  content: string;
  collapsible?: boolean;
}

export function DiffRenderer({ content, collapsible = true }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [viewMode, setViewMode] = useState<"side" | "unified">("side");

  const { sideBySide, stats } = useMemo(() => {
    const rawLines = content.split("\n");
    const parsed: DiffLine[] = [];
    let oldLine = 0;
    let newLine = 0;
    let added = 0;
    let removed = 0;

    const isDiff = rawLines.some(
      l => l.startsWith("@@") || (l.startsWith("--- ") && l.includes("/")) || (l.startsWith("+++ ") && l.includes("/"))
    );

    if (!isDiff) return { sideBySide: null, stats: null };

    for (const line of rawLines) {
      if (line.startsWith("--- ")) {
        parsed.push({ type: "meta", content: line });
      } else if (line.startsWith("+++ ")) {
        parsed.push({ type: "meta", content: line });
      } else if (line.startsWith("@@")) {
        const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (match) { oldLine = parseInt(match[1]); newLine = parseInt(match[2]); }
        parsed.push({ type: "hunk", content: line });
      } else if (line.startsWith("+") && !line.startsWith("+++")) {
        parsed.push({ type: "add", content: line, lineNum: { new: newLine++ } });
        added++;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        parsed.push({ type: "remove", content: line, lineNum: { old: oldLine++ } });
        removed++;
      } else {
        parsed.push({ type: "context", content: line, lineNum: { old: oldLine++, new: newLine++ } });
      }
    }

    // Build side-by-side rows: pair adjacent deletes + adds, show context on both sides
    const rows: SideBySideRow[] = [];
    let i = 0;
    while (i < parsed.length) {
      const line = parsed[i];
      if (line.type === "meta") {
        rows.push({ type: "meta", leftLine: line, rightLine: line });
        i++;
      } else if (line.type === "hunk") {
        rows.push({ type: "hunk", leftLine: line, rightLine: line });
        i++;
      } else if (line.type === "remove" && i + 1 < parsed.length && parsed[i + 1].type === "add") {
        // Pair: old on left, new on right
        rows.push({ type: "context", leftLine: line, rightLine: parsed[i + 1] });
        i += 2;
      } else if (line.type === "add") {
        rows.push({ type: "add", rightLine: line });
        i++;
      } else if (line.type === "remove") {
        rows.push({ type: "remove", leftLine: line });
        i++;
      } else {
        rows.push({ type: "context", leftLine: line, rightLine: line });
        i++;
      }
    }

    return {
      sideBySide: rows,
      stats: { added, removed, total: parsed.length },
    };
  }, [content]);

  if (!sideBySide || sideBySide.length === 0) return null;

  const previewLimit = 20;
  const needsCollapse = collapsible && sideBySide.length > previewLimit;
  const displayRows = needsCollapse && !expanded ? sideBySide.slice(0, previewLimit) : sideBySide;

  const FileMeta = ({ line }: { line: DiffLine }) => (
    <div className="px-3 py-1 bg-ink-900 text-ink-500 font-semibold text-xs font-mono border-b border-ink-800">
      {line.content}
    </div>
  );

  const HunkHeader = ({ line }: { line: DiffLine }) => (
    <div className="px-3 py-1 bg-amber-500/5 text-amber-400 text-xs font-mono border-b border-ink-800">
      {line.content}
    </div>
  );

  const lineNumCell = (num?: number) => (
    <td className="w-10 text-right pr-2 select-none text-ink-600 text-[0.65rem] align-top py-px">
      {num != null ? num : ""}
    </td>
  );

  const contentCell = (line: DiffLine | undefined, side: "left" | "right") => {
    if (!line || (side === "left" && line.type === "add") || (side === "right" && line.type === "remove")) {
      return <td className="pl-2 py-px align-top text-ink-700">&nbsp;</td>;
    }
    const isAdd = side === "right" && line.type === "add";
    const isRemove = side === "left" && line.type === "remove";
    return (
      <td className={`pl-2 py-px whitespace-pre-wrap break-all font-mono text-[0.72rem] ${
        isAdd ? "text-teal-400" : isRemove ? "text-rose-400" : "text-ink-400"
      }`}>
        {line.content.slice(1)}
      </td>
    );
  };

  const rowBg = (row: SideBySideRow) => {
    if (row.type === "add") return "bg-teal-500/10";
    if (row.type === "remove") return "bg-rose-500/10";
    return "";
  };

  return (
    <div className="my-2 rounded-lg border border-ink-800 overflow-hidden bg-ink-900/30">
      {/* Stats + toggle header */}
      <div className="flex items-center gap-3 px-3 py-1.5 border-b border-ink-800 bg-ink-900 text-xs">
        <span className="text-teal-400 font-medium font-mono">+{stats.added}</span>
        <span className="text-rose-400 font-medium font-mono">-{stats.removed}</span>
        <span className="text-ink-600 font-mono">{stats.total} changes</span>
        <div className="flex-1" />
        <div className="flex rounded border border-ink-700 overflow-hidden">
          <button
            onClick={() => setViewMode("side")}
            className={`px-2 py-0.5 text-[0.65rem] font-mono transition-theme ${
              viewMode === "side" ? "bg-ink-800 text-ink-200" : "text-ink-600 hover:text-ink-400"
            }`}
          >
            Side-by-side
          </button>
          <button
            onClick={() => setViewMode("unified")}
            className={`px-2 py-0.5 text-[0.65rem] font-mono transition-theme border-l border-ink-700 ${
              viewMode === "unified" ? "bg-ink-800 text-ink-200" : "text-ink-600 hover:text-ink-400"
            }`}
          >
            Unified
          </button>
        </div>
      </div>

      {/* Unified view */}
      {viewMode === "unified" && (
        <div className="overflow-x-auto">
          <div className="min-w-[300px]">
            {displayRows.map((row, i) => {
              const line = row.leftLine || row.rightLine;
              if (!line) return null;
              if (row.type === "meta") return <FileMeta key={i} line={line} />;
              if (row.type === "hunk") return <HunkHeader key={i} line={line} />;
              return (
                <div
                  key={i}
                  className={`flex items-start font-mono text-[0.72rem] leading-relaxed ${
                    line.type === "add" ? "bg-teal-500/10" : line.type === "remove" ? "bg-rose-500/10" : ""
                  }`}
                >
                  <div className="w-10 text-right pr-2 select-none text-ink-600 text-[0.65rem] py-px shrink-0">
                    {line.type !== "add" && line.lineNum?.old != null ? line.lineNum.old : ""}
                  </div>
                  <div className="w-10 text-right pr-2 select-none text-ink-600 text-[0.65rem] py-px shrink-0 border-r border-ink-800">
                    {line.type !== "remove" && line.lineNum?.new != null ? line.lineNum.new : ""}
                  </div>
                  <div className={`pl-2 py-px whitespace-pre-wrap break-all min-w-0 flex-1 ${
                    line.type === "add" ? "text-teal-400" : line.type === "remove" ? "text-rose-400" : "text-ink-400"
                  }`}>
                    <span className="select-none">{line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}</span>
                    {line.content.slice(1)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Side-by-side view */}
      {viewMode === "side" && (
        <div className="overflow-x-auto">
          <div className="min-w-[600px]">
            {/* Column headers */}
            <div className="flex border-b border-ink-800 bg-ink-900 text-ink-600 text-[0.6rem] font-mono uppercase tracking-wider">
              <div className="flex-1 flex">
                <div className="w-10 shrink-0 px-1 border-r border-ink-800 py-1">old</div>
                <div className="flex-1 px-2 py-1 border-r-2 border-ink-700">Original</div>
              </div>
              <div className="flex-1 flex">
                <div className="w-10 shrink-0 px-1 border-r border-ink-800 py-1">new</div>
                <div className="flex-1 px-2 py-1">Changed</div>
              </div>
            </div>

            {displayRows.map((row, i) => {
              if (row.type === "meta") return <FileMeta key={i} line={row.leftLine!} />;
              if (row.type === "hunk") return <HunkHeader key={i} line={row.leftLine!} />;

              return (
                <div key={i} className={`flex text-[0.72rem] leading-relaxed ${rowBg(row)}`}>
                  {/* Left side (old) */}
                  <div className="flex-1 flex border-r-2 border-ink-700 min-w-0">
                    {lineNumCell(row.leftLine?.type !== "add" ? row.leftLine?.lineNum?.old : undefined)}
                    {contentCell(row.leftLine, "left")}
                  </div>
                  {/* Right side (new) */}
                  <div className="flex-1 flex min-w-0">
                    {lineNumCell(row.rightLine?.type !== "remove" ? row.rightLine?.lineNum?.new : undefined)}
                    {contentCell(row.rightLine, "right")}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Expand/collapse */}
      {needsCollapse && (
        <button
          onClick={() => setExpanded(e => !e)}
          className="w-full text-center py-1.5 text-xs text-ink-500 hover:text-ink-300 bg-ink-900 border-t border-ink-800 transition-theme font-mono"
        >
          {expanded
            ? "▲ Collapse"
            : `▼ Show all ${sideBySide.length} changes (+${stats.added}/-${stats.removed})`}
        </button>
      )}
    </div>
  );
}

/** Detect if text content looks like a unified diff */
export function isDiffContent(text: string): boolean {
  const lines = text.split("\n").filter(l => l.trim());
  if (lines.length < 3) return false;
  const hasHeader = lines.some(l => l.startsWith("--- ") || l.startsWith("+++ "));
  const hasHunk = lines.some(l => l.startsWith("@@"));
  const hasChanges = lines.some(l => l.startsWith("+") || l.startsWith("-"));
  return hasHunk || (hasHeader && hasChanges);
}
