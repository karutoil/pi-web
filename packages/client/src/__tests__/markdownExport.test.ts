import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatMessage, ContentBlock } from '@pi-web/shared';
import {
  blocksToMarkdown,
  messageToMarkdown,
  turnToMarkdown,
  sessionToMarkdown,
  roleLabel,
  copyToClipboard,
} from '../lib/markdownExport';

const ts = '2025-01-01T00:00:00.000Z';

const user: ChatMessage = {
  role: 'user',
  content: 'Hello, PI!',
  timestamp: ts,
};

const assistantText: ChatMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: 'Hi there!' }],
  timestamp: ts,
};

const assistantWithThinking: ChatMessage = {
  role: 'assistant',
  content: [
    { type: 'thinking', thinking: 'Reasoning here' },
    { type: 'text', text: 'Final answer.' },
  ],
  timestamp: ts,
};

const assistantWithToolCall: ChatMessage = {
  role: 'assistant',
  content: [
    { type: 'text', text: 'Let me check.' },
    { type: 'toolCall', id: 'tc1', name: 'read', arguments: { path: '/tmp/x' } },
  ],
  timestamp: ts,
};

const toolResult: ChatMessage = {
  role: 'toolResult',
  content: 'file contents',
  toolName: 'read',
  toolCallId: 'tc1',
  timestamp: ts,
};

const toolResultWithDiff: ChatMessage = {
  role: 'toolResult',
  content: 'ignored',
  toolName: 'edit',
  toolCallId: 'tc2',
  details: { diff: '-old\n+new' },
  timestamp: ts,
};

const bash: ChatMessage = {
  role: 'bashExecution',
  content: '',
  command: 'ls -la',
  output: 'a.txt\nb.txt',
  exitCode: 0,
  timestamp: ts,
};

const bashErr: ChatMessage = {
  role: 'bashExecution',
  content: '',
  command: 'false',
  output: '',
  exitCode: 1,
  timestamp: ts,
};

describe('blocksToMarkdown', () => {
  it('returns string content unchanged', () => {
    expect(blocksToMarkdown('plain text')).toBe('plain text');
  });

  it('joins multiple text blocks with blank line', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ];
    expect(blocksToMarkdown(blocks)).toBe('first\n\nsecond');
  });

  it('renders thinking as a blockquote', () => {
    const blocks: ContentBlock[] = [{ type: 'thinking', thinking: 'line1\nline2' }];
    expect(blocksToMarkdown(blocks)).toBe('> line1\n> line2');
  });

  it('renders toolCall as a fenced JSON block with name comment', () => {
    const blocks: ContentBlock[] = [
      { type: 'toolCall', id: 'a', name: 'bash', arguments: { cmd: 'ls' } },
    ];
    const out = blocksToMarkdown(blocks);
    expect(out).toContain('```json');
    expect(out).toContain('// tool: bash');
    expect(out).toContain('"cmd": "ls"');
    expect(out.trim().endsWith('```')).toBe(true);
  });

  it('renders images as a mime-typed placeholder', () => {
    const blocks: ContentBlock[] = [{ type: 'image', data: 'x', mimeType: 'image/png' }];
    expect(blocksToMarkdown(blocks)).toBe('[image: image/png]');
  });

  it('skips unknown block types', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'ok' },
      { type: 'future_thing', text: 'no' } as unknown as ContentBlock,
    ];
    expect(blocksToMarkdown(blocks)).toBe('ok');
  });
});

describe('roleLabel', () => {
  it('maps known roles', () => {
    expect(roleLabel('user')).toBe('User');
    expect(roleLabel('assistant')).toBe('Assistant');
    expect(roleLabel('toolResult', 'read')).toBe('Tool (read)');
    expect(roleLabel('toolResult')).toBe('Tool (unknown)');
    expect(roleLabel('bashExecution')).toBe('Bash');
  });
  it('falls back to raw role name', () => {
    expect(roleLabel('mystery')).toBe('mystery');
  });
});

describe('messageToMarkdown', () => {
  it('user: returns raw text', () => {
    expect(messageToMarkdown(user)).toBe('Hello, PI!');
  });

  it('assistant text-only: returns raw text', () => {
    expect(messageToMarkdown(assistantText)).toBe('Hi there!');
  });

  it('assistant with thinking: thinking becomes blockquote, text stays raw', () => {
    const out = messageToMarkdown(assistantWithThinking);
    expect(out).toContain('> Reasoning here');
    expect(out).toContain('Final answer.');
  });

  it('assistant with toolCall: tool call rendered as JSON code block', () => {
    const out = messageToMarkdown(assistantWithToolCall);
    expect(out).toContain('Let me check.');
    expect(out).toContain('```json');
    expect(out).toContain('// tool: read');
  });

  it('toolResult: text wrapped in fenced block with header', () => {
    const out = messageToMarkdown(toolResult);
    expect(out).toContain('**read result**');
    expect(out).toContain('```\nfile contents\n```');
  });

  it('toolResult with diff: diff content preferred, fenced as diff', () => {
    const out = messageToMarkdown(toolResultWithDiff);
    expect(out).toContain('**edit result**');
    expect(out).toContain('```diff\n-old\n+new\n```');
    expect(out).not.toContain('ignored');
  });

  it('toolResult with error: header includes (error)', () => {
    const out = messageToMarkdown({ ...toolResult, isError: true });
    expect(out).toContain('*(error)*');
  });

  it('bashExecution: command, fenced output, exit code', () => {
    const out = messageToMarkdown(bash);
    expect(out).toContain('$ ls -la');
    expect(out).toContain('```\na.txt\nb.txt\n```');
    expect(out).toContain('exit 0');
  });

  it('bashExecution with no output: still shows command + exit', () => {
    const out = messageToMarkdown(bashErr);
    expect(out).toContain('$ false');
    expect(out).toContain('exit 1');
  });
});

describe('turnToMarkdown', () => {
  it('renders turn as role-prefixed sections joined by blank lines', () => {
    const turn: ChatMessage[] = [user, assistantText];
    const out = turnToMarkdown(turn);
    expect(out).toBe('## User\n\nHello, PI!\n\n## Assistant\n\nHi there!');
  });

  it('preserves tool calls and results within a turn', () => {
    const turn: ChatMessage[] = [user, assistantWithToolCall, toolResult];
    const out = turnToMarkdown(turn);
    expect(out).toContain('## User');
    expect(out).toContain('## Assistant');
    expect(out).toContain('## Tool (read)');
    expect(out).toContain('**read result**');
  });
});

describe('sessionToMarkdown', () => {
  it('includes H1 header when name provided', () => {
    const out = sessionToMarkdown([user, assistantText], 'My session');
    expect(out.startsWith('# My session\n\n')).toBe(true);
    expect(out).toContain('## User');
    expect(out).toContain('## Assistant');
  });

  it('omits H1 when name not provided', () => {
    const out = sessionToMarkdown([user]);
    expect(out.startsWith('## User')).toBe(true);
  });
});

describe('copyToClipboard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('uses navigator.clipboard.writeText in secure context', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    Object.defineProperty(window, 'isSecureContext', {
      configurable: true,
      value: true,
    });
    const ok = await copyToClipboard('hello');
    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('returns true via execCommand fallback when clipboard API is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
    // jsdom doesn't expose document.execCommand; stub it on the instance.
    const execSpy = vi.fn(() => true);
    (document as unknown as { execCommand: () => boolean }).execCommand = execSpy;
    const ok = await copyToClipboard('fallback');
    expect(ok).toBe(true);
    expect(execSpy).toHaveBeenCalledWith('copy');
  });

  it('returns false when both methods fail', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
    (document as unknown as { execCommand: () => boolean }).execCommand = () => {
      throw new Error('nope');
    };
    const ok = await copyToClipboard('x');
    expect(ok).toBe(false);
  });
});
