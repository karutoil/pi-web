import { useState, useEffect, useMemo } from "react";
import { useIsMobile } from "../hooks/useIsMobile";

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

function FileMeta({ line }: { line: DiffLine }) {
  return (
    <div className="diff-meta">{line.content}</div>
  );
}

function HunkHeader({ line }: { line: DiffLine }) {
  return (
    <div className="diff-hunk">{line.content}</div>
  );
}

export function DiffRenderer({ content, collapsible = true }: Props) {
  const [expanded, setExpanded] = useState(false);
  const isMobile = useIsMobile();
  const [viewMode, setViewMode] = useState<"side" | "unified">("unified");

  useEffect(() => {
    if (isMobile) setViewMode("unified");
  }, [isMobile]);

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

  const lineNumCell = (num?: number) => (
    <td className="diff-line-num-cell">{num != null ? num : ""}</td>
  );

  const contentCell = (line: DiffLine | undefined, side: "left" | "right") => {
    if (!line || (side === "left" && line.type === "add") || (side === "right" && line.type === "remove")) {
      return <td className="diff-empty-cell">&nbsp;</td>;
    }
    const isAdd = side === "right" && line.type === "add";
    const isRemove = side === "left" && line.type === "remove";
    return (
      <td className={`diff-content-cell ${isAdd ? "diff-add-text" : isRemove ? "diff-remove-text" : ""}`}>
        {line.content.slice(1)}
      </td>
    );
  };

  const rowBg = (row: SideBySideRow) => {
    if (row.type === "add") return "diff-add-row";
    if (row.type === "remove") return "diff-remove-row";
    return "";
  };

  return (
    <div className="diff-renderer">
      <div className="diff-toolbar">
        <span className="diff-add-count">+{stats.added}</span>
        <span className="diff-remove-count">-{stats.removed}</span>
        <span>{stats.total} changes</span>
        <div className="diff-toolbar-spacer" />
        {!isMobile && (
        <div className="diff-mode-toggle">
          <button
            type="button"
            onClick={() => setViewMode("side")}
            className={viewMode === "side" ? "active" : ""}
          >
            Side-by-side
          </button>
          <button
            type="button"
            onClick={() => setViewMode("unified")}
            className={viewMode === "unified" ? "active" : ""}
          >
            Unified
          </button>
        </div>
        )}
      </div>

      {viewMode === "unified" && (
        <div className="diff-scroll">
          <div className="diff-unified-min">
            {displayRows.map((row, i) => {
              const line = row.leftLine || row.rightLine;
              if (!line) return null;
              if (row.type === "meta") return <FileMeta key={i} line={line} />;
              if (row.type === "hunk") return <HunkHeader key={i} line={line} />;
              return (
                <div
                  key={i}
                  className={`diff-unified-row ${line.type === "add" ? "diff-add-row" : line.type === "remove" ? "diff-remove-row" : ""}`}
                >
                  {!isMobile && (
                  <div className="diff-line-num">
                    {line.type !== "add" && line.lineNum?.old != null ? line.lineNum.old : ""}
                  </div>
                  )}
                  <div className="diff-line-num diff-line-num-new">
                    {line.type !== "remove" && line.lineNum?.new != null ? line.lineNum.new : ""}
                  </div>
                  <div className={`diff-line-content ${
                    line.type === "add" ? "diff-add-text" : line.type === "remove" ? "diff-remove-text" : ""
                  }`}>
                    <span className="diff-prefix">{line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}</span>
                    {line.content.slice(1)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {viewMode === "side" && (
        <div className="diff-scroll">
          <div className="diff-side-min">
            <div className="diff-side-head">
              <div className="diff-side-pane">
                <div className="diff-side-head-num">old</div>
                <div className="diff-side-head-label">Original</div>
              </div>
              <div className="diff-side-pane">
                <div className="diff-side-head-num">new</div>
                <div className="diff-side-head-label">Changed</div>
              </div>
            </div>

            {displayRows.map((row, i) => {
              if (row.type === "meta") return <FileMeta key={i} line={row.leftLine!} />;
              if (row.type === "hunk") return <HunkHeader key={i} line={row.leftLine!} />;

              return (
                <div key={i} className={`diff-side-row ${rowBg(row)}`}>
                  <div className="diff-side-pane">
                    {lineNumCell(row.leftLine?.type !== "add" ? row.leftLine?.lineNum?.old : undefined)}
                    {contentCell(row.leftLine, "left")}
                  </div>
                  <div className="diff-side-pane">
                    {lineNumCell(row.rightLine?.type !== "remove" ? row.rightLine?.lineNum?.new : undefined)}
                    {contentCell(row.rightLine, "right")}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {needsCollapse && (
        <button
          type="button"
          onClick={() => setExpanded(e => !e)}
          className="diff-collapse"
        >
          {expanded
            ? "▲ Collapse"
            : `▼ Show all ${sideBySide.length} changes (+${stats.added}/-${stats.removed})`}
        </button>
      )}
    </div>
  );
}

export function isDiffContent(text: string): boolean {
  const lines = text.split("\n").filter(l => l.trim());
  if (lines.length < 3) return false;
  const hasHeader = lines.some(l => l.startsWith("--- ") || l.startsWith("+++ "));
  const hasHunk = lines.some(l => l.startsWith("@@"));
  const hasChanges = lines.some(l => l.startsWith("+") || l.startsWith("-"));
  return hasHunk || (hasHeader && hasChanges);
}
