## Mobile Responsiveness Implementation Review

**Date:** 2026-05-24  
**Scope:** All changed files in `packages/client/src/` per progress.md  
**Build status:** Passes (`tsc -b && vite build` clean)

---

### Correct

- **useIsMobile hook** (`hooks/useIsMobile.ts:7`): SSR-safe `typeof window` guard, 768px breakpoint, matches CSS `@media (max-width: 767px)`.
- **Sidebar overlay** (`App.tsx:437`, `Sidebar.tsx:207`): Mobile uses `w-[85vw] max-w-[288px]` with backdrop blur overlay. Landscape override (`styles.css:287`) caps sidebar at 240px.
- **ChatView layout** (`ChatView.tsx:299`): `max-w-3xl mx-auto` fills viewport on mobile; `px-3 md:px-5` responsive padding. No hardcoded widths that break mobile.
- **ChatInput** (`ChatInput.tsx:183`): `max-h-[160px] md:max-h-[200px]` and `enterKeyHint="send"`.
- **MessageBubble images** (`MessageBubble.tsx:165`): `max-h-32 md:max-h-48` reduces image height on mobile.
- **TerminalPanel bottom sheet** (`TerminalPanel.tsx:337`): Snap-point drag (`mobileSnap` 0.25/0.5/0.85), `rounded-t-xl`, backdrop overlay, `touchAction: manipulation`.
- **GitPanel mobile** (`GitPanel.tsx:317`): `fixed inset-0` full-screen overlay with `zIndex: 45`, `mobile-safe-top/bottom`.
- **ContextMenu** (`ContextMenu.tsx:69`): Dynamic rect-based position clamping (replaces hardcoded 200x160 estimates), `touchend` listener for touch dismissal, items are `min-h-[44px]`.
- **ConfirmDialog** (`ConfirmDialog.tsx:51`): Content wraps in `overflow-y-auto max-h-[calc(60vh-2.5rem)]`, action buttons `min-h-[44px]`.
- **ExtensionUIModal** (`ExtensionUIModal.tsx`): Dialog has `mx-4` side margins, `mobile-safe-bottom`, action buttons `min-h-[44px]`, textarea `min-h-[120px] md:min-h-[200px]`.
- **Safe-area support** (`styles.css:398`): `mobile-safe-top`/`mobile-safe-bottom` use `env(safe-area-inset-*)`. `index.html` has `viewport-fit=cover`.
- **Global touch-action** (`styles.css:144`): `touch-action: manipulation` and `-webkit-tap-highlight-color: transparent` on interactive elements.

---

### Fixed

#### 1. GitPanel commit button too small on mobile
- **Location:** `packages/client/src/components/GitPanel.tsx:467`
- **Issue:** Primary "Commit" button had `py-1.5` (~24px total height) with no minimum height. On mobile this is well below the 44px touch target guideline.
- **Resolution:** Added `min-h-[44px]` to the button className.

#### 2. TerminalPanel tab close button unusable on mobile
- **Location:** `packages/client/src/components/TerminalPanel.tsx:473`
- **Issue:** Close button is `opacity-100` on mobile (always visible) but contains only an 8px icon with zero padding. Clickable area ~8px.
- **Resolution:** Added `p-1 touch-target-sm` to expand clickable area to at least 32px on mobile.

#### 3. ExtensionUIModal close button too small
- **Location:** `packages/client/src/components/ExtensionUIModal.tsx:120`
- **Issue:** 16px close icon with no padding. Clickable area ~16px.
- **Resolution:** Added `p-1.5 touch-target-sm`.

#### 4. AddProjectExplorer "Go to path" button too small
- **Location:** `packages/client/src/components/AddProjectExplorer.tsx:193`
- **Issue:** 12px chevron icon with no padding inside the path bar submit button.
- **Resolution:** Added `p-1.5 touch-target-sm`.

---

### Blocker

*None remaining after fixes above.*

---

### Note

#### N1: SessionActions modal may overflow on short landscape screens
- **Location:** `packages/client/src/components/SessionActions.tsx:22`
- **Detail:** Uses `pt-[20vh]` offset with no `overflow-y-auto` on the inner container. On very short viewports (e.g. iPhone SE landscape ~280px usable height), the 6 action items + header may exceed available space. The "Esc to close" footer is `hidden sm:block` so it doesn't contribute on mobile, which mitigates the risk. Consider adding `max-h-[80vh] overflow-y-auto` to the inner container as future hardening.
- **Severity:** Low — content currently fits most real devices.

#### N2: AddProjectExplorer file row accessibility regression
- **Location:** `packages/client/src/components/AddProjectExplorer.tsx:242`
- **Detail:** File items changed from `<button>` to `<div role="option">` to support separate tap targets (select vs. enter directory). The `<div>` is not focusable (`tabIndex` missing), so keyboard-only users cannot Tab to individual items. Arrow-key navigation via the parent `handleKeyDown` still works if the list container has focus.
- **Severity:** Low — custom keyboard navigation still functions; screen readers see `role="option"`.

#### N3: GitBranchSelector create-branch button touch target
- **Location:** `packages/client/src/components/GitBranchSelector.tsx:214`
- **Detail:** Create branch button inside dropdown has `px-2 py-1` (~20px height). It's a secondary action inside an already-large dropdown. Not critical but could be enlarged in a follow-up.
- **Severity:** Low.

#### N4: ContextMenu lacks body scroll lock
- **Location:** `packages/client/src/components/ContextMenu.tsx`
- **Detail:** Opening a context menu (via long-press on mobile) does not lock body scrolling. Scrolling the page while the menu is open will dismiss it via `touchend` handler, but the underlying page also scrolls.
- **Severity:** Low — common pattern omission, not a regression.

#### N5: `mobile-show-actions` and `diff-side-by-side` CSS rules removed
- **Location:** `packages/client/src/styles.css` (end of mobile media query)
- **Detail:** The diff-side-by-side suppression and mobile-show-actions rules were removed from the CSS. The progress.md notes these were moved to component-level logic (`DiffRenderer.tsx` uses `useIsMobile`). Verified `DiffRenderer.tsx` was not in the changed files list but the scout notes confirm it already handles this. No regression.

