import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChannelList } from '../components/ChannelList';
import type { Project, SessionSummary } from '@pi-web/shared';

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

// VersionChecker fetches /api/version on mount — stub it out here so the
// channel-list tests stay focused on layout/handlers. The component has
// its own dedicated test file that covers the fetch + display logic.
vi.mock('../components/VersionChecker', () => ({
  VersionChecker: () => <div data-testid="version-checker" />,
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
  project: mockProject,
  sessions: mockSessions,
  activeSession: null,
  search: '',
  onSearch: vi.fn(),
  onSelectSession: vi.fn(),
  onNewSession: vi.fn(),
  onDeleteSession: vi.fn(),
  onRenameSession: vi.fn(),
  onForkSession: vi.fn(),
  onRefreshSessions: vi.fn(),
  onContinueLatest: vi.fn(),
  streamingSessionIds: new Set<string>(),
  onDeleteProject: vi.fn(),
  onRequestConfirm: vi.fn(),
  theme: 'dark' as const,
  onToggleTheme: vi.fn(),
};

describe('ChannelList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Project header ───

  it('shows the project name in the header', () => {
    render(<ChannelList {...defaultProps} />);
    expect(screen.getByText('Test Project')).toBeInTheDocument();
  });

  it('shows the project path in the header', () => {
    render(<ChannelList {...defaultProps} />);
    expect(screen.getByText('/home/test/project')).toBeInTheDocument();
  });

  // ─── Session grouping ───

  it('groups sessions by date (Today, Yesterday, Older)', () => {
    render(<ChannelList {...defaultProps} />);
    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('Yesterday')).toBeInTheDocument();
    expect(screen.getByText('Older')).toBeInTheDocument();
  });

  it('renders session names under correct groups', () => {
    render(<ChannelList {...defaultProps} />);
    expect(screen.getByText('Today session')).toBeInTheDocument();
    expect(screen.getByText('Yesterday session')).toBeInTheDocument();
    expect(screen.getByText('Old session')).toBeInTheDocument();
  });

  it('calls onSelectSession when clicking a session', () => {
    render(<ChannelList {...defaultProps} />);
    fireEvent.click(screen.getByText('Today session'));
    expect(defaultProps.onSelectSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's1' }),
    );
  });

  // ─── Search filter ───

  it('filters sessions by name', () => {
    render(<ChannelList {...defaultProps} />);
    const searchInput = screen.getByPlaceholderText('Filter sessions…');
    fireEvent.change(searchInput, { target: { value: 'today' } });
    expect(screen.getByText('Today session')).toBeInTheDocument();
    expect(screen.queryByText('Yesterday session')).not.toBeInTheDocument();
  });

  it('filters sessions by model', () => {
    render(<ChannelList {...defaultProps} />);
    const searchInput = screen.getByPlaceholderText('Filter sessions…');
    fireEvent.change(searchInput, { target: { value: 'gpt' } });
    expect(screen.getByText('Yesterday session')).toBeInTheDocument();
    expect(screen.queryByText('Today session')).not.toBeInTheDocument();
  });

  it('shows no matches message for empty filter result', () => {
    render(<ChannelList {...defaultProps} />);
    const searchInput = screen.getByPlaceholderText('Filter sessions…');
    fireEvent.change(searchInput, { target: { value: 'zzzzz' } });
    expect(screen.getByText('No matches.')).toBeInTheDocument();
  });

  it('clears search via the clear button', () => {
    render(<ChannelList {...defaultProps} />);
    const searchInput = screen.getByPlaceholderText('Filter sessions…') as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: 'today' } });
    const clearBtn = screen.getByLabelText('Clear search');
    fireEvent.click(clearBtn);
    expect(defaultProps.onSearch).toHaveBeenCalledWith('');
  });

  // ─── Continue latest ───

  it('shows the continue latest button when sessions exist', () => {
    render(<ChannelList {...defaultProps} />);
    expect(screen.getByText(/Continue latest/i)).toBeInTheDocument();
  });

  it('calls onContinueLatest when clicking the continue latest button', () => {
    render(<ChannelList {...defaultProps} />);
    fireEvent.click(screen.getByText(/Continue latest/i));
    expect(defaultProps.onContinueLatest).toHaveBeenCalled();
  });

  // ─── Project actions menu ───

  it('opens the project actions menu when clicking the kebab', () => {
    render(<ChannelList {...defaultProps} />);
    fireEvent.click(screen.getByLabelText('Project actions'));
    // Menu items appear in a portal mock; check for the label
    expect(screen.getAllByText(/New session/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Remove project/i).length).toBeGreaterThan(0);
  });

  // ─── Empty state ───

  it('shows the no-sessions empty state when there are no sessions', () => {
    render(<ChannelList {...defaultProps} sessions={[]} />);
    expect(screen.getByText(/No sessions yet/i)).toBeInTheDocument();
  });

  it('does not show the continue latest button when there are no sessions', () => {
    render(<ChannelList {...defaultProps} sessions={[]} />);
    expect(screen.queryByText(/Continue latest/i)).not.toBeInTheDocument();
  });
});
