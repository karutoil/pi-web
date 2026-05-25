import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";

// ─── Long-press hook for mobile context menus ───

export function useLongPress(onLongPress: (e: { clientX: number; clientY: number }) => void, delay = 500) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const posRef = useRef<{ x: number; y: number } | null>(null);
  const MOVE_THRESHOLD = 10;

  const onTouchStart = (e: React.TouchEvent) => {
    const touch = e.touches[0];
    posRef.current = { x: touch.clientX, y: touch.clientY };
    timerRef.current = setTimeout(() => {
      if (posRef.current) {
        onLongPress({ clientX: posRef.current.x, clientY: posRef.current.y });
      }
    }, delay);
  };

  const onTouchMove = (e: React.TouchEvent) => {
    if (!posRef.current || !timerRef.current) return;
    const touch = e.touches[0];
    const dx = Math.abs(touch.clientX - posRef.current.x);
    const dy = Math.abs(touch.clientY - posRef.current.y);
    if (dx > MOVE_THRESHOLD || dy > MOVE_THRESHOLD) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const onTouchEnd = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  return { onTouchStart, onTouchMove, onTouchEnd };
}

// ─── Portal-rendered right-click context menu at cursor position ───

export function ContextMenuPortal({
  x,
  y,
  onClose,
  children,
}: {
  x: number;
  y: number;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = () => onClose();
    const handler = (e: MouseEvent | TouchEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) close();
    };
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handler);
      document.addEventListener("touchend", handler);
      document.addEventListener("contextmenu", handler);
    }, 10);
    const keyHandler = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", keyHandler);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("touchend", handler);
      document.removeEventListener("contextmenu", handler);
      document.removeEventListener("keydown", keyHandler);
    };
  }, [onClose]);

  // Pre-calculate safe position — estimate menu size to avoid off-screen placement
  const vw = typeof window !== "undefined" ? window.innerWidth : 800;
  const vh = typeof window !== "undefined" ? window.innerHeight : 600;

  const [pos, setPos] = useState({ x: Math.max(8, x), y: Math.max(8, y) });
  useEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const maxLeft = vw - rect.width - 8;
    const maxTop = vh - rect.height - 8;
    const clampedLeft = Math.min(Math.max(x, 8), maxLeft);
    const clampedTop = Math.min(Math.max(y, 8), maxTop);
    setPos({ x: clampedLeft, y: clampedTop });
  }, [x, y, vw, vh]);

  return createPortal(
    <div
      ref={menuRef}
      style={{ position: "fixed", left: pos.x, top: pos.y, zIndex: 50 }}
      className="bg-ink-900 border border-ink-700 rounded-lg shadow-2xl py-1 min-w-[160px] animate-fade-in-up touch-none"
    >
      {children}
    </div>,
    document.body
  );
}

export function ContextMenuItem({
  label,
  icon,
  shortcut,
  danger,
  onClick,
}: {
  label: string;
  icon?: React.ReactNode;
  shortcut?: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={e => { e.stopPropagation(); onClick(); }}
      className={`w-full text-left px-3 py-2.5 min-h-[44px] text-xs flex items-center gap-2.5 transition-theme ${
        danger
          ? "text-rose-400 hover:bg-rose-600/10 hover:text-rose-300"
          : "text-ink-300 hover:bg-ink-800 hover:text-ink-100"
      }`}
    >
      {icon && <span className="shrink-0 w-3 flex justify-center">{icon}</span>}
      <span className="flex-1">{label}</span>
      {shortcut && <span className="text-ink-500 text-[0.65rem] font-mono ml-2 hidden sm:block">{shortcut}</span>}
    </button>
  );
}

export function ContextMenuDivider() {
  return <div className="border-t border-ink-800 my-0.5" />;
}
