import type { Project } from "@pi-web/shared";
import { Icon } from "./Icon";

interface EmptyStateProps {
  projects: Project[];
  onSelectProject: (p: Project) => void;
  onAddProject: () => void;
}

export function EmptyState({ projects, onSelectProject, onAddProject }: EmptyStateProps) {
  return (
    <div className="empty-state-shell">
      <div className="empty-state-card animate-fade-in-up">
        <div className="empty-state-rule">
          <span>PI Web</span>
        </div>

        <div className="empty-state-logo-wrap">
          <img src="/pi-logo.svg" alt="PI" className="empty-state-logo" />
        </div>

        <h1 className="empty-state-title">
          Start where your work lives
        </h1>
        <p className="empty-state-copy">
          Choose a project directory to open the PI workspace.
          Chat, browse sessions, run commands, and keep the agent grounded in your codebase.
        </p>

        {projects.length > 0 ? (
          <div className="empty-state-section">
            <div className="empty-state-section-title">Continue with a project</div>
            {projects.slice(0, 5).map(p => (
              <button
                type="button"
                key={p.id}
                onClick={() => onSelectProject(p)}
                className="empty-state-project"
              >
                <div className="empty-state-project-icon">
                  <Icon name="project" size={14} />
                </div>
                <div className="empty-state-project-copy">
                  <div>{p.name}</div>
                  <div>{p.path}</div>
                </div>
              </button>
            ))}
            <button
              type="button"
              onClick={onAddProject}
              className="empty-state-project"
              style={{ borderStyle: 'dashed' }}
            >
              <div className="empty-state-project-icon">
                <Icon name="plus-thick" size={14} />
              </div>
              <div className="empty-state-project-copy">
                <div>Add a project</div>
                <div>Connect another codebase</div>
              </div>
            </button>
          </div>
        ) : (
          <div>
            <button
              type="button"
              onClick={onAddProject}
              className="empty-state-primary"
            >
              <Icon name="plus-thick" size={16} />
              Add a project directory
            </button>
            <p className="empty-state-hint">
              Add a local directory to start chatting with PI
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
