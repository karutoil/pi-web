// ─── Raw-API markdown export for chat messages ───
//
// Output is a faithful text representation of what the API sent for a
// message/turn/session. Content blocks are rendered as close to the original
// wire form as possible: text blocks verbatim, thinking as a blockquote,
// tool calls as fenced JSON, tool results (incl. diffs) as fenced blocks.
//
// Goal: what the user pastes should look like the raw LLM/provider payload
// rendered as markdown, not the post-processed bubble view.

import type { ChatMessage, ContentBlock } from "@pi-web/shared";

/** Convert a message's content blocks to raw markdown text. */
export function blocksToMarkdown(content: ContentBlock[] | string): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const b of content) {
    if (b.type === "text" && b.text) {
      parts.push(b.text);
    } else if (b.type === "thinking" && b.thinking) {
      // Render thinking as a blockquote to distinguish from assistant text.
      const quoted = b.thinking
        .split("\n")
        .map(l => (l.length ? `> ${l}` : ">"))
        .join("\n");
      parts.push(quoted);
    } else if (b.type === "toolCall") {
      const name = b.name || "tool";
      const args = b.arguments != null ? JSON.stringify(b.arguments, null, 2) : "{}";
      parts.push("```json\n// tool: " + name + "\n" + args + "\n```");
    } else if (b.type === "image") {
      parts.push("[image: " + (b.mimeType || "unknown") + "]");
    }
    // Unknown block types: omit (forward-compat — better than garbage)
  }
  // Text blocks are joined with a blank line so the model-generated
  // paragraph spacing survives the round-trip.
  return parts.join("\n\n");
}

/** Human-friendly role label for markdown section headers. */
export function roleLabel(role: string, toolName?: string): string {
  switch (role) {
    case "user": return "User";
    case "assistant": return "Assistant";
    case "toolResult": return "Tool (" + (toolName || "unknown") + ")";
    case "bashExecution": return "Bash";
    case "branchSummary": return "Branch summary";
    case "compactionSummary": return "Context compacted";
    default: return role;
  }
}

/** Convert a single message to raw markdown, role-agnostic. */
export function messageToMarkdown(msg: ChatMessage): string {
  // Bash execution: render the command, output (fenced), and exit code.
  if (msg.role === "bashExecution") {
    const body: string[] = [];
    if (msg.command) body.push("$ " + msg.command);
    if (msg.output) body.push("```\n" + msg.output + "\n```");
    if (msg.exitCode !== undefined) body.push("exit " + msg.exitCode);
    return body.join("\n\n");
  }

  // Tool result: prefer the diff payload if present, else plain text.
  if (msg.role === "toolResult") {
    const header = "**" + (msg.toolName || "tool") + " result**" +
      (msg.isError ? " *(error)*" : "");
    if (msg.details?.diff && typeof msg.details.diff === "string") {
      return header + "\n\n```diff\n" + msg.details.diff + "\n```";
    }
    const text = blocksToMarkdown(msg.content);
    if (text) return header + "\n\n```\n" + text + "\n```";
    return header;
  }

  // System messages: emit content as-is.
  if (msg.role === "branchSummary" || msg.role === "compactionSummary") {
    return blocksToMarkdown(msg.content);
  }

  // User / assistant: raw text from the API.
  return blocksToMarkdown(msg.content);
}

/** Convert a turn (array of messages, user → final assistant) to markdown. */
export function turnToMarkdown(turn: ChatMessage[]): string {
  return turn
    .map(m => "## " + roleLabel(m.role, m.toolName) + "\n\n" + messageToMarkdown(m))
    .join("\n\n");
}

/**
 * Convert an entire session to markdown.
 *
 * @param messages  Messages in chronological order (any grouping; the caller
 *                  decides granularity — typically SessionEntry.message[]).
 * @param name      Optional session title used as the H1 header.
 */
export function sessionToMarkdown(messages: ChatMessage[], name?: string): string {
  const header = name ? "# " + name + "\n\n" : "";
  return header + turnToMarkdown(messages);
}

/**
 * Copy text to the clipboard with a graceful fallback for non-secure contexts
 * (HTTP, sandboxed iframes) where `navigator.clipboard` may be undefined or
 * throw. Returns true on success.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext !== false) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to fallback
  }
  // Fallback: hidden textarea + execCommand. Works in older browsers and
  // insecure contexts where the async Clipboard API is blocked.
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
