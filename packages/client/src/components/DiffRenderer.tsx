import { useState, useEffect, useMemo } from "react";
import { useIsMobile } from "../hooks/useIsMobile";

interface DiffLine {
  type: "add" | "remove" | "context" | "hunk" | "meta";
  content: string;
  lineNum?: { old?: number; new?: number };
}

interface SideBySideRow {
  type: "add" | "remove" | "edit" | "context" | "hunk" | "meta";
  leftLine?: DiffLine;
  rightLine?: DiffLine;
}

interface DiffFileNames {
  from?: string;
  to?: string;
}

interface DiffStats {
  added: number;
  removed: number;
  total: number;
}

interface ParsedDiff {
  sideBySide: SideBySideRow[] | null;
  stats: DiffStats;
  fileNames: DiffFileNames;
}

interface Props {
  content: string;
  collapsible?: boolean;
}

function cleanFileName(line: string): string {
  return line
    .replace(/^(---|\+\+\+)\s+/, "")
    .replace(/^a\//, "")
    .replace(/^b\//, "")
    .replace(/^\/dev\/null$/, "<empty>");
}

function isSyntheticFileMeta(line: string): boolean {
  return line === "--- a/file" || line === "+++ b/file";
}

function diffTitle(fileNames: DiffFileNames): string {
  if (fileNames.from && fileNames.to && fileNames.from !== fileNames.to) return `${fileNames.from} → ${fileNames.to}`;
  return fileNames.from || fileNames.to || "Diff";
}

function FileMeta({ line }: { line: DiffLine }) {
  return (
    <div className="diff-meta">
      <span className="diff-meta-mark">{line.content.startsWith("+++") ? "new" : "old"}</span>
      {line.content}
    </div>
  );
}

function HunkHeader({ line }: { line: DiffLine }) {
  return (
    <div className="diff-hunk">
      <span className="diff-hunk-mark">@</span>
      {line.content}
    </div>
  );
}

export function DiffRenderer({ content, collapsible = true }: Props) {
  const [expanded, setExpanded] = useState(false);
  const isMobile = useIsMobile();
  const [viewMode, setViewMode] = useState<"side" | "unified">("unified");

  useEffect(() => {
    if (isMobile) setViewMode("unified");
  }, [isMobile]);

  const { sideBySide, stats, fileNames } = useMemo<ParsedDiff>(() => {
    const rawLines = content.replace(/\n$/, "").split("\n");
    const parsed: DiffLine[] = [];
    let oldLine = 0;
    let newLine = 0;
    let added = 0;
    let removed = 0;
    let fileNames: DiffFileNames = {};

    const isDiff = rawLines.some(
      l => l.startsWith("@@") || (l.startsWith("--- ") && l.includes("/")) || (l.startsWith("+++ ") && l.includes("/"))
    );

    if (!isDiff) return { sideBySide: null, stats: { added: 0, removed: 0, total: 0 }, fileNames };

    for (const line of rawLines) {
      if (isSyntheticFileMeta(line)) {
        continue;
      } else if (line.startsWith("--- ")) {
        fileNames.from = cleanFileName(line);
        parsed.push({ type: "meta", content: line });
      } else if (line.startsWith("+++ ")) {
        fileNames.to = cleanFileName(line);
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
        rows.push({ type: "edit", leftLine: line, rightLine: parsed[i + 1] });
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
      stats: { added, removed, total: added + removed },
      fileNames,
    };
  }, [content]);

  if (!sideBySide || sideBySide.length === 0) return null;

  const previewLimit = 20;
  const needsCollapse = collapsible && sideBySide.length > previewLimit;
  const displayRows = needsCollapse && !expanded ? sideBySide.slice(0, previewLimit) : sideBySide;

  const lineNumCell = (num?: number) => (
    <div className={`diff-line-num-cell ${num == null ? "diff-line-num-muted" : ""}`}>{num != null ? num : ""}</div>
  );

  const sidePane = (line: DiffLine | undefined, side: "left" | "right") => {
    const isEmpty = !line || (side === "left" && line.type === "add") || (side === "right" && line.type === "remove");
    const isAdd = side === "right" && line?.type === "add";
    const isRemove = side === "left" && line?.type === "remove";
    let lineNum: number | undefined;
    if (side === "left" && line && line.type !== "add") lineNum = line.lineNum?.old;
    if (side === "right" && line && line.type !== "remove") lineNum = line.lineNum?.new;
    return (
      <div className="diff-side-pane">
        {lineNumCell(lineNum)}
        <div className={`diff-pane-content ${isEmpty ? "diff-pane-empty" : ""} ${isAdd ? "diff-add-text" : isRemove ? "diff-remove-text" : ""}`}>
          {isEmpty ? "" : line?.content.slice(1)}
        </div>
      </div>
    );
  };

  const unifiedLine = (row: SideBySideRow, index: number) => {
    const line = row.leftLine || row.rightLine;
    if (!line) return null;
    if (line.type === "meta") return <FileMeta key={index} line={line} />;
    if (line.type === "hunk") return <HunkHeader key={index} line={line} />;

    return (
      <div key={index} className={`diff-unified-row diff-${line.type}-row`}>
        {!isMobile && (
          <div className={`diff-line-num diff-line-num-old ${line.type === "add" ? "diff-line-num-muted" : ""}`}>
            {line.type !== "add" && line.lineNum?.old != null ? line.lineNum.old : ""}
          </div>
        )}
        <div className={`diff-line-num diff-line-num-new ${line.type === "remove" ? "diff-line-num-muted" : ""}`}>
          {line.type !== "remove" && line.lineNum?.new != null ? line.lineNum.new : ""}
        </div>
        <div className={`diff-line-content diff-${line.type}-text`}>
          <span className="diff-prefix">{line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}</span>
          {line.content.slice(1)}
        </div>
      </div>
    );
  };

  const sideRow = (row: SideBySideRow, index: number) => {
    if (row.type === "meta" || row.type === "hunk") {
      const line = row.leftLine!;
      return (
        <div key={index} className="diff-side-wide">
          {row.type === "meta" ? <FileMeta line={line} /> : <HunkHeader line={line} />}
        </div>
      );
    }

    return (
      <div key={index} className={`diff-side-row diff-${row.type}-row`}>
        {sidePane(row.leftLine, "left")}
        {sidePane(row.rightLine, "right")}
      </div>
    );
  };

  return (
    <div className="diff-renderer">
      <div className="diff-toolbar">
        <div className="diff-toolbar-title">
          <span className="diff-toolbar-label">Diff</span>
          <span className="diff-toolbar-path">{diffTitle(fileNames)}</span>
        </div>
        <div className="diff-toolbar-spacer" />
        <div className="diff-stat-group" aria-label="Diff stats">
          <span className="diff-stat diff-stat-add"><span className="diff-stat-sign">+</span>{stats.added}</span>
          <span className="diff-stat diff-stat-remove"><span className="diff-stat-sign">−</span>{stats.removed}</span>
          <span className="diff-stat-label">{stats.total} changed lines</span>
        </div>
        {!isMobile && (
          <div className="diff-mode-toggle" role="group" aria-label="Diff view mode">
            <button
              type="button"
              onClick={() => setViewMode("side")}
              className={viewMode === "side" ? "active" : ""}
            >
              Side
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
            {displayRows.map(unifiedLine)}
          </div>
        </div>
      )}

      {viewMode === "side" && (
        <div className="diff-scroll">
          <div className="diff-side-min">
            <div className="diff-side-head">
              <div className="diff-side-pane diff-side-head-pane">
                <div className="diff-side-head-num">old</div>
                <div className="diff-side-head-label">Original</div>
              </div>
              <div className="diff-side-pane diff-side-head-pane">
                <div className="diff-side-head-num">new</div>
                <div className="diff-side-head-label">Changed</div>
              </div>
            </div>
            {displayRows.map(sideRow)}
          </div>
        </div>
      )}

      {needsCollapse && (
        <button
          type="button"
          onClick={() => setExpanded(e => !e)}
          className="diff-collapse"
          aria-expanded={expanded}
        >
          {expanded
            ? "▲ Collapse"
            : `▼ Show all ${stats.total} changed lines (+${stats.added}/−${stats.removed})`}
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
