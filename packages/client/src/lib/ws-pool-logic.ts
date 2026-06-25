// ponytail: pure helpers extracted from useWebSocketPool so the reconnect
// backoff (#3) and the reconnect message-merge (#7) — the two pieces of logic
// that protect against losing a session on WS drop — have a runnable check
// without needing a React render environment.

import type { ChatMessage } from "@pi-web/shared";
import { messageSignature } from "@pi-web/shared";

export const MAX_RECONNECT = 10;        // fast exponential-backoff attempts
export const SLOW_RECONNECT_MS = 10_000; // #3: then keep trying slowly forever
export const BASE_DELAY = 1000;

/**
 * Reconnect delay (#3): exponential backoff for the first MAX_RECONNECT
 * attempts, then a fixed slow cadence forever — so a long server outage or
 * deploy recovers instead of leaving the client permanently dead.
 * Never returns null/infinity — the client always retries.
 */
export function reconnectDelay(attempt: number): number {
  if (attempt < MAX_RECONNECT) {
    // Cap the fast phase at SLOW_RECONNECT_MS — without this, attempt 9 is
    // 1000 * 1.5^9 ≈ 38s, which is SLOWER than the "slow" cadence it's
    // supposed to graduate into. A backgrounded tab whose sockets died and
    // climbed the attempt count would then strand the user for ~38s on return.
    return Math.min(BASE_DELAY * Math.pow(1.5, attempt), SLOW_RECONNECT_MS);
  }
  // ponytail: ±20% jitter avoids thundering-herd when many clients reconnect
  // after a shared server restart.
  return SLOW_RECONNECT_MS * (0.8 + Math.random() * 0.4);
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
