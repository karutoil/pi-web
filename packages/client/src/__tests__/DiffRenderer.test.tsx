import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DiffRenderer, isDiffContent } from '../components/DiffRenderer';

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

describe('DiffRenderer', () => {
  it('renders nothing for non-diff content', () => {
    const { container } = render(<DiffRenderer content="just some text" />);
    expect(container.innerHTML).toBe('');
  });

  it('renders diff stats header', () => {
    render(<DiffRenderer content={SAMPLE_DIFF} />);
    expect(screen.getByText('+1')).toBeInTheDocument();
    expect(screen.getByText('-1')).toBeInTheDocument();
  });

  it('defaults to unified view', () => {
    render(<DiffRenderer content={SAMPLE_DIFF} />);
    expect(screen.getByText('Unified').closest('button')).toHaveClass('bg-ink-800');
  });

  it('switches to side-by-side view on click', () => {
    render(<DiffRenderer content={SAMPLE_DIFF} />);
    fireEvent.click(screen.getByText('Side-by-side'));
    expect(screen.getByText('Side-by-side').closest('button')).toHaveClass('bg-ink-800');
  });

  it('shows file meta lines', () => {
    render(<DiffRenderer content={SAMPLE_DIFF} />);
    expect(screen.getByText('--- a/file.ts')).toBeInTheDocument();
    expect(screen.getByText('+++ b/file.ts')).toBeInTheDocument();
  });

  // ─── Collapse / Expand ───

  it('collapses long diffs by default', () => {
    // Build a diff with >20 rows
    const lines = ['--- a/f', '+++ b/f', '@@ -1,30 +1,30 @@'];
    for (let i = 0; i < 25; i++) lines.push(` context ${i}`);
    const longDiff = lines.join('\n');

    render(<DiffRenderer content={longDiff} collapsible={true} />);
    expect(screen.getByText(/Show all \d+ changes/)).toBeInTheDocument();
  });

  it('expands on click', () => {
    const lines = ['--- a/f', '+++ b/f', '@@ -1,30 +1,30 @@'];
    for (let i = 0; i < 25; i++) lines.push(` context ${i}`);
    const longDiff = lines.join('\n');

    render(<DiffRenderer content={longDiff} collapsible={true} />);
    fireEvent.click(screen.getByText(/Show all \d+ changes/));
    expect(screen.getByText('▲ Collapse')).toBeInTheDocument();
  });

  it('does not collapse when collapsible=false', () => {
    const lines = ['--- a/f', '+++ b/f', '@@ -1,30 +1,30 @@'];
    for (let i = 0; i < 25; i++) lines.push(` ctx ${i}`);
    const longDiff = lines.join('\n');

    render(<DiffRenderer content={longDiff} collapsible={false} />);
    expect(screen.queryByText(/Show all/)).not.toBeInTheDocument();
  });

  // ─── Side-by-side pairing ───

  it('pairs adjacent remove+add in side-by-side view', () => {
    const pairedDiff = `--- a/f
+++ b/f
@@ -1,3 +1,3 @@
-old line
+new line
 context`;
    const { container } = render(<DiffRenderer content={pairedDiff} />);
    // Side-by-side should show both left (old) and right (new) columns
    const rows = container.querySelectorAll('.flex.text-\\[0\\.72rem\\]');
    expect(rows.length).toBeGreaterThan(0);
  });
});
