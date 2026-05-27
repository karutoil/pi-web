import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Sidebar } from '../components/Sidebar';
import type { Project, SessionSummary } from '@pi-web/shared';
import type { ViewState } from '../App';

// Mock ContextMenu portal (it renders in a real DOM portal — skip in jsdom)
vi.mock('../components/ContextMenu', () => ({
  ContextMenuPortal: ({ children, onClose }: { children: React.ReactNode; onClose: () => void }) => (
    <div data-testid="context-menu" onClick={onClose}>{children}</div>
  ),
  ContextMenuItem: ({ label, onClick }: { label: string; onClick: () => void }) => (
    <button data-testid="ctx-item" onClick={onClick}>{label}</button>
  ),
  ContextMenuDivider: () => <hr data-testid="ctx-divider" />,
  useLongPress: (cb: any) => ({ onMouseDown: cb, onTouchStart: cb }),
}));

const mockProject: Project = {
  id: 'p1',
  name: 'Test Project',
  path: '/home/test/project',
  addedAt: new Date().toISOString(),
  lastOpenedAt: new Date().toISOString(),
  sessionCount: 2,
  lastActiveAt: new Date().toISOString(),
  totalTokens: 1000,
  totalCost: 0.05,
};

const now = new Date();
const yesterday = new Date(now.getTime() - 86400000);
const lastWeek = new Date(now.getTime() - 10 * 86400000);

const mockSessions: SessionSummary[] = [
  {
    id: 's1',
    filePath: '/data/s1.jsonl',
    cwd: '/home/test',
    timestamp: now.toISOString(),
    name: 'Today session',
    messageCount: 5,
    lastMessage: 'hello',
    model: 'claude-3',
    firstMessage: 'hi',
    createdAt: now.toISOString(),
    lastActiveAt: now.toISOString(),
    tokenCount: 500,
    cost: 0.01,
    isRecentlyActive: true,
  },
  {
    id: 's2',
    filePath: '/data/s2.jsonl',
    cwd: '/home/test',
    timestamp: yesterday.toISOString(),
    name: 'Yesterday session',
    messageCount: 3,
    lastMessage: 'fix bug',
    model: 'gpt-4',
    firstMessage: 'fix this',
    createdAt: yesterday.toISOString(),
    lastActiveAt: yesterday.toISOString(),
    tokenCount: 300,
    cost: 0.02,
    isRecentlyActive: false,
  },
  {
    id: 's3',
    filePath: '/data/s3.jsonl',
    cwd: '/home/test',
    timestamp: lastWeek.toISOString(),
    name: 'Old session',
    messageCount: 1,
    lastMessage: null,
    model: null,
    firstMessage: 'old stuff',
    createdAt: lastWeek.toISOString(),
    lastActiveAt: lastWeek.toISOString(),
    tokenCount: 100,
    cost: 0,
    isRecentlyActive: false,
  },
];

const defaultProps = {
  projects: [mockProject],
  sessions: mockSessions,
  selectedProject: mockProject,
  activeSession: null,
  view: 'sessions' as ViewState,
  showAddProject: false,
  theme: 'dark' as const,
  onSelectProject: vi.fn(),
  onSelectSession: vi.fn(),
  onBack: vi.fn(),
  onNewSession: vi.fn(),
  onAddProject: vi.fn(),
  onDeleteProject: vi.fn(),
  onToggleAddProject: vi.fn(),
  onToggleTheme: vi.fn(),
  onDeleteSession: vi.fn(),
  onRenameSession: vi.fn(),
  onForkSession: vi.fn(),
  onRefreshSessions: vi.fn(),
  onContinueLatest: vi.fn(),
  streamingSessionIds: new Set<string>(),
};

describe('Sidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Session grouping ───

  it('groups sessions by date (Today, Yesterday, This Week, Older)', () => {
    render(<Sidebar {...defaultProps} />);
    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('Yesterday')).toBeInTheDocument();
    expect(screen.getByText('Older')).toBeInTheDocument();
  });

  it('renders session names under correct groups', () => {
    render(<Sidebar {...defaultProps} />);
    expect(screen.getByText('Today session')).toBeInTheDocument();
    expect(screen.getByText('Yesterday session')).toBeInTheDocument();
    expect(screen.getByText('Old session')).toBeInTheDocument();
  });

  it('calls onSelectSession when clicking a session', () => {
    render(<Sidebar {...defaultProps} />);
    fireEvent.click(screen.getByText('Today session'));
    expect(defaultProps.onSelectSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's1' }),
    );
  });

  // ─── Search filter ───

  it('filters sessions by name', () => {
    render(<Sidebar {...defaultProps} />);
    const searchInput = screen.getByPlaceholderText('Filter…');
    fireEvent.change(searchInput, { target: { value: 'today' } });
    expect(screen.getByText('Today session')).toBeInTheDocument();
    expect(screen.queryByText('Yesterday session')).not.toBeInTheDocument();
  });

  it('filters sessions by model', () => {
    render(<Sidebar {...defaultProps} />);
    const searchInput = screen.getByPlaceholderText('Filter…');
    fireEvent.change(searchInput, { target: { value: 'gpt' } });
    expect(screen.getByText('Yesterday session')).toBeInTheDocument();
    expect(screen.queryByText('Today session')).not.toBeInTheDocument();
  });

  it('shows no matches message for empty filter result', () => {
    render(<Sidebar {...defaultProps} />);
    const searchInput = screen.getByPlaceholderText('Filter…');
    fireEvent.change(searchInput, { target: { value: 'zzzzz' } });
    expect(screen.getByText('No matches.')).toBeInTheDocument();
  });

  it('clears search via clear button', () => {
    render(<Sidebar {...defaultProps} />);
    const searchInput = screen.getByPlaceholderText('Filter…');
    fireEvent.change(searchInput, { target: { value: 'xyz' } });
    const clearBtn = screen.getByLabelText('Clear search');
    fireEvent.click(clearBtn);
    expect(searchInput).toHaveValue('');
  });

  // ─── Project view ───

  it('shows projects when view=projects', () => {
    render(<Sidebar {...defaultProps} view="projects" selectedProject={null} />);
    expect(screen.getByText('Test Project')).toBeInTheDocument();
  });

  it('shows add project explorer when toggled', () => {
    render(<Sidebar {...defaultProps} view="projects" selectedProject={null} showAddProject={true} />);
    expect(screen.getByText('Add Project')).toBeInTheDocument();
  });

  // ─── Theme toggle ───

  it('renders theme toggle button', () => {
    render(<Sidebar {...defaultProps} />);
    expect(screen.getByLabelText('Toggle dark mode')).toBeInTheDocument();
  });

  it('calls onToggleTheme on theme button click', () => {
    render(<Sidebar {...defaultProps} />);
    fireEvent.click(screen.getByLabelText('Toggle dark mode'));
    expect(defaultProps.onToggleTheme).toHaveBeenCalled();
  });
});
