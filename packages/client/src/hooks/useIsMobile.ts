import { useState, useEffect } from "react";

const MOBILE_BREAKPOINT = 768;

export function useIsMobile(breakpoint = MOBILE_BREAKPOINT): boolean {
  const [isMobile, setIsMobile] = useState(
    typeof window !== "undefined" ? window.matchMedia(`(max-width: ${breakpoint}px)`).matches : false
  );

  useEffect(() => {
    const mql = typeof window !== "undefined"
      ? window.matchMedia(`(max-width: ${breakpoint}px)`)
      : { matches: false, addEventListener: () => {}, removeEventListener: () => {} } as any;
    setIsMobile(mql.matches);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [breakpoint]);

  return isMobile;
}
