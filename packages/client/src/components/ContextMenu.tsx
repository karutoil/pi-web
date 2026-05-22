import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";

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
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) close();
    };
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handler);
      document.addEventListener("contextmenu", handler);
    }, 10);
    const keyHandler = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", keyHandler);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("contextmenu", handler);
      document.removeEventListener("keydown", keyHandler);
    };
  }, [onClose]);

  const [pos, setPos] = useState({ x, y });
  useEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const cx = x + rect.width > window.innerWidth ? x - rect.width : x;
    const cy = y + rect.height > window.innerHeight ? y - rect.height : y;
    setPos({ x: Math.max(4, cx), y: Math.max(4, cy) });
  }, [x, y]);

  return createPortal(
    <div
      ref={menuRef}
      style={{ position: "fixed", left: pos.x, top: pos.y, zIndex: 9999 }}
      className="bg-ink-900 border border-ink-700 rounded-lg shadow-2xl py-1 min-w-[160px] animate-fade-in-up"
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
      className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2.5 transition-theme ${
        danger
          ? "text-rose-400 hover:bg-rose-600/10 hover:text-rose-300"
          : "text-ink-300 hover:bg-ink-800 hover:text-ink-100"
      }`}
    >
      {icon && <span className="shrink-0 w-3 flex justify-center">{icon}</span>}
      <span className="flex-1">{label}</span>
      {shortcut && <span className="text-ink-600 text-[0.6rem] font-mono ml-2">{shortcut}</span>}
    </button>
  );
}

export function ContextMenuDivider() {
  return <div className="border-t border-ink-800 my-0.5" />;
}
