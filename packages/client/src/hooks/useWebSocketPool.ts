import { useRef, useEffect, useCallback, useState } from "react";
import type { WSClientMessage, WSServerMessage, AgentState, ChatMessage, SessionDetail,
  ModelInfo, CommandInfo, ForkEntry, SessionStats, ExtensionUIRequest } from "@pi-web/shared";

export interface ToolEvent {
  toolCallId: string; toolName: string; args: Record<string, unknown>;
  partialResult?: { content: any[] }; result?: { content: any[]; details?: any }; isError?: boolean;
  status: "running" | "done" | "error";
  details?: any;
}

export interface WSConnection {
  key: string;
  send: (msg: WSClientMessage) => void;
  sendPrompt: (text: string, images?: any[]) => void;
  messages: ChatMessage[];
  liveMessages: Map<string, ChatMessage>;
  runningTools: Map<string, ToolEvent>;
  state: AgentState | null;
  isConnected: boolean;
  isStreaming: boolean;
  isActive: boolean;
  models: ModelInfo[]; commands: CommandInfo[];
  forkMessages: ForkEntry[]; sessionStats: SessionStats | null;
  pendingUI: ExtensionUIRequest | null;
  respondToUI: (response: { value?: string; confirmed?: boolean; cancelled?: boolean }) => void;
  setOnSessionLoaded: (cb: ((session: SessionDetail) => void) | null) => void;
  setOnSessionEvent: (cb: ((event: WSServerMessage) => void) | null) => void;
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
    pendingUI: null as ExtensionUIRequest | null,
    pendingUIId: null as string | null,
  };

  const notify = () => listeners.forEach(l => l());

  // Connect
  const params = new URLSearchParams();
  if (projectId) params.set("projectId", projectId);
  if (sessionPath) params.set("sessionPath", sessionPath);
  if (newSessionId) params.set("newSessionId", newSessionId);
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${protocol}://${location.host}/ws/chat?${params}`);
  ws.onopen = () => { data.isConnected = true; notify(); };
  ws.onclose = () => { data.isConnected = false; data.isStreaming = false; notify(); };
  ws.onmessage = (event) => {
    try { handleMessage(JSON.parse(event.data)); } catch (e) { console.error("WS parse error:", e); }
  };

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
        const newMsgs: ChatMessage[] = [];
        if (msg.messages?.length) {
          for (const m of msg.messages) {
            if (m.role === "assistant" || m.role === "toolResult") newMsgs.push(m);
          }
        }
        messagesRef = [...preMsgs, ...newMsgs];
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
      case "tool_end": { const rt = new Map(data.runningTools); const e = rt.get(msg.toolCallId); if (e) rt.set(msg.toolCallId, { ...e, result: msg.result, details: msg.result?.details, isError: msg.isError, status: msg.isError ? "error" : "done" }); data.runningTools = rt; break; }
      case "turn_start": case "turn_end": break;
      case "queue_update": if (data.state) data.state = { ...data.state, steering: msg.steering, followUp: msg.followUp }; break;
      case "compaction_start": case "compaction_end": break;
      case "error": console.error("Agent error:", msg.message); data.isStreaming = false; break;
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
        const dialogMethods = ["select", "confirm", "input", "editor"];
        if (!dialogMethods.includes(msg.ui.method) && msg.ui.method !== "notify") break;
        if (msg.ui.method === "notify") {
          data.pendingUI = msg.ui;
          setTimeout(() => {
            data.pendingUI = data.pendingUI?.id === msg.ui.id ? null : data.pendingUI;
            notify();
            send({ type: "extension_ui_response", id: msg.ui.id, cancelled: true });
          }, 4000);
        } else {
          data.pendingUI = msg.ui;
          data.pendingUIId = msg.ui.id;
        }
        break;
      }
    }
    notify();
  }

  function send(msg: WSClientMessage) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  const conn: WSConnection = {
    key,
    send,
    sendPrompt: (text: string, images?: any[]) => {
      const userMsg: ChatMessage = { role: "user", content: text, timestamp: Date.now() };
      messagesRef = [...messagesRef, userMsg];
      data.messages = [...messagesRef];
      send({ type: "prompt", message: text, images });
      notify();
    },
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
    get pendingUI() { return data.pendingUI; },
    respondToUI: (response) => {
      const id = data.pendingUIId;
      if (id) {
        send({ type: "extension_ui_response", id, ...response });
        data.pendingUIId = null;
        data.pendingUI = null;
        notify();
      }
    },
    setOnSessionLoaded: (cb) => { onSessionLoadedRef.current = cb; },
    setOnSessionEvent: (cb) => { onSessionEventRef.current = cb; },
    close: () => { ws?.close(); ws = null; },
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
