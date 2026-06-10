import { useState } from "react";
import { Icon } from "./Icon";

// ─── Types ──────────────────────────────────────────────

export interface SkillBlock {
  type: "skill";
  name: string;
  location?: string;
  content: string;
}

export type TextSegment =
  | { type: "text"; content: string }
  | SkillBlock;

// ─── Parser ─────────────────────────────────────────────

/**
 * Match `<skill …>…</skill>` (paired) and `<skill … />` (self-closing).
 * Captures the attribute string in $1 (paired) or $2 (self-closing),
 * and the inner content in $3 (paired only).
 *
 * Compatible with:
 *   <skill name="foo" location="/path">description</skill>
 *   <skill name="foo" location="/path" />
 *   <skill><name>foo</name><location>/path</location>…</skill>
 */
const SKILL_RE =
  /<skill\b([^>]*?)>([\s\S]*?)<\/skill>|<skill\b([^>]*?)\/>/g;

/**
 * Match fenced code blocks (```…```) and inline code (`…`) so we can
 * avoid parsing `<skill>` tags that live inside code samples.
 */
const CODE_RE = /```[\s\S]*?```|`[^`\n]+`/g;

const ATTR_RE = /([a-zA-Z_][\w-]*)\s*=\s*"([^"]*)"/g;
const INNER_NAME_RE = /<name[^>]*>([\s\S]*?)<\/name>/i;
const INNER_LOC_RE = /<location[^>]*>([\s\S]*?)<\/location>/i;

function parseAttrs(attrStr: string): Record<string, string> {
  const out: Record<string, string> = {};
  let m: RegExpExecArray | null;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(attrStr)) !== null) {
    out[m[1].toLowerCase()] = m[2];
  }
  return out;
}

/** Extract a single skill block's name, location, and inner content. */
function extractSkill(fullMatch: string, attrStr: string, inner: string): SkillBlock {
  const attrs = parseAttrs(attrStr);
  let name = attrs.name ?? "";
  let location = attrs.location ?? "";

  // Fall back to child-element form (<skill><name>…</name>…)
  if (!name) {
    const m = inner.match(INNER_NAME_RE);
    if (m) name = m[1].trim();
  }
  if (!location) {
    const m = inner.match(INNER_LOC_RE);
    if (m) location = m[1].trim();
  }

  // Inner content: prefer child elements as description if present,
  // otherwise use the raw inner text.
  let content = "";
  const descMatch = inner.match(/<description[^>]*>([\s\S]*?)<\/description>/i);
  if (descMatch) {
    content = descMatch[1].trim();
  } else if (name || location) {
    // Strip known child elements (name, location) to leave just description text
    content = inner
      .replace(INNER_NAME_RE, "")
      .replace(INNER_LOC_RE, "")
      .replace(/<description[^>]*>|<\/description>/gi, "")
      .trim();
  } else {
    content = inner.trim();
  }

  return { type: "skill", name: name || "skill", location: location || undefined, content };
}

/**
 * Split a text string into text segments and skill blocks. Skill blocks
 * that appear inside fenced or inline code are NOT extracted — they are
 * left as plain text and rendered by the markdown pipeline.
 *
 * Text segments have their leading and trailing whitespace trimmed so
 * that a `<skill>` block surrounded by blank lines doesn't leave visible
 * gaps in the surrounding prose. Inner whitespace inside a segment is
 * preserved.
 */
export function parseSkillBlocks(text: string): TextSegment[] {
  if (!text) return [];
  if (!text.includes("<skill")) return [{ type: "text", content: text }];

  // Build a set of [start, end) ranges occupied by code so we can skip them.
  const codeRanges: Array<[number, number]> = [];
  let m: RegExpExecArray | null;
  CODE_RE.lastIndex = 0;
  while ((m = CODE_RE.exec(text)) !== null) {
    codeRanges.push([m.index, m.index + m[0].length]);
  }
  const inCode = (start: number, end: number) =>
    codeRanges.some(([s, e]) => start >= s && end <= e);

  const segments: TextSegment[] = [];
  let cursor = 0;
  SKILL_RE.lastIndex = 0;
  while ((m = SKILL_RE.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (inCode(start, end)) continue;

    if (start > cursor) {
      segments.push({ type: "text", content: text.slice(cursor, start) });
    }
    // m[1] = attrs of paired; m[2] = inner of paired;
    // m[3] = attrs of self-closing; m[4] = undefined
    const attrStr = (m[1] ?? m[3] ?? "") as string;
    const inner = (m[2] ?? "") as string;
    segments.push(extractSkill(m[0], attrStr, inner));
    cursor = end;
  }
  if (cursor < text.length) {
    segments.push({ type: "text", content: text.slice(cursor) });
  }

  // Trim leading/trailing whitespace on the text segments so a
  // `<skill>` block surrounded by blank lines or indentation flows
  // naturally with the surrounding prose instead of leaving a visible
  // gap. Inner whitespace inside a segment is preserved.
  for (const seg of segments) {
    if (seg.type === "text") seg.content = seg.content.replace(/^\s+|\s+$/g, "");
  }
  // Drop text segments that became empty after trimming.
  return segments.filter(
    (s) => s.type !== "text" || s.content.length > 0,
  );
}

// ─── Component ──────────────────────────────────────────

export interface SkillCardProps {
  name: string;
  location?: string;
  content: string;
  /** Force expanded state (used when there is no useful content to hide). */
  defaultExpanded?: boolean;
}

export function SkillCard({ name, location, content, defaultExpanded }: SkillCardProps) {
  // Cards with no inner body default to expanded so the header still conveys
  // something useful (just the name + path).
  const [expanded, setExpanded] = useState(!!(defaultExpanded || !content));

  return (
    <div
      className="conversation-skill-card"
      data-skill-name={name}
    >
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="conversation-skill-card-button"
        aria-expanded={expanded}
        aria-label={`Toggle skill ${name}`}
      >
        <Icon
          name="chevron-right-sm"
          size={10}
          className={`conversation-skill-card-chevron ${expanded ? "rotate-90" : ""}`}
        />
        <Icon name="spark" size={11} className="conversation-skill-card-icon" />
        <span>{name}</span>
        {location && (
          <span className="conversation-skill-card-location">
            {location}
          </span>
        )}
      </button>
      {expanded && content && (
        <div className="conversation-skill-card-body">
          {content}
        </div>
      )}
    </div>
  );
}

// ─── Helper for callers ─────────────────────────────────

/**
 * Convenience: parse text and render each segment. Text segments are
 * returned as raw strings so the caller can pass them through the
 * markdown pipeline (or render them however it wants).
 *
 * Use `parseSkillBlocks` + `<SkillCard>` directly if you need per-segment
 * control over the renderer.
 */
export function splitSkillBlocks(text: string): TextSegment[] {
  return parseSkillBlocks(text);
}
