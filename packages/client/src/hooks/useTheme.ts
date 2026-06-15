import { useState, useLayoutEffect, useCallback } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "pi-web-theme";

function getStored(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "dark" || v === "light") return v;
  } catch {}
  return "light";
}

function apply(theme: Theme) {
  document.documentElement.setAttribute("data-theme", theme);
  try { localStorage.setItem(STORAGE_KEY, theme); } catch {}
}

// Singleton theme state so every useTheme consumer updates together.
let currentTheme: Theme = getStored();
const listeners = new Set<(theme: Theme) => void>();

function emit(theme: Theme) {
  listeners.forEach((l) => l(theme));
}

function setStored(theme: Theme) {
  currentTheme = theme;
  apply(theme);
  emit(theme);
}

apply(currentTheme);

export function useTheme(): [Theme, () => void, (theme: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>(currentTheme);

  useLayoutEffect(() => {
    const update = (t: Theme) => setThemeState(t);
    listeners.add(update);
    // Listen for changes from other tabs.
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      const next = e.newValue;
      if (next === "light" || next === "dark") {
        currentTheme = next;
        apply(next);
        emit(next);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(update);
      window.removeEventListener("storage", onStorage);
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
