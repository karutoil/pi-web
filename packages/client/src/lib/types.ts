/**
 * Shared WebSocket-related types.
 *
 * These were originally defined in both useWebSocket.ts (legacy) and
 * useWebSocketPool.ts (active). Consolidated here to avoid duplication
 * and allow components to import types without depending on a specific hook.
 */

import type { WSClientMessage, WSServerMessage, AgentState, ChatMessage, SessionDetail,
  ModelInfo, CommandInfo, ForkEntry, SessionStats, ExtensionUIRequest, ImageAttachment, ToolDetails, ContentBlock } from "@pi-web/shared";

export interface ToolEvent {
  toolCallId: string; toolName: string; args: Record<string, unknown>;
  partialResult?: { content: ContentBlock[]; details?: ToolDetails }; result?: { content: ContentBlock[]; details?: ToolDetails }; isError?: boolean;
  status: "running" | "done" | "error";
}

/** Extension status bar entry */
export interface StatusEntry {
  key: string;
  text: string;
}

/** Extension widget */
export interface WidgetEntry {
  key: string;
  lines: string[];
  placement: "aboveEditor" | "belowEditor";
}

/** Auto-retry state */
export interface AutoRetryState {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  errorMessage: string;
}

/** Extension error entry */
export interface ExtensionErrorEntry {
  extensionPath: string;
  event: string;
  error: string;
}

/** Compaction result */
export interface CompactionResultState {
  reason: string;
  aborted: boolean;
  result?: any;
  willRetry?: boolean;
  errorMessage?: string;
}

export interface ExportHtmlResultState {
  path: string;
}

export interface CloneResultState {
  cancelled: boolean;
  sessionPath?: string;
}

export interface CommandResponseState {
  command: string;
  success: boolean;
  error?: string;
  id?: string;
}

/**
 * Minimal interface that components depend on.
 * WSConnection (from useWebSocketPool) extends this with pool-specific
 * fields (key, subscribe, unsubscribe, close) but is assignable to WSBridge.
 */
export interface WSBridge {
  send: (msg: WSClientMessage) => void;
  forceStop: () => void;
  sendPrompt: (text: string, images?: ImageAttachment[]) => void;
  newSession: () => void;
  loadSession: (sessionPath: string) => void;
  messages: ChatMessage[];
  liveMessages: Map<string, ChatMessage>;
  runningTools: Map<string, ToolEvent>;
  state: AgentState | null;
  lastError: string | null;
  isConnected: boolean;
  // True when an auth gateway (Cloudflare Access, etc.) rejected the WS
  // upgrade because the session expired — retrying can't succeed until the
  // user re-logs-in, so the UI offers a re-login button instead.
  authExpired: boolean;
  isStreaming: boolean;
  isActive: boolean;
  models: ModelInfo[]; commands: CommandInfo[];
  forkMessages: ForkEntry[]; sessionStats: SessionStats | null;
  pendingDialog: ExtensionUIRequest | null;
  pendingNotification: ExtensionUIRequest | null;
  respondToUI: (response: { value?: string; confirmed?: boolean; cancelled?: boolean }) => void;
  dismissNotification: () => void;
  setOnSessionLoaded: (cb: ((session: SessionDetail) => void) | null) => void;
  setOnSessionEvent: (cb: ((event: WSServerMessage) => void) | null) => void;
  /**
   * Rename this connection in the pool. Used when a pending new session gets
   * its real filePath from the server — the pool entry moves from
   * `${projectId}::__pending__::${newSessionId}` to `${projectId}::${filePath}`
   * without dropping the underlying connection (so streaming/background work continues).
   */
  rekey: (newKey: string) => void;
  // New: extension UI fire-and-forget state
  statusEntries: Record<string, string>;
  widgets: Record<string, { lines: string[]; placement: string }>;
  windowTitle: string | null;
  // New: auto-retry state
  autoRetry: AutoRetryState | null;
  // New: extension errors
  extensionErrors: ExtensionErrorEntry[];
  // New: agent-level request errors surfaced for review / resolve
  agentErrors: string[];
  dismissAgentError: (index: number) => void;
  clearAgentErrors: () => void;
  // New: compaction result
  compactionResult: CompactionResultState | null;
  // New: session action results
  exportHtmlResult: ExportHtmlResultState | null;
  cloneResult: CloneResultState | null;
  lastCommandResponse: CommandResponseState | null;
  // New: pending queue messages we sent locally but have not yet seen as a persisted user message
  pendingSteering: string[];
  pendingFollowUp: string[];
  // New: command methods
  cycleModel: () => void;
  cycleThinkingLevel: () => void;
  compact: (customInstructions?: string) => void;
  dismissCompactionResult: () => void;
  setAutoCompaction: (enabled: boolean) => void;
  setAutoRetry: (enabled: boolean) => void;
  abortRetry: () => void;
  setSteeringMode: (mode: "all" | "one-at-a-time") => void;
  setFollowUpMode: (mode: "all" | "one-at-a-time") => void;
  clearQueue: () => void;
  exportHtml: (outputPath?: string) => void;
  switchSession: (sessionPath: string) => void;
  clone: () => void;
  getMessages: () => void;
  getLastAssistantText: () => void;
  // Typed command helpers (previously sent as raw ws.send(...))
  setModel: (provider: string, modelId: string) => void;
  setThinkingLevel: (level: string) => void;
  steer: (message: string, images?: ImageAttachment[]) => void;
  followUp: (message: string, images?: ImageAttachment[]) => void;
  fork: (entryId: string) => void;
}
