import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import type { Project, SessionSummary } from "@pi-web/shared";
import { Icon } from "./Icon";
import { ContextMenuPortal, ContextMenuItem, ContextMenuDivider, useLongPress } from "./ContextMenu";

/**
 * Discord-style channel list — shows the active project's sessions as
 * "channels" grouped by date. Replaces the session list portion of the
 * old Sidebar. The project header lives at the top with a kebab menu
 * for project actions; the bottom hosts a slim "user panel" with theme
 * toggle and version info.
 *
 * Aesthetic kept consistent with the rest of the app: serif (Newsreader)
 * for names + the project header, Geist Mono for timestamps and paths,
 * warm amber accent for active / live sessions.
 */

interface ChannelListProps {
  project: Project;
  sessions: SessionSummary[];
  activeSession: SessionSummary | null;
  search: string;
  width?: number;
  fill?: boolean;
  onSearch: (q: string) => void;
  onSelectSession: (s: SessionSummary) => void;
  onNewSession: () => void;
  onDeleteSession: (s: SessionSummary) => void;
  onRenameSession: (s: SessionSummary, name: string) => void;
  onForkSession: (entryId: string) => void;
  onCopySession?: (s: SessionSummary) => void;
  onRefreshSessions: () => void;
  onContinueLatest: () => void;
  streamingSessionIds: Set<string>;
  onDeleteProject: (project: Project) => void;
  onRequestConfirm: (title: string, message: string, onConfirm: () => void) => void;
}

// ─── Helpers (mirrored from old Sidebar for local cohesion) ───

function formatTimeAgo(ts: string): string {
  const d = new Date(ts);
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 0) return "now";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return d.toLocaleDateString();
}

function formatCost(cost: number): string {
  if (cost <= 0) return "";
  if (cost < 0.01) return "<$0.01";
  return `$${cost.toFixed(2)}`;
}

type DateGroup = "today" | "yesterday" | "thisWeek" | "older";

function getDateGroup(ts: string): DateGroup {
  const d = new Date(ts);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const thisWeek = new Date(today.getTime() - 7 * 86400000);
  const t = d.getTime();
  if (t >= today.getTime()) return "today";
  if (t >= yesterday.getTime()) return "yesterday";
  if (t >= thisWeek.getTime()) return "thisWeek";
  return "older";
}

const GROUP_LABELS: Record<DateGroup, string> = {
  today: "Today",
  yesterday: "Yesterday",
  thisWeek: "This Week",
  older: "Older",
};

// ─── Header (project title + kebab) ───

function ProjectHeader({
  project,
  onNewSession,
  onRequestConfirm,
  onDeleteProject,
}: {
  project: Project;
  onNewSession: () => void;
  onRequestConfirm: (title: string, message: string, onConfirm: () => void) => void;
  onDeleteProject: (project: Project) => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  useEffect(() => {
    if (!menu) return;
    // Position the menu adjacent to the kebab button rather than the
    // cursor — cleaner for a header-attached control.
    if (menuBtnRef.current) {
      const rect = menuBtnRef.current.getBoundingClientRect();
      setMenu({ x: rect.right - 192, y: rect.bottom + 6 });
    }
  }, [menu]);

  return (
    <div className="project-session-header">
      <div className="project-session-header-copy">
        <h2
          className="project-session-title"
          title={project.name}
        >
          {project.name}
        </h2>
        <div className="project-session-path" title={project.path}>
          {project.path}
        </div>
      </div>
      <button
        ref={menuBtnRef}
        onClick={(e) => {
          const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
          setMenu(prev => prev ? null : { x: rect.right - 192, y: rect.bottom + 6 });
        }}
        className="project-session-action"
        aria-label="Project actions"
        title="Project actions"
      >
        <Icon name="kebab" size={14} />
      </button>
      {menu && (
        <ContextMenuPortal
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
        >
          <ContextMenuItem
            label="New session"
            icon={<Icon name="plus" size={10} />}
            onClick={() => { setMenu(null); onNewSession(); }}
          />
          <ContextMenuDivider />
          <ContextMenuItem
            label="Remove project"
            danger
            icon={<Icon name="trash" size={10} />}
            onClick={() => {
              setMenu(null);
              onRequestConfirm(
                "Remove project",
                `Remove "${project.name}"? This cannot be undone.`,
                () => onDeleteProject(project),
              );
            }}
          />
        </ContextMenuPortal>
      )}
    </div>
  );
}

// ─── Search input ───

function SearchBox({
  value,
  onChange,
  placeholder = "Filter…",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="project-session-search">
      <Icon
        name="search"
        size={11}
        className="project-session-search-icon"
      />
      <input
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
      />
      {value && (
        <button
          onClick={() => onChange("")}
          className="project-session-clear-search"
          aria-label="Clear search"
        >
          <Icon name="close-thick" size={8} />
        </button>
      )}
    </div>
  );
}

// ─── Section label (small caps, mono, hairline rule) ───

function SectionLabel({
  children,
  action,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="project-session-section-label">
      <span>{children}</span>
      {action && <div className="project-session-section-actions">{action}</div>}
    </div>
  );
}

function IconButton({
  onClick,
  title,
  ariaLabel,
  children,
}: {
  onClick: () => void;
  title: string;
  ariaLabel: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
      className="project-session-action"
    >
      {children}
    </button>
  );
}

// ─── Session item (channel) ───

function ChannelItem({
  session: s,
  isActive,
  isStreaming,
  onSelect,
  onDelete,
  onRename,
  onFork,
  onCopySession,
  onRequestConfirm,
}: {
  session: SessionSummary;
  isActive: boolean;
  isStreaming: boolean;
  onSelect: (s: SessionSummary) => void;
  onDelete: (s: SessionSummary) => void;
  onRename: (s: SessionSummary, name: string) => void;
  onFork: (entryId: string) => void;
  onCopySession?: (s: SessionSummary) => void;
  onRequestConfirm: (title: string, message: string, onConfirm: () => void) => void;
}) {
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(s.name || "");
  const renameRef = useRef<HTMLInputElement>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; copied?: boolean } | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => { if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current); };
  }, []);
  const flashCopied = () => {
    setCtxMenu(prev => (prev ? { ...prev, copied: true } : prev));
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => {
      setCtxMenu(prev => (prev ? { ...prev, copied: undefined } : prev));
    }, 1200);
  };
  const longPress = useLongPress(e => setCtxMenu({ x: e.clientX, y: e.clientY }));

  useEffect(() => {
    if (isRenaming && renameRef.current) {
      renameRef.current.focus();
      renameRef.current.select();
    }
  }, [isRenaming]);

  const handleRenameSubmit = () => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== s.name) {
      onRename(s, trimmed);
    }
    setIsRenaming(false);
  };

  const displayName = s.name || s.lastMessage || s.firstMessage || "Untitled";

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  };

  return (
    <div
      onContextMenu={handleContextMenu}
      {...longPress}
      className="project-session-item"
      data-active={isActive}
    >
      <button
        onClick={() => onSelect(s)}
        className="project-session-item-button"
        title={s.firstMessage || s.lastMessage || undefined}
      >
        {isRenaming ? (
          <input
            ref={renameRef}
            value={renameValue}
            onChange={e => setRenameValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") handleRenameSubmit();
              if (e.key === "Escape") setIsRenaming(false);
              e.stopPropagation();
            }}
            onBlur={handleRenameSubmit}
            onClick={e => e.stopPropagation()}
            className="project-session-rename-input"
          />
        ) : (
          <>
            <span
              className="project-session-item-hash"
              aria-hidden
            >
              #
            </span>
            <span
              className="project-session-item-title"
            >
              {displayName}
            </span>
            {isStreaming && (
              <span
                className="project-session-streaming-dot"
                title="PI is running"
                aria-label="PI is streaming"
              />
            )}
            {!isStreaming && (
              <span className="project-session-item-meta">
                {formatTimeAgo(s.lastActiveAt || s.timestamp)}
              </span>
            )}
          </>
        )}
      </button>

      {ctxMenu && (
        <ContextMenuPortal
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
        >
          <ContextMenuItem
            label="Rename"
            icon={<Icon name="pencil" size={10} />}
            onClick={() => { setCtxMenu(null); setIsRenaming(true); setRenameValue(s.name || ""); }}
          />
          <ContextMenuItem
            label="Fork from here"
            icon={<Icon name="fork" size={10} />}
            onClick={() => { setCtxMenu(null); onFork(s.id); }}
          />
          {onCopySession && (
            <ContextMenuItem
              label={ctxMenu.copied ? "Copied ✓" : "Copy entire session"}
              icon={<Icon name="copy-plain" size={10} />}
              onClick={() => { flashCopied(); onCopySession(s); }}
            />
          )}
          <ContextMenuDivider />
          <ContextMenuItem
            label="Delete"
            danger
            icon={<Icon name="trash" size={10} />}
            onClick={() => {
              setCtxMenu(null);
              onRequestConfirm(
                "Delete session",
                `Delete "${displayName}"? This removes the session file and cannot be undone.`,
                () => onDelete(s),
              );
            }}
          />
        </ContextMenuPortal>
      )}
    </div>
  );
}

// ─── Footer "user panel" — version + theme toggle ───

import type { Theme } from "../hooks/useTheme";
import { VersionChecker } from "./VersionChecker";

function UserPanel({
  theme,
  onToggleTheme,
}: {
  theme: Theme;
  onToggleTheme: () => void;
}) {
  return (
    <div className="project-session-footer">
      <div className="project-session-footer-inner">
        <div>
          <VersionChecker compact />
        </div>
        <button
          type="button"
          onClick={onToggleTheme}
          className="project-session-action"
          title={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
          aria-label="Toggle theme"
        >
          <Icon name={theme === "light" ? "moon" : "sun"} size={12} />
        </button>
      </div>
    </div>
  );
}

// ─── Main channel list ───

export function ChannelList({
  project,
  sessions,
  activeSession,
  search,
  width,
  fill = false,
  onSearch,
  onSelectSession,
  onNewSession,
  onDeleteSession,
  onRenameSession,
  onForkSession,
  onCopySession,
  onRefreshSessions,
  onContinueLatest,
  streamingSessionIds,
  onDeleteProject,
  onRequestConfirm,
  theme,
  onToggleTheme,
}: ChannelListProps & { theme: Theme; onToggleTheme: () => void }) {
  const listRef = useRef<HTMLDivElement>(null);
  const [focusedIdx, setFocusedIdx] = useState(-1);

  const filteredSessions = useMemo(() => {
    if (!search.trim()) return sessions;
    const q = search.toLowerCase();
    return sessions.filter(
      s => (s.name || s.lastMessage || "").toLowerCase().includes(q)
        || (s.model || "").toLowerCase().includes(q),
    );
  }, [sessions, search]);

  const groupedSessions = useMemo(() => {
    const groups: Record<DateGroup, SessionSummary[]> = { today: [], yesterday: [], thisWeek: [], older: [] };
    for (const s of filteredSessions) {
      groups[getDateGroup(s.lastActiveAt || s.timestamp)].push(s);
    }
    return groups;
  }, [filteredSessions]);

  const flatSessions = useMemo(() => {
    const result: SessionSummary[] = [];
    for (const g of ["today", "yesterday", "thisWeek", "older"] as DateGroup[]) {
      result.push(...groupedSessions[g]);
    }
    return result;
  }, [groupedSessions]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusedIdx(i => Math.min(i + 1, flatSessions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusedIdx(i => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && focusedIdx >= 0 && focusedIdx < flatSessions.length) {
      e.preventDefault();
      onSelectSession(flatSessions[focusedIdx]);
    }
  }, [flatSessions, focusedIdx, onSelectSession]);

  useEffect(() => {
    if (focusedIdx < 0 || !listRef.current) return;
    const items = listRef.current.querySelectorAll("[data-channel-idx]");
    items[focusedIdx]?.scrollIntoView({ block: "nearest" });
  }, [focusedIdx]);

  return (
    <aside
      className="project-session-panel"
      style={fill ? undefined : { width: width ? `${width}vw` : 240 }}
      aria-label="Session list"
      onKeyDown={handleKeyDown}
    >
      <ProjectHeader
        project={project}
        onNewSession={onNewSession}
        onRequestConfirm={onRequestConfirm}
        onDeleteProject={onDeleteProject}
      />

      <div className="project-session-hairline mx-3" />

      <SearchBox value={search} onChange={onSearch} placeholder="Filter sessions…" />

      <div
        ref={listRef}
        className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden sidebar-scroll pb-2"
        role="list"
      >
        {/* Continue latest — subtle amber action card */}
        {sessions.length > 0 && !search && (
          <button
            type="button"
            onClick={onContinueLatest}
            className="project-session-continue group"
          >
            <span className="project-session-continue-dot" />
            <span>
              Continue latest
            </span>
            <Icon name="chevron-right" size={10} />
          </button>
        )}

        {/* Section header */}
        <SectionLabel
          action={
            <>
              <IconButton onClick={onRefreshSessions} title="Refresh sessions" ariaLabel="Refresh sessions">
                <Icon name="refresh" size={11} />
              </IconButton>
              <IconButton onClick={onNewSession} title="New session" ariaLabel="New session">
                <Icon name="plus" size={11} />
              </IconButton>
            </>
          }
        >
          Sessions
        </SectionLabel>

        {/* Grouped channels */}
        {(["today", "yesterday", "thisWeek", "older"] as DateGroup[]).map(group => {
          const items = groupedSessions[group];
          if (items.length === 0) return null;
          return (
            <div key={group} className="project-session-group">
              <div className="project-session-group-label">
                <span>{GROUP_LABELS[group]}</span>
              </div>
              <div className="space-y-px">
                {items.map((s) => {
                  const globalIdx = flatSessions.findIndex(x => x.id === s.id);
                  return (
                    <div key={s.id} data-channel-idx={globalIdx}>
                      <ChannelItem
                        session={s}
                        isActive={activeSession?.id === s.id}
                        isStreaming={streamingSessionIds.has(s.id)}
                        onSelect={onSelectSession}
                        onDelete={onDeleteSession}
                        onRename={onRenameSession}
                        onFork={onForkSession}
                        onCopySession={onCopySession}
                        onRequestConfirm={onRequestConfirm}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}

        {filteredSessions.length === 0 && (
          <div className="project-session-empty">
            <div>
              <strong>{search ? "No matches." : "No sessions yet."}</strong>
              {!search && (
                <span>
                  Press <kbd>⌘N</kbd> to start one.
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      <UserPanel theme={theme} onToggleTheme={onToggleTheme} />
    </aside>
  );
}
