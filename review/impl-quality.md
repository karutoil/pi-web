# Mobile Responsiveness Implementation Quality Review

## Correct

- **Mobile-first CSS consistent.** Base classes target mobile; `md:` prefixes upgrade at 768px. Examples: `p-4 md:p-8` (`App.tsx:436`), `max-h-32 md:max-h-48` (`MessageBubble.tsx:165`), `max-h-[160px] md:max-h-[200px]` (`ChatInput.tsx`).
- **useIsMobile hook is sound.** MatchMedia-based, SSR-safe with `typeof window !== "undefined"` guard (`useIsMobile.ts:9`), 768px breakpoint aligns with Tailwind `md:` and CSS media query (`styles.css:392`).
- **Viewport meta correct.** `index.html` has `width=device-width, initial-scale=1.0, viewport-fit=cover`.
- **Safe-area classes applied where needed.** `mobile-safe-top` on `ChatHeader`, `App` welcome, `ExtensionUIModal`, `SessionActions`, `AddProjectExplorer` header, `GitPanel`. `mobile-safe-bottom` on `ChatInput`, `Sidebar` content/footer, `ExtensionErrorToast`, `ConfirmDialog`, `ExtensionUIModal` dialog, `AddProjectExplorer` footer, `GitPanel`.
- **Touch targets enlarged on mobile.** `min-h-[44px]` on buttons in `ConfirmDialog`, `ExtensionUIModal`, `GitPanel` tabs, `GitBranchSelector` list items, `CommandCompleter`, `AddProjectExplorer`. `touch-target` / `touch-target-sm` utility classes used in `GitPanel`, `AddProjectExplorer`, `ExtensionErrorToast`.
- **Global touch optimizations.** `touch-action: manipulation` and `-webkit-tap-highlight-color: transparent` on all interactive elements (`styles.css:144`).
- **Dead CSS cleaned up.** Removed unused `.mobile-show-actions`, `.diff-side-by-side`, `.diff-side-toggle` rules from media query (`styles.css`).
- **Keyboard hints added.** `enterKeyHint` on `ChatInput`, `GitPanel` commit textarea, `ExtensionUIModal` inputs, `AddProjectExplorer` path input, `GitStash` name input, `GitBranchSelector` branch input. `autoCorrect="off"` on path/branch inputs.
- **ContextMenu touch-aware.** Added `touchend` listener alongside `mousedown`, `touch-none` class prevents scroll bleed (`ContextMenu.tsx`).
- **AddProjectExplorer double-click removed.** Replaced with explicit "Open directory" button — no hover-dependent interaction on mobile (`AddProjectExplorer.tsx:268`).
- **Build passes.** TypeScript + Vite build clean (per progress notes).

## Fixed

- **App.tsx window SSR crash.** `useState(window.innerWidth >= 768)` changed to `useState(false)` + `useEffect` (`App.tsx:24-26`). Prevents SSR/hydration mismatch.

## Blocker

None. Implementation is coherent and build-valid.

## Note

### N1 — TerminalInstance font size not reactive on resize
**File:** `packages/client/src/components/TerminalPanel.tsx:22`
`TerminalInstance` reads `isMobile` for `fontSize: isMobile ? 14 : 13`, but the `useEffect` creating the xterm terminal depends only on `[tab.id]`. If the user resizes the browser across the breakpoint, the terminal font does not update until the tab is remounted. Intentional tradeoff (xterm is heavy), but worth documenting.

### N2 — useIsMobile used where CSS alone would suffice
**File:** `packages/client/src/components/MessageBubble.tsx:321`
```tsx
const argsPreview = JSON.stringify(args).slice(0, isMobile ? 40 : 80);
```
String truncation by JS hook is unnecessary — `truncate` CSS class plus a `max-w` handles overflow without a hook dependency.

**File:** `packages/client/src/components/GitPanel.tsx:715-722`
```tsx
{onBlame && file.status !== "?" && !isMobile && (...)}
{onComparePrev && file.status !== "?" && !isMobile && (...)}
```
Could use `hidden md:inline-flex` instead of conditional render via hook. Not a bug, but adds re-render surface.

### N3 — Inconsistent desktop reset of mobile touch targets
**File:** `packages/client/src/components/GitStash.tsx:232-246`
Stash action buttons use `min-h-[44px] md:min-h-0` — explicitly resets on desktop.

**File:** `packages/client/src/components/GitPanel.tsx:382-393`
Tab buttons use `min-h-[44px]` with no `md:min-h-0` reset.

**File:** `packages/client/src/components/ConfirmDialog.tsx:64-73`
Dialog buttons use `min-h-[44px]` with no desktop reset.

Pick one pattern and apply consistently. Recommendation: keep `min-h-[44px]` unconditionally — harmless on desktop, simplifies mental model.

### N4 — Landscape sidebar selector is fragile
**File:** `packages/client/src/styles.css:283`
```css
@media (max-width: 767px) and (orientation: landscape) {
  aside[class*="w-\\[85vw\\]"] { max-width: 240px !important; }
}
```
Attribute selector on an escaped Tailwind class string. If the `w-[85vw]` class is ever removed from `Sidebar.tsx`, this rule silently dies. Add a dedicated class (e.g., `mobile-sidebar`) to `Sidebar.tsx:178` and target that instead.

### N5 — TerminalPanel mobile bottom sheet missing safe-area padding
**File:** `packages/client/src/components/TerminalPanel.tsx:337-338`
On mobile the panel is `fixed bottom-0` but does not apply `mobile-safe-bottom`. Home-indicator area can obscure the bottom of the terminal. Add the class or inline `padding-bottom: env(safe-area-inset-bottom)`.

### N6 — DiffRenderer old line numbers use hook instead of CSS
**File:** `packages/client/src/components/DiffRenderer.tsx`
Old line numbers hidden with `{!isMobile && (...) }`. Could be `hidden md:block` to avoid JS dependency. The `useEffect` that forces unified view on mobile is justified (state management).

### N7 — SessionActions modal offset not responsive to short viewports
**File:** `packages/client/src/components/SessionActions.tsx:22`
`pt-[20vh]` is a fixed percentage. On landscape phones (e.g., iPhone SE landscape ~375px tall), `20vh` = 75px and the modal may feel too close to the top edge despite `mobile-safe-top`. Consider `pt-[15vh] md:pt-[20vh]`.
