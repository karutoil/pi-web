import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DiffRenderer, isDiffContent } from '../components/DiffRenderer';

// @pierre/diffs and @pierre/diffs/react are mocked in __tests__/setup.ts.

// ─── Diff parsing logic ───

describe('isDiffContent', () => {
  it('returns true for valid unified diff with hunk headers', () => {
    const diff = `--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,4 @@
 line1
+added
 line2
-removed
 line3`;
    expect(isDiffContent(diff)).toBe(true);
  });

  it('returns true for diff with headers and change lines', () => {
    const diff = `--- a/foo
+++ b/foo
+new line
-old line`;
    expect(isDiffContent(diff)).toBe(true);
  });

  it('returns false for plain text', () => {
    expect(isDiffContent('hello world')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isDiffContent('')).toBe(false);
  });

  it('returns false for short content (< 3 lines)', () => {
    expect(isDiffContent('a\nb')).toBe(false);
  });
});

// ─── Component rendering ───

const SAMPLE_DIFF = `--- a/file.ts
+++ b/file.ts
@@ -1,5 +1,5 @@
 import React from 'react';
-old line
+new line
 export function App() {
   return <div />;
 }`;

function getFileDiff() {
  return screen.getByTestId('file-diff');
}

describe('DiffRenderer', () => {
  it('renders nothing for non-diff content', () => {
    const { container } = render(<DiffRenderer content="just some text" />);
    expect(container.innerHTML).toBe('');
  });

  it('renders a FileDiff for the patch', () => {
    render(<DiffRenderer content={SAMPLE_DIFF} />);
    expect(getFileDiff()).toBeInTheDocument();
  });

  it('uses unified diff style by default', () => {
    render(<DiffRenderer content={SAMPLE_DIFF} />);
    const options = JSON.parse(getFileDiff().getAttribute('data-options') || '{}');
    expect(options.diffStyle).toBe('unified');
  });

  it('can disable the file header', () => {
    render(<DiffRenderer content={SAMPLE_DIFF} disableFileHeader />);
    const options = JSON.parse(getFileDiff().getAttribute('data-options') || '{}');
    expect(options.disableFileHeader).toBe(true);
  });

  it('keeps the file header visible by default', () => {
    render(<DiffRenderer content={SAMPLE_DIFF} />);
    const options = JSON.parse(getFileDiff().getAttribute('data-options') || '{}');
    expect(options.disableFileHeader).toBe(false);
  });

  // ─── Collapse / Expand ───

  it('collapses long diffs by default', () => {
    const lines = ['--- a/f', '+++ b/f', '@@ -1,30 +1,30 @@'];
    for (let i = 0; i < 25; i++) lines.push(` context ${i}`);
    const longDiff = lines.join('\n');

    render(<DiffRenderer content={longDiff} collapsible={true} />);
    expect(screen.getByText(/Show all \d+ lines/)).toBeInTheDocument();
  });

  it('expands on click', () => {
    const lines = ['--- a/f', '+++ b/f', '@@ -1,30 +1,30 @@'];
    for (let i = 0; i < 25; i++) lines.push(` context ${i}`);
    const longDiff = lines.join('\n');

    render(<DiffRenderer content={longDiff} collapsible={true} />);
    fireEvent.click(screen.getByText(/Show all \d+ lines/));
    expect(screen.getByText('▲ Collapse')).toBeInTheDocument();
  });

  it('does not collapse when collapsible=false', () => {
    const lines = ['--- a/f', '+++ b/f', '@@ -1,30 +1,30 @@'];
    for (let i = 0; i < 25; i++) lines.push(` ctx ${i}`);
    const longDiff = lines.join('\n');

    render(<DiffRenderer content={longDiff} collapsible={false} />);
    expect(screen.queryByText(/Show all/)).not.toBeInTheDocument();
  });

  it('renders one FileDiff per changed file', () => {
    const multi = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,1 +1,1 @@
-a
+b

diff --git a/b.ts b/b.ts
--- a/b.ts
+++ b/b.ts
@@ -1,1 +1,1 @@
-c
+d
`;
    render(<DiffRenderer content={multi} />);
    const files = screen.getAllByTestId('file-diff');
    expect(files.length).toBe(2);
    expect(files[0]).toHaveAttribute('data-filename', 'a.ts');
    expect(files[1]).toHaveAttribute('data-filename', 'b.ts');
  });
});
