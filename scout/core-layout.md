# Core Layout — Mobile Responsiveness Scout Report

## Summary

The codebase has **partial mobile support**. Basic mobile patterns exist (sidebar overlay, useIsMobile hook, touch-target classes), but significant issues remain: missing responsive treatment on chat area widths, overflow-prone panels (Terminal, Git), hardcoded sizes, and no responsive breakpoints beyond the 768px toggle.

---

## 1. `useIsMobile` Hook
**File:** `packages/client/src/hooks/useIsMobile.ts` (lines 1–14)

- **Breakpoint:** 768px (`max-width: 767px`). Matches `@media (max-width: 767px)` in `styles.css`.
- **Approach:** `window.matchMedia` listener. No SSR/fallback initial value — `useState(false)` defaults to desktop on first render, then flips on mount. Fine for SPA.
- **Usage count:** 10+ components import this. Used inconsistently.
- **Issue:** No mobile breakpoint parameterization exposed beyond default. Components with different mobile needs hardcode their own logic.

---

## 2. `App.tsx`
**File:** `packages/client/src/App.tsx`

### Layout
- **Root:** `<div className="flex h-screen overflow-hidden bg-ink-950">` — full-viewport flex. Fine.
- **Sidebar state:** `showSidebar` toggled via `isMobile` checks. On mobile, sidebar is **overlay** (not push). On desktop, sidebar is **inline** (w-64).
- **Main content:** `<main className="flex-1 flex flex-col min-w-0">` — uses `min-w-0` to prevent flex overflow. Good.

### Mobile handling
- **Line 25:** `const isMobile = useIsMobile()`
- **Line 32:** `showSidebar: useState(window.innerWidth >= 768)` — SSR mismatch risk (hydration mismatch if server renders `true` but client `false` on mobile).
- **Lines 101, 114, 126, 145:** `handleSelectProject`, `handleSelectSession`, `handleNewSession`, `handleBack` — auto-collapse sidebar on mobile. Good pattern.
- **Lines 303–340:** Mobile sidebar overlay + backdrop. Works.
- **Line 352:** SessionWelcome sub-component uses `useIsMobile` to show "Tap ☰" hint on mobile. Good.

### Issues
1. **Hydration mismatch:** `useState(window.innerWidth >= 768)` — server sees `true`, mobile client gets `false`. Causes flash. **Fix:** use `useIsMobile()` for initial state, or defer to effect.
2. **No responsive width constraints on `<main>`:** On large desktops, the main area has no max-width — content stretches to full width. The `ChatView` handles this internally (max-w-3xl), but nothing constrains the main container itself.

---

## 3. `Sidebar.tsx`
**File:** `packages/client/src/components/Sidebar.tsx`

### Layout
- **Desktop:** `w-64` (256px fixed width). No responsive variation.
- **Mobile (line 193):** `fixed inset-y-0 left-0 z-30 w-[85vw] max-w-[288px]` — overlay panel. Uses `animate-fade-in-up`.
- **Scrollable area:** `<div className="flex-1 overflow-y-auto custom-scrollbar px-2">` — standard scrollable container.

### Mobile handling
- Receives `isMobile` prop from App.tsx (line 193).
- Toggle button visible on mobile (when sidebar hidden) — in the header.

### Issues
1. **No min-width for sidebar content on small screens:** 85vw = ~305px at 360px width (iPhone SE). Content fits, but font sizes use fixed values (`text-[0.65rem]`, `text-[0.8rem]`) which are already tiny.
2. **Search input in SessionList** (line ~450): `text-[0.68rem]` — nearly unreadable on any screen. No responsive sizing.
3. **Context menu delete button** (ProjectList line ~435): `md:opacity-0` — hidden on mobile, but long-press fallback exists. Good, but no visible mobile alternative for quick delete access.
4. **Session items use `text-[0.8rem]`** for names — tiny. On 320px screens, two-line names wrap awkwardly within the 85vw sidebar.
5. **No `safe-area-inset` padding** on sidebar — bottom footer content may be hidden behind home indicator on iPhones.

---

## 4. `ChatView.tsx`
**File:** `packages/client/src/components/ChatView.tsx`

### Layout
- **Root:** `<div className="flex-1 flex flex-col min-h-0 relative">` — flex fill. Good.
- **Content scroll area** (line ~241): `className="flex-1 overflow-y-auto custom-scrollbar px-3 md:px-5 pt-6 pb-4"`
- **Message container** (line ~245): `<div className="max-w-3xl mx-auto space-y-4 md:space-y-5">` — **only responsive change**: 4 → 5 spacing on `md+`.
- **Empty state** (line ~270): `py-20` — fixed padding, no responsive adjustment.

### Mobile handling
- **No `useIsMobile` import or usage.** Completely unaware of mobile state.
- No responsive adjustments to scroll area, message width, or padding.

### Issues
1. **`max-w-3xl` (768px) on chat content** — on phones, this is 100% of the available width (minus sidebar). Fine. But no narrower target for tablet landscape (e.g., `md:max-w-2xl` at 768-1024). On tablet landscape, content stretches too wide for comfortable reading.
2. **`px-3 md:px-5`** — 12px padding on mobile is fine, but no further scaling for very small screens (<360px).
3. **`py-20` in empty state** — fixed. Should be `py-16 md:py-20`.
4. **TerminalPanel and GitPanel** are children with no responsive props — they don't know about mobile layout state.
5. **`space-y-4` (16px)** on mobile for messages — generous but ok. No responsive adjustment.
6. **No touch-area sizing** on chat-related buttons (fork, copy, compact).

---

## 5. `ChatHeader.tsx`
**File:** `packages/client/src/components/ChatHeader.tsx`

### Layout
- **Root:** `<div className="flex items-center gap-1.5 md:gap-2 px-3 md:px-4 py-2.5 border-b...">`
- **Session name input width:** `w-24 md:w-32 lg:w-48` — responsive. Good.
- **Session name max-width:** `max-w-[80px] md:max-w-[120px] lg:max-w-[200px]` — responsive. Good.
- **CWD display:** `hidden sm:inline` — hidden below 640px. Good.

### Mobile handling
- **Line 25:** `const isMobile = useIsMobile()` — used extensively.
- **Stats row:** `hidden md:flex` — hidden on mobile. Good.
- **Thinking level button:** `!isMobile` — hidden on mobile. **But** it IS rendered inside the model dropdown on mobile (line ~207). Good.
- **Model dropdown on mobile:** transforms to bottom sheet (`fixed bottom-0 left-0 right-0`). Good.
- **Mobile model backdrop** (line ~200): `fixed inset-0 z-39 bg-ink-950/50` — proper overlay.

### Issues
1. **Gap scaling:** `gap-1.5 md:gap-2` — minimal difference. On mobile, buttons are squished.
2. **Button text inside header** (`text-xs font-mono px-2 py-1`) — on mobile with many buttons visible (model, cycle, git toggle), they crowd each other. The `md:inline` on connection labels helps, but stats are hidden.
3. **No safe-area handling** on the header row — could overlap with status bar on notch phones.
4. **Model button truncation:** `max-w-[100px]` on mobile — model names longer than ~10 chars get truncated with no tooltip fallback (title attr exists but not accessible on touch).
5. **Git toggle button** always visible on mobile — combined with model, cycle, and session-action buttons, the header can overflow on very narrow screens.

---

## 6. `ChatInput.tsx`
**File:** `packages/client/src/components/ChatInput.tsx`

### Layout
- **Root:** `<div className="px-2 md:px-4 pb-2 md:pb-4 pt-2 flex justify-center mobile-safe-bottom">` — uses `mobile-safe-bottom` class (defined in styles.css for `@media (max-width: 767px)`). Good.
- **Container:** `max-w-3xl w-full` — matches ChatView.
- **Textarea:** `max-h-[200px]` — fixed. On mobile, 200px can overflow viewport when combined with status bar.
- **Pill text:** responsive — `hidden md:block` for desktop hint, `md:hidden` for mobile hint. Good.

### Mobile handling
- **No `useIsMobile` usage** — but `mobile-safe-bottom` class in parent div handles safe area.
- **Placeholder text** changes based on `isStreaming` state: "Steer..." vs "Ask PI...". Good.

### Issues
1. **`max-h-[200px]` on textarea** — fixed pixel value. On a 375px viewport with 44px safe-area bottom padding, input bar, and header, this can push content off-screen. Should be responsive: `max-h-[160px] md:max-h-[200px]`.
2. **Image preview height:** `h-12` (48px) — fixed. On narrow screens with image previews, they can overflow the input area.
3. **Command completer** — no responsive width handling. Could overflow on narrow viewports.
4. **Status row truncation:** `max-w-[45%]` and `max-w-[50%]` — fixed percentages may not work well if one status entry is long and the other is empty.
5. **Auto-retry indicator:** `max-w-32` on error message — could overflow on narrow phones. Should use `truncate` class more aggressively or add responsive max-width.

---

## 7. `MessageBubble.tsx`
**File:** `packages/client/src/components/MessageBubble.tsx`

### Layout
- **Root flex:** `flex justify-end` (user) / `flex gap-2 md:gap-3` (assistant) — responsive gap. Good.
- **Avatar:** `w-6 h-6 md:w-7 md:h-7` — responsive. Good.
- **Content max-width:** `max-w-[90%] md:max-w-[80%]` — responsive. Good.
- **User bubble:** `px-3 md:px-4 py-2.5` — responsive. Good.
- **Image blocks in user bubble:** `max-h-48` — fixed. Could be responsive.

### Mobile handling
- **Line 321:** `const isMobile = useIsMobile()` — used in `CombinedToolBubble` for args preview length.
- **Fork button:** `hidden md:block` — hidden on mobile. Long-press context menu is the fallback. Good.
- **Copy buttons on code blocks:** `opacity-60 md:opacity-0 md:group-hover:opacity-100` — always visible on mobile (no hover). Good.

### Issues
1. **`max-h-48` (192px) on user images** — fixed. On narrow screens with 2+ images in a row, they may overflow. Consider `max-h-32 md:max-h-48`.
2. **`prose prose-invert`** in markdown content — Tailwind prose may not be responsive enough for very small screens. No explicit `text-xs sm:text-sm` adjustments on prose elements.
3. **`pre` tag styling** in styles.css: `font-size: 0.8125rem` globally. The `@media (max-width: 767px)` block reduces to `0.75rem`. Good, but no `padding` adjustment — `padding: 1rem 1.25rem` on a narrow phone screen wastes space.
4. **Tool call arg preview:** `isMobile ? 40 : 80` chars — smart, but no truncation visible indicator (e.g., ellipsis).
5. **System bubbles:** fixed `px-4 py-1.5 text-xs` — fine, no issue.

---

## 8. `styles.css` — Global Responsive Rules
**File:** `packages/client/src/styles.css`

### Mobile media query (line ~248):
```css
@media (max-width: 767px) {
  pre { -webkit-overflow-scrolling: touch; font-size: 0.75rem; }
  .mobile-safe-bottom { padding-bottom: env(safe-area-inset-bottom, 0px); }
  .mobile-safe-top { padding-top: env(safe-area-inset-top, 0px); }
  .touch-target { min-width: 44px; min-height: 44px; ... }
  .touch-target-sm { min-width: 32px; min-height: 32px; ... }
  .mobile-show-actions .mobile-action { opacity: 1 !important; }
  .diff-side-by-side { display: none !important; }
  .diff-side-toggle { display: none !important; }
}
```

### Issues
1. **`pre` padding not reduced on mobile:** Global `pre` has `padding: 1rem 1.25rem` — not adjusted in the mobile breakpoint. On 320px screens, this eats ~32% of horizontal space.
2. **`code` font size not mobile-adjusted:** `font-size: 0.875em` in global styles. Not reduced in mobile breakpoint.
3. **`markdown-content` responsive:** No mobile-specific adjustments. Headings (`h1 1.4em`, `h2 1.2em`) may be too large relative to screen.
4. **`body::after` grain overlay:** `position: fixed; inset: 0; z-index: 9999` — this sits above everything including mobile modals/dropdowns. Should have `pointer-events: none` (it does) and possibly `z-index` below overlays. Currently fine since `z-9999` is above overlays that go up to `z-50` or `z-70`, but the grain itself is fine as it's non-interactive.
5. **No `@media` for foldable/large phones:** The single 767px breakpoint misses the 360-430px range where most issues occur. Consider `@media (max-width: 374px)` for iPhone SE / Galaxy Fold.
6. **`table-wrap` horizontal scroll:** `overflow-x: auto` is good, but `scrollbar-width: thin` may not show on all mobile browsers (iOS Safari sometimes ignores `scrollbar-width`).
7. **No landscape-specific handling:** No `@media (orientation: landscape)` rules. On mobile landscape, the sidebar + chat view split doesn't work well.

---

## 9. `TerminalPanel.tsx`
**File:** `packages/client/src/components/TerminalPanel.tsx` (556 lines)

### Mobile handling
- **Line 195:** `const isMobile = useIsMobile()` — used for bottom-sheet snap heights.
- Mobile: renders as **bottom sheet** with snap heights. Good pattern.

### Issues (inferred)
1. xterm.js font size hardcoded to `13px` (line 48 in TerminalInstance). No mobile scaling. Should be `11px` on phones.
2. xterm.js theme colors hardcoded. No adaptation to light/dark mode at all (though this may be intentional for terminal feel).
3. Terminal panel width/height constraints not responsive beyond the bottom-sheet mode.

---

## 10. `GitPanel.tsx`
**File:** `packages/client/src/components/GitPanel.tsx`

### Mobile handling
- **Line 148:** `const isMobile = useIsMobile()` — used for panel display.
- **Line 653:** Another `useIsMobile()` usage for specific component.

### Issues (inferred)
1. Panel renders as side panel alongside ChatView. On mobile, no bottom-sheet fallback mentioned — needs investigation of full file.
2. Git diff viewer inside panel uses fixed font sizes (`text-xs`, `text-[0.65rem]`).

---

## 11. `EmptyState.tsx`
**File:** `packages/client/src/components/EmptyState.tsx`

### Mobile handling
- Uses responsive classes: `p-4 md:p-8`, `text-2xl md:text-3xl`, `p-3 md:p-4`.
- Logo has `width="80" height="80"` — fixed SVG attributes. Should be `width="80" height="80" className="w-20 h-20 md:w-24 md:h-24"`.

### Issues
1. **Logo SVG attributes override CSS sizing:** `width="80" height="80"` on the `<img>` tag. The `className` may not resize it properly on small screens. Should use responsive Tailwind classes for sizing.

---

## 12. `SessionActions.tsx` (Modal)
**File:** `packages/client/src/components/SessionActions.tsx`

### Mobile handling
- Uses `pt-[20vh]` — **fixed** viewport-percentage. On mobile with status bars, this could position the modal incorrectly.
- No `max-height` or safe-area handling.

### Issues
1. **`pt-[20vh]`** — on mobile, the top safe area + status bar takes ~44-88px. 20vh positions the modal too low on phones. Should be `pt-[calc(20vh+env(safe-area-inset-top))]` or use a responsive value.
2. **`bg-black/60` backdrop** — uses Tailwind's `black` class. But the app uses `ink-950` as its dark color. Slight color inconsistency.
3. No landscape handling — modal always centered vertically.

---

## 13. `SessionWelcome` (in App.tsx)
**File:** `packages/client/src/App.tsx` (lines 340-385)

### Mobile handling
- `p-4 md:p-8` — good.
- `text-xl md:text-2xl` — good.
- Mobile hint: "Tap ☰ to browse sessions" — visible only on mobile. Good.

### Issues
1. No `safe-area` padding — could overlap with status bar on notched phones.

---

# Findings Summary

## Critical (block mobile usability)
| # | File | Line(s) | Issue |
|---|------|---------|-------|
| C1 | App.tsx | 32 | Hydration mismatch: `window.innerWidth` in useState |
| C2 | TerminalPanel.tsx | 48 | xterm font size hardcoded to 13px — unreadable on mobile |
| C3 | styles.css | (pre global) | No responsive `pre` padding — horizontal scroll area too small on phones |

## High (poor mobile experience)
| # | File | Line(s) | Issue |
|---|------|---------|-------|
| H1 | ChatView.tsx | 245 | No `useIsMobile` — completely mobile-blind |
| H2 | MessageBubble.tsx | (markdown-content) | Tailwind prose not responsive for tiny screens |
| H3 | ChatInput.tsx | textarea | `max-h-[200px]` fixed — can overflow on mobile |
| H4 | Sidebar.tsx | 193 | No safe-area-inset on sidebar — footer hidden on notched phones |
| H5 | SessionActions.tsx | (modal) | `pt-[20vh]` fixed — mispositioned on mobile with status bar |

## Medium (cosmetic/progressive degradation)
| # | File | Line(s) | Issue |
|---|------|---------|-------|
| M1 | ChatHeader.tsx | (header buttons) | Too many buttons crowd header on narrow screens |
| M2 | MessageBubble.tsx | User images | `max-h-48` fixed — images may overflow on narrow screens |
| M3 | Sidebar.tsx | Search input | `text-[0.68rem]` nearly unreadable |
| M4 | styles.css | (global) | No `@media (max-width: 374px)` for very small phones |
| M5 | EmptyState.tsx | Logo | SVG width/height attributes override CSS sizing |
| M6 | ChatView.tsx | Empty state | `py-20` fixed padding — no responsive adjustment |

## Low (nice-to-have)
| # | File | Line(s) | Issue |
|---|------|---------|-------|
| L1 | ChatView.tsx | (content) | No `md:max-w-2xl` for tablet landscape reading comfort |
| L2 | styles.css | (table-wrap) | iOS Safari may not honor `scrollbar-width` |
| L3 | ChatHeader.tsx | (model button) | No visible tooltip on touch for truncated model names |

## Key Patterns Observed
1. **Mobile breakpoint is 768px** (`max-width: 767px`) — consistent across `useIsMobile`, `styles.css`, and Tailwind `md:` breakpoint.
2. **Sidebar overlay pattern on mobile** — works well (backdrop + slide-in). Sidebar width is `w-[85vw] max-w-[288px]`.
3. **`mobile-safe-bottom` class** exists for bottom safe area, but not applied everywhere (missing from ChatHeader, Sidebar footer, SessionWelcome).
4. **Touch target classes** (`touch-target` = 44px, `touch-target-sm` = 32px) exist but are not consistently applied.
5. **No landscape media query** — mobile landscape mode not handled at all.
6. **No very-small-screen breakpoint** (<375px) — iPhone SE, Galaxy Fold, etc. not considered.
