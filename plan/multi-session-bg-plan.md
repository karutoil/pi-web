# Plan: Multi-Session Background Execution for pi-web

## Problem

Right now switching between projects or sessions in pi-web kills any in-flight PI work. The frontend stops receiving updates when you navigate away. The user wants:

- PI keeps working in the background when the user switches project/session.
- Frontend keeps getting streaming updates (so sidebar shows live indicators, badges, etc.).
- One PI process per (project, session) tuple — multiple sessions can run concurrently.

## Root Cause Analysis

### Server (`packages/server/src/pi-agent.ts`)

- `PooledAgent` pool is keyed by `cwd` only. One agent per project regardless of session.
- `restartWithSession()` and `loadSession()` **stop the current PI process and start a new one with a different session**. Any in-flight work is lost.
- `getOrCreateAgent(cwd, sessionPath, ...)` reuses the existing agent for the project — but `sessionPath` is silently ignored if an agent for the project already exists. So calling `loadSession` on a running agent for that project just kills it.
- 5-minute idle timeout is fine, but the agent never gets a chance to keep working — switching kills it before the timer even matters.

### Client (`packages/client/src/App.tsx` + `useWebSocketPool.ts`)

- `getOrConnect(projectId, sessionPath, newSessionId)` is called with `sessionPath = null` always (line 80 of App.tsx). So the pool key is effectively just `${projectId}:${newSessionId}`.
- When the project changes, `prevWsKeyRef` triggers `wsPool.disconnect(prevKey)` which **actively closes the old WS connection** → detaches from the agent → starts the 5-minute idle timer → eventually kills the agent.
- When a different session in the same project is selected, `ws.loadSession(session.filePath)` sends `load_session` over the existing WS → server calls `agent.loadSession()` → **kills and restarts the PI process**. All in-flight streaming is lost.
- Sidebar has `streamingSessionIds` plumbing (Sidebar.tsx line 31) and the dot pulse animation (line 588) — but `streamingSessionIds` is built from `wsPool.pool.values()` which only sees actively-rendered connections. Connections that exist in the pool but aren't used by the App's main `getOrConnect` call aren't tracked there. (Actually they are — let me re-verify. Yes the pool iteration sees all connections, but since the App's `getOrConnect` is called with `sessionPath=null`, switching sessions reuses the same key, so the same WS connection handles all sessions. The `streamingSessionIds` set will only show the *currently displayed* session's `state.sessionId`.)

## Solution

### Server changes

1. **Change pool key from `${cwd}` to `${cwd}::${sessionPath || "__new__"}`**.
   - File: `packages/server/src/pi-agent.ts` — `getOrCreateAgent()`.
   - One `PooledAgent` per (project, session) tuple. Multiple sessions in the same project can run concurrently.
   - Sessions without a path yet (new sessions) get a `__new__` placeholder key until the server reports `session_loaded` with the actual path; then we re-key.

2. **Stop killing the process for `load_session` / `switch_session`.**
   - The underlying PI RPC already has a `load_session` and `switch_session` command. Send it to the running agent — let PI handle the in-process session switch.
   - File: `pi-agent.ts` `loadSession()` method: just send `{ type: "load_session", sessionPath }` via `doSend` instead of `restartWithSession`. Same for `switchSession`.
   - Only call `restartWithSession` (process kill) if the session is on a different project (different cwd) — but the new key-based pool means each session has its own process anyway, so we never need to restart for session switch.

3. **Stale-extension-ctx fix (already in memory)**: when a session gets re-keyed, the underlying PI process needs to be restarted only on explicit `loadSession` RPC failures (auto-retry in the existing pattern).

4. **`loadSession` should be lazy:** if the (cwd, sessionPath) agent doesn't exist, create it. If it does exist, just attach.

5. **Add `lookupAgentBySessionKey(cwd, sessionPath)` helper** for client to attach to an existing background session.

6. **Re-keying flow for new sessions:**
   - WS opens with `newSessionId` query param → server creates agent with key `cwd::__new__`.
   - Server sends `session_loaded` with the real `sessionPath`.
   - Client receives `session_loaded` → re-keys the pool entry from `cwd::__new__` to `cwd::<realPath>`.
   - Server: on receiving `session_loaded` broadcast, re-key the agent in the pool. All future `getOrCreateAgent(cwd, realPath, ...)` calls return the same agent.

7. **WS-to-agent routing:** `wsToAgent` Map<ServerWebSocket, string> already uses the agent key. Just needs to use the new key format.

8. **Health endpoint** — already exposes `getPoolStats()`. Update the `key` field to be the new key format.

### Client changes

1. **Pass `sessionPath` to `getOrConnect`.** Don't pass `null` — pass the actual file path (or a special `__pending__` marker for new sessions).
   - File: `App.tsx` line ~80.
   - Key becomes `${projectId}::${sessionPath || "__pending__"}`.

2. **Remove the auto-disconnect on key change.** The pool is supposed to keep connections alive. Only disconnect on explicit user action (closing the tab, or session archive/delete).
   - File: `App.tsx` `prevWsKeyRef` effect — keep this ONLY for cleanup of `__pending__` placeholders that never resolved, not for active session switches.

3. **`handleSelectSession` should call `getOrConnect` with the session path** so the pool returns the existing connection if one is open.

4. **`handleSelectProject` should NOT close the previous project's connections.** Just switch the active one. Connections stay in the pool; server's idle timer handles cleanup.

5. **`streamingSessionIds` computation:** continue to iterate `wsPool.pool.values()`. Now this set can contain multiple sessions' IDs — sidebar will show live indicators for all of them. The current code already does this correctly (line 90-95 in App.tsx).

6. **Background session notifications:** when `agent_end` arrives for a connection that's not the "active" view, show a toast or update a badge. (Nice-to-have, can defer to follow-up.)

7. **`sessionDetail` cache keyed by `session.filePath`** — already done. Works fine.

8. **Re-key pending new sessions:** when `session_loaded` arrives with a real `filePath`, the App should rebuild the pool key for that connection. Add a method `rekey(newKey: string)` to `WSConnection` that updates the pool entry.

9. **`handleNewSession` should not pass `newSessionId` to a new connection if the existing one is open and connected.** Currently it does reuse the existing connection if open (good). Just verify the flow.

10. **`handleBack` from chat → sessions view should NOT disconnect the WS.** Currently it just changes `view` and `activeSession`, which is correct. The pool entry stays. ✓

11. **`handleBack` from sessions → projects view should NOT disconnect the project's WS either.** Currently it just clears `selectedProject`. The pool entry for that project stays. ✓ Good. But we need to make sure `prevWsKeyRef` doesn't close it. The current effect WILL close it because the key changes (project changes from old to null... actually selectedProject?.id → null gives key `null::...` which is different, so disconnect fires). Need to fix this.

### Testing

- Run existing test suite to ensure nothing breaks.
- Manual smoke test:
  1. Open project A, start a long-running task (e.g., a 30s prompt with tools).
  2. Switch to project B's chat. Project A's PI keeps running, sidebar shows "●" pulse next to project A.
  3. Switch back to project A. The chat shows the streamed updates that arrived while away.
  4. Open two sessions in the same project. Each has its own PI process. Both can stream concurrently.

## Implementation Plan

Three parallel work streams:

### Agent 1: Server pool re-keying + load/switch via RPC
- Edit `packages/server/src/pi-agent.ts`:
  - Change `getOrCreateAgent` key from `cwd` to `${cwd}::${sessionPath || "__new__"}`.
  - Add `rekeyAgent(oldKey, newKey)` function.
  - Replace `PooledAgent.loadSession` to send RPC instead of restart (with fallback restart on stale-ctx).
  - Replace `PooledAgent.switchSession` similarly.
  - Add `lookupAgentBySessionKey(cwd, sessionPath)` helper.
  - Export new functions.
- Edit `packages/server/src/index.ts`:
  - Update `wsToAgent` key usage to match new format.
  - On `session_loaded` broadcast, call `rekeyAgent` to move the agent from `cwd::__new__` to `cwd::<realPath>`.
  - Update `getPoolStats` consumers if any (no client changes needed).
  - Update `deleteFromPool` and `detachFromAgent` calls if needed.

### Agent 2: Client pool keying + re-keying API
- Edit `packages/client/src/hooks/useWebSocketPool.ts`:
  - Add `rekey(oldKey, newKey)` method to the pool.
  - Add `rekey(newKey)` method to `WSConnection` (mutates the pool entry's key).
  - Don't disconnect on key change at the pool level — connections persist.
- Edit `packages/client/src/App.tsx`:
  - Pass `session.filePath` to `getOrConnect` instead of `null`.
  - In the `session_loaded` handler, rekey the pool entry from `__pending__` to the real path.
  - Remove or fix the `prevWsKeyRef` auto-disconnect — only disconnect when leaving for real (e.g., on unmount).
  - Keep the existing `streamingSessionIds` logic (it already iterates the pool).
  - Update `handleBack` from projects view to NOT trigger disconnect (since the key is now keyed on project, the old project key remains valid in the pool).

### Agent 3: Background streaming + notification UX
- Edit `packages/client/src/App.tsx`:
  - Add a "background" set: `backgroundStreamingIds` = streamingSessionIds minus the active session's id.
  - When `agent_end` arrives for a connection whose sessionId is in the background set, show a toast notification ("Session X finished").
- Edit `packages/client/src/components/Sidebar.tsx`:
  - Add a pulsing dot next to project items that have any streaming sessions in the background.
  - Add a small badge with the streaming count next to the project name.
- Optional: a `BackgroundSessionToast.tsx` component.
- Edit `packages/client/src/lib/types.ts` if needed for the new toast API.

## Files Touched (summary)

- `packages/server/src/pi-agent.ts` (Agent 1)
- `packages/server/src/index.ts` (Agent 1)
- `packages/client/src/hooks/useWebSocketPool.ts` (Agent 2)
- `packages/client/src/App.tsx` (Agent 2 + 3)
- `packages/client/src/components/Sidebar.tsx` (Agent 3)
- `packages/shared/src/types.ts` (only if new WS message types needed)

## Acceptance Criteria

1. Switching projects/sessions does not stop the PI process for the previous selection.
2. Multiple sessions in the same project can stream concurrently (different PI processes).
3. Sidebar shows live indicators for background sessions that are streaming.
4. Returning to a session shows the messages that streamed in while away.
5. Idle timeout still cleans up abandoned sessions after 5 minutes.
6. No regressions in existing test suite.
7. TypeScript compiles cleanly.
