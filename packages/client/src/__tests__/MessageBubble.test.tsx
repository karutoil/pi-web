import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MessageBubble } from '../components/MessageBubble';
import type { ChatMessage } from '@pi-web/shared';

// Mock ContextMenu portal
vi.mock('../components/ContextMenu', () => ({
  ContextMenuPortal: ({ children, onClose }: { children: React.ReactNode; onClose: () => void }) => (
    <div data-testid="context-menu" onClick={onClose}>{children}</div>
  ),
  ContextMenuItem: ({ label, onClick }: { label: string; onClick: () => void }) => (
    <button data-testid="ctx-item" onClick={onClick}>{label}</button>
  ),
  ContextMenuDivider: () => <hr data-testid="ctx-divider" />,
}));

// Mock react-markdown to avoid complex rendering in tests
vi.mock('react-markdown', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div data-testid="markdown">{children}</div>,
}));

vi.mock('remark-gfm', () => ({ default: () => {} }));
vi.mock('rehype-sanitize', () => ({ default: () => {} }));

// ─── Test data ───

const userMessage: ChatMessage = {
  role: 'user',
  content: 'Hello, PI!',
  timestamp: Date.now(),
};

const assistantMessage: ChatMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: 'Hi there!' }],
  model: 'claude-3',
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
  timestamp: Date.now(),
};

const assistantWithThinking: ChatMessage = {
  role: 'assistant',
  content: [
    { type: 'thinking', thinking: 'Let me think about this...' },
    { type: 'text', text: 'Here is my answer.' },
  ],
  model: 'claude-3',
  timestamp: Date.now(),
};

const toolResultMessage: ChatMessage = {
  role: 'toolResult',
  content: 'file contents here',
  toolName: 'read',
  toolCallId: 'tc1',
  timestamp: Date.now(),
};

const bashMessage: ChatMessage = {
  role: 'bashExecution',
  content: '',
  command: 'ls -la',
  output: 'file1.txt\nfile2.txt',
  exitCode: 0,
  timestamp: Date.now(),
};

const systemMessage: ChatMessage = {
  role: 'compactionSummary',
  content: 'Context was compacted',
  timestamp: Date.now(),
};

const abortedMessage: ChatMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: 'Partial...' }],
  stopReason: 'aborted',
  model: 'claude-3',
  timestamp: Date.now(),
};

const erroredToolResult: ChatMessage = {
  role: 'toolResult',
  content: 'command not found',
  toolName: 'bash',
  toolCallId: 'tc2',
  isError: true,
  timestamp: Date.now(),
};

const defaultProps = {
  showThinking: false,
};

describe('MessageBubble', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── User messages ───

  it('renders user message text', () => {
    render(<MessageBubble message={userMessage} {...defaultProps} />);
    expect(screen.getByText('Hello, PI!')).toBeInTheDocument();
  });

  it('renders user bubble with amber styling', () => {
    const { container } = render(<MessageBubble message={userMessage} {...defaultProps} />);
    const bubble = container.querySelector('.bg-amber-500\\/12');
    expect(bubble).toBeInTheDocument();
  });

  // ─── Assistant messages ───

  it('renders assistant message text', () => {
    render(<MessageBubble message={assistantMessage} {...defaultProps} />);
    expect(screen.getByTestId('markdown')).toHaveTextContent('Hi there!');
  });

  it('renders assistant avatar', () => {
    const { container } = render(<MessageBubble message={assistantMessage} {...defaultProps} />);
    expect(container.querySelector('.bg-amber-500\\/20')).toBeInTheDocument();
  });

  it('shows model name and token count', () => {
    render(<MessageBubble message={assistantMessage} {...defaultProps} />);
    expect(screen.getByText('claude-3')).toBeInTheDocument();
    expect(screen.getByText(/tokens/)).toBeInTheDocument();
  });

  it('shows aborted label for aborted messages', () => {
    render(<MessageBubble message={abortedMessage} {...defaultProps} />);
    expect(screen.getByText('aborted')).toBeInTheDocument();
  });

  // ─── Thinking blocks ───

  it('hides thinking when showThinking=false', () => {
    render(<MessageBubble message={assistantWithThinking} showThinking={false} />);
    expect(screen.queryByText('Reasoning')).not.toBeInTheDocument();
  });

  it('shows thinking when showThinking=true', () => {
    render(<MessageBubble message={assistantWithThinking} showThinking={true} />);
    expect(screen.getByText('Reasoning')).toBeInTheDocument();
  });

  // ─── Tool results ───

  it('renders tool result with tool name', () => {
    render(<MessageBubble message={toolResultMessage} {...defaultProps} />);
    expect(screen.getByText(/read result/)).toBeInTheDocument();
  });

  it('renders error tool result with error indicator', () => {
    render(<MessageBubble message={erroredToolResult} {...defaultProps} />);
    expect(screen.getByText('(error)')).toBeInTheDocument();
  });

  // ─── Bash execution ───

  it('renders bash execution with command', () => {
    render(<MessageBubble message={bashMessage} {...defaultProps} />);
    expect(screen.getByText(/\$ ls -la/)).toBeInTheDocument();
  });

  it('shows exit code for bash execution', () => {
    render(<MessageBubble message={bashMessage} {...defaultProps} />);
    expect(screen.getByText('[0]')).toBeInTheDocument();
  });

  // ─── System messages ───

  it('renders compaction summary', () => {
    render(<MessageBubble message={systemMessage} {...defaultProps} />);
    expect(screen.getByText('Context compacted')).toBeInTheDocument();
  });

  // ─── Context menu ───

  it('shows context menu on right-click for assistant messages', () => {
    render(<MessageBubble message={assistantMessage} {...defaultProps} />);
    const bubble = screen.getByTestId('markdown').closest('[oncontextmenu]')?.parentElement || screen.getByTestId('markdown').parentElement?.parentElement;
    if (bubble) {
      fireEvent.contextMenu(bubble);
      expect(screen.getByTestId('context-menu')).toBeInTheDocument();
    }
  });

  it('does not show context menu for tool results', () => {
    render(<MessageBubble message={toolResultMessage} {...defaultProps} />);
    // Tool result should not trigger context menu
    const { container } = render(<MessageBubble message={toolResultMessage} {...defaultProps} />);
    expect(container.querySelector('[data-testid="context-menu"]')).not.toBeInTheDocument();
  });
});
