/**
 * Icon component — renders named SVG icons from a central path map.
 * Uses currentColor for fill/stroke so it inherits text color.
 *
 * Design principles (revamped):
 *  - Unified 16×16 grid for all UI icons (24×24 for sun/moon)
 *  - 2px stroke weight baseline; 1.5px for fine detail icons
 *  - round linecap + round linejoin everywhere for warmth
 *  - Optical padding: live area is ~12px, 2px inset on each side
 *  - Filled icons (kebab, abort, more, spark) use clean geometric shapes
 *  - No legacy "pi-avatar / pi-logo" placeholder icons
 */

import React from "react";

export interface IconProps {
  name: keyof typeof SVG_PATHS;
  size?: number;
  className?: string;
  "aria-hidden"?: boolean;
}

/* ─── Shared stroke defaults ─── */

interface IconDef {
  viewBox: string;
  fill: string;
  stroke: string;
  strokeWidth: string;
  strokeLinecap?: "inherit" | "round" | "butt" | "square";
  strokeLinejoin?: "inherit" | "round" | "miter" | "bevel";
  children: React.ReactNode;
}

const ROUND: Partial<IconDef> = {
  strokeLinecap: "round",
  strokeLinejoin: "round",
};

/* ─── Path definitions ─── */

const SVG_PATHS = {

  // ── Chevron left ──────────────────────────────────────────
  // Crisper single-stroke chevron with optical centre
  "chevron-left": {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    ...ROUND,
    children: <path d="M10.5 3.5 L5.5 8 L10.5 12.5" />,
  },

  // ── Chevron right ─────────────────────────────────────────
  "chevron-right": {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    ...ROUND,
    children: <path d="M5.5 3.5 L10.5 8 L5.5 12.5" />,
  },

  // ── Chevron down ──────────────────────────────────────────
  "chevron-down": {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    ...ROUND,
    children: <path d="M3.5 6 L8 10.5 L12.5 6" />,
  },

  // ── Chevron right small (solid filled caret) ──────────────
  // Replaced hairline path with a clean filled triangle
  "chevron-right-sm": {
    viewBox: "0 0 10 10",
    fill: "currentColor",
    stroke: "none",
    strokeWidth: "0",
    children: <polygon points="3,1.5 7.5,5 3,8.5" />,
  },

  // ── Chevron right small amber variant ─────────────────────
  "chevron-right-sm-amber": {
    viewBox: "0 0 10 10",
    fill: "currentColor",
    stroke: "none",
    strokeWidth: "0",
    children: <polygon points="3,2 7,5 3,8" />,
  },

  // ── Close / X ─────────────────────────────────────────────
  // Slightly extended diagonals for bolder presence
  close: {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.75",
    ...ROUND,
    children: <path d="M4.5 4.5 L11.5 11.5 M11.5 4.5 L4.5 11.5" />,
  },

  // ── Close thick ───────────────────────────────────────────
  "close-thick": {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2.25",
    ...ROUND,
    children: <path d="M4.5 4.5 L11.5 11.5 M11.5 4.5 L4.5 11.5" />,
  },

  // ── Home ──────────────────────────────────────────────────
  // Cleaner roofline, door centred and proportional
  home: {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.5",
    ...ROUND,
    children: (
      <>
        {/* Roof */}
        <path d="M2 7.5 L8 2 L14 7.5" />
        {/* Walls */}
        <path d="M3.5 6.5 L3.5 14 L12.5 14 L12.5 6.5" />
        {/* Door */}
        <path d="M6.5 14 L6.5 10.5 Q6.5 9.5 7.5 9.5 L8.5 9.5 Q9.5 9.5 9.5 10.5 L9.5 14" />
      </>
    ),
  },

  // ── Hash ──────────────────────────────────────────────────
  // Tighter glyph, true # proportions with slight slant
  hash: {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.75",
    ...ROUND,
    children: (
      <>
        <line x1="6" y1="2.5" x2="4.5" y2="13.5" />
        <line x1="11.5" y1="2.5" x2="10" y2="13.5" />
        <line x1="2.5" y1="6.5" x2="13.5" y2="6.5" />
        <line x1="2" y1="10.5" x2="13" y2="10.5" />
      </>
    ),
  },

  // ── Inbox ─────────────────────────────────────────────────
  // Proper tray shape: open top, slot for items
  inbox: {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.5",
    ...ROUND,
    children: (
      <>
        {/* Tray body */}
        <rect x="2" y="8" width="12" height="6" rx="1.5" />
        {/* Top slot flaps */}
        <path d="M2 9 L5.5 9 Q6 9 6.5 8 L7 7 L9 7 L9.5 8 Q10 9 10.5 9 L14 9" />
        {/* Envelope/letter peek */}
        <path d="M5 5.5 L8 3.5 L11 5.5" />
        <line x1="8" y1="3.5" x2="8" y2="6.5" />
      </>
    ),
  },

  // ── Kebab / vertical more ─────────────────────────────────
  // Slightly larger dots, better vertical rhythm
  kebab: {
    viewBox: "0 0 16 16",
    fill: "currentColor",
    stroke: "none",
    strokeWidth: "0",
    children: (
      <>
        <circle cx="8" cy="3.5" r="1.5" />
        <circle cx="8" cy="8" r="1.5" />
        <circle cx="8" cy="12.5" r="1.5" />
      </>
    ),
  },

  // ── Plus ──────────────────────────────────────────────────
  // Optically centred, equal arm lengths
  plus: {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.75",
    ...ROUND,
    children: <path d="M8 3 L8 13 M3 8 L13 8" />,
  },

  // ── Plus thick ────────────────────────────────────────────
  "plus-thick": {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2.5",
    ...ROUND,
    children: <path d="M8 3 L8 13 M3 8 L13 8" />,
  },

  // ── Refresh ───────────────────────────────────────────────
  // Full arc with proper gap and arrow direction reversed for clarity
  refresh: {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.75",
    ...ROUND,
    children: (
      <>
        <path d="M13.5 8 A5.5 5.5 0 1 1 10.5 3.2" />
        <polyline points="10.5 1 10.5 4 13.5 4" />
      </>
    ),
  },

  // ── Send arrow ────────────────────────────────────────────
  // Paper-plane diagonal send (feels more "send" than a flat arrow)
  send: {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.75",
    ...ROUND,
    children: (
      <path d="M13.5 2.5 L7 9 M13.5 2.5 L9.5 13.5 L7 9 L2.5 7.5 Z" />
    ),
  },

  // ── Abort / stop ──────────────────────────────────────────
  // Rounded square stop symbol (softer than pure rect)
  abort: {
    viewBox: "0 0 16 16",
    fill: "currentColor",
    stroke: "none",
    strokeWidth: "0",
    children: <rect x="3.5" y="3.5" width="9" height="9" rx="2" />,
  },

  // ── Copy offset ───────────────────────────────────────────
  // Classic two-page copy, clean gap between sheets
  "copy-offset": {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.5",
    ...ROUND,
    children: (
      <>
        <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
        <path d="M2.5 10.5 L2.5 2.5 L10.5 2.5" />
      </>
    ),
  },

  // ── Copy join ─────────────────────────────────────────────
  "copy-join": {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.5",
    ...ROUND,
    children: (
      <path d="M2 4.5 L2 12.5 Q2 13.5 3 13.5 L6.5 13.5 M6.5 4.5 L13 4.5 Q14 4.5 14 5.5 L14 12.5 Q14 13.5 13 13.5 L6.5 13.5 M6.5 2 L6.5 16" />
    ),
  },

  // ── Copy plain ────────────────────────────────────────────
  "copy-plain": {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.5",
    ...ROUND,
    children: <rect x="4" y="4" width="8" height="8" rx="1.5" />,
  },

  // ── Fork ──────────────────────────────────────────────────
  // Symmetrical Y-fork with curved transitions
  fork: {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.75",
    ...ROUND,
    children: (
      <path d="M8 2.5 L8 7 C8 9 5 10 3 13 M8 7 C8 9 11 10 13 13" />
    ),
  },

  // ── Fork left ─────────────────────────────────────────────
  "fork-left": {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.75",
    ...ROUND,
    children: (
      <path d="M3 3 L3 13 M3 7.5 C5.5 7 9 5 10.5 2.5 M3 7.5 C5.5 8 9 10 10.5 12.5" />
    ),
  },

  // ── Trash ─────────────────────────────────────────────────
  // Rounded lid + can body with two interior lines
  trash: {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.5",
    ...ROUND,
    children: (
      <>
        {/* Lid */}
        <path d="M2.5 5 L13.5 5" />
        <path d="M5.5 5 L6 3 L10 3 L10.5 5" />
        {/* Body */}
        <path d="M4 5 L4.5 13.5 L11.5 13.5 L12 5" />
        {/* Interior lines */}
        <line x1="6.5" y1="7" x2="6.5" y2="11.5" />
        <line x1="9.5" y1="7" x2="9.5" y2="11.5" />
      </>
    ),
  },

  // ── Pencil / edit ─────────────────────────────────────────
  // Proper pencil with a tip, eraser end, and body
  pencil: {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.5",
    ...ROUND,
    children: (
      <>
        {/* Body */}
        <path d="M3.5 12.5 L11 5 Q12 4 13 5 Q14 6 13 7 L5.5 14.5 Z" />
        {/* Tip crease */}
        <line x1="3.5" y1="12.5" x2="5.5" y2="14.5" />
        {/* Eraser band */}
        <line x1="10.3" y1="5.7" x2="12.3" y2="7.7" />
        {/* Ground line */}
        <path d="M2 14.5 L5.5 14.5" />
      </>
    ),
  },

  // ── Moon ──────────────────────────────────────────────────
  // Classic crescent with points trimmed for cleanliness
  moon: {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.75",
    ...ROUND,
    children: (
      <path d="M20.5 13.5 A9 9 0 1 1 10.5 3.5 A7 7 0 0 0 20.5 13.5 Z" />
    ),
  },

  // ── Sun ───────────────────────────────────────────────────
  // Slimmer rays, optical balance between circle and ray count
  sun: {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.75",
    ...ROUND,
    children: (
      <>
        <circle cx="12" cy="12" r="4.5" />
        <path d="M12 2.5v2 M12 19.5v2 M4.93 4.93l1.41 1.41 M17.66 17.66l1.41 1.41 M2.5 12h2 M19.5 12h2 M4.93 19.07l1.41-1.41 M17.66 6.34l1.41-1.41" />
      </>
    ),
  },

  // ── Search ────────────────────────────────────────────────
  // Slightly bigger lens circle, handle at 45°
  search: {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.75",
    ...ROUND,
    children: (
      <>
        <circle cx="6.5" cy="6.5" r="4" />
        <line x1="9.7" y1="9.7" x2="13.5" y2="13.5" />
      </>
    ),
  },

  // ── Project / folder ──────────────────────────────────────
  // Classic tabbed folder with a proper tab notch
  project: {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.5",
    ...ROUND,
    children: (
      <>
        {/* Tab */}
        <path d="M2 6.5 L2 4 Q2 3 3 3 L6.5 3 Q7 3 7.5 3.5 L8.5 5 L13 5 Q14 5 14 6 L14 13 Q14 14 13 14 L3 14 Q2 14 2 13 Z" />
      </>
    ),
  },

  // ── Grip / drag handle ───────────────────────────────────
  grip: {
    viewBox: "0 0 16 16",
    fill: "currentColor",
    stroke: "none",
    strokeWidth: "0",
    children: (
      <>
        <circle cx="5" cy="4" r="1" />
        <circle cx="11" cy="4" r="1" />
        <circle cx="5" cy="8" r="1" />
        <circle cx="11" cy="8" r="1" />
        <circle cx="5" cy="12" r="1" />
        <circle cx="11" cy="12" r="1" />
      </>
    ),
  },

  // ── Terminal ──────────────────────────────────────────────
  // Prompt chevron plus cursor underscore — pure text feel
  terminal: {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.5",
    ...ROUND,
    children: (
      <>
        <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
        <polyline points="4 6.5 6.5 8 4 9.5" />
        <line x1="8" y1="9.5" x2="11.5" y2="9.5" />
      </>
    ),
  },

  // ── Git branch ────────────────────────────────────────────
  // Standard git branch diagram — commit dots + connecting paths
  git: {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.5",
    ...ROUND,
    children: (
      <>
        <circle cx="5" cy="3.5" r="1.5" />
        <circle cx="5" cy="12.5" r="1.5" />
        <circle cx="11.5" cy="4" r="1.5" />
        <line x1="5" y1="5" x2="5" y2="11" />
        <path d="M11.5 5.5 C11.5 8.5 5 8 5 11" />
      </>
    ),
  },

  // ── Minus ─────────────────────────────────────────────────
  minus: {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.75",
    ...ROUND,
    children: <line x1="3" y1="8" x2="13" y2="8" />,
  },

  // ── Spark / lightning bolt ────────────────────────────────
  // Sharper zigzag with better proportions
  spark: {
    viewBox: "0 0 16 16",
    fill: "currentColor",
    stroke: "none",
    strokeWidth: "0",
    children: (
      <path d="M10 1.5 L4 9 L7.5 9 L6 14.5 L12 7 L8.5 7 Z" />
    ),
  },

  // ── Undo ──────────────────────────────────────────────────
  // Arc with a clear arrowhead direction
  undo: {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.5",
    ...ROUND,
    children: (
      <>
        <path d="M3.5 8.5 A5 5 0 1 1 7 14" />
        <polyline points="1.5 5 3.5 8.5 7 7" />
      </>
    ),
  },

  // ── More / horizontal ellipsis ────────────────────────────
  more: {
    viewBox: "0 0 16 16",
    fill: "currentColor",
    stroke: "none",
    strokeWidth: "0",
    children: (
      <>
        <circle cx="3.5" cy="8" r="1.5" />
        <circle cx="8" cy="8" r="1.5" />
        <circle cx="12.5" cy="8" r="1.5" />
      </>
    ),
  },

  // ── Compress / collapse ───────────────────────────────────
  // Two inward-pointing arrows in opposite corners
  compress: {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.5",
    ...ROUND,
    children: (
      <>
        <polyline points="5.5 1.5 1.5 1.5 1.5 5.5" />
        <line x1="1.5" y1="1.5" x2="6" y2="6" />
        <polyline points="10.5 14.5 14.5 14.5 14.5 10.5" />
        <line x1="14.5" y1="14.5" x2="10" y2="10" />
      </>
    ),
  },

  // ── Auto-compact ──────────────────────────────────────────
  // Same compress glyph + arc for "auto" hint
  "auto-compact": {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.5",
    ...ROUND,
    children: (
      <>
        <polyline points="5.5 1.5 1.5 1.5 1.5 5.5" />
        <line x1="1.5" y1="1.5" x2="6" y2="6" />
        <polyline points="10.5 14.5 14.5 14.5 14.5 10.5" />
        <line x1="14.5" y1="14.5" x2="10" y2="10" />
        {/* Auto arc hint — top right */}
        <path d="M9 3.5 A4 4 0 0 1 13 7.5" />
        <polyline points="13 5.5 13 7.5 11 7.5" />
      </>
    ),
  },

  // ── Export / upload ───────────────────────────────────────
  // Box with up-arrow, clear directional intent
  export: {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.5",
    ...ROUND,
    children: (
      <>
        <path d="M2.5 10.5 L2.5 13 Q2.5 13.5 3 13.5 L13 13.5 Q13.5 13.5 13.5 13 L13.5 10.5" />
        <line x1="8" y1="2" x2="8" y2="10" />
        <polyline points="5 4.5 8 2 11 4.5" />
      </>
    ),
  },

  // ── Clone / duplicate ─────────────────────────────────────
  // Two offset rounded rects with a clear stack read
  clone: {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.5",
    ...ROUND,
    children: (
      <>
        <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
        <path d="M3 10.5 L2 10.5 Q1 10.5 1 9.5 L1 2.5 Q1 1.5 2 1.5 L9 1.5 Q10 1.5 10 2.5 L10 3.5" />
      </>
    ),
  },

  // ── Folder ────────────────────────────────────────────────
  folder: {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.5",
    ...ROUND,
    children: (
      <>
        <path d="M2 6.5 L2 4 Q2 3 3 3 L6.5 3 Q7 3 7.5 3.5 L8.5 5 L13 5 Q14 5 14 6 L14 13 Q14 14 13 14 L3 14 Q2 14 2 13 Z" />
      </>
    ),
  },

  // ── Pi logo ───────────────────────────────────────────────
  "pi-logo": {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.5",
    ...ROUND,
    children: (
      <>
        <path d="M4 5 L12 5" />
        <path d="M6.5 5 L6.5 12" />
        <path d="M9.5 5 L9.5 12" />
      </>
    ),
  },

  // ── Pi avatar ─────────────────────────────────────────────
  "pi-avatar": {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.5",
    ...ROUND,
    children: (
      <>
        <circle cx="8" cy="5.5" r="2.5" />
        <path d="M3.5 13 Q8 9 12.5 13" />
      </>
    ),
  },

  // ── Download ──────────────────────────────────────────────
  download: {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.5",
    ...ROUND,
    children: (
      <>
        <path d="M8 3 L8 10 M5 7 L8 10 L11 7" />
        <path d="M3 12.5 L13 12.5" />
      </>
    ),
  },

  // ── Arrow up (popularity) ──────────────────────────────
  "arrow-up": {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.5",
    ...ROUND,
    children: (
      <>
        <path d="M8 13 L8 3 M4 7 L8 3 L12 7" />
      </>
    ),
  },

  // ── Clock (recency) ─────────────────────────────────────
  "clock": {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.5",
    ...ROUND,
    children: (
      <>
        <circle cx="8" cy="8" r="6" />
        <path d="M8 4.5 L8 8 L10.5 9.5" />
      </>
    ),
  },

  // ── Puzzle piece / extensions ────────────────────────────
  "puzzle": {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.5",
    ...ROUND,
    children: (
      <>
        <path d="M5.5 14 L2 14 Q1.5 14 1.5 13.5 L1.5 10 Q1.5 9.5 2 9.5 L3 9.5 Q4 9.5 4 8.5 Q4 7.5 3 7.5 L2 7.5 Q1.5 7.5 1.5 7 L1.5 3.5 Q1.5 3 2 3 L5.5 3 Q6 3 6 3.5 L6 4 Q6 5 7 5 Q8 5 8 4 L8 3.5 Q8 3 8.5 3 L13.5 3 Q14 3 14 3.5 L14 7 Q14 7.5 13.5 7.5 L12.5 7.5 Q11.5 7.5 11.5 8.5 Q11.5 9.5 12.5 9.5 L13.5 9.5 Q14 9.5 14 10 L14 13.5 Q14 14 13.5 14 L10 14 Q9.5 14 9.5 13.5 L9.5 12.5 Q9.5 11.5 8.5 11.5 Q7.5 11.5 7.5 12.5 L7.5 13.5 Q7.5 14 7 14 Z" />
      </>
    ),
  },

  // ── File / document ──────────────────────────────────────
  file: {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.5",
    ...ROUND,
    children: (
      <>
        <path d="M4 2 L9 2 L13 6 L13 14 Q13 14.5 12.5 14.5 L3.5 14.5 Q3 14.5 3 14 L3 2.5 Q3 2 3.5 2 Z" />
        <path d="M9 2 L9 5.5 Q9 6 9.5 6 L13 6" />
      </>
    ),
  },

} as const satisfies Record<string, IconDef>;

/* ─── Component ─── */

export type IconName = keyof typeof SVG_PATHS;

export function Icon({
  name,
  size = 16,
  className,
  "aria-hidden": ariaHidden = true,
}: IconProps) {
  const def = SVG_PATHS[name] as IconDef;

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
      aria-hidden={ariaHidden}
    >
      {def.children}
    </svg>
  );
}