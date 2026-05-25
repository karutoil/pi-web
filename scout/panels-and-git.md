# Panels & Git Components — Mobile Responsiveness Audit

**Breakpoint:** `768px` via `useIsMobile` hook (`packages/client/src/hooks/useIsMobile.ts`).

---

## 1. TerminalPanel.tsx

**File:** `packages/client/src/components/TerminalPanel.tsx`

### Layout approach
- Desktop: fixed-height bottom panel (`height: 240px` initial, resizable 120–70% viewport via drag).
- Mobile: fixed `bottom-0` bottom-sheet with snap heights (30%, 50%, 70% viewport).

### Issues

| # | Issue | Location | Severity |
|---|-------|----------|----------|
| 1 | **Hardcoded px height (240px)** on desktop; no responsive fallback | Line 198: `useState(240)` | Medium |
| 2 | **Resize drag only uses mouse events** — touch-to-resize desktop panel absent | Lines 224–245: `handleResizeMouseDown` uses `MouseEvent` only | Medium |
| 3 | **TerminalInstance padding is hardcoded px** | Line 176: `style={{ padding: "4px 4px 0" }}` | Low |
| 4 | **Tab close button uses sm:opacity** — mobile has hover-based opacity via `group-hover` but no mobile fallback for tap-to-reveal close | Lines 300–301: `opacity-0 group-hover:opacity-100 sm:opacity-40 sm:group-hover:opacity-100` | Low |
| 5 | **Tab rename input has `w-20`** fixed width — may overflow on narrow screens with long tab names | Line 309: `w-20` | Low |
| 6 | **Terminal tab bar uses `truncate max-w-[100px]`** for tab names — names get cut off, especially on mobile bottom-sheet | Line 306: `max-w-[100px]` | Medium |
| 7 | **No touch-action CSS on terminal content area** — could block scrolling of parent page during terminal interaction | Missing | Low |
| 8 | **Snap points too coarse** — `0.08` threshold for snapping; on mobile the drag delta calculation uses `window.innerHeight` which may be unreliable with mobile browser chrome (address bar) | Lines 214–226: snap calculation | Low |
| 9 | **Mobile drag handler uses `touch-none`** to prevent browser touch gestures, but no `touch-manipulation` for performance on Chrome for Android | Line 238: `touch-none` | Low |

### Existing mobile handling
- ✅ Bottom-sheet with backdrop overlay (line 249–251)
- ✅ Touch drag handlers (`handleMobileTouchStart/Move/End`) (lines 204–226)
- ✅ Responsive class: `fixed bottom-0 left-0 right-0 z-40 border-t-0 rounded-t-xl` (line 256–258)
- ✅ `snap` heights use `vh` units (line 261)

---

## 2. GitPanel.tsx

**File:** `packages/client/src/components/GitPanel.tsx`

### Layout approach
- Desktop: right-side panel, fixed width (`340px` initial, resizable 260–600px via left-edge drag).
- Mobile: `fixed inset-0` fullscreen overlay (`z-index: 45`).

### Issues

| # | Issue | Location | Severity |
|---|-------|----------|----------|
| 1 | **Hardcoded initial width 340px** — no responsive default | Line 157: `useState(340)` | Medium |
| 2 | **Resize handles only mouse events** — no touch resize for desktop panel | Lines 181–195: `handleResizeMouseDown` uses only `MouseEvent` | Medium |
| 3 | **Header buttons: `md:p-1` vs `p-1.5`** — padding gap is inconsistent; mobile `p-1.5` may be too small for finger taps | Lines 290–295: multiple buttons | Medium |
| 4 | **No `min-h-[44px]` or `min-h-[48px]` touch targets** — buttons use `p-1.5` (approx 15px padding) with `size={11-12}` icons — total ~30px, below Apple HIG 44px minimum | Lines 290–295 | High |
| 5 | **View tabs lack touch-friendly sizing** — `py-2` with `text-xs` content, but no min-height constraint | Lines 303–312 | Medium |
| 6 | **Multi-select bar: buttons are tiny** (`px-2 py-0.5 text-[0.65rem]`) — no mobile size override | Lines 320–325 | High |
| 7 | **Commit textarea has no mobile sizing** — `text-xs` with 2 rows, may feel cramped on phone | Line 374–379 | Medium |
| 8 | **Commit shortcut hint `hidden md:inline`** — hides `⌘↵` on mobile (good), but no replacement hint for mobile (e.g., tap to commit) | Line 396 | Low |
| 9 | **Changes list: `hover:bg-ink-900/30` on file rows** — hover state doesn't translate to touch; uses `hovered` state via `onMouseEnter` but mobile tap fires click not hover reliably | Lines 646–647 | Medium |
| 10 | **File actions: `hovered || isMobile`** — on mobile all actions are always visible (no tap-to-reveal), cluttering the UI with too many buttons on narrow screens | Line 649: `const showActions = hovered || isMobile` | High |
| 11 | **File path truncation: `flex-1` without `min-w-0`** on parent — paths may overflow the panel width | Line 672 | Medium |
| 12 | **No safe-area-inset for notched phones** — panel extends full width on mobile without `env(safe-area-inset-*)` | Line 173–175 | Medium |
| 13 | **Blame and Diff views are full-height sub-panels inside GitPanel** — on mobile (which is already fullscreen), they have no additional viewport management, effectively double-fullscreen | Lines 359–377 | Medium |
| 14 | **`ConflictBanner` buttons are extremely small** (`text-[0.65rem]`, `px-2 py-1`) — not touch-friendly | Lines 114–121 | High |

### Existing mobile handling
- ✅ Fullscreen overlay mode on mobile (line 173–175)
- ✅ Resize handle hidden on mobile (line 180)
- ✅ File row actions always visible on mobile (line 649)

---

## 3. GitLog.tsx

**File:** `packages/client/src/components/GitLog.tsx`

### Layout approach
- Self-contained scrollable component inside GitPanel's content area.
- No `useIsMobile` import — **zero mobile awareness**.

### Issues

| # | Issue | Location | Severity |
|---|-------|----------|----------|
| 1 | **No `useIsMobile` hook used** — no responsive behavior at all | Entire file | Medium |
| 2 | **Search bar: `flex-1` with `text-xs` — input may be too small for mobile finger typing** | Line 233–239 | Medium |
| 3 | **Commit rows: no touch-specific sizing** — `py-2` but content density is high | Line 172–176 | Medium |
| 4 | **`useLongPress` hook** — likely intended for mobile context-menu; verify it's implemented | Line 171 | Medium |
| 5 | **Context menu uses absolute page coords** (`ctxMenu.x`, `ctxMenu.y`) — on mobile this is triggered by long-press but menu may render off-screen at page edges | Lines 281–284 | High |
| 6 | **`CommitDiffViewer` has no mobile-specific rendering** — same as desktop, may overflow on narrow screens | Lines 87–137 | Medium |
| 7 | **No `safe-area-inset` handling** | Entire file | Low |

### Existing mobile handling
- ❌ None detected

---

## 4. GitBranchSelector.tsx

**File:** `packages/client/src/components/GitBranchSelector.tsx`

### Layout approach
- Inline dropdown triggered by a button in GitPanel header.
- No `useIsMobile` import — **zero mobile awareness**.

### Issues

| # | Issue | Location | Severity |
|---|-------|----------|----------|
| 1 | **No `useIsMobile` hook** — dropdown has no mobile adaptation | Entire file | Medium |
| 2 | **Dropdown positioned `absolute left-0 top-full`** — on mobile, if branch name is long and button is right-aligned, dropdown may overflow right edge | Lines 138–140 | High |
| 3 | **Hardcoded `min-w-[200px] md:min-w-[240px] max-w-[320px]`** — on phones < 320px wide, dropdown overflows | Line 140 | High |
| 4 | **Branch list `max-h-48` (192px)** — fine, but scroll may be sticky/unsmooth on iOS Safari without `-webkit-overflow-scrolling: touch` | Lines 158, 174 | Low |
| 5 | **No `min-h-[44px]` touch targets for branch items** — `py-1.5` (~24px) is below 44px HIG | Lines 153–167 | High |
| 6 | **Tag items use `py-1` (~16px)** — even smaller touch targets | Line 180 | High |
| 7 | **Create branch input: `py-1` text input — small for mobile keyboard** | Lines 146–153 | Medium |
| 8 | **Click-outside to dismiss uses `mousedown` event** — not reliable on touch devices; may need `touchend` fallback | Lines 93–101 | Medium |

### Existing mobile handling
- ❌ None detected

---

## 5. GitBlame.tsx

**File:** `packages/client/src/components/GitBlame.tsx`

### Layout approach
- Full-height content panel inside GitPanel.
- Uses `useIsMobile` — has mobile-specific rendering.

### Issues

| # | Issue | Location | Severity |
|---|-------|----------|----------|
| 1 | **Hardcoded `w-[120px]` for blame metadata column** — only rendered on desktop (good), but no responsive fallback check | Line 109 | Low |
| 2 | **Mobile column: `text-[0.6rem]` and `text-[0.55rem]`** — extremely small text, potentially unreadable on small screens | Line 118–119 | High |
| 3 | **Line number column: `w-8`** — fixed width, not responsive | Line 125 | Low |
| 4 | **Line content: `text-[0.7rem]`** — very small font size for body content on mobile | Line 130 | High |
| 5 | **`whitespace-pre-wrap break-words`** — long lines may create extremely wide content blocks on mobile | Line 130 | Medium |
| 6 | **Back button uses small `px-2.5 py-1`** — below 44px touch target HIG | Line 95 | Medium |
| 7 | **No horizontal scrolling support** — if blame content overflows, user can't see the end of long lines | Line 111 | Medium |

### Existing mobile handling
- ✅ Hides blame metadata column on mobile (line 109)
- ✅ Compact inline metadata on mobile (lines 118–122)

---

## 6. GitStash.tsx

**File:** `packages/client/src/components/GitStash.tsx`

### Layout approach
- Collapsible section at bottom of GitPanel.
- Uses `useIsMobile` — has partial mobile awareness.

### Issues

| # | Issue | Location | Severity |
|---|-------|----------|----------|
| 1 | **Stash action buttons always visible on mobile** (`showActions = hovered || acting || isMobile`) — 3 small buttons inline on mobile cause horizontal overflow | Line 228 | High |
| 2 | **Stash action buttons: `px-2 py-1` with `text-[0.6rem]`** — tiny touch targets, ~40px wide each | Lines 236–246 | High |
| 3 | **`md:px-1.5 md:py-0.5` override makes buttons even smaller on desktop, but mobile stays same small size** | Lines 236–246 | Medium |
| 4 | **Stash message input: `py-1` — small text input for mobile** | Line 117 | Medium |
| 5 | **No horizontal overflow protection on stash row content** — long messages may overflow | Line 212 | Medium |
| 6 | **`min-h-[28px] md:min-h-0`** — mobile gets 28px min-height but still too small for reliable touch (should be 44px) | Lines 236–246 | High |

### Existing mobile handling
- ✅ Actions always visible on mobile (line 228)

---

## 7. StatusBar.tsx

**File:** `packages/client/src/components/StatusBar.tsx`

### Issues

| # | Issue | Location | Severity |
|---|-------|----------|----------|
| 1 | **Components return `null`** — entirely non-functional stub | Lines 11–12 | N/A (not rendering) |
| 2 | **No mobile-specific implementation** — just stubs | Entire file | N/A |

### Existing mobile handling
- ❌ Components are stubs — no implementation

---

## Cross-Cutting Issues

### Shared
| # | Issue | Affected Files | Severity |
|---|-------|---------------|----------|
| 1 | **No `safe-area-inset` handling anywhere** — notched phones (iPhone X+) have content under the notch or home indicator | All panels | Medium |
| 2 | **No `touch-action: manipulation`** on interactive elements — may cause 300ms tap delay on older Chrome for Android | All panels | Medium |
| 3 | **Custom scrollbar classes** (`custom-scrollbar`) — custom scrollbar may not work on mobile or may have touch issues | All panels | Low |
| 4 | **Context menu system** (`ContextMenuPortal`, `ContextMenuItem`, `useLongPress`) — needs mobile gesture support verification; not all files import this system | GitLog, GitBlame | Medium |
| 5 | **Font sizes at `text-[0.6rem]` through `text-[0.65rem]`** — pervasive sub-8px text, essentially unreadable on mobile | GitLog, GitBranchSelector, GitStash, GitBlame | High |
| 6 | **No viewport meta tag check** — assumes 1x devicePixelRatio; on high-DPI phones, `vh` units and fixed widths may behave unexpectedly | All panels | Low |

### Layout-level (ChatView)
| # | Issue | Location | Severity |
|---|-------|----------|----------|
| 1 | **ChatView uses `flex` for chat column + GitPanel** — on mobile both are full-height, but GitPanel goes fullscreen (`fixed inset-0`) so chat is hidden; need to verify this doesn't cause layout shifts | ChatView.tsx lines 221–223 | Medium |
| 2 | **TerminalPanel is sibling to ChatView content** — on mobile it overlays bottom; need to verify z-ordering doesn't block chat input | ChatView.tsx lines 354–358 | Medium |
| 3 | **Chat messages use `max-w-3xl`** — good for desktop, but on mobile `max-w-3xl` becomes screen width; need to verify padding doesn't cause horizontal overflow | ChatView.tsx line 227 | Low |

---

## Summary

### Critical (fix before mobile launch)
1. **Touch target sizes** — `text-[0.6rem]` buttons with ~28–40px dimensions across GitLog, GitStash, GitBranchSelector. Need `min-h-[44px]` + scaled text.
2. **Unreadable font sizes** — `0.6rem`–`0.7rem` text in GitBlame, GitStash action buttons. Use responsive breakpoints (e.g., `text-[0.65rem] sm:text-xs`).
3. **GitLog, GitBranchSelector** — zero mobile handling. Add `useIsMobile` and responsive layouts.

### Important
4. **GitPanel file row actions clutter on mobile** — showing all 5+ action buttons on a narrow row. Use swipe-to-action or tap-to-reveal.
5. **Dropdown overflow** — GitBranchSelector dropdown may overflow right edge on narrow screens.
6. **No safe-area-inset** on any panel — notch/home indicator overlap on modern phones.
7. **Status bar is a stub** — needs implementation or removal.

### Low
8. **Custom scrollbar behavior** on mobile browsers.
9. **300ms tap delay** — add `touch-action: manipulation`.
10. **Resize handles only mouse** — add touch resize for desktop panels.
