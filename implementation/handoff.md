# Implementation Handoff — Mobile Responsiveness

## What Was Implemented

All four phases of `mobile-responsive-plan-v2.md` were implemented.

### Phase 1 — Foundation
- **styles.css**: Added global `touch-action: manipulation` / `-webkit-tap-highlight-color: transparent` on interactive elements. Reduced `pre` padding inside mobile media query. Added very-small-screen (`<374px`) heading sizes. Removed dead `.mobile-show-actions` and `.diff-side-by-side`/`.diff-side-toggle` rules. Added landscape orientation sidebar clamp.
- **useIsMobile.ts**: Added SSR guard (`typeof window !== "undefined"`) to prevent hydration mismatch.
- **App.tsx**: `showSidebar` now initializes to `false` and sets itself via `useEffect` on mount. Added `mobile-safe-top` to `SessionWelcome`.
- **Sidebar.tsx**: Added `mobile-safe-bottom` to scrollable area and footer.
- **ChatHeader.tsx**: Added `mobile-safe-top`.
- **ChatInput.tsx**: Reduced mobile textarea `max-h` to `160px` (desktop stays `200px`). Shrunk auto-retry error truncation to `max-w-24` on mobile (`sm:max-w-32`). Added `enterKeyHint="send"`.
- **ChatView.tsx**: Reduced empty-state padding to `py-16 md:py-20`.
- **Cross-cutting keyboard attributes**: Added `enterKeyHint` / `autoCorrect` to inputs in `ExtensionUIModal`, `AddProjectExplorer`, `GitPanel`, `GitStash`, `GitBranchSelector`.

### Phase 2 — Panels & Git
- **TerminalPanel.tsx**: xterm `fontSize` is now `14` on mobile, `13` on desktop (review B1 fix). Tab close button is always visible on mobile (`opacity-100 md:opacity-0 ...`). Added `touchAction: "manipulation"` inline style to panel root.
- **GitPanel.tsx**: Added `mobile-safe-top mobile-safe-bottom`. View tabs now `min-h-[44px]`. Multi-select action bar buttons resized to `px-2 py-1 text-xs min-h-[36px]`. Conflict banner buttons resized to `px-2.5 py-1.5 text-xs min-h-[36px]`. File-row actions hide **Blame** and **Compare** on mobile to prevent overflow.
- **GitBlame.tsx**: Mobile metadata font sizes bumped to `text-[0.7rem] sm:text-xs` / `text-[0.65rem] sm:text-xs`. Line content bumped to `text-xs sm:text-sm`. Back button gets `touch-target`. Added `overflow-x-auto` to content scroll container.
- **GitStash.tsx**: Action buttons changed from `min-h-[28px]` to `min-h-[44px] md:min-h-0` and `text-[0.6rem]` → `text-xs md:text-[0.65rem]`.
- **GitBranchSelector.tsx**: List items get `min-h-[44px]`. Dropdown gets `max-w-[calc(100vw-1rem)] right-0`. Added `touchend` fallback for click-outside dismissal.
- **GitLog.tsx**: Commit rows get `min-h-[44px]`.

### Phase 3 — Modals & Interactions
- **ContextMenu.tsx**: Items now `py-2.5 min-h-[44px]`; shortcuts hidden on mobile (`hidden sm:block`). Portal gets `touch-none`. Added `touchend` fallback for click-outside. Viewport clamping now measures real menu size and clamps to `8px` inset so menu never renders off-screen.
- **ConfirmDialog.tsx**: Content wrapped in `overflow-y-auto max-h-[calc(60vh-2.5rem)]`. Buttons get `min-h-[44px]`.
- **ExtensionUIModal.tsx**: All dialog buttons (`select`, `confirm`, `input`, `editor`) get `min-h-[44px]`. Editor textarea `rows={8}` removed; replaced with `min-h-[120px] md:min-h-[200px]`. Close button gets `p-1.5 touch-target-sm`. Inner content div gets `overflow-y-auto max-h-[calc(65vh-4rem)]`.
- **ExtensionErrorToast.tsx**: Root gets `mobile-safe-bottom`. Dismiss button gets `p-1.5 touch-target-sm`.
- **AddProjectExplorer.tsx**: Header gets `mobile-safe-top`, footer `mobile-safe-bottom`. Path input gets `min-h-[44px]`, `enterKeyHint="go"`, `autoCorrect="off"`. Submit/cancel buttons get `min-h-[44px]`. Header close button gets `touch-target-sm`. Directory chevron converted to a real `<button>` that calls `handleEnterDirectory` (avoids nested-button invalid HTML by changing row wrapper from `<button>` to `<div role="option">`).
- **SessionActions.tsx**: Inner modal gets `mobile-safe-top`. Footer hint hidden on mobile (`hidden sm:block`).
- **MessageBubble.tsx**: User image attachments now `max-h-32 md:max-h-48`.
- **CommandCompleter.tsx**: Command items get `min-h-[44px]`.
- **WidgetDisplay.tsx**: Root gets `overflow-x-auto`.

### Phase 4 — Polish
- **EmptyState.tsx**: Logo responsive sizing `w-16 h-16 md:w-20 md:h-20`.
- **TerminalPanel.tsx**: Added separate `handleResizeTouchStart` handler with `touchmove`/`touchend` listeners for desktop resize handle.
- **styles.css**: Added landscape orientation query to clamp sidebar width to `240px` on mobile landscape.

## Changed Files

| File | Changes |
|------|---------|
| `packages/client/src/styles.css` | Touch-action globals, mobile `pre` padding, very-small-screen breakpoint, dead CSS removal, landscape query |
| `packages/client/src/hooks/useIsMobile.ts` | SSR guard |
| `packages/client/src/App.tsx` | `SessionWelcome` safe-area, `showSidebar` SSR-safe init |
| `packages/client/src/components/Sidebar.tsx` | `mobile-safe-bottom` on scroll area and footer |
| `packages/client/src/components/ChatHeader.tsx` | `mobile-safe-top` |
| `packages/client/src/components/ChatInput.tsx` | Responsive `max-h`, auto-retry `max-w`, `enterKeyHint` |
| `packages/client/src/components/ChatView.tsx` | Empty-state padding |
| `packages/client/src/components/TerminalPanel.tsx` | xterm `fontSize`, tab close visibility, touch-action, desktop resize touch handlers |
| `packages/client/src/components/GitPanel.tsx` | Safe areas, touch targets, tab min-h, multi-select sizing, conflict buttons, file-row mobile action filter, keyboard attrs |
| `packages/client/src/components/GitBlame.tsx` | Responsive font sizes, back button touch target, `overflow-x-auto` |
| `packages/client/src/components/GitStash.tsx` | Action button min-h / text size, keyboard attrs |
| `packages/client/src/components/GitBranchSelector.tsx` | List item min-h, `touchend` fallback, dropdown overflow clamp |
| `packages/client/src/components/GitLog.tsx` | Commit row min-h |
| `packages/client/src/components/ContextMenu.tsx` | Item min-h, shortcut hidden mobile, `touch-none`, `touchend` fallback, viewport clamping |
| `packages/client/src/components/ConfirmDialog.tsx` | Button min-h, body scroll wrapper |
| `packages/client/src/components/ExtensionUIModal.tsx` | Button/input min-h, editor textarea height, close button, body scroll, keyboard attrs |
| `packages/client/src/components/ExtensionErrorToast.tsx` | Safe area, dismiss button sizing |
| `packages/client/src/components/AddProjectExplorer.tsx` | Safe areas, directory enter button, input/button min-h, keyboard attrs |
| `packages/client/src/components/SessionActions.tsx` | Safe area, hint hidden mobile |
| `packages/client/src/components/MessageBubble.tsx` | Image max-h responsive |
| `packages/client/src/components/CommandCompleter.tsx` | Item min-h |
| `packages/client/src/components/WidgetDisplay.tsx` | `overflow-x-auto` |
| `packages/client/src/components/EmptyState.tsx` | Logo responsive sizing |

## Validation

```
$ bun run --cwd packages/client build
$ tsc -b && vite build
✓ built in 1.91s
```

TypeScript compiles cleanly and Vite production build succeeds with no errors.

## What Was Left Undone

- **StatusBar.tsx**: Component is a stub (returns `null`). No mobile-specific change was applied; it should be implemented or removed in a future sprint.
- **Manual device emulation testing**: The plan’s Phase 4.5 testing checklist (iPhone SE, iPhone 14 Pro, iPad Mini, etc.) was not executed. Build validation confirms no compile-time breakage, but runtime verification on emulated devices is recommended.
- **Scroll trapping for additional modals**: Review note N1 flagged that `ConfirmDialog`, `ExtensionUIModal`, `AddProjectExplorer`, and `SessionActions` lack explicit `touch-none` / `overscroll-behavior: contain` on their overlays. The plan only mandated this for `ContextMenu`. Adding it to the remaining modals is a low-risk follow-up if body-scroll propagation becomes an issue during manual testing.
- **Landscape handling beyond sidebar**: Only sidebar width has a landscape rule. Other components rely on general responsive classes. No explicit landscape breakage is known, but dedicated testing would confirm.

## Decisions Needing Parent Approval

None. All changes follow the approved plan and review. The one review blocker (B1 — TerminalPanel font size direction) was corrected during implementation.

## Recommended Next Step

Run the Phase 4.5 manual testing checklist in Chrome DevTools device emulation to verify:
1. Sidebar overlay open/close and no horizontal scroll.
2. Chat input textarea growth capped correctly on short viewports.
3. Terminal bottom-sheet touch drag and xterm readability.
4. GitPanel buttons are all tappable (≥44 px).
5. ContextMenu spawns on long-press and stays on-screen.
6. All modals fit within viewport and buttons are tappable.
