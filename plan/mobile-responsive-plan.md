# Implementation Plan — Mobile Responsiveness for pi-web Client

## Goal
Make the pi-web client fully usable on phones (320–430 px) and tablets (768–1024 px) without breaking the desktop experience.

---

## Phase 1 — Foundation (global CSS, safe areas, core layout)
*Apply first. No component logic changes; only CSS and className additions.*

### 1.1 Global touch-action + tap-highlight
- **File:** `packages/client/src/styles.css`
- **Where:** After `body` block, before scrollbar block.
- **Add:**
  ```css
  button, a, input, textarea, select, [role="button"] {
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
  }
  ```
- **Priority:** P1 — removes 300 ms tap delay on older Android Chrome.

### 1.2 Mobile `pre` padding reduction
- **File:** `packages/client/src/styles.css`
- **Where:** Inside `@media (max-width: 767px)` block (line ~374).
- **Change:**
  ```css
  pre {
    -webkit-overflow-scrolling: touch;
    font-size: 0.75rem;
    padding: 0.75rem 1rem; /* was 1rem 1.25rem globally */
  }
  ```
- **Priority:** P0 — currently eats ~32 % of a 320 px screen.

### 1.3 Very-small-screen breakpoint
- **File:** `packages/client/src/styles.css`
- **Where:** After existing `@media (max-width: 767px)` block.
- **Add:**
  ```css
  @media (max-width: 374px) {
    .markdown-content h1 { font-size: 1.25em; }
    .markdown-content h2 { font-size: 1.1em; }
    .markdown-content h3 { font-size: 1em; }
  }
  ```
- **Priority:** P1 — iPhone SE / Galaxy Fold comfort.

### 1.4 Dead CSS cleanup
- **File:** `packages/client/src/styles.css`
- **Where:** Inside mobile media query.
- **Remove:** `.mobile-show-actions` rules (no consumers in codebase).
- **Remove:** `.diff-side-by-side` / `.diff-side-toggle` `!important` rules (DiffRenderer already handles this in JS).
- **Priority:** P2 — reduces confusion.

### 1.5 `useIsMobile` SSR guard
- **File:** `packages/client/src/hooks/useIsMobile.ts`
- **Where:** Line 7 inside `useEffect`.
- **Change:**
  ```ts
  const mql = typeof window !== "undefined"
    ? window.matchMedia(`(max-width: ${breakpoint - 1}px)`)
    : { matches: false, addEventListener: () => {}, removeEventListener: () => {} } as any;
  ```
- **Priority:** P2 — future-proofs against SSR.

### 1.6 App shell safe-area + sidebar footer
- **File:** `packages/client/src/components/Sidebar.tsx`
- **Where:** Scrollable area class and footer wrapper.
- **Change:**
  - Add `mobile-safe-bottom` class to the `<div className="flex-1 overflow-y-auto custom-scrollbar px-2">` (line ~216).
  - Add `mobile-safe-bottom` class to the footer `<div className="px-4 py-2.5 ...">` (line ~255).
- **Priority:** P1 — prevents home indicator from hiding last item and footer bar.

### 1.7 ChatHeader safe-area top
- **File:** `packages/client/src/components/ChatHeader.tsx`
- **Where:** Root `<div>` (line ~79).
- **Change:** Append `mobile-safe-top` to className.
- **Priority:** P1 — avoids notch overlap.

### 1.8 ChatInput textarea max-height
- **File:** `packages/client/src/components/ChatInput.tsx`
- **Where:** `<textarea>` className (line ~156).
- **Change:** `max-h-[200px]` → `max-h-[160px] md:max-h-[200px]`.
- **Priority:** P1 — 200 px can push content off-screen on short viewports.

### 1.9 ChatInput auto-retry truncation
- **File:** `packages/client/src/components/ChatInput.tsx`
- **Where:** Error message span (line ~173).
- **Change:** `max-w-32` → `max-w-24 sm:max-w-32`.
- **Priority:** P1 — overflows on 320 px screens.

### 1.10 ChatView empty-state padding
- **File:** `packages/client/src/components/ChatView.tsx`
- **Where:** Empty state wrapper (line ~302).
- **Change:** `py-20` → `py-16 md:py-20`.
- **Priority:** P2.

### 1.11 SessionWelcome safe-area top
- **File:** `packages/client/src/App.tsx`
- **Where:** `SessionWelcome` root `<div>` (line ~352).
- **Change:** Append `mobile-safe-top` to className.
- **Priority:** P1.

### 1.12 App.tsx sidebar SSR-safe init
- **File:** `packages/client/src/App.tsx`
- **Where:** `showSidebar` state declaration (line ~24).
- **Change:**
  ```ts
  const [showSidebar, setShowSidebar] = useState(false);
  useEffect(() => {
    setShowSidebar(window.innerWidth >= 768);
  }, []);
  ```
  *(Was `useState(window.innerWidth >= 768)` which causes hydration mismatch on mobile.)*
- **Priority:** P1 — prevents sidebar flash / hydration mismatch on mobile.

### 1.13 Mobile keyboard attributes (cross-cutting)
- **Files:** `ChatInput.tsx`, `ExtensionUIModal.tsx`, `AddProjectExplorer.tsx`, `GitPanel.tsx`, `GitStash.tsx`, `GitBranchSelector.tsx`
- **Where:** All `<input>` and `<textarea>` elements.
- **Change:** Add appropriate attributes:
  - `ChatInput` textarea: `enterKeyHint="send"`
  - `ExtensionUIModal` input: `enterKeyHint="done"`
  - `AddProjectExplorer` path input: `enterKeyHint="go"`, `autoCorrect="off"`
  - `GitPanel` commit textarea: `enterKeyHint="send"`
  - `GitStash` stash input: `enterKeyHint="done"`
  - `GitBranchSelector` create-branch input: `enterKeyHint="done"`, `autoCorrect="off"`
- **Priority:** P1 — improves mobile keyboard UX.

---

## Phase 2 — Panels & Git (touch targets, font sizes, safe areas)
*Depends on Phase 1 CSS being in place (touch-action, pre padding).*

### 2.1 TerminalPanel xterm font size
- **File:** `packages/client/src/components/TerminalPanel.tsx`
- **Where:** `TerminalInstance` component, `new Terminal({...})` options (line ~48).
- **Change:**
  ```ts
  const isMobile = useIsMobile(); // add import at top
  // ...
  fontSize: isMobile ? 11 : 13,
  ```
- **Priority:** P0 — 13 px is unreadable on high-DPI phones.

### 2.2 TerminalPanel tab close button visibility
- **File:** `packages/client/src/components/TerminalPanel.tsx`
- **Where:** `TabButton` close button className (line ~300).
- **Change:**
  ```
  opacity-100 md:opacity-0 md:group-hover:opacity-100
  ```
  (was `opacity-0 group-hover:opacity-100 sm:opacity-40 sm:group-hover:opacity-100`).
- **Priority:** P1 — currently invisible on phones (<640 px).

### 2.3 TerminalPanel touch-action on content
- **File:** `packages/client/src/components/TerminalPanel.tsx`
- **Where:** Terminal content wrapper (line ~256 inside panel root).
- **Change:** Add `style={{ touchAction: "manipulation" }}` to the panel root `<div>` (or the content area). Do **not** use `touch-manipulation` class — it is undefined in both `styles.css` and Tailwind v4.
- **Priority:** P2.

### 2.4 GitPanel safe-area top + bottom
- **File:** `packages/client/src/components/GitPanel.tsx`
- **Where:** Root `<div>` (line ~173).
- **Change:** Append `mobile-safe-top mobile-safe-bottom` to className.
- **Priority:** P1.

### 2.5 GitPanel header buttons touch targets
- **File:** `packages/client/src/components/GitPanel.tsx`
- **Where:** Header sync / refresh / close buttons (lines ~341–350).
- **Change:** Verify `touch-target` class is present on each `<button>`. It is already present in source (review confirmed). If any button is missing it, add `p-1.5 touch-target md:p-1`.
- **Priority:** P1 — ensures ≥44 px target on mobile.
- **Note:** Implementation can skip if already applied.

### 2.6 GitPanel view tabs touch targets
- **File:** `packages/client/src/components/GitPanel.tsx`
- **Where:** View tab buttons (lines ~303–312).
- **Change:** Add `min-h-[44px]` to both `<button>` className strings.
- **Priority:** P1.

### 2.7 GitPanel multi-select bar sizing
- **File:** `packages/client/src/components/GitPanel.tsx`
- **Where:** Multi-select action bar (lines ~320–325).
- **Change:** Buttons `px-2 py-0.5 text-[0.65rem]` → `px-2 py-1 text-xs min-h-[36px]`.
- **Priority:** P1.

### 2.8 GitPanel conflict banner buttons
- **File:** `packages/client/src/components/GitPanel.tsx`
- **Where:** `ConflictBanner` buttons (lines ~114–121).
- **Change:** `px-2 py-1 text-[0.65rem]` → `px-2.5 py-1.5 text-xs min-h-[36px]`.
- **Priority:** P1.

### 2.9 GitPanel file row action cleanup on mobile
- **File:** `packages/client/src/components/GitPanel.tsx`
- **Where:** `FileRow` actions block (line ~701).
- **Change:** On mobile, hide Blame (`B`) and Compare (`⇄`) buttons; keep only Stage/Unstage and Discard.
  *Implementation:* In the `showActions` block, conditionally render the extra buttons:
  ```tsx
  {onBlame && file.status !== "?" && !isMobile && ( ... )}
  {onComparePrev && file.status !== "?" && !isMobile && ( ... )}
  ```
- **Priority:** P1 — 5 buttons overflow 320 px rows.

### 2.10 GitBlame font sizes
- **File:** `packages/client/src/components/GitBlame.tsx`
- **Where:** Mobile metadata spans (lines ~118–119) and line content (line ~130).
- **Change:**
  - `text-[0.6rem]` → `text-[0.7rem] sm:text-xs`
  - `text-[0.55rem]` → `text-[0.65rem] sm:text-xs`
  - `text-[0.7rem]` (line content) → `text-xs sm:text-sm`
- **Priority:** P0 — sub-8 px text is unreadable.

### 2.11 GitBlame back button touch target
- **File:** `packages/client/src/components/GitBlame.tsx`
- **Where:** Back button (line ~95).
- **Change:** Add `touch-target` class.
- **Priority:** P1.

### 2.12 GitBlame horizontal scroll
- **File:** `packages/client/src/components/GitBlame.tsx`
- **Where:** Content scroll container (line ~111).
- **Change:** Add `overflow-x-auto` to the `<div className="flex-1 overflow-y-auto ...">`.
- **Priority:** P1 — long lines are clipped.

### 2.13 GitStash action button sizing
- **File:** `packages/client/src/components/GitStash.tsx`
- **Where:** `StashRow` buttons (lines ~236–246).
- **Change:**
  - Remove `min-h-[28px] md:min-h-0`
  - Add `min-h-[44px] md:min-h-0`
  - Change `text-[0.6rem]` → `text-xs md:text-[0.65rem]`
- **Priority:** P1.

### 2.14 GitBranchSelector item touch targets + dropdown overflow
- **File:** `packages/client/src/components/GitBranchSelector.tsx`
- **Where:** Branch list items (lines ~153–167) and tag items (line ~180).
- **Change:**
  - Add `min-h-[44px]` to each `<button>` in list.
  - Add `max-w-[calc(100vw-1rem)]` to the dropdown container to prevent overflow on sub-320 px viewports.
  - Add `right-0` as a fallback positioning class if dropdown overflows right edge.
- **Priority:** P1.

### 2.15 GitBranchSelector click-outside touch fallback
- **File:** `packages/client/src/components/GitBranchSelector.tsx`
- **Where:** `useEffect` for click outside (lines ~93–101).
- **Change:** Add `document.addEventListener("touchend", handleClick)` alongside `mousedown`, and remove in cleanup.
- **Priority:** P2.

### 2.16 GitLog commit row touch target
- **File:** `packages/client/src/components/GitLog.tsx`
- **Where:** `CommitRow` root `<div>` (line ~172).
- **Change:** Add `min-h-[44px]` to className.
- **Priority:** P2.

---

## Phase 3 — Modals & Interactions (dialog sizing, touch targets, scroll)
*Depends on Phase 1 + 2. Changes are className / attribute additions; no logic coupling.*

### 3.1 ContextMenu item sizing + shortcut hiding
- **File:** `packages/client/src/components/ContextMenu.tsx`
- **Where:** `ContextMenuItem` button (line ~110).
- **Change:**
  - `py-1.5` → `py-2.5` (increases height toward 44 px)
  - Add `min-h-[44px]`
  - Shortcut span: add `hidden sm:block` class.
- **Priority:** P1.

### 3.2 ContextMenu touch suppression
- **File:** `packages/client/src/components/ContextMenu.tsx`
- **Where:** Portal root `<div>` (line ~99).
- **Change:** Add `touch-none` class.
- **Priority:** P1 — prevents body scroll while menu open.

### 3.3 ContextMenu click-outside touchend fallback
- **File:** `packages/client/src/components/ContextMenu.tsx`
- **Where:** `useEffect` for click outside (lines ~56–72).
- **Change:** Add `document.addEventListener("touchend", handleClickOutside)` alongside `mousedown`, and remove in cleanup.
- **Priority:** P2.

### 3.4 ContextMenu viewport clamping
- **File:** `packages/client/src/components/ContextMenu.tsx`
- **Where:** `ContextMenuPortal` positioning logic.
- **Change:** Clamp `left`/`top` so the menu never renders off-screen:
  ```ts
  const maxLeft = window.innerWidth - menuRect.width - 8;
  const maxTop = window.innerHeight - menuRect.height - 8;
  const clampedLeft = Math.min(Math.max(left, 8), maxLeft);
  const clampedTop = Math.min(Math.max(top, 8), maxTop);
  ```
- **Priority:** P1 — prevents menu from rendering outside viewport on mobile.

### 3.5 ConfirmDialog button sizing + scroll
- **File:** `packages/client/src/components/ConfirmDialog.tsx`
- **Where:** Dialog body `<div>` (line ~47) and buttons (lines ~52–60).
- **Change:**
  - Body: wrap content in an inner `<div className="overflow-y-auto max-h-[calc(60vh-2.5rem)]">` (the padded outer box should not be the scroll container).
  - Buttons: add `min-h-[44px]` to both Cancel and Confirm buttons.
- **Priority:** P1.

### 3.6 ExtensionUIModal select / confirm / input button sizing
- **File:** `packages/client/src/components/ExtensionUIModal.tsx`
- **Where:**
  - Select list buttons (line ~65): add `min-h-[44px]`
  - Confirm buttons (line ~83–92): add `min-h-[44px]`
  - Input / submit buttons (line ~98–109): add `min-h-[44px]`
- **Priority:** P1.

### 3.7 ExtensionUIModal editor textarea rows
- **File:** `packages/client/src/components/ExtensionUIModal.tsx`
- **Where:** Textarea (line ~118).
- **Change:** Remove `rows={8}`; add CSS class `min-h-[120px] md:min-h-[200px]` to the textarea.
- **Priority:** P1 — 8 rows overflow short mobile viewports.

### 3.8 ExtensionUIModal close button sizing
- **File:** `packages/client/src/components/ExtensionUIModal.tsx`
- **Where:** Header close button (line ~205).
- **Change:** Wrap in `<button className="touch-target-sm ...">` or increase padding to `p-1.5`.
- **Priority:** P1 — 16 px icon alone is ~16 px target.

### 3.9 ExtensionUIModal dialog body scroll
- **File:** `packages/client/src/components/ExtensionUIModal.tsx`
- **Where:** Dialog content wrapper (line ~203).
- **Change:** Add `overflow-y-auto max-h-[calc(65vh-4rem)]` to the inner content div (not the outer centered container), accounting for header + safe area.
- **Priority:** P1.

### 3.10 ExtensionErrorToast safe area + dismiss button
- **File:** `packages/client/src/components/ExtensionErrorToast.tsx`
- **Where:** Root container (line ~18) and dismiss button (line ~27).
- **Change:**
  - Root `<div>`: append `mobile-safe-bottom`
  - Dismiss `<button>`: add `p-1.5 touch-target-sm`
- **Priority:** P1.

### 3.11 AddProjectExplorer safe areas
- **File:** `packages/client/src/components/AddProjectExplorer.tsx`
- **Where:** Header wrapper (line ~105) and footer wrapper (line ~163).
- **Change:**
  - Header: add `mobile-safe-top`
  - Footer: add `mobile-safe-bottom`
- **Priority:** P1.

### 3.12 AddProjectExplorer directory enter on mobile
- **File:** `packages/client/src/components/AddProjectExplorer.tsx`
- **Where:** File list item button (line ~210).
- **Change:** Make the chevron-right icon actionable for directories:
  - Change the `<Icon name="chevron-right-sm" ... />` at end of row to a `<button>` that calls `handleEnterDirectory(item)` when `item.isDirectory`.
  - Add `aria-label="Open directory"`.
- **Priority:** P1 — double-tap does not work on touch.

### 3.13 AddProjectExplorer input + button sizing
- **File:** `packages/client/src/components/AddProjectExplorer.tsx`
- **Where:**
  - Path input (line ~146): add `min-h-[44px]`
  - Submit button (line ~255): add `min-h-[44px]`
  - Cancel button (line ~262): add `min-h-[44px]`
  - Header close button (line ~119): add `touch-target-sm`
- **Priority:** P1.

### 3.14 SessionActions safe area + hint hiding
- **File:** `packages/client/src/components/SessionActions.tsx`
- **Where:** Root overlay `<div>` (line ~22) and footer hint (line ~32).
- **Change:**
  - Root: add `mobile-safe-top` to the inner modal box (or change `pt-[20vh]` to `pt-[calc(20vh+env(safe-area-inset-top))]`)
  - Footer hint: add `hidden sm:block`
- **Priority:** P1.

### 3.15 MessageBubble image max-height
- **File:** `packages/client/src/components/MessageBubble.tsx`
- **Where:** User image attachments (line ~ user bubble images).
- **Change:** `max-h-48` → `max-h-32 md:max-h-48`.
- **Priority:** P1 — images can overflow narrow screens.

### 3.16 CommandCompleter item touch target
- **File:** `packages/client/src/components/CommandCompleter.tsx`
- **Where:** Command item buttons (line ~29).
- **Change:** Add `min-h-[44px]` to each `<button>`.
- **Priority:** P2.

### 3.17 WidgetDisplay overflow
- **File:** `packages/client/src/components/WidgetDisplay.tsx`
- **Where:** Root `<div>` (line ~15).
- **Change:** Add `overflow-x-auto` to className.
- **Priority:** P2.

---

## Phase 4 — Polish & Testing
*Low-risk visual tweaks and validation.*

### 4.1 EmptyState logo responsive sizing
- **File:** `packages/client/src/components/EmptyState.tsx`
- **Where:** Logo `<img>` (line ~12).
- **Change:**
  ```tsx
  <img src="/pi-logo.svg" alt="PI" width="80" height="80" className="mx-auto w-16 h-16 md:w-20 md:h-20" />
  ```
- **Priority:** P2.

### 4.2 TerminalPanel desktop resize touch support
- **File:** `packages/client/src/components/TerminalPanel.tsx`
- **Where:** Desktop resize handle (line ~322).
- **Change:** Add a separate `handleResizeTouchStart` handler (and `touchmove`/`touchend` listeners) for the desktop resize handle. Do **not** reuse `handleResizeMouseDown` — it expects `React.MouseEvent` and installs `mousemove`/`mouseup` listeners. Touch events need `React.TouchEvent` and `touchmove`/`touchend` with `e.touches[0].clientY`.
  ```ts
  const handleResizeTouchStart = useCallback((e: React.TouchEvent) => {
    e.preventDefault();
    setIsResizing(true);
    startYRef.current = e.touches[0].clientY;
    // ... mirror mouse handlers using touchmove/touchend and e.touches[0].clientY
  }, []);
  ```
  Then add `onTouchStart={handleResizeTouchStart}` to the desktop resize `<div>`.
- **Priority:** P2.

### 4.3 Landscape orientation media query
- **File:** `packages/client/src/styles.css`
- **Where:** After mobile media query.
- **Add:**
  ```css
  @media (max-width: 767px) and (orientation: landscape) {
    /* Reduce sidebar width in landscape to leave room for chat */
    aside[class*="w-\\[85vw\\]"] { max-width: 240px !important; }
  }
  ```
  *Alternative:* if the sidebar element receives an explicit class, target that class directly. The current sidebar uses `w-[85vw] max-w-[288px]` inline; the attribute selector above targets it without adding a new class. If a dedicated class is added to `Sidebar.tsx`, replace the selector with that class.
- **Priority:** P2.

### 4.4 StatusBar stub note
- **File:** `packages/client/src/components/StatusBar.tsx`
- **Where:** Entire file.
- **Note:** Component returns `null` — entirely non-functional. Not a mobile blocker, but should be removed or implemented in a future sprint. No mobile-specific change required.
- **Priority:** P2.

### 4.5 Testing checklist
1. **Device emulation (Chrome DevTools):**
   - iPhone SE (375×667)
   - iPhone 14 Pro (393×852)
   - iPhone 14 Pro Max (430×932)
   - iPad Mini (768×1024)
   - iPad Air (820×1180)
2. **Per breakpoint verify:**
   - Sidebar opens/closes via overlay; no horizontal scroll.
   - Chat input textarea grows to `max-h-[160px]` and does not push header off-screen.
   - Terminal bottom-sheet snaps correctly; xterm text is readable.
   - GitPanel fills screen; all buttons are tappable (≥44 px).
   - GitBlame text is readable; horizontal scroll works.
   - ContextMenu spawns on long-press and stays on-screen (viewport clamped).
   - ConfirmDialog / ExtensionUIModal fit within viewport; buttons tappable.
   - AddProjectExplorer chevron enters directories; keyboard does not hide submit button.
   - ExtensionErrorToast not hidden by home indicator.
3. **Accessibility:** Run Lighthouse "Mobile" audit; target score ≥90.
4. **Manual touch-test:** Tap every button in GitPanel, Terminal tabs, and modals on a real phone if possible.

---

## Breakpoint Rationale
- **`md:` (768 px)** — Primary mobile/desktop toggle. Used for any change that should flip exactly at the CSS media-query boundary (`max-width: 767px`).
- **`sm:` (640 px)** — Used only when an intermediate tier is intentionally desired (e.g., `max-w-24 sm:max-w-32` in ChatInput, where 640 px still has room for the wider truncation). Prefer `md:` for all standard mobile/desktop splits to keep mental model simple.

---

## Files to Modify
| File | What |
|------|------|
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
| `packages/client/src/components/StatusBar.tsx` | No-op note (stub) |

## Dependencies
- Phase 2 depends on Phase 1 CSS being present (touch-action, pre padding).
- Phase 3 depends on Phase 1 + 2 because modal buttons reference `touch-target` / `min-h` conventions established earlier.
- Phase 4 is independent and can run in parallel with Phase 3 if desired.

## Risks
1. **xterm font-size change** (2.1) may cause row/col miscalculation on mobile because `FitAddon` uses pixel dimensions. Verify terminal still fills width after reducing font size.
2. **GitPanel file-row action filtering** (2.9) removes Blame/Compare on mobile. If users rely on those, consider a secondary "more" menu instead of full removal.
3. **ExtensionUIModal textarea row removal** (3.7) changes the visual height. Ensure the `min-h` Tailwind classes are applied correctly and do not conflict with `resize-none`.
4. **Safe-area classes** rely on `viewport-fit=cover` in `index.html`, which is already present. If any parent has `overflow: hidden`, env() padding may be clipped. Verify no parent clips `.mobile-safe-top/bottom`.
5. **Global `touch-action: manipulation`** (1.1) prevents double-tap zoom everywhere. This is desired for a web app, but verify no user expects pinch-zoom on images (they can still pinch-zoom the page; `manipulation` only disables double-tap).
6. **ContextMenu viewport clamping** (3.4) requires measuring the menu after render. If the menu is portaled before measurement, a single-frame flash may occur; mitigate with `visibility: hidden` until coords are computed.

## Changelog

### v2 — 2024-05-24
- **B1 (BLOCKER):** Fixed 4.2 — desktop resize `onTouchStart` now uses separate `handleResizeTouchStart` with `touchmove`/`touchend` instead of reusing `handleResizeMouseDown`. Prevents type error and broken touch resize.
- **B2 (BLOCKER):** Fixed 4.3 — replaced nonexistent `.sidebar-mobile` with attribute selector targeting `aside[class*="w-\\[85vw\\]"]` (or explicit class if added). Landscape query now targets real DOM.
- **B3 (BLOCKER):** Fixed 2.3 — replaced undefined `touch-manipulation` class with `style={{ touchAction: "manipulation" }}`. The class does not exist in Tailwind v4 or `styles.css`.
- **B4 (BLOCKER):** Added 1.12 — `App.tsx` `showSidebar` SSR-safe init. Changed `useState(window.innerWidth >= 768)` to `useState(false)` + `useEffect` to set on mount. Prevents hydration mismatch / sidebar flash on mobile.
- **C1:** Added 1.13 — mobile keyboard attributes (`enterKeyHint`, `autoCorrect`) cross-cutting all text inputs.
- **C2:** Added 3.3 — ContextMenu `touchend` fallback for click-outside dismissal.
- **C3:** Added 3.4 — ContextMenu viewport clamping so menu never renders off-screen on mobile.
- **C4:** Updated 2.14 — added `max-w-[calc(100vw-1rem)]` and `right-0` to GitBranchSelector dropdown to prevent overflow on narrow viewports.
- **C5:** Updated 2.5 — noted that `touch-target` is already present on GitPanel header buttons; implementation can skip if already applied.
- **C6:** Updated 1.6 — added `mobile-safe-bottom` to Sidebar footer wrapper as well as scroll area.
- **C7:** Updated 3.5 — moved `max-h-[60vh]` to inner content wrapper with `calc(60vh - 2.5rem)` so padding does not eat scrollable space.
- **C8:** Updated 3.9 — changed `max-h-[65vh]` to `max-h-[calc(65vh-4rem)]` on ExtensionUIModal inner content to account for header + safe area.
- **C9:** Added 4.4 — StatusBar stub note (returns `null`, non-functional; no mobile change needed but documented).
- **C10:** Added "Breakpoint Rationale" section documenting when to use `sm:` vs `md:`.
- **C11:** Fixed 1.10 — corrected ChatView empty-state line reference from ~270 to ~302.
