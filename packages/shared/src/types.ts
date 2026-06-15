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

// ─── App version / update-checker (#160) ───
export interface VersionInfo {
  /** Short commit hash (7 chars) of HEAD, e.g. "52471ca". */
  commit: string;
  /** Full commit hash. */
  fullCommit: string;
  /** Current branch name, or "HEAD" if detached. */
  branch: string;
  /** First line of the most recent commit message. */
  commitMessage: string;
  /** Commits HEAD is ahead of origin/<defaultBranch>. */
  ahead: number;
  /** Commits HEAD is behind origin/<defaultBranch>. */
  behind: number;
  /** True when the working tree has uncommitted changes. */
  dirty: boolean;
  /** True when up-to-date with origin/<defaultBranch> AND clean. */
  upToDate: boolean;
  /** Default remote branch being compared (e.g. "main"). */
  defaultBranch: string;
  /**
   * True when an `origin/<defaultBranch>` ref is present and the snapshot
   * was actually compared against it. When false, ahead/behind are 0 by
   * construction and `upToDate` is meaningless.
   */
  hasRemote: boolean;
  /** True when the server itself is not inside a git working tree. */
  unavailable: boolean;
  /** ISO timestamp this snapshot was taken. */
  fetchedAt: string;
  /** Remote URL used to refresh the behind count at runtime (optional). */
  remoteUrl?: string;
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
  timestamp: string;
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
  details?: ToolDetails;
  // bash execution
  command?: string;
  output?: string;
  exitCode?: number;
  cancelled?: boolean;
  truncated?: boolean;
  fullOutputPath?: string;
  // branch/compaction
  tokensBefore?: number;
  // thinking
  thinking?: string;
}

/** Tool result details — currently known: diff. Extensible with unknown props. */
export interface ToolDetails {
  diff?: string;
  [key: string]: unknown;
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
  | { type: "steer"; message: string; images?: ImageAttachment[] }
  | { type: "follow_up"; message: string; images?: ImageAttachment[] }
  | { type: "new_session" }
  | { type: "load_session"; sessionPath: string }
  | { type: "switch_session"; sessionPath: string }
  | { type: "rekey_session"; oldKey: string; newKey: string; id?: string }
  | { type: "set_model"; provider: string; modelId: string }
  | { type: "cycle_model" }
  | { type: "set_thinking"; level: string }
  | { type: "cycle_thinking_level" }
  | { type: "delete_session"; sessionId: string }
  | { type: "rename_session"; sessionId: string; name: string }
  | { type: "fork"; entryId: string }
  | { type: "refresh_sessions"; projectId: string }
  | { type: "get_available_models" }
  | { type: "get_commands" }
  | { type: "get_fork_messages" }
  | { type: "get_messages" }
  | { type: "get_last_assistant_text" }
  | { type: "get_session_stats" }
  | { type: "set_session_name"; name: string }
  | { type: "compact"; customInstructions?: string }
  | { type: "get_state" }
  | { type: "set_auto_compaction"; enabled: boolean }
  | { type: "set_auto_retry"; enabled: boolean }
  | { type: "abort_retry" }
  | { type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
  | { type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }
  | { type: "export_html"; outputPath?: string }
  | { type: "clone" }
  | { type: "bash"; command: string }
  | { type: "abort_bash" }
  | { type: "extension_ui_response"; id: string; value?: string; confirmed?: boolean; cancelled?: boolean };

export type WSServerMessage =
  | { type: "state"; data: AgentState }
  | { type: "agent_start" }
  | { type: "agent_end"; messages: ChatMessage[] }
  | { type: "message_start"; message: ChatMessage }
  | { type: "message_update"; message: ChatMessage; delta: TextDelta | ThinkingDelta | ToolCallDelta }
  | { type: "message_end"; message: ChatMessage }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: "tool_update"; toolCallId: string; partialResult: { content: ContentBlock[]; details?: ToolDetails } }
  | { type: "tool_end"; toolCallId: string; toolName: string; result: { content: ContentBlock[]; details?: ToolDetails }; isError: boolean }
  | { type: "turn_start" }
  | { type: "turn_end"; message: ChatMessage; toolResults: ChatMessage[] }
  | { type: "queue_update"; steering: string[]; followUp: string[] }
  | { type: "compaction_start"; reason: string }
  | { type: "compaction_end"; reason: string; aborted: boolean; result?: CompactionResult; willRetry?: boolean; errorMessage?: string }
  | { type: "error"; message: string }
  | { type: "response"; command: string; success: boolean; data?: unknown; error?: string; id?: string }
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
  | { type: "extension_ui_request"; ui: ExtensionUIRequest }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
  | { type: "extension_error"; extensionPath: string; event: string; error: string }
  | { type: "export_html_result"; path: string }
  | { type: "clone_result"; cancelled: boolean; sessionPath?: string }
  | { type: "messages_result"; messages: ChatMessage[] }
  | { type: "last_assistant_text_result"; text: string | null };

// Extension UI protocol
export type ExtensionUIMethod = "select" | "confirm" | "input" | "editor" | "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text";

export interface ExtensionUIRequest {
  id: string;
  method: ExtensionUIMethod;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  timeout?: number;
  notifyType?: "info" | "warning" | "error" | "success";
  // setStatus fields
  statusKey?: string;
  statusText?: string;
  // setWidget fields
  widgetKey?: string;
  widgetLines?: string[];
  widgetPlacement?: "aboveEditor" | "belowEditor";
  // set_editor_text fields
  text?: string;
}

/** Compaction result data */
export interface CompactionResult {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details: Record<string, unknown>;
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

// ─── Workspace layout ───

export type WorkspacePanelKind = "chat" | "preview" | "git" | "terminal" | "rail" | "channels" | "files" | "extensions";
export type WorkspaceRegionId = "left" | "center" | "right" | "top" | "bottom";
export type WorkspaceRegionMode = "tabs" | "split";

export interface WorkspaceRegionLayout {
  id: WorkspaceRegionId;
  size: number;
  mode: WorkspaceRegionMode;
}

export interface WorkspacePanelLayout {
  id: WorkspacePanelKind;
  region: WorkspaceRegionId;
  order: number;
  size: number;
}

export interface WorkspaceLayout {
  version: number;
  regions: WorkspaceRegionLayout[];
  panels: WorkspacePanelLayout[];
  updatedAt: string | null;
}

export interface APILayoutResponse {
  layout: WorkspaceLayout;
}

export interface SaveLayoutRequest {
  layout: WorkspaceLayout;
}

// ─── Preview types ───

export type PreviewStatus = "detecting" | "selecting" | "starting" | "running" | "crashed" | "stopped";

export interface PreviewInfo {
  id: string;
  projectId: string;
  label: string;
  port: number;
  url: string;
  status: PreviewStatus;
  /** Log entries (newest last) */
  logs: string[];
  startedAt: number;
  /** Shell command used to spawn, e.g. "npm run dev" */
  command: string | null;
  /** PID of the spawned process, tracked for cleanup */
  process: number | null;
  /** Working directory of the dev server */
  cwd: string;
  /** All detected listening ports from the spawned process */
  detectedPorts: number[];
  /** Health-poll timer handle (for server internal use) */
  healthTimer: ReturnType<typeof setInterval> | null;
  /** Remote URL to proxy to (e.g. "https://panel.catalystctl.com"). When set, no local dev server is spawned. */
  remoteUrl?: string;
}

export interface PreviewStartRequest {
  projectId: string;
  cwd: string;
  label?: string;
  command?: string;
  port?: number;
  /** Remote URL to proxy to instead of a local dev server */
  remoteUrl?: string;
}

export interface SerializedElement {
  /** Unique CSS selector path, e.g. "html>body>div.container>button.btn" */
  selector: string;
  tagName: string;
  /** Truncated to 5KB */
  outerHTML: string;
  boundingBox: { x: number; y: number; width: number; height: number };
  computedStyles: Record<string, string>;
  /** First 200 characters */
  textContent: string;
  /** React component info if __REACT_DEVTOOLS_GLOBAL_HOOK__ is available */
  source?: {
    file?: string;
    line?: number;
    col?: number;
    /** React component name (displayName or function name) */
    componentName?: string;
    /** Full component ancestor chain, nearest first */
    componentStack?: string[];
  };
  /** Base64-encoded PNG data URL (via modern-screenshot) */
  screenshotPng?: string;
  /** Unique token for @element mention */
  token: string;
  /** URL of the page where the element was selected */
  pageUrl: string;
  /** Document title of the page */
  pageTitle: string;
}

export interface PreviewLogMessage {
  type: "preview_log";
  projectId: string;
  label: string;
  text: string;
  stream: "stdout" | "stderr";
}
