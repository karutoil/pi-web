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
    `Page URL: ${el.pageUrl || "(unknown)"}`,
    `Page title: ${el.pageTitle || "(none)"}`,
    ``,
    `Element: <${el.tagName}>`,
    `CSS selector: \`${el.selector}\``,
    `Bounding box: ${JSON.stringify(el.boundingBox)}`,
    ``,
  ];

  // React component source info (if available from fiber)
  if (el.source?.componentName || el.source?.componentStack) {
    if (el.source.componentName) {
      parts.push(`React component: \`<${el.source.componentName}>\``);
    }
    if (el.source.componentStack && el.source.componentStack.length > 0) {
      parts.push(`Component stack: ${el.source.componentStack.map(c => `<${c}>`).join(" → ")}`);
    }
    if (el.source.file) {
      parts.push(`Source file: ${el.source.file}${el.source.line ? `:${el.source.line}` : ""}`);
    }
    parts.push(``);
  }

  // Framework-agnostic search hints: grep these in the project to find the element
  const hints = buildSearchHints(el);
  if (hints.length > 0) {
    parts.push(`Search hints (grep the project for these):`);
    for (const h of hints) {
      parts.push(`  ${h}`);
    }
    parts.push(``);
  }

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

/** Extract grep-friendly strings from the element's HTML attributes and text. */
function buildSearchHints(el: SerializedElement): string[] {
  const hints: string[] = [];
  const seen = new Set<string>();

  // Parse attributes from outerHTML
  const attrRe = /\s([\w-]+)(?:=\\s*"([^"]*)")?/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(el.outerHTML)) !== null) {
    const name = m[1];
    const value = m[2];
    // Class values: split and add individual classes
    if (name === "class" && value) {
      for (const cls of value.split(/\s+/)) {
        if (cls.length > 1 && !seen.has(cls)) {
          seen.add(cls);
          hints.push(`class="${cls}"`);
        }
      }
    }
    // ID
    if (name === "id" && value && !seen.has(value)) {
      seen.add(value);
      hints.push(`id="${value}"`);
    }
    // Data attributes
    if (name.startsWith("data-") && value && !seen.has(value)) {
      seen.add(value);
      hints.push(`${name}="${value}"`);
    }
    // ARIA attributes with useful values
    if ((name === "aria-label" || name === "role") && value && !seen.has(value)) {
      seen.add(value);
      hints.push(`${name}="${value}"`);
    }
  }

  // Text content (first 60 chars, trimmed)
  if (el.textContent && el.textContent.length > 1) {
    const text = el.textContent.slice(0, 60).trim();
    if (text && !seen.has(text)) {
      seen.add(text);
      hints.push(`text: "${text}"`);
    }
  }

  return hints.slice(0, 12); // keep it concise
}
