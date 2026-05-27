import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ChatInput } from '../components/ChatInput';
import type { CommandInfo } from '@pi-web/shared';

// Mock imageUtils so compressImage doesn't need canvas
vi.mock('../lib/imageUtils', () => ({
  compressImage: vi.fn(async (blob: Blob) => blob),
}));

const defaultCommands: CommandInfo[] = [
  { name: 'help', description: 'Show help', source: 'skill' },
  { name: 'compact', description: 'Compact context', source: 'skill' },
];

const defaultProps = {
  onSend: vi.fn(),
  onAbort: vi.fn(),
  isStreaming: false,
  disabled: false,
  commands: defaultCommands,
  onRequestCommands: vi.fn(),
  statusEntries: {},
  widgets: {},
  autoRetry: null,
  onAbortRetry: vi.fn(),
};

describe('ChatInput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Send action (text) ───

  it('calls onSend with trimmed text on Enter', () => {
    render(<ChatInput {...defaultProps} />);
    const textarea = screen.getByPlaceholderText('Ask PI...');
    fireEvent.change(textarea, { target: { value: '  hello world  ' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    expect(defaultProps.onSend).toHaveBeenCalledWith('hello world', undefined);
  });

  it('does not send empty text', () => {
    render(<ChatInput {...defaultProps} />);
    const textarea = screen.getByPlaceholderText('Ask PI...');
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    expect(defaultProps.onSend).not.toHaveBeenCalled();
  });

  it('does not send when disabled', () => {
    render(<ChatInput {...defaultProps} disabled={true} />);
    const textarea = screen.getByPlaceholderText('Ask PI...');
    fireEvent.change(textarea, { target: { value: 'hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    expect(defaultProps.onSend).not.toHaveBeenCalled();
  });

  it('allows shift+Enter for newlines (does not send)', () => {
    render(<ChatInput {...defaultProps} />);
    const textarea = screen.getByPlaceholderText('Ask PI...');
    fireEvent.change(textarea, { target: { value: 'hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(defaultProps.onSend).not.toHaveBeenCalled();
    // Browser default inserts newline on shift+Enter; value should remain intact
    // (jsdom does not simulate native key insertion, so we only verify no send)
    expect(textarea).toHaveValue('hello');
  });

  it('sends via click on send button', () => {
    render(<ChatInput {...defaultProps} />);
    const textarea = screen.getByPlaceholderText('Ask PI...');
    fireEvent.change(textarea, { target: { value: 'test msg' } });
    fireEvent.click(screen.getByLabelText('Send message'));
    expect(defaultProps.onSend).toHaveBeenCalledWith('test msg', undefined);
  });

  it('clears input after send', () => {
    render(<ChatInput {...defaultProps} />);
    const textarea = screen.getByPlaceholderText('Ask PI...');
    fireEvent.change(textarea, { target: { value: 'bye' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    expect(textarea).toHaveValue('');
  });

  // ─── Send action (images) ───

  it('renders image preview after image paste', async () => {
    const { container } = render(<ChatInput {...defaultProps} />);
    const textarea = screen.getByPlaceholderText('Ask PI...');

    const file = new File(['img'], 'test.png', { type: 'image/png' });
    Object.defineProperty(file, 'size', { value: 1024 });
    const clipboardData = { items: [{ type: 'image/png', kind: 'file', getAsFile: () => file }] };
    fireEvent.paste(textarea, { clipboardData: clipboardData as unknown as Record<string, unknown> });

    // Wait for async compressImage + FileReader
    await waitFor(() => {
      expect(screen.getByAltText('Attachment')).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  // ─── Abort action ───

  it('shows abort button when streaming', () => {
    render(<ChatInput {...defaultProps} isStreaming={true} />);
    expect(screen.getByLabelText('Abort')).toBeInTheDocument();
  });

  it('calls onAbort when abort button clicked', () => {
    render(<ChatInput {...defaultProps} isStreaming={true} />);
    fireEvent.click(screen.getByLabelText('Abort'));
    expect(defaultProps.onAbort).toHaveBeenCalledOnce();
  });

  it('shows streaming placeholder when streaming', () => {
    render(<ChatInput {...defaultProps} isStreaming={true} />);
    expect(screen.getByPlaceholderText('Steer...')).toBeInTheDocument();
  });

  it('shows connecting message when disabled', () => {
    render(<ChatInput {...defaultProps} disabled={true} />);
    expect(screen.getAllByText('Connecting...').length).toBeGreaterThan(0);
  });

  // ─── Command completion ───

  it('shows command completer on "/" input', () => {
    render(<ChatInput {...defaultProps} />);
    const textarea = screen.getByPlaceholderText('Ask PI...');
    fireEvent.change(textarea, { target: { value: '/' } });
    expect(screen.getByText(/Commands/)).toBeInTheDocument();
  });

  it('requests commands when none loaded', () => {
    render(<ChatInput {...defaultProps} commands={[]} />);
    const textarea = screen.getByPlaceholderText('Ask PI...');
    fireEvent.change(textarea, { target: { value: '/' } });
    expect(defaultProps.onRequestCommands).toHaveBeenCalled();
  });

  it('filters commands by text after "/"', () => {
    render(<ChatInput {...defaultProps} />);
    const textarea = screen.getByPlaceholderText('Ask PI...');
    // Open completer first with "/"
    fireEvent.change(textarea, { target: { value: '/' } });
    expect(screen.getByText(/Commands/)).toBeInTheDocument();
    // Then type filter text - keep "/" at end position so completer stays open
    fireEvent.change(textarea, { target: { value: '/hel' } });
    expect(screen.getByText('/help')).toBeInTheDocument();
    expect(screen.queryByText('/compact')).not.toBeInTheDocument();
  });

  it('closes completer on Escape', () => {
    render(<ChatInput {...defaultProps} />);
    const textarea = screen.getByPlaceholderText('Ask PI...');
    fireEvent.change(textarea, { target: { value: '/' } });
    expect(screen.getByText(/Commands/)).toBeInTheDocument();
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(screen.queryByText(/Commands/)).not.toBeInTheDocument();
  });

  it('selects command and inserts text', () => {
    render(<ChatInput {...defaultProps} />);
    const textarea = screen.getByPlaceholderText('Ask PI...');
    fireEvent.change(textarea, { target: { value: '/' } });
    fireEvent.click(screen.getByText('/help'));
    expect(textarea).toHaveValue('/help ');
  });
});
