import '@testing-library/jest-dom';
import { createElement } from 'react';
import { vi } from 'vitest';

// Mock window.matchMedia for jsdom (used by useIsMobile)
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

// @pierre/diffs renders web-components; jsdom can't mount them.
// Provide probes so tests can assert inputs without spinning up the
// real highlighter / shadow DOM.
vi.mock('@pierre/diffs', () => ({
  registerCustomTheme: () => {},
  parsePatchFiles: (patch: string) => {
    if (!patch.includes('--- ') && !patch.includes('+++ ')) return [];
    // Minimal fake metadata: one patch per `+++ b/...` line so tests can
    // exercise multi-file diffs.
    const names = [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]).filter(Boolean);
    return [{
      files: names.length > 0
        ? names.map((name) => ({ name, type: 'change', hunks: [] }))
        : [{ name: 'file', type: 'change', hunks: [] }],
    }];
  },
}));

vi.mock('@pierre/diffs/react', () => ({
  FileDiff: ({ fileDiff, options }: { fileDiff: { name?: string }; options?: Record<string, unknown> }) =>
    createElement('div', {
      'data-testid': 'file-diff',
      'data-filename': fileDiff.name ?? '',
      'data-options': JSON.stringify(options),
    }),
}));
