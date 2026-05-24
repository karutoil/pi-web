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

/**
 * Minimal interface that components depend on.
 * WSConnection (from useWebSocketPool) extends this with pool-specific
 * fields (key, subscribe, unsubscribe, close) but is assignable to WSBridge.
 */
export interface WSBridge {
  send: (msg: WSClientMessage) => void;
  sendPrompt: (text: string, images?: ImageAttachment[]) => void;
  newSession: () => void;
  loadSession: (sessionPath: string) => void;
  messages: ChatMessage[];
  liveMessages: Map<string, ChatMessage>;
  runningTools: Map<string, ToolEvent>;
  state: AgentState | null;
  isConnected: boolean;
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
}
