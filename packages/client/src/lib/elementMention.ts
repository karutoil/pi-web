/**
 * Element mention token builder — mirrors the @file mention pattern.
 *
 * Formats:
 *   "@element:tag.selector" — lightweight token for chat input
 *   "@element{...json...}" — full structured context for the agent
 */

import type { SerializedElement } from "@pi-web/shared";

/**
 * Build a short @element mention token for display in ChatInput.
 */
export function buildElementToken(el: SerializedElement): string {
  return `@element:${el.tagName}.${el.selector.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40)}`;
}

/**
 * Parse @element tokens from a text string. Returns array of matched tokens.
 */
export function parseElementTokens(
  text: string,
): Array<{ token: string; tagName: string; selectorSlug: string }> {
  const re = /@element:([a-z0-9]+)\.([a-zA-Z0-9_-]+)/gi;
  const results: Array<{ token: string; tagName: string; selectorSlug: string }> = [];
  let match;
  while ((match = re.exec(text)) !== null) {
    results.push({
      token: match[0],
      tagName: match[1],
      selectorSlug: match[2],
    });
  }
  return results;
}

/**
 * Build a full structured context string for sending to the agent.
 * Includes selector, HTML, styles, and bounding box.
 */
export function buildElementContext(el: SerializedElement): string {
  const parts = [
    `Element: <${el.tagName}>`,
    `CSS selector: \`${el.selector}\``,
    `Bounding box: ${JSON.stringify(el.boundingBox)}`,
    ``,
  ];

  if (el.textContent) {
    parts.push(`Text content: "${el.textContent}"`);
    parts.push(``);
  }

  const styleKeys = Object.keys(el.computedStyles);
  if (styleKeys.length > 0) {
    parts.push(`Key computed styles:`);
    parts.push("```css");
    for (const key of styleKeys.slice(0, 15)) {
      parts.push(`  ${key}: ${el.computedStyles[key]};`);
    }
    parts.push("```");
    parts.push(``);
  }

  const htmlTruncated =
    el.outerHTML.length > 5000
      ? el.outerHTML.slice(0, 5000) + "... (truncated)"
      : el.outerHTML;
  parts.push(`Outer HTML:`);
  parts.push("```html");
  parts.push(htmlTruncated);
  parts.push("```");

  return parts.join("\n");
}
