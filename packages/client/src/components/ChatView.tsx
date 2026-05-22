import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import type { Project, SessionSummary } from "@pi-web/shared";
import type { WSBridge, ToolEvent } from "../hooks/useWebSocket";
import { MessageBubble } from "./MessageBubble";
import { ChatInput } from "./ChatInput";
import { ChatHeader } from "./ChatHeader";
import { ExtensionUIModal } from "./ExtensionUIModal";
import { DiffRenderer } from "./DiffRenderer";

interface ChatViewProps {
  ws: WSBridge;
  sessionDetail: { entries: any[]; cwd: string } | null;
  project: Project | null;
  session: SessionSummary | null;
}

export function ChatView({ ws, sessionDetail, project, session }: ChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showThinking, setShowThinking] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll && messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [ws.messages, ws.liveMessages, ws.runningTools, autoScroll]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 80);
  }, []);

  const handleSend = useCallback((text: string, images?: { data: string; mimeType: string }[]) => {
    if (ws.isStreaming) {
      ws.send({ type: "steer", message: text });
    } else {
      ws.sendPrompt(text, images);
    }
  }, [ws]);

  const handleAbort = useCallback(() => ws.send({ type: "abort" }), [ws]);
  const handleFork = useCallback((entryId: string) => {
    ws.send({ type: "fork", entryId });
  }, [ws]);
  const handleRequestCommands = useCallback(() => {
    ws.send({ type: "get_commands" });
  }, [ws]);
  const handleCompact = useCallback(() => ws.send({ type: "compact" }), [ws]);

  const liveMsg = ws.liveMessages.get("current");
  const cwd = sessionDetail?.cwd || project?.path || "";
  const sessionName = ws.state?.sessionName || session?.name || session?.lastMessage || null;
  const hasHistoricalMessages = sessionDetail?.entries.some(e => e.message) || false;

  // Map entry IDs for fork support on historical messages
  const entryMap = new Map<string, string>();
  sessionDetail?.entries.forEach(e => { if (e.id && e.message?.role === "user") entryMap.set(e.id, e.id); });

  return (
    <div className="flex-1 flex flex-col min-h-0 relative">
      <ChatHeader ws={ws} cwd={cwd} sessionName={sessionName} />

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto custom-scrollbar px-5 pt-6 pb-28"
      >
        <div className="max-w-3xl mx-auto space-y-5">
          {/* Historical messages */}
          {sessionDetail?.entries.map((entry, i) => {
            if (!entry.message) return null;
            if (entry.type === "compaction" || entry.type === "branch_summary") return null;
            const isUser = entry.message.role === "user";
            return (
              <MessageBubble
                key={entry.id || i}
                message={entry.message}
                showThinking={showThinking}
                isHistorical={true}
                entryId={isUser ? entry.id : undefined}
                onFork={isUser ? handleFork : undefined}
              />
            );
          })}

          {/* Running tools */}
          {ws.runningTools.size > 0 && (
            <div className="space-y-1.5">
              {Array.from(ws.runningTools.values()).map(tool => (
                <ToolExecutionBubble key={tool.toolCallId} tool={tool} />
              ))}
            </div>
          )}

          {/* Live messages */}
          {ws.messages.map((msg, i) => (
            <MessageBubble
              key={`live-${i}`}
              message={msg}
              showThinking={showThinking}
              isHistorical={false}
            />
          ))}

          {/* Currently streaming */}
          {liveMsg && (
            <MessageBubble message={liveMsg} showThinking={showThinking} isStreaming={true} />
          )}

          <div ref={messagesEndRef} />
        </div>

        {ws.messages.length === 0 && !liveMsg && !hasHistoricalMessages && (
          <div className="flex flex-col items-center justify-center py-20 text-center animate-fade-in-up">
            <svg width="48" height="48" viewBox="0 0 128 128" fill="none" className="mb-6 opacity-40">
              <circle cx="64" cy="64" r="60" stroke="currentColor" strokeWidth="6" className="text-amber-600" />
              <path d="M44 52 L64 32 L84 52" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" className="text-amber-500" />
              <path d="M64 32 L64 88" stroke="currentColor" strokeWidth="4" strokeLinecap="round" className="text-amber-500" />
              <circle cx="64" cy="88" r="4" className="fill-amber-500" />
            </svg>
            <h3 className="text-ink-300 text-lg font-medium mb-2">Start a conversation</h3>
            <p className="text-ink-500 text-sm max-w-sm italic">
              Ask PI to read, write, edit, or run commands. Streaming responses appear in real time.
            </p>
            <div className="flex flex-wrap justify-center gap-2 mt-6">
              {["List files in this project", "Explain the codebase structure", "Find all TODO comments"].map(s => (
                <button key={s} onClick={() => handleSend(s)}
                  className="px-3 py-1.5 text-xs text-ink-400 bg-ink-900 border border-ink-800 rounded-full hover:border-ink-600 hover:text-ink-200 transition-theme">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Compaction button */}
        {ws.messages.length > 0 && !ws.isStreaming && (
          <div className="max-w-3xl mx-auto flex justify-center pb-2">
            <button
              onClick={handleCompact}
              className="text-ink-600 hover:text-amber-500 text-xs font-mono transition-theme"
              title="Compact conversation context"
            >
              Compact context
            </button>
          </div>
        )}
      </div>

      <ChatInput
        onSend={handleSend}
        onAbort={handleAbort}
        isStreaming={ws.isStreaming}
        disabled={!ws.isConnected}
        commands={ws.commands}
        onRequestCommands={handleRequestCommands}
      />

      {/* Extension UI Modal — only for dialog methods */}
      {ws.pendingUI && ["select", "confirm", "input", "editor"].includes(ws.pendingUI.method) && (
        <ExtensionUIModal
          request={ws.pendingUI}
          onRespond={ws.respondToUI}
        />
      )}

      {/* Extension UI Notifications */}
      {ws.pendingUI && ws.pendingUI.method === "notify" && (
        <ExtensionUIModal
          request={ws.pendingUI}
          onRespond={ws.respondToUI}
        />
      )}
    </div>
  );
}

function ToolExecutionBubble({ tool }: { tool: ToolEvent }) {
  const [expanded, setExpanded] = useState(false);
  const colors: Record<string, string> = {
    read: "border-tool-read-bdr bg-tool-read-bg text-tool-read",
    bash: "border-tool-bash-bdr bg-tool-bash-bg text-tool-bash",
    edit: "border-tool-edit-bdr bg-tool-edit-bg text-tool-edit",
    write: "border-tool-write-bdr bg-tool-write-bg text-tool-write",
    grep: "border-tool-grep-bdr bg-tool-grep-bg text-tool-grep",
    find: "border-tool-find-bdr bg-tool-find-bg text-tool-find",
    ls: "border-tool-ls-bdr bg-tool-ls-bg text-tool-ls",
  };
  const color = colors[tool.toolName] || "text-tool-default";
  const isRunning = tool.status === "running";
  const output = tool.partialResult?.content || tool.result?.content;
  const outputText = output?.map((b: any) => b.text || "").join("\n") || "";
  const lines = outputText.split("\n");
  const previewLines = 4;
  const needsExpansion = !isRunning && lines.length > previewLines;
  const preview = needsExpansion ? lines.slice(0, previewLines).join("\n") + "\n…" : outputText;

  // Use PI's native diff from details.diff (format: "-N content\n+N content\n N content")
  const editArgs = tool.args as any;
  const generatedDiff = useMemo(() => {
    // PI's edit tool returns details.diff
    if (tool.details?.diff && typeof tool.details.diff === "string") {
      const rawDiff: string = tool.details.diff;
      const filePath = editArgs?.path || editArgs?.filePath || "file";
      const rawLines = rawDiff.split("\n");
      const parts: string[] = [];
      parts.push(`--- a${filePath}`);
      parts.push(`+++ b${filePath}`);
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
    }
    // Fallback: generate from edit tool args (oldText/newText pairs)
    if (tool.toolName === "edit" && editArgs?.edits && Array.isArray(editArgs.edits)) {
      const parts: string[] = [];
      const filePath = editArgs.path || editArgs.filePath || "file";
      parts.push(`--- a${filePath}`);
      parts.push(`+++ b${filePath}`);
      for (const edit of editArgs.edits) {
        if (edit.oldText && edit.newText) {
          const oldLines = edit.oldText.split("\n");
          const newLines = edit.newText.split("\n");
          parts.push(`@@ -1,${oldLines.length} +1,${newLines.length} @@`);
          for (const l of oldLines) parts.push(`-${l}`);
          for (const l of newLines) parts.push(`+${l}`);
        }
      }
      return parts.join("\n");
    }
    if (tool.toolName === "patch" && editArgs?.diff) {
      return editArgs.diff;
    }
    return null;
  }, [tool.toolName, editArgs, tool.details]);

  // Render diffs with our custom renderer
  if (generatedDiff && tool.status === "done") {
    return (
      <div className={`border rounded-lg overflow-hidden ${color} animate-fade-in-up`}>
        <div className="flex items-center gap-2 px-3 py-2 text-xs font-mono border-b border-inherit/20">
          <svg width="10" height="10" viewBox="0 0 10 10" className="text-amber-500" fill="currentColor">
            <path d="M3 2 L7 5 L3 8" />
          </svg>
          <span className="font-medium">{tool.toolName}</span>
          <span className="text-teal-500">done</span>
        </div>
        <DiffRenderer content={generatedDiff} collapsible={false} />
      </div>
    );
  }

  return (
    <div className={`border rounded-lg overflow-hidden ${color} animate-fade-in-up`}>
      <button onClick={() => setExpanded(e => !e)} className="w-full flex items-center gap-2 px-3 py-2 text-xs font-mono transition-theme">
        <svg width="10" height="10" viewBox="0 0 10 10" className={`transition-transform ${expanded ? "rotate-90" : ""}`} fill="currentColor">
          <path d="M3 1 L7 5 L3 9" />
        </svg>
        <span className="font-medium">{tool.toolName}</span>
        {isRunning && <span className="flex items-center gap-1 text-amber-500"><span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />running</span>}
        {tool.status === "done" && <span className="text-teal-500">done</span>}
        {tool.status === "error" && <span className="text-rose-500">error</span>}
        {needsExpansion && <span className="opacity-50 ml-1">({lines.length} lines)</span>}
      </button>
      {outputText && (
        <pre className="px-3 pb-2 text-xs leading-relaxed whitespace-pre-wrap border-t border-inherit pt-2 max-h-20 overflow-hidden font-mono opacity-80">
          {expanded ? outputText : preview}
        </pre>
      )}
    </div>
  );
}
