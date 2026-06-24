// ponytail: pure helpers extracted from useWebSocketPool so the reconnect
// backoff (#3) and the reconnect message-merge (#7) — the two pieces of logic
// that protect against losing a session on WS drop — have a runnable check
// without needing a React render environment.

import type { ChatMessage } from "@pi-web/shared";
import { messageSignature } from "@pi-web/shared";

export const MAX_RECONNECT = 10;        // fast exponential-backoff attempts
export const SLOW_RECONNECT_MS = 30_000; // #3: then keep trying slowly forever
export const BASE_DELAY = 1000;

/**
 * Reconnect delay (#3): exponential backoff for the first MAX_RECONNECT
 * attempts, then a fixed slow cadence forever — so a long server outage or
 * deploy recovers instead of leaving the client permanently dead.
 * Never returns null/infinity — the client always retries.
 */
export function reconnectDelay(attempt: number): number {
  if (attempt < MAX_RECONNECT) {
    return BASE_DELAY * Math.pow(1.5, attempt);
  }
  return SLOW_RECONNECT_MS;
}

export { messageSignature } from "@pi-web/shared";

/**
 * Merge server-persisted history with locally-held messages on reconnect (#7).
 * Server messages win; any local-only USER messages (e.g. a prompt sent right
 * before the WS dropped that PI hasn't persisted yet) are appended so they
 * don't vanish from the UI (which would otherwise prompt a duplicate send).
 * Assistant/toolResult are never taken from the local set — trust the server.
 */
export function mergeMessagesOnReconnect(restored: ChatMessage[], local: ChatMessage[]): ChatMessage[] {
  const seen = new Set(restored.map(messageSignature));
  const localOnly = local.filter((m) => m.role === "user" && !seen.has(messageSignature(m)));
  return [...restored, ...localOnly];
}
