## Review: Mobile Responsiveness Plan

**Verdict: CONCERNS + 3 BLOCKERS**

---

### BLOCKERS (must fix before implementation)

**B1. Plan 4.2 — Tablet resize handler is type-incorrect**
- `onTouchStart={handleResizeMouseDown}` on desktop resize handle will not compile or run.
- `handleResizeMouseDown` expects `React.MouseEvent` and installs `mousemove`/`mouseup` listeners. Touch events use `React.TouchEvent` and need `touchmove`/`touchend` listeners with `e.touches[0].clientY`.
- **Fix:** Add separate `handleResizeTouchStart` + `handleTouchMove`/`handleTouchEnd` handlers, or merge into a single pointer-event handler.

**B2. Plan 4.3 — `.sidebar-mobile` class does not exist**
- Landscape query references `.sidebar-mobile { max-width: 240px !important; }` but no element in the codebase uses that class.
- Sidebar mobile width is set via `w-[85vw] max-w-[288px]` inline.
- **Fix:** Either add `sidebar-mobile` to the sidebar element in `Sidebar.tsx` or replace the CSS rule with a Tailwind responsive class like `max-w-[240px] landscape:max-w-[240px]` (if Tailwind v4 supports `landscape:`) or use an inline `@media` targeting the existing class.

**B3. Plan 2.3 — `touch-manipulation` class is undefined**
- Phase 1.1 correctly adds `touch-action: manipulation` via raw CSS to interactive elements. Phase 2.3 then says to "Add `touch-manipulation` class" to TerminalPanel content. This class is not defined in `styles.css` and is not a Tailwind v4 utility.
- **Fix:** Either define `.touch-manipulation { touch-action: manipulation; }` in `styles.css` or use inline `style={{ touchAction: "manipulation" }}`.

**B4. Missing App.tsx hydration mismatch fix (scout-rated critical)**
- Scout `core-layout.md` C1: `useState(window.innerWidth >= 768)` in `App.tsx` line 32 causes hydration mismatch / sidebar flash on mobile.
- Plan "Files to Modify" table lists `App.tsx — showSidebar SSR-safe init (optional)` but there is **no numbered plan item** for it.
- **Fix:** Add a Phase 1 item to initialize `showSidebar` from `useIsMobile()` or defer to `useEffect`.

---

### CONCERNS (non-blocking suggestions)

**C1. Missing mobile keyboard attributes**
- Modals-and-interactions scout rated "No `inputMode`/`enterKeyHint`/`autoCorrect` on inputs" as high priority.
- Plan touches zero inputs across: `ChatInput`, `ExtensionUIModal` (input/editor), `AddProjectExplorer` (path input), `GitPanel` (commit textarea), `GitStash` (stash input), `GitBranchSelector` (create branch input).
- **Suggest:** Add a cross-cutting Phase 1 item or inline `inputMode`/`enterKeyHint` on all text inputs.

**C2. ContextMenu missing `touchend` fallback**
- Plan 2.15 adds `touchend` to `GitBranchSelector` click-outside. `ContextMenu.tsx` uses the same `mousedown`-only pattern (line 56–72) but gets no fix.
- **Suggest:** Mirror 2.15 for `ContextMenuPortal` click-outside handler.

**C3. GitLog context menu off-screen on mobile**
- Scout panels-and-git.md rated "Context menu uses absolute page coords — may render off-screen at page edges" as **High**.
- Plan does not address viewport clamping or repositioning for `ContextMenuPortal` when triggered by `useLongPress`.
- **Suggest:** Add `max-width`/`max-height` clamping or viewport-edge detection to `ContextMenuPortal`.

**C4. GitBranchSelector dropdown overflow**
- Scout rated "Dropdown positioned `absolute left-0 top-full` — may overflow right edge" and "Hardcoded `min-w-[200px] md:min-w-[240px] max-w-[320px]` — on phones <320px wide, dropdown overflows" as High.
- Plan only adds `min-h-[44px]` and `touchend`. Does not fix positioning or width.
- **Suggest:** Add `right-0` fallback positioning or `max-w-[calc(100vw-1rem)]`.

**C5. Plan 2.5 is redundant**
- GitPanel header buttons already have `touch-target` class (verified in `GitPanel.tsx` lines 290–295).
- Plan says "Replace `p-1.5 md:p-1` with `p-1.5 touch-target md:p-1`" but `touch-target` is already present.
- **No harm** if applied, but wastes implementation time.

**C6. Sidebar footer lacks safe-area padding**
- Plan 1.6 adds `mobile-safe-bottom` to the **scrollable area** (`<div className="flex-1 overflow-y-auto ...">`). The actual footer bar (`<div className="px-4 py-2.5 ...">`) below it does not get `mobile-safe-bottom` and could be hidden by home indicator.
- **Suggest:** Also append `mobile-safe-bottom` to the footer wrapper.

**C7. ConfirmDialog scroll container sizing**
- Plan 3.3 adds `overflow-y-auto max-h-[60vh]` to the dialog body. The body includes `p-5` padding, so content height is `60vh - 2.5rem`. On short viewports this may still clip.
- **Suggest:** Use `max-h-[60vh]` on a child content wrapper, not the padded outer box, or use `max-h-[calc(60vh-2.5rem)]`.

**C8. ExtensionUIModal body scroll height**
- Plan 3.7 adds `overflow-y-auto max-h-[65vh]` to the inner content div. This div sits inside a container that also has header + `mobile-safe-bottom`. `65vh` may still exceed available space on short phones.
- **Suggest:** Use `max-h-[calc(65vh-4rem)]` or similar to account for header + safe area.

**C9. StatusBar.tsx stub not addressed**
- Scout found `StatusBar.tsx` returns `null` — entirely non-functional.
- Plan does not list it. Since it renders nothing, it's not a mobile blocker, but it should be in a "remove or implement" note.

**C10. Mix of `sm:` and `md:` without documented rationale**
- Plan uses `sm:max-w-32` (1.9), `sm:text-xs` (2.10), but `md:max-h-48` (3.13), `md:max-h-[200px]` (1.8).
- Mobile breakpoint is 767px (`md:`). Using `sm:` (640px) creates an intermediate tier that may confuse implementers.
- **Suggest:** Document when to use `sm:` vs `md:` or standardize on `md:` for all mobile/desktop toggles.

**C11. Phase 1.10 line reference off**
- Plan says ChatView empty state is at "line ~270". Actual empty state wrapper is at line ~293 in `ChatView.tsx`.
- Minor; the className change is still unambiguous.

---

### CORRECT (what is already good)

- **Phase ordering** is sound: CSS foundation → panels → modals → polish. Dependencies are correctly declared.
- **Tailwind v4 patterns** are appropriate: arbitrary values (`min-h-[44px]`), responsive prefixes (`md:`, `sm:`), custom theme tokens (`ink-950`, `amber-500`), and CSS-first `@theme` are all used correctly.
- **P0 priority items are truly broken:**
  - `pre` padding eats ~32% of 320px screen — confirmed.
  - xterm `fontSize: 13` unreadable on phones — confirmed.
  - GitBlame `text-[0.6rem]` (~9.6px) is below readable threshold — confirmed.
- **Line references** in the plan are overwhelmingly accurate (verified against actual source files).
- **Desktop safety:** Almost all changes use mobile-only media queries or `md:` prefixes, so desktop layout is preserved.
- **Safe-area classes** (`mobile-safe-top`, `mobile-safe-bottom`) exist in `styles.css` and are applied correctly where planned.
- **Touch target convention** (`touch-target` = 44px, `touch-target-sm` = 32px) is already defined in CSS and leveraged consistently across the plan.
- **Risks section** correctly identifies xterm FitAddon miscalculation, GitPanel action removal UX, and safe-area clipping risks.

---

### SUMMARY

| Criterion | Score | Notes |
|-----------|-------|-------|
| Completeness (28 components) | 20/23 files covered | Missing: ErrorBoundary, CompactionIndicator, SubagentProgress, StatusBar, ModelSelector (minor/acceptable) |
| Correctness (Tailwind v4) | Good | 3 incorrect class references (`touch-manipulation`, `.sidebar-mobile`, resize touch handler) |
| Feasibility (desktop safe) | Good | All changes are mobile-scoped; no desktop breakage expected |
| Priority accuracy | Good | P0 items match scout critical findings |
| Missing concerns | Partial | Touch targets, safe areas, scroll trapping covered. Keyboard attributes, context-menu positioning, dropdown overflow not covered. |
| Plan structure | Good | Phases ordered correctly with clear dependencies |
| Conflicts | 3 blockers | Resize touch handler, landscape CSS class, undefined `touch-manipulation` |

**Recommendation:** Fix B1–B4, then the plan is ready for implementation.
