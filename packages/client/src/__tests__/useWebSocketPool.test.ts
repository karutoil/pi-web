import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// ─── Fake WebSocket ───
type FakeWS = {
  url: string;
  readyState: number;
  sent: string[];
  onopen: ((e: any) => void) | null;
  onclose: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null;
  onmessage: ((e: any) => void) | null;
  send: (data: string) => void;
  close: () => void;
  _open: () => void;
  _receive: (msg: unknown) => void;
  _close: () => void;
};

const allWS: FakeWS[] = [];

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  url: string;
  readyState = 0; // CONNECTING
  sent: string[] = [];
  onopen: any = null;
  onclose: any = null;
  onerror: any = null;
  onmessage: any = null;
  constructor(url: string) {
    this.url = url;
    const self: FakeWS = this as unknown as FakeWS;
    self._open = () => {
      this.readyState = 1;
      this.onopen?.({});
    };
    self._receive = (msg) => {
      this.onmessage?.({ data: JSON.stringify(msg) });
    };
    self._close = () => this.close();
    allWS.push(self);
  }
  send(data: string) { this.sent.push(data); }
  close() {
    this.readyState = 3;
    this.onclose?.({});
  }
}

beforeEach(() => {
  allWS.length = 0;
  // @ts-expect-error — replace global with our fake class
  globalThis.WebSocket = FakeWebSocket;
});

afterEach(() => {
  vi.useRealTimers();
});

import { useWebSocketPool } from "../hooks/useWebSocketPool";

describe("useWebSocketPool — multi-session keying", () => {
  it("returns null when no projectId/sessionPath/newSessionId is given", () => {
    const { result } = renderHook(() => useWebSocketPool());
    expect(result.current.getOrConnect(null, null, null)).toBeNull();
    expect(result.current.getOrConnect("proj1", null, null)).toBeNull();
  });

  it("creates one connection per (project, session) tuple", () => {
    const { result } = renderHook(() => useWebSocketPool());

    let connA: any, connB: any;
    act(() => { connA = result.current.getOrConnect("p1", "/path/sessionA.json", null); });
    act(() => { connB = result.current.getOrConnect("p1", "/path/sessionB.json", null); });

    expect(connA).not.toBeNull();
    expect(connB).not.toBeNull();
    expect(connA).not.toBe(connB);
    expect(result.current.pool.size).toBe(2);
    expect(connA!.key).toBe("p1::/path/sessionA.json::");
    expect(connB!.key).toBe("p1::/path/sessionB.json::");
  });

  it("reuses the existing connection for the same (project, session)", () => {
    const { result } = renderHook(() => useWebSocketPool());

    let connA1: any, connA2: any;
    act(() => { connA1 = result.current.getOrConnect("p1", "/path/A.json", null); });
    act(() => { connA2 = result.current.getOrConnect("p1", "/path/A.json", null); });

    expect(connA1).toBe(connA2);
    expect(result.current.pool.size).toBe(1);
  });

  it("separate WebSockets are opened for separate sessions", () => {
    const { result } = renderHook(() => useWebSocketPool());

    act(() => { result.current.getOrConnect("p1", "/path/A.json", null); });
    const wsA = allWS[0]!;
    act(() => { result.current.getOrConnect("p1", "/path/B.json", null); });
    const wsB = allWS[1]!;

    expect(wsA).not.toBe(wsB);
    expect(wsA.url).toContain("sessionPath=" + encodeURIComponent("/path/A.json"));
    expect(wsB.url).toContain("sessionPath=" + encodeURIComponent("/path/B.json"));
  });
});

describe("useWebSocketPool — rekey", () => {
  it("rekey moves the pool entry from old key to new key", () => {
    const { result } = renderHook(() => useWebSocketPool());

    let conn: any;
    act(() => { conn = result.current.getOrConnect("p1", null, "uuid-123"); });
    const oldKey = conn!.key;
    expect(oldKey).toBe("p1::::uuid-123");
    expect(result.current.pool.size).toBe(1);
    expect(result.current.pool.get(oldKey)).toBe(conn);

    act(() => { conn!.rekey("p1::/resolved/session.json::"); });

    expect(conn!.key).toBe("p1::/resolved/session.json::");
    expect(result.current.pool.size).toBe(1);
    expect(result.current.pool.get(oldKey)).toBeUndefined();
    expect(result.current.pool.get("p1::/resolved/session.json::")).toBe(conn);
  });

  it("rekey is a no-op when the key is unchanged", () => {
    const { result } = renderHook(() => useWebSocketPool());
    let conn: any;
    act(() => { conn = result.current.getOrConnect("p1", "/A.json", null); });
    const before = result.current.pool.get(conn!.key);
    act(() => { conn!.rekey(conn!.key); });
    expect(result.current.pool.get(conn!.key)).toBe(before);
  });

  it("after rekey, getOrConnect with the new key returns the same conn", () => {
    const { result } = renderHook(() => useWebSocketPool());
    let conn1: any, conn2: any;
    act(() => { conn1 = result.current.getOrConnect("p1", null, "uuid-1"); });
    act(() => { conn1!.rekey("p1::/resolved.json::"); });
    act(() => { conn2 = result.current.getOrConnect("p1", "/resolved.json", null); });
    expect(conn1).toBe(conn2);
    expect(result.current.pool.size).toBe(1);
  });
});

describe("useWebSocketPool — multi-session regression (the user's bug)", () => {
  /**
   * REGRESSION TEST for the bug the user reported:
   *
   * "As soon as I switched sessions the stream stopped and no work was
   * further created."
   *
   * The original code in App.handleSelectSession called
   *   ws.loadSession(B.path)
   * on the OLD WS (for A). That told the OLD PI process to in-process
   * switch to B, killing A's in-flight work. The fix: never reuse the
   * old WS for a different session — each session gets its own WS.
   *
   * This test asserts the pool's contract: opening a new session does
   * NOT cause any side effect on the existing sessions' WebSockets.
   */
  it("opening a second session does NOT send load_session on the first session's WS", async () => {
    vi.useFakeTimers();

    const { result } = renderHook(() => useWebSocketPool());

    // Set up: open session A
    act(() => { result.current.getOrConnect("p1", "/A.json", null); });
    const wsA = allWS[0]!;
    act(() => { wsA._open(); });
    // Pool sends get_state etc. on open via setTimeout(200). Advance.
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    // Clear sent messages from the open-handshake so we only see what
    // happens during session switching.
    wsA.sent.length = 0;

    // Simulate "user clicks session B" — the new architecture creates a
    // fresh WS for B. handleSelectSession does NOT call ws.loadSession on
    // the old WS.
    act(() => { result.current.getOrConnect("p1", "/B.json", null); });

    // Critical assertion: the OLD WS for A must not have received a
    // load_session command.
    const loadSessionSends = wsA.sent.filter((s) => {
      try { return JSON.parse(s).type === "load_session"; } catch { return false; }
    });
    expect(loadSessionSends).toEqual([]);

    // And the OLD WS should not have been closed.
    expect(wsA.readyState).toBe(1); // OPEN, not CLOSED
  });

  it("streaming state on the old session is preserved when opening a new session", () => {
    const { result } = renderHook(() => useWebSocketPool());

    act(() => { result.current.getOrConnect("p1", "/A.json", null); });
    const wsA = allWS[0]!;
    act(() => { wsA._open(); });

    // Simulate server saying "agent started" on session A
    act(() => { wsA._receive({ type: "agent_start" }); });
    // And a state event with sessionId
    act(() => { wsA._receive({
      type: "state",
      data: { isStreaming: true, sessionId: "sessA", sessionFile: "/A.json", messageCount: 0 }
    }); });

    // Sanity check: pool conn reports streaming for A
    const connA = result.current.pool.get("p1::/A.json::")!;
    expect(connA.isStreaming).toBe(true);
    expect(connA.state?.sessionId).toBe("sessA");

    // Now open session B — the new architecture creates a fresh WS
    act(() => { result.current.getOrConnect("p1", "/B.json", null); });
    const wsB = allWS[1]!;
    act(() => { wsB._open(); });
    act(() => { wsB._receive({ type: "agent_start" }); });
    act(() => { wsB._receive({
      type: "state",
      data: { isStreaming: true, sessionId: "sessB", sessionFile: "/B.json", messageCount: 0 }
    }); });

    // A's streaming state must be untouched
    expect(connA.isStreaming).toBe(true);
    expect(connA.state?.sessionId).toBe("sessA");

    // And B is also streaming
    const connB = result.current.pool.get("p1::/B.json::")!;
    expect(connB.isStreaming).toBe(true);
    expect(connB.state?.sessionId).toBe("sessB");
  });
});

describe("useWebSocketPool — reconnect / keepalive client behavior", () => {
  it("requests history and last assistant text after opening", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useWebSocketPool());
    act(() => { result.current.getOrConnect("p1", "/A.json", null); });
    const ws = allWS[0]!;
    act(() => { ws._open(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });

    const types = ws.sent.map((s) => {
      try { return JSON.parse(s).type; } catch { return null; }
    });
    expect(types).toContain("get_state");
    expect(types).toContain("get_messages");
    expect(types).toContain("get_last_assistant_text");
    expect(types).toContain("get_available_models");
    expect(types).toContain("get_commands");

    act(() => { result.current.disconnect("p1::/A.json::"); });
    vi.useRealTimers();
  });

  it("restores messages from messages_result", () => {
    const { result } = renderHook(() => useWebSocketPool());
    let conn: any;
    act(() => { conn = result.current.getOrConnect("p1", "/A.json", null); });
    const ws = allWS[0]!;
    act(() => { ws._open(); });
    act(() => {
      ws._receive({
        type: "messages_result",
        messages: [
          { role: "user", content: "hi", timestamp: "2024-01-01T00:00:00Z" },
          { role: "assistant", content: "hello", timestamp: "2024-01-01T00:00:01Z" },
          { role: "system", content: "ignored", timestamp: "2024-01-01T00:00:02Z" },
        ],
      });
    });

    expect(conn.messages).toHaveLength(2);
    expect(conn.messages[0].role).toBe("user");
    expect(conn.messages[1].role).toBe("assistant");
    act(() => { result.current.disconnect(conn.key); });
  });

  it("surfaces the in-flight streaming message from state.streamingMessage (not last_assistant_text_result)", () => {
    const { result } = renderHook(() => useWebSocketPool());
    let conn: any;
    act(() => { conn = result.current.getOrConnect("p1", "/A.json", null); });
    const ws = allWS[0]!;
    act(() => { ws._open(); });

    // last_assistant_text_result must NOT paint the live bubble — it returns
    // the last COMPLETED text, not the in-flight one, so it would show a phantom
    // stale "streaming" bubble. The in-flight message comes from state.
    act(() => { ws._receive({ type: "last_assistant_text_result", text: "completed response" }); });
    expect(conn.liveMessages.get("current")).toBeUndefined();

    // state.streamingMessage IS the in-flight partial — surface it so a
    // reconnecting client sees the live stream instead of a bare indicator.
    act(() => {
      ws._receive({
        type: "state",
        data: { isStreaming: true, isCompacting: false, sessionFile: "/A.json", sessionId: "sessA", sessionName: null, model: null, thinkingLevel: "off", messageCount: 0, pendingMessageCount: 0, steering: [], followUp: [], streamingMessage: { role: "assistant", content: "streaming...", timestamp: "2024-01-01T00:00:00Z" } },
      });
    });
    expect(conn.liveMessages.get("current")).toEqual({ role: "assistant", content: "streaming...", timestamp: "2024-01-01T00:00:00Z" });

    // When the turn ends (state with isStreaming:false + no streamingMessage),
    // the live bubble clears so no phantom lingers.
    act(() => {
      ws._receive({
        type: "state",
        data: { isStreaming: false, isCompacting: false, sessionFile: "/A.json", sessionId: "sessA", sessionName: null, model: null, thinkingLevel: "off", messageCount: 1, pendingMessageCount: 0, steering: [], followUp: [], streamingMessage: null },
      });
    });
    expect(conn.liveMessages.get("current")).toBeUndefined();

    act(() => { result.current.disconnect(conn.key); });
  });

  it("sets isActive from state.isStreaming on reconnect", () => {
    const { result } = renderHook(() => useWebSocketPool());
    let conn: any;
    act(() => { conn = result.current.getOrConnect("p1", "/A.json", null); });
    const ws = allWS[0]!;
    act(() => { ws._open(); });

    act(() => {
      ws._receive({
        type: "state",
        data: { isStreaming: true, isCompacting: false, sessionFile: "/A.json", sessionId: "sessA", sessionName: null, model: null, thinkingLevel: "off", messageCount: 0, pendingMessageCount: 0, steering: [], followUp: [] },
      });
    });
    expect(conn.isActive).toBe(true);
    expect(conn.isStreaming).toBe(true);

    act(() => {
      ws._receive({
        type: "state",
        data: { isStreaming: false, isCompacting: false, sessionFile: "/A.json", sessionId: "sessA", sessionName: null, model: null, thinkingLevel: "off", messageCount: 0, pendingMessageCount: 0, steering: [], followUp: [] },
      });
    });
    expect(conn.isActive).toBe(false);
    expect(conn.isStreaming).toBe(false);
    act(() => { result.current.disconnect(conn.key); });
  });

  it("auto-reconnects and requests history again", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useWebSocketPool());
    let conn: any;
    act(() => { conn = result.current.getOrConnect("p1", "/A.json", null); });
    const ws1 = allWS[0]!;
    act(() => { ws1._open(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    ws1.sent.length = 0;

    act(() => { ws1._close(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });

    expect(allWS.length).toBe(2);
    const ws2 = allWS[1]!;
    act(() => { ws2._open(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });

    const types = ws2.sent.map((s) => {
      try { return JSON.parse(s).type; } catch { return null; }
    });
    expect(types).toContain("get_messages");
    expect(types).toContain("get_last_assistant_text");

    act(() => { result.current.disconnect(conn.key); });
    vi.useRealTimers();
  });
});
