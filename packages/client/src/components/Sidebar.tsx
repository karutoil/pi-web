import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import type { Project, SessionSummary } from "@pi-web/shared";
import type { ViewState } from "../App";
import type { Theme } from "../hooks/useTheme";
import { Icon } from "./Icon";
import { ConfirmDialog } from "./ConfirmDialog";
import { AddProjectExplorer } from "./AddProjectExplorer";
import { ContextMenuPortal, ContextMenuItem, ContextMenuDivider, useLongPress } from "./ContextMenu";

interface SidebarProps {
  projects: Project[];
  sessions: SessionSummary[];
  selectedProject: Project | null;
  activeSession: SessionSummary | null;
  view: ViewState;
  showAddProject: boolean;
  theme: Theme;
  onSelectProject: (p: Project) => void;
  onSelectSession: (s: SessionSummary) => void;
  onBack: () => void;
  onNewSession: () => void;
  onAddProject: (path: string, name: string) => void;
  onDeleteProject: (id: string) => void;
  onToggleAddProject: () => void;
  onToggleTheme: () => void;
  onDeleteSession: (s: SessionSummary) => void;
  onRenameSession: (s: SessionSummary, name: string) => void;
  onForkSession: (entryId: string) => void;
  onRefreshSessions: () => void;
  onContinueLatest: () => void;
  streamingSessionIds: Set<string>;
  isAddingProject?: boolean;
  onToggleSidebar?: () => void;
  isMobile?: boolean;
}

// ─── Helpers ───

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

function formatTokens(n: number): string {
  if (n <= 0) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
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

// ─── Main Sidebar ───

export function Sidebar({
  projects,
  sessions,
  selectedProject,
  activeSession,
  view,
  showAddProject,
  theme,
  onSelectProject,
  onSelectSession,
  onBack,
  onNewSession,
  onAddProject,
  onDeleteProject,
  onToggleAddProject,
  onToggleTheme,
  onDeleteSession,
  onRenameSession,
  onForkSession,
  onRefreshSessions,
  onContinueLatest,
  streamingSessionIds,
  onToggleSidebar,
  isMobile,
}: SidebarProps) {
  const [sessionSearch, setSessionSearch] = useState("");
  const [focusedIdx, setFocusedIdx] = useState(-1);
  const [confirmDialog, setConfirmDialog] = useState<{open: boolean; title: string; message: string; onConfirm: () => void}>({open: false, title: '', message: '', onConfirm: () => {}});
  const listRef = useRef<HTMLDivElement>(null);

  const filteredSessions = useMemo(() => {
    if (!sessionSearch.trim()) return sessions;
    const q = sessionSearch.toLowerCase();
    return sessions.filter(
      s => (s.name || s.lastMessage || "").toLowerCase().includes(q)
        || (s.model || "").toLowerCase().includes(q)
    );
  }, [sessions, sessionSearch]);

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

  // Build id→index map for O(1) lookup instead of indexOf
  const sessionIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    flatSessions.forEach((s, i) => map.set(s.id, i));
    return map;
  }, [flatSessions]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (view !== "sessions" && view !== "chat") return;
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
  }, [view, flatSessions, focusedIdx, onSelectSession]);

  useEffect(() => {
    if (focusedIdx >= 0 && listRef.current) {
      const items = listRef.current.querySelectorAll("[data-session-idx]");
      items[focusedIdx]?.scrollIntoView({ block: "nearest" });
    }
  }, [focusedIdx]);

  return (
    <>
    <aside
      className={`shrink-0 flex flex-col bg-ink-900/30 relative ${
        isMobile
          ? "fixed inset-y-0 left-0 z-30 w-[85vw] max-w-[288px] animate-fade-in-up mobile-sidebar"
          : "w-64"
      }`}
      onKeyDown={handleKeyDown}
    >
      {/* Ambient top glow */}
      <div className="absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-amber-500/[0.03] to-transparent pointer-events-none" />

      {/* Header — compact single line */}
      <div className="relative flex items-center justify-between px-4 pt-4 pb-3">
        <div className="flex items-center gap-2.5">
          <img src="/pi-logo.svg" alt="PI" className="w-6 h-6" />
          <span className="font-semibold text-ink-200 tracking-tight text-[0.82rem]">PI</span>
        </div>
        {onToggleSidebar && (
          <button
            onClick={onToggleSidebar}
            className="text-ink-500 hover:text-ink-400 transition-theme p-1 touch-target"
            title="Hide sidebar (⌘B)"
            aria-label="Hide sidebar"
          >
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <line x1="13" y1="2" x2="13" y2="14" />
              <polyline points="9 5 13 8 9 11" />
            </svg>
          </button>
        )}
      </div>

      {/* Breadcrumb nav — inline, borderless */}
      {view !== "projects" && (
        <div className="px-4 pb-2">
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 text-ink-500 hover:text-ink-300 text-xs transition-theme"
            aria-label="Back to projects"
          >
            <Icon name="chevron-left" size={10} />
            {view === "sessions" ? "All Projects" : selectedProject?.name ?? "Sessions"}
          </button>
        </div>
      )}

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto custom-scrollbar px-2 mobile-safe-bottom" ref={listRef}>
        {view === "projects" && (
          <ProjectList
            projects={projects}
            selectedProject={selectedProject}
            showAddProject={showAddProject}
            onSelect={onSelectProject}
            onDelete={onDeleteProject}
            onAdd={onAddProject}
            onToggleAdd={onToggleAddProject}
            onRequestConfirm={(title, message, onConfirm) => setConfirmDialog({open: true, title, message, onConfirm})}
          />
        )}

        {(view === "sessions" || view === "chat") && selectedProject && (
          <SessionList
            sessions={sessions}
            filteredSessions={filteredSessions}
            groupedSessions={groupedSessions}
            flatSessions={flatSessions}
            sessionIndexMap={sessionIndexMap}
            activeSession={activeSession}
            focusedIdx={focusedIdx}
            search={sessionSearch}
            onSearch={setSessionSearch}
            onSelect={onSelectSession}
            onNewSession={onNewSession}
            onDelete={onDeleteSession}
            onRename={onRenameSession}
            onFork={onForkSession}
            onRefresh={onRefreshSessions}
            onContinueLatest={onContinueLatest}
            streamingSessionIds={streamingSessionIds}
            projectName={selectedProject.name}
            onRequestConfirm={(title, message, onConfirm) => setConfirmDialog({open: true, title, message, onConfirm})}
          />
        )}
      </div>

      {/* Minimal footer */}
      <div className="px-4 py-2.5 flex items-center justify-between mobile-safe-bottom">
        <div className="flex items-center gap-2">
          <button
            onClick={onToggleTheme}
            className="text-ink-500 hover:text-ink-400 transition-theme p-1 touch-target"
            title={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
            aria-label="Toggle dark mode"
          >
            {theme === "light" ? (
              <Icon name="moon" size={13} />
            ) : (
              <Icon name="sun" size={13} />
            )}
          </button>
          <span className="text-ink-500 text-[0.65rem] font-mono tracking-wide">PI WEB</span>
        </div>
        <span className="w-1.5 h-1.5 rounded-full bg-teal-500/70" title="Connected" />
      </div>
    </aside>
    <ConfirmDialog
      open={confirmDialog.open}
      title={confirmDialog.title}
      message={confirmDialog.message}
      onConfirm={() => { confirmDialog.onConfirm(); setConfirmDialog(s => ({...s, open: false})); }}
      onCancel={() => setConfirmDialog(s => ({...s, open: false}))}
    />
    {showAddProject && (
      <AddProjectExplorer
        onAdd={(path, name) => { onAddProject(path, name); onToggleAddProject(); }}
        onCancel={onToggleAddProject}
      />
    )}
    </>
  );
}

// ─── Project List ───

function ProjectList({
  projects,
  selectedProject,
  showAddProject,
  onSelect,
  onDelete,
  onAdd,
  onToggleAdd,
  onRequestConfirm,
}: {
  projects: Project[];
  selectedProject: Project | null;
  showAddProject: boolean;
  onSelect: (p: Project) => void;
  onDelete: (id: string) => void;
  onAdd: (path: string, name: string) => void;
  onToggleAdd: () => void;
  onRequestConfirm: (title: string, message: string, onConfirm: () => void) => void;
}) {
  return (
    <div className="py-2">
      <div className="flex items-center justify-between mb-2 px-2">
        <h2 className="text-[0.65rem] font-semibold text-ink-400 uppercase tracking-[0.12em]">Projects</h2>
        <button
          onClick={onToggleAdd}
          className="text-ink-500 hover:text-ink-300 transition-theme p-1 rounded-md hover:bg-ink-800/50 touch-target"
          title="Add project"
          aria-label="Add project"
        >
          <Icon name="plus" size={14} />
        </button>
      </div>

      {projects.length === 0 && !showAddProject && (
        <p className="text-ink-500 text-xs px-2 py-6 text-center">
          No projects yet. Add a local directory.
        </p>
      )}

      <div className="space-y-px">
        {projects.map(p => (
          <button
            key={p.id}
            onClick={() => onSelect(p)}
            className={`w-full text-left px-3 py-3 rounded-lg transition-theme group ${
              selectedProject?.id === p.id
                ? "bg-ink-800/40"
                : "hover:bg-ink-800/20"
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-ink-100 text-[0.8rem] font-medium truncate">{p.name}</div>
                <div className="text-ink-400 text-[0.65rem] font-mono truncate mt-0.5">
                  {p.path}
                </div>
                <div className="flex items-center gap-1.5 mt-1 text-ink-500 text-[0.65rem] font-mono">
                  {p.sessionCount > 0 && <span>{p.sessionCount} sess</span>}
                  {p.lastActiveAt && <span>{formatTimeAgo(p.lastActiveAt)}</span>}
                  {p.totalCost > 0 && <span>{formatCost(p.totalCost)}</span>}
                </div>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onRequestConfirm('Remove Project', `Remove "${p.name}"? This cannot be undone.`, () => onDelete(p.id));
                }}
                className="opacity-100 md:opacity-0 md:group-hover:opacity-100 text-ink-500 hover:text-rose-400 transition-all shrink-0 p-1 touch-target"
                title="Remove project"
                aria-label="Remove project"
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Add Project Form ───

// ─── Session List ───

function SessionList({
  sessions,
  filteredSessions,
  groupedSessions,
  flatSessions,
  sessionIndexMap,
  activeSession,
  focusedIdx,
  search,
  onSearch,
  onSelect,
  onNewSession,
  onDelete,
  onRename,
  onFork,
  onRefresh,
  onContinueLatest,
  projectName,
  streamingSessionIds,
  onRequestConfirm,
}: {
  sessions: SessionSummary[];
  filteredSessions: SessionSummary[];
  groupedSessions: Record<DateGroup, SessionSummary[]>;
  flatSessions: SessionSummary[];
  sessionIndexMap: Map<string, number>;
  activeSession: SessionSummary | null;
  focusedIdx: number;
  search: string;
  onSearch: (q: string) => void;
  onSelect: (s: SessionSummary) => void;
  onNewSession: () => void;
  onDelete: (s: SessionSummary) => void;
  onRename: (s: SessionSummary, name: string) => void;
  onFork: (entryId: string) => void;
  onRefresh: () => void;
  onContinueLatest: () => void;
  projectName: string;
  streamingSessionIds: Set<string>;
  isAddingProject?: boolean;
  onRequestConfirm: (title: string, message: string, onConfirm: () => void) => void;
}) {
  return (
    <div className="py-2">
      {/* Compact header */}
      <div className="flex items-center justify-between mb-2 px-2">
        <h2 className="text-[0.65rem] font-semibold text-ink-400 uppercase tracking-[0.12em]">Sessions</h2>
        <div className="flex items-center gap-0.5">
          <button
            onClick={onRefresh}
            className="text-ink-500 hover:text-ink-300 transition-theme p-1 rounded-md hover:bg-ink-800/50 touch-target"
            title="Refresh"
            aria-label="Refresh sessions"
          >
            <Icon name="refresh" size={12} />
          </button>
          <button
            onClick={onNewSession}
            className="text-ink-500 hover:text-ink-300 transition-theme p-1 rounded-md hover:bg-ink-800/50 touch-target"
            title="New session"
            aria-label="New session"
          >
            <Icon name="plus" size={12} />
          </button>
        </div>
      </div>

      {/* Project name */}
      <div className="px-3 mb-2">
        <span className="text-ink-200 text-xs font-medium">{projectName}</span>
      </div>

      {/* Search — minimal */}
      <div className="relative mb-2 px-1">
        <Icon name="search" size={10} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-500" />
        <input
          type="text"
          placeholder="Filter…"
          value={search}
          onChange={e => onSearch(e.target.value)}
          className="w-full bg-ink-950/30 border border-ink-800/40 rounded-md pl-7 pr-2 py-1.5 text-ink-200 text-[0.68rem] font-mono placeholder-ink-500 focus:outline-none focus:border-amber-600/40 transition-theme"
        />
        {search && (
          <button
            onClick={() => onSearch("")}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-500 hover:text-ink-400"
            aria-label="Clear search"
          >
            <Icon name="close-thick" size={8} />
          </button>
        )}
      </div>

      {/* Continue latest — subtle pill */}
      {sessions.length > 0 && !search && (
        <button
          onClick={onContinueLatest}
          className="w-full text-left px-3 py-1.5 rounded-lg mb-2 mx-1 bg-amber-500/[0.08] text-amber-400 text-[0.68rem] hover:bg-amber-500/15 transition-theme"
        >
          → Continue latest
        </button>
      )}

      {filteredSessions.length === 0 && (
        <p className="text-ink-500 text-xs px-2 py-6 text-center">
          {search ? "No matches." : "No sessions yet."}
        </p>
      )}

      {/* Grouped session list */}
      {(["today", "yesterday", "thisWeek", "older"] as DateGroup[]).map(group => {
        const items = groupedSessions[group];
        if (items.length === 0) return null;
        return (
          <div key={group} className="mb-1">
            <div className="px-3 py-1.5 text-[0.55rem] font-semibold text-ink-500 uppercase tracking-[0.15em]">
              {GROUP_LABELS[group]}
            </div>
            <div className="space-y-px">
              {items.map((s) => {
                const globalIdx = sessionIndexMap.get(s.id) ?? -1;
                const isFocused = focusedIdx === globalIdx;
                return (
                  <SessionItem
                    key={s.id}
                    session={s}
                    isActive={activeSession?.id === s.id}
                    isFocused={isFocused}
                    isStreaming={streamingSessionIds.has(s.id)}
                    idx={globalIdx}
                    onSelect={onSelect}
                    onDelete={onDelete}
                    onRename={onRename}
                    onFork={onFork}
                    onRequestConfirm={onRequestConfirm}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Session Item ───

function SessionItem({
  session: s,
  isActive,
  isFocused,
  isStreaming,
  idx,
  onSelect,
  onDelete,
  onRename,
  onFork,
  onRequestConfirm,
}: {
  session: SessionSummary;
  isActive: boolean;
  isFocused: boolean;
  isStreaming: boolean;
  idx: number;
  onSelect: (s: SessionSummary) => void;
  onDelete: (s: SessionSummary) => void;
  onRename: (s: SessionSummary, name: string) => void;
  onFork: (entryId: string) => void;
  onRequestConfirm: (title: string, message: string, onConfirm: () => void) => void;
}) {
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(s.name || "");
  const renameRef = useRef<HTMLInputElement>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const longPress = useLongPress((e) => setCtxMenu({ x: e.clientX, y: e.clientY }));

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
  const preview = s.firstMessage || s.lastMessage;

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  };

  // Status dot class — pulse only when actively streaming
  const dotColor = isStreaming
    ? "bg-teal-400"
    : isActive
    ? "bg-amber-500/60"
    : "bg-ink-700 group-hover:bg-ink-600";

  return (
    <div
      data-session-idx={idx}
      onContextMenu={handleContextMenu}
      {...longPress}
      className={`relative group rounded-lg transition-all duration-150 ${
        isActive
          ? "bg-ink-800/40"
          : isFocused
          ? "bg-ink-800/25"
          : "hover:bg-ink-800/15"
      }`}
    >
      <button
        onClick={() => onSelect(s)}
        className="w-full text-left px-3 py-2.5 min-h-[44px]"
        title={preview || undefined}
      >
        <div className="flex items-center gap-2.5">
          {/* Minimal status dot */}
          <span className={`shrink-0 w-1.5 h-1.5 rounded-full mt-1.5 ${dotColor} ${isStreaming ? "animate-pulse" : ""}`} />

          <div className="flex-1 min-w-0">
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
                className="w-full bg-ink-950/50 border border-amber-600/30 rounded px-1.5 py-0.5 text-ink-200 text-xs focus:outline-none"
              />
            ) : (
              <div className="text-ink-200 text-[0.8rem] truncate leading-snug">{displayName}</div>
            )}
            {/* Metadata */}
            <div className="flex items-center gap-1.5 mt-0.5 text-ink-500 text-[0.65rem] font-mono">
              <span>{formatTimeAgo(s.lastActiveAt || s.timestamp)}</span>
              {s.messageCount > 0 && <span>{s.messageCount}m</span>}
              {s.cost > 0 && <span>{formatCost(s.cost)}</span>}
            </div>
          </div>
        </div>
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
            label="Fork From Here"
            icon={<Icon name="fork" size={10} />}
            onClick={() => { setCtxMenu(null); onFork(s.id); }}
          />
          <ContextMenuDivider />
          <ContextMenuItem
            label="Delete"
            danger
            icon={<Icon name="trash" size={10} />}
            onClick={() => {
              setCtxMenu(null);
              onRequestConfirm('Delete Session', `Delete "${displayName}"? This removes the session file and cannot be undone.`, () => onDelete(s));
            }}
          />
        </ContextMenuPortal>
      )}
    </div>
  );
}
