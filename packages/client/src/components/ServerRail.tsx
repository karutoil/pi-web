import { useState, useRef, useEffect, useCallback } from "react";
import type { Project } from "@pi-web/shared";
import { Icon } from "./Icon";
import { useProjectFavicon } from "../hooks/useProjectFavicon";
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
  onOpenSettings?: () => void;
  collapsed?: boolean;
  onExpand?: () => void;
  orientation?: "vertical" | "horizontal";
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
  const favicon = useProjectFavicon(project.id);
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
      <span
        className="project-session-stamp-marker"
        aria-hidden
      />
      <button
        onClick={() => onSelect(project)}
        onContextMenu={handleContextMenu}
        {...longPress}
        title={collapsed ? displayName : undefined}
        aria-label={`Open project ${displayName}`}
        aria-current={active ? "true" : undefined}
        className="project-session-stamp"
        data-active={active}
      >
        {favicon ? (
          <img
            src={favicon}
            alt=""
            className="w-full h-full object-cover rounded-[0.85rem] pointer-events-none"
            aria-hidden="true"
          />
        ) : (
          <span className="select-none">
            {projectInitials(displayName)}
          </span>
        )}

        {streaming && (
          <span
            className="project-session-stamp-dot"
            title="PI is running here"
            aria-label="PI is running in this project"
          />
        )}

        <span
          className="pointer-events-none absolute inset-0 rounded-[14px]"
          style={{
            background: "linear-gradient(180deg, rgba(255,255,255,0.035), transparent 60%)",
          }}
          aria-hidden
        />
      </button>

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
    <div className="project-session-stamp-wrap group/home overflow-x-hidden" data-rail-stamp data-active={active}>
      <span
        className="project-session-stamp-marker"
        aria-hidden
      />
      <button
        onClick={onClick}
        title={collapsed ? "All projects" : undefined}
        aria-label="All projects"
        aria-current={active ? "true" : undefined}
        className="project-session-stamp-home"
        data-active={active}
      >
        <Icon name="home" size={20} />
      </button>
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
    <div className="project-session-stamp-wrap group/add" data-rail-stamp>
      <button
        onClick={onClick}
        disabled={loading}
        title={collapsed ? "Add project" : undefined}
        aria-label="Add project"
        className="project-session-stamp-add"
      >
        {loading ? (
          <div className="w-3.5 h-3.5 rounded-full border-2 border-ink-600 border-t-amber-500 animate-spin" />
        ) : (
          <Icon name="plus" size={20} />
        )}
      </button>
    </div>
  );
}

// ─── Settings stamp (bottom of rail, under add project) ───

function SettingsStamp({
  onClick,
  collapsed,
}: {
  onClick: () => void;
  collapsed: boolean;
}) {
  return (
    <div className="project-session-stamp-wrap group/settings" data-rail-stamp>
      <button
        onClick={onClick}
        title={collapsed ? "Settings" : undefined}
        aria-label="Settings"
        className="project-session-stamp-settings"
      >
        <Icon name="settings" size={18} />
      </button>
    </div>
  );
}

// ─── Rail hairline (the slim divider Discord uses between groups) ───

function RailDivider({ orientation }: { orientation: "vertical" | "horizontal" }) {
  return orientation === "horizontal"
    ? <div className="w-px h-8 mx-1 bg-ink-700/45" aria-hidden />
    : <div className="mx-auto w-8 my-1 h-px bg-ink-700/45" aria-hidden />;
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
  onOpenSettings,
  collapsed = true,
  orientation = "vertical",
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
      className="project-session-rail"
      data-orientation={orientation}
      style={{ width: orientation === "horizontal" ? undefined : RAIL_WIDTH }}
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

      <RailDivider orientation={orientation} />

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
          <div className="project-session-empty">
            <div>
              <strong>No projects</strong>
              <span>Add a project to start collecting sessions.</span>
            </div>
          </div>
        )}
      </div>

      <RailDivider orientation={orientation} />

      {/* Add project stamp — bottom */}
      <div className="animate-stamp-drop" style={{ animationDelay: `${100 + ordered.length * 28}ms` }}>
        <AddStamp
          onClick={onAddProject}
          collapsed={collapsed}
          loading={isAddingProject}
        />
      </div>

      <RailDivider orientation={orientation} />

      {/* Settings stamp — under add project */}
      <div className="animate-stamp-drop" style={{ animationDelay: `${128 + ordered.length * 28}ms` }}>
        <SettingsStamp
          onClick={() => onOpenSettings?.()}
          collapsed={collapsed}
        />
      </div>
    </aside>
  );
}
