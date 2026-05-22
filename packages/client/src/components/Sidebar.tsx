import { useState } from "react";
import type { Project, SessionSummary } from "@pi-web/shared";
import type { ViewState } from "../App";
import type { Theme } from "../hooks/useTheme";

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
}

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
}: SidebarProps) {
  return (
    <aside className="w-72 shrink-0 flex flex-col border-r border-ink-800 bg-ink-900/50">
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
      <div className="flex-1 overflow-y-auto custom-scrollbar">
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

        {view === "sessions" && selectedProject && (
          <SessionList
            sessions={sessions}
            activeSession={activeSession}
            onSelect={onSelectSession}
            onNewSession={onNewSession}
            projectName={selectedProject.name}
          />
        )}

        {view === "chat" && selectedProject && (
          <SessionList
            sessions={sessions}
            activeSession={activeSession}
            onSelect={onSelectSession}
            onNewSession={onNewSession}
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

function SessionList({
  sessions,
  activeSession,
  onSelect,
  onNewSession,
  projectName,
}: {
  sessions: SessionSummary[];
  activeSession: SessionSummary | null;
  onSelect: (s: SessionSummary) => void;
  onNewSession: () => void;
  projectName: string;
}) {
  return (
    <div className="p-3">
      <div className="flex items-center justify-between mb-3 px-1">
        <div>
          <h2 className="text-xs font-semibold text-ink-400 uppercase tracking-wider">Sessions</h2>
          <p className="text-ink-600 text-xs font-mono mt-0.5 truncate">{projectName}</p>
        </div>
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

      {sessions.length === 0 && (
        <p className="text-ink-600 text-sm px-1 py-4 text-center italic">
          No sessions. Click + to start.
        </p>
      )}

      <div className="space-y-0.5">
        {sessions.map(s => (
          <button
            key={s.id}
            onClick={() => onSelect(s)}
            className={`w-full text-left px-3 py-2.5 rounded-md transition-theme ${
              activeSession?.id === s.id
                ? "bg-ink-850 border border-ink-700"
                : "hover:bg-ink-850/50 border border-transparent"
            }`}
          >
            <div className="text-ink-200 text-sm truncate">
              {s.name || s.lastMessage || "Untitled"}
            </div>
            <div className="flex items-center gap-2 mt-1 text-ink-600 text-xs font-mono">
              <span>{s.messageCount} msgs</span>
              {s.model && <span>· {s.model}</span>}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
