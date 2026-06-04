# Server Changes Report — Multi-Session Pool Re-Keying

## Files Changed

- `packages/server/src/pi-agent.ts` — pool key change, new helpers, RPC-based session switching
- `packages/server/src/index.ts` — new `wsToAgent` key derivation, `rekey_session` WS handler
- `packages/shared/src/types.ts` — added `rekey_session` to `WSClientMessage` union

## Validation

```
$ npx tsc -b
(no output)
```

All three packages (`shared`, `server`, `client`) compile cleanly. The client package was rebuilt and its `dist` types now align with the source.

## Summary of New `loadSession` / `switchSession` Semantics

### Before
- `PooledAgent.loadSession(path)` called `restartWithSession(path)`, which **stopped the running PI process and spawned a new one with the new session path**. Any in-flight streaming was lost.
- Pool keyed by `cwd` only — only one PI process per project, so multiple sessions could not run concurrently.
- `switchSession` was a raw RPC send (correct), but the agent would still get killed by the next `loadSession` call.

### After
- Pool keyed by `${cwd}::${sessionPath || "__new__"}` — one PI process per (project, session) tuple. Multiple sessions in the same project can run concurrently.
- `PooledAgent.loadSession(path)` sends `{type: "load_session", sessionPath}` to the running agent and lets PI handle the in-process switch. No process kill. In-flight streaming continues.
- `PooledAgent.switchSession(path)` sends `{type: "switch_session", sessionPath}` directly. No restart.
- `restartWithSession` is preserved (still on `PooledAgent`) for future stale-extension-ctx auto-recovery.
- The 5-minute idle timeout still works as before — per-agent, per-pool-entry.

### Re-Keying Flow for New Sessions
- WS opens with `sessionPath=null` (or `newSessionId` query) → `getOrCreateAgent(cwd, null, ...)` returns an agent with key `cwd::__new__`.
- PI creates the session and emits `state` with `sessionFile`. The client then sends `{type: "rekey_session", oldKey, newKey}` over the existing WS.
- The server's `rekey_session` handler calls `rekeyAgent(oldKey, newKey)` which moves the agent in the pool, updates the agent's `agentKey`, and updates `wsToAgent` for the calling client.
- Future `getOrCreateAgent(cwd, realPath, ...)` calls return the same agent.
- The client only needs to rekey its own pool entry on its side (handled by Agent 2).

### New Exported Helpers in `pi-agent.ts`
- `buildAgentKey(cwd, sessionPath)` — exported for client/server consistency.
- `lookupAgentBySessionKey(cwd, sessionPath)` — convenience for finding an agent by (cwd, session) tuple.
- `rekeyAgent(oldKey, newKey)` — moves an agent in the pool. Returns the moved agent or `null` if `oldKey` not found, or if `newKey` already has a different agent (caller must resolve conflict).

## Open Risks / Questions

1. **No server-side auto-rekey on `state.sessionFile` yet.** The rekey currently relies on the client sending `rekey_session` after it sees a new path. If the client never sends it, the agent stays under `__new__` in the pool. This is acceptable for now since the client always reacts to a new `sessionFile` (Agent 2 handles this), but a server-side safety net (auto-rekey when `state.sessionFile` arrives and current key is `__new__`) would be more robust. Deferred to a follow-up since the current design works.
2. **Stale-extension-ctx auto-recovery is unwired.** `restartWithSession` exists but no code currently calls it in response to a `load_session` failure. The project memory mentions this is a known issue. Will need a follow-up: detect `success: false` on a `load_session` response with a "stale ctx" error and trigger `restartWithSession` + retry. Not in scope for this PR per the prompt.
3. **Multiple concurrent "new session" attempts collide on `__new__` key.** If a user clicks "new session" twice quickly on the same project, the second click reuses the first agent and resets its state. The existing `handleNewSession` flow in App.tsx already mitigates this client-side by checking `ws.isConnected`, but server-side we don't disambiguate. Acceptable since the UI prevents this race in practice.
4. **`newSessionId` param was removed from `getOrCreateAgent`.** The call site in `index.ts` was updated. The `newSessionId` query param is still read in `onOpen` to decide whether to send `new_session` RPC. This is unchanged.

## Recommendations / Next Steps

- Wire up server-side auto-rekey on `state.sessionFile` change (intercept in `PooledAgent`'s message wrapper before broadcast).
- Add stale-ctx auto-recovery: detect failed `load_session` and call `restartWithSession` + retry.
- Verify the client-side rekey path in Agent 2 sends `rekey_session` promptly so the server pool stays in sync.
