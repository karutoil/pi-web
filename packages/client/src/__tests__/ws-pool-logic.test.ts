import { describe, it, expect } from "vitest";
import type { ChatMessage } from "@pi-web/shared";
import { reconnectDelay, messageSignature, mergeMessagesOnReconnect, MAX_RECONNECT, SLOW_RECONNECT_MS, BASE_DELAY } from "../lib/ws-pool-logic";

// These tests run without a React environment — they verify the two pieces of
// client-side logic that prevent losing a session on WS drop: the reconnect
// backoff (#3) and the reconnect message-merge (#7).

const user = (text: string, toolCallId?: string): ChatMessage => ({
  role: "user",
  content: text,
  timestamp: new Date().toISOString(),
  ...(toolCallId ? { toolCallId } : {}),
});
const assistant = (text: string): ChatMessage => ({ role: "assistant", content: text, timestamp: "" });

describe("reconnectDelay (#3: never give up)", () => {
  it("uses exponential backoff for the fast phase", () => {
    expect(reconnectDelay(0)).toBe(BASE_DELAY);                       // 1s
    expect(reconnectDelay(1)).toBe(BASE_DELAY * 1.5);                 // 1.5s
    expect(reconnectDelay(2)).toBe(BASE_DELAY * 1.5 * 1.5);           // 2.25s
  });

  it("stops growing (caps at the slow cadence) after MAX_RECONNECT attempts", () => {
    // The OLD code gave up entirely after MAX_RECONNECT (leaving the session dead).
    // The fix: keep retrying forever at SLOW_RECONNECT_MS.
    expect(reconnectDelay(MAX_RECONNECT)).toBe(SLOW_RECONNECT_MS);
    expect(reconnectDelay(MAX_RECONNECT + 1)).toBe(SLOW_RECONNECT_MS);
    expect(reconnectDelay(1000)).toBe(SLOW_RECONNECT_MS); // still trying, not null/Infinity
  });

  it("never returns a non-finite or zero/negative delay", () => {
    for (let i = 0; i <= MAX_RECONNECT + 5; i++) {
      const d = reconnectDelay(i);
      expect(Number.isFinite(d)).toBe(true);
      expect(d).toBeGreaterThan(0);
    }
  });
});

describe("mergeMessagesOnReconnect (#7: don't drop in-flight user messages)", () => {
  it("appends a local-only user prompt the server hasn't persisted yet", () => {
    const restored = [assistant("hi")];
    const local = [user("my unpersisted steer")];
    const merged = mergeMessagesOnReconnect(restored, local);
    expect(merged.map((m) => (m.content as string))).toEqual(["hi", "my unpersisted steer"]);
  });

  it("does NOT duplicate a user message the server already persisted", () => {
    const restored = [user("hello"), assistant("hi")];
    const local = [user("hello")]; // same text -> same signature -> deduped
    const merged = mergeMessagesOnReconnect(restored, local);
    expect(merged.filter((m) => m.role === "user")).toHaveLength(1);
  });

  it("never trusts local assistant/toolResult over the server (trust persisted history)", () => {
    const restored = [user("q"), assistant("server-answer")];
    const local = [user("q"), assistant("stale-local-partial")]; // partial local assistant must be dropped
    const merged = mergeMessagesOnReconnect(restored, local);
    expect(merged.map((m) => (m.content as string))).toEqual(["q", "server-answer"]);
  });

  it("keeps multiple distinct local user messages in order", () => {
    const restored: ChatMessage[] = [];
    const local = [user("first"), user("second"), user("third")];
    const merged = mergeMessagesOnReconnect(restored, local);
    expect(merged.map((m) => (m.content as string))).toEqual(["first", "second", "third"]);
  });

  it("treats messages with identical text but different toolCallId as distinct", () => {
    // toolResult dedup relies on toolCallId; the signature includes it.
    const a: ChatMessage = { role: "user", content: "x", timestamp: "", toolCallId: "tc1" } as any;
    const b: ChatMessage = { role: "user", content: "x", timestamp: "", toolCallId: "tc2" } as any;
    expect(messageSignature(a)).not.toBe(messageSignature(b));
  });

  it("does NOT duplicate an image-attachment user message (SDK echoes typeless image blocks)", () => {
    // The optimistic copy tags images {type:"image",...}; the SDK echoes them
    // as {data, mimeType} (no type). Same message, different shapes — the
    // signature must collide so the optimistic copy dedups against the echo.
    const optimistic: ChatMessage = {
      role: "user",
      content: [
        { type: "text", text: "see this" },
        { type: "image", data: "AAA", mimeType: "image/png" },
      ],
      timestamp: "",
    };
    const echoed: ChatMessage = {
      role: "user",
      content: [
        { type: "text", text: "see this" },
        { data: "AAA", mimeType: "image/png" } as any,
      ],
      timestamp: "",
    };
    expect(messageSignature(optimistic)).toBe(messageSignature(echoed));
    const merged = mergeMessagesOnReconnect([echoed], [optimistic]);
    expect(merged.filter((m) => m.role === "user")).toHaveLength(1);
  });
});
