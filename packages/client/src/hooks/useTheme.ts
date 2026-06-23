import { useState, useLayoutEffect, useCallback } from "react";
import { piWebStorage } from "../lib/piWebStorage";

export type Theme = "light" | "dark";

const STORAGE_KEY = "pi-web-theme";

function readTheme(): Theme {
  const v = piWebStorage.getItem(STORAGE_KEY);
  if (v === "dark" || v === "light") return v;
  return "light";
}

function apply(theme: Theme) {
  document.documentElement.setAttribute("data-theme", theme);
}

// Singleton theme state so every useTheme consumer updates together.
let currentTheme: Theme = readTheme();
apply(currentTheme);

const listeners = new Set<(theme: Theme) => void>();
function emit(theme: Theme) {
  listeners.forEach((l) => l(theme));
}

function setStored(theme: Theme) {
  currentTheme = theme;
  apply(theme);
  piWebStorage.setItem(STORAGE_KEY, theme);
  emit(theme);
}

// Cross-tab + external updates (replaces the old `storage` event listener).
piWebStorage.subscribe(() => {
  const next = readTheme();
  if (next !== currentTheme) {
    currentTheme = next;
    apply(next);
    emit(next);
  }
});

export function useTheme(): [Theme, () => void, (theme: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>(currentTheme);

  useLayoutEffect(() => {
    const update = (t: Theme) => setThemeState(t);
    listeners.add(update);
    return () => {
      listeners.delete(update);
    };
  }, []);

  useLayoutEffect(() => {
    apply(theme);
  }, [theme]);

  const toggle = useCallback(() => {
    setStored(currentTheme === "light" ? "dark" : "light");
  }, []);

  const setTheme = useCallback((next: Theme) => {
    if (next === currentTheme) return;
    setStored(next);
  }, []);

  return [theme, toggle, setTheme];
}
