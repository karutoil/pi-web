# Mobile Responsiveness Scout Report

## 1. Infrastructure

### index.html — Viewport Meta
**File:** `packages/client/index.html` (line 6)
```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
```
- ✅ Correct. `width=device-width` + `initial-scale=1.0` + `viewport-fit=cover` (notch support). No issues.

### Tailwind Config
**Files:** `packages/client/vite.config.ts` (uses `@tailwindcss/vite`), `packages/client/src/styles.css`
- No `tailwind.config.*` file exists. Tailwind v4 is CSS-first config (`@import "tailwindcss"` + `@theme` block in `styles.css`).
- Custom breakpoint defined in `@theme` is only via CSS custom properties — no custom screen sizes in Tailwind config. All responsive work uses inline media queries in CSS or Tailwind's default `sm:`/`md:` breakpoints.

### Tailwind Default Breakpoints (inherited)
```
sm: 640px
md: 768px
lg: 1024px
xl: 1280px
2xl: 1536px
```
- `useIsMobile` uses **768px** breakpoint, matching Tailwind's `md:` breakpoint. Consistent.

---

## 2. `useIsMobile` Hook

**File:** `packages/client/src/hooks/useIsMobile.ts` (all 18 lines)

```ts
const MOBILE_BREAKPOINT = 768;

export function useIsMobile(breakpoint = MOBILE_BREAKPOINT): boolean {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => { ... });
  return isMobile;
}
```

### Issues Found

**BUG: Return type annotation is wrong**
- Line 3: `export function useIsMobile(breakpoint = MOBILE_BREAKPOINT): boolean` — TypeScript type says it returns `boolean`, but it returns `useState(false)` which is `[boolean, Setter]` at compile time. The hook actually returns the state value (line 17: `return isMobile`), so it does return a boolean. The type annotation is technically correct but misleading — it should be `boolean` not a generic. **No runtime bug**, just a slight annotation quirk.

**No SSR safety**
- No `useLayoutEffect` or `typeof window !== 'undefined'` guard. `window.matchMedia` will throw on SSR. If this app is ever deployed with SSR/Next-style hydration, this will crash. Current Vite SPA deployment avoids the issue.

**Breakpoint inconsistency: `767px` in CSS vs `768px` in hook**
- `useIsMobile` uses `max-width: 767px` (line 7: `breakpoint - 1` = 767).
- `styles.css` media query uses `max-width: 767px` (line 374). 
- **Match ✅**, but the breakpoint boundary (767px width = 768px screen minus 1px) is an unusual convention. Most apps use `max-width: 768px`. This means a device at exactly 768px wide is NOT considered mobile. Fine for practice.

---

## 3. `styles.css` Global Styles

**File:** `packages/client/src/styles.css` (416 lines)

### Mobile-specific media query (lines 372-415)
```css
@media (max-width: 767px) {
  pre { -webkit-overflow-scrolling: touch; font-size: 0.75rem; }
  .mobile-safe-bottom { padding-bottom: env(safe-area-inset-bottom, 0px); }
  .mobile-safe-top { padding-top: env(safe-area-inset-top, 0px); }
  .touch-target { min-width: 44px; min-height: 44px; }
  .touch-target-sm { min-width: 32px; min-height: 32px; }
  .mobile-show-actions .mobile-action { opacity: 1 !important; }
  .diff-side-by-side { display: none !important; }
  .diff-side-toggle { display: none !important; }
}
```

### Issues

**`pre` font-size reduced to `0.75rem` on mobile**
- Line 376. This is quite small for mobile reading. On a 375px iPhone SE screen, `0.75rem` = ~12px. Might be hard to read.

**`!important` overuse in media query**
- Lines 408, 412-413. `!important` used 3 times. This makes it hard for components to override mobile behavior if needed.

**`mobile-show-actions` class defined but not used in any component**
- Line 408. The CSS class `.mobile-show-actions .mobile-action` has no consumers in the codebase. Dead CSS.

**`diff-side-by-side` and `diff-side-toggle` classes defined but components handle this in JS**
- Lines 412-413. `DiffRenderer.tsx` line 196 already hides side-by-side toggle on mobile via `!isMobile && (...)`. The CSS `.diff-side-toggle { display: none !important }` is redundant but harmless.

---

## 4. Component Analysis

### EmptyState.tsx ✅ Minor
**File:** `packages/client/src/components/EmptyState.tsx`

- Uses `md:p-8` (padding scales at 768px). Mobile gets `p-4`. OK.
- `md:text-3xl` / `text-2xl` scaling. OK.
- `max-w-md w-full`. Full-width on mobile. OK.
- No issues found.

### ErrorBoundary.tsx ✅ Minor
**File:** `packages/client/src/components/ErrorBoundary.tsx`

- `p-6` padding (no `md:` variant). Fixed padding on all screens. Fine.
- `max-w-lg`. Reasonable max-width.
- ⚠️ **No responsive font scaling** for `text-2xl` heading. On very small screens (320px), this might overflow. Minor.

### Icon.tsx ✅ Fine
**File:** `packages/client/src/components/Icon.tsx`

- All icons use fixed `viewBox` sizes and receive `size` prop (default 16).
- No mobile-specific sizing. The `size` prop is passed by consumers.
- **No issues.**

### DiffRenderer.tsx ✅ Good
**File:** `packages/client/src/components/DiffRenderer.tsx`

- **Uses `useIsMobile`** (line 2).
- Line 25: `useEffect(() => { if (isMobile) setViewMode("unified"); }, [isMobile]);` — Automatically forces unified view on mobile. ✅
- Line 196: `!isMobile && ( ... )` — Hides side-by-side toggle buttons on mobile. ✅
- Line 214: `!isMobile && (...)` — Hides old line numbers on mobile. ✅
- Line 242: Side-by-side view wrapped in `viewMode === "side"` which can't happen on mobile. ✅
- ⚠️ **Issue:** Side-by-side view has `min-w-[600px]` (line 239). On mobile, this forces horizontal scroll even if the toggle were visible. Not a bug since toggle is hidden, but if someone changes this logic, it will break.

### AutoRetryIndicator.tsx ⚠️
**File:** `packages/client/src/components/AutoRetryIndicator.tsx`

- `max-w-32` on the error message truncation span (line 13). This is 128px fixed. On very narrow screens, this may overflow the parent.
- `text-xs` on all text. Consistent but small.
- ⚠️ **No `sm:` responsive breakpoints.** Could overflow on 320px screens.

### CompactionIndicator.tsx ⚠️
**File:** `packages/client/src/components/CompactionIndicator.tsx`

- `text-xs` on all text. Small.
- Custom compaction textarea has `rows={2}` — fixed rows on mobile. Fine.
- ⚠️ **No responsive padding** — uses `px-3 py-2` on all screen sizes.
- No mobile-specific hooks/behavior.

### SubagentProgress.tsx ✅ Fine
**File:** `packages/client/src/components/SubagentProgress.tsx`

- All text at `text-xs` or `text-[0.65rem]`.
- `truncate` classes used for overflow protection. ✅
- `max-w-[200px]` on currentToolArgs (line 135). On mobile this could be too narrow. No `sm:` variant.

---

## 5. App Layout & Sidebar (Critical)

### App.tsx
**File:** `packages/client/src/App.tsx`

- Line 25: `const isMobile = useIsMobile();`
- Line 45: `const [showSidebar, setShowSidebar] = useState(window.innerWidth >= 768);` — Initial state uses inline `innerWidth`. **Hydration risk** if SSR: server default is `true` (0 >= 768 = false), so sidebar starts hidden on server, then sidebar might flash on client. Fine for SPA.
- Lines 185-201: Mobile sidebar is `fixed inset-y-0 left-0 z-30` with overlay backdrop. ✅
- Sidebar width on mobile: `w-[85vw] max-w-[288px]` (from Sidebar.tsx line 128). Reasonable.

### ChatHeader.tsx ✅ Good
**File:** `packages/client/src/components/ChatHeader.tsx`

- Uses `useIsMobile` (line 5).
- Line 79: `touch-target-sm` class on sidebar toggle button. ✅
- Line 94: `max-w-[80px] md:max-w-[120px] lg:max-w-[200px]` — Session name truncates progressively. ✅
- Line 97: `hidden sm:inline` on cwd. ✅
- Line 107: `hidden md:inline` on "Offline" and "Live" labels. ✅
- Line 126: `max-w-[100px] md:max-w-[160px]` on model selector. ✅
- Line 160: Mobile model dropdown goes full-width bottom sheet. ✅
- Line 175: Thinking level hidden on mobile (`!isMobile`), instead shown inside model dropdown on mobile. ✅
- **No issues found.**

### Sidebar.tsx ✅ Good
**File:** `packages/client/src/components/Sidebar.tsx`

- Mobile: `fixed inset-y-0 left-0 z-30 w-[85vw] max-w-[288px]` (line 128). ✅
- Desktop: `w-64` fixed width. ✅
- Touch targets use `touch-target` class in media query. ✅
- Session item has `min-h-[44px]` (line 418). ✅
- **No issues found.**

### ChatView.tsx
**File:** `packages/client/src/components/ChatView.tsx`

- No `useIsMobile` import or usage in ChatView itself. It delegates mobile concerns to ChatHeader, ChatInput, and MessageBubble.
- Uses `ChatInput` which may have its own mobile behavior.

---

## 6. Components Using `useIsMobile` (Full Inventory)

| Component | File | How it uses `useIsMobile` |
|-----------|------|--------------------------|
| App.tsx | `src/App.tsx:25` | Sidebar visibility toggle, auto-close sidebar after nav |
| DiffRenderer.tsx | `components/DiffRenderer.tsx:23` | Forces unified view, hides toggle |
| ChatHeader.tsx | `components/ChatHeader.tsx:25` | Hides thinking level button, bottom-sheet model dropdown |
| MessageBubble.tsx | `components/MessageBubble.tsx:321` | Avatar sizing, max-width scaling |
| GitBlame.tsx | `components/GitBlame.tsx:46` | Git blame display |
| GitPanel.tsx | `components/GitPanel.tsx:148,653` | Git panel layout |
| TerminalPanel.tsx | `components/TerminalPanel.tsx:195` | Terminal panel |
| GitStash.tsx | `components/GitStash.tsx:201` | Git stash view |

---

## 7. Summary of Issues

### Bugs
1. **None critical.** No runtime bugs found.

### Warnings (Medium)
2. **`pre` font-size 0.75rem on mobile** (`styles.css:376`) — Very small on narrow screens (~12px on iPhone SE). Recommend `0.8125rem` (13px).
3. **`!important` overuse in mobile media query** (`styles.css:408,412-413`) — Dead code for `mobile-show-actions` and redundant for `diff-side-*`. Clean up.
4. **`max-w-32` on AutoRetryIndicator error message** (`AutoRetryIndicator.tsx:13`) — 128px fixed width on error text that uses `truncate`. Could overflow on 320px screens. Reduce to `max-w-24` or use `sm:max-w-32`.
5. **`max-w-[200px]` on SubagentProgress currentToolArgs** (`SubagentProgress.tsx:135`) — Too narrow on mobile. Use `sm:max-w-[200px]` or reduce mobile width.
6. **CompactionIndicator has no responsive styling** — Fixed `px-3 py-2` and `text-xs` on all screens. On 320px screens, the "Compact" / "Cancel" button row might be tight.

### Recommendations (Low Priority)
7. **SSR safety**: Add `typeof window !== "undefined"` guard to `useIsMobile` for future SSR compatibility.
8. **`useIsMobile` return type**: Change return type annotation from `: boolean` to just remove the explicit return type (let TS infer `boolean`), or use `boolean` consistently — it's currently slightly misleading.
9. **Remove dead CSS**: Delete `.mobile-show-actions` class (no consumers).
10. **ErrorBoundary font**: Add `text-xl md:text-2xl` scaling for heading on very small screens.
11. **Consistent `touch-target` usage**: Some buttons on mobile (like "Compact"/"Cancel" in CompactionIndicator) don't use `touch-target` class — tap targets may be below 44px on small screens.
