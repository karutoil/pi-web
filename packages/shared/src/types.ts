// Shared types between server and client

export interface Project {
  id: string;
  name: string;
  path: string;
  addedAt: string;
  lastOpenedAt: string | null;
  sessionCount: number;
  lastActiveAt: string | null;
  totalTokens: number;
  totalCost: number;
}

export interface SessionSummary {
  id: string;
  filePath: string;
  cwd: string;
  timestamp: string;
  name: string | null;
  messageCount: number;
  lastMessage: string | null;
  model: string | null;
  firstMessage: string | null;
  createdAt: string;
  lastActiveAt: string;
  tokenCount: number;
  cost: number;
  isRecentlyActive: boolean;
}

export interface SessionDetail {
  id: string;
  filePath: string;
  cwd: string;
  timestamp: string;
  name: string | null;
  version: number;
  entries: SessionEntry[];
}

export interface SessionEntry {
  id: string;
  parentId: string | null;
  type: string;
  timestamp: string;
  message?: ChatMessage;
  // model_change
  provider?: string;
  modelId?: string;
  // thinking_level_change
  thinkingLevel?: string;
  // compaction
  summary?: string;
  // label
  label?: string;
  targetId?: string;
  // branch_summary
  fromId?: string;
  // custom entries
  customType?: string;
  data?: unknown;
  content?: unknown;
  display?: boolean;
}

export interface ChatMessage {
  role: string;
  content: string | ContentBlock[];
  timestamp?: number;
  // assistant
  api?: string;
  provider?: string;
  model?: string;
  usage?: TokenUsage;
  stopReason?: string;
  errorMessage?: string;
  // tool result
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  details?: any;
  // bash execution
  command?: string;
  output?: string;
  exitCode?: number;
  cancelled?: boolean;
  truncated?: boolean;
  // branch/compaction
  tokensBefore?: number;
  // thinking
  thinking?: string;
}

export interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  data?: string;
  mimeType?: string;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens?: number;
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

// WebSocket message types
export type WSClientMessage =
  | { type: "prompt"; message: string; images?: ImageAttachment[] }
  | { type: "abort" }
  | { type: "steer"; message: string }
  | { type: "follow_up"; message: string }
  | { type: "new_session" }
  | { type: "set_model"; provider: string; modelId: string }
  | { type: "set_thinking"; level: string }
  | { type: "delete_session"; sessionId: string }
  | { type: "rename_session"; sessionId: string; name: string }
  | { type: "fork"; entryId: string }
  | { type: "refresh_sessions"; projectId: string }
  | { type: "get_available_models" }
  | { type: "get_commands" }
  | { type: "get_fork_messages" }
  | { type: "get_session_stats" }
  | { type: "set_session_name"; name: string }
  | { type: "compact" }
  | { type: "get_state" }
  | { type: "extension_ui_response"; id: string; value?: string; confirmed?: boolean; cancelled?: boolean };

export type WSServerMessage =
  | { type: "state"; data: AgentState }
  | { type: "agent_start" }
  | { type: "agent_end"; messages: ChatMessage[] }
  | { type: "message_start"; message: ChatMessage }
  | { type: "message_update"; message: ChatMessage; delta: TextDelta | ThinkingDelta | ToolCallDelta }
  | { type: "message_end"; message: ChatMessage }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: "tool_update"; toolCallId: string; partialResult: { content: ContentBlock[] } }
  | { type: "tool_end"; toolCallId: string; toolName: string; result: { content: ContentBlock[]; details?: any }; isError: boolean }
  | { type: "turn_start" }
  | { type: "turn_end"; message: ChatMessage; toolResults: ChatMessage[] }
  | { type: "queue_update"; steering: string[]; followUp: string[] }
  | { type: "compaction_start"; reason: string }
  | { type: "compaction_end"; reason: string; aborted: boolean }
  | { type: "error"; message: string }
  | { type: "session_loaded"; session: SessionDetail }
  | { type: "model_changed"; provider: string; modelId: string }
  | { type: "thinking_changed"; level: string }
  | { type: "available_models"; models: ModelInfo[] }
  | { type: "available_commands"; commands: CommandInfo[] }
  | { type: "fork_messages"; messages: ForkEntry[] }
  | { type: "session_stats"; stats: SessionStats }
  | { type: "session_name_changed"; name: string }
  | { type: "session_deleted"; sessionId: string }
  | { type: "session_renamed"; sessionId: string; name: string }
  | { type: "sessions_refreshed"; sessions: SessionSummary[] }
  | { type: "extension_ui_request"; ui: ExtensionUIRequest };

// Extension UI protocol
export type ExtensionUIMethod = "select" | "confirm" | "input" | "editor" | "notify" | "setStatus";

export interface ExtensionUIRequest {
  id: string;
  method: ExtensionUIMethod;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  timeout?: number;
  notifyType?: "info" | "warning" | "error";
}

export interface ModelInfo {
  id: string;
  name: string;
  api: string;
  provider: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: string[];
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface CommandInfo {
  name: string;
  description?: string;
  source: string;
  location?: string;
  path?: string;
}

export interface ForkEntry {
  entryId: string;
  text: string;
}

export interface SessionStats {
  sessionFile: string | null;
  sessionId: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: TokenUsage;
  cost: number;
  contextUsage?: {
    tokens: number;
    contextWindow: number;
    percent: number;
  };
}

export interface AgentState {
  isStreaming: boolean;
  isCompacting: boolean;
  sessionFile: string | null;
  sessionId: string;
  sessionName: string | null;
  model: string | null;
  thinkingLevel: string;
  messageCount: number;
  pendingMessageCount: number;
  steering: string[];
  followUp: string[];
}

export interface TextDelta {
  type: "text_delta";
  contentIndex: number;
  delta: string;
}

export interface ThinkingDelta {
  type: "thinking_delta";
  contentIndex: number;
  delta: string;
}

export interface ToolCallDelta {
  type: "toolcall_delta" | "toolcall_start" | "toolcall_end";
  contentIndex: number;
  delta?: string;
  toolCall?: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface ImageAttachment {
  data: string;
  mimeType: string;
}

export interface APISessionListResponse {
  sessions: SessionSummary[];
  total: number;
}

export interface APIProjectsResponse {
  projects: Project[];
}
