import { useState, useRef, useEffect, useCallback } from "react";
import type { Project } from "@pi-web/shared";
import { Icon } from "./Icon";
import { ContextMenuPortal, ContextMenuItem, ContextMenuDivider, useLongPress } from "./ContextMenu";

/**
 * Discord-style server rail — narrow vertical column of "stamps" that
 * represent projects. Active project stamp comes forward with an amber
 * edge; unreads and streaming sessions register as small dots on the
 * stamp's corner. Aesthetic reframe: instead of colored circles, each
 * stamp is a small letterpress tile — rounded square with a serif
 * monogram and a subtle ink-stained border, the editorial counterpart
 * of Discord's round server icons.
 */

interface ServerRailProps {
  projects: Project[];
  selectedProject: Project | null;
  streamingProjectIds: Set<string>;
  isAddingProject: boolean;
  onSelectProject: (p: Project) => void;
  onSelectHome: () => void;
  onAddProject: () => void;
  onDeleteProject: (id: string) => void;
  isHomeActive: boolean;
  onRequestConfirm: (title: string, message: string, onConfirm: () => void) => void;
  collapsed?: boolean;
  onExpand?: () => void;
}

const STAMP_SIZE = 48; // px
const RAIL_WIDTH = 72; // px

// ─── Derive a 1- or 2-character monogram for a project name ───
// Prefer the first letter of each of the first two words; fall back to
// the first two chars. "pi web" → "PW", "pi" → "PI", "my-cool-app" → "MC".
function projectInitials(name: string): string {
  const words = name
    .replace(/[-_./]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  const clean = name.replace(/[^a-zA-Z0-9]/g, "");
  if (!clean) return "·";
  if (clean.length === 1) return clean.toUpperCase();
  return (clean[0] + clean[1]).toUpperCase();
}

// ─── Single project stamp (the rail's row) ───

interface ProjectStampProps {
  project: Project;
  index: number;
  active: boolean;
  streaming: boolean;
  collapsed: boolean;
  onSelect: (p: Project) => void;
  onRequestConfirm: (title: string, message: string, onConfirm: () => void) => void;
  onDelete: (id: string) => void;
}

function ProjectStamp({
  project,
  index,
  active,
  streaming,
  collapsed,
  onSelect,
  onRequestConfirm,
  onDelete,
}: ProjectStampProps) {
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const longPress = useLongPress(e => setCtxMenu({ x: e.clientX, y: e.clientY }));

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  };

  const displayName = project.name;
  const pathShort = project.path.length > 36
    ? "…" + project.path.slice(-35)
    : project.path;

  return (
    <div
      className="relative group/stamp overflow-x-hidden"
      style={{ animationDelay: `${index * 28}ms` }}
      data-rail-stamp
    >
      {/* Active rail-marker — Discord-style rounded bar on the rail's left edge.
          Anchored to the stamp's container (which spans the full rail width),
          NOT the button — otherwise the -left offset pushes the marker outside
          the 72px rail and triggers a horizontal scrollbar. */}
      <span
        className={[
          "absolute left-0 top-1/2 -translate-y-1/2 h-5 w-[3px] rounded-r-full",
          "transition-all duration-200 ease-out pointer-events-none",
          active ? "h-7 bg-amber-500 opacity-100" : "h-2 bg-ink-500 opacity-0 group-hover/stamp:opacity-60",
        ].join(" ")}
        aria-hidden
      />
      <button
        onClick={() => onSelect(project)}
        onContextMenu={handleContextMenu}
        {...longPress}
        title={collapsed ? displayName : undefined}
        aria-label={`Open project ${displayName}`}
        aria-current={active ? "true" : undefined}
        className={[
          "relative flex items-center justify-center w-12 h-12 mx-auto rounded-[14px]",
          "transition-all duration-200 ease-out outline-none",
          // Default state — paper-tile
          "bg-ink-850/60 border border-ink-700/70",
          "text-ink-200 hover:text-ink-100",
          "hover:bg-ink-800 hover:border-ink-600",
          "hover:-translate-y-[1px] hover:shadow-[0_4px_10px_-2px_rgba(0,0,0,0.35)]",
          "active:translate-y-0",
          // Active: amber-tinted, comes forward
          active && "bg-ink-900 border-amber-500/55 text-amber-500",
          active && "shadow-[0_6px_14px_-3px_rgba(212,160,32,0.25),inset_0_0_0_1px_rgba(212,160,32,0.18)]",
          active && "-translate-y-[1px]",
          // Focus ring
          "focus-visible:ring-2 focus-visible:ring-amber-500/45 focus-visible:ring-offset-2 focus-visible:ring-offset-ink-900",
        ].filter(Boolean).join(" ")}
        style={{ fontFamily: "var(--font-serif)" }}
      >
        {/* Initials */}
        <span className="text-[0.95rem] font-semibold tracking-tight leading-none select-none">
          {projectInitials(displayName)}
        </span>

        {/* Unread / streaming dot — top right corner */}
        {streaming && (
          <span
            className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-amber-500 ring-2 ring-ink-900 animate-pulse-subtle"
            title="PI is running here"
            aria-label="PI is running in this project"
          />
        )}

        {/* Subtle inner ink-bleed for the warm-editorial feel */}
        <span
          className="pointer-events-none absolute inset-0 rounded-[14px]"
          style={{
            background: "radial-gradient(circle at 30% 25%, rgba(255,255,255,0.04) 0%, transparent 55%)",
          }}
          aria-hidden
        />
      </button>

      {/* Tooltip — only on collapsed rail (otherwise label is part of expanded list) */}
      {collapsed && (
        <div
          className={[
            "pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-3 z-50",
            "px-2.5 py-1.5 rounded-md whitespace-nowrap",
            "bg-ink-950 border border-ink-700 shadow-lg shadow-ink-950/60",
            "text-ink-100 text-xs font-medium",
            "opacity-0 -translate-x-1 group-hover/stamp:opacity-100 group-hover/stamp:translate-x-0",
            "transition-all duration-150 ease-out",
          ].join(" ")}
          role="tooltip"
        >
          <div className="leading-none" style={{ fontFamily: "var(--font-serif)" }}>
            {displayName}
          </div>
          <div className="text-ink-500 text-[0.6rem] font-mono mt-0.5 leading-none">
            {pathShort}
          </div>
          {/* Pointer */}
          <span
            className="absolute -left-1 top-1/2 -translate-y-1/2 w-2 h-2 rotate-45 bg-ink-950 border-l border-b border-ink-700"
            aria-hidden
          />
        </div>
      )}

      {ctxMenu && (
        <ContextMenuPortal
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
        >
          <ContextMenuItem
            label="Open"
            icon={<Icon name="chevron-right" size={10} />}
            onClick={() => { setCtxMenu(null); onSelect(project); }}
          />
          <ContextMenuDivider />
          <ContextMenuItem
            label="Remove project"
            danger
            icon={<Icon name="trash" size={10} />}
            onClick={() => {
              setCtxMenu(null);
              onRequestConfirm(
                "Remove project",
                `Remove "${displayName}"? This cannot be undone.`,
                () => onDelete(project.id),
              );
            }}
          />
        </ContextMenuPortal>
      )}
    </div>
  );
}

// ─── Home stamp (top of rail — toggles to the projects overview) ───

function HomeStamp({
  active,
  collapsed,
  onClick,
}: {
  active: boolean;
  collapsed: boolean;
  onClick: () => void;
}) {
  return (
    <div className="relative group/home overflow-x-hidden" data-rail-stamp>
      <span
        className={[
          "absolute left-0 top-1/2 -translate-y-1/2 h-5 w-[3px] rounded-r-full transition-all duration-200 pointer-events-none",
          active ? "h-7 bg-amber-500 opacity-100" : "h-2 bg-ink-500 opacity-0 group-hover/home:opacity-60",
        ].join(" ")}
        aria-hidden
      />
      <button
        onClick={onClick}
        title={collapsed ? "All projects" : undefined}
        aria-label="All projects"
        aria-current={active ? "true" : undefined}
        className={[
          "relative flex items-center justify-center w-12 h-12 mx-auto rounded-[14px]",
          "transition-all duration-200 ease-out outline-none",
          "border",
          active
            ? "bg-ink-900 border-amber-500/55 text-amber-500 shadow-[0_6px_14px_-3px_rgba(212,160,32,0.25),inset_0_0_0_1px_rgba(212,160,32,0.18)] -translate-y-[1px]"
            : "bg-ink-850/60 border-ink-700/70 text-ink-300 hover:text-ink-100 hover:bg-ink-800 hover:border-ink-600 hover:-translate-y-[1px] hover:shadow-[0_4px_10px_-2px_rgba(0,0,0,0.35)]",
          "focus-visible:ring-2 focus-visible:ring-amber-500/45 focus-visible:ring-offset-2 focus-visible:ring-offset-ink-900",
        ].join(" ")}
      >
        <Icon name="home" size={20} />
      </button>
      {collapsed && (
        <div
          className="pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-3 z-50 px-2.5 py-1.5 rounded-md whitespace-nowrap bg-ink-950 border border-ink-700 shadow-lg shadow-ink-950/60 text-ink-100 text-xs font-medium opacity-0 -translate-x-1 group-hover/home:opacity-100 group-hover/home:translate-x-0 transition-all duration-150 ease-out"
          role="tooltip"
        >
          <div className="leading-none" style={{ fontFamily: "var(--font-serif)" }}>All projects</div>
          <span className="absolute -left-1 top-1/2 -translate-y-1/2 w-2 h-2 rotate-45 bg-ink-950 border-l border-b border-ink-700" aria-hidden />
        </div>
      )}
    </div>
  );
}

// ─── Add-project stamp (bottom of rail) ───

function AddStamp({
  onClick,
  collapsed,
  loading,
}: {
  onClick: () => void;
  collapsed: boolean;
  loading: boolean;
}) {
  return (
    <div className="relative group/add" data-rail-stamp>
      <button
        onClick={onClick}
        disabled={loading}
        title={collapsed ? "Add project" : undefined}
        aria-label="Add project"
        className={[
          "relative flex items-center justify-center w-12 h-12 mx-auto rounded-[14px]",
          "transition-all duration-200 ease-out outline-none",
          "border border-dashed border-ink-600/60",
          "text-ink-500 hover:text-amber-500 hover:border-amber-500/55 hover:bg-amber-500/[0.04]",
          "focus-visible:ring-2 focus-visible:ring-amber-500/45 focus-visible:ring-offset-2 focus-visible:ring-offset-ink-900",
          "disabled:opacity-50 disabled:cursor-wait",
        ].join(" ")}
      >
        {loading ? (
          <div className="w-3.5 h-3.5 rounded-full border-2 border-ink-600 border-t-amber-500 animate-spin" />
        ) : (
          <Icon name="plus" size={20} strokeWidth={2} />
        )}
      </button>
      {collapsed && (
        <div
          className="pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-3 z-50 px-2.5 py-1.5 rounded-md whitespace-nowrap bg-ink-950 border border-ink-700 shadow-lg shadow-ink-950/60 text-ink-100 text-xs font-medium opacity-0 -translate-x-1 group-hover/add:opacity-100 group-hover/add:translate-x-0 transition-all duration-150 ease-out"
          role="tooltip"
        >
          Add project
          <span className="absolute -left-1 top-1/2 -translate-y-1/2 w-2 h-2 rotate-45 bg-ink-950 border-l border-b border-ink-700" aria-hidden />
        </div>
      )}
    </div>
  );
}

// ─── Rail hairline (the slim divider Discord uses between groups) ───

function RailDivider() {
  return (
    <div className="mx-auto w-8 my-1 h-px bg-ink-700/45" aria-hidden />
  );
}

// ─── Main component ───

export function ServerRail({
  projects,
  selectedProject,
  streamingProjectIds,
  isAddingProject,
  onSelectProject,
  onSelectHome,
  onAddProject,
  onDeleteProject,
  isHomeActive,
  onRequestConfirm,
  collapsed = true,
}: ServerRailProps) {
  // Re-measure container width to support the (theoretical) expanded mode
  const railRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!railRef.current) return;
    railRef.current.style.setProperty("--rail-width", `${RAIL_WIDTH}px`);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const stamps = Array.from(
        railRef.current?.querySelectorAll<HTMLElement>('[data-rail-stamp] button') ?? []
      );
      const idx = stamps.findIndex(b => b === document.activeElement);
      if (idx < 0) return;
      e.preventDefault();
      const next = e.key === "ArrowDown"
        ? Math.min(idx + 1, stamps.length - 1)
        : Math.max(idx - 1, 0);
      stamps[next]?.focus();
    }
  }, []);

  // Sort: active project pinned first visually? Discord does. We do too.
  const ordered = (() => {
    if (!selectedProject) return projects;
    const idx = projects.findIndex(p => p.id === selectedProject.id);
    if (idx <= 0) return projects;
    return [projects[idx], ...projects.slice(0, idx), ...projects.slice(idx + 1)];
  })();

  return (
    <aside
      ref={railRef}
      className={[
        "shrink-0 flex flex-col items-stretch bg-ink-950/55",
        "border-r border-ink-800/70 overflow-x-hidden overflow-y-hidden",
        "py-2.5 gap-0.5",
        "transition-[width] duration-200",
      ].join(" ")}
      style={{ width: RAIL_WIDTH }}
      aria-label="Project rail"
      onKeyDown={handleKeyDown}
    >
      {/* Home stamp — top */}
      <div className="animate-stamp-drop" style={{ animationDelay: "0ms" }}>
        <HomeStamp
          active={isHomeActive}
          collapsed={collapsed}
          onClick={onSelectHome}
        />
      </div>

      <RailDivider />

      {/* Project stamps — scrollable middle */}
      <div
        className="flex-1 overflow-y-auto overflow-x-hidden sidebar-scroll flex flex-col items-stretch gap-1.5 py-1"
        role="list"
      >
        {ordered.map((p, i) => (
          <div
            key={p.id}
            className="animate-stamp-drop"
            style={{ animationDelay: `${100 + i * 28}ms` }}
          >
            <ProjectStamp
              project={p}
              index={i}
              active={selectedProject?.id === p.id}
              streaming={streamingProjectIds.has(p.id)}
              collapsed={collapsed}
              onSelect={onSelectProject}
              onRequestConfirm={onRequestConfirm}
              onDelete={onDeleteProject}
            />
          </div>
        ))}

        {projects.length === 0 && (
          <div className="px-2 py-4 text-center">
            <p
              className="text-ink-500 text-[0.6rem] font-mono leading-relaxed"
              style={{ fontFamily: "var(--font-serif)", fontStyle: "italic" }}
            >
              No
              <br />
              projects
            </p>
          </div>
        )}
      </div>

      <RailDivider />

      {/* Add project stamp — bottom */}
      <div className="animate-stamp-drop" style={{ animationDelay: `${100 + ordered.length * 28}ms` }}>
        <AddStamp
          onClick={onAddProject}
          collapsed={collapsed}
          loading={isAddingProject}
        />
      </div>
    </aside>
  );
}
