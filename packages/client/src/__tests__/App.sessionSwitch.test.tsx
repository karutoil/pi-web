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
    // The bug pattern: any `ws.newSession(` call inside handleNewSession
    expect(body).not.toMatch(/ws\.newSession\s*\(/);
  });

  // REGRESSION GUARD for the "refresh loses the live PI session" bug.
  //
  // The original persistence effect had an `else if (!activeSession)` branch
  // that cleared sessionStorage on the INITIAL MOUNT — before the restore
  // effect could read it. So a refresh landed the user on the empty projects
  // view instead of reattaching to the still-running PI. The fix gates the
  // clear on `restoreAttemptedRef.current` so the mount window preserves the
  // seed. This guard asserts that gate stays in place.
  it("persistence effect does NOT clear sessionStorage before restore has run", () => {
    // Find the LIVE_SESSION persistence useEffect.
    const match = appSrc.match(/\/\/\s*#LIVE:[\s\S]*?useEffect\(\(\)\s*=>\s*\{[\s\S]*?sessionStorage[\s\S]*?\},\s*\[view,\s*selectedProject,\s*activeSession\]\);/);
    expect(match, "LIVE_SESSION persistence effect not found").toBeTruthy();
    const body = match![0];
    // The clear branch must be gated on restoreAttemptedRef.current — the
    // old `else if (!activeSession)` (unguarded) is the bug.
    expect(body).toMatch(/restoreAttemptedRef\.current/);
    // The old buggy pattern must be gone: an unguarded `!activeSession` clear.
    expect(body).not.toMatch(/else\s+if\s*\(!activeSession\)\s*\{[^}]*removeItem/);
  });
});
