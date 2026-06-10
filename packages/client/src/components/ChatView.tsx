import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import type { Project, SessionSummary, ChatMessage, SessionEntry, ContentBlock } from "@pi-web/shared";
import type { ToolEvent, WSBridge } from "../lib/types";
import { SCROLL_THRESHOLD, SCROLL_THROTTLE_MS } from "../lib/constants";
import { MessageBubble } from "./MessageBubble";
import { ChatInput } from "./ChatInput";
import { ChatHeader } from "./ChatHeader";
import { ExtensionUIModal } from "./ExtensionUIModal";
import { Icon } from "./Icon";
import { SessionActions } from "./SessionActions";
import { GitBranchSelector } from "./GitBranchSelector";
import { CompactionIndicator } from "./CompactionIndicator";
import { ExtensionErrorToast } from "./ExtensionErrorToast";
import { turnToMarkdown, copyToClipboard } from "../lib/markdownExport";


// ─── Loading overlay: blurs chat + blocks interaction until PI is ready ───
function SessionLoadingOverlay() {
  return (
    <div
      className="absolute inset-0 z-[45] flex flex-col items-center justify-center bg-ink-950/70 backdrop-blur-md pointer-events-auto"
      aria-busy="true"
      aria-label="Starting PI"
    >
      <div className="flex flex-col items-center gap-4 animate-fade-in-up">
        {/* Spinner ring */}
        <div className="relative w-12 h-12">
          <div className="absolute inset-0 rounded-full border-2 border-ink-700" />
          <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-amber-500 animate-spin" />
        </div>
        <div className="text-center">
          <p className="text-ink-200 text-sm font-medium tracking-wide">Starting PI…</p>
          <p className="text-ink-500 text-xs font-mono mt-1">Loading session</p>
        </div>
      </div>
    </div>
  );
}

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
  const autoScrollRef = useRef(true);
  useEffect(() => { autoScrollRef.current = autoScroll; }, [autoScroll]);
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sessionActionStatus, setSessionActionStatus] = useState<string | null>(null);
  const lastExportPathRef = useRef<string | null>(null);
  const lastCloneSessionRef = useRef<string | null>(null);
  const lastCloneCancelledRef = useRef<boolean | null>(null);
  const lastAutoCompactionEnabledRef = useRef<boolean | null>(null);
  const lastCommandResponseKeyRef = useRef<string | null>(null);

  // Virtualization: only render the last RENDER_LIMIT messages
  const [renderLimit, setRenderLimit] = useState(200);
  const allHistorical = (sessionDetail?.entries || [])
    .filter((e: SessionEntry) => e.message && e.type !== "compaction" && e.type !== "branch_summary");
  const hasMoreHistory = allHistorical.length > renderLimit;
  const historicalEntries = hasMoreHistory ? allHistorical.slice(-renderLimit) : allHistorical;

  useEffect(() => () => {
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
  }, []);

  const showSessionActionStatus = useCallback((message: string) => {
    setSessionActionStatus(message);
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    statusTimerRef.current = setTimeout(() => setSessionActionStatus(null), 4500);
  }, []);

  // Auto-scroll via ResizeObserver — fires after DOM commit, always in sync
  // This is more reliable than useEffect deps for rapid streaming updates
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const content = contentRef.current;
    if (!content) return;

    const observer = new ResizeObserver(() => {
      if (!autoScrollRef.current || !el) return;
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

  /**
   * Jump to the bottom of the chat and re-enable auto-scroll.
   * Shown as a floating button when the user has scrolled away from the
   * bottom (i.e. autoScroll has been disabled by handleScroll).
   */
  const handleJumpToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setAutoScroll(true);
  }, []);

  const sessionName = ws.state?.sessionName || session?.name || session?.lastMessage || null;
  const downloadSessionHtml = useCallback(async (sessionPath: string) => {
    try {
      const response = await fetch("/api/sessions/export-html", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionPath }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.error) throw new Error(data.error || "Export failed");
      const blob = new Blob([data.html || ""], { type: "text/html" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const safeName = (sessionName || "session").replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "");
      link.href = url;
      link.download = `${safeName || "session"}.html`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      showSessionActionStatus("HTML export downloaded.");
    } catch (error: any) {
      showSessionActionStatus(`Export failed: ${error.message || "unknown error"}`);
    }
  }, [sessionName, showSessionActionStatus]);

  useEffect(() => {
    const result = ws.exportHtmlResult;
    if (!result?.path || result.path === lastExportPathRef.current) return;
    lastExportPathRef.current = result.path;
    downloadSessionHtml(result.path);
  }, [downloadSessionHtml, ws.exportHtmlResult]);

  useEffect(() => {
    const result = ws.cloneResult;
    if (!result) return;
    const key = `${result.cancelled}:${result.sessionPath || ""}`;
    if (lastCloneSessionRef.current === result.sessionPath && lastCloneCancelledRef.current === result.cancelled) return;
    lastCloneSessionRef.current = result.sessionPath || null;
    lastCloneCancelledRef.current = result.cancelled;
    if (result.cancelled) {
      showSessionActionStatus("Clone cancelled.");
      return;
    }
    if (result.sessionPath) {
      showSessionActionStatus("Clone complete. Loading cloned session…");
      ws.switchSession(result.sessionPath);
    } else {
      showSessionActionStatus("Clone complete.");
    }
  }, [showSessionActionStatus, ws, ws.cloneResult]);

  useEffect(() => {
    const response = ws.lastCommandResponse;
    if (!response || response.command !== "set_auto_compaction") return;
    const key = `${response.command}:${response.success}:${response.id || ""}`;
    if (lastCommandResponseKeyRef.current === key) return;
    lastCommandResponseKeyRef.current = key;
    if (response.success) {
      showSessionActionStatus(`Auto-compaction ${lastAutoCompactionEnabledRef.current ? "enabled" : "disabled"}.`);
    } else {
      showSessionActionStatus(`Auto-compaction update failed: ${response.error || "unknown error"}`);
    }
  }, [showSessionActionStatus, ws.lastCommandResponse]);

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
  const [showSessionActions, setShowSessionActions] = useState(false);
  const [extensionErrorList, setExtensionErrorList] = useState<Array<{ extensionPath: string; event: string; error: string }>>([]);

  // Track extension errors from WSBridge
  useEffect(() => {
    if (ws.extensionErrors.length > extensionErrorList.length) {
      setExtensionErrorList(ws.extensionErrors);
    }
  }, [ws.extensionErrors.length]);

  const handleExportHtml = useCallback(() => {
    const exportSessionPath = ws.state?.sessionFile || session?.filePath;
    if (!exportSessionPath) {
      showSessionActionStatus("No session file is available to export yet.");
      return;
    }
    lastExportPathRef.current = exportSessionPath;
    showSessionActionStatus("Preparing HTML export…");
    downloadSessionHtml(exportSessionPath);
  }, [downloadSessionHtml, session?.filePath, showSessionActionStatus, ws.state?.sessionFile]);
  const handleClone = useCallback(() => {
    showSessionActionStatus("Cloning session…");
    ws.clone();
  }, [showSessionActionStatus, ws]);
  const handleSetAutoCompaction = useCallback((enabled: boolean) => {
    lastAutoCompactionEnabledRef.current = enabled;
    showSessionActionStatus(`Auto-compaction ${enabled ? "enabled" : "disabled"}…`);
    ws.setAutoCompaction(enabled);
  }, [showSessionActionStatus, ws]);

  // Screen reader announcements for streaming + loading state
  useEffect(() => {
    if (!ws.isConnected || !ws.state) {
      setSrAnnouncement('Starting PI…');
    } else if (ws.isStreaming) {
      setSrAnnouncement('PI is thinking...');
    } else if (srAnnouncement && srAnnouncement !== 'Starting PI…') {
      setSrAnnouncement('PI responded');
    }
  }, [ws.isConnected, ws.state, ws.isStreaming]);

  const liveMsg = ws.liveMessages.get("current");
  const cwd = sessionDetail?.cwd || project?.path || "";

  // Git branch status for the branch bar below input
  const [gitStatus, setGitStatus] = useState<{ branch: string; ahead: number; behind: number } | null>(null);
  const refreshGitStatus = useCallback(() => {
    if (!cwd) return;
    fetch(`/api/git/status?cwd=${encodeURIComponent(cwd)}`)
      .then(r => r.json())
      .then(d => {
        if (!d.error) setGitStatus({ branch: d.branch, ahead: d.ahead ?? 0, behind: d.behind ?? 0 });
      })
      .catch(() => {});
  }, [cwd]);
  useEffect(() => {
    refreshGitStatus();
    const t = setInterval(refreshGitStatus, 15000);
    return () => clearInterval(t);
  }, [refreshGitStatus]);

  const hasHistoricalMessages = sessionDetail?.entries?.some(e => e.message) || false;

  // Map entry IDs for fork support on historical messages
  const entryMap = new Map<string, string>();
  sessionDetail?.entries?.forEach(e => { if (e.id && e.message?.role === "user") entryMap.set(e.id, e.id); });

  // Group messages into turns for context menu copy
  // A turn = user message + all toolResults + final assistant response
  const historicalMsgs = (sessionDetail?.entries || [])
    .filter(e => e.message && e.type !== "compaction" && e.type !== "branch_summary")
    .map(e => e.message!);
  const liveMsgs = ws.messages;
  const allChatMsgs = [...historicalMsgs, ...liveMsgs];

  // Build toolCallId → toolResult message map for inline tool result rendering
  const toolResultsMap = useMemo(() => {
    const map = new Map<string, ChatMessage>();
    for (const msg of allChatMsgs) {
      if (msg.role === "toolResult" && msg.toolCallId) {
        map.set(msg.toolCallId, msg);
      }
    }
    return map;
  }, [allChatMsgs]);

  // Collect toolCallIds that have inline tool calls in assistant messages (to skip standalone result bubbles)
  const inlineToolCallIds = useMemo(() => {
    const ids = new Set<string>();
    for (const msg of allChatMsgs) {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "toolCall" && block.id) ids.add(block.id);
        }
      }
    }
    // Also check the live streaming message
    const live = ws.liveMessages.get("current");
    if (live && live.role === "assistant" && Array.isArray(live.content)) {
      for (const block of live.content) {
        if (block.type === "toolCall" && block.id) ids.add(block.id);
      }
    }
    return ids;
  }, [allChatMsgs, ws.liveMessages]);

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
  }, [allChatMsgs]);

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

  // Determine if PI is still loading (not connected or no state received yet)
  const isLoading = !ws.isConnected || !ws.state;

  const getTurnText = useCallback((turn: ChatMessage[]): string => {
    return turn.map(m => {
      const prefix = m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : m.role === "toolResult" ? `Tool (${m.toolName || "unknown"})` : m.role;
      return `${prefix}: ${extractMsgText(m)}`;
    }).join("\n\n");
  }, []);

  /**
   * Copy a turn as raw API markdown (user message → final assistant response,
   * plus any tool calls/results in between). Used by the per-message right-
   * click context menu.
   */
  const copyTurn = useCallback((turn: ChatMessage[]) => {
    copyToClipboard(turnToMarkdown(turn));
  }, []);

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden relative">
      <ChatHeader ws={ws} cwd={cwd} sessionName={sessionName} onToggleSidebar={onToggleSidebar} showSidebar={showSidebar} onSessionActions={() => setShowSessionActions(true)} />

      <div aria-live="polite" className="sr-only">{srAnnouncement}</div>

      {/* Main content row: chat area + right-side panels */}
      <div className="flex-1 flex min-h-0 min-w-0 overflow-hidden relative">
        {/* Loading overlay — blurs + blocks interaction until connected + state received */}
        {isLoading && <SessionLoadingOverlay />}

        {/* Chat column — takes remaining space after terminal panel */}
        <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden">
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar px-3 md:px-5 pt-6 pb-4 relative"
          >
        {/* Notification toast — absolute overlay pinned to top of scroll area */}
        {ws.pendingNotification && (
          <ExtensionUIModal
            request={ws.pendingNotification}
            onRespond={ws.dismissNotification}
          />
        )}
        <div ref={contentRef} className="max-w-3xl mx-auto space-y-4 md:space-y-5">
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
                toolResultsMap={toolResultsMap}
                inlineToolCallIds={inlineToolCallIds}
                runningTools={ws.runningTools}
                isHistorical={true}
                entryId={isUser ? entry.id : undefined}
                onFork={isUser ? handleFork : undefined}
                onCopyTurn={() => copyTurn(turn)}
              />
            );
          })}

          {/* Live messages */}
          {ws.messages.map((msg, i) => (
            <MessageBubble
              key={`live-${i}`}
              message={msg}
              showThinking={showThinking}
              toolResultsMap={toolResultsMap}
              inlineToolCallIds={inlineToolCallIds}
              runningTools={ws.runningTools}
              isHistorical={false}
              onCopyTurn={() => {
                const histLen = historicalMsgs.length;
                const turn = getTurnForMsg(histLen + i);
                copyTurn(turn);
              }}
            />
          ))}

          {/* Currently streaming */}
          {liveMsg && (
            <MessageBubble
              toolResultsMap={toolResultsMap}
              inlineToolCallIds={inlineToolCallIds}
              runningTools={ws.runningTools}
              message={liveMsg}
              showThinking={showThinking}
              isStreaming={true}
            />
          )}


        </div>

        {ws.messages.length === 0 && !liveMsg && !hasHistoricalMessages && (
          <div className="flex flex-col items-center justify-center py-16 md:py-20 text-center animate-fade-in-up">
            <Icon name="pi-logo" size={48} className="mb-6 opacity-40" />
            <h3 className="text-ink-300 text-lg font-medium mb-2">Start a conversation</h3>
            <p className="text-ink-500 text-sm max-w-sm italic">
              Ask PI to read, write, edit, or run commands. Streaming responses appear in real time.
            </p>
            <div className="flex flex-wrap justify-center gap-2 mt-6">
              {["List files in this project", "Explain the codebase structure", "Find all TODO comments"].map(s => (
                <button key={s} onClick={() => handleSend(s)}
                  className="px-3 py-2 text-xs text-ink-400 bg-ink-900 border border-ink-800 rounded-full hover:border-ink-600 hover:text-ink-200 transition-theme min-h-[36px]">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Compaction indicator */}
        {ws.compactionResult && (
          <div className="max-w-3xl mx-auto pb-2">
            <CompactionIndicator
              compactionResult={ws.compactionResult}
              isCompacting={!!ws.state?.isCompacting}
              onCompact={(instr) => ws.compact(instr)}
              onSetAutoCompaction={handleSetAutoCompaction}
            />
          </div>
        )}
        {/* Compact & Session actions button */}
        {ws.messages.length > 0 && !ws.isStreaming && !ws.compactionResult && (
          <div className="max-w-3xl mx-auto flex justify-center gap-3 pb-2">
            <button
              onClick={() => ws.compact()}
              className="text-xs font-mono text-ink-500 hover:text-amber-500 transition-theme"
              title="Compact conversation context"
              aria-label="Compact conversation context"
            >
              Compact context
            </button>
            <button
              onClick={() => setShowSessionActions(true)}
              className="text-xs font-mono text-ink-500 hover:text-amber-500 transition-theme"
              title="More session actions"
              aria-label="Session actions"
            >
              ⋯ More
            </button>
          </div>
        )}

        {/* Jump-to-bottom button — sticky to the bottom of the scroll area
            so it floats above the content without expanding the column.
            Shown when autoScroll is disabled (user scrolled away from
            bottom). Clicking scrolls to the bottom and re-enables auto-
            scroll. */}
        {!autoScroll && (
          <div className="sticky bottom-3 inset-x-0 flex justify-center pointer-events-none z-10 -mt-10">
            <button
              onClick={handleJumpToBottom}
              aria-label="Jump to latest message"
              title="Jump to latest"
              className="pointer-events-auto group flex items-center gap-1.5 px-2.5 py-1 min-h-[28px] rounded-full bg-ink-900/40 hover:bg-ink-900/70 backdrop-blur-sm border border-ink-700/40 hover:border-amber-500/40 text-ink-400 hover:text-amber-500 text-[0.65rem] font-mono transition-theme"
            >
              {ws.isStreaming && (
                <span className="relative flex w-1.5 h-1.5 shrink-0">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-amber-500 opacity-75 animate-ping" />
                  <span className="relative inline-flex w-1.5 h-1.5 rounded-full bg-amber-500" />
                </span>
              )}
              <Icon name="chevron-down" size={10} />
              <span>Jump to latest</span>
            </button>
          </div>
        )}
      </div>

      {/* Extension error toasts — inline above input */}
      <ExtensionErrorToast
        errors={extensionErrorList}
        onDismiss={(idx) => setExtensionErrorList(prev => prev.filter((_, i) => i !== idx))}
        onClearAll={() => setExtensionErrorList([])}
      />

      <ChatInput
        onSend={handleSend}
        onAbort={handleAbort}
        isStreaming={ws.isStreaming}
        disabled={!ws.isConnected}
        commands={ws.commands}
        onRequestCommands={handleRequestCommands}
        showTerminal={false}
        statusEntries={ws.statusEntries}
        widgets={ws.widgets}
        autoRetry={ws.autoRetry}
        onAbortRetry={() => ws.abortRetry()}
        projectPath={cwd}
        ws={ws}
        sessionStats={ws.sessionStats}
      />

      {/* Branch / worktree selector below input */}
      {gitStatus && (
        <div className="max-w-3xl w-full mx-auto flex items-center justify-between px-4 md:px-5 pb-2 md:pb-3 shrink-0 flex-wrap gap-y-1">
          <span className="text-ink-500 text-xs font-mono flex items-center gap-1.5">
            <Icon name="folder" size={12} />
            Worktree
          </span>
          <GitBranchSelector
            cwd={cwd}
            currentBranch={gitStatus.branch}
            ahead={gitStatus.ahead}
            behind={gitStatus.behind}
            onRefresh={refreshGitStatus}
            dropdownPosition="above"
          />
        </div>
      )}
    </div>{/* end chat column */}
  </div>{/* end main content row */}

      {/* Extension UI Modal — dialog methods (confirm, select, input, editor) */}
      {ws.pendingDialog && (
        <ExtensionUIModal
          request={ws.pendingDialog}
          onRespond={ws.respondToUI}
        />
      )}

      {/* Session actions dropdown */}
      {showSessionActions && (
        <SessionActions
          onCompact={(instr) => {
            showSessionActionStatus(instr ? "Compacting with custom instructions…" : "Compacting context…");
            ws.compact(instr);
          }}
          onExportHtml={handleExportHtml}
          onClone={handleClone}
          onSetAutoCompaction={handleSetAutoCompaction}
          onClose={() => setShowSessionActions(false)}
        />
      )}

      {sessionActionStatus && (
        <div className="fixed left-1/2 bottom-4 -translate-x-1/2 z-[70] max-w-[min(90vw,32rem)] px-3 py-2 rounded-lg bg-ink-950/95 border border-ink-700 text-ink-100 text-xs font-mono shadow-2xl mobile-safe-bottom">
          {sessionActionStatus}
        </div>
      )}
    </div>
  );
}


