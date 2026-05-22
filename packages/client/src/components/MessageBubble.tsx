import { useState, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import type { ChatMessage, ContentBlock, ToolDetails } from "@pi-web/shared";
import { formatTokens } from "../lib/utils";
import { DiffRenderer, isDiffContent } from "./DiffRenderer";
import { Icon } from "./Icon";
import { ContextMenuPortal, ContextMenuItem, ContextMenuDivider } from "./ContextMenu";

interface MessageBubbleProps {
  message: ChatMessage;
  showThinking: boolean;
  isHistorical?: boolean;
  isStreaming?: boolean;
  entryId?: string;
  onFork?: (entryId: string) => void;
  onCopyTurn?: () => void;
  onCopyResponse?: () => void;
}

export function MessageBubble({ message, showThinking, isHistorical, isStreaming, entryId, onFork, onCopyTurn, onCopyResponse }: MessageBubbleProps) {
  const role = message.role;
  const isUser = role === "user";
  const isAssistant = role === "assistant";
  const isTool = role === "toolResult";
  const isBash = role === "bashExecution";
  const isSystem = role === "branchSummary" || role === "compactionSummary";

  // Right-click context menu
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const handleContextMenu = (e: React.MouseEvent) => {
    // Only show context menu on user or assistant messages
    if (isUser || isAssistant) {
      e.preventDefault();
      setCtxMenu({ x: e.clientX, y: e.clientY });
    }
  };

  if (isSystem) {
    return <SystemBubble message={message} />;
  }

  return (
    <div onContextMenu={handleContextMenu} className={`animate-fade-in-up ${isUser ? "flex justify-end" : "flex gap-3"}`}>
      {!isUser && (
        <div className="shrink-0 w-7 h-7 rounded-full bg-amber-500/20 border border-amber-500/30 flex items-center justify-center mt-1">
          <Icon name="pi-avatar" size={14} />
        </div>
      )}
      
      <div className={`max-w-[80%] ${isUser ? "" : "min-w-0 flex-1"}`}>
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
          <div className={`text-ink-600 text-[0.65rem] font-mono mt-1 ${isUser ? "text-right" : ""}`}>
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

      {/* Right-click context menu */}
      {ctxMenu && (
        <ContextMenuPortal
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
        >
          <ContextMenuItem
            label="Copy final response"
            icon={<Icon name="copy-offset" size={10} />}
            onClick={() => { setCtxMenu(null); onCopyResponse?.(); }}
          />
          <ContextMenuItem
            label="Copy entire turn"
            icon={<Icon name="copy-join" size={10} />}
            onClick={() => { setCtxMenu(null); onCopyTurn?.(); }}
          />
          <ContextMenuDivider />
          <ContextMenuItem
            label="Copy raw markdown"
            icon={<Icon name="copy-plain" size={10} />}
            onClick={() => { setCtxMenu(null); navigator.clipboard.writeText(extractTextContent(message.content)); }}
          />
        </ContextMenuPortal>
      )}
    </div>
  );
}

function UserBubble({ message, entryId, onFork }: { message: ChatMessage; entryId?: string; onFork?: (id: string) => void }) {
  const text = extractTextContent(message.content);
  
  return (
    <div className="group relative bg-amber-500/12 border border-amber-500/20 rounded-2xl rounded-br-md px-4 py-2.5">
      <p className="text-ink-100 text-sm leading-relaxed whitespace-pre-wrap break-words">
        {text}
      </p>
      {entryId && onFork && (
        <button
          onClick={() => onFork(entryId)}
          className="absolute -left-8 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 text-ink-600 hover:text-amber-500 transition-all p-1"
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
  showThinking,
  isHistorical,
  isStreaming,
}: {
  message: ChatMessage;
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
              }}
            >
              {text}
            </ReactMarkdown>
          </div>
        );
      })}

      {/* Tool calls */}
      {toolCalls.map((block, i) => (
        <ToolCallIndicator
          key={block.id || i}
          toolCall={block}
          expanded={!!toolCallsExpanded[block.id || String(i)]}
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
        {collapsed && <span className="text-ink-600 ml-1">({clean.split("\n").length} lines)</span>}
      </button>
      {!collapsed && (
        <div className="px-3 pb-2 text-ink-500 text-xs leading-relaxed whitespace-pre-wrap border-t border-amber-500/10 pt-2 max-h-64 overflow-y-auto">
          {clean}
        </div>
      )}
    </div>
  );
}

function ToolCallIndicator({
  toolCall,
  expanded,
  onToggle,
}: {
  toolCall: { id?: string; name?: string; arguments?: Record<string, unknown> };
  expanded: boolean;
  onToggle: () => void;
}) {
  const name = toolCall.name || "unknown";
  const args = toolCall.arguments || {};
  const argsPreview = JSON.stringify(args).slice(0, 80);

  // Color by tool — adaptive tokens (light/dark aware)
  const colors: Record<string, string> = {
    read: "text-tool-read border-tool-read-bdr bg-tool-read-bg",
    bash: "text-tool-bash border-tool-bash-bdr bg-tool-bash-bg",
    edit: "text-tool-edit border-tool-edit-bdr bg-tool-edit-bg",
    write: "text-tool-write border-tool-write-bdr bg-tool-write-bg",
    grep: "text-tool-grep border-tool-grep-bdr bg-tool-grep-bg",
    find: "text-tool-find border-tool-find-bdr bg-tool-find-bg",
    ls: "text-tool-ls border-tool-ls-bdr bg-tool-ls-bg",
  };

  const color = colors[name] || "text-tool-default";

  return (
    <button
      onClick={onToggle}
      className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-mono transition-theme w-full text-left ${color}`}
      aria-label="Toggle tool details"
    >
      <Icon name="chevron-right-sm" size={10} className={`transition-transform ${expanded ? "rotate-90" : ""}`} />
      <span className="font-medium">{name}</span>
      <span className="opacity-60 truncate">{argsPreview}</span>
    </button>
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
        {needsExpansion && <span className="text-ink-600 ml-1">({lines.length} lines)</span>}
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
        <span className="text-teal-400 font-medium">$ {message.command}</span>
        {exitCode !== undefined && (
          <span className={isError ? "text-rose-500" : "text-ink-600"}>
            [{exitCode}]
          </span>
        )}
        {needsExpansion && <span className="text-ink-600 ml-1">({lines.length} lines)</span>}
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
      <div className="bg-ink-900 border border-ink-800 rounded-full px-4 py-1.5 text-ink-500 text-xs font-mono">
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

interface CodeBlockProps extends React.HTMLAttributes<HTMLPreElement> {
  children?: React.ReactNode;
  className?: string;
}

function CodeBlock({ children, className, ...props }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  
  // Extract language from className (react-markdown adds "language-xxx" class)
  const lang = className?.replace("language-", "");
  const text = extractTextFromNode(children);

  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  // Render diffs with our custom renderer
  if (lang === "diff" || isDiffContent(text)) {
    return (
      <div className="relative group">
        <button
          onClick={handleCopy}
          className="absolute top-2 right-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity px-2 py-1 rounded bg-ink-800 hover:bg-ink-700 text-ink-400 text-xs font-mono"
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
        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity px-2 py-1 rounded bg-ink-800 hover:bg-ink-700 text-ink-400 text-xs font-mono"
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
