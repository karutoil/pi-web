import type { SessionDetail, ChatMessage, ContentBlock } from "@pi-web/shared";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

let cachedCss: string | null = null;

async function loadClientCss(): Promise<string> {
  if (cachedCss !== null) return cachedCss;
  try {
    const assetsDir = join(import.meta.dir, "..", "..", "client", "dist", "assets");
    const files = await readdir(assetsDir);
    const cssFile = files.find((f) => f.endsWith(".css") && f.startsWith("index-"));
    if (!cssFile) throw new Error("No built client CSS found");
    cachedCss = await readFile(join(assetsDir, cssFile), "utf-8");
  } catch (err) {
    console.error("[export-pretty] failed to load client CSS:", err);
    cachedCss =
      "/* Client CSS missing. Run `bun run build` so the pretty export can use the built styles. */";
  }
  return cachedCss;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatTokens(n: number): string {
  if (n <= 0) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

function toolAccentKind(name?: string): string {
  const normalized = (name || "").toLowerCase();
  if (["bash", "shell", "exec", "run"].some((k) => normalized.includes(k))) return "bash";
  if (["edit", "write", "patch", "refactor", "format"].some((k) => normalized.includes(k))) return "edit";
  if (["read", "ls", "list", "find", "grep", "search", "glob", "stat"].some((k) => normalized.includes(k))) return "read";
  if (["skill"].some((k) => normalized.includes(k))) return "skill";
  if (["subagent", "agent", "task"].some((k) => normalized.includes(k))) return "agent";
  return "default";
}

function extractText(content: string | ContentBlock[] | undefined | null): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .filter((b): b is ContentBlock & { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text || "")
    .join("\n");
}

function extractThinking(content: string | ContentBlock[] | undefined | null): string {
  if (!content) return "";
  if (typeof content === "string") return "";
  return content
    .filter((b): b is ContentBlock & { type: "thinking"; thinking: string } => b.type === "thinking")
    .map((b) => b.thinking || "")
    .join("\n");
}

function extractToolCalls(content: string | ContentBlock[] | undefined | null): ContentBlock[] {
  if (!content || typeof content === "string") return [];
  return content.filter((b): b is ContentBlock & { type: "toolCall"; id?: string; name?: string; arguments?: Record<string, unknown> } => b.type === "toolCall");
}

function extractImages(content: string | ContentBlock[] | undefined | null): ContentBlock[] {
  if (!content || typeof content === "string") return [];
  return content.filter((b) => b.type === "image" && b.data && b.mimeType);
}

function renderMarkdown(text: string): string {
  const lines = text.split("\n");
  const blocks: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === "") {
      i++;
      continue;
    }

    if (line.startsWith("```")) {
      const fence = line.match(/^```(.*)$/);
      const start = i;
      i++;
      const codeLines: string[] = [];
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      const lang = escapeHtml((fence?.[1] || "").trim().split(" ")[0]);
      const code = escapeHtml(codeLines.join("\n"));
      blocks.push(`<pre class="language-${lang}"><code>${code}</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const content = renderInline(heading[2]);
      blocks.push(`<h${level}>${content}</h${level}>`);
      i++;
      continue;
    }

    if (/^[-*]\s/.test(trimmed)) {
      const [list, next] = renderList("ul", i, lines);
      blocks.push(list);
      i = next;
      continue;
    }

    if (/^\d+\.\s/.test(trimmed)) {
      const [list, next] = renderList("ol", i, lines);
      blocks.push(list);
      i = next;
      continue;
    }

    if (/^>\s/.test(trimmed)) {
      const [quote, next] = renderBlockquote(i, lines);
      blocks.push(quote);
      i = next;
      continue;
    }

    if (/^\s{4,}/.test(line)) {
      const [code, next] = renderIndentedCode(i, lines);
      blocks.push(code);
      i = next;
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== "") {
      para.push(lines[i]);
      i++;
    }
    blocks.push(`<p>${renderInline(para.join(" "))}</p>`);
  }

  return blocks.join("\n");
}

function renderList(tag: "ul" | "ol", start: number, lines: string[]): [string, number] {
  const items: string[] = [];
  let i = start;
  const markerRe = tag === "ul" ? /^[-*]\s/ : /^\d+\.\s/;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (trimmed === "") {
      i++;
      continue;
    }
    if (!markerRe.test(trimmed)) break;
    const content = renderInline(trimmed.replace(markerRe, ""));
    items.push(`<li>${content}</li>`);
    i++;
  }
  return [`<${tag}>\n${items.join("\n")}\n</${tag}>`, i];
}

function renderBlockquote(start: number, lines: string[]): [string, number] {
  const parts: string[] = [];
  let i = start;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (trimmed === "") break;
    if (!trimmed.startsWith("> ")) break;
    parts.push(trimmed.slice(2));
    i++;
  }
  return [`<blockquote>${renderInline(parts.join(" "))}</blockquote>`, i];
}

function renderIndentedCode(start: number, lines: string[]): [string, number] {
  const code: string[] = [];
  let i = start;
  while (i < lines.length && (lines[i].startsWith("    ") || lines[i].trim() === "")) {
    code.push(lines[i].replace(/^    /, ""));
    i++;
  }
  return [`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`, i];
}

function renderInline(text: string): string {
  let s = escapeHtml(text)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>")
    .replace(/(?<!_)_([^_\n]+)_(?!_)/g, "<em>$1</em>")
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, label, href) => {
      const safe = sanitizeUrl(href);
      return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    });

  // Preserve line breaks inside a paragraph as <br> for hard wraps that the app keeps
  s = s.replace(/  \n/g, "<br>\n").replace(/\n/g, " ");
  return s;
}

function sanitizeUrl(url: string): string {
  try {
    const u = new URL(url, "https://example.com");
    if (u.protocol !== "https:" && u.protocol !== "http:" && u.protocol !== "mailto:") return "#";
    return escapeHtml(url);
  } catch {
    return "#";
  }
}

function chevronRightSvg(cls = "conversation-chevron rotate-90"): string {
  return `<svg class="${cls}" width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true"><polygon points="3,1.5 7.5,5 3,8.5" /></svg>`;
}

function avatarSvg(): string {
  return `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="5.5" r="2.5"/><path d="M3.5 13 Q8 9 12.5 13" /></svg>`;
}

function wrap(title: string, cwd: string, messagesHtml: string, css: string): string {
  const safeTitle = escapeHtml(title);
  const safeCwd = escapeHtml(cwd);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeTitle}</title>
  <style>
${css}
:root, [data-theme="dark"] { color-scheme: dark; }
html, body { height: 100%; overflow: hidden; }
body { display: flex; flex-direction: column; }
.pretty-export-shell { background: linear-gradient(180deg, var(--workspace-panel-strong) 94%, var(--workspace-panel) 96%); }
.conversation-header-copy { min-width: 0; flex: 1 1 auto; }
.markdown-content p { margin: 0 0 0.75rem; }
.markdown-content p:last-child { margin-bottom: 0; }
.markdown-content h1,.markdown-content h2,.markdown-content h3,.markdown-content h4 { color: var(--color-ink-100); margin: 1rem 0 0.5rem; line-height: 1.3; }
.markdown-content h1 { font-size: 1.25rem; }
.markdown-content h2 { font-size: 1.1rem; }
.markdown-content h3 { font-size: 0.95rem; }
.markdown-content ul,.markdown-content ol { margin: 0.5rem 0; padding-left: 1.25rem; }
.markdown-content li { margin: 0.25rem 0; }
.markdown-content blockquote { margin: 0.5rem 0; padding-left: 0.75rem; border-left: 2px solid var(--workspace-seam); color: var(--color-ink-500); }
.markdown-content pre { background: color-mix(in srgb, var(--color-ink-950) 40%, transparent); border: 1px solid var(--workspace-seam); border-radius: 0.65rem; padding: 0.75rem; overflow: auto; }
.markdown-content code { font-family: var(--font-mono); font-size: 0.85em; background: color-mix(in srgb, var(--color-ink-950) 40%, transparent); border-radius: 0.35rem; padding: 0.1rem 0.3rem; }
.markdown-content pre code { background: transparent; padding: 0; }
.markdown-content hr { border: 0; border-top: 1px solid var(--workspace-seam); margin: 1rem 0; }
.markdown-content a { color: var(--workspace-blueprint); text-decoration: underline; }
.markdown-content table { border-collapse: collapse; margin: 0.5rem 0; width: 100%; }
.markdown-content th,.markdown-content td { border: 1px solid var(--workspace-seam); padding: 0.35rem 0.5rem; text-align: left; }
  </style>
</head>
<body data-theme="dark">
  <div class="conversation-shell pretty-export-shell">
    <header class="conversation-header">
      <div class="conversation-header-copy">
        <div class="conversation-header-row"><h1 class="conversation-title">${safeTitle}</h1></div>
        ${safeCwd ? `<div class="conversation-cwd">${safeCwd}</div>` : ""}
      </div>
    </header>
    <main class="conversation-scroll">
      <div class="conversation-message-stack">
        ${messagesHtml}
      </div>
    </main>
  </div>
</body>
</html>`;
}

function renderUserMessage(msg: ChatMessage): string {
  const text = extractText(msg.content);
  const images = extractImages(msg.content);
  const safeText = text ? `<p class="conversation-user-text">${renderInline(text)}</p>` : "";
  const imageHtml = images
    .map(
      (img) =>
        `<img class="conversation-user-image" src="data:${escapeHtml(img.mimeType || "image/png")};base64,${escapeHtml(img.data || "")}" alt="Attachment" />`
    )
    .join("");
  const imagesHtml = imageHtml
    ? `<div class="conversation-user-images ${text ? "mt-2" : ""}">${imageHtml}</div>`
    : "";

  return `<div class="conversation-message-row min-w-0 justify-end" data-user="true">
  <div class="conversation-bubble">
    <div class="conversation-user-bubble group relative">
      ${safeText}${imagesHtml}
    </div>
  </div>
</div>`;
}

function renderToolCallBubble(toolCall: ContentBlock, result?: ChatMessage): string {
  const name = toolCall.name || "tool";
  const args = toolCall.arguments || {};
  const accent = toolAccentKind(name);
  const argsPreview = JSON.stringify(args).slice(0, 80);
  const resultContent = result ? extractText(result.content) : "";
  const isError = result?.isError || false;
  const status = isError
    ? `<span class="conversation-tool-status conversation-tool-status-error">(error)</span>`
    : result
    ? `<span class="conversation-tool-status conversation-tool-status-done">✓</span>`
    : `<span class="conversation-tool-status conversation-tool-status-running">●</span>`;
  const lines = resultContent.split("\n");
  const lineCount = lines.length > 1 ? `<span class="conversation-tool-status">${lines.length} lines</span>` : "";

  const header = `<div class="conversation-tool-header">
  ${chevronRightSvg("conversation-chevron rotate-90")}
  <span class="conversation-tool-name">${escapeHtml(name)}</span>
  <span class="conversation-tool-args">${escapeHtml(argsPreview)}</span>
  ${status}${lineCount}</div>`;

  const body = resultContent
    ? `<div class="conversation-tool-body conversation-result-panel"><pre class="conversation-result-pre">${escapeHtml(resultContent)}</pre></div>`
    : "";

  return `<div class="conversation-tool-bubble conversation-tool-bubble--${accent} ${isError ? "conversation-tool-bubble-error" : ""}">${header}${body}</div>`;
}

function renderAssistantMessage(msg: ChatMessage, toolResultsMap?: Map<string, ChatMessage>): string {
  const content = Array.isArray(msg.content) ? msg.content : [];
  const textBlocks = typeof msg.content === "string" ? [msg.content] : content.filter((b) => b.type === "text").map((b) => b.text || "");
  const text = textBlocks.join("\n\n");
  const thinking = msg.thinking || extractThinking(msg.content);
  const toolCalls = extractToolCalls(msg.content);

  let composed = "";

  if (thinking) {
    composed += `<div class="conversation-thinking-block">
  <button class="conversation-reasoning-toggle" aria-label="Reasoning" disabled>
    ${chevronRightSvg("conversation-chevron rotate-90")}
    Reasoning
  </button>
  <div class="conversation-reasoning-body">${escapeHtml(thinking)}</div>
</div>`;
  }

  if (text) {
    composed += `<div class="conversation-markdown prose prose-invert max-w-none text-ink-100 text-sm leading-relaxed markdown-content">${renderMarkdown(text)}</div>`;
  }

  for (const call of toolCalls) {
    const result = call.id && toolResultsMap ? toolResultsMap.get(call.id) : undefined;
    composed += renderToolCallBubble(call, result);
  }

  if (!composed) return "";

  let metadata = "";
  if (msg.model || msg.usage) {
    const modelSpan = msg.model ? `<span>${escapeHtml(msg.model)}</span>` : "";
    const tokenSpan = msg.usage
      ? `<span class="conversation-metadata-tokens">${formatTokens(
          (msg.usage.input || 0) + (msg.usage.output || 0)
        )} tokens</span>`
      : "";
    const errSpan =
      msg.stopReason === "aborted" || msg.stopReason === "error"
        ? `<span class="conversation-metadata-error">${msg.stopReason}</span>`
        : "";
    metadata = `<div class="conversation-metadata">${modelSpan}${tokenSpan}${errSpan}</div>`;
  }

  return `<div class="conversation-message-row min-w-0">
  <div class="conversation-avatar">${avatarSvg()}</div>
  <div class="conversation-bubble conversation-assistant-bubble">
    ${composed}${metadata}
  </div>
</div>`;
}

function renderToolResultMessage(msg: ChatMessage): string {
  const content = extractText(msg.content);
  const lines = content.split("\n");
  const accent = toolAccentKind(msg.toolName);
  const status = msg.isError
    ? `<span class="conversation-tool-status conversation-tool-status-error">(error)</span>`
    : "";
  const lineCount = lines.length > 1
    ? `<span class="conversation-tool-status">${lines.length} lines</span>`
    : "";

  return `<div class="conversation-message-row min-w-0">
  <div class="conversation-avatar">${avatarSvg()}</div>
  <div class="conversation-bubble conversation-assistant-bubble">
    <div class="conversation-tool-bubble conversation-tool-bubble--${accent} ${msg.isError ? "conversation-tool-bubble-error" : ""}">
      <div class="conversation-tool-header">
        ${chevronRightSvg("conversation-chevron rotate-90")}
        <span class="conversation-tool-name">${escapeHtml(msg.toolName || "tool")} result</span>
        ${status}${lineCount}
      </div>
      <div class="conversation-tool-body conversation-result-panel">
        <pre class="conversation-result-pre">${escapeHtml(content)}</pre>
      </div>
    </div>
  </div>
</div>`;
}

function renderBashMessage(msg: ChatMessage): string {
  const output = msg.output || "";
  const isError = msg.exitCode !== undefined && msg.exitCode !== 0;
  const lines = output.split("\n");
  const lineCount = lines.length > 1 ? `<span class="conversation-tool-status">${lines.length} lines</span>` : "";
  const exitCodeSpan =
    msg.exitCode !== undefined
      ? `<span class="conversation-exit-code ${isError ? "conversation-exit-code-error" : ""}">[${msg.exitCode}]</span>`
      : "";

  return `<div class="conversation-message-row min-w-0">
  <div class="conversation-avatar">${avatarSvg()}</div>
  <div class="conversation-bubble conversation-assistant-bubble">
    <div class="conversation-tool-bubble conversation-tool-bubble--bash ${isError ? "conversation-tool-bubble-error" : ""}">
      <div class="conversation-tool-header conversation-bash-header">
        ${chevronRightSvg("conversation-chevron rotate-90")}
        <span class="conversation-bash-command">$ ${escapeHtml(msg.command || "")}</span>
        ${exitCodeSpan}${lineCount}
      </div>
      ${output ? `<div class="conversation-tool-body conversation-result-panel"><pre class="conversation-result-pre">${escapeHtml(output)}</pre></div>` : ""}
    </div>
  </div>
</div>`;
}

function renderSystemMessage(msg: ChatMessage): string {
  const label = msg.role === "compactionSummary" ? "Context compacted" : "Branch summary";
  const tokens = msg.tokensBefore ? ` · ${formatTokens(msg.tokensBefore)} tokens` : "";
  return `<div class="conversation-system-pill-wrap">
  <div class="conversation-system-pill">${escapeHtml(label)}${tokens}</div>
</div>`;
}

function renderEntry(
  entry: SessionDetail["entries"][number],
  toolResultsMap: Map<string, ChatMessage>,
  inlineToolCallIds: Set<string>
): string {
  if (!entry.message) return "";
  const role = entry.message.role;
  if (role === "user") return renderUserMessage(entry.message);
  if (role === "assistant") return renderAssistantMessage(entry.message, toolResultsMap);
  if (role === "toolResult") {
    if (entry.message.toolCallId && inlineToolCallIds.has(entry.message.toolCallId)) return "";
    return renderToolResultMessage(entry.message);
  }
  if (role === "bashExecution") return renderBashMessage(entry.message);
  if (role === "branchSummary" || role === "compactionSummary") return renderSystemMessage(entry.message);
  return "";
}

export async function buildSessionHtmlPretty(detail: SessionDetail): Promise<string> {
  const css = await loadClientCss();
  const title = detail.name || "Session Export";

  const toolResultsMap = new Map<string, ChatMessage>();
  const inlineToolCallIds = new Set<string>();

  for (const entry of detail.entries) {
    if (entry.message?.role === "toolResult" && entry.message.toolCallId) {
      toolResultsMap.set(entry.message.toolCallId, entry.message);
    }
    if (entry.message?.role === "assistant" && Array.isArray(entry.message.content)) {
      for (const block of entry.message.content) {
        if (block.type === "toolCall" && block.id) {
          inlineToolCallIds.add(block.id);
        }
      }
    }
  }

  const messagesHtml = detail.entries
    .map((e) => renderEntry(e, toolResultsMap, inlineToolCallIds))
    .filter(Boolean)
    .join("\n");

  return wrap(title, detail.cwd || "", messagesHtml, css);
}
