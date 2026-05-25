# Mobile Responsiveness UX Review

## Scope
All changed files in `packages/client/src/` per progress.md.

---

## Correct

### Sidebar drawer pattern
- **App.tsx:63-70** — Mobile backdrop renders at `z-20` with `bg-ink-950/60 backdrop-blur-sm`; click closes sidebar. Sidebar itself is `fixed inset-y-0 left-0 z-30 w-[85vw] max-w-[288px]`. Layering is correct (backdrop below sidebar).
- **App.tsx:315** — Sidebar auto-closes on project/session selection via `setTimeout(() => setShowSidebar(false), 150)`.
- **Sidebar.tsx:108** — Close button present in header with `aria-label` and `title`.
- **Sidebar.tsx:131** — Scrollable content area has `mobile-safe-bottom`.

### Git / Terminal panels on mobile
- **TerminalPanel.tsx:220-250** — Bottom-sheet snap behavior with touch drag (`SNAP_POINTS = [0.3, 0.5, 0.7]`). Backdrop at `z-39`, panel at `z-40`.
- **TerminalPanel.tsx:178** — xterm font size adapts: `isMobile ? 14 : 13`.
- **GitPanel.tsx:297** — On mobile: `fixed inset-0 border-l-0` with inline `zIndex: 45`. Full-screen overlay, no clipping.
- **GitPanel.tsx:303-308** — Desktop resize handle hidden on mobile (`!isMobile`).
- **GitPanel.tsx:384-397** — View tabs (Changes / Log) use `min-h-[44px]` for touch targets.
- **GitBlame.tsx:90-100** — Left metadata column hidden on mobile; compact inline hash/author shown instead.

### Chat input area
- **ChatInput.tsx:155** — `enterKeyHint="send"` on textarea.
- **ChatInput.tsx:162** — Textarea max-height adapts: `max-h-[160px] md:max-h-[200px]`.
- **ChatInput.tsx:169-180** — Send / Abort / Terminal-toggle buttons all use `touch-target` (44×44 min).
- **ChatInput.tsx:12** — Outer container has `mobile-safe-bottom`.
- **ChatInput.tsx:65-72** — Paste handler supports image attachments.

### Diff / code rendering
- **DiffRenderer.tsx:38** — `useEffect` forces `viewMode = "unified"` when `isMobile` becomes true.
- **DiffRenderer.tsx:172-173** — Side-by-side toggle hidden on mobile (`!isMobile`).
- **DiffRenderer.tsx:217** — Unified line content uses `break-all` to prevent horizontal overflow.
- **styles.css:252-260** — Headings shrink at `max-width: 374px` for very narrow viewports.

### Touch targets & accessibility
- Long-press hook in **ContextMenu.tsx:7-45** enables right-click menus on touch (500ms, 10px move threshold).
- **ContextMenuItem.tsx:112** — Menu items use `min-h-[44px]`.
- **GitLog.tsx:242** — Commit rows use `min-h-[44px]`.
- **Sidebar.tsx:256** — Session list items use `min-h-[44px]`.
- **AddProjectExplorer.tsx:238** — Directory rows use `py-3 md:py-2` (larger on mobile).
- **ConfirmDialog.tsx:50-62** — Dialog buttons use `min-h-[44px]`.
- **ExtensionUIModal.tsx:126,140** — Dialog action buttons use `min-h-[44px]`.

### Viewport & safe areas
- **index.html** (scouted) — `width=device-width, initial-scale=1.0, viewport-fit=cover` correct.
- **styles.css:228-236** — `mobile-safe-bottom` and `mobile-safe-top` classes defined under `@media (max-width: 767px)`.
- **styles.css:238-248** — `touch-target` (44px) and `touch-target-sm` (32px) utility classes.

---

## Fixed

### 1. Project delete button invisible on mobile
**File:** `packages/client/src/components/Sidebar.tsx`  
**Line:** ~312  
**Issue:** `opacity-0 group-hover:opacity-100 md:opacity-0` meant the delete button was unreachable on touch devices (no hover).
```tsx
// Before
className="opacity-0 group-hover:opacity-100 md:opacity-0 ..."

// After
className="opacity-100 md:opacity-0 md:group-hover:opacity-100 ..."
```

### 2. Git diff viewer lacks horizontal scroll containment
**File:** `packages/client/src/components/GitPanel.tsx`  
**Line:** ~117  
**Issue:** Diff lines use `whitespace-pre` inside `flex-1 overflow-y-auto` with no `overflow-x-auto`. Long diff lines overflow horizontally or push layout.
```tsx
// Before
<div className="flex-1 overflow-y-auto custom-scrollbar ...">

// After
<div className="flex-1 overflow-y-auto overflow-x-auto custom-scrollbar ...">
```

### 3. Git log commit diff viewer same overflow issue
**File:** `packages/client/src/components/GitLog.tsx`  
**Line:** ~290  
**Issue:** Same `whitespace-pre` content without horizontal scroll container.
```tsx
// Before
<div className="flex-1 overflow-y-auto custom-scrollbar ...">

// After
<div className="flex-1 overflow-y-auto overflow-x-auto custom-scrollbar ...">
```

### 4. Chat attachment remove button too small
**File:** `packages/client/src/components/ChatInput.tsx`  
**Line:** ~72  
**Issue:** `w-5 h-5` (~20px) is below minimum accessible touch target.
```tsx
// Before
className="... w-5 h-5 ..."

// After
className="... w-6 h-6 ... touch-target-sm"
```

---

## Blocker

None. All critical paths are functional after the fixes above.

---

## Note

### N1 — Sub-12px typography density
Multiple components use `text-[0.55rem]` (~8.8px), `text-[0.6rem]` (~9.6px), and `text-[0.65rem]` (~10.4px). At 320px viewport these are below iOS accessibility defaults and may be unreadable for users with reduced vision.

**Locations:**
- `Sidebar.tsx:258` — session group labels `text-[0.55rem]`
- `GitPanel.tsx:470` — file status badge `text-[0.6rem]`
- `GitPanel.tsx:495` — diff stats `text-[0.6rem]`
- `GitLog.tsx:150` — ref badge `text-[0.6rem]`
- `GitStash.tsx:109` — stash index `text-[0.6rem]`
- `ChatInput.tsx:196` — hint text `text-[0.65rem]`
- `DiffRenderer.tsx:207` — line numbers `text-[0.65rem]`

**Risk:** Users on small devices or with accessibility settings may see clipped/truncated labels.

### N2 — `mobile-safe-bottom` overrides base padding on mobile
**File:** `styles.css:228-232`  
**Issue:** `.mobile-safe-bottom { padding-bottom: env(safe-area-inset-bottom, 0px); }` is unlayered CSS, so it overrides Tailwind `pb-*` utilities. On devices without safe areas, bottom padding becomes `0px` wherever the class is used.

**Affected components:** ChatInput (loses `pb-2`), ConfirmDialog (loses `p-5` bottom), AddProjectExplorer footer (loses `pb-4`), Sidebar footer, GitPanel.

**Suggested fix:** Change to additive padding:
```css
.mobile-safe-bottom {
  padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 0.5rem);
}
```
This preserves base padding while adding safe-area offset.

### N3 — SessionActions modal top padding is fixed
**File:** `packages/client/src/components/SessionActions.tsx:24`  
**Issue:** `pt-[20vh]` on the outer flex container. On short landscape phones or with large safe-area insets, the modal may sit too low. Consider `pt-[15vh] sm:pt-[20vh]` or vertical centering.

### N4 — Auto-retry error text severely truncated on mobile
**File:** `packages/client/src/components/ChatInput.tsx:204`  
**Issue:** `max-w-24` (~96px) on mobile for error messages leaves almost no readable text.

### N5 — No manual device testing performed
**From progress.md:** "Manual device emulation testing (iPhone SE, iPad Mini, etc.) not performed; recommended next step."  
Several issues above (tiny text, padding overrides) would likely surface quickly in real browser DevTools emulation.

### N6 — `mobile-safe-bottom` and `mobile-safe-top` only apply below 768px
The media query wrapping these classes means desktop users with notched external monitors (e.g., some ultrawides in portrait) do not get safe-area padding. This is acceptable since the primary risk is mobile devices.
