import type { Project, SessionSummary } from "@pi-web/shared";
import { ServerRail } from "./ServerRail";
import { ChannelList } from "./ChannelList";
import type { Theme } from "../hooks/useTheme";

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
  theme: Theme;
  onToggleTheme: () => void;
}

export function ProjectSessionSidebar(props: ProjectSessionSidebarProps) {
  const project = props.selectedProject;

  return (
    <div className="flex min-w-0 min-h-0 h-full max-h-full max-w-full overflow-hidden">
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
          theme={props.theme}
          onToggleTheme={props.onToggleTheme}
          fill
        />
      ) : (
        <div className="flex-1 flex flex-col min-w-0 min-h-0 h-full max-h-full max-w-full p-5 text-ink-300">
          <div className="text-ink-100 font-serif text-lg mb-2">Projects</div>
          <p className="text-ink-500 text-xs font-mono leading-relaxed">Select a project from the left rail to view its sessions.</p>
        </div>
      )}
    </div>
  );
}
