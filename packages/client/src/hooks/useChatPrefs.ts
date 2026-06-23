import { useState, useLayoutEffect, useCallback } from "react";
import { piWebStorage } from "../lib/piWebStorage";

// Chat display defaults — user-tunable in Settings → PI Web → Chat.
// ponytail: singleton + listener set mirrors useTheme so a change in settings
// updates every consumer live; values only seed useState initials, so existing
// already-rendered blocks keep their current open state (it's a *default*).
export interface ChatPrefs {
  /** Reasoning blocks expanded by default (flow inline like normal chat). */
  autoExpandReasoning: boolean;
  /** The per-turn tool group rail open by default. */
  autoExpandToolGroup: boolean;
  /** Each individual tool call expanded by default. */
  autoExpandToolCalls: boolean;
}

const KEYS = {
  autoExpandReasoning: "pi-web-auto-expand-reasoning",
  autoExpandToolGroup: "pi-web-auto-expand-tool-group",
  autoExpandToolCalls: "pi-web-auto-expand-tool-calls",
} as const;

export type ChatPrefKey = keyof ChatPrefs;

function readBool(key: string): boolean {
  return piWebStorage.getItem(key) === "1";
}

function load(): ChatPrefs {
  return {
    autoExpandReasoning: readBool(KEYS.autoExpandReasoning),
    autoExpandToolGroup: readBool(KEYS.autoExpandToolGroup),
    autoExpandToolCalls: readBool(KEYS.autoExpandToolCalls),
  };
}

let current: ChatPrefs = load();
const listeners = new Set<(p: ChatPrefs) => void>();

function emit() { listeners.forEach(l => l(current)); }

function persist(key: ChatPrefKey, value: boolean) {
  piWebStorage.setItem(KEYS[key], value ? "1" : "0");
}

export function setChatPref(key: ChatPrefKey, value: boolean) {
  if (current[key] === value) return;
  current = { ...current, [key]: value };
  persist(key, value);
  emit();
}

export function resetChatPrefs() {
  current = { autoExpandReasoning: false, autoExpandToolGroup: false, autoExpandToolCalls: false };
  (Object.keys(KEYS) as ChatPrefKey[]).forEach(k => piWebStorage.removeItem(KEYS[k]));
  emit();
}

// Cross-tab + external updates (replaces the old `storage` event listener).
piWebStorage.subscribe(() => {
  const next = load();
  if (
    next.autoExpandReasoning !== current.autoExpandReasoning ||
    next.autoExpandToolGroup !== current.autoExpandToolGroup ||
    next.autoExpandToolCalls !== current.autoExpandToolCalls
  ) {
    current = next;
    emit();
  }
});

export function useChatPrefs(): [ChatPrefs, (key: ChatPrefKey, value: boolean) => void] {
  const [prefs, setPrefs] = useState<ChatPrefs>(current);
  useLayoutEffect(() => {
    const update = (p: ChatPrefs) => setPrefs(p);
    listeners.add(update);
    return () => { listeners.delete(update); };
  }, []);
  const setPref = useCallback((key: ChatPrefKey, value: boolean) => setChatPref(key, value), []);
  return [prefs, setPref];
}
