import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import type { Project, SessionSummary, ChatMessage, SessionEntry, ContentBlock } from "@pi-web/shared";
import type { WSBridge } from "../lib/types";
import { SCROLL_THRESHOLD, SCROLL_THROTTLE_MS } from "../lib/constants";
import { MessageBubble } from "./MessageBubble";
import { ChatInput } from "./ChatInput";
import { ChatHeader } from "./ChatHeader";
import { ExtensionUIModal } from "./ExtensionUIModal";
import { Icon } from "./Icon";
import { TerminalPanel } from "./TerminalPanel";
import { GitPanel } from "./GitPanel";

interface ChatViewProps {
  ws: WSBridge;
  sessionDetail: { entries: SessionEntry[]; cwd: string } | null;
  project: Project | null;
  session: SessionSummary | null;
  onToggleSidebar?: () => void;
  showSidebar?: boolean;
}

function extractMsgText(msg: ChatMessage): string {
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is ContentBlock & { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text || "")
      .join("\n\n");
  }
  return "";
}

export function ChatView({ ws, sessionDetail, project, session, onToggleSidebar, showSidebar }: ChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showThinking, setShowThinking] = useState(true);
  const [srAnnouncement, setSrAnnouncement] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const contentRef = useRef<HTMLDivElement>(null);
  const [showTerminal, setShowTerminal] = useState(false);
  const [showGit, setShowGit] = useState(false);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Virtualization: only render the last RENDER_LIMIT messages
  const [renderLimit, setRenderLimit] = useState(200);
  const allHistorical = (sessionDetail?.entries || [])
    .filter((e: SessionEntry) => e.message && e.type !== "compaction" && e.type !== "branch_summary");
  const hasMoreHistory = allHistorical.length > renderLimit;
  const historicalEntries = hasMoreHistory ? allHistorical.slice(-renderLimit) : allHistorical;

  // Auto-scroll via ResizeObserver — fires after DOM commit, always in sync
  // This is more reliable than useEffect deps for rapid streaming updates
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const content = contentRef.current;
    if (!content) return;

    const observer = new ResizeObserver(() => {
      if (!autoScroll || !el) return;
      // Direct scrollTop — O(1), no layout recalculation
      el.scrollTop = el.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [autoScroll]);

  // Throttled scroll handler — check if user is near bottom
  const handleScroll = useCallback(() => {
    if (scrollTimerRef.current) return;
    scrollTimerRef.current = setTimeout(() => {
      scrollTimerRef.current = null;
      const el = scrollRef.current;
      if (!el) return;
      const { scrollTop, scrollHeight, clientHeight } = el;
      const nearBottom = scrollHeight - scrollTop - clientHeight < SCROLL_THRESHOLD;
      setAutoScroll(nearBottom);
    }, SCROLL_THROTTLE_MS);
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

  // Compact feedback state
  const [isCompacting, setIsCompacting] = useState(false);
  const [compactDone, setCompactDone] = useState(false);
  const handleCompactClick = useCallback(() => {
    setIsCompacting(true);
    ws.send({ type: "compact" });
  }, [ws]);
  useEffect(() => {
    if (isCompacting && !ws.isStreaming) {
      setIsCompacting(false);
      setCompactDone(true);
      const t = setTimeout(() => setCompactDone(false), 2000);
      return () => clearTimeout(t);
    }
  }, [ws.isStreaming, isCompacting]);

  // Screen reader announcements for streaming state
  useEffect(() => {
    if (ws.isStreaming) {
      setSrAnnouncement('PI is thinking...');
    } else if (srAnnouncement) {
      setSrAnnouncement('PI responded');
    }
  }, [ws.isStreaming]);

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
      <ChatHeader ws={ws} cwd={cwd} sessionName={sessionName} onToggleGit={() => setShowGit(v => !v)} showGit={showGit} onToggleSidebar={onToggleSidebar} showSidebar={showSidebar} />

      <div aria-live="polite" className="sr-only">{srAnnouncement}</div>

      {/* Main content row: chat area + git panel */}
      <div className="flex-1 flex min-h-0">
        {/* Chat column */}
        <div className="flex-1 flex flex-col min-h-0">
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="flex-1 overflow-y-auto custom-scrollbar px-5 pt-6 pb-4"
          >
        <div ref={contentRef} className="max-w-3xl mx-auto space-y-5">
          {/* Load earlier messages */}
          {hasMoreHistory && (
            <button
              onClick={() => setRenderLimit(n => n + 200)}
              className="w-full text-center py-2 text-xs text-ink-500 hover:text-ink-300 font-mono transition-theme"
            >
              ↑ Load {Math.min(200, allHistorical.length - renderLimit)} earlier messages
            </button>
          )}

          {/* Historical messages (virtualized) */}
          {historicalEntries.map((entry: SessionEntry, i: number) => {
            if (!entry.message) return null;
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


        </div>

        {ws.messages.length === 0 && !liveMsg && !hasHistoricalMessages && (
          <div className="flex flex-col items-center justify-center py-20 text-center animate-fade-in-up">
            <Icon name="pi-logo" size={48} className="mb-6 opacity-40" />
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
              onClick={handleCompactClick}
              disabled={isCompacting}
              className={`text-xs font-mono transition-theme ${isCompacting ? 'text-ink-500 cursor-not-allowed' : compactDone ? 'text-teal-400' : 'text-ink-600 hover:text-amber-500'}`}
              title="Compact conversation context"
              aria-label="Compact conversation context"
            >
              {isCompacting ? 'Compacting…' : compactDone ? '✓ Compacted' : 'Compact context'}
            </button>
          </div>
        )}
      </div>

      {/* Terminal panel */}
      <TerminalPanel
        projectId={project?.id || null}
        projectPath={project?.path || null}
        visible={showTerminal}
        onClose={() => setShowTerminal(false)}
      />

      <ChatInput
        onSend={handleSend}
        onAbort={handleAbort}
        isStreaming={ws.isStreaming}
        disabled={!ws.isConnected}
        commands={ws.commands}
        onRequestCommands={handleRequestCommands}
        showTerminal={showTerminal}
        onToggleTerminal={() => setShowTerminal(v => !v)}
      />
    </div>{/* end chat column */}

    {/* Git panel */}
    <GitPanel
      cwd={cwd}
      visible={showGit}
      onClose={() => setShowGit(false)}
    />
  </div>{/* end main content row */}

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


