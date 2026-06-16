/**
 * Zustand store for right-side panel management.
 *
 * Coordinates which panel is active on the right side of the layout.
 * Only one panel can be primary at a time (preview, git, terminal, files, extensions),
 * but multiple can be open in a stacked/tabbed arrangement.
 */

import { create } from "zustand";

export type RightPanelKind = "preview" | "git" | "terminal" | "files" | "extensions" | "search" | "outline";

export interface RightPanelState {
  /** Which panel kind is currently active */
  active: RightPanelKind | null;
  /** Set of open panels (for tab strip rendering) */
  openPanels: Set<RightPanelKind>;

  // Actions
  open: (kind: RightPanelKind) => void;
  close: (kind: RightPanelKind) => void;
  closeAll: () => void;
  setActive: (kind: RightPanelKind) => void;
  toggle: (kind: RightPanelKind) => void;
  isOpen: (kind: RightPanelKind) => boolean;
}

export const useRightPanelStore = create<RightPanelState>((set, get) => ({
  active: null,
  openPanels: new Set(),

  open: (kind) => {
    set((s) => {
      const next = new Set(s.openPanels);
      next.add(kind);
      return { openPanels: next, active: kind };
    });
  },

  close: (kind) => {
    set((s) => {
      const next = new Set(s.openPanels);
      next.delete(kind);
      // If closing the active panel, switch to the last remaining one
      let newActive: RightPanelKind | null = s.active;
      if (s.active === kind) {
        const remaining = Array.from(next);
        newActive = remaining.length > 0 ? remaining[remaining.length - 1] : null;
      }
      return { openPanels: next, active: newActive };
    });
  },

  closeAll: () => set({ openPanels: new Set(), active: null }),

  setActive: (kind) => {
    const s = get();
    if (s.openPanels.has(kind)) {
      set({ active: kind });
    }
  },

  toggle: (kind) => {
    const s = get();
    if (s.openPanels.has(kind)) {
      get().close(kind);
    } else {
      get().open(kind);
    }
  },

  isOpen: (kind) => get().openPanels.has(kind),
}));
