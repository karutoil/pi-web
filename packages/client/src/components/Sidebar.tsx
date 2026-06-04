import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import type { Project, SessionSummary } from "@pi-web/shared";
import type { ViewState } from "../App";
import type { Theme } from "../hooks/useTheme";
import { Icon } from "./Icon";
import { ConfirmDialog } from "./ConfirmDialog";
import { AddProjectExplorer } from "./AddProjectExplorer";
import { ContextMenuPortal, ContextMenuItem, ContextMenuDivider, useLongPress } from "./ContextMenu";
import { VersionChecker } from "./VersionChecker";

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
  /**
   * Copy the entire session (all messages) to the clipboard as raw API
   * markdown. Parent is responsible for fetching the session detail if it
   * isn't already loaded.
   */
  onCopySession?: (s: SessionSummary) => void;
  onRefreshSessions: () => void;
  onContinueLatest: () => void;
  streamingSessionIds: Set<string>;
  streamingProjectIds: Set<string>;
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
  onCopySession,
  onRefreshSessions,
  onContinueLatest,
  streamingSessionIds,
  streamingProjectIds,
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

  // Whether the context switcher (project card) should be shown.
  // Sessions / chat views need it; projects view does not.
  const showContextSwitcher = (view === "sessions" || view === "chat") && selectedProject;

  return (
    <>
    <aside
      className={`shrink-0 flex flex-col relative ${
        isMobile
          ? "fixed inset-y-0 left-0 z-30 w-[85vw] max-w-[288px] animate-fade-in-up mobile-sidebar bg-ink-900"
          : "w-64 bg-ink-900/30"
      }`}
      onKeyDown={handleKeyDown}
    >
      {/* Brand row ─────────────────────────────────────── */}
      <div className="relative flex items-center justify-between pl-4 pr-2.5 pt-3.5 pb-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="relative shrink-0">
            <img src="/pi-logo.svg" alt="" className="w-6 h-6 block" />
          </div>
          <div className="flex items-baseline gap-1.5 min-w-0">
            <span
              className="font-semibold text-ink-100 tracking-tight leading-none text-[0.95rem]"
              style={{ fontFamily: "var(--font-serif)" }}
            >
              PI
            </span>
            <span className="text-ink-500 text-[0.6rem] font-mono uppercase tracking-[0.18em] leading-none">
              web
            </span>
          </div>
        </div>
        <div className="flex items-center gap-0.5 -mr-1">
          <button
            onClick={onToggleTheme}
            className="text-ink-500 hover:text-ink-200 hover:bg-ink-800/40 transition-theme p-1.5 rounded-md touch-target"
            title={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
            aria-label="Toggle dark mode"
          >
            {theme === "light" ? (
              <Icon name="moon" size={11} />
            ) : (
              <Icon name="sun" size={11} />
            )}
          </button>
          {onToggleSidebar && (
            <button
              onClick={onToggleSidebar}
              className="text-ink-500 hover:text-ink-200 hover:bg-ink-800/40 transition-theme p-1.5 rounded-md touch-target"
              title="Hide sidebar (⌘B)"
              aria-label="Hide sidebar"
            >
              <Icon name="chevron-left" size={11} />
            </button>
          )}
        </div>
      </div>
      <div className="sidebar-hairline mx-3" />

      {/* Context switcher — shown when a project is open. Replaces the
          old "← All Projects" breadcrumb with something more substantial:
          the active project name, its path, and a chevron that takes you
          back to the project picker. */}
      {showContextSwitcher && (
        <>
          <button
            onClick={onBack}
            className="group mx-2 mt-2 mb-1.5 px-2.5 py-2 rounded-md flex items-center gap-2.5 text-left hover:bg-ink-850/40 transition-theme focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-500/40"
            title="Switch project"
            aria-label="Back to all projects"
          >
            <span
              className="shrink-0 w-1.5 h-1.5 rounded-full bg-amber-500/80"
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <div
                className="text-ink-100 text-[0.82rem] font-medium truncate leading-tight"
                style={{ fontFamily: "var(--font-serif)" }}
              >
                {selectedProject?.name}
              </div>
              <div className="text-ink-500 text-[0.6rem] font-mono truncate mt-0.5 leading-none">
                {selectedProject?.path}
              </div>
            </div>
            <Icon
              name="chevron-down"
              size={10}
              className="text-ink-500 group-hover:text-ink-300 transition-theme shrink-0 -rotate-90"
            />
          </button>
          <div className="sidebar-hairline mx-3" />
        </>
      )}

      {/* Scrollable content ──────────────────────────── */}
      <div
        className="flex-1 overflow-y-auto sidebar-scroll px-2 pb-2 mobile-safe-bottom"
        ref={listRef}
      >
        {view === "projects" && (
          <ProjectList
            projects={projects}
            selectedProject={selectedProject}
            showAddProject={showAddProject}
            onSelect={onSelectProject}
            onDelete={onDeleteProject}
            onAdd={onAddProject}
            onToggleAdd={onToggleAddProject}
            streamingProjectIds={streamingProjectIds}
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
            onCopySession={onCopySession}
            onRefresh={onRefreshSessions}
            onContinueLatest={onContinueLatest}
            streamingSessionIds={streamingSessionIds}
            projectName={selectedProject.name}
            onRequestConfirm={(title, message, onConfirm) => setConfirmDialog({open: true, title, message, onConfirm})}
          />
        )}
      </div>

      {/* Footer — intentionally minimal. The theme toggle has moved
          up to the brand row, and the "PI WEB" wordmark + status dot
          were removed to keep the bottom edge clean. Only the version
          checker lives here. */}
      <div className="sidebar-hairline mx-3" />
      <VersionChecker />
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

// ─── Section label ──────────────────────────────────────

function SectionLabel({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-2.5 pt-3.5 pb-1.5">
      <span
        className="text-ink-500 text-[0.58rem] font-mono uppercase tracking-[0.2em]"
        style={{ fontFamily: "var(--font-mono)" }}
      >
        {children}
      </span>
      {action && <div className="flex items-center gap-0.5 -mr-1">{action}</div>}
    </div>
  );
}

// ─── Icon button (uniform header action) ────────────────

function SidebarIconButton({
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
      className="text-ink-500 hover:text-ink-200 hover:bg-ink-800/50 transition-theme p-1.5 rounded-md touch-target inline-flex items-center justify-center"
    >
      {children}
    </button>
  );
}

// ─── Project List ───────────────────────────────────────

function ProjectList({
  projects,
  selectedProject,
  showAddProject,
  onSelect,
  onDelete,
  onAdd,
  onToggleAdd,
  streamingProjectIds,
  onRequestConfirm,
}: {
  projects: Project[];
  selectedProject: Project | null;
  showAddProject: boolean;
  onSelect: (p: Project) => void;
  onDelete: (id: string) => void;
  onAdd: (path: string, name: string) => void;
  onToggleAdd: () => void;
  streamingProjectIds: Set<string>;
  onRequestConfirm: (title: string, message: string, onConfirm: () => void) => void;
}) {
  return (
    <div>
      <SectionLabel
        action={
          <SidebarIconButton
            onClick={onToggleAdd}
            title="Add project"
            ariaLabel="Add project"
          >
            <Icon name="plus" size={12} />
          </SidebarIconButton>
        }
      >
        Projects
      </SectionLabel>

      {projects.length === 0 && !showAddProject && (
        <div className="px-2.5 py-5">
          <p
            className="text-ink-500 text-[0.72rem] leading-relaxed text-center"
            style={{ fontFamily: "var(--font-serif)", fontStyle: "italic" }}
          >
            No projects yet.
          </p>
          <p className="text-ink-500 text-[0.62rem] font-mono text-center mt-1">
            Add a local directory to begin.
          </p>
        </div>
      )}

      {/*
        Outer element is a div + role="button" so we can legally nest the
        "Remove project" button inside it. Using a real <button> here would
        produce invalid HTML (nested <button>) and React 19 would refuse to
        fire the click handler — leaving the user stuck on the projects
        view with the click "flashing" but doing nothing. #130
      */}
      <div className="space-y-px">
        {projects.map(p => {
          const active = selectedProject?.id === p.id;
          const streaming = streamingProjectIds.has(p.id);
          return (
            <div
              key={p.id}
              role="button"
              tabIndex={0}
              onClick={() => onSelect(p)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(p);
                }
              }}
              aria-label={`Open project ${p.name}`}
              className={`relative w-full text-left pl-3 pr-2 py-2.5 rounded-md transition-theme group cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-500/40 hover:bg-ink-850/30 ${
                active ? "sidebar-item-active" : ""
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 min-w-0">
                    {streaming && (
                      <span
                        className="shrink-0 w-1.5 h-1.5 rounded-full bg-teal-400 animate-pulse"
                        title="PI is running in this project"
                        aria-label="PI is running in this project"
                      />
                    )}
                    <div
                      className="text-ink-100 text-[0.85rem] font-medium truncate leading-tight"
                      style={{ fontFamily: "var(--font-serif)" }}
                    >
                      {p.name}
                    </div>
                  </div>
                  <div className="text-ink-500 text-[0.6rem] font-mono truncate mt-1 leading-none">
                    {p.path}
                  </div>
                  {(p.sessionCount > 0 || p.lastActiveAt || p.totalCost > 0) && (
                    <div className="flex items-center gap-1.5 mt-1.5 text-ink-500 text-[0.6rem] font-mono leading-none">
                      {p.sessionCount > 0 && <span>{p.sessionCount} sess</span>}
                      {p.sessionCount > 0 && p.lastActiveAt && (
                        <span className="text-ink-700">·</span>
                      )}
                      {p.lastActiveAt && <span>{formatTimeAgo(p.lastActiveAt)}</span>}
                      {(p.sessionCount > 0 || p.lastActiveAt) && p.totalCost > 0 && (
                        <span className="text-ink-700">·</span>
                      )}
                      {p.totalCost > 0 && <span>{formatCost(p.totalCost)}</span>}
                    </div>
                  )}
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onRequestConfirm('Remove Project', `Remove "${p.name}"? This cannot be undone.`, () => onDelete(p.id));
                  }}
                  className="opacity-100 md:opacity-0 md:group-hover:opacity-100 text-ink-500 hover:text-rose-400 hover:bg-ink-800/40 transition-all shrink-0 p-1 rounded-md touch-target"
                  title="Remove project"
                  aria-label="Remove project"
                >
                  <Icon name="close" size={11} />
                </button>
              </div>
            </div>
          );
        })}

        {/* Add project — drop-zone style. Always visible after the last
            project, doubles as the "no projects" CTA. */}
        {!showAddProject && (
          <button
            onClick={onToggleAdd}
            className="w-full mt-1 px-3 py-2.5 rounded-md border border-dashed border-ink-700/50 hover:border-amber-600/40 hover:bg-amber-500/[0.03] text-ink-500 hover:text-amber-500 text-[0.72rem] font-mono transition-theme flex items-center justify-center gap-2 group"
            style={{ fontFamily: "var(--font-mono)" }}
            aria-label="Add project"
            title="Add project"
          >
            <Icon name="plus" size={11} className="text-ink-500 group-hover:text-amber-500" />
            <span className="uppercase tracking-[0.18em] text-[0.58rem]">
              Add Project
            </span>
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Session List ───────────────────────────────────────

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
  onCopySession,
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
  onCopySession?: (s: SessionSummary) => void;
  onRefresh: () => void;
  onContinueLatest: () => void;
  projectName: string;
  streamingSessionIds: Set<string>;
  isAddingProject?: boolean;
  onRequestConfirm: (title: string, message: string, onConfirm: () => void) => void;
}) {
  return (
    <div>
      <SectionLabel
        action={
          <>
            <SidebarIconButton
              onClick={onRefresh}
              title="Refresh sessions"
              ariaLabel="Refresh sessions"
            >
              <Icon name="refresh" size={11} />
            </SidebarIconButton>
            <SidebarIconButton
              onClick={onNewSession}
              title="New session"
              ariaLabel="New session"
            >
              <Icon name="plus" size={11} />
            </SidebarIconButton>
          </>
        }
      >
        Sessions
      </SectionLabel>

      {/* Search — ghost, no border, gains amber focus ring */}
      <div className="relative mb-2 px-0.5">
        <Icon
          name="search"
          size={11}
          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-500 pointer-events-none"
        />
        <input
          type="text"
          placeholder="Filter…"
          value={search}
          onChange={e => onSearch(e.target.value)}
          className="w-full bg-ink-950/40 border border-transparent rounded-md pl-7 pr-7 py-1.5 text-ink-200 text-[0.72rem] font-mono placeholder-ink-500 hover:bg-ink-950/60 focus:bg-ink-950/70 focus:border-amber-600/40 focus:outline-none transition-theme"
        />
        {search && (
          <button
            onClick={() => onSearch("")}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-500 hover:text-ink-200 p-0.5 rounded transition-theme"
            aria-label="Clear search"
          >
            <Icon name="close-thick" size={8} />
          </button>
        )}
      </div>

      {/* Continue latest — subtle amber action card */}
      {sessions.length > 0 && !search && (
        <button
          onClick={onContinueLatest}
          className="w-full text-left pl-3 pr-2.5 py-2 rounded-md mb-1 bg-amber-500/[0.06] hover:bg-amber-500/[0.12] text-amber-500 hover:text-amber-400 text-[0.72rem] transition-theme flex items-center gap-2 group"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          <span className="shrink-0 w-1 h-1 rounded-full bg-amber-500 group-hover:scale-125 transition-theme" />
          <span className="uppercase tracking-[0.16em] text-[0.6rem] font-medium flex-1">
            Continue Latest
          </span>
          <Icon name="chevron-right" size={10} className="text-amber-500/70" />
        </button>
      )}

      {/* Grouped session list */}
      {(["today", "yesterday", "thisWeek", "older"] as DateGroup[]).map(group => {
        const items = groupedSessions[group];
        if (items.length === 0) return null;
        return (
          <div key={group}>
            <div className="sidebar-group-label">
              <span>{GROUP_LABELS[group]}</span>
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
                    onCopySession={onCopySession}
                    onRequestConfirm={onRequestConfirm}
                  />
                );
              })}
            </div>
          </div>
        );
      })}

      {filteredSessions.length === 0 && (
        <div className="px-3 py-6">
          <p
            className="text-ink-500 text-[0.72rem] text-center"
            style={{ fontFamily: "var(--font-serif)", fontStyle: "italic" }}
          >
            {search ? "No matches." : "No sessions yet."}
          </p>
          {!search && (
            <p className="text-ink-500 text-[0.6rem] font-mono text-center mt-1">
              Start a new conversation above.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Session Item ───────────────────────────────────────

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
  onCopySession,
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

  return (
    <div
      data-session-idx={idx}
      onContextMenu={handleContextMenu}
      {...longPress}
      className={`relative rounded-md transition-theme ${
        isActive
          ? "sidebar-item-active"
          : isFocused
          ? "bg-ink-850/40"
          : "hover:bg-ink-850/25"
      }`}
    >
      <button
        onClick={() => onSelect(s)}
        className="w-full text-left pl-3 pr-2.5 py-2 min-h-[42px]"
        title={preview || undefined}
      >
        <div className="flex items-center gap-2">
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
                className="w-full bg-ink-950/60 border border-amber-600/40 rounded px-1.5 py-0.5 text-ink-100 text-[0.8rem] focus:outline-none"
                style={{ fontFamily: "var(--font-serif)" }}
              />
            ) : (
              <div className="flex items-center gap-2 min-w-0">
                {isStreaming && (
                  <span
                    className="shrink-0 w-1.5 h-1.5 rounded-full bg-teal-400 animate-pulse"
                    title="Streaming"
                    aria-label="PI is streaming"
                  />
                )}
                <div
                  className="text-ink-200 text-[0.82rem] truncate leading-snug flex-1 min-w-0"
                  style={{ fontFamily: "var(--font-serif)" }}
                >
                  {displayName}
                </div>
              </div>
            )}
            {/* Metadata */}
            <div className="flex items-center gap-1.5 mt-0.5 text-ink-500 text-[0.6rem] font-mono leading-none">
              <span>{formatTimeAgo(s.lastActiveAt || s.timestamp)}</span>
              {s.messageCount > 0 && (
                <>
                  <span className="text-ink-700">·</span>
                  <span>{s.messageCount}m</span>
                </>
              )}
              {s.cost > 0 && (
                <>
                  <span className="text-ink-700">·</span>
                  <span>{formatCost(s.cost)}</span>
                </>
              )}
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
          {onCopySession && (
            <ContextMenuItem
              label={ctxMenu.copied ? "Copied ✓" : "Copy entire session"}
              icon={<Icon name="copy-plain" size={10} />}
              onClick={() => {
                flashCopied();
                onCopySession(s);
              }}
            />
          )}
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
