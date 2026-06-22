import { describe, it, expect } from "vitest";
// Static source guard: read App.tsx as a raw string (?raw) so the test runs in
// any vitest environment without needing node:fs / __dirname.
import appSrc from "../App.tsx?raw";

/**
 * REGRESSION GUARD for the bug the user reported:
 * "As soon as I switched sessions the stream stopped and no work was
 * further created."
 *
 * The original bug was in App.tsx handleSelectSession which called
 *   ws.loadSession(B.path)
 * on the OLD WebSocket (for session A). That told the OLD PI process to
 * in-process switch from A to B, killing A's in-flight work.
 *
 * The fix removed that call. This test is a static guard: it scans
 * App.tsx and asserts that handleSelectSession does NOT contain any
 * `ws.loadSession(` call. If a future refactor reintroduces the bug,
 * this test fails immediately.
 *
 * The dynamic behavioral tests in useWebSocketPool.test.ts verify the
 * pool's contract (no side effects on existing conns). Together they
 * cover the regression.
 */
describe("App — static regression guard for session-switch bug", () => {
  // appSrc is imported as a raw string above (?raw) — no readFileSync needed.

  it("handleSelectSession does NOT call ws.loadSession(...) on the old WS", () => {
    // Strip line comments and block comments so the "do not call" comment
    // in handleSelectSession doesn't false-positive the regex.
    const stripped = appSrc
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    const match = stripped.match(
      /const\s+handleSelectSession\s*=\s*useCallback\s*\([\s\S]*?\}\s*,\s*\[[^\]]*\]\s*\)\s*;/
    );
    expect(match, "handleSelectSession not found in App.tsx").toBeTruthy();

    const body = match![0];
    // The bug pattern: any `ws.loadSession(` call inside handleSelectSession
    expect(body).not.toMatch(/ws\.loadSession\s*\(/);
  });

  it("handleNewSession does NOT call ws.newSession() on the old WS", () => {
    const stripped = appSrc
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    const match = stripped.match(
      /const\s+handleNewSession\s*=\s*useCallback\s*\([\s\S]*?\}\s*,\s*\[[^\]]*\]\s*\)\s*;/
    );
    expect(match, "handleNewSession not found in App.tsx").toBeTruthy();

    const body = match![0];
    // The bug pattern: any `ws.newSession(` call inside handleNewSession
    expect(body).not.toMatch(/ws\.newSession\s*\(/);
  });

  // REGRESSION GUARD for the "refresh loses the live PI session" bug.
  //
  // The restore is now SERVER-SIDE: restoreLiveSession queries /live-sessions
  // (the server pool is the single source of truth) instead of a client-side
  // localStorage token (which clobbered across tabs — H2). This guard asserts
  // (a) no localStorage live-session token is written, and (b) restoreLiveSession
  // fetches the server endpoint — so neither the old localStorage token nor its
  // cross-tab clobber can silently come back.
  it("restore is server-side: no localStorage token + restoreLiveSession fetches /live-sessions", () => {
    expect(appSrc).not.toMatch(/LIVE_SESSION_KEY\s*=\s*["']/);
    expect(appSrc).not.toMatch(/writeLiveSession|clearLiveSession/);
    const m = appSrc.match(/const\s+restoreLiveSession\s*=\s*useCallback[\s\S]*?\/live-sessions[\s\S]*?\},\s*\[[^\]]*\]\s*\)\s*;/);
    expect(m, "restoreLiveSession not found or does not fetch /live-sessions").toBeTruthy();
  });
});
