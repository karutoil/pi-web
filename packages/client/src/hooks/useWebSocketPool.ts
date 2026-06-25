import { useRef, useEffect, useCallback, useState } from "react";
import type { WSClientMessage, WSServerMessage, AgentState, ChatMessage, SessionDetail,
  ModelInfo, CommandInfo, ForkEntry, SessionStats, ExtensionUIRequest, ImageAttachment, ContentBlock } from "@pi-web/shared";
import { messageSignature } from "@pi-web/shared";
import type { ToolEvent, WSBridge } from "../lib/types";
export type { ToolEvent, WSBridge };
import { NOTIFY_TIMEOUT_MS } from "../lib/constants";
import { reconnectDelay as computeReconnectDelay, mergeMessagesOnReconnect } from "../lib/ws-pool-logic";

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
  pool: { current: Map<string, ReturnType<typeof createConnection>> },
): WSConnection & { close: () => void } {
  let ws: WebSocket | null = null;
  let messagesRef: ChatMessage[] = [];
  let preRunCountRef = 0;
  const onSessionLoadedRef = { current: null as ((session: SessionDetail) => void) | null };
  const onSessionEventRef = { current: null as ((event: WSServerMessage) => void) | null };

  // Helper: extract plain text from a ChatMessage for queue matching
  function getChatMessageText(msg: ChatMessage): string {
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      return msg.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("");
    }
    return "";
  }

  // Reactive state — subscribers get notified
  const listeners = new Set<() => void>();
  let data = {
    messages: [] as ChatMessage[],
    liveMessages: new Map<string, ChatMessage>(),
    runningTools: new Map<string, ToolEvent>(),
    state: null as AgentState | null,
    isConnected: false,
    authExpired: false,
    lastError: null as string | null,
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
    // New: pending queue messages we sent locally but have not yet seen as a persisted user message
    pendingSteering: [] as string[],
    pendingFollowUp: [] as string[],
    // New: extension errors
    extensionErrors: [] as Array<{ extensionPath: string; event: string; error: string }>,
    // New: agent errors surfaced in the UI for review/resolve
    agentErrors: [] as string[],
    // New: compaction result
    compactionResult: null as { reason: string; aborted: boolean; result?: any; willRetry?: boolean; errorMessage?: string } | null,
    // New: session action results
    exportHtmlResult: null as { path: string } | null,
    cloneResult: null as { cancelled: boolean; sessionPath?: string } | null,
    lastCommandResponse: null as { command: string; success: boolean; error?: string; id?: string } | null,
  };

  // If this connection is for a brand-new session (no sessionPath yet), the
  // first `state` event from the server will carry the real sessionFile.
  // We pre-set `pendingNewSession` so the state handler in `handleMessage`
  // triggers `onSessionLoadedRef.current(...)`, which the App uses to rekey
  // the pool entry from `__pending__` to the real filePath. Without this,
  // new-session connections would stay under their newSessionId key forever
  // and `handleSelectSession` could never find them again.
  let pendingNewSession = !sessionPath;
  // Mutable reconnect params — updated by rekey() when a pending new session
  // resolves to its real file path, so a dropped+reconnected WS reattaches to
  // the SAME resolved agent instead of spawning a fresh new-session agent (#4).
  let currentSessionPath = sessionPath;
  let currentNewSessionId = newSessionId;
  const notify = () => listeners.forEach(l => l());

  // Active means the agent is still doing work the user might care about:
  // streaming text, or a tool that is still running.
  function updateIsActive() {
    data.isActive = data.isStreaming || Array.from(data.runningTools.values()).some((t) => t.status === "running");
  }

  // Collect agent-level error text into the review/resolve toast list.
  function addAgentError(text: string) {
    data.agentErrors = [...data.agentErrors, text];
    if (data.agentErrors.length > 20) data.agentErrors = data.agentErrors.slice(-20);
  }

  // Auto-reconnect with exponential backoff
  let reconnectAttempts = 0;
  const MAX_RECONNECT = 10;          // fast exponential-backoff attempts; then slow-forever (see ws-pool-logic)
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let intentionallyClosed = false;
  // #LIVE: last time we received a WS frame. A long gap while the socket still
  // reads OPEN (readyState==1) means the OS silently killed it (iOS PWA
  // suspend, half-open TCP) — onclose never fires so reconnect never arms. The
  // visibilitychange/online probe registered below uses this to force a close.
  let lastMessageAt = Date.now();
  // H3/M6: when the tab was last hidden. iOS kills backgrounded WS sockets in
  // ~30s; the 60s-from-lastMessageAt probe alone misses a short freeze during
  // active streaming (lastMessageAt is recent). A >10s hidden gap also forces a
  // freshness check.
  let lastHiddenAt = Date.now();
  // #LIVE: messages sent while the WS wasn't OPEN (reconnect window). Flushed
  // on reconnect so a prompt/steer sent during a blip isn't silently lost.
  const pendingQueue: WSClientMessage[] = [];

  // CF-ACCESS: detect an expired auth gateway (Cloudflare Access, etc.) so the
  // UI can offer a re-login button instead of silently retrying a WS upgrade
  // the gateway will keep rejecting. A dropped WS alone is ambiguous (could be
  // a deploy/restart), so probe a same-origin API endpoint: the gateway returns
  // a redirect (opaqueredirect) or 401/403 when the session is dead; a healthy
  // server returns 200; a dead network throws. Debounced so a flapping socket
  // can't spam the probe.
  let authProbeAt = 0;
  function probeAuthExpired(): Promise<boolean> {
    if (data.authExpired) return Promise.resolve(true);
    if (Date.now() - authProbeAt < 10_000) return Promise.resolve(false);
    authProbeAt = Date.now();
    return fetch("/api/projects", { cache: "no-store", redirect: "manual" })
      .then((res) => res.type === "opaqueredirect" || res.status === 401 || res.status === 403)
      .catch(() => false);
  }

  function connect() {
    const params = new URLSearchParams();
    if (projectId) params.set("projectId", projectId);
    if (currentSessionPath) params.set("sessionPath", currentSessionPath);
    if (currentNewSessionId) params.set("newSessionId", currentNewSessionId);
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${protocol}://${location.host}/ws?${params}`);
    ws.onopen = () => {
      data.isConnected = true;
      data.lastError = null;
      data.authExpired = false;
      reconnectAttempts = 0;
      // #7: keep messagesRef across reconnect — a user prompt sent just before
      // the WS dropped may not be persisted by PI yet. Wiping it here made the
      // message vanish from the UI (and a re-type would duplicate it in PI).
      // messages_result below merges the server's persisted history back in.
      data.liveMessages = new Map();
      // E10: clear stale transient UI state; the server re-broadcasts current
      // state via get_state. Without this a retry that ended during the
      // disconnect leaves a stale 'retrying' indicator.
      data.autoRetry = null;
      notify();
      // Request current state, message history, and commands on connect.
      // ponytail: no 200ms delay — the server's boot guard queues early RPCs
      // until the agent is ready, and get_state is idempotent.
      send({ type: "get_state" });
      // ponytail: ask only for the tail we don't have (since = our message count).
      // Server slices when in bounds, else returns full (first connect / compaction).
      send({ type: "get_messages", since: messagesRef.length });
      send({ type: "get_available_models" });
      send({ type: "get_commands" });
      // #LIVE: flush anything queued while the socket was down (prompts,
      // steers, follow-ups) AFTER get_messages so the server's history
      // snapshot (the messages_result merge baseline) is captured first —
      // otherwise a flushed prompt already in server history would show twice.
      // C1: guard the flush — if the WS dropped again during this window,
      // send() re-queues the prompt and the while-loop would spin forever
      // (re-queue → shift → re-queue), freezing the tab. Only flush while OPEN.
      if (ws?.readyState === WebSocket.OPEN) {
        while (pendingQueue.length) send(pendingQueue.shift()!);
      }
    };
    ws.onclose = (ev) => {
      // F2: a 4401 close means the upgrade was rejected for auth — surface it
      // as expired so App flips to SignIn instead of reconnecting forever.
      if (ev?.code === 4401) { data.authExpired = true; }
      data.isConnected = false;
      data.isStreaming = false;
      notify();
      // Auto-reconnect unless intentionally closed
      // #3: Auto-reconnect forever — fast exponential backoff for the first
      // MAX_RECONNECT attempts, then a slow fixed cadence so a long server
      // outage/deploy still recovers instead of leaving the client dead.
      // The 'Offline' badge (ChatHeader) reflects !isConnected the whole time.
      if (!intentionallyClosed && !data.authExpired) {
        // #LIVE: clear any pending timer first so a late onclose from a
        // superseded socket can't stack a second connect() (double WS to
        // one agent).
        if (reconnectTimer) clearTimeout(reconnectTimer);
        const fast = reconnectAttempts < MAX_RECONNECT;
        const delay = computeReconnectDelay(reconnectAttempts);
        console.log(`[ws] reconnecting in ${Math.round(delay)}ms (attempt ${reconnectAttempts + 1}${fast ? "" : ", slow"})`);
        reconnectTimer = setTimeout(() => {
          if (data.authExpired) { reconnectTimer = null; return; }
          reconnectAttempts++;
          connect();
        }, delay);
        // CF-ACCESS: a dropped WS is ambiguous (server restart vs. expired auth
        // gateway). Probe a same-origin API endpoint — Cloudflare Access returns
        // a redirect (opaqueredirect) or 401/403 when the session is dead,
        // whereas a healthy server returns 200. If expired, stop retrying (a
        // rejected WS upgrade can't succeed until the user re-logs-in) and
        // surface a re-login button (ChatHeader). Inconclusive probes leave the
        // reconnect above intact so genuine outages still recover.
        probeAuthExpired().then((expired) => {
          if (expired && !intentionallyClosed) {
            data.authExpired = true;
            if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
            notify();
          }
        });
      }
    };
    ws.onerror = () => {
      data.lastError = "WebSocket connection error";
      notify();
      // #LIVE: some browsers fire onerror WITHOUT a following onclose (DNS
      // failure, network-stack suspend). Without scheduling here the client
      // would give up forever — defeating the #3 "never give up" invariant.
      // Guard on the timer so onclose+onerror can't stack two reconnects.
      if (!intentionallyClosed && !data.authExpired && !reconnectTimer && ws?.readyState !== WebSocket.OPEN) {
        const delay = computeReconnectDelay(reconnectAttempts);
        reconnectTimer = setTimeout(() => {
          reconnectAttempts++;
          connect();
        }, delay);
      }
    };
    ws.onmessage = (event) => {
      lastMessageAt = Date.now();
      // ponytail: reset backoff on any inbound frame — a partial reconnect that
      // receives a message shouldn't leave the counter stuck high (so the next
      // drop starts fast again, not at the slow cadence).
      if (reconnectAttempts > 0) reconnectAttempts = 0;
      try { handleMessage(JSON.parse(event.data)); } catch (e) { console.error("WS parse error:", e); }
    };
  }

  connect();

  // ponytail: proactive dead-connection probe. Without this a half-open socket
  // on an active tab (NAT timeout, WiFi flap, suspend) isn't detected until the
  // server's idleTimeout closes it. The server sends pings (sendPings), so a
  // healthy connection updates lastMessageAt via pong frames and won't
  // false-positive.
  const healthCheck = setInterval(() => {
    if (intentionallyClosed) return;
    if (ws?.readyState === WebSocket.OPEN && Date.now() - lastMessageAt > 45_000) {
      try { ws.close(); } catch {}  // triggers onclose -> reconnect at attempt 0
    }
  }, 15_000);

  // #LIVE: detect a silently-dead socket (iOS PWA suspend / half-open TCP) —
  // onclose never fires for these, so the reconnect backoff never arms and
  // sends vanish into a dead buffer. Per-connection so closing one dead socket
  // in a multi-session pool never tears down a sibling session.
  const onVisible = () => {
    if (intentionallyClosed) return;
    if (document.visibilityState !== "visible") {
      lastHiddenAt = Date.now();
      return;
    }
    // The user is back. Any backoff that accumulated while the tab was hidden
    // (backgrounded sockets dying → reconnectAttempts climbing toward MAX_RECONNECT)
    // is meaningless now — reset it so we reconnect promptly instead of waiting
    // the full SLOW_RECONNECT_MS the pending timer was sitting at (the "30s to
    // reconnect" regression after returning to a backgrounded tab).
    reconnectAttempts = 0;
    // H3/M6: force-close a likely-dead socket. Two triggers: no frame in 60s,
    // OR the tab was hidden >10s (iOS kills backgrounded WS sockets in ~30s).
    if (ws && ws.readyState === WebSocket.OPEN) {
      const hiddenFor = Date.now() - lastHiddenAt;
      if (Date.now() - lastMessageAt > 60_000 || hiddenFor > 10_000) {
        try { ws.close(); } catch {}  // onclose schedules a reconnect at the (now 0) attempt → ~1s
      }
      return;
    }
    // Socket isn't OPEN (died while hidden). If a slow reconnect timer is
    // pending, fire immediately instead of making the user wait up to 30s.
    if (ws && ws.readyState === WebSocket.CONNECTING) return; // in-flight; give it a chance
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    connect();
  };
  const onOffline = () => { if (!intentionallyClosed && ws) { try { ws.close(); } catch {} } };
  const onOnline = () => {
    if (intentionallyClosed) return;
    // H5: don't create a duplicate WS. `online` can fire without a preceding
    // `offline` (partial connectivity flap); calling connect() unconditionally
    // orphaned the existing OPEN socket and cascaded reconnects. If the socket
    // is already healthy (or connecting), leave it.
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    reconnectAttempts = 0;
    connect();
  };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("offline", onOffline);
  window.addEventListener("online", onOnline);
  const removeLifecycleListeners = () => {
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("offline", onOffline);
    window.removeEventListener("online", onOnline);
  };
  function handleMessage(msg: WSServerMessage) {
    switch (msg.type) {
      case "state": {
        if (msg.data) {
          data.state = msg.data as AgentState;
          data.isStreaming = (msg.data as AgentState).isStreaming;
          updateIsActive();
          // #SDK-MIGRATION: surface the in-flight assistant message on reconnect.
          // Without it a reattach mid-stream shows isStreaming with no text (the
          // perceived "lost live session"). Clear the live bubble when not
          // streaming so a stale phantom can't linger.
          const sm = (msg.data as any).streamingMessage;
          if (sm) {
            data.liveMessages = new Map(data.liveMessages);
            data.liveMessages.set("current", sm);
          } else if (!data.isStreaming) {
            data.liveMessages = new Map(data.liveMessages);
            data.liveMessages.delete("current");
          }
          if (pendingNewSession) {
            pendingNewSession = false;
            // Session state arrived after new_session — emit session_loaded for App
            if (onSessionLoadedRef.current) onSessionLoadedRef.current({
              id: (msg.data as AgentState).sessionId,
              name: (msg.data as AgentState).sessionName,
              filePath: (msg.data as AgentState).sessionFile,
            } as any);
          }
        }
        break;
      }
      case "agent_start":
        data.isStreaming = true;
        preRunCountRef = messagesRef.length;
        data.runningTools = new Map();
        updateIsActive();
        break;
      case "agent_end": {
        data.isStreaming = false;
        data.liveMessages = new Map();
        data.runningTools = new Map();
        updateIsActive();
        const preMsgs = messagesRef.slice(0, preRunCountRef);
        const serverMessages = (msg.messages || []).filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult");
        messagesRef = mergeMessagesOnReconnect([...preMsgs, ...serverMessages], messagesRef);
        data.messages = [...messagesRef];
        break;
      }
      case "message_start": data.liveMessages = new Map(data.liveMessages); data.liveMessages.set("current", msg.message); break;
      case "message_update": data.liveMessages = new Map(data.liveMessages); data.liveMessages.set("current", msg.message); break;
      case "message_end": {
        if (msg.message.role === "assistant" || msg.message.role === "toolResult") {
          messagesRef = [...messagesRef, msg.message];
          data.messages = [...messagesRef];
          if (msg.message.errorMessage) addAgentError(`Agent error: ${msg.message.errorMessage}`);
        } else if (msg.message.role === "user") {
          const text = getChatMessageText(msg.message).trim();
          if (text) {
            data.pendingSteering = data.pendingSteering.filter((t) => t.trim() !== text);
            data.pendingFollowUp = data.pendingFollowUp.filter((t) => t.trim() !== text);
          }
          const sig = messageSignature(msg.message);
          if (!messagesRef.some((m) => messageSignature(m) === sig)) {
            messagesRef = [...messagesRef, msg.message];
            data.messages = [...messagesRef];
          }
        }
        { const lm = new Map(data.liveMessages); lm.delete("current"); data.liveMessages = lm; }
        break;
      }
      case "tool_start": { const rt = new Map(data.runningTools); rt.set(msg.toolCallId, { toolCallId: msg.toolCallId, toolName: msg.toolName, args: msg.args, status: "running" }); data.runningTools = rt; updateIsActive(); break; }
      case "tool_update": { const rt = new Map(data.runningTools); const e = rt.get(msg.toolCallId); if (e) rt.set(msg.toolCallId, { ...e, partialResult: msg.partialResult }); data.runningTools = rt; break; }
      case "tool_end": { const rt = new Map(data.runningTools); const e = rt.get(msg.toolCallId); if (e) rt.set(msg.toolCallId, { ...e, result: msg.result, isError: msg.isError, status: msg.isError ? "error" : "done" }); data.runningTools = rt; updateIsActive(); break; }
      case "turn_start": case "turn_end": break;
      case "queue_update": if (data.state) data.state = { ...data.state, steering: msg.steering, followUp: msg.followUp }; break;
      case "compaction_start":
        data.compactionResult = null;
        break;
      case "compaction_end":
        if (msg.errorMessage) addAgentError(`Compaction error: ${msg.errorMessage}`);
        data.compactionResult = {
          reason: msg.reason,
          aborted: msg.aborted,
          result: msg.result,
          willRetry: msg.willRetry,
          errorMessage: msg.errorMessage,
        };
        break;
      case "error": {
        console.error("Agent error:", msg.message);
        addAgentError(msg.message);
        data.isStreaming = false;
        updateIsActive();
        break;
      }
      case "response":
        data.lastCommandResponse = { command: msg.command, success: msg.success, error: msg.error, id: msg.id };
        // "Agent not ready" is the startup-window race (client's onopen flush
        // beats agent.start()). The server now queues these until ready, but
        // never toast it — the Starting PI screen covers that state instead.
        if (!msg.success && msg.error && msg.error !== "Agent not ready") addAgentError(`${msg.command} failed: ${msg.error}`);
        if (onSessionEventRef.current) onSessionEventRef.current(msg);
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
          // E11: clear the previous auto-dismiss timer before overwriting —
          // otherwise a rapid second notification orphans the first timer (it
          // fires after 4s and may prematurely clear the current notification).
          const prevTimer = (data as { notifyTimer?: ReturnType<typeof setTimeout> }).notifyTimer;
          if (prevTimer) clearTimeout(prevTimer);
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
      case "auto_retry_end": {
        data.autoRetry = null;
        if (msg.finalError) addAgentError(`Retry failed: ${msg.finalError}`);
        break;
      }
      case "extension_error":
        data.extensionErrors = [...data.extensionErrors, { extensionPath: msg.extensionPath, event: msg.event, error: msg.error }];
        // Keep only last 20 errors
        if (data.extensionErrors.length > 20) data.extensionErrors = data.extensionErrors.slice(-20);
        break;
      case "export_html_result":
        data.exportHtmlResult = { path: msg.path || "" };
        if (onSessionEventRef.current) onSessionEventRef.current(msg as any);
        break;
      case "clone_result":
        data.cloneResult = { cancelled: msg.cancelled || false, sessionPath: msg.sessionPath };
        if (onSessionEventRef.current) onSessionEventRef.current(msg as any);
        break;
      case "messages_result": {
        // Restore history after reconnect so the user sees everything that
        // happened while the WebSocket was away.
        const restored = (msg.messages || []).filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult");
        const from = (msg as any).fromIndex ?? 0;
        if (from > 0 && from <= messagesRef.length) {
          // ponytail: server sent only the tail (from `from` onward). Our head
          // [0,from) is already server-persisted and unchanged (append-only
          // history), so dedup-append the genuinely-new server messages and keep
          // any client-side messages beyond `from` (interleaved events / local
          // user msgs). from>0 implies no local-only msgs at send time (else the
          // server would have fallen back to full), so this never drops data.
          const have = new Set(messagesRef.map(messageSignature));
          const additions = restored.filter((m) => !have.has(messageSignature(m)));
          messagesRef = [...messagesRef, ...additions];
        } else {
          // #7: full reload (first connect, compaction fallback, or local-only
          // msgs pending) — merge: keep any user messages we added locally that
          // PI hasn't persisted yet. Server messages come first; local-only append.
          messagesRef = mergeMessagesOnReconnect(restored, messagesRef);
        }
        data.messages = [...messagesRef];
        break;
      }
      case "last_assistant_text_result": {
        // Forward to session event listeners only. Do NOT paint the live bubble
        // from this — it returns the LAST COMPLETED assistant text, not the
        // in-flight one, so it painted a phantom "streaming" bubble (stale text
        // from a previous turn) even when not streaming. The in-flight message
        // now comes from state.streamingMessage (see the `state` handler).
        if (onSessionEventRef.current) onSessionEventRef.current(msg as any);
        break;
      }
    }
    notify();
  }

  function send(msg: WSClientMessage) {
    if (msg.type === "steer") {
      data.pendingSteering = [...data.pendingSteering, msg.message];
      notify();
    } else if (msg.type === "follow_up") {
      data.pendingFollowUp = [...data.pendingFollowUp, msg.message];
      notify();
    }
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    } else if (msg.type === "prompt" || msg.type === "steer" || msg.type === "follow_up" || msg.type === "abort" || msg.type === "force_stop" || msg.type === "abort_retry" || msg.type === "extension_ui_response") {
      // C3: abort/abort_retry/extension_ui_response were previously dropped
      // during a reconnect window — the user couldn't stop a runaway agent or
      // answer a blocking dialog while the WS was down. Queue them too. A
      // duplicate extension_ui_response to an already-answered dialog is
      // harmless (the server drops unknown ids).
      // #LIVE: WS isn't OPEN (reconnect window). Queue the message so it's
      // flushed on reconnect — otherwise a prompt sent mid-reconnect is
      // silently dropped while its optimistic copy stays in the UI (looks
      // sent, PI never gets it). Dedup on flush is handled by the
      // messages_result merge (#7), which runs first because get_messages is
      // requested before the queue is flushed.
      pendingQueue.push(msg);
    }
  }

  // Mutable current key — updated by rekey() when a pending session resolves
  // to its real filePath. Read via the `key` getter on the conn.
  let currentKey = key;

  const conn: WSConnection = {
    get key() { return currentKey; },
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
      const userMsg: ChatMessage = { role: "user", content, timestamp: new Date().toISOString() };
      messagesRef = [...messagesRef, userMsg];
      data.messages = [...messagesRef];
      send({ type: "prompt", message: text, images });
      notify();
    },
    newSession: () => {
      send({ type: "new_session" });
      pendingNewSession = true;
      messagesRef = [];
      data.messages = [];
      data.liveMessages = new Map();
      data.runningTools = new Map();
      data.isStreaming = false;
      data.isActive = false;
      data.state = null;
      data.compactionResult = null;
      data.exportHtmlResult = null;
      data.cloneResult = null;
      data.lastCommandResponse = null;
      data.pendingSteering = [];
      data.pendingFollowUp = [];
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
      data.exportHtmlResult = null;
      data.cloneResult = null;
      data.lastCommandResponse = null;
      data.pendingSteering = [];
      data.pendingFollowUp = [];
      notify();
    },
    // New command methods
    cycleModel: () => { send({ type: "cycle_model" }); },
    cycleThinkingLevel: () => { send({ type: "cycle_thinking_level" }); },
    compact: (customInstructions?: string) => { send({ type: "compact", customInstructions }); },
    dismissCompactionResult: () => { data.compactionResult = null; notify(); },
    dismissAgentError: (index: number) => { data.agentErrors = data.agentErrors.filter((_, i) => i !== index); notify(); },
    clearAgentErrors: () => { data.agentErrors = []; notify(); },
    setAutoCompaction: (enabled: boolean) => { send({ type: "set_auto_compaction", enabled }); },
    setAutoRetry: (enabled: boolean) => { send({ type: "set_auto_retry", enabled }); },
    abortRetry: () => { send({ type: "abort_retry" }); },
    forceStop: () => { send({ type: "force_stop" }); },
    setModel: (provider: string, modelId: string) => { send({ type: "set_model", provider, modelId }); },
    setThinkingLevel: (level: string) => { send({ type: "set_thinking_level", level }); },
    steer: (message: string, images?: ImageAttachment[]) => { send({ type: "steer", message, images }); },
    followUp: (message: string, images?: ImageAttachment[]) => { send({ type: "follow_up", message, images }); },
    fork: (entryId: string) => { send({ type: "fork", entryId }); },
    setSteeringMode: (mode: "all" | "one-at-a-time") => { send({ type: "set_steering_mode", mode }); },
    setFollowUpMode: (mode: "all" | "one-at-a-time") => { send({ type: "set_follow_up_mode", mode }); },
    clearQueue: () => {
      data.pendingSteering = [];
      data.pendingFollowUp = [];
      send({ type: "clear_queue" });
    },
    exportHtml: (outputPath?: string) => { send({ type: "export_html", outputPath }); },
    switchSession: (sessionPath: string) => {
      data.exportHtmlResult = null;
      data.cloneResult = null;
      data.lastCommandResponse = null;
      send({ type: "switch_session", sessionPath });
    },
    clone: () => { send({ type: "clone" }); },
    getMessages: () => { send({ type: "get_messages" }); },
    getLastAssistantText: () => { send({ type: "get_last_assistant_text" }); },

    get messages() { return data.messages; },
    get liveMessages() { return data.liveMessages; },
    get runningTools() { return data.runningTools; },
    get state() { return data.state; },
    get lastError() { return data.lastError; },
    get isConnected() { return data.isConnected; },
    get authExpired() { return data.authExpired; },
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
    get pendingSteering() { return data.pendingSteering; },
    get pendingFollowUp() { return data.pendingFollowUp; },
    get extensionErrors() { return data.extensionErrors; },
    get agentErrors() { return data.agentErrors; },
    get compactionResult() { return data.compactionResult; },
    get exportHtmlResult() { return data.exportHtmlResult; },
    get cloneResult() { return data.cloneResult; },
    get lastCommandResponse() { return data.lastCommandResponse; },

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
    /**
     * Rename this connection's pool key. Used when a pending new session
     * (keyed by newSessionId) resolves to its real filePath from the server.
     * The underlying WebSocket stays connected — only the pool map entry moves.
     */
    rekey: (newKey: string) => {
      if (newKey === currentKey) return;
      // #4: update reconnect params so a dropped WS reattaches to the resolved
      // agent. Key format is `${projectId}::${sessionPath}::${newSessionId}`;
      // after resolve it's `${projectId}::${filePath}::` (empty newSessionId).
      // sessionPath is a ~/.pi file path (no `::`), so split is safe.
      // H7: split on the FIRST and LAST `::` (not split("::")) so a sessionPath
      // that itself contains `::` (valid on POSIX) doesn't corrupt parts[1]/[2]
      // and send a truncated path on reconnect → a duplicate agent spawn.
      const first = newKey.indexOf("::");
      const last = newKey.lastIndexOf("::");
      currentSessionPath = (first >= 0 && last > first) ? newKey.slice(first + 2, last) : null;
      currentNewSessionId = last >= 0 ? newKey.slice(last + 2) || null : null;
      // Only unregister from old key if we're still the registered conn there
      if (pool.current.get(currentKey) === conn) {
        pool.current.delete(currentKey);
      }
      pool.current.set(newKey, conn);
      currentKey = newKey;
      notify();
    },
    close: () => {
      intentionallyClosed = true;
      removeLifecycleListeners();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      clearInterval(healthCheck);
      pendingQueue.length = 0; // E13: drop queued messages on terminal close
      const timer = (data as { notifyTimer?: ReturnType<typeof setTimeout> }).notifyTimer;
      if (timer) { clearTimeout(timer); delete (data as { notifyTimer?: ReturnType<typeof setTimeout> }).notifyTimer; }
      ws?.close(); ws = null;
    },
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
    // Need a projectId AND at least one of (sessionPath, newSessionId).
    // The pool is keyed per-session now — there's no project-level default conn.
    if (!projectId || (!sessionPath && !newSessionId)) return null;

    // Key format: `${projectId}::${sessionPath}::${newSessionId}`.
    // - Existing session:    `projId::/path/to/session.json::`
    // - Pending new session: `projId::::newSessionUuid`
    // - Resolved pending:    rekeyed to the filePath form above
    const key = `${projectId}::${sessionPath || ""}::${newSessionId || ""}`;
    const existing = poolRef.current.get(key);
    if (existing) return existing;

    const conn = createConnection(key, projectId, sessionPath, newSessionId, poolRef);
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

  /**
   * Convenience pool-level rekey. The conn's own rekey() does the same work
   * (and is what the App calls directly). This is here for symmetry and so
   * callers that only have the oldKey can do the swap without touching the conn.
   */
  const rekey = useCallback((oldKey: string, newKey: string) => {
    const conn = poolRef.current.get(oldKey);
    if (conn) conn.rekey(newKey);
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

  return { getOrConnect, disconnect, disconnectAll, rekey, pool: poolRef.current };
}
