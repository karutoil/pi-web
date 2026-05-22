import { useRef, useEffect, useCallback, useState } from "react";
import type { WSClientMessage, WSServerMessage, AgentState, ChatMessage, SessionDetail,
  ModelInfo, CommandInfo, ForkEntry, SessionStats, ExtensionUIRequest } from "@pi-web/shared";

export interface ToolEvent {
  toolCallId: string; toolName: string; args: Record<string, unknown>;
  partialResult?: { content: any[] }; result?: { content: any[]; details?: any }; isError?: boolean;
  status: "running" | "done" | "error";
  details?: any;
}

export interface WSBridge {
  send: (msg: WSClientMessage) => void;
  sendPrompt: (text: string, images?: any[]) => void;
  messages: ChatMessage[];
  liveMessages: Map<string, ChatMessage>;
  runningTools: Map<string, ToolEvent>;
  state: AgentState | null;
  isConnected: boolean;
  isStreaming: boolean;
  // New features
  models: ModelInfo[]; commands: CommandInfo[];
  forkMessages: ForkEntry[]; sessionStats: SessionStats | null;
  pendingUI: ExtensionUIRequest | null;
  respondToUI: (response: { value?: string; confirmed?: boolean; cancelled?: boolean }) => void;
  setOnSessionLoaded: (cb: ((session: SessionDetail) => void) | null) => void;
  setOnSessionEvent: (cb: ((event: WSServerMessage) => void) | null) => void;
}

export function useWebSocket(projectId: string | null, sessionPath: string | null, newSessionId: string | null): WSBridge | null {
  const wsRef = useRef<WebSocket | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [liveMessages, setLiveMessages] = useState<Map<string, ChatMessage>>(new Map());
  const [runningTools, setRunningTools] = useState<Map<string, ToolEvent>>(new Map());
  const [state, setState] = useState<AgentState | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [forkMessages, setForkMessages] = useState<ForkEntry[]>([]);
  const [sessionStats, setSessionStats] = useState<SessionStats | null>(null);
  const [pendingUI, setPendingUI] = useState<ExtensionUIRequest | null>(null);
  const pendingUIIdRef = useRef<string | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const preRunCountRef = useRef(0);
  const onSessionLoadedRef = useRef<((session: SessionDetail) => void) | null>(null);
  const onSessionEventRef = useRef<((event: WSServerMessage) => void) | null>(null);

  useEffect(() => {
    if (!projectId && !sessionPath && !newSessionId) return;
    const params = new URLSearchParams();
    if (projectId) params.set("projectId", projectId);
    if (sessionPath) params.set("sessionPath", sessionPath);
    if (newSessionId) params.set("newSessionId", newSessionId);
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${protocol}://${location.host}/ws/chat?${params}`);
    wsRef.current = ws;
    setMessages([]); messagesRef.current = []; preRunCountRef.current = 0;
    setLiveMessages(new Map()); setRunningTools(new Map());
    setState(null); setModels([]); setCommands([]); setForkMessages([]); setSessionStats(null);
    setIsStreaming(false);
    ws.onopen = () => { setIsConnected(true); };
    ws.onclose = () => { setIsConnected(false); setIsStreaming(false); };
    ws.onmessage = (event) => {
      try { handleMessage(JSON.parse(event.data)); } catch (e) { console.error("WS parse error:", e); }
    };
    return () => { ws.close(); wsRef.current = null; };
  }, [projectId, sessionPath, newSessionId]);

  const handleMessage = useCallback((msg: WSServerMessage) => {
    switch (msg.type) {
      case "state": if (msg.data) setState(msg.data as AgentState); break;
      case "agent_start":
        setIsStreaming(true);
        preRunCountRef.current = messagesRef.current.length;
        setRunningTools(new Map());
        break;
      case "agent_end": {
        setIsStreaming(false);
        const preMsgs = messagesRef.current.slice(0, preRunCountRef.current);
        const newMsgs: ChatMessage[] = [];
        if (msg.messages?.length) {
          for (const m of msg.messages) {
            if (m.role === "assistant" || m.role === "toolResult") newMsgs.push(m);
          }
        }
        messagesRef.current = [...preMsgs, ...newMsgs];
        setMessages([...messagesRef.current]);
        setLiveMessages(new Map()); setRunningTools(new Map());
        break;
      }
      case "message_start": setLiveMessages(p => { const n = new Map(p); n.set("current", msg.message); return n; }); break;
      case "message_update": setLiveMessages(p => { const n = new Map(p); n.set("current", msg.message); return n; }); break;
      case "message_end":
        if (msg.message.role === "assistant" || msg.message.role === "toolResult") {
          messagesRef.current = [...messagesRef.current, msg.message];
          setMessages([...messagesRef.current]);
        }
        setLiveMessages(p => { const n = new Map(p); n.delete("current"); return n; });
        break;
      case "tool_start": setRunningTools(p => { const n = new Map(p); n.set(msg.toolCallId, { toolCallId: msg.toolCallId, toolName: msg.toolName, args: msg.args, status: "running" }); return n; }); break;
      case "tool_update": setRunningTools(p => { const n = new Map(p); const e = n.get(msg.toolCallId); if (e) n.set(msg.toolCallId, { ...e, partialResult: msg.partialResult }); return n; }); break;
      case "tool_end": setRunningTools(p => { const n = new Map(p); const e = n.get(msg.toolCallId); if (e) n.set(msg.toolCallId, { ...e, result: msg.result, details: msg.result?.details, isError: msg.isError, status: msg.isError ? "error" : "done" }); return n; }); break;
      case "turn_start": case "turn_end": break;
      case "queue_update": setState(prev => prev ? { ...prev, steering: msg.steering, followUp: msg.followUp } : prev); break;
      case "compaction_start": case "compaction_end": break;
      case "error": console.error("Agent error:", msg.message); setIsStreaming(false); break;
      case "session_loaded": if (msg.session && onSessionLoadedRef.current) onSessionLoadedRef.current(msg.session); break;
      case "available_models": setModels(msg.models); break;
      case "available_commands": setCommands(msg.commands); break;
      case "fork_messages": setForkMessages(msg.messages); break;
      case "session_stats": setSessionStats(msg.stats); break;
      case "model_changed":
        setState(prev => prev ? { ...prev, model: msg.modelId } : prev);
        break;
      case "thinking_changed":
        setState(prev => prev ? { ...prev, thinkingLevel: msg.level } : prev);
        break;
      case "session_name_changed":
        setState(prev => prev ? { ...prev, sessionName: msg.name } : prev);
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
        // Fire-and-forget methods — ignore (setStatus, setWidget, setTitle, set_editor_text)
        const dialogMethods = ["select", "confirm", "input", "editor"];
        if (!dialogMethods.includes(msg.ui.method) && msg.ui.method !== "notify") {
          // Fire-and-forget — PI doesn't expect a response, silently ignore
          break;
        }
        if (msg.ui.method === "notify") {
          setPendingUI(msg.ui);
          setTimeout(() => {
            setPendingUI(prev => prev?.id === msg.ui.id ? null : prev);
            send({ type: "extension_ui_response", id: msg.ui.id, cancelled: true });
          }, 4000);
        } else {
          setPendingUI(msg.ui);
          pendingUIIdRef.current = msg.ui.id;
        }
        break;
      }
    }
  }, []);

  const send = useCallback((msg: WSClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify(msg));
  }, []);

  const sendPrompt = useCallback((text: string, images?: any[]) => {
    const userMsg: ChatMessage = { role: "user", content: text, timestamp: Date.now() };
    messagesRef.current = [...messagesRef.current, userMsg];
    setMessages([...messagesRef.current]);
    send({ type: "prompt", message: text, images });
  }, [send]);

  const respondToUI = useCallback((response: { value?: string; confirmed?: boolean; cancelled?: boolean }) => {
    const id = pendingUIIdRef.current;
    if (id) {
      send({ type: "extension_ui_response", id, ...response });
      pendingUIIdRef.current = null;
      setPendingUI(null);
    }
  }, [send]);

  if (!projectId && !sessionPath && !newSessionId) return null;

  return {
    send, sendPrompt, messages, liveMessages, runningTools, state,
    isConnected, isStreaming, models, commands, forkMessages, sessionStats,
    pendingUI, respondToUI,
    setOnSessionLoaded: (cb) => { onSessionLoadedRef.current = cb; },
    setOnSessionEvent: (cb) => { onSessionEventRef.current = cb; },
  };
}
