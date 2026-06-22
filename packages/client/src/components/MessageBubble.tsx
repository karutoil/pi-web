import { useState, useMemo, useRef, useEffect, memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import type { ChatMessage, ContentBlock, ToolDetails } from "@pi-web/shared";
import type { ToolEvent } from "../lib/types";
import { formatTokens } from "../lib/utils";
import { DiffRenderer, isDiffContent } from "./DiffRenderer";
import { Icon, type IconName } from "./Icon";
import { ContextMenuPortal, ContextMenuItem, ContextMenuDivider, useLongPress } from "./ContextMenu";
import { SubagentProgressView, isSubagentDetails } from "./SubagentProgress";
import { messageToMarkdown, copyToClipboard } from "../lib/markdownExport";
import { SkillCard, parseSkillBlocks } from "./SkillCard";

interface MessageBubbleProps {
  message: ChatMessage;
  showThinking: boolean;
  toolResultsMap?: Map<string, ChatMessage>;
  inlineToolCallIds?: Set<string>;
  runningTools?: Map<string, ToolEvent>;
  isHistorical?: boolean;
  isStreaming?: boolean;
  entryId?: string;
  onFork?: (entryId: string) => void;
  /**
   * Copy the entire turn (last user message → final assistant response) as
   * raw markdown. Parent owns the turn context.
   */
  onCopyTurn?: (msg: ChatMessage) => void;
}

function toolAccentKind(name?: string): string {
  const n = (name || "").toLowerCase();
  if (["bash", "shell", "exec", "run", "run_type_check"].some(k => n === k || n.includes(k))) return "bash";
  if (["edit", "write", "patch", "refactor", "format", "replace"].some(k => n.includes(k))) return "edit";
  if (["read", "ls", "list", "find", "grep", "search", "glob", "stat", "lsp_", "xref_"].some(k => n.includes(k))) return "read";
  if (["skill"].some(k => n.includes(k))) return "skill";
  if (["subagent", "agent", "task"].some(k => n.includes(k))) return "agent";
  return "default";
}

/** Leading glyph for a tool — one icon per tool family. */
function toolIconName(name?: string): IconName {
  const n = (name || "").toLowerCase();
  if (n === "bash" || n === "shell" || n === "run" || n === "run_type_check") return "terminal";
  if (n.includes("replace") || n.includes("edit") || n.includes("write") || n.includes("patch")) return "pencil";
  if (n === "read") return "file";
  if (n.includes("search") || n.includes("grep") || n.includes("find") || n.includes("glob") || n.includes("xref_") || n.includes("lsp_")) return "search";
  if (n === "ls" || n.includes("list")) return "folder";
  if (n.includes("skill")) return "puzzle";
  if (n.includes("subagent") || n.includes("agent") || n.includes("task")) return "fork";
  return "spark";
}

/** Human-readable one-liner for a tool call's args — replaces raw JSON. */
function summarizeToolCall(name: string, args: Record<string, unknown>): string {
  const n = (name || "").toLowerCase();
  const str = (v: unknown): string => typeof v === "string" ? v : "";
  const num = (v: unknown): number | undefined => typeof v === "number" ? v : undefined;
  const compact = (s: string) => s.replace(/\s+/g, " ").trim();
  try {
    if (n === "bash") {
      return compact(str(args.command)).replace(/^cd\s+\S+\s*&&\s*/, "");
    }
    if (n === "run" || n === "run_type_check") {
      const cmd = compact(str(args.command)) || (n === "run_type_check" ? str(args.path) : "");
      const cwd = str(args.cwd);
      return [cmd, cwd && `· ${cwd}`].filter(Boolean).join(" ");
    }
    if (n === "read") {
      const path = str(args.path);
      const off = num(args.offset);
      const lim = num(args.limit);
      let s = path;
      if (off != null) s += `:${off}`;
      if (lim != null) s += `+${lim}`;
      return s;
    }
    if (n === "search") {
      const pat = str(args.pattern);
      const scope = str(args.path) || str(args.glob);
      return [pat, scope && `in ${scope}`].filter(Boolean).join(" ");
    }
    if (n.includes("replace") || n.includes("edit") || n.includes("write") || n.includes("patch")) {
      const path = str(args.path) || str(args.file) || str(args.file_path) || str(args.filePath);
      const edits = Array.isArray(args.edits) ? args.edits.length : 0;
      return [path, edits && `${edits} ${edits === 1 ? "edit" : "edits"}`].filter(Boolean).join(" · ");
    }
    if (n.includes("lsp_")) return str(args.path) || n;
    if (n === "xref_project") return str(args.path) || "project";
    if (n === "subagent" || n.includes("agent") || n.includes("task")) {
      const agent = str(args.agent);
      const action = str(args.action);
      if (agent) return agent;
      if (action) return action;
      return "delegate";
    }
    if (n.includes("skill")) return str(args.name) || "skill";
  } catch {
    /* fall through to generic */
  }
  // Generic fallback: a few compact key:value chips.
  const entries = Object.entries(args || {}).slice(0, 3);
  if (!entries.length) return "";
  return entries.map(([k, v]) => {
    const s = typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "";
    return s ? `${k}: ${s.length > 32 ? s.slice(0, 32) + "…" : s}` : "";
  }).filter(Boolean).join("  ");
}

// ─── TextWithSkills ────────────────────────────────────────

/**
 * Renders a text string that may contain `<skill>…</skill>` blocks.
 * Text segments flow through the same ReactMarkdown pipeline used for
 * plain assistant text; skill blocks become <SkillCard> children sitting
 * as siblings of the markdown wrapper, so they keep their own borders
 * and don't fight the prose styles.
 */
function TextWithSkills({ text, isStreaming }: { text: string; isStreaming?: boolean }) {
  const segments = parseSkillBlocks(text);
  // Fast path: no skill blocks → render as a single markdown block
  if (segments.length === 1 && segments[0].type === "text") {
    if (isDiffContent(segments[0].content)) {
      return <DiffRenderer content={segments[0].content} />;
    }
    return (
      <div
            className={`conversation-markdown prose prose-invert max-w-none text-ink-100 text-sm leading-relaxed markdown-content ${
          isStreaming ? "cursor-blink" : ""
        }`}
      >
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeSanitize]}
          components={{
            pre: CodeBlock,
            table: ({ children }) => (
              <div className="table-wrap">
                <table>{children}</table>
              </div>
            ),
          }}
        >
          {segments[0].content}
        </ReactMarkdown>
      </div>
    );
  }

  // Mixed: render each segment in its own wrapper, preserving order.
  return (
    <div className="space-y-2">
      {segments.map((seg, i) => {
        if (seg.type === "skill") {
          return (
            <SkillCard
              key={`s${i}`}
              name={seg.name}
              location={seg.location}
              content={seg.content}
            />
          );
        }
        if (!seg.content.trim()) return null;
        if (isDiffContent(seg.content)) {
          return <DiffRenderer key={`t${i}`} content={seg.content} />;
        }
        return (
          <div
            key={`t${i}`}
        className={`conversation-markdown prose prose-invert max-w-none text-ink-100 text-sm leading-relaxed markdown-content ${
              isStreaming ? "cursor-blink" : ""
            }`}
          >
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeSanitize]}
              components={{
                pre: CodeBlock,
                table: ({ children }) => (
                  <div className="table-wrap">
                    <table>{children}</table>
                  </div>
                ),
              }}
            >
              {seg.content}
            </ReactMarkdown>
          </div>
        );
      })}
    </div>
  );
}

function MessageBubbleImpl({ message, showThinking, toolResultsMap, inlineToolCallIds, runningTools, isHistorical, isStreaming, entryId, onFork, onCopyTurn }: MessageBubbleProps) {
  const role = message.role;
  const isUser = role === "user";
  const isAssistant = role === "assistant";
  const isTool = role === "toolResult";
  const isBash = role === "bashExecution";
  const isSystem = role === "branchSummary" || role === "compactionSummary";

  // Right-click context menu
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; copied?: "message" | "turn" } | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => { if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current); };
  }, []);
  const flashCopied = (kind: "message" | "turn") => {
    setCtxMenu(prev => (prev ? { ...prev, copied: kind } : prev));
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => {
      setCtxMenu(prev => (prev ? { ...prev, copied: undefined } : prev));
    }, 1200);
  };
  const handleContextMenu = (e: React.MouseEvent) => {
    // Only show context menu on user or assistant messages
    if (isUser || isAssistant) {
      e.preventDefault();
      setCtxMenu({ x: e.clientX, y: e.clientY });
    }
  };

  // Long-press for mobile context menu
  const longPress = useLongPress((e) => {
    if (isUser || isAssistant) {
      setCtxMenu({ x: e.clientX, y: e.clientY });
    }
  });

  if (isSystem) {
    return <SystemBubble message={message} />;
  }

  // Skip standalone tool result bubble if its call is rendered inline in an assistant message
  if (isTool && message.toolCallId && inlineToolCallIds?.has(message.toolCallId)) {
    return null;
  }

  return (
    <div onContextMenu={handleContextMenu} {...longPress} className={`conversation-message-row min-w-0 ${isUser ? "justify-end" : ""}`} data-user={isUser} data-historical={isHistorical ? "true" : "false"}>
      {!isUser && (
        <div className="conversation-avatar">
          <Icon name="pi-avatar" size={12} />
        </div>
      )}
      
      <div className={`conversation-bubble ${isUser ? "" : "conversation-assistant-bubble"}`}>
        {/* Tool execution */}
        {isTool && (
          <ToolResultBubble message={message} />
        )}

        {/* Bash execution */}
        {isBash && (
          <BashResultBubble message={message} />
        )}

        {/* Assistant message */}
        {isAssistant && (
          <AssistantBubble
            message={message}
            toolResultsMap={toolResultsMap}
            inlineToolCallIds={inlineToolCallIds}
            runningTools={runningTools}
            showThinking={showThinking}
            isHistorical={isHistorical}
            isStreaming={isStreaming}
          />
        )}

        {/* User message */}
        {isUser && (
          <UserBubble message={message} entryId={entryId} onFork={onFork} />
        )}

        {/* Timestamp / metadata */}
        {!isStreaming && (
          <div className="conversation-metadata" data-user={isUser}>
            {message.model && <span>{message.model}</span>}
            {message.usage && (
              <span className="conversation-metadata-tokens">
                {formatTokens(message.usage.input + (message.usage.output || 0))} tokens
              </span>
            )}
            {message.stopReason === "aborted" && (
              <span className="conversation-metadata-error">aborted</span>
            )}
            {message.stopReason === "error" && (
              <span className="conversation-metadata-error">error</span>
            )}
          </div>
        )}
      </div>

      {/* Right-click context menu — copy this message, the whole turn */}
      {ctxMenu && (
        <ContextMenuPortal
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
        >
          <ContextMenuItem
            label={ctxMenu.copied === "message" ? "Copied ✓" : "Copy message"}
            icon={<Icon name="copy-plain" size={10} />}
            onClick={() => {
              copyToClipboard(messageToMarkdown(message));
              flashCopied("message");
            }}
          />
          <ContextMenuItem
            label={ctxMenu.copied === "turn" ? "Copied ✓" : "Copy entire turn"}
            icon={<Icon name="copy-join" size={10} />}
            onClick={() => {
              onCopyTurn?.(message);
              flashCopied("turn");
            }}
          />
        </ContextMenuPortal>
      )}
    </div>
  );
}

// Memoized so historical bubbles skip re-render during streaming. Stable
// props (memoized maps + stable onCopyTurn) keep this effective.
export const MessageBubble = memo(MessageBubbleImpl);

function UserBubble({ message, entryId, onFork }: { message: ChatMessage; entryId?: string; onFork?: (id: string) => void }) {
  const text = extractTextContent(message.content);
  const imageBlocks = extractImageBlocks(message.content);
  const segments = text ? parseSkillBlocks(text) : [];

  return (
    <div className="conversation-user-bubble group relative">
      {text && (
        segments.length === 1 && segments[0].type === "text" ? (
          <p className="conversation-user-text">
            {segments[0].content}
          </p>
        ) : (
          <div className="conversation-user-text-stack">
            {segments.map((seg, i) =>
              seg.type === "skill" ? (
                <SkillCard
                  key={i}
                  name={seg.name}
                  location={seg.location}
                  content={seg.content}
                />
              ) : seg.content.trim() ? (
                <p key={i} className="conversation-user-text">
                  {seg.content}
                </p>
              ) : null
            )}
          </div>
        )
      )}
      {imageBlocks.length > 0 && (
        <div className={`conversation-user-images ${text ? "mt-2" : ""}`}>
          {imageBlocks.map((img, i) => (
            <img
              key={i}
              src={`data:${img.mimeType};base64,${img.data}`}
              alt={`Attachment ${i + 1}`}
              className="conversation-user-image"
            />
          ))}
        </div>
      )}
      {entryId && onFork && (
        <button
          onClick={() => onFork(entryId)}
          className="conversation-fork-button"
          title="Fork from here"
          aria-label="Fork from here"
        >
          <Icon name="fork-left" size={14} />
        </button>
      )}
    </div>
  );
}

function AssistantBubble({
  message,
  toolResultsMap,
  runningTools,
  showThinking,
  isHistorical,
  isStreaming,
}: {
  message: ChatMessage;
  toolResultsMap?: Map<string, ChatMessage>;
  inlineToolCallIds?: Set<string>;
  runningTools?: Map<string, ToolEvent>;
  showThinking: boolean;
  isHistorical?: boolean;
  isStreaming?: boolean;
}) {
  const content = Array.isArray(message.content) ? message.content : [];
  const [toolCallsExpanded, setToolCallsExpanded] = useState<Record<string, boolean>>({});

  // Separate thinking blocks from text
  const thinkingBlocks = content.filter(b => b.type === "thinking");
  const toolCalls = content.filter(b => b.type === "toolCall");
  const textBlocks = content.filter(b => b.type === "text");
  
  const hasContent = textBlocks.length > 0 || (thinkingBlocks.length > 0 && showThinking) || toolCalls.length > 0;

  if (!hasContent && !isStreaming) return null;

  return (
    <div className="space-y-3">
      {/* Thinking blocks */}
      {showThinking && thinkingBlocks.map((block, i) => (
        <ThinkingBlock key={i} thinking={block.thinking || ""} />
      ))}

      {/* Streaming thinking indicator */}
      {isStreaming && thinkingBlocks.length === 0 && textBlocks.length === 0 && (
        <div className="conversation-streaming-thought">
          <span className="conversation-thinking-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span>Thinking</span>
        </div>
      )}

      {/* Text content */}
      {textBlocks.map((block, i) => {
        const text = block.text || "";
        return <TextWithSkills key={i} text={text} isStreaming={isStreaming} />;
      })}

      {/* Tool calls */}
      {toolCalls.map((block, i) => (
        <CombinedToolBubble
          key={block.id || i}
          toolCall={block}
          toolResult={block.id ? toolResultsMap?.get(block.id) : undefined}
          runningTool={block.id ? runningTools?.get(block.id) : undefined}
          expanded={toolCallsExpanded[block.id || String(i)] ?? false}
          onToggle={() => {
            const key = block.id || String(i);
            setToolCallsExpanded(prev => ({ ...prev, [key]: !prev[key] }));
          }}
        />
      ))}
    </div>
  );
}

function ThinkingBlock({ thinking }: { thinking: string }) {
  const [open, setOpen] = useState(false);
  const clean = thinking.replace(/\x1b\[[0-9;]*m/g, "");
  const lineCount = clean.split("\n").length;

  return (
    <div className="conversation-thinking-block" data-open={open ? "true" : "false"}>
      <button
        onClick={() => setOpen(o => !o)}
        className="conversation-reasoning-toggle"
        aria-expanded={open}
        aria-label="Toggle reasoning"
      >
        <Icon name="chevron-right-sm" size={9} className={`conversation-tool-caret ${open ? "is-open" : ""}`} />
        <span className="conversation-reasoning-glyph" aria-hidden="true">
          <Icon name="spark" size={12} />
        </span>
        <span className="conversation-reasoning-label">Reasoning</span>
        {!open && lineCount > 0 && (
          <span className="conversation-reasoning-count">{lineCount} {lineCount === 1 ? "line" : "lines"}</span>
        )}
      </button>
      <div className="conversation-reasoning-body-wrap">
        <div className="conversation-reasoning-body">
          {clean}
        </div>
      </div>
    </div>
  );
}

/** Combined tool call + result bubble — shows request header and result body in one unit */
function CombinedToolBubble({
  toolCall,
  expanded,
  onToggle,
  toolResult,
  runningTool,
}: {
  toolCall: { id?: string; name?: string; arguments?: Record<string, unknown> };
  expanded: boolean;
  onToggle: () => void;
  toolResult?: ChatMessage;
  runningTool?: ToolEvent;
}) {
  const name = toolCall.name || "unknown";
  const args = toolCall.arguments || {};
  const summary = summarizeToolCall(name, args);
  const isRunning = runningTool && runningTool.status === "running";
  const isDone = !!toolResult || (runningTool && runningTool.status === "done");
  const isError = toolResult?.isError || (runningTool && runningTool.status === "error");
  const accentKind = toolAccentKind(name);

  // Determine result content for inline rendering
  const resultContent = useMemo(() => {
    if (!toolResult) return null;
    return extractTextContent(toolResult.content);
  }, [toolResult]);

  // Parse diff from tool result details
  const detailsDiff = useMemo(() => {
    if (!toolResult?.details?.diff || typeof toolResult.details.diff !== "string") return null;
    const rawDiff: string = toolResult.details.diff;
    if (rawDiff.trim() === '') return null;
    const rawLines = rawDiff.split("\n");
    const parts: string[] = [];
    parts.push("--- a/file");
    parts.push("+++ b/file");
    parts.push(`@@ -1,${rawLines.length} +1,${rawLines.length} @@`);
    for (const line of rawLines) {
      const prefix = line.charAt(0);
      const rest = line.slice(1).replace(/^\d+\s*/, "");
      if (prefix === "-" || prefix === "+" || prefix === " ") {
        parts.push(prefix + rest);
      } else {
        parts.push(" " + line);
      }
    }
    return parts.join("\n");
  }, [toolResult?.details?.diff]);

  const isDiffResult = !!(detailsDiff || (resultContent && !isError && isDiffContent(resultContent)));
  const hasBody = !!(resultContent || isRunning);

  return (
    <div
      className={`conversation-tool-bubble conversation-tool-bubble--${accentKind}${isError ? " conversation-tool-bubble-error" : ""}${isRunning ? " conversation-tool-bubble-running" : ""}${hasBody ? " has-body" : " no-body"}`}
    >
      {/* Header: glyph + tool name + human summary + status pill */}
      <button
        onClick={onToggle}
        className="conversation-tool-header"
        aria-expanded={hasBody ? expanded : undefined}
        aria-label="Toggle tool details"
      >
        <Icon name="chevron-right-sm" size={9} className={`conversation-tool-caret ${expanded ? "is-open" : ""}`} />
        <span className="conversation-tool-glyph" aria-hidden="true">
          <Icon name={toolIconName(name)} size={13} />
        </span>
        <span className="conversation-tool-name">{name}</span>
        {summary && <span className="conversation-tool-summary">{summary}</span>}
        <span className="conversation-tool-pills">
          {isRunning && (
            <span className="conversation-tool-pill conversation-tool-pill--running">
              <span className="conversation-tool-pill-spin" aria-hidden="true" />
              Running
            </span>
          )}
          {isDone && !isError && (
            <span className="conversation-tool-pill conversation-tool-pill--done">
              <Icon name="check" size={9} />
              Done
            </span>
          )}
          {isError && (
            <span className="conversation-tool-pill conversation-tool-pill--error">
              <Icon name="close" size={9} />
              Error
            </span>
          )}
        </span>
      </button>

      {/* Animated body: result content */}
      <div className="conversation-tool-body-wrap" data-open={hasBody && expanded ? "true" : "false"}>
        <div className="conversation-tool-body-inner">
          {hasBody && (
            <>
              {/* Diff result */}
              {isDiffResult && (
                <div className="conversation-tool-body conversation-diff-panel">
                  {detailsDiff ? (
                    <DiffRenderer key={detailsDiff} content={detailsDiff} collapsible={false} />
                  ) : resultContent ? (
                    <DiffRenderer key={resultContent} content={resultContent} collapsible={false} />
                  ) : null}
                </div>
              )}

              {/* Subagent progress — rich rendering for subagent/extension tools */}
              {isRunning && !isDiffResult && runningTool.partialResult?.details && isSubagentDetails(runningTool.partialResult.details) && (
                <div className="conversation-tool-body conversation-subagent-panel">
                  <SubagentProgressView details={runningTool.partialResult.details} isRunning={true} />
                </div>
              )}

              {/* Generic running indicator — for non-subagent tools */}
              {isRunning && !isDiffResult && !(runningTool.partialResult?.details && isSubagentDetails(runningTool.partialResult.details)) && (
                <div className="conversation-tool-body conversation-running-panel">
                  <span className="conversation-running-label">Running…</span>
                  {runningTool.partialResult?.content && (
                    <pre className="conversation-result-pre">
                      {extractTextContent(runningTool.partialResult.content as ContentBlock[] | string)}
                    </pre>
                  )}
                </div>
              )}

              {/* Completed subagent result — show structured summary */}
              {!isDiffResult && !isRunning && (toolResult?.details || runningTool?.result?.details) && isSubagentDetails(toolResult?.details || runningTool?.result?.details) && (
                <div className="conversation-tool-body conversation-subagent-panel">
                  <SubagentProgressView details={(toolResult?.details || runningTool?.result?.details)!} isRunning={false} />
                </div>
              )}

              {/* Text result (non-diff, non-subagent) */}
              {!isDiffResult && !isRunning && resultContent && !(toolResult?.details && isSubagentDetails(toolResult.details)) && !isSubagentDetails(runningTool?.result?.details) && (
                <div className="conversation-tool-body conversation-result-panel">
                  <pre className="conversation-result-pre">
                    {resultContent}
                  </pre>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ToolResultBubble({ message }: { message: ChatMessage }) {
  const content = extractTextContent(message.content);
  const [expanded, setExpanded] = useState(false);
  const isError = message.isError;
  const accentKind = toolAccentKind(message.toolName);
  
  const lines = content.split("\n");
  const previewLines = 3;
  const needsExpansion = lines.length > previewLines;
  const preview = needsExpansion ? lines.slice(0, previewLines).join("\n") + "\n…" : content;

  // Parse PI's native diff from details.diff (format: "-N content\n+N content\n N content")
  const detailsDiff = useMemo(() => {
    if (!message.details?.diff || typeof message.details.diff !== "string") return null;
    const rawDiff: string = message.details.diff;
    if (rawDiff.trim() === '') return null;
    const rawLines = rawDiff.split("\n");
    const parts: string[] = [];
    parts.push("--- a/file");
    parts.push("+++ b/file");
    parts.push(`@@ -1,${rawLines.length} +1,${rawLines.length} @@`);
    for (const line of rawLines) {
      const prefix = line.charAt(0);
      const rest = line.slice(1).replace(/^\d+\s*/, "");
      if (prefix === "-" || prefix === "+" || prefix === " ") {
        parts.push(prefix + rest);
      } else {
        parts.push(" " + line);
      }
    }
    return parts.join("\n");
  }, [message.details?.diff]);

  // Use diff renderer when PI's native diff is available in details
  if (detailsDiff) {
    return (
      <div className={`conversation-tool-bubble conversation-tool-bubble--${accentKind} conversation-diff-panel`}>
        <div className="conversation-tool-header conversation-diff-header">
          <span className="conversation-tool-glyph" aria-hidden="true"><Icon name={toolIconName(message.toolName)} size={13} /></span>
          <span className="conversation-tool-name">{message.toolName || "tool"}</span>
          <span className="conversation-tool-pills"><span className="conversation-tool-pill conversation-tool-pill--diff">diff</span></span>
        </div>
        <DiffRenderer key={detailsDiff} content={detailsDiff} collapsible={false} />
      </div>
    );
  }

  // Use diff renderer for edit/patch/refactor text-based diffs
  if (!isError && isDiffContent(content)) {
    return (
      <div className={`conversation-tool-bubble conversation-tool-bubble--${accentKind} conversation-diff-panel`}>
        <div className="conversation-tool-header conversation-diff-header">
          <span className="conversation-tool-glyph" aria-hidden="true"><Icon name={toolIconName(message.toolName)} size={13} /></span>
          <span className="conversation-tool-name">{message.toolName || "tool"}</span>
          {message.toolName && ["edit", "patch", "refactor", "write", "replace"].includes(message.toolName) && (
            <span className="conversation-tool-pills"><span className="conversation-tool-pill conversation-tool-pill--diff">diff</span></span>
          )}
        </div>
        <DiffRenderer key={content} content={content} collapsible={false} />
      </div>
    );
  }

  return (
    <div className={`conversation-tool-bubble conversation-tool-bubble--${accentKind} ${isError ? "conversation-tool-bubble-error" : ""}`}>
      <button
        onClick={() => setExpanded(e => !e)}
        className="conversation-tool-header"
        aria-expanded={expanded}
        aria-label="Toggle result"
      >
        <Icon name="chevron-right-sm" size={9} className={`conversation-tool-caret ${expanded ? "is-open" : ""}`} />
        <span className="conversation-tool-glyph" aria-hidden="true"><Icon name={toolIconName(message.toolName)} size={13} /></span>
        <span className="conversation-tool-name">{message.toolName || "tool"}</span>
        <span className="conversation-tool-pills">
          {isError && <span className="conversation-tool-pill conversation-tool-pill--error"><Icon name="close" size={9} />Error</span>}
          {needsExpansion && <span className="conversation-tool-pill conversation-tool-pill--meta">{lines.length} lines</span>}
        </span>
      </button>
      {!expanded && (
        <pre className="conversation-result-pre conversation-result-preview">
          {preview}
        </pre>
      )}
      {expanded && (
        <pre className="conversation-result-pre">
          {content}
        </pre>
      )}
    </div>
  );
}

function BashResultBubble({ message }: { message: ChatMessage }) {
  const output = message.output || "";
  const exitCode = message.exitCode;
  const isError = exitCode !== undefined && exitCode !== 0;
  
  const lines = output.split("\n");
  const previewLines = 4;
  const needsExpansion = lines.length > previewLines;
  const preview = needsExpansion ? lines.slice(0, previewLines).join("\n") + "\n…" : output;
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={`conversation-tool-bubble conversation-tool-bubble--bash ${isError ? "conversation-tool-bubble-error" : "conversation-tool-bubble-bash"}`}>
      <button
        onClick={() => setExpanded(e => !e)}
        className="conversation-tool-header conversation-bash-header"
        aria-expanded={expanded}
        aria-label="Toggle output"
      >
        <Icon name="chevron-right-sm" size={9} className={`conversation-tool-caret ${expanded ? "is-open" : ""}`} />
        <span className="conversation-tool-glyph" aria-hidden="true"><Icon name="terminal" size={13} /></span>
        <span className="conversation-bash-command">$ {message.command}</span>
        <span className="conversation-tool-pills">
          {exitCode !== undefined && (
            <span className={`conversation-tool-pill ${isError ? "conversation-tool-pill--error" : "conversation-tool-pill--done"}`}>
              {isError ? <Icon name="close" size={9} /> : <Icon name="check" size={9} />}
              {exitCode}
            </span>
          )}
          {needsExpansion && <span className="conversation-tool-pill conversation-tool-pill--meta">{lines.length} lines</span>}
        </span>
      </button>
      {output && (
        <pre className="conversation-result-pre">
          {expanded ? output : preview}
        </pre>
      )}
    </div>
  );
}

function SystemBubble({ message }: { message: ChatMessage }) {
  return (
    <div className="conversation-system-pill-wrap">
    <div className="conversation-system-pill">
      {message.role === "compactionSummary" ? "Context compacted" : "Branch summary"}
      {message.tokensBefore && ` · ${formatTokens(message.tokensBefore)} tokens`}
    </div>
    </div>
  );
}

function extractTextContent(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is ContentBlock & { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

function extractImageBlocks(content: ChatMessage["content"]): ContentBlock[] {
  if (typeof content === "string") return [];
  if (Array.isArray(content)) {
    return content.filter(b => b.type === "image" && b.data && b.mimeType);
  }
  return [];
}

interface CodeBlockProps extends React.HTMLAttributes<HTMLPreElement> {
  children?: React.ReactNode;
  className?: string;
}

function CodeBlock({ children, className, ...props }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  // Extract language from className (react-markdown adds "language-xxx" class)
  const lang = className?.replace("language-", "") || "";
  const text = extractTextFromNode(children);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => { if (copyTimerRef.current) clearTimeout(copyTimerRef.current); };
  }, []);

  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 1500);
    });
  };

  const isDiff = lang === "diff" || isDiffContent(text);
  const label = isDiff ? "diff" : (lang || "text");

  return (
    <div className="conversation-code-block group">
      <div className="conversation-code-header">
        <span className="conversation-code-lang">{label}</span>
        <button
          onClick={handleCopy}
          className="conversation-code-copy"
          aria-label="Copy code"
          type="button"
        >
          <Icon name="copy-plain" size={10} />
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {isDiff ? (
        <DiffRenderer key={text} content={text} />
      ) : (
        <pre className={className} {...props}>{children}</pre>
      )}
    </div>
  );
}

interface ReactNodeLike { props: { children?: unknown } }

function extractTextFromNode(node: unknown): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(extractTextFromNode).join("");
  if (typeof node === "object" && node !== null && "props" in node) {
    const el = node as ReactNodeLike;
    if (typeof el.props === "object" && el.props.children !== undefined) return extractTextFromNode(el.props.children);
  }
  return "";
}
