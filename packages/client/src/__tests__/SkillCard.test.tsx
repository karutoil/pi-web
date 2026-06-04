import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SkillCard, parseSkillBlocks } from '../components/SkillCard';

describe('parseSkillBlocks', () => {
  it('returns a single text segment when no skill blocks are present', () => {
    const out = parseSkillBlocks('hello world');
    expect(out).toEqual([{ type: 'text', content: 'hello world' }]);
  });

  it('returns an empty array for empty input', () => {
    expect(parseSkillBlocks('')).toEqual([]);
  });

  it('parses a paired skill block with attributes', () => {
    const out = parseSkillBlocks(
      '<skill name="frontend-design" location="/a/b/SKILL.md">Builds UIs.</skill>',
    );
    expect(out).toEqual([
      {
        type: 'skill',
        name: 'frontend-design',
        location: '/a/b/SKILL.md',
        content: 'Builds UIs.',
      },
    ]);
  });

  it('parses a self-closing skill block', () => {
    const out = parseSkillBlocks('<skill name="x" location="/p" />');
    expect(out).toEqual([
      { type: 'skill', name: 'x', location: '/p', content: '' },
    ]);
  });

  it('parses the child-element skill form (Agent Skills spec)', () => {
    const out = parseSkillBlocks(
      '<skill><name>foo</name><location>/p/SKILL.md</location><description>Does foo things.</description></skill>',
    );
    expect(out[0].type).toBe('skill');
    expect((out[0] as any).name).toBe('foo');
    expect((out[0] as any).location).toBe('/p/SKILL.md');
    expect((out[0] as any).content).toBe('Does foo things.');
  });

  it('interleaves text and skill segments in order, trimming boundary whitespace', () => {
    const out = parseSkillBlocks(
      'before <skill name="a" location="/a">A</skill> middle <skill name="b" location="/b">B</skill> after',
    );
    expect(out).toEqual([
      { type: 'text', content: 'before' },
      { type: 'skill', name: 'a', location: '/a', content: 'A' },
      { type: 'text', content: 'middle' },
      { type: 'skill', name: 'b', location: '/b', content: 'B' },
      { type: 'text', content: 'after' },
    ]);
  });

  it('strips blank lines that surround a <skill> block so it flows with surrounding prose', () => {
    const out = parseSkillBlocks(
      'hello\n\n<skill name="a" location="/a">A</skill>\n\nworld',
    );
    expect(out).toEqual([
      { type: 'text', content: 'hello' },
      { type: 'skill', name: 'a', location: '/a', content: 'A' },
      { type: 'text', content: 'world' },
    ]);
  });

  it('preserves inner whitespace inside a text segment', () => {
    const out = parseSkillBlocks('line one\nline two');
    expect(out).toEqual([{ type: 'text', content: 'line one\nline two' }]);
  });

  it('drops text segments that become empty after trimming', () => {
    const out = parseSkillBlocks('   \n<skill name="a" location="/a">A</skill>\n   ');
    expect(out).toEqual([{ type: 'skill', name: 'a', location: '/a', content: 'A' }]);
  });

  it('does NOT extract skill blocks that live inside fenced code', () => {
    const out = parseSkillBlocks('```\n<skill name="x" location="/p">nope</skill>\n```');
    expect(out).toEqual([
      { type: 'text', content: '```\n<skill name="x" location="/p">nope</skill>\n```' },
    ]);
  });

  it('does NOT extract skill blocks that live inside inline code', () => {
    const out = parseSkillBlocks('use `<skill name="x"/>` literally');
    expect(out).toEqual([
      { type: 'text', content: 'use `<skill name="x"/>` literally' },
    ]);
  });

  it('falls back to "skill" when name is missing', () => {
    const out = parseSkillBlocks('<skill>just content</skill>');
    expect((out[0] as any).name).toBe('skill');
  });
});

describe('SkillCard', () => {
  it('renders the skill name in the header and is collapsed by default', () => {
    render(
      <SkillCard
        name="frontend-design"
        location="/a/b/SKILL.md"
        content="This is the long description that should be hidden when collapsed."
      />,
    );
    expect(screen.getByText('frontend-design')).toBeInTheDocument();
    expect(
      screen.queryByText(/This is the long description/),
    ).not.toBeInTheDocument();
  });

  it('expands to show content when the header is clicked', () => {
    render(
      <SkillCard
        name="frontend-design"
        location="/a/b/SKILL.md"
        content="Hidden description body."
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Toggle skill frontend-design/ }));
    expect(screen.getByText(/Hidden description body/)).toBeInTheDocument();
  });

  it('collapses again after a second click', () => {
    render(
      <SkillCard
        name="frontend-design"
        location="/a/b/SKILL.md"
        content="Toggle body."
      />,
    );
    const btn = screen.getByRole('button', { name: /Toggle skill frontend-design/ });
    fireEvent.click(btn);
    expect(screen.getByText(/Toggle body/)).toBeInTheDocument();
    fireEvent.click(btn);
    expect(screen.queryByText(/Toggle body/)).not.toBeInTheDocument();
  });

  it('starts expanded when there is no content (just name + path visible)', () => {
    render(<SkillCard name="ping" location="/x" content="" />);
    // No hidden content, but the header is rendered.
    expect(screen.getByText('ping')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Toggle skill ping/ })).toHaveAttribute('aria-expanded', 'true');
  });
});
