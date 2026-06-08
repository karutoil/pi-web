/**
 * DOM element serializer — mirrors the overlay.js serializer for use
 * within the React app (e.g. when parsing serialized elements from
 * postMessage payloads).
 *
 * This is a TypeScript utility that validates and normalizes the
 * SerializedElement payload received from the iframe.
 */

import type { SerializedElement } from "@pi-web/shared";

function parseSource(s: unknown): SerializedElement["source"] {
  if (!s || typeof s !== "object") return undefined;
  const src = s as Record<string, unknown>;
  const file = typeof src.file === "string" ? src.file : undefined;
  const line = typeof src.line === "number" ? src.line : undefined;
  const col = typeof src.col === "number" ? src.col : undefined;
  const componentName = typeof src.componentName === "string" ? src.componentName : undefined;
  const componentStack = Array.isArray(src.componentStack)
    ? src.componentStack.filter((c): c is string => typeof c === "string")
    : undefined;
  if (!file && !componentName && !componentStack) return undefined;
  return { file, line, col, componentName, componentStack };
}

/**
 * Validate and normalize a serialized element payload from the iframe.
 * Returns null if the payload is malformed.
 */
export function normalizeElement(payload: unknown): SerializedElement | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;

  if (typeof p.selector !== "string") return null;
  if (typeof p.tagName !== "string") return null;
  if (typeof p.outerHTML !== "string") return null;
  if (typeof p.token !== "string") return null;

  const bbox = p.boundingBox as Record<string, unknown> | undefined;
  if (
    !bbox ||
    typeof bbox.x !== "number" ||
    typeof bbox.y !== "number" ||
    typeof bbox.width !== "number" ||
    typeof bbox.height !== "number"
  ) {
    return null;
  }

  return {
    selector: p.selector as string,
    tagName: p.tagName as string,
    outerHTML: typeof p.outerHTML === "string" ? p.outerHTML.slice(0, 5000) : "",
    boundingBox: {
      x: bbox.x as number,
      y: bbox.y as number,
      width: bbox.width as number,
      height: bbox.height as number,
    },
    computedStyles:
      typeof p.computedStyles === "object" && p.computedStyles
        ? (p.computedStyles as Record<string, string>)
        : {},
    textContent: typeof p.textContent === "string" ? p.textContent.slice(0, 200) : "",
    source: parseSource(p.source),
    screenshotPng:
      typeof p.screenshotPng === "string" ? p.screenshotPng : undefined,
    token: p.token as string,
    pageUrl: typeof p.pageUrl === "string" ? p.pageUrl : "",
    pageTitle: typeof p.pageTitle === "string" ? p.pageTitle : "",
  };
}
