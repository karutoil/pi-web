import type { Project } from "@pi-web/shared";

interface EmptyStateProps {
  projects: Project[];
  onSelectProject: (p: Project) => void;
  onAddProject: () => void;
}

export function EmptyState({ projects, onSelectProject, onAddProject }: EmptyStateProps) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8">
      <div className="max-w-md w-full text-center animate-fade-in-up">
        {/* Logo */}
        <div className="mb-8">
          <img src="/pi-logo.svg" alt="PI" width="80" height="80" className="mx-auto" />
        </div>

        <h1 className="text-3xl font-semibold text-ink-100 mb-3 tracking-tight">
          PI Web
        </h1>
        <p className="text-ink-400 text-lg italic mb-8 leading-relaxed">
          A beautiful web interface for the PI coding agent.
          Chat, browse sessions, manage projects.
        </p>

        {projects.length > 0 ? (
          <div className="space-y-2">
            <p className="text-ink-500 text-sm font-mono mb-4">Continue with a project</p>
            {projects.slice(0, 5).map(p => (
              <button
                key={p.id}
                onClick={() => onSelectProject(p)}
                className="w-full text-left p-4 rounded-xl bg-ink-900 hover:bg-ink-850 border border-ink-800 hover:border-ink-700 transition-theme group"
              >
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-amber-500/15 border border-amber-500/25 flex items-center justify-center shrink-0">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="text-amber-500">
                      <path d="M2 13 L2 3 L14 3 L14 13 Z" />
                      <path d="M2 7 L14 7" />
                    </svg>
                  </div>
                  <div className="text-left min-w-0">
                    <div className="text-ink-200 font-medium text-sm">{p.name}</div>
                    <div className="text-ink-600 text-xs font-mono truncate">{p.path}</div>
                  </div>
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div>
            <button
              onClick={onAddProject}
              className="inline-flex items-center gap-2 px-6 py-3 bg-amber-600 hover:bg-amber-500 text-ink-950 font-medium rounded-xl transition-theme text-sm"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M8 3 L8 13 M3 8 L13 8" />
              </svg>
              Add a project directory
            </button>
            <p className="text-ink-600 text-xs font-mono mt-4">
              Add a local directory to start chatting with PI
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
