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

  // ── Terminal (viewBox 0 0 16 16) ──
  terminal: {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.5",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    children: (
      <>
        <rect x="1" y="2" width="14" height="12" rx="2" />
        <polyline points="4 6 6 8 4 10" />
        <line x1="8" y1="10" x2="12" y2="10" />
      </>
    ),
  },

  // ── Git branch (viewBox 0 0 16 16) ──
  git: {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.5",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    children: (
      <>
        <circle cx="5" cy="3" r="1.5" />
        <circle cx="5" cy="13" r="1.5" />
        <circle cx="12" cy="3" r="1.5" />
        <line x1="5" y1="4.5" x2="5" y2="11.5" />
        <path d="M12 4.5C12 7 5 8 5 11.5" />
      </>
    ),
  },

  // ── Minus (viewBox 0 0 16 16) ──
  minus: {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    strokeLinecap: "round",
    children: <line x1="3" y1="8" x2="13" y2="8" />,
  },

  // ── Undo (viewBox 0 0 16 16) ──
  undo: {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.5",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    children: (
      <>
        <path d="M3 7h6a4 4 0 110 8H7" />
        <polyline points="5 5 3 7 5 9" />
      </>
    ),
  },

  // ── More / ellipsis (viewBox 0 0 16 16) ──
  more: {
    viewBox: "0 0 16 16",
    fill: "currentColor",
    stroke: "none",
    strokeWidth: "0",
    children: (
      <>
        <circle cx="3" cy="8" r="1.5" />
        <circle cx="8" cy="8" r="1.5" />
        <circle cx="13" cy="8" r="1.5" />
      </>
    ),
  },

  // ── Compress / compact (viewBox 0 0 16 16) ──
  compress: {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.5",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    children: (
      <>
        <polyline points="6 2 2 2 2 6" />
        <line x1="2" y1="2" x2="5.5" y2="5.5" />
        <polyline points="10 14 14 14 14 10" />
        <line x1="14" y1="14" x2="10.5" y2="10.5" />
      </>
    ),
  },

  // ── Auto-compaction (viewBox 0 0 16 16) ──
  "auto-compact": {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.5",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    children: (
      <>
        <polyline points="6 2 2 2 2 6" />
        <line x1="2" y1="2" x2="5.5" y2="5.5" />
        <polyline points="10 14 14 14 14 10" />
        <line x1="14" y1="14" x2="10.5" y2="10.5" />
        <path d="M8 3a5 5 0 0 1 4.5 2.8" />
      </>
    ),
  },

  // ── Export (viewBox 0 0 16 16) ──
  export: {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.5",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    children: (
      <>
        <path d="M2 10v3a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-3" />
        <polyline points="5 5 8 2 11 5" />
        <line x1="8" y1="2" x2="8" y2="10" />
      </>
    ),
  },

  // ── Clone / copy (viewBox 0 0 16 16) ──
  clone: {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.5",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    children: (
      <>
        <rect x="5" y="5" width="8" height="8" rx="1" />
        <path d="M3 11H2.5A1.5 1.5 0 0 1 1 9.5v-7A1.5 1.5 0 0 1 2.5 1h7A1.5 1.5 0 0 1 11 2.5V3" />
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
