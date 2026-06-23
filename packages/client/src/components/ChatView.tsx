import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import type { Project, SessionSummary, ChatMessage, SessionEntry, ContentBlock } from "@pi-web/shared";
import type { ToolEvent, WSBridge } from "../lib/types";
import { SCROLL_THRESHOLD, SCROLL_THROTTLE_MS } from "../lib/constants";
import { MessageBubble } from "./MessageBubble";
import { ChatInput } from "./ChatInput";
import { ChatHeader } from "./ChatHeader";
import { useChatPrefs } from "../hooks/useChatPrefs";
import { ExtensionUIModal } from "./ExtensionUIModal";
import { Icon } from "./Icon";
import { SessionActions } from "./SessionActions";
import { GitBranchSelector } from "./GitBranchSelector";
import { CompactionIndicator } from "./CompactionIndicator";
import { ExtensionErrorToast } from "./ExtensionErrorToast";
import { turnToMarkdown, copyToClipboard } from "../lib/markdownExport";
import { MessageQueue } from "./MessageQueue";


// ─── Loading overlay: blurs chat + blocks interaction until PI is ready ───
function SessionLoadingOverlay() {
  return (
    <div
      className="conversation-session-loading"
      aria-busy="true"
      aria-label="Starting PI"
    >
      <div className="conversation-loading-card animate-fade-in-up">
        <div className="conversation-loading-spinner" />
        <div className="conversation-loading-copy">
          <p>Starting PI…</p>
          <p>Loading session</p>
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
  onBack?: () => void;
  onToggleTerminal?: () => void;
  onTogglePreview?: () => void;
  onToggleGit?: () => void;
  onToggleFiles?: () => void;
  onToggleExtensions?: () => void;
  onToggleSkills?: () => void;
  onToggleSubagents?: () => void;
  terminalOpen?: boolean;
  previewOpen?: boolean;
  gitOpen?: boolean;
  filesOpen?: boolean;
  extensionsOpen?: boolean;
  skillsOpen?: boolean;
  subagentsOpen?: boolean;
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


/** Render a styled notice for pi-subagents custom messages (completion + control). */
function renderSubagentNotice(entry: SessionEntry) {
  if (entry.type !== "custom_message" || !entry.customType) return null;
  const isNotify = entry.customType === "subagent-notify";
  const isControl = entry.customType === "subagent_control_notice" || entry.customType === "subagent-control-notice";
  if (!isNotify && !isControl) {
    // Generic custom message with display content — render plainly so it isn't hidden.
    const text = typeof entry.content === "string" ? entry.content : "";
    if (!text || entry.display === false) return null;
    return (
      <div className="conversation-subagent-notice">
        <span className="conversation-subagent-notice-label">{entry.customType}</span>
        <div className="whitespace-pre-wrap">{text}</div>
      </div>
    );
  }
  const text = typeof entry.content === "string" ? entry.content : "";
  const data = (entry.data ?? undefined) as { event?: { type?: string } } | undefined;
  const needsAttention = data?.event?.type === "needs_attention" || text.includes("Needs Attention");
  const label = isControl ? (needsAttention ? "Subagent needs attention" : "Subagent control") : "Background task";
  return (
    <div className={`conversation-subagent-notice${needsAttention ? " needs-attention" : ""}`}>
      <span className="conversation-subagent-notice-label">{label}</span>
      <div className="whitespace-pre-wrap">{text}</div>
    </div>
  );
}
export function ChatView({ ws, sessionDetail, project, session, onToggleSidebar, showSidebar, onBack, onToggleTerminal, onTogglePreview, onToggleGit, onToggleFiles, onToggleExtensions, onToggleSkills, onToggleSubagents, terminalOpen, previewOpen, gitOpen, filesOpen, extensionsOpen, skillsOpen, subagentsOpen }: ChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showThinking, setShowThinking] = useState(true);
  const [chatPrefs] = useChatPrefs();
  const [srAnnouncement, setSrAnnouncement] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [historySearch, setHistorySearch] = useState("");
  const [projectSettings, setProjectSettings] = useState({ systemPrompt: "", projectInstructions: "" });
  const autoScrollRef = useRef(true);
  useEffect(() => { autoScrollRef.current = autoScroll; }, [autoScroll]);

  // Reset auto-scroll when switching sessions so the jump-to-latest button
  // doesn't stay visible from a previous conversation.
  useEffect(() => {
    setAutoScroll(true);
  }, [ws.state?.sessionId]);

  // Toggle the history search overlay on Ctrl/Cmd+F and focus it.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setHistorySearchOpen(true);
        setTimeout(() => historySearchRef.current?.focus(), 0);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const contentRef = useRef<HTMLDivElement>(null);
  const historySearchRef = useRef<HTMLInputElement>(null);
  const [historySearchOpen, setHistorySearchOpen] = useState(false);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sessionActionStatus, setSessionActionStatus] = useState<string | null>(null);
  const lastExportPathRef = useRef<string | null>(null);
  const lastCloneSessionRef = useRef<string | null>(null);
  const lastCloneCancelledRef = useRef<boolean | null>(null);
  const lastAutoCompactionEnabledRef = useRef<boolean | null>(null);
  const lastCommandResponseKeyRef = useRef<string | null>(null);
  // True while a scroll position change was caused by us (jump-to-bottom or
  // ResizeObserver auto-pin), not by the user. The scroll handler reads this
  // to avoid mis-toggling autoScroll off and reigniting the
  // jump-button-flicker / shoot-up-and-down loop on long chats.
  const programmaticScrollRef = useRef(false);
  const programmaticClearRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Render ALL history — no button, no limit. Perf is handled by React.memo
  // on MessageBubble (historical bubbles skip re-render during streaming)
  // + content-visibility:auto in CSS (browser skips off-screen paint).
  // Memoized so derived maps (toolResultsMap, inlineToolCallIds, turnGroups)
  // stay referentially stable and don't break MessageBubble's memo.
  const allHistorical = useMemo(() =>
    (sessionDetail?.entries || [])
      .filter((e: SessionEntry) => (e.message || (e.type === "custom_message" && e.customType)) && e.type !== "compaction" && e.type !== "branch_summary"),
    [sessionDetail?.entries]
  );
  const historySearchLower = historySearch.trim().toLowerCase();
  const visibleHistoricalEntries = historySearchLower
    ? allHistorical.filter(e => e.message && extractMsgText(e.message).toLowerCase().includes(historySearchLower))
    : allHistorical;
  useEffect(() => () => {
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
  }, []);

  const showSessionActionStatus = useCallback((message: string) => {
    setSessionActionStatus(message);
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    statusTimerRef.current = setTimeout(() => setSessionActionStatus(null), 4500);
  }, []);

  // Pin scrollTop to the bottom and mark the resulting scroll event as
  // programmatic. Without this, the throttled scroll handler reads the
  // post-pin position, and on long chats content-visibility makes scrollHeight
  // grow as bottom rows render — so it computes "not near bottom" and flips
  // autoScroll back off. That toggled the jump button on/off and made the
  // view shoot up and down. The flag auto-clears shortly after pinning quiets
  // so genuine user scrolls are still respected.
  const pinToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    programmaticScrollRef.current = true;
    el.scrollTop = el.scrollHeight;
    if (programmaticClearRef.current) clearTimeout(programmaticClearRef.current);
    programmaticClearRef.current = setTimeout(() => {
      programmaticScrollRef.current = false;
    }, 150);
  }, []);

  // Auto-scroll via ResizeObserver — fires after DOM commit, always in sync
  // This is more reliable than useEffect deps for rapid streaming updates
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const content = contentRef.current;
    if (!content) return;

    const observer = new ResizeObserver(() => {
      if (!autoScrollRef.current) return;
      // O(1) scrollTop, marked programmatic so it can't fight the scroll handler.
      pinToBottom();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [autoScroll, pinToBottom]);

  // Throttled scroll handler — check if user is near bottom
  const handleScroll = useCallback(() => {
    // Ignore scrolls we caused (auto-pin / jump settling).
    if (programmaticScrollRef.current) return;
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
    setAutoScroll(true);
    const el = scrollRef.current;
    if (!el) return;
    pinToBottom();
    // content-visibility defers real heights until rows paint; re-pin on the
    // next frame so we land on the true bottom, not the 8rem estimate.
    requestAnimationFrame(() => { pinToBottom(); });
  }, [pinToBottom]);

  const sessionName = ws.state?.sessionName || session?.name || session?.lastMessage || null;
  const downloadSessionHtml = useCallback(async (sessionPath: string, endpoint = "/api/sessions/export-html", statusMessage = "HTML export downloaded.") => {
    try {
      const response = await fetch(endpoint, {
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
      showSessionActionStatus(statusMessage);
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

  const buildMessage = useCallback((text: string) => {
    const parts: string[] = [];
    if (!ws.isStreaming) {
      if (projectSettings.systemPrompt.trim()) parts.push(projectSettings.systemPrompt.trim());
      if (projectSettings.projectInstructions.trim()) parts.push(projectSettings.projectInstructions.trim());
    }
    if (text.trim()) parts.push(text.trim());
    return parts.join("\n\n---\n\n");
  }, [ws.isStreaming, projectSettings]);

  const handleSend = useCallback((text: string, images?: { data: string; mimeType: string }[]) => {
    ws.sendPrompt(buildMessage(text), images);
  }, [ws, buildMessage]);

  const handleSteer = useCallback((text: string, images?: { data: string; mimeType: string }[]) => {
    ws.send({ type: "steer", message: buildMessage(text), ...(images ? { images } : {}) });
  }, [ws, buildMessage]);

  const handleFollowUp = useCallback((text: string, images?: { data: string; mimeType: string }[]) => {
    ws.send({ type: "follow_up", message: buildMessage(text), ...(images ? { images } : {}) });
  }, [ws, buildMessage]);

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

  const handleExportHtmlPretty = useCallback(() => {
    const exportSessionPath = ws.state?.sessionFile || session?.filePath;
    if (!exportSessionPath) {
      showSessionActionStatus("No session file is available to export yet.");
      return;
    }
    lastExportPathRef.current = exportSessionPath;
    showSessionActionStatus("Preparing pretty HTML export…");
    downloadSessionHtml(exportSessionPath, "/api/sessions/export-html-pretty", "Pretty HTML export downloaded.");
  }, [downloadSessionHtml, session?.filePath, showSessionActionStatus, ws.state?.sessionFile]);

  const downloadSessionJsonl = useCallback(async (sessionPath: string) => {
    try {
      const response = await fetch("/api/sessions/export-jsonl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionPath }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.error) throw new Error(data.error || "Export failed");
      const blob = new Blob([data.jsonl || ""], { type: "application/jsonl+json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const safeName = (sessionName || "session").replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "");
      link.href = url;
      link.download = `${safeName || "session"}.jsonl`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      showSessionActionStatus("JSONL export downloaded.");
    } catch (error: any) {
      showSessionActionStatus(`Export failed: ${error.message || "unknown error"}`);
    }
  }, [sessionName, showSessionActionStatus]);

  const handleExportJsonl = useCallback(() => {
    const exportSessionPath = ws.state?.sessionFile || session?.filePath;
    if (!exportSessionPath) {
      showSessionActionStatus("No session file is available to export yet.");
      return;
    }
    lastExportPathRef.current = exportSessionPath;
    showSessionActionStatus("Preparing JSONL export…");
    downloadSessionJsonl(exportSessionPath);
  }, [downloadSessionJsonl, session?.filePath, showSessionActionStatus, ws.state?.sessionFile]);
  const handleClone = useCallback(() => {
    showSessionActionStatus("Cloning session…");
    ws.clone();
  }, [showSessionActionStatus, ws]);
  const handleSetAutoCompaction = useCallback((enabled: boolean) => {
    lastAutoCompactionEnabledRef.current = enabled;
    showSessionActionStatus(`Auto-compaction ${enabled ? "enabled" : "disabled"}…`);
    ws.setAutoCompaction(enabled);
  }, [showSessionActionStatus, ws]);

  const handleRestartPi = useCallback(async () => {
    if (!confirm("Restart PI? This will stop all running PI agent processes.")) return;
    try {
      showSessionActionStatus("Restarting PI…");
      const res = await fetch("/api/extensions/restart", { method: "POST" });
      const data = (await res.json()) as { error?: string };
      if (!res.ok || data.error) throw new Error(data.error || "Restart failed");
      showSessionActionStatus("PI restarted.");
    } catch (e: any) {
      showSessionActionStatus(`PI restart failed: ${e.message || "unknown error"}`);
    }
  }, [showSessionActionStatus]);

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


  // Non-destructive recovery: if we're connected but PI never sent `state`
  // (a long-lived subagent run can be slow to answer get_state, or the
  // attach-time RPC was dropped), quietly re-request it. Never kills the
  // agent — the session stays visible from HTTP history regardless.
  useEffect(() => {
    if (!ws.isConnected || ws.state) return;
    const t1 = setTimeout(() => ws.send({ type: "get_state" }), 5000);
    const t2 = setTimeout(() => ws.send({ type: "get_state" }), 12000);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [ws.isConnected, ws.state]);
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
  const historicalMsgs = useMemo(() => allHistorical.map(e => e.message).filter((m): m is ChatMessage => Boolean(m)), [allHistorical]);
  const liveMsgs = ws.messages;

  // Deduplicate live messages against historical entries so the same persisted
  // message is not rendered twice while the server is streaming.
  const messageSignature = useCallback((msg: ChatMessage): string => {
    let text = "";
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = msg.content.map(c => c.type === "text" ? (c.text ?? "") : c.type === "image" ? `image:${c.mimeType ?? ""}` : c.type).join("|");
    }
    return `${msg.role}:${text}:${msg.toolCallId ?? ""}`;
  }, []);

  const uniqueLiveMsgs = useMemo(() => {
    if (historicalMsgs.length === 0 || liveMsgs.length === 0) return liveMsgs;
    const histSigs = historicalMsgs.map(messageSignature);
    const liveSigs = liveMsgs.map(messageSignature);
    let overlap = 0;
    for (let i = 1; i <= Math.min(histSigs.length, liveSigs.length); i++) {
      let match = true;
      for (let j = 0; j < i; j++) {
        if (histSigs[histSigs.length - i + j] !== liveSigs[j]) {
          match = false;
          break;
        }
      }
      if (match) overlap = i;
    }
    return liveMsgs.slice(overlap);
  }, [historicalMsgs, liveMsgs, messageSignature]);

  const allChatMsgs = useMemo(() => [...historicalMsgs, ...uniqueLiveMsgs], [historicalMsgs, uniqueLiveMsgs]);

  // Show the loading overlay only while we have NOTHING to show: not connected
  // AND no history yet. History loads over HTTP (sessionDetail) and live messages
  // stream over the WS, so the session stays visible the moment either arrives —
  // a wedged get_state can never blank a live (e.g. multi-subagent) session.
  const isLoading = !ws.isConnected && !sessionDetail;

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

  useEffect(() => {
    if (!project?.id) return;
    fetch(`/api/projects/${encodeURIComponent(project.id)}/settings`)
      .then(r => r.json())
      .then(d => {
        setProjectSettings({
          systemPrompt: d.systemPrompt || "",
          projectInstructions: d.projectInstructions || "",
        });
      })
      .catch(() => {});
  }, [project?.id]);

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


  // Stable copy-turn handler keyed by message reference. Taking the message
  // (not a precomputed turn) keeps this callback referentially stable so
  // MessageBubble's React.memo isn't busted by a fresh arrow on each render.
  const handleCopyTurnForMsg = useCallback((msg: ChatMessage) => {
    const idx = allChatMsgs.indexOf(msg);
    if (idx < 0) return;
    copyTurn(getTurnForMsg(idx));
  }, [allChatMsgs, copyTurn, getTurnForMsg]);
  return (
    <div className="conversation-shell">
      <ChatHeader ws={ws} cwd={cwd} sessionName={sessionName} onToggleSidebar={onToggleSidebar} showSidebar={showSidebar} onSessionActions={() => setShowSessionActions(true)} onBack={onBack} onToggleTerminal={onToggleTerminal} onTogglePreview={onTogglePreview} onToggleGit={onToggleGit} onToggleFiles={onToggleFiles} onToggleExtensions={onToggleExtensions} onToggleSkills={onToggleSkills} onToggleSubagents={onToggleSubagents} showTerminal={terminalOpen} previewOpen={previewOpen} gitOpen={gitOpen} filesOpen={filesOpen} extensionsOpen={extensionsOpen} skillsOpen={skillsOpen} subagentsOpen={subagentsOpen} />

      <div aria-live="polite" className="sr-only">{srAnnouncement}</div>

      {historySearchOpen && (
        <div className="shrink-0 px-3 py-1.5 border-b border-ink-800 flex flex-wrap items-center gap-2">
          <Icon name="search" size={12} className="text-ink-500" />
          <input
            ref={historySearchRef}
            type="text"
            value={historySearch}
            onChange={e => setHistorySearch(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Escape") {
                setHistorySearchOpen(false);
                setHistorySearch("");
              }
            }}
            onBlur={() => {
              if (!historySearch.trim()) setHistorySearchOpen(false);
            }}
            placeholder="Search history…"
            className="flex-1 min-w-0 bg-transparent text-xs text-ink-200 placeholder:text-ink-600 outline-none"
            spellCheck={false}
          />
          {historySearch && (
            <span className="text-xs text-ink-500">
              {visibleHistoricalEntries.length} / {allHistorical.length}
            </span>
          )}
          {historySearch && (
            <button
              type="button"
              onClick={() => setHistorySearch("")}
              className="text-ink-500 hover:text-ink-300 text-xs"
              aria-label="Clear history search"
            >
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setHistorySearchOpen(false);
              setHistorySearch("");
            }}
            className="text-ink-500 hover:text-ink-300 text-xs"
            aria-label="Close history search"
          >
            Esc
          </button>
        </div>
      )}

      <div className="flex-1 flex min-h-0 min-w-0 overflow-hidden relative">
        {/* Loading overlay — only while disconnected with no history yet */}
        {isLoading && <SessionLoadingOverlay />}

        {/* Chat column — takes remaining space after terminal panel */}
        <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden">
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="conversation-scroll"
          >
        {/* Notification toast — absolute overlay pinned to top of scroll area */}
        {ws.pendingNotification && (
          <ExtensionUIModal
            request={ws.pendingNotification}
            onRespond={ws.dismissNotification}
          />
        )}
        <div ref={contentRef} className="conversation-message-stack">

          {/* Historical messages — all rendered; off-screen ones skipped by
             content-visibility:auto (see .conversation-message-row CSS) */}
          {visibleHistoricalEntries.map((entry: SessionEntry, displayIdx: number) => {
            if (entry.type === "custom_message" && entry.customType && !entry.message) {
              const notice = renderSubagentNotice(entry);
              if (notice) return <div key={entry.id || displayIdx} className="conversation-message-row">{notice}</div>;
              return null;
            }
            if (!entry.message) return null;
            const isUser = entry.message.role === "user";
            return (
              <MessageBubble
                key={entry.id || displayIdx}
                message={entry.message}
                showThinking={showThinking}
                chatPrefs={chatPrefs}
                toolResultsMap={toolResultsMap}
                inlineToolCallIds={inlineToolCallIds}
                // Historical bubbles never have in-flight tools; passing undefined
                // keeps this prop stable so tool events don't re-render history.
                runningTools={undefined}
                isHistorical={true}
                entryId={isUser ? entry.id : undefined}
                onFork={isUser ? handleFork : undefined}
                onCopyTurn={handleCopyTurnForMsg}
              />
            );
          })}

          {/* Live messages */}
          {uniqueLiveMsgs.map((msg, i) => (
            <MessageBubble
              key={`live-${i}`}
              message={msg}
              showThinking={showThinking}
              chatPrefs={chatPrefs}
              toolResultsMap={toolResultsMap}
              inlineToolCallIds={inlineToolCallIds}
              runningTools={ws.runningTools}
              isHistorical={false}
              onCopyTurn={handleCopyTurnForMsg}
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
              chatPrefs={chatPrefs}
              isStreaming={true}
            />
          )}


        </div>

        {allChatMsgs.length === 0 && !liveMsg && !hasHistoricalMessages && (
          <div className="conversation-empty">
            <div className="conversation-empty-icon">
              <Icon name="pi-logo" size={28} />
            </div>
            <h3 className="conversation-empty-title">
              {session?.name ? session.name : "How can I help?"}
            </h3>
            <p className="conversation-empty-copy">
              Ask PI to read, write, edit, or run commands in
              {' '}<span className="conversation-warning">{project?.name || "your project"}</span>.
              Streaming responses, tool calls, and diffs appear in real time.
            </p>
            <div className="conversation-prompt-list">
              {[
                "List the files in this project",
                "Explain the codebase structure",
                "Find all TODO comments",
                "Summarize the latest git changes",
              ].map(s => (
                <button key={s} type="button" onClick={() => handleSend(s)} className="conversation-prompt-button">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Compaction indicator */}
        {ws.compactionResult && (
          <div className="conversation-action-row">
            <CompactionIndicator
              compactionResult={ws.compactionResult}
              isCompacting={!!ws.state?.isCompacting}
              onCompact={(instr) => ws.compact(instr)}
              onSetAutoCompaction={handleSetAutoCompaction}
              onDismiss={ws.dismissCompactionResult}
            />
          </div>
        )}
        {/* Compact & Session actions button */}
        {allChatMsgs.length > 0 && !ws.isStreaming && !ws.compactionResult && (
          <div className="conversation-action-row">
            <button
              type="button"
              onClick={() => ws.compact()}
              className="conversation-action-link"
              title="Compact conversation context"
              aria-label="Compact conversation context"
            >
              Compact context
            </button>
            <button
              type="button"
              onClick={() => setShowSessionActions(true)}
              className="conversation-action-link"
              title="More session actions"
              aria-label="Session actions"
            >
              More
            </button>
          </div>
        )}

        {/* Jump-to-bottom button — sticky to the bottom of the scroll area
            so it floats above the content without expanding the column.
            Shown when autoScroll is disabled (user scrolled away from
            bottom). Clicking scrolls to the bottom and re-enables auto-
            scroll. */}
        {!autoScroll && (
          <div className="conversation-jump-wrap">
            <button
              type="button"
              onClick={handleJumpToBottom}
              aria-label="Jump to latest message"
              title="Jump to latest"
              className="conversation-jump-button"
            >
              {ws.isStreaming && (
                <span className="conversation-live-dot" />
              )}
              <Icon name="chevron-down" size={10} />
              <span>Jump to latest</span>
            </button>
          </div>
        )}
      </div>

      <ExtensionErrorToast
        errors={extensionErrorList}
        onDismiss={(idx) => setExtensionErrorList(prev => prev.filter((_, i) => i !== idx))}
        onClearAll={() => setExtensionErrorList([])}
      />

      <MessageQueue
        steering={ws.state?.steering ?? []}
        followUp={ws.state?.followUp ?? []}
        pendingSteering={ws.pendingSteering}
        pendingFollowUp={ws.pendingFollowUp}
        onClear={() => ws.clearQueue()}
      />

      <ChatInput
        onSend={handleSend}
        onSteer={handleSteer}
        onFollowUp={handleFollowUp}
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
        <div className="conversation-worktree-row">
          <span className="conversation-worktree-label">
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
          onExportHtmlPretty={handleExportHtmlPretty}
          onExportJsonl={handleExportJsonl}
          onClone={handleClone}
          onSetAutoCompaction={handleSetAutoCompaction}
          onRestartPi={handleRestartPi}
          onClose={() => setShowSessionActions(false)}
        />
      )}

      {sessionActionStatus && (
        <div className="conversation-status-toast">
          {sessionActionStatus}
        </div>
      )}
    </div>
  );
}


