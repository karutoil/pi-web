import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import type { Project, SessionSummary } from "@pi-web/shared";
import type { ViewState } from "../App";
import type { Theme } from "../hooks/useTheme";
import { ContextMenuPortal, ContextMenuItem, ContextMenuDivider } from "./ContextMenu";

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
}: SidebarProps) {
  const [sessionSearch, setSessionSearch] = useState("");
  const [focusedIdx, setFocusedIdx] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);

  // Filtered sessions
  const filteredSessions = useMemo(() => {
    if (!sessionSearch.trim()) return sessions;
    const q = sessionSearch.toLowerCase();
    return sessions.filter(
      s => (s.name || s.lastMessage || "").toLowerCase().includes(q)
        || (s.model || "").toLowerCase().includes(q)
    );
  }, [sessions, sessionSearch]);

  // Group sessions by date
  const groupedSessions = useMemo(() => {
    const groups: Record<DateGroup, SessionSummary[]> = { today: [], yesterday: [], thisWeek: [], older: [] };
    for (const s of filteredSessions) {
      groups[getDateGroup(s.lastActiveAt || s.timestamp)].push(s);
    }
    return groups;
  }, [filteredSessions]);

  // Flat list for keyboard navigation
  const flatSessions = useMemo(() => {
    const result: SessionSummary[] = [];
    for (const g of ["today", "yesterday", "thisWeek", "older"] as DateGroup[]) {
      result.push(...groupedSessions[g]);
    }
    return result;
  }, [groupedSessions]);

  // Keyboard navigation
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

  // Scroll focused item into view
  useEffect(() => {
    if (focusedIdx >= 0 && listRef.current) {
      const items = listRef.current.querySelectorAll("[data-session-idx]");
      items[focusedIdx]?.scrollIntoView({ block: "nearest" });
    }
  }, [focusedIdx]);

  return (
    <aside className="w-72 shrink-0 flex flex-col border-r border-ink-800 bg-ink-900/50" onKeyDown={handleKeyDown}>
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3.5 border-b border-ink-800">
        <svg width="24" height="24" viewBox="0 0 128 128" fill="none" className="shrink-0">
          <circle cx="64" cy="64" r="60" stroke="currentColor" strokeWidth="8" className="text-amber-500" />
          <path d="M44 52 L64 32 L84 52" stroke="currentColor" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" className="text-amber-400" />
          <path d="M64 32 L64 88" stroke="currentColor" strokeWidth="6" strokeLinecap="round" className="text-amber-400" />
          <circle cx="64" cy="88" r="5" className="fill-amber-500" />
        </svg>
        <div>
          <h1 className="font-semibold text-ink-100 tracking-tight text-base">PI Web</h1>
          <p className="text-ink-500 text-xs font-mono">coding agent</p>
        </div>
      </div>

      {/* Navigation */}
      <div className="px-3 py-2 border-b border-ink-800">
        {view !== "projects" && (
          <button
            onClick={onBack}
            className="flex items-center gap-2 text-ink-400 hover:text-ink-200 text-sm transition-theme py-1.5 px-2 rounded-md hover:bg-ink-850 w-full"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M10 4 L6 8 L10 12" />
            </svg>
            {view === "sessions" ? "Projects" : "Sessions"}
          </button>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto custom-scrollbar" ref={listRef}>
        {view === "projects" && (
          <ProjectList
            projects={projects}
            selectedProject={selectedProject}
            showAddProject={showAddProject}
            onSelect={onSelectProject}
            onDelete={onDeleteProject}
            onAdd={onAddProject}
            onToggleAdd={onToggleAddProject}
          />
        )}

        {(view === "sessions" || view === "chat") && selectedProject && (
          <SessionList
            sessions={sessions}
            filteredSessions={filteredSessions}
            groupedSessions={groupedSessions}
            flatSessions={flatSessions}
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
            projectName={selectedProject.name}
          />
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-ink-800 text-ink-600 text-xs font-mono flex items-center justify-between">
        <button
          onClick={onToggleTheme}
          className="flex items-center gap-2 hover:text-ink-400 transition-theme"
          title={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
        >
          {theme === "light" ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="12" r="5" />
              <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
            </svg>
          )}
          <span>{theme === "light" ? "Dark" : "Light"}</span>
        </button>
        <span className="w-1.5 h-1.5 rounded-full bg-teal-500" title="Connected" />
      </div>
    </aside>
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
}: {
  projects: Project[];
  selectedProject: Project | null;
  showAddProject: boolean;
  onSelect: (p: Project) => void;
  onDelete: (id: string) => void;
  onAdd: (path: string, name: string) => void;
  onToggleAdd: () => void;
}) {
  return (
    <div className="p-3">
      <div className="flex items-center justify-between mb-3 px-1">
        <h2 className="text-xs font-semibold text-ink-400 uppercase tracking-wider">Projects</h2>
        <button
          onClick={onToggleAdd}
          className="text-ink-500 hover:text-ink-200 transition-theme p-1 rounded hover:bg-ink-850"
          title="Add project"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M8 3 L8 13 M3 8 L13 8" />
          </svg>
        </button>
      </div>

      {showAddProject && (
        <AddProjectForm onAdd={onAdd} onCancel={onToggleAdd} />
      )}

      {projects.length === 0 && !showAddProject && (
        <p className="text-ink-600 text-sm px-1 py-4 text-center italic">
          No projects yet. Add a local directory.
        </p>
      )}

      <div className="space-y-0.5">
        {projects.map(p => (
          <button
            key={p.id}
            onClick={() => onSelect(p)}
            className={`w-full text-left px-3 py-2.5 rounded-md transition-theme group ${
              selectedProject?.id === p.id
                ? "bg-ink-850 border border-ink-700"
                : "hover:bg-ink-850/50 border border-transparent"
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-ink-200 text-sm font-medium truncate">{p.name}</div>
                <div className="text-ink-500 text-xs font-mono truncate mt-0.5">{p.path}</div>
                {/* Project stats */}
                <div className="flex items-center gap-2 mt-1 text-ink-600 text-[0.65rem] font-mono">
                  {p.sessionCount > 0 && <span>{p.sessionCount} sessions</span>}
                  {p.lastActiveAt && <span>· {formatTimeAgo(p.lastActiveAt)}</span>}
                  {p.totalTokens > 0 && <span>· {formatTokens(p.totalTokens)} tok</span>}
                  {p.totalCost > 0 && <span>· {formatCost(p.totalCost)}</span>}
                </div>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`Remove "${p.name}"?`)) onDelete(p.id);
                }}
                className="opacity-0 group-hover:opacity-100 text-ink-600 hover:text-rose-500 transition-all shrink-0 p-0.5"
                title="Remove project"
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M4 4 L12 12 M12 4 L4 12" />
                </svg>
              </button>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Add Project Form ───

function AddProjectForm({
  onAdd,
  onCancel,
}: {
  onAdd: (path: string, name: string) => void;
  onCancel: () => void;
}) {
  const [path, setPath] = useState("");
  const [name, setName] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (path.trim()) {
      onAdd(path.trim(), name.trim() || "");
    }
  };

  return (
    <form onSubmit={handleSubmit} className="mb-3 p-3 rounded-lg bg-ink-850 border border-ink-750 animate-fade-in-up">
      <input
        type="text"
        placeholder="Directory path (e.g. /home/user/project)"
        value={path}
        onChange={e => setPath(e.target.value)}
        className="w-full bg-ink-900 border border-ink-700 rounded px-2.5 py-1.5 text-ink-200 text-sm font-mono placeholder-ink-600 focus:outline-none focus:border-amber-600 mb-2"
        autoFocus
      />
      <input
        type="text"
        placeholder="Display name (optional)"
        value={name}
        onChange={e => setName(e.target.value)}
        className="w-full bg-ink-900 border border-ink-700 rounded px-2.5 py-1.5 text-ink-200 text-sm placeholder-ink-600 focus:outline-none focus:border-amber-600 mb-2.5"
      />
      <div className="flex gap-2">
        <button
          type="submit"
          className="flex-1 bg-amber-600 hover:bg-amber-500 text-ink-950 text-sm font-medium py-1.5 rounded transition-theme"
        >
          Add Project
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 text-ink-500 hover:text-ink-300 text-sm transition-theme"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ─── Session List (with all new features) ───

function SessionList({
  sessions,
  filteredSessions,
  groupedSessions,
  flatSessions,
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
}: {
  sessions: SessionSummary[];
  filteredSessions: SessionSummary[];
  groupedSessions: Record<DateGroup, SessionSummary[]>;
  flatSessions: SessionSummary[];
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
}) {
  return (
    <div className="p-3">
      {/* Header with search + actions */}
      <div className="flex items-center justify-between mb-2 px-1">
        <div>
          <h2 className="text-xs font-semibold text-ink-400 uppercase tracking-wider">Sessions</h2>
          <p className="text-ink-600 text-xs font-mono mt-0.5 truncate">{projectName}</p>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={onRefresh}
            className="text-ink-500 hover:text-ink-200 transition-theme p-1 rounded hover:bg-ink-850"
            title="Refresh sessions"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M2 8 A6 6 0 1 1 8 14" />
              <path d="M2 8 L2 4 L5 6" />
            </svg>
          </button>
          <button
            onClick={onNewSession}
            className="text-ink-500 hover:text-ink-200 transition-theme p-1 rounded hover:bg-ink-850"
            title="New session"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M8 3 L8 13 M3 8 L13 8" />
            </svg>
          </button>
        </div>
      </div>

      {/* Search / Filter */}
      <div className="relative mb-2">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-600">
          <circle cx="7" cy="7" r="4" />
          <path d="M10 10 L14 14" />
        </svg>
        <input
          type="text"
          placeholder="Filter sessions..."
          value={search}
          onChange={e => onSearch(e.target.value)}
          className="w-full bg-ink-900 border border-ink-800 rounded-md pl-7 pr-2 py-1.5 text-ink-200 text-xs font-mono placeholder-ink-600 focus:outline-none focus:border-amber-600/60 transition-theme"
        />
        {search && (
          <button
            onClick={() => onSearch("")}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-600 hover:text-ink-400"
          >
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 4 L12 12 M12 4 L4 12" />
            </svg>
          </button>
        )}
      </div>

      {/* Continue latest */}
      {sessions.length > 0 && !search && (
        <button
          onClick={onContinueLatest}
          className="w-full text-left px-3 py-2 rounded-md mb-2 bg-amber-600/10 border border-amber-600/20 text-amber-400 text-xs font-medium hover:bg-amber-600/15 transition-theme"
        >
          ▶ Continue latest session
        </button>
      )}

      {filteredSessions.length === 0 && (
        <p className="text-ink-600 text-sm px-1 py-4 text-center italic">
          {search ? "No matching sessions." : "No sessions. Click + to start."}
        </p>
      )}

      {/* Grouped session list */}
      {(["today", "yesterday", "thisWeek", "older"] as DateGroup[]).map(group => {
        const items = groupedSessions[group];
        if (items.length === 0) return null;
        return (
          <div key={group} className="mb-2">
            <div className="px-1 py-1 text-[0.6rem] font-semibold text-ink-500 uppercase tracking-widest">
              {GROUP_LABELS[group]} ({items.length})
            </div>
            <div className="space-y-0.5">
              {items.map((s, idx) => {
                const globalIdx = flatSessions.indexOf(s);
                const isFocused = focusedIdx === globalIdx;
                return (
                  <SessionItem
                    key={s.id}
                    session={s}
                    isActive={activeSession?.id === s.id}
                    isFocused={isFocused}
                    idx={globalIdx}
                    onSelect={onSelect}
                    onDelete={onDelete}
                    onRename={onRename}
                    onFork={onFork}
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

// ─── Session Item (with hover preview, delete, rename, fork) ───

function SessionItem({
  session: s,
  isActive,
  isFocused,
  idx,
  onSelect,
  onDelete,
  onRename,
  onFork,
}: {
  session: SessionSummary;
  isActive: boolean;
  isFocused: boolean;
  idx: number;
  onSelect: (s: SessionSummary) => void;
  onDelete: (s: SessionSummary) => void;
  onRename: (s: SessionSummary, name: string) => void;
  onFork: (entryId: string) => void;
}) {
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(s.name || "");
  const renameRef = useRef<HTMLInputElement>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

  // Focus rename input
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
      className={`relative group rounded-md transition-theme ${
        isActive
          ? "bg-ink-850 border border-ink-700"
          : isFocused
          ? "bg-ink-850/70 border border-ink-800"
          : "hover:bg-ink-850/50 border border-transparent"
      }`}
    >
      <button
        onClick={() => onSelect(s)}
        className="w-full text-left px-3 py-2"
        title={preview || undefined}
      >
        <div className="flex items-center gap-2">
          {s.isRecentlyActive && (
            <span className="w-1.5 h-1.5 rounded-full bg-teal-400 shrink-0 animate-pulse" title="Active now" />
          )}
          {!s.isRecentlyActive && isActive && (
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" title="Selected" />
          )}
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
                className="w-full bg-ink-900 border border-amber-600/40 rounded px-1.5 py-0.5 text-ink-200 text-sm focus:outline-none"
              />
            ) : (
              <div className="text-ink-200 text-sm truncate">{displayName}</div>
            )}
            <div className="flex items-center gap-1.5 mt-0.5 text-ink-600 text-[0.65rem] font-mono flex-wrap">
              <span>{formatTimeAgo(s.lastActiveAt || s.timestamp)}</span>
              <span>·</span>
              <span>{s.messageCount} msgs</span>
              {s.model && <><span>·</span><span className="truncate max-w-[80px]">{s.model}</span></>}
              {s.tokenCount > 0 && <><span>·</span><span>{formatTokens(s.tokenCount)} tok</span></>}
              {s.cost > 0 && <><span>·</span><span>{formatCost(s.cost)}</span></>}
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
            icon={<svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3 L5 13 M3 10 L5 13 L8 12" /></svg>}
            onClick={() => { setCtxMenu(null); setIsRenaming(true); setRenameValue(s.name || ""); }}
          />
          <ContextMenuItem
            label="Fork From Here"
            icon={<svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 3 L8 8 L3 13 M8 8 L13 13" /></svg>}
            onClick={() => { setCtxMenu(null); onFork(s.id); }}
          />
          <ContextMenuDivider />
          <ContextMenuItem
            label="Delete"
            danger
            icon={<svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 5 L13 5 M6 5 L6 3 L10 3 L10 5 M5 5 L5 13 L11 13 L11 5" /></svg>}
            onClick={() => {
              setCtxMenu(null);
              if (confirm(`Delete "${displayName}"? This removes the session file.`)) onDelete(s);
            }}
          />
        </ContextMenuPortal>
      )}
    </div>
  );
}
