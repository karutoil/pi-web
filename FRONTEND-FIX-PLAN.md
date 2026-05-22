# PI Web Frontend Fix Plan

> Audit identified 27 issues across 4 severity tiers. This plan sequences fixes by dependency and impact.

---

## Phase 1 — Critical (blocks build / security / crash prevention)

### 1.1 Fix `isActive` TypeScript error
**File:** `packages/client/src/hooks/useWebSocket.ts:176`  
**Problem:** Return object missing `isActive` property required by `WSBridge`. Pool version (`useWebSocketPool.ts`) already has it — the legacy hook doesn't.  
**Fix:** Add `isActive: isStreaming` to the return object (line 176).  
**Verification:** `cd packages/client && npx tsc --noEmit` passes.  
**Effort:** 1 line.

### 1.2 Add `rehype-sanitize` to markdown renderer
**File:** `packages/client/src/components/MessageBubble.tsx` (AssistantBubble)  
**Problem:** `react-markdown` + `remark-gfm` renders unsanitized HTML. If any message content contains `<script>` or malicious HTML, it executes.  
**Fix:**  
- `bun add rehype-sanitize` in `packages/client`  
- Add `rehypePlugins={[rehypeSanitize]}` to the `<ReactMarkdown>` component  
- Optionally create a custom schema that allows GFM table/autolink extensions but blocks scripts  
**Verification:** Render a message with `<img onerror="alert(1)" src=x>` — no alert.  
**Effort:** Small.

### 1.3 Add React error boundary
**File:** New `packages/client/src/components/ErrorBoundary.tsx`, modify `main.tsx`  
**Problem:** Any runtime error in any component crashes the entire app with white screen.  
**Fix:**  
- Create class-based `ErrorBoundary` component with fallback UI (ink-themed, shows error message, "Reload" button)  
- Wrap `<App />` in `main.tsx` with `<ErrorBoundary>`  
- Optionally add a second boundary around `<ChatView />` so sidebar survives chat crashes  
**Verification:** Throw in a MessageBubble — app shows fallback instead of white screen.  
**Effort:** Small.

### 1.4 Fix root tsconfig project references
**File:** `tsconfig.json`  
**Problem:** `Referenced project may not disable emit` errors for both server and client.  
**Fix:** Either:
- Remove `"noEmit": true` from `packages/server/tsconfig.json` and `packages/client/tsconfig.json` (replace with `"emitDeclarationOnly": true` if needed), OR
- Remove the `"references"` array from root `tsconfig.json` and rely on per-package builds  
**Verification:** Root `npx tsc --noEmit` passes.  
**Effort:** Small config change.

---

## Phase 2 — Bugs & Performance

### 2.1 Fix stale closure in `ChatInput.handleSend`
**File:** `packages/client/src/components/ChatInput.tsx`  
**Problem:** `handleSend` captures `text` in deps, but `handleChange` updates `text` asynchronously. If user types very fast, the callback may fire with stale text.  
**Fix:** Use a ref for the current text value:  
```tsx
const textRef = useRef(text);
useEffect(() => { textRef.current = text; }, [text]);
// In handleSend, read textRef.current instead of text
```  
**Verification:** Rapidly type and hit Enter — correct text is sent.  
**Effort:** Small.

### 2.2 Replace `confirm()` with custom modal
**File:** `packages/client/src/components/Sidebar.tsx` (ProjectList, SessionItem)  
**Problem:** Native `confirm()` blocks main thread, looks inconsistent, no undo.  
**Fix:**  
- Create `ConfirmDialog` component (reuse `ContextMenu` portal pattern or `ExtensionUIModal` pattern)  
- Replace both `confirm()` calls in `onDeleteProject` and `onDeleteSession`  
- Add subtle animation, show entity name, add "This cannot be undone" warning  
**Verification:** Delete project/session — custom dialog appears.  
**Effort:** Medium.

### 2.3 Compress pasted images before sending
**File:** `packages/client/src/components/ChatInput.tsx`  
**Problem:** Pasted images sent as raw base64 through WebSocket. A 4K screenshot can be 2-5MB.  
**Fix:**  
- Create `packages/client/src/lib/imageUtils.ts` with `compressImage(blob, maxDim=1920, quality=0.8)`  
- Uses `OffscreenCanvas` or `<canvas>` to resize and `canvas.toBlob('image/jpeg', quality)` to compress  
- Apply in `handlePaste` before adding to `pendingImages`  
**Verification:** Paste 4K screenshot — WebSocket message size stays under ~200KB.  
**Effort:** Medium.

### 2.4 Cache session detail fetches
**File:** `packages/client/src/App.tsx` (`handleSelectSession`)  
**Problem:** Every session selection triggers a fresh `/api/sessions/detail` fetch. Navigating back and forth is wasteful.  
**Fix:**  
- Create `useSessionDetailCache` hook or use a simple `Map<string, { data: SessionDetail; timestamp: number }>`  
- Cache with 30s TTL. Invalidate on `ws.isStreaming` transitions (agent_end → refresh)  
**Verification:** Click same session twice — second click uses cache.  
**Effort:** Small-medium.

### 2.5 Fix session rename edge case
**File:** `packages/client/src/components/Sidebar.tsx` (SessionItem)  
**Problem:** If user clears the rename input and clicks away, `handleRenameSubmit` sends empty string. Also, clicking the rename input triggers `onSelect` via the parent button.  
**Fix:**  
- Guard: `if (trimmed && trimmed !== s.name)` already exists — but `trimmed` is empty when user clears input. Add: `if (!trimmed) { setIsRenaming(false); return; }`  
- Add `onClick={e => e.stopPropagation()}` to rename input (already present, verify)  
**Verification:** Clear rename input and blur — reverts to original name.  
**Effort:** Tiny.

### 2.6 Add loading states for async operations
**File:** Multiple  
**Problem:** Adding a project, fetching sessions — no spinner or loading indicator.  
**Fix:**  
- Add `isAddingProject` state, disable "Add" button while request in flight  
- Add subtle skeleton/shimmer for initial session list load  
- Model dropdown: show "Loading..." while `ws.models.length === 0` and `ws.isConnected`  
**Verification:** Add project with slow network — button shows loading state.  
**Effort:** Medium.

### 2.7 Fix context menu handler for tool results
**File:** `packages/client/src/components/MessageBubble.tsx`  
**Problem:** Context menu guard only allows `isUser || isAssistant`, which is correct — but `onCopyTurn` and `onCopyResponse` props could be undefined for messages rendered outside the ChatView turn grouping. Need to verify all callers pass these.  
**Fix:** Add null-check in `onCopyTurn?.()` and `onCopyResponse?.()` calls (already done with `?.()` syntax). Verify this is sufficient.  
**Verification:** Right-click on first historical message — context menu works.  
**Effort:** Verify-only.

### 2.8 Fix Extension UI modal z-index
**File:** `packages/client/src/components/ExtensionUIModal.tsx`, `ContextMenu.tsx`  
**Problem:** Modal uses `z-50`, context menu uses `z-9999`. Context menu could appear over modal.  
**Fix:** Standardize z-index layers:  
- `z-30` — sidebar overlays (session search, breadcrumbs)  
- `z-40` — dropdown menus (model selector, thinking level)  
- `z-50` — context menus  
- `z-60` — modal backdrop  
- `z-70` — modal content  
- `z-80` — notifications (toast)  
Add these as CSS custom properties in `styles.css`.  
**Verification:** Open modal, right-click — context menu appears behind modal.  
**Effort:** Small.

---

## Phase 3 — UX & Accessibility

### 3.1 Add ARIA attributes to icon-only buttons
**File:** `Sidebar.tsx`, `ChatHeader.tsx`, `ChatInput.tsx`, `MessageBubble.tsx`  
**Problem:** ~20 icon-only `<button>` elements have no `aria-label`. Screen readers announce nothing useful.  
**Fix:** Add `aria-label` to every icon button:  
- Theme toggle: `aria-label="Toggle dark mode"`  
- Add project: `aria-label="Add project"`  
- Refresh: `aria-label="Refresh sessions"`  
- Send: `aria-label="Send message"`  
- Abort: `aria-label="Abort"`  
- Fork: `aria-label="Fork from here"`  
- Copy in code block: `aria-label="Copy code"`  
**Verification:** Screen reader announces purpose of every button.  
**Effort:** Small (systematic find-and-add).

### 3.2 Add `aria-current` and `role` to session list
**File:** `packages/client/src/components/Sidebar.tsx`  
**Problem:** Active session has visual indicator but no ARIA state.  
**Fix:**  
- Add `aria-current="true"` to active session button  
- Add `role="listbox"` to session container, `role="option"` to each item  
**Verification:** Screen reader announces "current" for active session.  
**Effort:** Small.

### 3.3 Add `aria-live` region for streaming updates
**File:** `packages/client/src/components/ChatView.tsx`  
**Problem:** New messages and streaming content appear without screen reader announcements.  
**Fix:**  
- Add visually-hidden `<div aria-live="polite" className="sr-only">` that announces "PI is thinking", "PI responded", etc.  
- Update on `agent_start`, `agent_end`, `message_end` events  
**Verification:** Screen reader announces when new messages arrive.  
**Effort:** Small-medium.

### 3.4 Fix color contrast for small text
**File:** `packages/client/src/styles.css`  
**Problem:** `text-ink-600` on dark `bg-ink-950` is ~3.5:1 contrast ratio. Fails WCAG AA for text under 18px/14px bold. Many sidebar items use `text-[0.6rem]` (9.6px).  
**Fix:**  
- Bump `--color-ink-600` in dark mode from `#6e685d` to `#7d7568` (~4.6:1)  
- Or reduce usage of `text-ink-600` for meaningful text — use `text-ink-500` instead  
- Audit all `text-[0.6rem]` usages — these are sub-10px and fail AA regardless. Change smallest to `text-[0.65rem]` minimum  
**Verification:** Axe/WAVE contrast check passes.  
**Effort:** Small.

### 3.5 Add keyboard shortcut for new session
**File:** `packages/client/src/App.tsx`, `Sidebar.tsx`  
**Problem:** No `Cmd/Ctrl+N` shortcut for new session.  
**Fix:**  
- Add `useEffect` in App that listens for `keydown` with `e.metaKey && e.key === "n"`  
- Call `handleNewSession`  
- Prevent default browser new-window behavior  
**Verification:** Press Cmd+N — new session starts.  
**Effort:** Tiny.

### 3.6 Add "Compact context" confirmation/feedback
**File:** `packages/client/src/components/ChatView.tsx`  
**Problem:** Clicking "Compact context" gives no visual feedback.  
**Fix:**  
- Add local `isCompacting` state  
- Set `true` on click, listen for `ws.isStreaming` to become false (or compaction_end WS event)  
- Show spinner or disabled state while compacting  
- Show brief "Context compacted" toast after completion  
**Verification:** Click "Compact context" — button shows loading, then success feedback.  
**Effort:** Small.

### 3.7 Add focus-visible ring styling
**File:** `packages/client/src/styles.css`  
**Problem:** No custom focus-visible ring. Default browser outline may not match theme.  
**Fix:**  
```css
:focus-visible {
  outline: 2px solid var(--color-amber-500);
  outline-offset: 2px;
}
:focus:not(:focus-visible) {
  outline: none;
}
```  
**Verification:** Tab through interface — amber focus ring visible, matches theme.  
**Effort:** Tiny.

### 3.8 Add skip-to-content link
**File:** `packages/client/src/App.tsx`  
**Problem:** No skip link for keyboard users. Must tab through entire sidebar to reach chat.  
**Fix:**  
- Add visually-hidden link at top of App: `<a href="#main-content" className="sr-only focus:not-sr-only ...">Skip to chat</a>`  
- Add `id="main-content"` to `<main>` element  
- Add `sr-only` and `focus:not-sr-only` utility classes to styles.css  
**Verification:** Tab into page — first focus is skip link.  
**Effort:** Tiny.

---

## Phase 4 — Code Quality & Architecture

### 4.1 Extract shared utilities
**New file:** `packages/client/src/lib/utils.ts`  
**Problem:** `formatTimeAgo`, `formatCost`, `formatTokens` are duplicated across `App.tsx` and `Sidebar.tsx`. Magic numbers scattered.  
**Fix:**  
- Create `lib/utils.ts` with all shared formatters  
- Add constants file `lib/constants.ts`:  
  ```ts
  export const SCROLL_THRESHOLD = 120;
  export const SCROLL_THROTTLE_MS = 100;
  export const SESSION_FETCH_DELAY_MS = 1500;
  export const NOTIFY_TIMEOUT_MS = 4000;
  export const IMAGE_MAX_DIM = 1920;
  export const IMAGE_QUALITY = 0.8;
  ```  
- Replace all inline usages  
**Verification:** `npx tsc --noEmit` passes.  
**Effort:** Small.

### 4.2 Create icon component system
**New file:** `packages/client/src/components/Icon.tsx`  
**Problem:** ~30 inline `<svg>` elements scattered across 8 components. Duplicated arrow icons, close icons, etc.  
**Fix:**  
- Create `Icon` component with `name` prop: `<Icon name="chevron-right" size={10} />`  
- Define SVG paths in a map object  
- Replace all inline SVGs with `<Icon>` calls  
- Keep custom complex SVGs (logo, diff indicators) as-is  
**Verification:** Visual regression check — all icons render identically.  
**Effort:** Medium.

### 4.3 Remove `any` types
**File:** `MessageBubble.tsx`, `useWebSocket.ts`, `useWebSocketPool.ts`  
**Problem:** `any` used for ContentBlock casts, CodeBlock props, WS message handling.  
**Fix:**  
- `CodeBlock`: type `children` as `React.ReactNode`, type `className` as `string`  
- `useWebSocket`: remove `as AgentState` cast — type-narrow with runtime check  
- `DiffRenderer`: type `details.diff` parsing more precisely  
**Verification:** `npx tsc --noEmit --noImplicitAny` passes (or closer to it).  
**Effort:** Medium.

### 4.4 Add component tests
**New directory:** `packages/client/src/__tests__/`  
**Problem:** Zero test coverage.  
**Fix:** Start with highest-value tests:  
- `DiffRenderer.test.tsx` — parsing logic, side-by-side pairing, collapse/expand  
- `Sidebar.test.tsx` — session grouping, search filter, keyboard nav  
- `ChatInput.test.tsx` — send/abort, paste handling, command completion  
- `MessageBubble.test.tsx` — role-based rendering, context menu  
**Setup:** Add `vitest` + `@testing-library/react` + `jsdom`  
**Verification:** `bun test` runs and passes.  
**Effort:** Large (setup + initial test suite).

### 4.5 Refactor `useWebSocket` vs `useWebSocketPool` relationship
**File:** `packages/client/src/hooks/`  
**Problem:** Two parallel WebSocket hook implementations. `useWebSocketPool` is the active one (used in App.tsx). `useWebSocket` appears to be the legacy version. Both define `WSBridge`/`WSConnection` interfaces with subtle differences.  
**Fix:**  
- Remove `useWebSocket.ts` entirely (App.tsx uses `useWebSocketPool`)  
- Move `WSBridge`/`WSConnection`/`ToolEvent` types to `packages/client/src/lib/types.ts`  
- Re-export from pool hook for convenience  
- If `useWebSocket` is still needed for isolated usage, refactor it to delegate to pool  
**Verification:** App works identically after refactor. `npx tsc --noEmit` passes.  
**Effort:** Medium.

### 4.6 Fix shared package alias
**File:** `packages/client/vite.config.ts`  
**Problem:** `@pi-web/shared` aliases to a single file (`types.ts`). No tree-shaking, no type-checking of package boundary.  
**Fix:**  
- Create `packages/shared/src/index.ts` that re-exports from `types.ts`  
- Alias to the directory or `index.ts` instead  
- Long-term: add `package.json` `exports` field to shared package  
**Verification:** Imports still resolve.  
**Effort:** Small.

---

## Execution Order

```
1.1  Fix isActive TS error           → unblocks build
1.4  Fix root tsconfig               → clean compilation
1.2  Add rehype-sanitize             → security
1.3  Add error boundary              → crash prevention
─── Phase 1 complete, app builds & is safe ───
2.1  Fix stale closure               → input reliability
2.5  Fix rename edge case            → data integrity
2.7  Verify context menu handlers    → defensive check
2.8  Fix z-index layers              → visual consistency
2.2  Replace confirm()               → UX consistency
2.3  Compress pasted images          → performance/memory
2.4  Cache session detail            → network performance
2.6  Add loading states              → perceived performance
─── Phase 2 complete, all bugs fixed ───
3.7  Focus-visible ring              → keyboard UX baseline
3.8  Skip-to-content link            → keyboard navigation
3.1  ARIA labels                     → screen reader
3.2  ARIA current/roles              → session list accessibility
3.3  aria-live region                → streaming accessibility
3.4  Color contrast fixes            → readability
3.5  Cmd+N shortcut                  → power user
3.6  Compact feedback                → action feedback
─── Phase 3 complete, accessible & polished ───
4.1  Extract shared utils            → DRY, single source of truth
4.6  Fix shared package alias        → import hygiene
4.5  Consolidate WS hooks            → remove dead code
4.2  Icon component system           → maintainability
4.3  Remove any types                → type safety
4.4  Add component tests             → regression safety
─── Phase 4 complete, codebase is clean ───
```

## Estimated Total Effort

| Phase | Effort | Items |
|-------|--------|-------|
| 1 — Critical | ~2h | 4 items |
| 2 — Bugs & Perf | ~4h | 8 items |
| 3 — UX & A11y | ~3h | 8 items |
| 4 — Code Quality | ~6h | 6 items |
| **Total** | **~15h** | **26 items** |

## Risks & Notes

- **rehype-sanitize** may strip some GFM features (autolinks, table attributes). Test markdown rendering after adding.
- **Image compression** needs `OffscreenCanvas` — not available in all browsers. Fallback to regular `<canvas>`.
- **Removing `useWebSocket.ts`** requires checking if anything else imports it.
- **Color contrast changes** may subtly alter the visual feel. Test both themes carefully.
- **Test infrastructure** (vitest + testing-library) is a one-time setup cost that pays off long-term.
