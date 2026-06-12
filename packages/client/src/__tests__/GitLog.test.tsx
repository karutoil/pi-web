import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { GitLog } from '../components/GitLog';
import type { GitLogEntry } from '../components/GitLog';

vi.mock('../components/ContextMenu', () => ({
  ContextMenuPortal: ({ children, onClose }: { children: React.ReactNode; onClose: () => void }) => (
    <div data-testid="context-menu" onClick={onClose}>{children}</div>
  ),
  ContextMenuItem: ({ label, onClick }: { label: string; onClick: () => void }) => (
    <button data-testid="ctx-item" onClick={onClick}>{label}</button>
  ),
  ContextMenuDivider: () => <hr data-testid="ctx-divider" />,
  useLongPress: () => ({}),
}));

const sampleEntry: GitLogEntry = {
  hash: '52471caf5072170c1d871563b954cef94964b8e8',
  shortHash: '52471ca',
  author: 'karutoil',
  date: new Date().toISOString(),
  message: 'fix(pwa): move banners',
  refs: '',
};

const logResponse = { log: [sampleEntry] };

function jsonResponse(body: unknown, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  });
}

describe('GitLog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders commits returned by /api/git/log', async () => {
    (globalThis as any).fetch = jsonResponse(logResponse);
    render(<GitLog cwd="/tmp" onRefresh={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText('52471ca')).toBeInTheDocument();
    });
  });

  it('shows the diff text when the server returns a non-empty diff', async () => {
    let call = 0;
    const patch = `--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,3 @@
-hello world
+hello world!
 context`;
    (globalThis as any).fetch = vi.fn().mockImplementation((url: string) => {
      call++;
      if (url.includes('/api/git/log')) return Promise.resolve({ ok: true, json: async () => logResponse });
      if (url.includes('/api/git/show')) return Promise.resolve({ ok: true, json: async () => ({ diff: patch }) });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    render(<GitLog cwd="/tmp" onRefresh={() => {}} />);
    await waitFor(() => expect(screen.getByText('52471ca')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByText('52471ca'));
    });
    await waitFor(() => {
      const probe = screen.getByTestId('file-diff');
      expect(probe).toBeInTheDocument();
    });
    expect(call).toBeGreaterThanOrEqual(2);
  });

  it('shows a clear empty-state when the server returns an empty diff (regression: #161)', async () => {
    (globalThis as any).fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/git/log')) return Promise.resolve({ ok: true, json: async () => logResponse });
      if (url.includes('/api/git/show')) return Promise.resolve({ ok: true, json: async () => ({ diff: '' }) });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    render(<GitLog cwd="/tmp" onRefresh={() => {}} />);
    await waitFor(() => expect(screen.getByText('52471ca')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByText('52471ca'));
    });
    // The spinner must clear, the diff panel must show the empty state.
    await waitFor(() => {
      expect(screen.queryByText(/loading diff/i)).not.toBeInTheDocument();
    });
    expect(screen.getByText(/no diff for this commit/i)).toBeInTheDocument();
  });

  it('surfaces server errors in the diff view', async () => {
    (globalThis as any).fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/git/log')) return Promise.resolve({ ok: true, json: async () => logResponse });
      if (url.includes('/api/git/show')) return Promise.resolve({ ok: false, status: 400, json: async () => ({ error: 'Invalid commit hash' }) });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    render(<GitLog cwd="/tmp" onRefresh={() => {}} />);
    await waitFor(() => expect(screen.getByText('52471ca')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByText('52471ca'));
    });
    await waitFor(() => {
      expect(screen.getByText(/invalid commit hash/i)).toBeInTheDocument();
    });
  });

  it('clears the loading spinner even when the user clicks a different commit mid-fetch (race regression: #161)', async () => {
    // First fetch (A) hangs forever; second fetch (B) resolves immediately
    // with an empty diff. The spinner for A must NOT stay stuck.
    let resolveA: ((v: any) => void) | null = null;
    (globalThis as any).fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/git/log')) return Promise.resolve({ ok: true, json: async () => logResponse });
      if (url.includes('/api/git/show') && url.includes(sampleEntry.hash)) {
        return new Promise((resolve) => { resolveA = resolve; });
      }
      if (url.includes('/api/git/show')) {
        return Promise.resolve({ ok: true, json: async () => ({ diff: '' }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    // Two entries so the second click has a different hash to target.
    const entryB: GitLogEntry = { ...sampleEntry, hash: 'a07ef840e000fbe4c8b8c0a406d0f709ecbb132a', shortHash: 'a07ef84', message: 'second commit' };
    (globalThis as any).fetch.mockImplementation((url: string) => {
      if (url.includes('/api/git/log')) return Promise.resolve({ ok: true, json: async () => ({ log: [sampleEntry, entryB] }) });
      if (url.includes(sampleEntry.hash) && url.includes('/api/git/show')) {
        return new Promise((resolve) => { resolveA = resolve; });
      }
      if (url.includes(entryB.hash) && url.includes('/api/git/show')) {
        return Promise.resolve({ ok: true, json: async () => ({ diff: '' }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(<GitLog cwd="/tmp" onRefresh={() => {}} />);
    await waitFor(() => expect(screen.getByText('52471ca')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('a07ef84')).toBeInTheDocument());

    // Click A — starts a hung request, spinner appears
    await act(async () => {
      fireEvent.click(screen.getByText('52471ca'));
    });
    expect(screen.getByText(/loading diff/i)).toBeInTheDocument();

    // Click B — fast request
    await act(async () => {
      fireEvent.click(screen.getByText('a07ef84'));
    });

    // Spinner for A must clear, even though A's response is still pending
    await waitFor(() => {
      expect(screen.queryByText(/loading diff/i)).not.toBeInTheDocument();
    });

    // Now resolve A so we don't leak an open promise into the next test
    await act(async () => {
      resolveA?.({ ok: true, json: async () => ({ diff: 'late' }) });
    });
  });
});
