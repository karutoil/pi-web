import type { ChatMessage } from "./types";

/**
 * Signature used to dedup chat messages across reconnect and agent-end merges.
 * Two messages with the same role+text(+toolCallId) are treated as the same
 * persisted message.
 *
 * Known ceiling: two genuinely-distinct user messages with identical text
 * collide (e.g. "yes" twice) — acceptable for a chat UI where that's rare
 * and the second is usually a deliberate repeat.
 */
export function messageSignature(msg: ChatMessage): string {
  let text = "";
  if (typeof msg.content === "string") {
    text = msg.content;
  } else if (Array.isArray(msg.content)) {
    text = msg.content
      .map((c) => {
        if (c.type === "text") return c.text ?? "";
        // SDK echoes image attachments as {data, mimeType} with no `type`
        // field (it pushes ImageAttachment objects raw); treat a
        // mimeType-bearing block as an image so the optimistic copy dedups
        // against the echo.
        if (c.type === "image" || c.mimeType) return `image:${c.mimeType ?? ""}`;
        return c.type ?? "";
      })
      .join("|");
  }
  return `${msg.role}:${text}:${msg.toolCallId ?? ""}`;
}
