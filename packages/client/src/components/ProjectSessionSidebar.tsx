import type { Project, SessionSummary } from "@pi-web/shared";
import { Icon } from "./Icon";
import { ServerRail } from "./ServerRail";
import { ChannelList } from "./ChannelList";

interface ProjectSessionSidebarProps {
  projects: Project[];
  selectedProject: Project | null;
  streamingProjectIds: Set<string>;
  isAddingProject: boolean;
  sessions: SessionSummary[];
  activeSession: SessionSummary | null;
  search: string;
  onSearch: (q: string) => void;
  onSelectProject: (p: Project) => void;
  onSelectSession: (s: SessionSummary) => void;
  onSelectHome: () => void;
  onAddProject: () => void;
  onNewSession: () => void;
  onDeleteProject: (project: Project) => void;
  onDeleteSession: (s: SessionSummary) => void;
  onRenameSession: (s: SessionSummary, name: string) => void;
  onForkSession: (entryId: string) => void;
  onCopySession: (s: SessionSummary) => void;
  onRefreshSessions: () => void;
  onContinueLatest: () => void;
  streamingSessionIds: Set<string>;
  onRequestConfirm: (title: string, message: string, onConfirm: () => void) => void;
  onOpenSettings?: () => void;
}

export function ProjectSessionSidebar(props: ProjectSessionSidebarProps) {
  const project = props.selectedProject;

  return (
    <div className="project-session-shell">
      <ServerRail
        projects={props.projects}
        selectedProject={project}
        streamingProjectIds={props.streamingProjectIds}
        isAddingProject={props.isAddingProject}
        isHomeActive={!project}
        onSelectProject={props.onSelectProject}
        onSelectHome={props.onSelectHome}
        onAddProject={props.onAddProject}
        onDeleteProject={(id) => {
          const deleted = props.projects.find(p => p.id === id);
          if (deleted) props.onDeleteProject(deleted);
        }}
        onRequestConfirm={props.onRequestConfirm}
        onOpenSettings={props.onOpenSettings}
      />
      {project ? (
        <ChannelList
          project={project}
          sessions={props.sessions}
          activeSession={props.activeSession}
          search={props.search}
          onSearch={props.onSearch}
          onSelectSession={props.onSelectSession}
          onNewSession={props.onNewSession}
          onDeleteSession={props.onDeleteSession}
          onRenameSession={props.onRenameSession}
          onForkSession={props.onForkSession}
          onCopySession={props.onCopySession}
          onRefreshSessions={props.onRefreshSessions}
          onContinueLatest={props.onContinueLatest}
          streamingSessionIds={props.streamingSessionIds}
          onDeleteProject={props.onDeleteProject}
          onRequestConfirm={props.onRequestConfirm}
          fill
        />
      ) : (
        <div className="project-session-panel">
          <div className="project-session-empty">
            <div className="project-session-empty-ledger">
              <div className="project-session-empty-ledger-icon">
                <Icon name="hash" size={22} />
              </div>
              <div className="project-session-empty-ledger-title">Project ledger</div>
              <div className="project-session-empty-ledger-copy">
                Select a project from the left rail to open its session archive.
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
