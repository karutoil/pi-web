# Chat Area Redesign — Plan

Mockups: [`atelier.html`](./atelier.html) · [`foundry.html`](./foundry.html)
Open them in a browser to compare side by side.

---

## 1. The problem

The current chat area is cramped and overstuffed. Every control PI owns is
wedged into two bars:

**`ChatHeader.tsx`** — 9+ things on one row:
title · cwd path · Offline/Live status · context-% stat · `$cost` stat ·
session-actions button · **7 panel-toggle pills** (terminal, files, preview,
git, extensions, skills, subagents).

**`ChatInput.tsx` toolbar** — 8+ more:
model selector · thinking-level · prompt library · attach · mic · token count ·
terminal button · abort · send.

Symptoms:
- **Duplicated info.** Context % appears in the header *and* a token count sits
  in the input. Cost only in the header.
- **Redundant controls.** `WorkspaceDock` already renders its own
  `closedPanels` reopen strip (floating edge buttons), so the 7 header pills
  duplicate dock control.
- **No breathing room.** Tight padding, busy pills on every surface, metadata
  under every message.
- The header is a control panel, not a conversation title.

## 2. Design principles (the "Claude approach")

1. **One focal column.** Conversation content centered, ~46–47rem, generous
   vertical rhythm. Everything else gets out of the way.
2. **Empty-ish header.** A title and a status dot is enough. Everything that
   *does* something moves to one overflow menu or a dedicated surface.
3. **One home for stats.** Context %, cost, and token count consolidated into a
   single quiet line — never duplicated across two bars.
4. **Panels are not the conversation's problem.** Panel toggles leave the header.
   The dock already owns panel visibility; we just give it a cleaner entry point.
5. **Calm composer.** Model + thinking on the left, attach + send on the right,
   nothing else on the bar.
6. **Queter messages.** Tool calls collapse to one-line cards; per-message
   metadata (tokens, errors) reveals on hover.

## 3. Two directions (pick one before I build)

Both apply the same principles; they differ in **aesthetic** and in **how
panels are reached**.

### A — Atelier (light, Claude-faithful) — [`atelier.html`](./atelier.html)
- Warm **paper** light theme. Brass used sparingly (send button, active states).
- **Near-empty header**: mark + title + Live dot + one `⋯` overflow.
- **Panels → right-edge icon rail** (7 slim muted icons; active = brass).
  Keeps the header pristine; one click to any panel.
- **Stats → single footer line under the composer**
  (`cwd` · `tok · % · $`). Nothing duplicated.
- The overflow menu also holds session actions (export / clone / compact).
- Most spacious, most "Claude". Biggest departure from current look.

### B — Foundry (dark, PI-native unified) — [`foundry.html`](./foundry.html)
- Keeps PI's **brass & rust workshop** identity (warm charcoal, brass accent,
  Newsreader italic titles, Geist Mono). Tool cards keep the brass left-bar.
- **Unified slim header**: title + one inline stats cluster (`▓ 42%  $0.03`) +
  Live dot + overflow. CWD demoted into the panel strip.
- **Panels → quiet top tab strip** under the header (7 tabs, active = brass).
  More IDE-structured, still calm.
- Composer matches current dark surface but with de-cluttered toolbar.
- Less radical; preserves brand; "unified" = one calm bar does the work.

**My read:** B is the safer, more coherent path (no theme work, keeps the
identity you've already built). A is the bolder, more genuinely "Claude" one
if you want the refresh to feel like a generation change. Both are
implementable; the panel pattern (rail vs tab strip) is the main fork.

## 4. Concrete changes (applies to whichever direction)

> All paths below are under `packages/client/src/`.

### `components/ChatHeader.tsx`
- Delete the 7 panel-toggle buttons and the `onToggle*`/`*Open` props.
- Delete the stats block (context %, cost) — moves to composer footer (A) or
  the inline header cluster (B).
- Delete the standalone cwd line — demote to composer footer (A) / tab strip (B).
- Keep: mark, title (click-to-rename), Live/Offline dot, one `⋯` overflow.
- Overflow menu = session actions (export HTML/JSONL, clone, compact,
  auto-compaction toggle, restart PI) **+** "Open panel" submenu (only if we
  keep a header entry; rail/tab strip may make this redundant).
- Mobile header stays a compact title row + the `⋯` overflow.

### Panel toggles → new home
- **A (rail):** new tiny `PanelRail.tsx` (right edge, vertical, 7 icons). Renders
  only the chat column's right gutter; hidden on narrow widths (falls back to
  overflow menu).
- **B (tab strip):** new `PanelTabs.tsx` under the header.
- Both consume the same `onToggle*` / `*Open` props ChatHeader used to take.
- `WorkspaceDock`'s existing `closedPanels` strip stays as the reopen affordance
  on docked panes — the rail/tabs are the *open* affordance. No conflict.

### `components/ChatInput.tsx`
- Toolbar → **model + thinking (left)** · spacer · **attach + mic + send (right)**.
- Remove the standalone token-count pill (now lives in the footer/header cluster).
- Remove the "terminal open" indicator button (redundant with panel rail/tabs).
- Prompt-library + voice stay as quiet icon pills.
- Footer line (new, direction A): cwd left, `tok · % · $` right, mono, muted.
- Direction B: footer optional; stats already in header. Keep a minimal footer
  for cwd + token count if desired.

### `components/MessageBubble.tsx`
- Per-message metadata (tokens / exit-code / error) → `opacity:0` by default,
  `opacity:1` on row hover. Already partially the pattern; finish it.
- Tool cards: default **collapsed** to one-line summary (icon + `read · path` +
  meta + chevron). Click expands. Removes wall-of-tool-noise mid-stream.
- Keep the accent left-bar per tool family (B) / mute it (A).

### `styles.css` (conversation-* block, ~L3181–4230 + theme dupes)
- `.conversation-scroll` padding up to `2.25rem 1.25rem`.
- `.conversation-message-stack` max-width → `46–47rem`; turn spacing → `2.1rem`.
- `.conversation-header` height → `~54–56px`, strip the multi-pill layout.
- `.conversation-toolbar` de-clutter per above.
- Add `.conversation-footer` (A) / `.conversation-panel-tabs` (B).
- **Delete the duplicate theme blocks** at L11115 and L12341 — there are three
  copies of the conversation styles; consolidating to one removes ~300 lines and
  the maintenance trap. (Separate cleanup, but do it in the same pass.)

## 5. Migration (low-risk, incremental)

1. **Consolidate stats** — move context %/cost/token into one place; remove
   duplicates. No layout change yet. Shippable alone.
2. **Panel toggles out of header** — build `PanelRail` or `PanelTabs`, move the
   7 props, leave header otherwise intact. Revertable independently.
3. **Header diet** — strip to title + status + overflow. Wire session actions
   into the overflow menu.
4. **Composer toolbar diet** — model/thinking left, attach/send right; drop
   token pill + terminal indicator.
5. **Message quietness** — hover-reveal metadata + collapsed tool cards.
6. **Spacing pass** — widen column, add vertical rhythm, clean up the triple
   CSS theme blocks.

Each step is independently reviewable; none changes data flow or the WS layer.

## 6. Open questions for you

- **Direction A or B?** (light Claude-faithful vs dark PI-native.) Or A's
  layout in PI's dark palette — a hybrid I can mock if useful.
- **Panel access preference:** right-edge rail (A), top tab strip (B), or just
  rely on the dock's existing reopen strip + one "Panels" overflow button?
- **Stats location:** composer footer (A) vs inline header (B)?
- Keep the brass left-bar on tool cards (B) or mute it (A)?
- Scope: ship this as one PR, or land the 6 migration steps incrementally?

Once you pick a direction + answer the panel/stats questions, I'll implement
against the real components.
