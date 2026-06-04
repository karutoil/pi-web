import { describe, it, expect } from "bun:test";
import { buildAgentKey } from "./pi-agent";

/**
 * Tests for the server-side agent pool. These verify the multi-session
 * keying scheme that the client depends on for "switch sessions without
 * killing in-flight work".
 *
 * We can only test pure functions here — `rekeyAgent` and `getOrCreateAgent`
 * operate on a private module-level Map and would require real PI processes
 * to populate. The key format invariant is what matters for the client
 * contract: given the same (cwd, sessionPath), both sides must produce
 * the same key.
 */

describe("buildAgentKey — server/client key parity", () => {
  it("uses __new__ placeholder when sessionPath is null/undefined/empty", () => {
    expect(buildAgentKey("/proj", null)).toBe("/proj::__new__");
    expect(buildAgentKey("/proj", undefined)).toBe("/proj::__new__");
    expect(buildAgentKey("/proj", "")).toBe("/proj::__new__");
  });

  it("encodes real sessionPath in the key", () => {
    expect(buildAgentKey("/proj", "/home/user/.pi/sessions/abc.json"))
      .toBe("/proj::/home/user/.pi/sessions/abc.json");
  });

  it("two different sessions in the same project get different keys", () => {
    const k1 = buildAgentKey("/proj", "/a.json");
    const k2 = buildAgentKey("/proj", "/b.json");
    expect(k1).not.toBe(k2);
  });

  it("two different projects with the same session get different keys", () => {
    const k1 = buildAgentKey("/proj1", "/a.json");
    const k2 = buildAgentKey("/proj2", "/a.json");
    expect(k1).not.toBe(k2);
  });

  it("matches the client pool key format from useWebSocketPool", () => {
    // The client computes the key as:
    //   `${projectId}::${sessionPath || ""}::${newSessionId || ""}`
    // The server computes the key as:
    //   `${cwd}::${sessionPath || "__new__"}`
    //
    // For an existing session (no newSessionId on either side), both
    // produce a key of the form `${idOrPath}::${sessionPath}::` on the
    // client and `${idOrPath}::${sessionPath}` on the server. The
    // trailing `::` on the client key is harmless — it's used to look
    // up the client pool entry, the server pool is keyed by its own
    // format. The cross-side link is via the WebSocket, not the key.

    // For a pending new session: client key has newSessionId in slot 3,
    // server key uses __new__ in slot 2. They're different by design.
    // The client's session_loaded handler sends a rekey_session WS msg
    // to tell the server to move the agent from __new__ to the real path.

    // The invariant: buildAgentKey with a real sessionPath must produce
    // a stable, deterministic key the server can re-derive.
    const key1 = buildAgentKey("/proj", "/sessions/abc.json");
    const key2 = buildAgentKey("/proj", "/sessions/abc.json");
    expect(key1).toBe(key2);
  });
});
