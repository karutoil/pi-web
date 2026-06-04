import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { VersionChecker } from '../components/VersionChecker';
import type { VersionInfo } from '@pi-web/shared';

const baseInfo: VersionInfo = {
  commit: '52471ca',
  fullCommit: '52471ca8c0e1a1c0ff1a0b1c0ff1a0b1c0ff1a0b',
  branch: 'main',
  commitMessage: 'feat: add version checker',
  ahead: 0,
  behind: 0,
  dirty: false,
  upToDate: true,
  hasRemote: true,
  defaultBranch: 'main',
  unavailable: false,
  fetchedAt: new Date().toISOString(),
};

function mockFetchResponse(info: Partial<VersionInfo> | { error: string }) {
  if ('error' in info) {
    return vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: info.error }),
    });
  }
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ ...baseInfo, ...info }),
  });
}

describe('VersionChecker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a loading state on first render', () => {
    // Hold the fetch open so we can observe the loading UI
    (globalThis as any).fetch = vi.fn().mockReturnValue(new Promise(() => {}));
    render(<VersionChecker />);
    expect(screen.getByText(/loading version/i)).toBeInTheDocument();
  });

  it('renders commit hash and "up to date" status when in sync', async () => {
    (globalThis as any).fetch = mockFetchResponse({});
    render(<VersionChecker />);
    await waitFor(() => {
      expect(screen.getByText('52471ca')).toBeInTheDocument();
    });
    expect(screen.getByText('up to date')).toBeInTheDocument();
  });

  it('shows commit count behind when out of date', async () => {
    (globalThis as any).fetch = mockFetchResponse({ behind: 3, upToDate: false });
    render(<VersionChecker />);
    await waitFor(() => {
      expect(screen.getByText('3 behind main')).toBeInTheDocument();
    });
  });

  it('shows ahead count when local has unpushed commits', async () => {
    (globalThis as any).fetch = mockFetchResponse({ ahead: 2, upToDate: false });
    render(<VersionChecker />);
    await waitFor(() => {
      expect(screen.getByText('2 ahead of main')).toBeInTheDocument();
    });
  });

  it('shows a clear "no origin/main" status when the remote ref is missing', async () => {
    (globalThis as any).fetch = mockFetchResponse({
      hasRemote: false,
      upToDate: false,
    });
    render(<VersionChecker />);
    await waitFor(() => {
      expect(screen.getByText('no origin/main')).toBeInTheDocument();
    });
  });

  it('shows dirty state when working tree has changes', async () => {
    (globalThis as any).fetch = mockFetchResponse({ dirty: true, upToDate: false });
    render(<VersionChecker />);
    await waitFor(() => {
      expect(screen.getByText('uncommitted changes')).toBeInTheDocument();
    });
  });

  it('renders the unavailable fallback when server has no git info', async () => {
    (globalThis as any).fetch = mockFetchResponse({ unavailable: true });
    render(<VersionChecker />);
    await waitFor(() => {
      expect(screen.getByText('no git info')).toBeInTheDocument();
    });
  });

  it('renders an error state and retry button when fetch fails', async () => {
    (globalThis as any).fetch = vi.fn().mockRejectedValue(new Error('boom'));
    render(<VersionChecker />);
    await waitFor(() => {
      expect(screen.getByText('version unavailable')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Retry version check')).toBeInTheDocument();
  });

  it('clicking the refresh button re-fetches the version', async () => {
    const fetchMock = mockFetchResponse({});
    (globalThis as any).fetch = fetchMock;
    render(<VersionChecker />);
    await waitFor(() => {
      expect(screen.getByText('52471ca')).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Refresh version info'));
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  it('exposes a tooltip with full commit and message', async () => {
    (globalThis as any).fetch = mockFetchResponse({});
    const { container } = render(<VersionChecker />);
    await waitFor(() => {
      expect(screen.getByText('52471ca')).toBeInTheDocument();
    });
    const wrapper = container.querySelector('[title]') as HTMLElement;
    expect(wrapper).toBeTruthy();
    expect(wrapper.getAttribute('title')).toContain('main @ 52471ca8c0e1a1c0ff1a0b1c0ff1a0b1c0ff1a0b');
    expect(wrapper.getAttribute('title')).toContain('feat: add version checker');
    expect(wrapper.getAttribute('title')).toContain('Matches origin/main');
  });
});
