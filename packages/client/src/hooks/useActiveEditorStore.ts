import { create } from "zustand";

interface ActiveEditorState {
  filePath: string | null;
  content: string | null;
  setActive: (filePath: string | null, content: string | null) => void;
}

export const useActiveEditorStore = create<ActiveEditorState>((set) => ({
  filePath: null,
  content: null,
  setActive: (filePath, content) => set({ filePath, content }),
}));
