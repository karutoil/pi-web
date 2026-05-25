# Mobile Responsiveness Scout: Modals & Interaction Components

**Scope:** 9 components. **Mobile breakpoint:** `max-width: 767px` (per `styles.css` line 374).
**Existing mobile utilities:** `.touch-target` (44×44px min), `.touch-target-sm` (32×32px min), `.mobile-safe-top/bottom` (env vars).

---

## 1. `ContextMenu.tsx`

**Path:** `packages/client/src/components/ContextMenu.tsx` (all 134 lines)

### Current Layout
- Portal-rendered at fixed `(x, y)` coordinates. Positioned via `style={{ position: "fixed", left: pos.x, top: pos.y }}`.
- Desktop: right-click context menu at cursor.
- Mobile: long-press hook (`useLongPress`, delay=500ms) triggers same menu.

### Issues

| # | Issue | Location | Detail |
|---|-------|----------|--------|
| 1 | **No touch-action suppression** | Line 99 | Menu container has `touch-action: none` missing. Mobile touch drag could scroll behind the menu. |
| 2 | **No keyboard/virtual keyboard handling** | Line 56-72 | `mousedown`/`contextmenu` close handlers don't account for mobile. Tapping outside the menu area may not register properly with touch events. `mousedown` fires for touch but `contextmenu` doesn't fire on mobile. |
| 3 | **Hardcoded MENU_WIDTH/MENU_HEIGHT** | Lines 76-77 | `MENU_WIDTH = 200`, `MENU_HEIGHT = 160` used for off-screen calculation. Actual rendered width is `min-w-[160px]` — safe, but the height estimate assumes all 4 items. Dynamic content could overflow the `MENU_HEIGHT` estimate. |
| 4 | **Menu not viewport-aware on narrow screens** | Lines 78-81 | Uses `window.innerWidth/innerHeight` which is correct, but `safeX/safeY` clamping uses `Math.max(4, ...)`. On very narrow screens (e.g., 320px), the menu could still overflow right edge. The `min-w-[160px]` class (line 99) combined with a small screen = the menu takes 50% width. |
| 5 | **Min-width too wide for small phones** | Line 99 | `min-w-[160px]` means on 320px screens, menu = 50% width. Acceptable but no `sm:` responsive reduction. |
| 6 | **No `touch-action: none` on menu** | Line 99 | Missing `touch-none` class. User can drag to scroll while menu is open. |
| 7 | **Context menu items too small for touch** | Lines 110-119 | `px-3 py-1.5` on a button. Actual touch area ~40×24px. Below 44px minimum for WCAG AA. No `.touch-target` class applied. |
| 8 | **Shortcuts hidden on mobile** | Line 118 | `shortcut` text visible on mobile — wastes horizontal space on narrow screens. Should hide with `hidden sm:block` or similar. |

### Existing Mobile Handling
- ✅ `useLongPress` hook provides mobile trigger (lines 11-43).
- ✅ Portal rendering avoids scroll container issues.
- ✅ Position recalculation on mount (lines 82-87).

---

## 2. `ConfirmDialog.tsx`

**Path:** `packages/client/src/components/ConfirmDialog.tsx` (all 63 lines)

### Current Layout
- Portal-rendered, centered in viewport with `fixed inset-0 flex items-center justify-center`.
- `max-w-sm w-full` dialog box.
- Has `mobile-safe-bottom` class.

### Issues

| # | Issue | Location | Detail |
|---|-------|----------|--------|
| 1 | **Buttons too small for touch** | Lines 52-60 | `px-3 py-1.5` on buttons = ~48×24px. Height below 44px touch target minimum. No `.touch-target` class. |
| 2 | **No `overflow-y-auto` on dialog** | Line 47 | Dialog uses fixed `p-5` padding. If message text wraps extremely on narrow screens, it could be cut off. No scroll fallback. |
| 3 | **"This cannot be undone" always visible** | Lines 49-51 | Takes 1 line of vertical space on mobile. On small screens (iPhone SE 1st gen = 568px tall), this wastes precious space. Could be collapsible or hidden on very small screens. |
| 4 | **Hardcoded `mx-4` margins** | Line 47 | `w-full mx-4` = 8px total horizontal margin. On very small screens (320px), the dialog body is ~312px wide. Fine, but no further responsive adjustment. |
| 5 | **Backdrop close on touch** | Line 42 | `onClick={onCancel}` on backdrop. On mobile, the backdrop is a large tappable area that dismisses accidentally. Consider requiring a deliberate button press. |
| 6 | **No preventDefault on touchmove** | — | No `touch-action` suppression. User could accidentally drag the backdrop. |

### Existing Mobile Handling
- ✅ Portal rendering.
- ✅ `mobile-safe-bottom` class for notched phones.
- ✅ `max-w-sm w-full` scales to full width.
- ✅ `aria-modal="true"` for accessibility.

---

## 3. `ExtensionUIModal.tsx`

**Path:** `packages/client/src/components/ExtensionUIModal.tsx` (all 212 lines)

### Current Layout
- Two modes: notify toast (top-center) or dialog (centered).
- Dialog: portal-rendered, `max-w-md w-full`.
- Four input types: select, confirm, input, editor.

### Issues

| # | Issue | Location | Detail |
|---|-------|----------|--------|
| 1 | **Notify width constraint** | Line 151 | `min-w-[280px] max-w-lg` for notify. On 320px screens, min-w = 87.5% width. Acceptable. But `top-4` may conflict with status bar on notched phones despite `mobile-safe-top`. |
| 2 | **Select list touch targets too small** | Lines 65-72 | `px-3 py-2` on select buttons = ~48×32px. Height 32px — below 44px minimum. No `.touch-target` class. |
| 3 | **Confirm buttons small** | Lines 83-92 | `flex-1 py-2` buttons = height ~32px. Below 44px minimum. No `.touch-target` class. |
| 4 | **Input/button small** | Lines 98-109 | Input `px-3 py-2` and buttons `py-2` — same height issue. |
| 5 | **Textarea rows hardcoded** | Line 118 | `rows={8}` on a small phone. 8 rows of text with `text-sm` font ≈ ~256px height, which could exceed viewport height when combined with header + buttons. Should use `min-h`/`max-h` with resize constraints. |
| 6 | **Dialog header close button too small** | Line 205 | Close button is `<Icon name="close" size={16}>` — only 16×16px target. No padding, no `.touch-target` class. On mobile this is ~16px — far below 44px minimum. |
| 7 | **No `overflow-y-auto` on body** | Line 203 | Dialog body has no scroll. If message + input + buttons exceed viewport, content gets clipped. |
| 8 | **No `min-h-[touchbar]` on modal container** | Line 201 | Dialog container `max-w-md` but no min-height. On very tall phones this is fine, but on short phones with status bars the content could be pushed below safe areas. |
| 9 | **Keyboard open behavior** | Lines 60-63 | Auto-focus input/textarea on mobile will trigger virtual keyboard, which may push the modal off-screen. No scroll-to-visible logic. |
| 10 | **Editor mode has no resize handle** | Line 123 | `resize-none` prevents users from manually expanding the textarea on mobile to see more content. |

### Existing Mobile Handling
- ✅ `mobile-safe-bottom` on dialog (line 202).
- ✅ `mobile-safe-top` on notify (line 151).
- ✅ Portal rendering.
- ✅ `max-w-md w-full` responsive width.
- ⚠️ Select list has `max-h-60 overflow-y-auto` (line 64) — good for overflow, but targets too small.

---

## 4. `ExtensionErrorToast.tsx`

**Path:** `packages/client/src/components/ExtensionErrorToast.tsx` (all 33 lines)

### Current Layout
- Fixed position bottom-right, stacked up to 3 errors.
- `fixed bottom-4 right-4 z-40 flex flex-col gap-2 max-w-sm`.

### Issues

| # | Issue | Location | Detail |
|---|-------|----------|--------|
| 1 | **Hardcoded `bottom-4 right-4` conflicts with safe area** | Line 18 | No `mobile-safe-bottom` class. On notched phones (iPhone X+), bottom-safe-area inset (~34px) is not accounted for. Toast could be obscured by home indicator. |
| 2 | **Hardcoded `right-4`** | Line 18 | On 320px screens, right margin = 16px = 5% of width. Acceptable but no responsive adjustment. |
| 3 | **Dismiss button too small** | Line 27 | Close button is `✕` with `text-xs` and no padding — ~20×20px target. Below 44px minimum. |
| 4 | **Text truncation only via `truncate`** | Lines 23-27 | Single-line truncation. On narrow screens, long error messages are fully truncated with no expand option. `title` attribute is hover-only. |
| 5 | **Stack overflow on many errors** | Line 18 | Only shows last 3 (`slice(-3)`). On mobile, 3 stacked toasts at `gap-2` with `p-3` each ≈ ~280px vertical space. Could cover significant content area. |
| 6 | **No animation pause on interaction** | — | `animate-fade-in-up` plays on mount. No `pointerdown`/`touchstart` handler to pause/cancel animation if user is trying to interact. |
| 7 | **No swipe-to-dismiss** | — | Mobile UX pattern for toasts is usually swipe to dismiss. None implemented. |

### Existing Mobile Handling
- ⚠️ None for this component. No safe-area classes, no touch targets, no responsive positioning.

---

## 5. `AddProjectExplorer.tsx`

**Path:** `packages/client/src/components/AddProjectExplorer.tsx` (all 264 lines)

### Current Layout
- Full-screen overlay portal (`fixed inset-0`), centered flex container.
- `max-w-xl w-full` with `maxHeight: 80vh` (inline style).
- Structure: header → path bar → breadcrumb → file list → footer actions.

### Issues

| # | Issue | Location | Detail |
|---|-------|----------|--------|
| 1 | **No safe-area classes** | — | Full-screen modal. No `mobile-safe-top` on header or `mobile-safe-bottom` on footer. Content could be obscured by notches/home indicators. |
| 2 | **File list items touch targets** | Lines 210-250 | File row: `px-3 py-3 md:py-2`. On mobile, `py-3` = ~32px height. Border-left indicator + icon + text layout. Actual touch area ~48px height (good), but the double-click handler for `onDoubleClick` (line 218) won't work on mobile. |
| 3 | **Double-click semantics broken on mobile** | Line 218 | `onDoubleClick={() => handleEnterDirectory(item)}` — double-tap on mobile selects, not navigates. Need long-press or a separate "enter" tap. |
| 4 | **Path input field small** | Lines 146-156 | `px-2.5 py-1.5` on input = ~48×28px. Height too small. No `inputmode` or `enterkeyhint` attributes for mobile keyboard optimization. |
| 5 | **Submit button small** | Lines 255-261 | `flex-1 py-2` = ~48×32px. Below 44px minimum. |
| 6 | **Cancel button small** | Lines 262-265 | `px-4 py-2` = ~48×32px. Below 44px minimum. |
| 7 | **Header close button small** | Lines 119-122 | `w-7 h-7` = 28×28px. Below 44px minimum. No `.touch-target` class. |
| 8 | **Breadcrumb icon small** | Lines 174-178 | Chevron icon `size={10}` = 10×10px. Text "..." also small. Touch target ≈ 20px wide. |
| 9 | **No virtual keyboard overlay handling** | — | When path input is focused on mobile, the virtual keyboard covers the bottom portion of the modal including the submit/cancel buttons. No scroll-to-top or content reflow on keyboard open. |
| 10 | **Max-width not responsive** | Line 108 | `max-w-xl` = 36rem (576px). On small phones, this fills the width. Acceptable, but the internal layout doesn't reflow — file list, path bar, footer all maintain same internal padding (`px-5`). |
| 11 | **Internal padding too large for mobile** | Throughout | `px-5` padding (lines 105, 113, 135, 163) = 20px on each side. On a 360px-wide phone, that's ~11% wasted. Could use `px-3 sm:px-5`. |
| 12 | **No `touch-action` suppression** | Line 107 | Modal overlay doesn't prevent scrolling on the content behind it. |

### Existing Mobile Handling
- ✅ `flex flex-col` layout with `flex-1 min-h-0` on file list enables scroll.
- ✅ `overflow-y-auto custom-scrollbar` on list (line 171).
- ✅ Keyboard navigation with arrow keys (lines 127-143).
- ✅ `maxHeight: 80vh` prevents full-screen overflow.

---

## 6. `ModelSelector.tsx`

**Path:** `packages/client/src/components/ModelSelector.tsx` (all 63 lines)

### Current Layout
- Full-screen overlay `fixed inset-0 flex items-start justify-center pt-[15vh]`.
- `max-w-md w-full` dialog.
- Search input → filtered list → footer hints.

### Issues

| # | Issue | Location | Detail |
|---|-------|----------|--------|
| 1 | **No safe-area classes** | — | No `mobile-safe-top` or `mobile-safe-bottom`. Hardcoded `pt-[15vh]` doesn't account for status bar. |
| 2 | **List item touch targets** | Lines 48-56 | `px-4 py-2.5` on buttons ≈ 48px height. Acceptable (≥ 44px). But no explicit `.touch-target` class. |
| 3 | **Search input padding small** | Lines 41-46 | `px-3 py-2` = ~48×32px. Height below 44px minimum. No `inputmode="search"` or `autocorrect="off"`. |
| 4 | **Footer hint text** | Lines 58-60 | Keyboard shortcuts hint (`Tab: cycle`, `Enter: select`) is keyboard-only info. Wastes vertical space on mobile where keyboard is virtual. Could be hidden on mobile with `hidden sm:block`. |
| 5 | **No keyboard optimization attributes** | Lines 41-46 | Input lacks `inputMode`, `autoComplete`, `autoCorrect`. On mobile, this means the wrong keyboard appears (alphabetic instead of search/numeric). |
| 6 | **No `overflow-y-auto` on list** | Line 47 | `max-h-64` provides scrolling, which is good. But combined with `pt-[15vh]` top offset, the list may not be fully visible on short phones. |
| 7 | **Close mechanism missing** | — | No explicit close button. Relies on backdrop tap to close. No `Esc` handler on mobile (virtual keyboard dismisses modal). |
| 8 | **Hardcoded `pt-[15vh]`** | Line 37 | On phones with large status bars (~80px), 15vh ≈ 120px on a 800px phone. OK, but combined with the modal content + keyboard could push everything off-screen. |

### Existing Mobile Handling
- ✅ `max-w-md w-full` scales to full width.
- ✅ `max-h-64 overflow-y-auto` on list prevents overflow.
- ✅ Backdrop dismiss (though unreliable on mobile).

---

## 7. `SessionActions.tsx`

**Path:** `packages/client/src/components/SessionActions.tsx` (all 35 lines)

### Current Layout
- Full-screen overlay `fixed inset-0 flex items-start justify-center pt-[20vh]`.
- `max-w-xs w-full` (320px max).
- Title header → 6 action buttons → footer hint.

### Issues

| # | Issue | Location | Detail |
|---|-------|----------|--------|
| 1 | **No safe-area classes** | — | No `mobile-safe-top` or `mobile-safe-bottom`. |
| 2 | **Action buttons touch targets** | Lines 27-30 | `px-4 py-2.5` ≈ 48px height. Meets minimum, but no `.touch-target` class. Icon size is 14×14px — the icon itself is small, but the button area is adequate. |
| 3 | **Footer hint text** | Line 32 | "Esc to close" is keyboard-only info. Wastes space on mobile. Should be `hidden sm:block`. |
| 4 | **No keyboard optimization** | — | No virtual keyboard interaction, so no `inputMode` needed. But no `inputMode` also means no haptic feedback indicators. |
| 5 | **Close mechanism missing** | — | Only backdrop tap. No X button visible on mobile. On phones with large headers, users may not see they can tap outside to close. |
| 6 | **Hardcoded `pt-[20vh]`** | Line 22 | 20vh on a 600px-tall phone = 120px top offset. Combined with ~40px title + 6×48px actions ≈ 376px total. Fine, but no responsive adjustment. |

### Existing Mobile Handling
- ✅ `max-w-xs` fits well on mobile.
- ✅ Backdrop dismiss.
- ✅ Icon + text layout is readable at small sizes.

---

## 8. `CommandCompleter.tsx`

**Path:** `packages/client/src/components/CommandCompleter.tsx` (all 38 lines)

### Current Layout
- Absolutely positioned below ChatInput: `absolute bottom-full left-0 mb-2`.
- `w-[calc(100vw-2rem)] md:w-80`.
- `max-h-64 overflow-y-auto`.

### Issues

| # | Issue | Location | Detail |
|---|-------|----------|--------|
| 1 | **Positioned relative to ChatInput** | Line 24 | On mobile, when keyboard opens, ChatInput may move up but the completer's `absolute bottom-full` may not reposition. Could end up off-screen or behind keyboard. |
| 2 | **Width on mobile** | Line 24 | `w-[calc(100vw-2rem)]` = full width minus 16px. Good for mobile. No `md:w-80` needed on mobile — this is already handled. |
| 3 | **No touch targets for items** | Lines 29-37 | `px-3 py-2` ≈ 48px height. Acceptable but no `.touch-target` class. |
| 4 | **Source emoji icons small** | Line 31 | Emoji is text, not a button. Fine. |
| 5 | **Header text small** | Line 27 | `text-[0.65rem]` for "Commands" label. Fine for info text. |
| 6 | **No keyboard awareness** | — | On mobile, the virtual keyboard covering the ChatInput area also covers the completer popup. No `IntersectionObserver` or scroll-based repositioning. |
| 7 | **z-index may conflict** | Line 24 | `z-50` — check against other components' z-indexes. ConfirmDialog is `z-60`, ExtensionUIModal is `z-70`. Completer at `z-50` could be hidden behind modals. |
| 8 | **No select on touch** | Lines 29-37 | Click handler `onClick={() => onSelect(c.name)}`. On mobile, this works. But no `touch-action` handling. |

### Existing Mobile Handling
- ✅ `w-[calc(100vw-2rem)]` responsive width on mobile.
- ✅ `max-h-64 overflow-y-auto` prevents overflow.

---

## 9. `WidgetDisplay.tsx`

**Path:** `packages/client/src/components/WidgetDisplay.tsx` (all 22 lines)

### Current Layout
- Inline flex-col layout within the main chat view.
- `px-4 md:px-6` horizontal padding.

### Issues

| # | Issue | Location | Detail |
|---|-------|----------|--------|
| 1 | **Monospace text may overflow** | Lines 17-19 | `text-xs font-mono` with `whitespace-pre-wrap`. Long command output lines may still overflow container if not wrapped. `text-xs` = ~12px monospace. |
| 2 | **No scroll on overflow** | — | No `overflow-x-auto` or `overflow-y-auto` on the widget container. If a widget outputs many lines or very wide lines, it pushes the entire page layout. |
| 3 | **Horizontal padding responsive** | Line 15 | `px-4 md:px-6` — actually this is good, padding is less on mobile. |
| 4 | **No background contrast** | Line 17 | `bg-ink-950/60 backdrop-blur-sm border border-ink-800/50`. Semi-transparent bg may not provide enough contrast on certain wallpapers or themes. |

### Existing Mobile Handling
- ✅ `px-4 md:px-6` responsive padding.
- ✅ `whitespace-pre-wrap` wraps long lines.

---

## Summary of Critical Issues by Severity

### 🔴 Critical (break mobile UX)
1. **All modals lack safe-area classes** — Content obscured by notches/home indicators on iOS/Android. (All except ConfirmDialog, ExtensionUIModal, ChatInput which already have `mobile-safe-top/bottom`)
2. **AddProjectExplorer double-click navigation** — Double-tap selects on mobile, never enters directory. (Line 218)
3. **ExtensionErrorToast no safe area** — Toast hidden behind home indicator. (Line 18)
4. **CommandCompleter keyboard overlay** — Completer popup hidden behind virtual keyboard. (Line 24)
5. **ExtensionUIModal editor textarea** — `resize-none` + hardcoded `rows={8}` may exceed viewport on mobile. (Line 118)

### 🟡 High (major UX degradation)
6. **Touch targets < 44px across all components** — 8/9 components use buttons/pads < 44px height. `ContextMenu`, `ConfirmDialog`, `ExtensionUIModal`, `AddProjectExplorer`, `ModelSelector`, `ExtensionErrorToast`, `SessionActions` all affected.
7. **Close buttons < 28px** — Modal close buttons are 16×16px or 28×28px. Far below touch minimum. (ContextMenu 16px, ExtensionUIModal 16px, AddProjectExplorer 28×28px)
8. **No `touch-action: none`** — User can accidentally scroll/drag behind modals and menus.
9. **No virtual keyboard optimization** — Inputs lack `inputMode`, `enterkeyhint`, `autocorrect`. Wrong keyboards appear.

### 🟢 Medium (should fix)
10. **Keyboard-only hint text visible on mobile** — `SessionActions`, `ModelSelector` show "Esc/Esc to close" — wastes space.
11. **Modal dialogs not scrollable** — `ConfirmDialog` and `ExtensionUIModal` body has no `overflow-y-auto`. Long content clips.
12. **WidgetDisplay no horizontal scroll** — Wide terminal output may overflow page.

---

## Cross-Component Patterns Missing

| Pattern | Status | Where |
|---------|--------|-------|
| `.touch-target` on interactive elements | ❌ Mostly missing | ContextMenu, ConfirmDialog, ExtensionUIModal, AddProjectExplorer, ModelSelector, ExtensionErrorToast, SessionActions |
| `.mobile-safe-top` / `.mobile-safe-bottom` | ⚠️ Partial | Only in ConfirmDialog, ExtensionUIModal, ChatInput. Missing in: ContextMenu, ExtensionErrorToast, AddProjectExplorer, ModelSelector, SessionActions, CommandCompleter, WidgetDisplay |
| `inputMode`/`enterKeyHint` on inputs | ❌ Missing | All text inputs across all components |
| `touch-action` suppression | ❌ Missing | All overlays, menus, modals |
| Swipe dismiss for toasts | ❌ Missing | ExtensionErrorToast |
| Responsive `padding` adjustment | ⚠️ Partial | WidgetDisplay has `px-4 md:px-6`. AddProjectExplorer should use `px-3 sm:px-5`. |
