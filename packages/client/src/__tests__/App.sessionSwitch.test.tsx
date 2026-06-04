import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
  const appPath = resolve(__dirname, "../App.tsx");
  const appSrc = readFileSync(appPath, "utf-8");

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
    expect(body).not.toMatch(/ws\.newSession\s*\(/);
  });
});
