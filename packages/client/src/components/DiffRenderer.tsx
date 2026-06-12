import { useMemo, useState } from "react";
import { FileDiff } from "@pierre/diffs/react";
import { useTheme } from "../hooks/useTheme";
import { parsePatchFiles, registerCustomTheme } from "@pierre/diffs";
import { piDiffDark, piDiffLight } from "../themes/piDiffTheme";
import type { FileDiffMetadata } from "@pierre/diffs";

registerCustomTheme("pi-web-diff-dark", () => Promise.resolve(piDiffDark));
registerCustomTheme("pi-web-diff-light", () => Promise.resolve(piDiffLight));

interface Props {
  content: string;
  collapsible?: boolean;
  disableFileHeader?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

export function DiffRenderer({
  content,
  collapsible = true,
  disableFileHeader = false,
  className = "",
  style,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [theme] = useTheme();

  const fileDiffs = useMemo<FileDiffMetadata[]>(() => {
    try {
      return parsePatchFiles(content).flatMap((p) => p.files);
    } catch {
      return [];
    }
  }, [content]);

  const lineCount = content.split("\n").length;
  const needsCollapse = collapsible && lineCount > 20;

  // If it doesn't look like a diff and we can't parse one, render nothing.
  if (fileDiffs.length === 0 && !isDiffContent(content)) {
    return null;
  }

  const options = useMemo(
    () => ({
      theme: theme === "dark" ? "pi-web-diff-dark" : "pi-web-diff-light",
      diffStyle: "unified" as const,
      hunkSeparators: "line-info" as const,
      disableFileHeader,
      overflow: "wrap" as const,
      disableWorkerPool: true,
      // Force a layout re-measure after the first paint to work around a
      // first-mount/ResizeObserver issue inside animated flex panels.
      onPostRender(_node: HTMLElement, instance: { rerender: () => void }, phase: string) {
        if (phase === "mount") {
          requestAnimationFrame(() => {
            try { instance.rerender(); } catch {}
          });
        }
      },
    }),
    [disableFileHeader, theme]
  );

  // Host `<diffs-container>` is inline by default; make it block so
  // it participates in flex/block flow correctly.
  const hostStyle: React.CSSProperties = {
    display: "block",
    minWidth: 0,
  };

  return (
    <div
      className={`diff-renderer ${className}`}
      style={{
        ...style,
        ...(needsCollapse && !expanded ? { maxHeight: "480px", overflow: "hidden" } : {}),
      }}
    >
      {fileDiffs.length === 0 ? (
        <pre className="whitespace-pre-wrap font-mono text-xs p-2">{content}</pre>
      ) : (
        fileDiffs.map((fileDiff, i) => (
          <FileDiff key={i} fileDiff={fileDiff} options={options} style={hostStyle} />
        ))
      )}
      {needsCollapse && (
        <button
          type="button"
          className="diff-collapse"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "▲ Collapse" : `▼ Show all ${lineCount} lines`}
        </button>
      )}
    </div>
  );
}

export function isDiffContent(text: string): boolean {
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length < 3) return false;
  const hasHeader = lines.some((l) => l.startsWith("--- ") || l.startsWith("+++ "));
  const hasHunk = lines.some((l) => l.startsWith("@@"));
  const hasChanges = lines.some((l) => l.startsWith("+") || l.startsWith("-"));
  return hasHunk || (hasHeader && hasChanges);
}
