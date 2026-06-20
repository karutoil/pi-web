import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { WSServerMessage } from "@pi-web/shared";
import { SDKAgent } from "./pi-agent";

// Smoke tests for the in-process SDK-backed agent. These DO construct a real
// AgentSession (unlike pi-agent.test.ts which uses a FakeAgent), so they
// verify the SDK wiring: start, subscribe, get_state, command dispatch, stop.
//
// ponytail: one tiny check per behavior, not a full suite. Fails fast if the
// SDK import, runtime factory, event translation, or command dispatch broke.
//
// These start a real agent and rebind real extensions (pi-lsp, pi-xref,
// subagent-async, …), so each test needs a generous timeout.

const TEST_TIMEOUT = 30_000;
const TMP = join(tmpdir(), `pi-web-smoke-${process.pid}`);
const PROJECT_DIR = join(TMP, "project");

function makeAgent(sessionPath?: string) {
  return new SDKAgent({ cwd: PROJECT_DIR, sessionPath });
}

function collect(agent: SDKAgent, timeoutMs = 3500) {
  const msgs: WSServerMessage[] = [];
  agent.setHandler((m) => msgs.push(m));
  return { msgs, wait: () => new Promise<void>((r) => setTimeout(r, timeoutMs)) };
}

describe("SDKAgent smoke (in-process SDK wiring)", () => {
  afterEach(() => {
    try { rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  it("starts a new session, reports a state with a sessionFile, and stops cleanly", async () => {
    mkdirSync(PROJECT_DIR, { recursive: true });
    writeFileSync(join(PROJECT_DIR, "AGENTS.md"), "# Smoke project");
    const agent = makeAgent();
    const { msgs, wait } = collect(agent);

    await agent.start();
    agent.getState();
    await wait();

    const state = msgs.find((m) => m.type === "state");
    expect(state).toBeDefined();
    expect((state as any)?.data?.sessionFile).toBeTruthy();

    await agent.stop();
  }, TEST_TIMEOUT);

  it("switches sessions in-process via new_session + switch_session", async () => {
    mkdirSync(PROJECT_DIR, { recursive: true });
    // Start one agent, create its session, capture its file.
    const agent = makeAgent();
    const { msgs, wait } = collect(agent);
    await agent.start();
    const firstFile = (agent as any).session?.sessionFile as string;
    expect(firstFile).toBeTruthy();
    await wait();

    // Create a SECOND session file via new_session, then switch back to the
    // first via switch_session — the real production "open another session"
    // path. Verifies runtime.newSession/switchSession + rebind work in-process.
    msgs.length = 0;
    agent.doSend({ type: "new_session" });
    await wait();
    const secondFile = (agent as any).session?.sessionFile as string;
    expect(secondFile).toBeTruthy();
    expect(secondFile).not.toBe(firstFile);

    msgs.length = 0;
    agent.doSend({ type: "switch_session", sessionPath: firstFile });
    await wait();
    // After switching back, get_state reports the first file again.
    agent.getState();
    await wait();
    const state = msgs.find((m) => m.type === "state");
    expect((state as any)?.data?.sessionFile).toBe(firstFile);
    await agent.stop();
  }, TEST_TIMEOUT);

  it("get_available_models returns the model list from the registry", async () => {
    mkdirSync(PROJECT_DIR, { recursive: true });
    const agent = makeAgent();
    const { msgs, wait } = collect(agent);
    await agent.start();
    agent.doSend({ type: "get_available_models" });
    await wait();
    const models = msgs.find((m) => m.type === "available_models");
    expect(models).toBeDefined();
    // Models may be empty if no API keys configured, but the message must arrive.
    expect(Array.isArray((models as any)?.models)).toBe(true);
    await agent.stop();
  }, TEST_TIMEOUT);

  it("get_commands returns extension+prompt+skill commands", async () => {
    mkdirSync(PROJECT_DIR, { recursive: true });
    const agent = makeAgent();
    const { msgs, wait } = collect(agent);
    await agent.start();
    agent.doSend({ type: "get_commands" });
    await wait();
    const cmds = msgs.find((m) => m.type === "available_commands");
    expect(cmds).toBeDefined();
    expect(Array.isArray((cmds as any)?.commands)).toBe(true);
    await agent.stop();
  }, TEST_TIMEOUT);
});
