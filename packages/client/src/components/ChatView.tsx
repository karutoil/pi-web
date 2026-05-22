import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import type { Project, SessionSummary, ChatMessage } from "@pi-web/shared";
import type { WSBridge } from "../hooks/useWebSocket";
import { MessageBubble } from "./MessageBubble";
import { ChatInput } from "./ChatInput";
import { ChatHeader } from "./ChatHeader";
import { ExtensionUIModal } from "./ExtensionUIModal";

interface ChatViewProps {
  ws: WSBridge;
  sessionDetail: { entries: any[]; cwd: string } | null;
  project: Project | null;
  session: SessionSummary | null;
}

function extractMsgText(msg: ChatMessage): string {
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text || "")
      .join("\n\n");
  }
  return "";
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

  // Group messages into turns for context menu copy
  // A turn = user message + all toolResults + final assistant response
  const historicalMsgs = (sessionDetail?.entries || [])
    .filter(e => e.message && e.type !== "compaction" && e.type !== "branch_summary")
    .map(e => e.message!);
  const liveMsgs = ws.messages;
  const allChatMsgs = [...historicalMsgs, ...liveMsgs];

  const turnGroups = useMemo(() => {
    const groups: Map<number, ChatMessage[]> = new Map(); // index -> turn messages
    let turnStart = 0;
    for (let i = 0; i < allChatMsgs.length; i++) {
      const msg = allChatMsgs[i];
      if (msg.role === "user" && i > 0) {
        turnStart = i;
      }
      if (!groups.has(turnStart)) groups.set(turnStart, []);
      groups.get(turnStart)!.push(msg);
    }
    return groups;
  }, [allChatMsgs.length]);

  const getTurnForMsg = useCallback((idx: number): ChatMessage[] => {
    // Find which turn this message belongs to
    for (const [start, msgs] of turnGroups) {
      if (idx >= start && idx < start + msgs.length) return msgs;
    }
    return [allChatMsgs[idx]];
  }, [turnGroups, allChatMsgs]);

  const getFinalResponse = useCallback((turn: ChatMessage[]): string => {
    // Get the last assistant message text
    for (let i = turn.length - 1; i >= 0; i--) {
      if (turn[i].role === "assistant") {
        return extractMsgText(turn[i]);
      }
    }
    return "";
  }, []);

  const getTurnText = useCallback((turn: ChatMessage[]): string => {
    return turn.map(m => {
      const prefix = m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : m.role === "toolResult" ? `Tool (${m.toolName || "unknown"})` : m.role;
      return `${prefix}: ${extractMsgText(m)}`;
    }).join("\n\n");
  }, []);

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
            const turn = getTurnForMsg(i);
            return (
              <MessageBubble
                key={entry.id || i}
                message={entry.message}
                showThinking={showThinking}
                isHistorical={true}
                entryId={isUser ? entry.id : undefined}
                onFork={isUser ? handleFork : undefined}
                onCopyTurn={() => navigator.clipboard.writeText(getTurnText(turn))}
                onCopyResponse={() => navigator.clipboard.writeText(getFinalResponse(turn))}
              />
            );
          })}

          {/* Live messages */}
          {ws.messages.map((msg, i) => (
            <MessageBubble
              key={`live-${i}`}
              message={msg}
              showThinking={showThinking}
              isHistorical={false}
              onCopyTurn={() => {
                const histLen = historicalMsgs.length;
                const turn = getTurnForMsg(histLen + i);
                navigator.clipboard.writeText(getTurnText(turn));
              }}
              onCopyResponse={() => {
                const histLen = historicalMsgs.length;
                const turn = getTurnForMsg(histLen + i);
                navigator.clipboard.writeText(getFinalResponse(turn));
              }}
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


