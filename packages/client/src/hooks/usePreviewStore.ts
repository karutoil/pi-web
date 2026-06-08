/**
 * Zustand store for preview state.
 *
 * Holds:
 *  - Active preview info per (projectId, label)
 *  - Panel open/closed + width (persisted to localStorage)
 *  - Picked elements list
 *  - Console logs
 *  - Picker mode toggle
 */

import { create } from "zustand";
import type { PreviewInfo, SerializedElement } from "@pi-web/shared";

export interface ConsoleEntry {
  level: "log" | "warn" | "error";
  message: string;
  timestamp: number;
}

export interface PreviewState {
  // Panel state
  isOpen: boolean;
  panelWidth: number;

  // Preview processes
  previews: Map<string, PreviewInfo>;

  // Active view
  activeProjectId: string | null;
  activeLabel: string;

  // Element picker
  pickerActive: boolean;
  pickedElements: SerializedElement[];
  autoSendMessage: string | null; // message to auto-send when element picked
  // Console
  consoleLogs: ConsoleEntry[];
  // Actions
  setOpen: (open: boolean) => void;
  setPanelWidth: (width: number) => void;
  setPreviews: (previews: PreviewInfo[]) => void;
  upsertPreview: (preview: PreviewInfo) => void;
  removePreview: (projectId: string, label: string) => void;
  setActivePreview: (projectId: string | null, label?: string) => void;
  togglePicker: () => void;
  addPickedElement: (element: SerializedElement, autoSend?: string) => void;
  removePickedElement: (token: string) => void;
  clearPickedElements: () => void;
  consumeAutoSend: () => string | null;
  addConsoleLog: (entry: ConsoleEntry) => void;
  clearConsoleLogs: () => void;

}

const DEFAULT_WIDTH = 480;
const MIN_WIDTH = 320;
const MAX_WIDTH_PCT = 0.7;

function loadWidth(): number {
  try {
    const v = localStorage.getItem("pi-preview-width");
    if (v) {
      const n = parseInt(v, 10);
      if (!isNaN(n) && n >= MIN_WIDTH && n <= window.innerWidth * MAX_WIDTH_PCT) return n;
    }
  } catch {}
  return DEFAULT_WIDTH;
}

function saveWidth(w: number) {
  try { localStorage.setItem("pi-preview-width", String(w)); } catch {}
}

export const usePreviewStore = create<PreviewState>((set, get) => ({
  isOpen: false,
  panelWidth: loadWidth(),

  previews: new Map(),
  activeProjectId: null,
  activeLabel: "default",

  pickerActive: false,
  pickedElements: [],
  autoSendMessage: null,
  consoleLogs: [],
  setOpen: (open) => set({ isOpen: open }),
  setPanelWidth: (width) => {
    const clamped = Math.max(MIN_WIDTH, Math.min(width, window.innerWidth * MAX_WIDTH_PCT));
    saveWidth(clamped);
    set({ panelWidth: clamped });
  },
  setPreviews: (previews) => {
    const map = new Map<string, PreviewInfo>();
    for (const p of previews) map.set(`${p.projectId}:${p.label}`, p);
    set({ previews: map });
  },
  upsertPreview: (preview) => {
    set((s) => {
      const next = new Map(s.previews);
      next.set(`${preview.projectId}:${preview.label}`, preview);
      return { previews: next };
    });
  },
  removePreview: (projectId, label) => {
    set((s) => {
      const next = new Map(s.previews);
      next.delete(`${projectId}:${label}`);
      return { previews: next };
    });
  },
  setActivePreview: (projectId, label) => {
    set({ activeProjectId: projectId, activeLabel: label || "default" });
  },
  togglePicker: () => set((s) => ({ pickerActive: !s.pickerActive })),
  addPickedElement: (element, autoSend) => {
    set((s) => {
      const exists = s.pickedElements.some((e) => e.token === element.token);
      const next = exists ? s.pickedElements : [...s.pickedElements, element];
      return {
        pickedElements: next,
        autoSendMessage: autoSend || null,
      };
    });
  },
  removePickedElement: (token) => {
    set((s) => ({
      pickedElements: s.pickedElements.filter((e) => e.token !== token),
    }));
  },
  clearPickedElements: () => set({ pickedElements: [], autoSendMessage: null }),
  consumeAutoSend: () => {
    const msg = get().autoSendMessage;
    if (msg) {
      set({ autoSendMessage: null });
      return msg;
    }
    return null;
  },

  addConsoleLog: (entry) => {
    set((s) => {
      const next = [...s.consoleLogs, entry];
      if (next.length > 500) next.splice(0, next.length - 500);
      return { consoleLogs: next };
    });
  },

  clearConsoleLogs: () => set({ consoleLogs: [] }),
}));
