## Review: Mobile Responsiveness Plan v2

**Verdict: REVISE — 1 blocker remains.**

---

### Blocker (must fix before implementation)

**B1. Plan 2.1 — TerminalPanel xterm font size goes the wrong direction**
- Plan sets `fontSize: isMobile ? 11 : 13`. The current desktop value is 13 px; the plan makes it **smaller** on phones.
- Scout rated 13 px unreadable on high-DPI phones (P0). Reducing to 11 px regresses that finding.
- **Fix:** Change to `fontSize: isMobile ? 14 : 13` (or 15–16). Goal is larger, not smaller, on mobile.

---

### Correct (what is already good)

- **All review-1 blockers addressed:**
  - B1 (resize touch handler type-incorrect): Fixed in 4.2 with separate `handleResizeTouchStart` + `touchmove`/`touchend`.
  - B2 (`.sidebar-mobile` class missing): Fixed in 4.3 with attribute selector targeting real DOM.
  - B3 (`touch-manipulation` undefined): Fixed in 2.3 with inline `style={{ touchAction: "manipulation" }}`.
  - B4 (`App.tsx` hydration mismatch): Fixed in 1.12 with `useState(false)` + `useEffect` init.
- **All review-1 concerns addressed:**
  - C1 (keyboard attributes): Added cross-cutting 1.13 with `enterKeyHint` and `autoCorrect`.
  - C2 (ContextMenu `touchend`): Added 3.3.
  - C3 (ContextMenu off-screen): Added 3.4 viewport clamping.
  - C4 (GitBranchSelector overflow): Updated 2.14 with `max-w-[calc(100vw-1rem)]` and `right-0`.
  - C5 (2.5 redundant): Updated with skip note.
  - C6 (Sidebar footer safe-area): Updated 1.6.
  - C7 (ConfirmDialog scroll): Updated 3.5 with `calc(60vh - 2.5rem)`.
  - C8 (ExtensionUIModal scroll): Updated 3.9 with `calc(65vh - 4rem)`.
  - C9 (StatusBar stub): Added 4.4.
  - C10 (`sm:` vs `md:` rationale): Added "Breakpoint Rationale" section.
  - C11 (line reference off): Fixed 1.10 to ~302.
- **Phase ordering** is sound: CSS foundation → panels → modals → polish.
- **Desktop safety** preserved: nearly all changes use mobile-only media queries or `md:` prefixes.
- **Line references** overwhelmingly accurate against source files.

---

### Notes (non-blocking gaps and risks)

**N1. Scroll trapping incomplete**
- Only ContextMenu (3.2) gets `touch-none` to prevent body scroll.
- ConfirmDialog, ExtensionUIModal, AddProjectExplorer, SessionActions lack explicit `touch-none` or `overscroll-behavior: contain` on their overlays.
- On mobile, scrolling inside these modals can propagate to the body background.

**N2. GitBlame mobile fonts still small**
- 2.10 sets `text-[0.65rem]` (~10.4 px) and `text-[0.7rem]` (~11.2 px) on mobile.
- Still below comfortable readability threshold. Consider `text-xs` (12 px) as a floor.

**N3. GitBranchSelector dropdown positioning vague**
- 2.14 says "Add `right-0` as a fallback positioning class if dropdown overflows right edge."
- Unclear whether this is conditional or always applied. If always applied alongside `left-0`, behavior depends on CSS layout context.

**N4. TerminalPanel bottom-sheet safe-area**
- No `mobile-safe-bottom` added to TerminalPanel bottom-sheet root.
- Home indicator may overlap terminal content area on iPhone X+.

**N5. Missing `inputMode` attributes**
- 1.13 adds `enterKeyHint` and `autoCorrect` but not `inputMode`.
- Path inputs (AddProjectExplorer) could benefit from `inputMode="url"`.

**N6. Landscape handling minimal**
- Only sidebar width (4.3) has a landscape rule.
- Other components (ChatView, GitPanel, TerminalPanel) rely on general responsive classes. No obvious breakage, but no explicit landscape testing beyond sidebar.

---

### Summary

| Criterion | Score | Notes |
|-----------|-------|-------|
| Blocker resolution (B1–B4) | 4/4 | All fixed correctly. |
| Concern resolution (C1–C11) | 11/11 | All addressed. |
| New issues introduced | 1 | Terminal font size direction inverted. |
| Touch targets | Good | `min-h-[44px]` applied across all major interactive elements. |
| Safe areas | Good | `mobile-safe-top/bottom` applied to shell, panels, modals, toasts. |
| Keyboard handling | Partial | `enterKeyHint`/`autoCorrect` covered; `inputMode` missing; no virtual-viewport handling. |
| Scroll trapping | Partial | Only ContextMenu explicitly trapped. |
| Orientation | Minimal | Landscape query only for sidebar width. |

**Recommendation:** Fix blocker B1 (2.1 font size). Plan is then ready for implementation.
