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

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(getStored);

  useLayoutEffect(() => { apply(theme); }, [theme]);

  const toggle = useCallback(() => {
    setTheme(t => (t === "light" ? "dark" : "light"));
  }, []);

  return [theme, toggle];
}
