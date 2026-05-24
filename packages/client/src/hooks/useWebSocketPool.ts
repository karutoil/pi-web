import { useRef, useEffect, useCallback, useState } from "react";
import type { WSClientMessage, WSServerMessage, AgentState, ChatMessage, SessionDetail,
  ModelInfo, CommandInfo, ForkEntry, SessionStats, ExtensionUIRequest, ImageAttachment, ContentBlock } from "@pi-web/shared";
import type { ToolEvent, WSBridge } from "../lib/types";
export type { ToolEvent, WSBridge };
import { NOTIFY_TIMEOUT_MS } from "../lib/constants";

export interface WSConnection extends WSBridge {
  key: string;
  subscribe: (l: () => void) => void;
  unsubscribe: (l: () => void) => void;
  close: () => void;
}

// ─── Single WS connection to one agent ───

function createConnection(
  key: string,
  projectId: string | null,
  sessionPath: string | null,
  newSessionId: string | null,
): WSConnection & { close: () => void } {
  let ws: WebSocket | null = null;
  let messagesRef: ChatMessage[] = [];
  let preRunCountRef = 0;
  const onSessionLoadedRef = { current: null as ((session: SessionDetail) => void) | null };
  const onSessionEventRef = { current: null as ((event: WSServerMessage) => void) | null };

  // Reactive state — subscribers get notified
  const listeners = new Set<() => void>();
  let data = {
    messages: [] as ChatMessage[],
    liveMessages: new Map<string, ChatMessage>(),
    runningTools: new Map<string, ToolEvent>(),
    state: null as AgentState | null,
    isConnected: false,
    isStreaming: false,
    isActive: false,
    models: [] as ModelInfo[],
    commands: [] as CommandInfo[],
    forkMessages: [] as ForkEntry[],
    sessionStats: null as SessionStats | null,
    pendingDialog: null as ExtensionUIRequest | null,
    pendingDialogId: null as string | null,
    pendingNotification: null as ExtensionUIRequest | null,
    pendingNotificationId: null as string | null,
    // New: extension UI fire-and-forget state
    statusEntries: {} as Record<string, string>,
    widgets: {} as Record<string, { lines: string[]; placement: string }>,
    windowTitle: null as string | null,
    // New: auto-retry state
    autoRetry: null as { attempt: number; maxAttempts: number; delayMs: number; errorMessage: string } | null,
    // New: extension errors
    extensionErrors: [] as Array<{ extensionPath: string; event: string; error: string }>,
    // New: compaction result
    compactionResult: null as { reason: string; aborted: boolean; result?: any; willRetry?: boolean; errorMessage?: string } | null,
  };

  const notify = () => listeners.forEach(l => l());

  // Auto-reconnect with exponential backoff
  let reconnectAttempts = 0;
  const MAX_RECONNECT = 10;
  const BASE_DELAY = 1000;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let intentionallyClosed = false;

  function connect() {
    const params = new URLSearchParams();
    if (projectId) params.set("projectId", projectId);
    if (sessionPath) params.set("sessionPath", sessionPath);
    if (newSessionId) params.set("newSessionId", newSessionId);
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${protocol}://${location.host}/ws?${params}`);
    ws.onopen = () => {
      data.isConnected = true;
      reconnectAttempts = 0;
      notify();
      // Request current state and commands on connect
      setTimeout(() => { send({ type: "get_state" }); send({ type: "get_commands" }); }, 200);
    };
    ws.onclose = () => {
      data.isConnected = false;
      data.isStreaming = false;
      notify();
      // Auto-reconnect unless intentionally closed
      if (!intentionallyClosed && reconnectAttempts < MAX_RECONNECT) {
        const delay = BASE_DELAY * Math.pow(1.5, reconnectAttempts);
        console.log(`[ws] reconnecting in ${Math.round(delay)}ms (attempt ${reconnectAttempts + 1})`);
        reconnectTimer = setTimeout(() => {
          reconnectAttempts++;
          connect();
        }, delay);
      }
    };
    ws.onmessage = (event) => {
      try { handleMessage(JSON.parse(event.data)); } catch (e) { console.error("WS parse error:", e); }
    };
  }

  connect();

  function handleMessage(msg: WSServerMessage) {
    switch (msg.type) {
      case "state": if (msg.data) { data.state = msg.data as AgentState; data.isStreaming = (msg.data as AgentState).isStreaming; } break;
      case "agent_start":
        data.isStreaming = true;
        data.isActive = true;
        preRunCountRef = messagesRef.length;
        data.runningTools = new Map();
        break;
      case "agent_end": {
        data.isStreaming = false;
        data.isActive = false;
        const preMsgs = messagesRef.slice(0, preRunCountRef);
        // Preserve the user message(s) sent during this run (may contain image content blocks)
        const userMsgs = messagesRef.slice(preRunCountRef).filter(m => m.role === "user");
        const newMsgs: ChatMessage[] = [];
        if (msg.messages?.length) {
          for (const m of msg.messages) {
            if (m.role === "assistant" || m.role === "toolResult") newMsgs.push(m);
          }
        }
        messagesRef = [...preMsgs, ...userMsgs, ...newMsgs];
        data.messages = [...messagesRef];
        data.liveMessages = new Map(); data.runningTools = new Map();
        break;
      }
      case "message_start": data.liveMessages = new Map(data.liveMessages); data.liveMessages.set("current", msg.message); break;
      case "message_update": data.liveMessages = new Map(data.liveMessages); data.liveMessages.set("current", msg.message); break;
      case "message_end":
        if (msg.message.role === "assistant" || msg.message.role === "toolResult") {
          messagesRef = [...messagesRef, msg.message];
          data.messages = [...messagesRef];
        }
        { const lm = new Map(data.liveMessages); lm.delete("current"); data.liveMessages = lm; }
        break;
      case "tool_start": { const rt = new Map(data.runningTools); rt.set(msg.toolCallId, { toolCallId: msg.toolCallId, toolName: msg.toolName, args: msg.args, status: "running" }); data.runningTools = rt; break; }
      case "tool_update": { const rt = new Map(data.runningTools); const e = rt.get(msg.toolCallId); if (e) rt.set(msg.toolCallId, { ...e, partialResult: msg.partialResult }); data.runningTools = rt; break; }
      case "tool_end": { const rt = new Map(data.runningTools); const e = rt.get(msg.toolCallId); if (e) rt.set(msg.toolCallId, { ...e, result: msg.result, isError: msg.isError, status: msg.isError ? "error" : "done" }); data.runningTools = rt; break; }
      case "turn_start": case "turn_end": break;
      case "queue_update": if (data.state) data.state = { ...data.state, steering: msg.steering, followUp: msg.followUp }; break;
      case "compaction_start":
        data.compactionResult = null;
        break;
      case "compaction_end":
        data.compactionResult = {
          reason: msg.reason,
          aborted: msg.aborted,
          result: (msg as any).result,
          willRetry: (msg as any).willRetry,
          errorMessage: (msg as any).errorMessage,
        };
        break;
      case "error": console.error("Agent error:", msg.message); data.isStreaming = false; break;
      case "response":
        // Generic command success/failure response — just log for now
        if (!(msg as any).success) console.warn(`Command ${(msg as any).command} failed:`, (msg as any).error);
        break;
      case "session_loaded": if (msg.session && onSessionLoadedRef.current) onSessionLoadedRef.current(msg.session); break;
      case "available_models": data.models = msg.models; break;
      case "available_commands": data.commands = msg.commands; break;
      case "fork_messages": data.forkMessages = msg.messages; break;
      case "session_stats": data.sessionStats = msg.stats; break;
      case "model_changed":
        if (data.state) data.state = { ...data.state, model: msg.modelId };
        break;
      case "thinking_changed":
        if (data.state) data.state = { ...data.state, thinkingLevel: msg.level };
        break;
      case "session_name_changed":
        if (data.state) data.state = { ...data.state, sessionName: msg.name };
        break;
      case "session_deleted":
        if (onSessionEventRef.current) onSessionEventRef.current(msg);
        break;
      case "session_renamed":
        if (onSessionEventRef.current) onSessionEventRef.current(msg);
        break;
      case "sessions_refreshed":
        if (onSessionEventRef.current) onSessionEventRef.current(msg);
        break;
      case "extension_ui_request": {
        const ui = msg.ui;
        const dialogMethods = ["select", "confirm", "input", "editor"];

        if (dialogMethods.includes(ui.method)) {
          // Dialog: blocks until response — show modal
          if (data.pendingDialogId) {
            send({ type: "extension_ui_response", id: data.pendingDialogId, cancelled: true });
          }
          data.pendingDialog = ui;
          data.pendingDialogId = ui.id;
        } else if (ui.method === "notify") {
          // Notification: fire-and-forget with auto-dismiss
          data.pendingNotification = ui;
          data.pendingNotificationId = ui.id;
          const autoTimer = setTimeout(() => {
            if (data.pendingNotificationId === ui.id) {
              data.pendingNotification = null;
              data.pendingNotificationId = null;
              notify();
              send({ type: "extension_ui_response", id: ui.id, cancelled: true });
            }
          }, NOTIFY_TIMEOUT_MS);
          (data as { notifyTimer?: ReturnType<typeof setTimeout> }).notifyTimer = autoTimer;
        } else if (ui.method === "setStatus") {
          // setStatus: fire-and-forget — update status bar entries
          if (ui.statusKey) {
            if (ui.statusText) {
              data.statusEntries = { ...data.statusEntries, [ui.statusKey]: ui.statusText };
            } else {
              const { [ui.statusKey]: _, ...rest } = data.statusEntries;
              data.statusEntries = rest;
            }
          }
          // Acknowledge fire-and-forget
          send({ type: "extension_ui_response", id: ui.id, cancelled: true });
        } else if (ui.method === "setWidget") {
          // setWidget: fire-and-forget — update widget entries
          if (ui.widgetKey) {
            if (ui.widgetLines && ui.widgetLines.length > 0) {
              data.widgets = { ...data.widgets, [ui.widgetKey]: { lines: ui.widgetLines, placement: ui.widgetPlacement || "aboveEditor" } };
            } else {
              const { [ui.widgetKey]: _, ...rest } = data.widgets;
              data.widgets = rest;
            }
          }
          send({ type: "extension_ui_response", id: ui.id, cancelled: true });
        } else if (ui.method === "setTitle") {
          // setTitle: fire-and-forget — update window title
          data.windowTitle = ui.title || null;
          send({ type: "extension_ui_response", id: ui.id, cancelled: true });
        } else if (ui.method === "set_editor_text") {
          // set_editor_text: fire-and-forget — no-op in web UI (no TUI editor)
          send({ type: "extension_ui_response", id: ui.id, cancelled: true });
        }
        break;
      }
      case "auto_retry_start":
        data.autoRetry = { attempt: msg.attempt, maxAttempts: msg.maxAttempts, delayMs: msg.delayMs, errorMessage: msg.errorMessage };
        break;
      case "auto_retry_end":
        data.autoRetry = null;
        break;
      case "extension_error":
        data.extensionErrors = [...data.extensionErrors, { extensionPath: msg.extensionPath, event: msg.event, error: msg.error }];
        // Keep only last 20 errors
        if (data.extensionErrors.length > 20) data.extensionErrors = data.extensionErrors.slice(-20);
        break;
      case "export_html_result":
      case "clone_result":
      case "messages_result":
      case "last_assistant_text_result":
        // These result types are forwarded to session event listeners
        if (onSessionEventRef.current) onSessionEventRef.current(msg as any);
        break;
    }
    notify();
  }

  function send(msg: WSClientMessage) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  const conn: WSConnection = {
    key,
    send,
    sendPrompt: (text: string, images?: ImageAttachment[]) => {
      // Build content with image blocks so user sees their own attachments immediately
      let content: string | ContentBlock[] = text;
      if (images && images.length > 0) {
        const blocks: ContentBlock[] = [];
        if (text) blocks.push({ type: "text", text });
        for (const img of images) {
          blocks.push({ type: "image", data: img.data, mimeType: img.mimeType });
        }
        content = blocks;
      }
      const userMsg: ChatMessage = { role: "user", content, timestamp: Date.now() };
      messagesRef = [...messagesRef, userMsg];
      data.messages = [...messagesRef];
      send({ type: "prompt", message: text, images });
      notify();
    },
    newSession: () => {
      send({ type: "new_session" });
      messagesRef = [];
      data.messages = [];
      data.liveMessages = new Map();
      data.runningTools = new Map();
      data.isStreaming = false;
      data.isActive = false;
      data.state = null;
      data.compactionResult = null;
      notify();
    },
    loadSession: (sessionPath: string) => {
      send({ type: "load_session", sessionPath });
      messagesRef = [];
      data.messages = [];
      data.liveMessages = new Map();
      data.runningTools = new Map();
      data.isStreaming = false;
      data.isActive = false;
      data.state = null;
      data.compactionResult = null;
      notify();
    },
    // New command methods
    cycleModel: () => { send({ type: "cycle_model" }); },
    cycleThinkingLevel: () => { send({ type: "cycle_thinking_level" }); },
    compact: (customInstructions?: string) => { send({ type: "compact", customInstructions }); },
    setAutoCompaction: (enabled: boolean) => { send({ type: "set_auto_compaction", enabled }); },
    setAutoRetry: (enabled: boolean) => { send({ type: "set_auto_retry", enabled }); },
    abortRetry: () => { send({ type: "abort_retry" }); },
    setSteeringMode: (mode: "all" | "one-at-a-time") => { send({ type: "set_steering_mode", mode }); },
    setFollowUpMode: (mode: "all" | "one-at-a-time") => { send({ type: "set_follow_up_mode", mode }); },
    exportHtml: (outputPath?: string) => { send({ type: "export_html", outputPath }); },
    switchSession: (sessionPath: string) => { send({ type: "switch_session", sessionPath }); },
    clone: () => { send({ type: "clone" }); },
    getMessages: () => { send({ type: "get_messages" }); },
    getLastAssistantText: () => { send({ type: "get_last_assistant_text" }); },

    get messages() { return data.messages; },
    get liveMessages() { return data.liveMessages; },
    get runningTools() { return data.runningTools; },
    get state() { return data.state; },
    get isConnected() { return data.isConnected; },
    get isStreaming() { return data.isStreaming; },
    get isActive() { return data.isActive; },
    get models() { return data.models; },
    get commands() { return data.commands; },
    get forkMessages() { return data.forkMessages; },
    get sessionStats() { return data.sessionStats; },
    get pendingDialog() { return data.pendingDialog; },
    get pendingNotification() { return data.pendingNotification; },
    // New state accessors
    get statusEntries() { return data.statusEntries; },
    get widgets() { return data.widgets; },
    get windowTitle() { return data.windowTitle; },
    get autoRetry() { return data.autoRetry; },
    get extensionErrors() { return data.extensionErrors; },
    get compactionResult() { return data.compactionResult; },

    respondToUI: (response) => {
      const id = data.pendingDialogId;
      if (id) {
        send({ type: "extension_ui_response", id, ...response });
        data.pendingDialogId = null;
        data.pendingDialog = null;
        notify();
      }
    },
    dismissNotification: () => {
      const id = data.pendingNotificationId;
      if (id) {
        // Clear auto-dismiss timer
        const timer = (data as { notifyTimer?: ReturnType<typeof setTimeout> }).notifyTimer;
        if (timer) { clearTimeout(timer); delete (data as { notifyTimer?: ReturnType<typeof setTimeout> }).notifyTimer; }
        send({ type: "extension_ui_response", id, cancelled: true });
        data.pendingNotificationId = null;
        data.pendingNotification = null;
        notify();
      }
    },
    setOnSessionLoaded: (cb) => { onSessionLoadedRef.current = cb; },
    setOnSessionEvent: (cb) => { onSessionEventRef.current = cb; },
    close: () => { intentionallyClosed = true; if (reconnectTimer) clearTimeout(reconnectTimer); ws?.close(); ws = null; },
    subscribe: (l) => listeners.add(l),
    unsubscribe: (l) => listeners.delete(l),
  };

  return conn;
}

// ─── Pool hook: manages multiple WS connections ───

export function useWebSocketPool() {
  const poolRef = useRef(new Map<string, ReturnType<typeof createConnection>>());
  const [, forceUpdate] = useState(0);

  const getOrConnect = useCallback((
    projectId: string | null,
    sessionPath: string | null,
    newSessionId: string | null,
  ): WSConnection | null => {
    if (!projectId && !sessionPath && !newSessionId) return null;

    const key = `${projectId || ""}:${sessionPath || ""}:${newSessionId || ""}`;
    const existing = poolRef.current.get(key);
    if (existing) return existing;

    const conn = createConnection(key, projectId, sessionPath, newSessionId);
    // Subscribe to updates — trigger React re-render when data changes
    conn.subscribe(() => forceUpdate(n => n + 1));
    poolRef.current.set(key, conn);
    return conn;
  }, []);

  const disconnect = useCallback((key: string) => {
    const conn = poolRef.current.get(key);
    if (conn) {
      conn.close();
      poolRef.current.delete(key);
      forceUpdate(n => n + 1);
    }
  }, []);

  const disconnectAll = useCallback(() => {
    for (const conn of poolRef.current.values()) conn.close();
    poolRef.current.clear();
    forceUpdate(n => n + 1);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      for (const conn of poolRef.current.values()) conn.close();
    };
  }, []);

  return { getOrConnect, disconnect, disconnectAll, pool: poolRef.current };
}
