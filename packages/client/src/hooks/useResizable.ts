/**
 * Generic resize hook — adds drag-to-resize behavior to a panel.
 *
 * Usage:
 *   const { width, resizeHandleProps } = useResizable({ defaultWidth, minWidth, maxWidth, persistKey });
 *   <div style={{ width }}> ... </div>
 *   <div {...resizeHandleProps} />
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { piWebStorage } from "../lib/piWebStorage";

interface UseResizableOptions {
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  persistKey?: string;
}

export function useResizable(opts: UseResizableOptions) {
  const { defaultWidth, minWidth, maxWidth, persistKey } = opts;

  const [width, setWidth] = useState(() => {
    if (persistKey) {
      const v = piWebStorage.getItem(persistKey);
      if (v) {
        const n = parseInt(v, 10);
        if (!isNaN(n)) return Math.max(minWidth, Math.min(n, maxWidth));
      }
    }
    return defaultWidth;
  });

  const [isDragging, setIsDragging] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const widthRef = useRef(width);
  useEffect(() => { widthRef.current = width; }, [width]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsDragging(true);
      startXRef.current = e.clientX;
      startWidthRef.current = widthRef.current;
    },
    [],
  );

  useEffect(() => {
    if (!isDragging) return;

    const onMouseMove = (e: MouseEvent) => {
      // Resize from left edge = dragging left decreases width
      const delta = startXRef.current - e.clientX;
      const newWidth = startWidthRef.current + delta;
      const clamped = Math.max(minWidth, Math.min(newWidth, maxWidth));
      setWidth(clamped);
    };

    const onMouseUp = () => {
      setIsDragging(false);
      if (persistKey) {
        piWebStorage.setItem(persistKey, String(widthRef.current));
      }
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, [isDragging, minWidth, maxWidth, persistKey]);

  return {
    width,
    isDragging,
    handleMouseDown,
  };
}
