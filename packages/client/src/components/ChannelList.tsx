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
    <div className="shrink-0 px-3 pt-3 pb-2.5">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <h2
            className="text-ink-100 text-[0.95rem] font-semibold leading-tight truncate"
            style={{ fontFamily: "var(--font-serif)" }}
            title={project.name}
          >
            {project.name}
          </h2>
          <div className="text-ink-500 text-[0.6rem] font-mono truncate mt-0.5 leading-none" title={project.path}>
            {project.path}
          </div>
        </div>
        <button
          ref={menuBtnRef}
          onClick={(e) => {
            const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
            setMenu({ x: rect.right - 192, y: rect.bottom + 6 });
          }}
          className="shrink-0 p-1.5 -m-1.5 rounded-md text-ink-500 hover:text-ink-200 hover:bg-ink-800/40 transition-theme"
          aria-label="Project actions"
          title="Project actions"
        >
          <Icon name="kebab" size={14} />
        </button>
      </div>
      {menu && (
        <ContextMenuPortal
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
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
    <div className="relative shrink-0 mx-2.5 mb-2">
      <Icon
        name="search"
        size={11}
        className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-500 pointer-events-none"
      />
      <input
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full bg-ink-950/40 border border-transparent rounded-md pl-7 pr-7 py-1.5 text-ink-200 text-[0.72rem] font-mono placeholder-ink-500 hover:bg-ink-950/60 focus:bg-ink-950/70 focus:border-amber-600/40 focus:outline-none transition-theme"
      />
      {value && (
        <button
          onClick={() => onChange("")}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-500 hover:text-ink-200 p-0.5 rounded transition-theme"
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
    <div className="shrink-0 flex items-center justify-between px-3.5 pt-3 pb-1">
      <span
        className="text-ink-500 text-[0.58rem] font-mono uppercase tracking-[0.2em]"
      >
        {children}
      </span>
      {action}
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
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
      className="text-ink-500 hover:text-ink-200 hover:bg-ink-800/50 transition-theme p-1 rounded inline-flex items-center justify-center"
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
      className={[
        "relative mx-2 px-2.5 py-1.5 rounded-md transition-theme group/ch",
        isActive
          ? "bg-ink-850/70 text-ink-100 shadow-[inset_2px_0_0_0_var(--color-amber-500)]"
          : "text-ink-300 hover:bg-ink-850/35 hover:text-ink-100",
      ].join(" ")}
    >
      <button
        onClick={() => onSelect(s)}
        className="w-full text-left flex items-center gap-1.5 min-w-0"
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
            className="flex-1 min-w-0 bg-ink-950/60 border border-amber-600/40 rounded px-1.5 py-0.5 text-ink-100 text-[0.8rem] focus:outline-none"
            style={{ fontFamily: "var(--font-serif)" }}
          />
        ) : (
          <>
            <span
              className={[
                "shrink-0 text-[0.95rem] leading-none w-3 text-center transition-colors",
                isActive ? "text-amber-500" : "text-ink-500 group-hover/ch:text-ink-400",
              ].join(" ")}
              aria-hidden
            >
              #
            </span>
            <span
              className="flex-1 min-w-0 text-[0.82rem] truncate leading-snug"
              style={{ fontFamily: "var(--font-serif)" }}
            >
              {displayName}
            </span>
            {isStreaming && (
              <span
                className="shrink-0 w-1.5 h-1.5 rounded-full bg-teal-400 animate-pulse"
                title="PI is running"
                aria-label="PI is streaming"
              />
            )}
            {!isStreaming && (
              <span className="shrink-0 text-ink-500 text-[0.6rem] font-mono leading-none ml-1">
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
    <div className="shrink-0 px-2.5 py-2 border-t border-ink-800/70 bg-ink-950/40">
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <VersionChecker compact />
        </div>
        <button
          onClick={onToggleTheme}
          className="shrink-0 p-1.5 rounded-md text-ink-500 hover:text-ink-200 hover:bg-ink-800/50 transition-theme"
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
      className="shrink-0 flex flex-col min-w-0 min-h-0 bg-ink-900/35 border-r border-ink-800/70 overflow-x-hidden max-h-full max-w-full"
      style={fill ? { flex: "1 1 0", height: "100%" } : { width: width ? `${width}vw` : 240 }}
      aria-label="Session list"
      onKeyDown={handleKeyDown}
    >
      <ProjectHeader
        project={project}
        onNewSession={onNewSession}
        onRequestConfirm={onRequestConfirm}
        onDeleteProject={onDeleteProject}
      />

      <div className="sidebar-hairline mx-3" />

      <SearchBox value={search} onChange={onSearch} placeholder="Filter sessions…" />

      <div
        ref={listRef}
        className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden sidebar-scroll pb-2"
        role="list"
      >
        {/* Continue latest — subtle amber action card */}
        {sessions.length > 0 && !search && (
          <button
            onClick={onContinueLatest}
            className="mx-2 mt-1 mb-1.5 w-[calc(100%-1rem)] text-left pl-2.5 pr-2.5 py-1.5 rounded-md bg-amber-500/[0.06] hover:bg-amber-500/[0.12] text-amber-500 hover:text-amber-400 text-[0.72rem] transition-theme flex items-center gap-2 group"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            <span className="shrink-0 w-1 h-1 rounded-full bg-amber-500 group-hover:scale-125 transition-theme" />
            <span className="uppercase tracking-[0.16em] text-[0.6rem] font-medium flex-1">
              Continue latest
            </span>
            <Icon name="chevron-right" size={10} className="text-amber-500/70" />
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
            <div key={group} className="mb-1">
              <div className="sidebar-group-label">
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
          <div className="px-4 py-8">
            <p
              className="text-ink-500 text-[0.78rem] text-center"
              style={{ fontFamily: "var(--font-serif)", fontStyle: "italic" }}
            >
              {search ? "No matches." : "No sessions yet."}
            </p>
            {!search && (
              <p className="text-ink-500 text-[0.6rem] font-mono text-center mt-1.5">
                Press <kbd className="px-1 py-0.5 rounded bg-ink-800/60 text-ink-300 font-mono text-[0.55rem]">⌘N</kbd> to start one.
              </p>
            )}
          </div>
        )}
      </div>

      <UserPanel theme={theme} onToggleTheme={onToggleTheme} />
    </aside>
  );
}
