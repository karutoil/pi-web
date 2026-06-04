import { useState, useMemo, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import type { ChatMessage, ContentBlock, ToolDetails } from "@pi-web/shared";
import type { ToolEvent } from "../lib/types";
import { formatTokens } from "../lib/utils";
import { DiffRenderer, isDiffContent } from "./DiffRenderer";
import { Icon } from "./Icon";
import { ContextMenuPortal, ContextMenuItem, ContextMenuDivider, useLongPress } from "./ContextMenu";
import { useIsMobile } from "../hooks/useIsMobile";
import { SubagentProgressView, isSubagentDetails } from "./SubagentProgress";
import { messageToMarkdown, copyToClipboard } from "../lib/markdownExport";

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
  onCopyTurn?: () => void;
}

export function MessageBubble({ message, showThinking, toolResultsMap, inlineToolCallIds, runningTools, isHistorical, isStreaming, entryId, onFork, onCopyTurn }: MessageBubbleProps) {
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
    <div onContextMenu={handleContextMenu} {...longPress} className={`animate-fade-in-up min-w-0 ${isUser ? "flex justify-end" : "flex gap-2 md:gap-3"}`}>
      {!isUser && (
        <div className="shrink-0 w-6 h-6 md:w-7 md:h-7 rounded-full bg-amber-500/20 border border-amber-500/30 flex items-center justify-center mt-1">
          <Icon name="pi-avatar" size={12} />
        </div>
      )}
      
      <div className={`max-w-[90%] md:max-w-[80%] overflow-hidden ${isUser ? "" : "min-w-0 flex-1"}`}>
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
          <div className={`text-ink-500 text-[0.65rem] font-mono mt-1 ${isUser ? "text-right" : ""}`}>
            {message.model && <span>{message.model}</span>}
            {message.usage && (
              <span className="ml-2">
                {formatTokens(message.usage.input + (message.usage.output || 0))} tokens
              </span>
            )}
            {message.stopReason === "aborted" && (
              <span className="text-rose-500 ml-2">aborted</span>
            )}
            {message.stopReason === "error" && (
              <span className="text-rose-500 ml-2">error</span>
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
              onCopyTurn?.();
              flashCopied("turn");
            }}
          />
        </ContextMenuPortal>
      )}
    </div>
  );
}

function UserBubble({ message, entryId, onFork }: { message: ChatMessage; entryId?: string; onFork?: (id: string) => void }) {
  const text = extractTextContent(message.content);
  const imageBlocks = extractImageBlocks(message.content);

  return (
    <div className="group relative bg-amber-500/12 border border-amber-500/20 rounded-2xl rounded-br-md px-3 md:px-4 py-2.5">
      {text && (
        <p className="text-ink-100 text-sm leading-relaxed whitespace-pre-wrap break-words">
          {text}
        </p>
      )}
      {imageBlocks.length > 0 && (
        <div className={`flex gap-2 flex-wrap ${text ? 'mt-2' : ''}`}>
          {imageBlocks.map((img, i) => (
            <img
              key={i}
              src={`data:${img.mimeType};base64,${img.data}`}
              alt={`Attachment ${i + 1}`}
              className="max-h-32 md:max-h-48 rounded-lg border border-amber-500/20 object-contain"
            />
          ))}
        </div>
      )}
      {entryId && onFork && (
        <button
          onClick={() => onFork(entryId)}
          className="hidden md:block absolute -left-8 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 text-ink-500 hover:text-amber-500 transition-all p-1"
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

  // Default expanded for completed tool calls with results
  const _initialExpanded = useMemo(() => {
    const init: Record<string, boolean> = {};
    content.filter(b => b.type === "toolCall" && b.id).forEach(b => { init[b.id!] = true; });
    return init;
  }, []);

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
        <div className="text-ink-500 text-sm italic animate-pulse">Thinking...</div>
      )}

      {/* Text content */}
      {textBlocks.map((block, i) => {
        const text = block.text || "";
        // Auto-detect diff content
        if (isDiffContent(text)) {
          return <DiffRenderer key={i} content={text} />;
        }
        return (
          <div
            key={i}
            className={`prose prose-invert max-w-none text-ink-100 text-sm leading-relaxed markdown-content ${
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
              {text}
            </ReactMarkdown>
          </div>
        );
      })}

      {/* Tool calls */}
      {toolCalls.map((block, i) => (
        <CombinedToolBubble
          key={block.id || i}
          toolCall={block}
          toolResult={block.id ? toolResultsMap?.get(block.id) : undefined}
          runningTool={block.id ? runningTools?.get(block.id) : undefined}
          expanded={toolCallsExpanded[block.id || String(i)] ?? _initialExpanded[block.id || String(i)] ?? true}
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
  const [collapsed, setCollapsed] = useState(false);
  const clean = thinking.replace(/\x1b\[[0-9;]*m/g, "");
  
  return (
    <div className="border border-amber-500/20 rounded-lg overflow-hidden bg-amber-500/5">
      <button
        onClick={() => setCollapsed(c => !c)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-amber-500 hover:text-amber-400 text-xs font-mono transition-theme"
        aria-label="Toggle thinking"
      >
        <Icon name="chevron-right-sm" size={10} className={`transition-transform ${collapsed ? "" : "rotate-90"}`} />
        Reasoning
        {collapsed && <span className="text-ink-500 ml-1">({clean.split("\n").length} lines)</span>}
      </button>
      {!collapsed && (
        <div className="px-3 pb-2 text-ink-500 text-xs leading-relaxed whitespace-pre-wrap border-t border-amber-500/10 pt-2 max-h-64 overflow-y-auto">
          {clean}
        </div>
      )}
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
  const isMobile = useIsMobile();
  const argsPreview = JSON.stringify(args).slice(0, isMobile ? 40 : 80);
  const isRunning = runningTool && runningTool.status === "running";
  const isDone = !!toolResult || (runningTool && runningTool.status === "done");
  const isError = toolResult?.isError || (runningTool && runningTool.status === "error");

  // Color by tool — adaptive tokens (light/dark aware)
  const colors: Record<string, string> = {
    read: "text-tool-read border-tool-read-bdr bg-tool-read-bg",
    bash: "text-tool-bash border-tool-bash-bdr bg-tool-bash-bg",
    edit: "text-tool-edit border-tool-edit-bdr bg-tool-edit-bg",
    write: "text-tool-write border-tool-write-bdr bg-tool-write-bg",
    grep: "text-tool-grep border-tool-grep-bdr bg-tool-grep-bg",
    find: "text-tool-find border-tool-find-bdr bg-tool-find-bg",
    ls: "text-tool-ls border-tool-ls-bdr bg-tool-ls-bg",
    subagent: "text-amber-400 border-amber-500/20 bg-amber-500/5",
  };

  const headerColor = colors[name] || "text-tool-default";

  // Determine border color for the whole bubble
  const borderColor = isError
    ? "border-rose-500/30"
    : isRunning
    ? "border-amber-500/30"
    : "border-ink-800";
  const bgColor = isError
    ? "bg-rose-500/5"
    : "bg-ink-900/30";

  // Build result content for inline rendering
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

  // Result lines for expansion logic
  const resultLines = resultContent ? resultContent.split("\n") : [];
  const needsExpansion = resultLines.length > 5;

  const isDiffResult = !!(detailsDiff || (resultContent && !isError && isDiffContent(resultContent)));

  return (
    <div className={`rounded-lg border overflow-hidden ${borderColor} ${bgColor}`}>
      {/* Header: tool call info */}
      <button
        onClick={onToggle}
        className={`flex items-center gap-2 px-3 py-1.5 text-xs font-mono transition-theme w-full text-left ${headerColor}`}
        aria-label="Toggle tool details"
      >
        <Icon name="chevron-right-sm" size={10} className={`transition-transform ${expanded ? "rotate-90" : ""}`} />
        <span className="font-medium">{name}</span>
        <span className="opacity-60 truncate">{argsPreview}</span>
        {isRunning && <span className="text-amber-400 animate-pulse ml-1">●</span>}
        {isDone && !isError && <span className="text-teal-400 ml-1">✓</span>}
        {isError && <span className="text-rose-400 ml-1">(error)</span>}
      </button>

      {/* Expanded body: result content */}
      {expanded && (resultContent || isRunning) && (
        <>
          {/* Diff result */}
          {isDiffResult && (
            <div className="border-t border-ink-800">
              {detailsDiff ? (
                <DiffRenderer content={detailsDiff} collapsible={false} />
              ) : resultContent ? (
                <DiffRenderer content={resultContent} collapsible={false} />
              ) : null}
            </div>
          )}

          {/* Subagent progress — rich rendering for subagent/extension tools */}
          {isRunning && !isDiffResult && runningTool.partialResult?.details && isSubagentDetails(runningTool.partialResult.details) && (
            <div className="border-t border-ink-800 px-3 py-2">
              <SubagentProgressView details={runningTool.partialResult.details} isRunning={true} />
            </div>
          )}

          {/* Generic running indicator — for non-subagent tools */}
          {isRunning && !isDiffResult && !(runningTool.partialResult?.details && isSubagentDetails(runningTool.partialResult.details)) && (
            <div className="border-t border-ink-800 px-3 py-2 text-ink-500 text-xs font-mono">
              <span className="animate-pulse">Running…</span>
              {runningTool.partialResult?.content && (
                <pre className="mt-1 text-ink-400 whitespace-pre-wrap max-h-20 overflow-hidden">
                  {extractTextContent(runningTool.partialResult.content as ContentBlock[] | string)}
                </pre>
              )}
            </div>
          )}

          {/* Completed subagent result — show structured summary */}
          {!isDiffResult && !isRunning && (toolResult?.details || runningTool?.result?.details) && isSubagentDetails(toolResult?.details || runningTool?.result?.details) && (
            <div className="border-t border-ink-800 px-3 py-2">
              <SubagentProgressView details={(toolResult?.details || runningTool?.result?.details)!} isRunning={false} />
            </div>
          )}

          {/* Text result (non-diff, non-subagent) */}
          {!isDiffResult && !isRunning && resultContent && !(toolResult?.details && isSubagentDetails(toolResult.details)) && !isSubagentDetails(runningTool?.result?.details) && (
            <div className="border-t border-ink-800">
              <pre className="px-3 pb-2 text-ink-400 text-xs leading-relaxed whitespace-pre-wrap pt-2 max-h-64 overflow-y-auto font-mono">
                {resultContent}
              </pre>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ToolResultBubble({ message }: { message: ChatMessage }) {
  const content = extractTextContent(message.content);
  const [expanded, setExpanded] = useState(false);
  const isError = message.isError;
  
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
      <div className="border border-ink-800 rounded-lg overflow-hidden bg-ink-900/30">
        <div className="flex items-center gap-2 px-3 py-1.5 text-xs font-mono border-b border-ink-800">
          <Icon name="chevron-right-sm-amber" size={10} className="text-amber-500" />
          <span className="text-ink-400">{message.toolName || "tool"} result</span>
          <span className="text-amber-500">(diff)</span>
        </div>
        <DiffRenderer content={detailsDiff} collapsible={false} />
      </div>
    );
  }

  // Use diff renderer for edit/patch/refactor text-based diffs
  if (!isError && isDiffContent(content)) {
    return (
      <div className="border border-ink-800 rounded-lg overflow-hidden bg-ink-900/30">
        <div className="flex items-center gap-2 px-3 py-1.5 text-xs font-mono border-b border-ink-800">
          <Icon name="chevron-right-sm-amber" size={10} className="text-amber-500" />
          <span className="text-ink-400">{message.toolName || "tool"} result</span>
          {message.toolName && ["edit", "patch", "refactor", "write"].includes(message.toolName) && (
            <span className="text-amber-500">(diff)</span>
          )}
        </div>
        <DiffRenderer content={content} collapsible={false} />
      </div>
    );
  }

  return (
    <div className={`border rounded-lg overflow-hidden ${
      isError ? "border-rose-500/30 bg-rose-500/5" : "border-ink-800 bg-ink-900/30"
    }`}>
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs font-mono transition-theme"
        aria-label="Toggle result"
      >
        <Icon name="chevron-right-sm" size={10} className={`transition-transform ${expanded ? "rotate-90" : ""}`} />
        <span className={isError ? "text-rose-400" : "text-ink-400"}>
          {message.toolName || "tool"} result
        </span>
        {isError && <span className="text-rose-500">(error)</span>}
        {needsExpansion && <span className="text-ink-500 ml-1">({lines.length} lines)</span>}
      </button>
      {/* Always show preview */}
      {!expanded && (
        <pre className="px-3 pb-2 text-ink-400 text-xs leading-relaxed whitespace-pre-wrap border-t border-ink-800 pt-2 max-h-20 overflow-hidden font-mono">
          {preview}
        </pre>
      )}
      {/* Full output on expand */}
      {expanded && (
        <pre className="px-3 pb-2 text-ink-400 text-xs leading-relaxed whitespace-pre-wrap border-t border-ink-800 pt-2 max-h-64 overflow-y-auto font-mono">
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
    <div className={`border rounded-lg overflow-hidden ${
      isError ? "border-rose-500/30 bg-rose-500/5" : "border-teal-500/20 bg-teal-500/5"
    }`}>
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs font-mono"
        aria-label="Toggle output"
      >
        <Icon name="chevron-right-sm" size={10} className={`transition-transform ${expanded ? "rotate-90" : ""}`} />
        <span className="text-teal-400 font-medium truncate">$ {message.command}</span>
        {exitCode !== undefined && (
          <span className={isError ? "text-rose-500" : "text-ink-500"}>
            [{exitCode}]
          </span>
        )}
        {needsExpansion && <span className="text-ink-500 ml-1">({lines.length} lines)</span>}
      </button>
      {output && (
        <pre className="px-3 pb-2 text-ink-400 text-xs leading-relaxed whitespace-pre-wrap border-t border-ink-800 pt-2 max-h-20 overflow-hidden font-mono">
          {expanded ? output : preview}
        </pre>
      )}
    </div>
  );
}

function SystemBubble({ message }: { message: ChatMessage }) {
  return (
    <div className="flex justify-center">
      <div className="bg-ink-900 border border-ink-800 rounded-full px-4 py-1.5 text-ink-400 text-xs font-mono">
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
  const lang = className?.replace("language-", "");
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

  // Render diffs with our custom renderer
  if (lang === "diff" || isDiffContent(text)) {
    return (
      <div className="relative group">
        <button
          onClick={handleCopy}
          className="absolute top-2 right-2 z-10 opacity-60 md:opacity-0 md:group-hover:opacity-100 transition-opacity px-2 py-1.5 rounded bg-ink-800 hover:bg-ink-700 text-ink-400 text-xs font-mono min-h-[32px]"
          aria-label="Copy code"
        >
          {copied ? "Copied!" : "Copy"}
        </button>
        <DiffRenderer content={text} />
      </div>
    );
  }

  return (
    <div className="relative group">
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 opacity-60 md:opacity-0 md:group-hover:opacity-100 transition-opacity px-2 py-1.5 rounded bg-ink-800 hover:bg-ink-700 text-ink-400 text-xs font-mono min-h-[32px]"
        aria-label="Copy code"
      >
        {copied ? "Copied!" : "Copy"}
      </button>
      <pre className={className} {...props}>{children}</pre>
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
