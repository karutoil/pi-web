/**
 * Icon component — renders named SVG icons from a central path map.
 * Uses currentColor for fill/stroke so it inherits text color.
 * Keeps viewBox/paths identical to the original inline SVGs.
 */

export interface IconProps {
  name: keyof typeof SVG_PATHS;
  size?: number;
  className?: string;
}

/* ─── Path definitions ─── */

interface IconDef {
  viewBox: string;
  fill: string;
  stroke: string;
  strokeWidth: string;
  strokeLinecap?: "inherit" | "round" | "butt" | "square";
  strokeLinejoin?: "inherit" | "round" | "miter" | "bevel";
  children: React.ReactNode;
}

const SVG_PATHS: Record<string, IconDef> = {
  // ── Navigation chevrons (viewBox 0 0 16 16) ──
  "chevron-left": {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2.5",
    children: <path d="M10 4 L6 8 L10 12" />,
  },
  "chevron-right": {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2.5",
    children: <path d="M6 4 L10 8 L6 12" />,
  },

  // ── Small caret (viewBox 0 0 10 10) used for collapsible sections ──
  "chevron-right-sm": {
    viewBox: "0 0 10 10",
    fill: "currentColor",
    stroke: "none",
    strokeWidth: "0",
    children: <path d="M3 1 L7 5 L3 9" />,
  },
  "chevron-right-sm-amber": {
    viewBox: "0 0 10 10",
    fill: "currentColor",
    stroke: "none",
    strokeWidth: "0",
    children: <path d="M3 2 L7 5 L3 8" />,
  },

  // ── Close / X (viewBox 0 0 16 16) ──
  close: {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    children: <path d="M4 4 L12 12 M12 4 L4 12" />,
  },
  "close-thick": {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2.5",
    children: <path d="M4 4 L12 12 M12 4 L4 12" />,
  },

  // ── Plus (viewBox 0 0 16 16) ──
  plus: {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    children: <path d="M8 3 L8 13 M3 8 L13 8" />,
  },
  "plus-thick": {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2.5",
    children: <path d="M8 3 L8 13 M3 8 L13 8" />,
  },

  // ── Refresh (viewBox 0 0 16 16) ──
  refresh: {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    children: (
      <>
        <path d="M2 8 A6 6 0 1 1 8 14" />
        <path d="M2 8 L2 4 L5 6" />
      </>
    ),
  },

  // ── Send arrow (viewBox 0 0 16 16) ──
  send: {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2.5",
    children: <path d="M2 8 L12 8 M8 4 L13 8 L8 12" />,
  },

  // ── Abort / stop (viewBox 0 0 16 16) ──
  abort: {
    viewBox: "0 0 16 16",
    fill: "currentColor",
    stroke: "none",
    strokeWidth: "0",
    children: <rect x="3" y="3" width="10" height="10" rx="1" />,
  },

  // ── Copy (viewBox 0 0 16 16) — copy-with-offset ──
  "copy-offset": {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    children: (
      <>
        <rect x="5" y="5" width="8" height="8" rx="1" />
        <path d="M3 11 L3 3 L11 3" />
      </>
    ),
  },
  "copy-join": {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    children: <path d="M2 4 L2 12 L6 12 M6 4 L14 4 L14 12 L6 12" />,
  },
  "copy-plain": {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    children: <rect x="4" y="4" width="8" height="8" rx="1" />,
  },

  // ── Fork (viewBox 0 0 16 16) ──
  fork: {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    children: <path d="M8 3 L8 8 L3 13 M8 8 L13 13" />,
  },
  "fork-left": {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    children: <path d="M3 5 L3 13 M3 8 L8 3 M3 8 L8 13" />,
  },

  // ── Trash (viewBox 0 0 16 16) ──
  trash: {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    children: <path d="M3 5 L13 5 M6 5 L6 3 L10 3 L10 5 M5 5 L5 13 L11 13 L11 5" />,
  },

  // ── Edit / pencil (viewBox 0 0 16 16) ──
  pencil: {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    children: <path d="M12 3 L5 13 M3 10 L5 13 L8 12" />,
  },

  // ── Moon (viewBox 0 0 24 24) ──
  moon: {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.8",
    strokeLinecap: "round",
    children: <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />,
  },

  // ── Sun (viewBox 0 0 24 24) ──
  sun: {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.8",
    strokeLinecap: "round",
    children: (
      <>
        <circle cx="12" cy="12" r="5" />
        <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
      </>
    ),
  },

  // ── Search (viewBox 0 0 16 16) ──
  search: {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    children: (
      <>
        <circle cx="7" cy="7" r="4" />
        <path d="M10 10 L14 14" />
      </>
    ),
  },

  // ── Project / folder (viewBox 0 0 16 16) ──
  project: {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    children: (
      <>
        <path d="M2 13 L2 3 L14 3 L14 13 Z" />
        <path d="M2 7 L14 7" />
      </>
    ),
  },

  // ── PI avatar (viewBox 0 0 128 128) — used for assistant bubble ──
  "pi-avatar": {
    viewBox: "0 0 128 128",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "0", // paths carry their own stroke classes
    children: (
      <>
        <circle cx="64" cy="64" r="56" stroke="currentColor" strokeWidth="8" className="text-amber-500" />
        <path d="M48 56 L64 36 L80 56" stroke="currentColor" strokeWidth="4" strokeLinecap="round" className="text-amber-400" />
      </>
    ),
  },

  // ── PI logo large (viewBox 0 0 128 128) — ChatView empty state ──
  "pi-logo": {
    viewBox: "0 0 128 128",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "0",
    children: (
      <>
        <circle cx="64" cy="64" r="60" stroke="currentColor" strokeWidth="6" className="text-amber-600" />
        <path d="M44 52 L64 32 L84 52" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" className="text-amber-500" />
        <path d="M64 32 L64 88" stroke="currentColor" strokeWidth="4" strokeLinecap="round" className="text-amber-500" />
        <circle cx="64" cy="88" r="4" className="fill-amber-500" />
      </>
    ),
  },
};

/* ─── Component ─── */

export function Icon({ name, size = 16, className }: IconProps) {
  const def = SVG_PATHS[name];
  if (!def) {
    if (process.env.NODE_ENV === "development") {
      console.warn(`[Icon] Unknown icon name: "${name}"`);
    }
    return null;
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox={def.viewBox}
      fill={def.fill}
      stroke={def.stroke}
      strokeWidth={def.strokeWidth}
      strokeLinecap={def.strokeLinecap}
      strokeLinejoin={def.strokeLinejoin}
      className={className}
    >
      {def.children}
    </svg>
  );
}
