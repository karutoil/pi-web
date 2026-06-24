import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { ServerWebSocket } from "bun";
import type { WSServerMessage } from "@pi-web/shared";
import { buildAgentKey, PooledAgent, type IPIAgent, type PIAgentOptions, type LiveSessionSnapshot, getOrCreateAgent, lookupAgent, rekeyAgent, deleteFromPool, stopAgentsForCwd, setProjectSessionsChangedHandler, _resetPoolForTesting, getLiveSessionsForCwd } from "./pi-agent";

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
    //   `${cwd}::${sessionPath}` for an existing session, or
    //   `${cwd}::__new__:${newSessionId}` for a pending new session (#4: the
    //   newSessionId suffix disambiguates two concurrent new sessions in the
    //   same project so they don't collapse onto one `__new__` agent).
    //
    // For an existing session both sides agree on the sessionPath segment;
    // the trailing `::` on the client key is harmless (used to look up the
    // client pool entry, the server pool is keyed by its own format). The
    // cross-side link is via the WebSocket, not the key. On resolution the
    // runtime's rebind callback rekeys the agent from `__new__:<uuid>` to the
    // real sessionFile path so a reconnecting client reattaches.
    //
    // The invariant: buildAgentKey with a real sessionPath must produce
    // a stable, deterministic key the server can re-derive.
    const key1 = buildAgentKey("/proj", "/sessions/abc.json");
    const key2 = buildAgentKey("/proj", "/sessions/abc.json");
    expect(key1).toBe(key2);
  });

  it("#4: two concurrent new sessions in the same project get distinct keys", () => {
    // The whole point of embedding newSessionId: without it both would be
    // `/proj::__new__` and the second getOrCreateAgent would reuse the first
    // agent, clobbering its in-flight new-session state.
    const k1 = buildAgentKey("/proj", null, "uuid-A");
    const k2 = buildAgentKey("/proj", null, "uuid-B");
    expect(k1).toBe("/proj::__new__:uuid-A");
    expect(k2).toBe("/proj::__new__:uuid-B");
    expect(k1).not.toBe(k2);
  });
});

// ─── keepalive / idle-timeout tests ────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class FakeAgent implements IPIAgent {
  options: PIAgentOptions;
  handler: ((msg: WSServerMessage) => void) | null = null;
  exitHandler: ((code: number | null) => void) | null = null;
  rebindHandler: ((sessionFile: string) => boolean) | null = null;
  rebindedTo: string | null = null;
  startCalls = 0;
  stopCalls = 0;
  /** Configurable live snapshot for getLiveSnapshot(); defaults to a snapshot
   * derived from options.sessionPath so tests can drive the recovery flow.
   * Set to null to simulate a pre-resolve (pending __new__) agent. */
  liveSnapshot: LiveSessionSnapshot | null | undefined = undefined;

  constructor(options: PIAgentOptions) {
    this.options = options;
  }

  setHandler(handler: (msg: WSServerMessage) => void) { this.handler = handler; }
  setExitHandler(handler: (code: number | null) => void) { this.exitHandler = handler; }
  setRebindHandler(handler: (sessionFile: string) => boolean) { this.rebindHandler = handler; }
  rebindTo(sessionFile: string): boolean {
    this.rebindedTo = sessionFile;
    return this.rebindHandler?.(sessionFile) ?? true;
  }
  async start() { this.startCalls++; }
  async stop() { this.stopCalls++; }
  getOptions() { return this.options; }
  getState() {}
  doSend() {}
  getLiveSnapshot(): LiveSessionSnapshot | null {
    // Default: synthesize a snapshot from options.sessionPath so the recovery
    // flow has something to return. Tests that want "no snapshot yet" set
    // this.liveSnapshot = null explicitly.
    if (this.liveSnapshot !== undefined) return this.liveSnapshot;
    if (!this.options.sessionPath) return null;
    return {
      sessionPath: this.options.sessionPath,
      sessionId: "fake-sess",
      sessionName: null,
      isStreaming: false,
      isCompacting: false,
      clientCount: 0,
      lastActivityAt: Date.now(),
    };
  }
}

function makeWS() {
  const sent: string[] = [];
  return {
    readyState: 1,
    send: (data: string) => sent.push(data),
    _sent: sent,
  } as unknown as ServerWebSocket & { _sent: string[] };
}

describe("PooledAgent keepalive", () => {
  const agents: PooledAgent[] = [];

  beforeEach(() => {
    agents.length = 0;
  });

  afterEach(async () => {
    for (const a of agents) {
      try { await a.stop(); } catch {}
    }
  });

  function createAgent(key = "/proj::/s.json") {
    const fake = new FakeAgent({ cwd: "/proj" });
    const pooled = new PooledAgent(key, { cwd: "/proj" }, () => fake, 50);
    agents.push(pooled);
    return { pooled, fake };
  }

  it("stops the agent after the idle timeout when no clients and no activity", async () => {
    const { pooled, fake } = createAgent();
    await pooled.start();
    const ws = makeWS();
    pooled.attach(ws);
    pooled.detach(ws);

    expect(fake.stopCalls).toBe(0);
    await sleep(120);
    expect(fake.stopCalls).toBe(1);
  });

  it("keeps the agent alive while streaming, then stops after agent_end", async () => {
    const { pooled, fake } = createAgent();
    await pooled.start();
    const ws = makeWS();
    pooled.attach(ws);
    pooled.detach(ws);

    expect(fake.handler).not.toBeNull();
    fake.handler!({ type: "agent_start" });
    await sleep(120);
    expect(fake.stopCalls).toBe(0);

    fake.handler!({ type: "agent_end", messages: [] });
    await sleep(120);
    expect(fake.stopCalls).toBe(1);
  });

  it("keeps the agent alive while a tool is running, then stops after tool_end", async () => {
    const { pooled, fake } = createAgent();
    await pooled.start();
    const ws = makeWS();
    pooled.attach(ws);
    pooled.detach(ws);

    fake.handler!({ type: "tool_start", toolCallId: "t1", toolName: "bash", args: {} });
    await sleep(120);
    expect(fake.stopCalls).toBe(0);

    fake.handler!({
      type: "tool_end",
      toolCallId: "t1",
      toolName: "bash",
      result: { content: [] },
      isError: false,
    });
    await sleep(120);
    expect(fake.stopCalls).toBe(1);
  });

  it("reflects streaming state from state events and defers idle timeout", async () => {
    const { pooled, fake } = createAgent();
    await pooled.start();
    const ws = makeWS();
    pooled.attach(ws);
    pooled.detach(ws);

    fake.handler!({
      type: "state",
      data: {
        isStreaming: true,
        isCompacting: false,
        sessionFile: "/s.json",
        sessionId: "sess",
        sessionName: null,
        model: null,
        thinkingLevel: "off",
        messageCount: 0,
        pendingMessageCount: 0,
        steering: [],
        followUp: [],
      },
    });
    await sleep(120);
    expect(fake.stopCalls).toBe(0);

    fake.handler!({
      type: "state",
      data: {
        isStreaming: false,
        isCompacting: false,
        sessionFile: "/s.json",
        sessionId: "sess",
        sessionName: null,
        model: null,
        thinkingLevel: "off",
        messageCount: 0,
        pendingMessageCount: 0,
        steering: [],
        followUp: [],
      },
    });
    await sleep(120);
    expect(fake.stopCalls).toBe(1);
  });
});

// ─── session-loss regression tests (#1, #4, #5) ────────────────────────────

describe("PooledAgent exit -> closeClients (regression #1)", () => {
  const agents: PooledAgent[] = [];
  beforeEach(() => { agents.length = 0; _resetPoolForTesting(); });
  afterEach(async () => { for (const a of agents) { try { await a.stop(); } catch {} } _resetPoolForTesting(); });

  // Fake WS that records send() AND close() so we can assert closeClients fired.
  function makeWS() {
    const sent: string[] = [];
    let closed = false;
    return {
      readyState: 1,
      send: (data: string) => sent.push(data),
      close: () => { closed = true; },
      _sent: sent,
      _closed: () => closed,
    } as unknown as ServerWebSocket & { _sent: string[]; _closed: () => boolean };
  }

  it("#1: on PI exit, closes every attached client WS (no zombie)", async () => {
    const fake = new FakeAgent({ cwd: "/proj" });
    const pooled = new PooledAgent("/proj::__new__:u1", { cwd: "/proj" }, () => fake, 50);
    agents.push(pooled);
    await pooled.start();

    const ws1 = makeWS();
    const ws2 = makeWS();
    pooled.attach(ws1);
    pooled.attach(ws2);

    expect(fake.exitHandler).not.toBeNull();
    // Simulate PI crashing (non-zero exit, unexpected).
    fake.exitHandler!(1);

    // #1 invariant: both client WSes were closed so their onclose fires
    // client-side and reconnect logic kicks in. Before the fix they stayed
    // 'open' and every subsequent send was silently dropped.
    expect(ws1._closed()).toBe(true);
    expect(ws2._closed()).toBe(true);
    // The exit error was broadcast before closing.
    expect(ws1._sent.some((m) => m.includes('PI agent exited'))).toBe(true);
  });

  it("#1: after exit, the agent is gone from the pool (recreate on reconnect)", async () => {
    // Use the real module pool via getOrCreateAgent with an injected FakeAgent
    // factory so no `pi` binary is spawned.
    const fake = new FakeAgent({ cwd: "/proj", sessionPath: "/s.json" });
    const { agent, isNew } = getOrCreateAgent("/proj", "/s.json", undefined, undefined, undefined, () => fake);
    expect(isNew).toBe(true);
    const key = agent.getKey();
    expect(lookupAgent(key)).not.toBeNull();
    expect(fake.exitHandler).not.toBeNull();
    // Simulate PI crashing.
    fake.exitHandler!(1);
    // Pool entry removed — a reconnect will create a fresh agent.
    expect(lookupAgent(key)).toBeNull();
    const fake2 = new FakeAgent({ cwd: "/proj", sessionPath: "/s.json" });
    const { agent: agent2, isNew: isNew2 } = getOrCreateAgent("/proj", "/s.json", undefined, undefined, undefined, () => fake2);
    expect(isNew2).toBe(true);
    expect(agent2).not.toBe(agent);
    await agent2.stop();
  });
});

describe("concurrent new sessions / rekey (regression #4)", () => {
  beforeEach(() => _resetPoolForTesting());
  afterEach(async () => _resetPoolForTesting());

  it("#4: two concurrent new sessions get distinct pool entries (no collision)", () => {
    const { agent: a1, isNew: n1 } = getOrCreateAgent("/proj", null, "uuid-A");
    const { agent: a2, isNew: n2 } = getOrCreateAgent("/proj", null, "uuid-B");
    expect(n1 && n2).toBe(true);
    expect(a1).not.toBe(a2);
    expect(a1.getKey()).toBe("/proj::__new__:uuid-A");
    expect(a2.getKey()).toBe("/proj::__new__:uuid-B");
  });

  it("#4: rekeying a pending agent to its resolved path lets a reconnect reattach", () => {
    const { agent } = getOrCreateAgent("/proj", null, "uuid-A", undefined, undefined, () => new FakeAgent({ cwd: "/proj" }));
    const oldKey = agent.getKey();
    expect(oldKey).toBe("/proj::__new__:uuid-A");

    // Simulate PI reporting the real sessionFile via a state event.
    // (handleAgentMessage does the rekey internally; here we drive rekeyAgent
    // directly to assert the pool moves.)
    const newKey = buildAgentKey("/proj", "/home/x/.pi/agent/sessions/abc.json");
    expect(rekeyAgent(oldKey, newKey)).not.toBeNull();
    expect(agent.getKey()).toBe(newKey);

    // A reconnect with the resolved sessionPath must find THIS agent, not a new one.
    const { agent: reconnected, isNew } = getOrCreateAgent("/proj", "/home/x/.pi/agent/sessions/abc.json", undefined, undefined, undefined, () => new FakeAgent({ cwd: "/proj" }));
    expect(isNew).toBe(false);
    expect(reconnected).toBe(agent);
  });

  it("#4: rekey to an already-occupied key is refused (no clobber)", () => {
    const { agent: existing } = getOrCreateAgent("/proj", "/shared.json", undefined, undefined, undefined, () => new FakeAgent({ cwd: "/proj" }));
    const { agent: pending } = getOrCreateAgent("/proj", null, "uuid-C", undefined, undefined, () => new FakeAgent({ cwd: "/proj" }));
    // Pending session resolves to a path that's already open — must NOT overwrite.
    expect(rekeyAgent(pending.getKey(), buildAgentKey("/proj", "/shared.json"))).toBeNull();
    // Both agents still present and distinct.
    expect(lookupAgent(buildAgentKey("/proj", "/shared.json"))).toBe(existing);
    expect(lookupAgent("/proj::__new__:uuid-C")).toBe(pending);
  });
});

describe("session-changed handler isolation (regression #5)", () => {
  beforeEach(() => _resetPoolForTesting());
  afterEach(() => _resetPoolForTesting());

  it("#5: a rejecting async handler does not throw into the agent message path", () => {
    let rejected = 0;
    setProjectSessionsChangedHandler(() => {
      rejected++;
      return Promise.reject(new Error("boom"));
    });
    const fake = new FakeAgent({ cwd: "/proj", sessionPath: "/s.json" });
    const pooled = new PooledAgent(buildAgentKey("/proj", "/s.json"), { cwd: "/proj", sessionPath: "/s.json" }, () => fake, 50);
    pooled.start().then(() => pooled.stop());
    // Drive a state event with a sessionFile so the handler fires (session_name_changed
    // also fires it; use that to avoid needing sessionFile-pending logic).
    expect(fake.handler).not.toBeNull();
    // Should not throw synchronously:
    expect(() => fake.handler!({ type: "session_name_changed", name: "x" })).not.toThrow();
    expect(rejected).toBe(1);
  });
});

// ─── live-connection regressions: refresh / leave / orphaned dialog ──────────
//
// Bug: "if you leave a session, refresh or anything that will take you out
// of that session you lose the live view of that PI process and the server
// requires a reboot to fix it."
//
// Two concrete failure modes covered here:
//  1. PI blocks on an extension_ui_request (modal dialog). The client that was
//     supposed to answer disconnects (refresh). The dialog was broadcast once
//     and is now lost — PI waits forever, unrecoverable without a server reboot.
//     Fix: PooledAgent remembers the last blocking dialog and replays it to a
//     reconnecting client on attach.
//  2. A PI process hangs (no agent_end, no exit) with streaming=true and no
//     clients. It is never reaped by the idle timer (which only fires when
//     !isActive()), so it lingers forever and the session is wedged. Fix: a
//     staleness watchdog force-stops agents that have been "active" with no
//     message activity and no clients for too long.

describe("live connection: reconnect reattaches to a streaming agent", () => {
  beforeEach(() => _resetPoolForTesting());
  afterEach(async () => _resetPoolForTesting());

  it("a reconnecting client reattaches to the SAME running agent and keeps receiving live output", async () => {
    const cwd = "/proj";
    const sessionPath = "/home/x/.pi/agent/sessions/abc.json";
    let fake: FakeAgent;
    const factory = (opts: PIAgentOptions) => { fake = new FakeAgent(opts); return fake; };

    const { agent } = getOrCreateAgent(cwd, sessionPath, undefined, undefined, undefined, factory);
    await agent.start();
    const ws1 = makeWS();
    agent.attach(ws1);
    fake!.handler!({ type: "agent_start" });
    fake!.handler!({ type: "message_start", message: { role: "assistant", content: "working", timestamp: new Date().toISOString() } });

    // User refreshes: client WS closes, server detaches. Agent is still streaming.
    agent.detach(ws1);
    expect(lookupAgent(`${cwd}::${sessionPath}`)).toBe(agent);

    // PI keeps streaming while the client is away.
    fake!.handler!({ type: "message_update", message: { role: "assistant", content: "more", timestamp: new Date().toISOString() } } as any);

    // Client reconnects with the same sessionPath — must find THIS agent.
    const { agent: reattached, isNew } = getOrCreateAgent(cwd, sessionPath, undefined, undefined, undefined, factory);
    expect(isNew).toBe(false);
    expect(reattached).toBe(agent);
    const ws2 = makeWS();
    reattached.attach(ws2);
    ws2._sent.length = 0;

    // Live output after reconnect reaches the new client.
    fake!.handler!({ type: "message_update", message: { role: "assistant", content: "live!", timestamp: new Date().toISOString() } } as any);
    expect(ws2._sent.some((m) => m.includes("live!"))).toBe(true);
    await agent.stop();
  });
});

describe("live connection: orphaned blocking dialog is replayed on reconnect", () => {
  beforeEach(() => _resetPoolForTesting());
  afterEach(async () => _resetPoolForTesting());

  it("a dialog that arrived while the client was away is replayed to a reconnecting client", async () => {
    const fake = new FakeAgent({ cwd: "/proj", sessionPath: "/s.json" });
    const pooled = new PooledAgent(buildAgentKey("/proj", "/s.json"), { cwd: "/proj", sessionPath: "/s.json" }, () => fake, 50);
    await pooled.start();

    // PI is mid-run and asks the user a blocking question.
    fake.handler!({ type: "agent_start" });
    fake.handler!({
      type: "extension_ui_request",
      ui: { id: "d1", method: "confirm", title: "Proceed?", message: "ok?", options: ["yes", "no"] },
    });

    // Client disconnects (refresh) BEFORE answering. PI stays blocked.
    // (No agent_end, so the agent is still "active".)

    // A new client connects and attaches.
    const ws2 = makeWS();
    pooled.attach(ws2);

    // The blocking dialog MUST be replayed so the new client can answer it,
    // otherwise PI waits forever (the "server requires a reboot" state).
    expect(ws2._sent.some((m) => m.includes("extension_ui_request") && m.includes("d1"))).toBe(true);
    await pooled.stop();
  });

  it("fire-and-forget UI events (notify/setStatus) are NOT replayed as blocking dialogs", async () => {
    const fake = new FakeAgent({ cwd: "/proj", sessionPath: "/s.json" });
    const pooled = new PooledAgent(buildAgentKey("/proj", "/s.json"), { cwd: "/proj", sessionPath: "/s.json" }, () => fake, 50);
    await pooled.start();
    fake.handler!({ type: "agent_start" });
    fake.handler!({ type: "extension_ui_request", ui: { id: "n1", method: "notify", message: "hi" } });
    fake.handler!({ type: "extension_ui_request", ui: { id: "s1", method: "setStatus", statusKey: "k", statusText: "v" } });

    const ws2 = makeWS();
    pooled.attach(ws2);

    // Neither notify nor setStatus should be replayed as a blocking dialog.
    const replayed = ws2._sent.filter((m) => m.includes("extension_ui_request"));
    expect(replayed).toEqual([]);
    await pooled.stop();
  });
});

describe("live connection: wedged streaming agent is reaped by the watchdog", () => {
  beforeEach(() => _resetPoolForTesting());
  afterEach(async () => _resetPoolForTesting());

  it("force-stops an agent that is streaming with no activity and no clients for too long", async () => {
    // Use a tiny watchdog window so the test runs fast.
    const fake = new FakeAgent({ cwd: "/proj", sessionPath: "/s.json" });
    const pooled = new PooledAgent(buildAgentKey("/proj", "/s.json"), { cwd: "/proj", sessionPath: "/s.json" }, () => fake, 50, 30);
    await pooled.start();

    // Client connects, PI starts streaming, then client leaves.
    const ws1 = makeWS();
    pooled.attach(ws1);
    fake.handler!({ type: "agent_start" });
    pooled.detach(ws1);

    // streaming=true, no clients. The idle timer alone would never fire
    // (isActive() is true). Without the watchdog this agent lingers forever
    // — the "requires a reboot" state.
    expect(fake.stopCalls).toBe(0);
    await sleep(120);
    expect(fake.stopCalls).toBe(1);
    expect(lookupAgent(buildAgentKey("/proj", "/s.json"))).toBeNull();
  });
});

// ─── rekey-then-exit regression (the real "requires a reboot" bug) ───────────
//
// Reproduces the production bug found by stress-testing: when a new-session
// agent is rekeyed from `__new__:<uuid>` to its resolved sessionFile path and
// THEN the PI process dies, the exit handler used to delete the STALE original
// key (captured in the constructor closure) instead of the current
// this.agentKey. The rekeyed entry stayed in the pool with a dead PI under
// it — a reconnect reused the dead agent, every send was silently dropped,
// and only a server reboot cleared it.

describe("rekey-then-exit removes the agent under its CURRENT key (regression)", () => {
  beforeEach(() => _resetPoolForTesting());
  afterEach(async () => _resetPoolForTesting());

  it("after rekey, a PI exit deletes the rekeyed entry (not the stale original key)", async () => {
    const fake = new FakeAgent({ cwd: "/proj" });
    const { agent } = getOrCreateAgent("/proj", null, "uuid-X", undefined, undefined, () => fake);
    await agent.start();
    const oldKey = agent.getKey();
    expect(oldKey).toBe("/proj::__new__:uuid-X");

    // PI resolves the new session -> server rekeys to the real sessionFile.
    const newKey = buildAgentKey("/proj", "/home/x/.pi/agent/sessions/abc.json");
    expect(fake.handler).not.toBeNull();
    fake.handler!({
      type: "state",
      data: {
        isStreaming: false, isCompacting: false,
        sessionFile: "/home/x/.pi/agent/sessions/abc.json",
        sessionId: "sess", sessionName: null, model: null, thinkingLevel: "off",
        messageCount: 0, pendingMessageCount: 0, steering: [], followUp: [],
      },
    });
    expect(agent.getKey()).toBe(newKey);
    expect(lookupAgent(newKey)).toBe(agent);
    // The stale original key must no longer hold the agent.
    expect(lookupAgent(oldKey)).toBeNull();

    // Attach a client so we can assert it gets closed on exit.
    const ws = makeWS();
    agent.attach(ws);

    // PI dies unexpectedly.
    expect(fake.exitHandler).not.toBeNull();
    fake.exitHandler!(1);

    // CRITICAL: the agent must be gone from the pool under the CURRENT key.
    // Before the fix, agentPool.delete(agentKey) removed the stale oldKey and
    // left this entry behind — the bug.
    expect(lookupAgent(newKey)).toBeNull();
    expect(lookupAgent(oldKey)).toBeNull();
  });
});

// ─── reattach edge cases: normalization, stale newSessionId, orphan-on-delete ─
//
// Goal: a client must ALWAYS reattach to the SAME live agent, never spawn a
// duplicate that orphans the live PI process.

describe("reattach: sessionPath normalization", () => {
  beforeEach(() => _resetPoolForTesting());
  afterEach(() => _resetPoolForTesting());

  it("trailing slash, //, and ./ all map to the same key as the canonical path", () => {
    const cwd = "/proj";
    const canonical = buildAgentKey(cwd, "/home/x/.pi/agent/sessions/abc.json");
    expect(buildAgentKey(cwd, "/home/x/.pi/agent/sessions/abc.json/")).toBe(canonical);
    expect(buildAgentKey(cwd, "/home/x/.pi/agent//sessions//abc.json")).toBe(canonical);
    expect(buildAgentKey(cwd, "/home/x/.pi/agent/./sessions/abc.json")).toBe(canonical);
    expect(buildAgentKey(cwd, "/home/x/.pi/agent/sessions/../sessions/abc.json")).toBe(canonical);
  });

  it("a client reconnecting with a trailing-slash sessionPath reattaches to the SAME agent (no duplicate)", () => {
    const canonical = "/home/x/.pi/agent/sessions/abc.json";
    const { agent } = getOrCreateAgent("/proj", canonical, undefined, undefined, undefined, () => new FakeAgent({ cwd: "/proj" }));
    expect(agent.clientCount).toBe(0);
    // Reconnect with a mangled (trailing-slash) path: must find the SAME agent.
    const { agent: again, isNew } = getOrCreateAgent("/proj", canonical + "/", undefined, undefined, undefined, () => new FakeAgent({ cwd: "/proj" }));
    expect(isNew).toBe(false);
    expect(again).toBe(agent);
  });
});

describe("reattach: SDK lifecycle rebind callback", () => {
  beforeEach(() => _resetPoolForTesting());
  afterEach(() => _resetPoolForTesting());

  it("rekeys the pool to the forked session path when the SDK fires the rebind handler", () => {
    const fake = new FakeAgent({ cwd: "/proj", sessionPath: "/orig.json" });
    const { agent } = getOrCreateAgent("/proj", "/orig.json", undefined, undefined, undefined, () => fake);
    expect(agent.getKey()).toBe(buildAgentKey("/proj", "/orig.json"));

    // SDK runtime.newSession/switchSession/fork/clone resolves the new path
    // synchronously and invokes the rebind handler inside the replacement
    // transaction.
    fake.rebindTo("/forked.json");
    expect(agent.getKey()).toBe(buildAgentKey("/proj", "/forked.json"));
    expect(lookupAgent(buildAgentKey("/proj", "/orig.json"))).toBeNull();
    expect(lookupAgent(buildAgentKey("/proj", "/forked.json"))).toBe(agent);

    // A reconnect with the new path finds the SAME agent.
    const { agent: again, isNew } = getOrCreateAgent("/proj", "/forked.json", undefined, undefined, undefined, () => new FakeAgent({ cwd: "/proj" }));
    expect(isNew).toBe(false);
    expect(again).toBe(agent);
  });

  it("clears the pending-new flag when rebind resolves the initial sessionFile", () => {
    const fake = new FakeAgent({ cwd: "/proj" });
    const { agent } = getOrCreateAgent("/proj", null, "uuid-P", undefined, undefined, () => fake);
    expect(agent.getKey()).toBe(buildAgentKey("/proj", null, "uuid-P"));

    fake.rebindTo("/home/x/.pi/agent/sessions/p.json");
    expect(agent.getKey()).toBe(buildAgentKey("/proj", "/home/x/.pi/agent/sessions/p.json"));
    expect(lookupAgent(buildAgentKey("/proj", null, "uuid-P"))).toBeNull();
  });
});

describe("reattach: deleteFromPool stops the agent (no orphaned PI)", () => {
  beforeEach(() => _resetPoolForTesting());
  afterEach(async () => _resetPoolForTesting());

  it("deleteFromPool stops the underlying agent so no live PI lingers without a pool entry", async () => {
    const fake = new FakeAgent({ cwd: "/proj", sessionPath: "/s.json" });
    const { agent } = getOrCreateAgent("/proj", "/s.json", undefined, undefined, undefined, () => fake);
    await agent.start();
    expect(fake.stopCalls).toBe(0);
    deleteFromPool(buildAgentKey("/proj", "/s.json"));
    // The async stop is fire-and-forget; let it settle.
    await sleep(50);
    expect(fake.stopCalls).toBe(1);
    expect(lookupAgent(buildAgentKey("/proj", "/s.json"))).toBeNull();
  });

  it("stopAgentsForCwd stops every agent for the project (project deletion)", async () => {
    const f1 = new FakeAgent({ cwd: "/proj" });
    const f2 = new FakeAgent({ cwd: "/proj" });
    const { agent: a1 } = getOrCreateAgent("/proj", "/a.json", undefined, undefined, undefined, () => f1);
    const { agent: a2 } = getOrCreateAgent("/proj", "/b.json", undefined, undefined, undefined, () => f2);
    await a1.start(); await a2.start();
    // A different project's agent must be left alone.
    const fOther = new FakeAgent({ cwd: "/other" });
    const { agent: aOther } = getOrCreateAgent("/other", "/c.json", undefined, undefined, undefined, () => fOther);
    await aOther.start();
    stopAgentsForCwd("/proj");
    await sleep(50);
    expect(f1.stopCalls).toBe(1);
    expect(f2.stopCalls).toBe(1);
    expect(fOther.stopCalls).toBe(0); // other project untouched
    expect(lookupAgent(buildAgentKey("/proj", "/a.json"))).toBeNull();
    expect(lookupAgent(buildAgentKey("/proj", "/b.json"))).toBeNull();
    expect(lookupAgent(buildAgentKey("/other", "/c.json"))).toBe(aOther);
  });
});

// ─── switch_session / load_session rekey (clone-flow desync) ───────────────────
//
// When the client clones a session it calls switch_session on the EXISTING
// pi process, switching it in-place to the cloned session. The client rekeys
// its pool entry to the cloned filePath (App.handleSessionLoaded); the server
// must rekey too, or a reconnect spawns a fresh agent and orphans this PI
// (and runs two PIs on the cloned file).

describe("reattach: switch_session/load_session rekeys the agent to the loaded path", () => {
  beforeEach(() => _resetPoolForTesting());
  afterEach(() => _resetPoolForTesting());

  it("a session_loaded (from switch_session) rekeys the agent so a reconnect finds it under the NEW path", () => {
    const fake = new FakeAgent({ cwd: "/proj", sessionPath: "/orig.json" });
    const { agent } = getOrCreateAgent("/proj", "/orig.json", undefined, undefined, undefined, () => fake);
    expect(agent.getKey()).toBe(buildAgentKey("/proj", "/orig.json"));

    // PI switches in-process to the cloned session and reports session_loaded.
    expect(fake.handler).not.toBeNull();
    fake.handler!({ type: "session_loaded", session: { id: "s2", filePath: "/cloned.json", cwd: "/proj", timestamp: "", name: null, version: 1, entries: [] } as any });

    // The agent must now be keyed under the CLONED path.
    expect(agent.getKey()).toBe(buildAgentKey("/proj", "/cloned.json"));
    expect(lookupAgent(buildAgentKey("/proj", "/orig.json"))).toBeNull();
    expect(lookupAgent(buildAgentKey("/proj", "/cloned.json"))).toBe(agent);

    // A reconnect with the cloned path reattaches to THIS agent (no duplicate).
    const { agent: again, isNew } = getOrCreateAgent("/proj", "/cloned.json", undefined, undefined, undefined, () => new FakeAgent({ cwd: "/proj" }));
    expect(isNew).toBe(false);
    expect(again).toBe(agent);
  });

  it("switching to the SAME session is a no-op rekey (no churn)", () => {
    const fake = new FakeAgent({ cwd: "/proj", sessionPath: "/same.json" });
    const { agent } = getOrCreateAgent("/proj", "/same.json", undefined, undefined, undefined, () => fake);
    const keyBefore = agent.getKey();
    fake.handler!({ type: "session_loaded", session: { id: "s", filePath: "/same.json", cwd: "/proj", timestamp: "", name: null, version: 1, entries: [] } as any });
    expect(agent.getKey()).toBe(keyBefore);
  });
});

// #CLONE: PI forks to a new session file and reports it synchronously via the
// SDK runtime's rebind hook. The server pool rekeys inside that transaction;
// no polling is required.
describe("reattach: clone rekeys the agent to the forked session via lifecycle rebind", () => {
  beforeEach(() => _resetPoolForTesting());
  afterEach(() => _resetPoolForTesting());

  it("the rebind handler rekeys to the forked path; a reconnect finds the SAME agent", () => {
    const fake = new FakeAgent({ cwd: "/proj", sessionPath: "/orig.json" });
    const { agent } = getOrCreateAgent("/proj", "/orig.json", undefined, undefined, undefined, () => fake);
    expect(agent.getKey()).toBe(buildAgentKey("/proj", "/orig.json"));

    // SDK clone resolves the forked path synchronously and fires rebind.
    fake.rebindTo("/cloned.json");

    expect(agent.getKey()).toBe(buildAgentKey("/proj", "/cloned.json"));
    expect(lookupAgent(buildAgentKey("/proj", "/orig.json"))).toBeNull();
    expect(lookupAgent(buildAgentKey("/proj", "/cloned.json"))).toBe(agent);
    const { agent: again, isNew } = getOrCreateAgent("/proj", "/cloned.json", undefined, undefined, undefined, () => new FakeAgent({ cwd: "/proj" }));
    expect(isNew).toBe(false);
    expect(again).toBe(agent);
  });
});

// ─── live-session recovery (cache-cleared refresh) ────────────────────
//
// The "hard refresh with cache clearing" case: sessionStorage is wiped, so
// the client has NO handle to its live session. The server pool is the
// source of truth — getLiveSessionsForCwd reports every still-running agent
// for a project so the client can reattach to the most-recently-active one.

describe("getLiveSessionsForCwd (cache-cleared recovery)", () => {
  beforeEach(() => _resetPoolForTesting());
  afterEach(() => _resetPoolForTesting());

  it("returns a snapshot for every live agent in the project, most-recent first", async () => {
    const cwd = "/proj";
    const f1 = new FakeAgent({ cwd, sessionPath: "/a.json" });
    const f2 = new FakeAgent({ cwd, sessionPath: "/b.json" });
    const a1 = getOrCreateAgent(cwd, "/a.json", undefined, undefined, undefined, () => f1).agent;
    const a2 = getOrCreateAgent(cwd, "/b.json", undefined, undefined, undefined, () => f2).agent;
    // b.json gets a later activity event than a.json so it sorts first.
    f1.handler!({ type: "agent_start" });
    await new Promise(r => setTimeout(r, 5));
    f2.handler!({ type: "agent_start" });
    const live = getLiveSessionsForCwd(cwd);
    expect(live).toHaveLength(2);
    expect(live[0].sessionPath).toBe("/b.json"); // most-recent first
    expect(live[1].sessionPath).toBe("/a.json");
  });

  it("excludes agents from other projects", () => {
    const fa = new FakeAgent({ cwd: "/projA", sessionPath: "/a.json" });
    const fb = new FakeAgent({ cwd: "/projB", sessionPath: "/b.json" });
    getOrCreateAgent("/projA", "/a.json", undefined, undefined, undefined, () => fa);
    getOrCreateAgent("/projB", "/b.json", undefined, undefined, undefined, () => fb);
    const liveA = getLiveSessionsForCwd("/projA");
    expect(liveA).toHaveLength(1);
    expect(liveA[0].sessionPath).toBe("/a.json");
  });

  it("includes streaming agents (the real live-session case)", () => {
    const fake = new FakeAgent({ cwd: "/proj", sessionPath: "/live.json" });
    fake.liveSnapshot = { sessionPath: "/live.json", sessionId: "s", sessionName: null, isStreaming: true, isCompacting: false, clientCount: 0, lastActivityAt: Date.now() };
    const { agent } = getOrCreateAgent("/proj", "/live.json", undefined, undefined, undefined, () => fake);
    const live = getLiveSessionsForCwd("/proj");
    expect(live).toHaveLength(1);
    expect(live[0].isStreaming).toBe(true);
    expect(live[0].sessionPath).toBe("/live.json");
  });

  // Guards the /api/projects/:id/sessions endpoint merge: a refreshed client
  // has no open WS, so the ONLY way it learns a session is still streaming is
  // by the server marking SessionSummary.isStreaming from this pool. The
  // endpoint builds a Set of streaming sessionPaths from getLiveSessionsForCwd
  // and sets isStreaming on matching sessions — this test pins that contract
  // (streaming sessionPath present, non-streaming absent) so a shape change
  // here can't silently drop liveness from the session list after refresh.
  it("exposes streaming sessionPaths the sessions endpoint keys on (refresh reattach visibility)", () => {
    const streamFake = new FakeAgent({ cwd: "/proj", sessionPath: "/streaming.json" });
    streamFake.liveSnapshot = { sessionPath: "/streaming.json", sessionId: "s1", sessionName: null, isStreaming: true, isCompacting: false, clientCount: 0, lastActivityAt: Date.now() };
    const idleFake = new FakeAgent({ cwd: "/proj", sessionPath: "/idle.json" });
    idleFake.liveSnapshot = { sessionPath: "/idle.json", sessionId: "s2", sessionName: null, isStreaming: false, isCompacting: false, clientCount: 1, lastActivityAt: Date.now() };
    getOrCreateAgent("/proj", "/streaming.json", undefined, undefined, undefined, () => streamFake);
    getOrCreateAgent("/proj", "/idle.json", undefined, undefined, undefined, () => idleFake);
    // Mirror the endpoint's exact merge: streaming sessionPaths only.
    const streamingPaths = new Set(
      getLiveSessionsForCwd("/proj").filter(s => s.isStreaming && s.sessionPath).map(s => s.sessionPath),
    );
    expect(streamingPaths.has("/streaming.json")).toBe(true);
    expect(streamingPaths.has("/idle.json")).toBe(false);
  });
});
