/**
 * Preview Proxy — reverse-proxies requests to the dev server, injecting
 * the element-picker overlay into HTML responses.
 *
 * Uses a fetch-based approach (not http-proxy) for Bun compatibility.
 * Routes: /preview/:projectId/:label/* → http://localhost:$port/*
 *
 * What it does:
 *  1. Forwards request to dev server (method, headers, body)
 *  2. On HTML responses: injects <base>, overlay script, overlay CSS
 *  3. Strips X-Frame-Options / frame-ancestors CSP for iframe compatibility
 *  4. Adds sandbox-suitable headers
 */

import { getPreview } from "./pi-preview";
import { getOverlayJS, getOverlayCSS } from "./pi-preview-overlay";
import { parse } from "node-html-parser";

interface ProxyContext {
  projectId: string;
  label: string;
}

/**
 * Parses the URL path and extracts (projectId, label, path).
 * /preview/:projectId/:label/... → { projectId, label }
 */
export function parsePreviewPath(
  pathname: string,
): { projectId: string; label: string; remainingPath: string } | null {
  const match = pathname.match(/^\/preview\/([^/]+)\/([^/]+)(\/.*)?$/);
  if (!match) return null;
  return {
    projectId: match[1],
    label: match[2],
    remainingPath: match[3] || "/",
  };
}

function injectOverlay(
  rawHtml: string,
  proxyOrigin: string,
  proxyPathPrefix: string,
): string {
  // Use node-html-parser for robust injection
  const root = parse(rawHtml);
  // Injected CSS/JS paths
  const cssPath = `${proxyOrigin}/__preview/overlay.css`;
  const jsPath = `${proxyOrigin}/__preview/overlay.js`;
  // Proxy path metadata for the overlay (used to intercept SPA navigations)
  const configScript = `<script data-pi-preview-config>window.__PI_PREVIEW_PREFIX=${JSON.stringify(proxyPathPrefix)};window.__PI_PREVIEW_ORIGIN=${JSON.stringify(proxyOrigin)};</script>`;
  // Inject config + overlay CSS in <head>
  const head = root.querySelector("head");
  if (head) {
    head.insertAdjacentHTML(
      "beforeend",
      `${configScript}<link rel="stylesheet" href="${cssPath}" data-pi-preview>`,
    );
  }
  // Inject overlay JS before </body>
  const body = root.querySelector("body");
  if (body) {
    body.insertAdjacentHTML(
      "beforeend",
      `<script src="${jsPath}" data-pi-preview async></script>`,
    );
  } else {
    // No body? Append to the end of the document
    root.insertAdjacentHTML(
      "beforeend",
      `${configScript}<link rel="stylesheet" href="${cssPath}" data-pi-preview><script src="${jsPath}" data-pi-preview async></script>`,
    );
  }
  return root.toString();
}
/**
 * Strips headers that prevent iframe embedding and adds CORS headers
 * so the proxied preview can make credentialed requests from the iframe.
 */
function stripEmbedBlockers(headers: Headers, requestOrigin?: string): Headers {
  const cleaned = new Headers(headers);
  // Remove X-Frame-Options entirely
  cleaned.delete("x-frame-options");
  cleaned.delete("X-Frame-Options");
  // Modify Content-Security-Policy: strip frame-ancestors directive
  const csp = cleaned.get("content-security-policy") ||
    cleaned.get("Content-Security-Policy");
  if (csp) {
    const newCsp = csp
      .replace(/frame-ancestors\s+[^;]+;?/gi, "")
      .replace(/;;/g, ";")
      .replace(/;\s*$/, "")
      .trim();
    cleaned.set("Content-Security-Policy", newCsp);
  }
  // Add CORS headers so the preview iframe (different origin in dev)
  // can make credentialed fetch/XHR requests through the proxy.
  const origin = requestOrigin || "*";
  cleaned.set("Access-Control-Allow-Origin", origin);
  cleaned.set("Access-Control-Allow-Credentials", "true");
  return cleaned;
}
/** Build a styled HTML error page for the preview iframe */
function errorPage(title: string, detail: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,sans-serif;background:#0a0a0a;color:#a0a0a0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:12px}h1{color:#d4a020;font-size:18px;margin:0;font-weight:600}p{font-size:13px;margin:0;color:#666}</style></head><body><h1>${title}</h1><p>${detail}</p></body></html>`;
}

export async function handlePreviewRequest(
  request: Request,
  projectId: string,
  label: string,
  remainingPath: string,
): Promise<Response> {
  const preview = getPreview(projectId, label);
  if (!preview || preview.status !== "running") {
    return new Response(
      errorPage("Preview not available", `Status: ${preview?.status || "not found"}. ${preview?.status === "starting" ? "The dev server is still starting — please wait a moment and refresh." : preview?.status === "crashed" ? "The dev server crashed. Check the Preview panel for error details." : "Start the preview from the panel."}`),
      {
        status: 503,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      },
    );
  }
  // Safety: refuse to proxy to pi-web's own port (prevents infinite loops)
  const serverPort = (Bun as unknown as { server?: { port: number } })?.server?.port || parseInt(process.env.PORT || "0", 10);
  if (preview.port === serverPort && serverPort > 0) {
    console.error(`[preview-proxy] Refusing to proxy to pi-web's own port ${serverPort}`);
    return new Response(
      errorPage("Configuration error", `The preview port (${preview.port}) conflicts with pi-web's own port. Please use a different port.`),
      { status: 500, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }
  const targetUrl = new URL(
    remainingPath + (remainingPath.includes("?") ? "" : new URL(request.url).search || ""),
    `http://127.0.0.1:${preview.port}`,
  );
  // Build forwarded request
  const forwardHeaders = new Headers(request.headers);
  forwardHeaders.delete("host");
  forwardHeaders.delete("connection");
  forwardHeaders.delete("keep-alive");
  forwardHeaders.delete("transfer-encoding");
  let body: BodyInit | null = null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    body = request.body;
  }
  try {
    console.log(`[preview-proxy] → http://127.0.0.1:${preview.port}${remainingPath}`);
    const upstream = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: forwardHeaders,
      body,
      redirect: "manual",
    });
    console.log(`[preview-proxy] ← ${upstream.status} ${upstream.headers.get("content-type")}`);
    const contentType = upstream.headers.get("content-type") || "";
    const requestOrigin = new URL(request.url).origin;
    // If HTML response, inject overlay
    if (contentType.includes("text/html") || contentType.includes("application/xhtml")) {
      let html = await upstream.text();
      const proxyOrigin = requestOrigin;
      const proxyPathPrefix = `/preview/${encodeURIComponent(projectId)}/${encodeURIComponent(label)}/`;
      const baseTag = `<base href="http://127.0.0.1:${preview.port}/" data-pi-preview>`;
      html = html.replace(/<head[^>]*>/i, (match) => match + baseTag);
      if (!/<head/i.test(html)) {
        html = `<head>${baseTag}</head>` + html;
      }
      html = injectOverlay(html, proxyOrigin, proxyPathPrefix);
      const cleanedHeaders = stripEmbedBlockers(upstream.headers, requestOrigin);
      cleanedHeaders.set("Content-Type", "text/html; charset=utf-8");
      cleanedHeaders.set("Cache-Control", "no-store");
      return new Response(html, {
        status: upstream.status,
        headers: cleanedHeaders,
      });
    }
    // Non-HTML: forward as-is, stripping embed blockers
    const cleanedHeaders = stripEmbedBlockers(upstream.headers, requestOrigin);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: cleanedHeaders,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[preview-proxy] Error proxying to ${targetUrl}:`, msg);
    return new Response(
      errorPage("Dev server unreachable", `Could not connect to port ${preview.port}: ${msg}`),
      {
        status: 502,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      },
    );
  }
}
