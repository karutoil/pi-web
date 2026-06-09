import { useState, useRef, useCallback, useEffect, type KeyboardEvent, type ClipboardEvent } from "react";
import type { CommandInfo, SessionStats } from "@pi-web/shared";
import type { AutoRetryState, WSBridge } from "../lib/types";
import { CommandCompleter } from "./CommandCompleter";
import { Icon } from "./Icon";
import { ModelSelectorDropdown } from "./ModelSelectorDropdown";
import { compressImage } from "../lib/imageUtils";
import { stripAnsi } from "../lib/stripAnsi";
import { FileMentionCompleter } from "./FileMentionCompleter";
import { usePreviewStore } from "../hooks/usePreviewStore";
import { buildElementContext } from "../lib/elementMention";

interface ChatInputProps {
  onSend: (text: string, images?: { data: string; mimeType: string }[]) => void;
  onAbort: () => void;
  isStreaming: boolean;
  disabled: boolean;
  commands: CommandInfo[];
  onRequestCommands: () => void;
  showTerminal?: boolean;
  // Extension UI state
  statusEntries: Record<string, string>;
  widgets: Record<string, { lines: string[]; placement: string }>;
  autoRetry: AutoRetryState | null;
  onAbortRetry: () => void;
  // Project path for @ file mentions
  projectPath?: string;
  // Model / thinking / stats (moved from ChatHeader)
  ws: WSBridge;
  sessionStats: SessionStats | null;
}

interface PendingImage { data: string; mimeType: string; }

export function ChatInput({ onSend, onAbort, isStreaming, disabled, commands, onRequestCommands, showTerminal, statusEntries, widgets, autoRetry, onAbortRetry, projectPath, ws, sessionStats }: ChatInputProps) {
  const [text, setText] = useState("");
  const [showCommands, setShowCommands] = useState(false);
  const [showFileMentions, setShowFileMentions] = useState(false);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [modelOpen, setModelOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputContainerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef(text);
  useEffect(() => { textRef.current = text; }, [text]);
  const pendingImagesRef = useRef(pendingImages);
  useEffect(() => { pendingImagesRef.current = pendingImages; }, [pendingImages]);
  const disabledRef = useRef(disabled);
  useEffect(() => { disabledRef.current = disabled; }, [disabled]);
  const mountedRef = useRef(true);

  // Insert element context into input when picker selects an element
  const pendingElementToken = usePreviewStore((s) => s.pendingElementToken);
  useEffect(() => {
    if (!pendingElementToken) return;
    const store = usePreviewStore.getState();
    const element = store.pickedElements.find(e => e.token === pendingElementToken);
    const context = element ? buildElementContext(element) : `@${pendingElementToken}`;
    const insertion = `@${pendingElementToken}\n${context}\n`;
    setText(prev => {
      const el = textareaRef.current;
      if (!el) return prev + insertion;
      const start = el.selectionStart;
      return prev.slice(0, start) + insertion + prev.slice(start);
    });
    store.consumePendingElement();
  }, [pendingElementToken]);
  useEffect(() => { return () => { mountedRef.current = false; }; }, []);


  const slashIndex = text.lastIndexOf("/");
  const commandFilter = (showCommands && slashIndex >= 0) ? text.slice(slashIndex + 1) : "";

  // @ mention: find the last @ that's not part of a word
  const atMatch = showFileMentions ? /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, textareaRef.current?.selectionStart ?? text.length)) : null;
  const fileMentionFilter = atMatch ? atMatch[1] : "";

  const handleSend = useCallback(() => {
    const trimmed = textRef.current.trim();
    if ((!trimmed && pendingImagesRef.current.length === 0) || disabledRef.current) return;
    onSend(trimmed, pendingImagesRef.current.length > 0 ? pendingImagesRef.current : undefined);
    setText("");
    setPendingImages([]);
    setShowCommands(false);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, [disabled, onSend]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
    if (e.key === "Escape") { setShowCommands(false); setShowFileMentions(false); }
    if (e.key === "Backspace" && showCommands && slashIndex === text.length - 1) setShowCommands(false);
    // Close file mentions if backspace removes the @
    if (e.key === "Backspace" && showFileMentions && !atMatch) setShowFileMentions(false);
  }, [handleSend, showCommands, showFileMentions, slashIndex, text.length, atMatch]);

  const handleInput = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const maxH = window.innerWidth < 768 ? 160 : 200;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, maxH) + "px";
  }, []);

  // Auto-resize textarea when text changes programmatically (e.g. element token insertion)
  useEffect(() => {
    handleInput();
  }, [text, handleInput]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setText(val);
    handleInput();
    if (val.endsWith("/")) { setShowCommands(true); onRequestCommands(); }
    const lastSlash = val.lastIndexOf("/");
    if (showCommands && lastSlash >= 0 && val.slice(lastSlash + 1).includes(" ")) setShowCommands(false);

    // @ mention trigger: detect standalone @ (not inside a word)
    const cursorPos = e.target.selectionStart ?? val.length;
    const textBeforeCursor = val.slice(0, cursorPos);
    const atTrigger = /(?:^|\s)@([^\s@]*)$/.exec(textBeforeCursor);
    if (atTrigger) {
      setShowFileMentions(true);
    } else if (showFileMentions) {
      // Check if we're still in an @ mention context
      setShowFileMentions(false);
    }
  }, [handleInput, showCommands, showFileMentions, commands.length, onRequestCommands]);

  const handlePaste = useCallback((e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const blob = item.getAsFile();
        if (!blob) continue;
        compressImage(blob).then((compressed) => {
          const reader = new FileReader();
          reader.onload = () => {
            if (!mountedRef.current) return;
            const base64 = (reader.result as string).split(",")[1];
            setPendingImages(prev => [...prev, { data: base64, mimeType: compressed.type || "image/jpeg" }]);
          };
          reader.readAsDataURL(compressed);
        }).catch(console.error);
      }
    }
  }, []);

  const removeImage = (idx: number) => setPendingImages(prev => prev.filter((_, i) => i !== idx));

  const handleSelectCommand = useCallback((name: string) => {
    const lastSlash = text.lastIndexOf("/");
    setText(text.slice(0, lastSlash) + "/" + name + " ");
    setShowCommands(false);
    textareaRef.current?.focus();
  }, [text]);

  const handleSelectFile = useCallback((relativePath: string, isDirectory: boolean) => {
    // Find the @ that triggered the mention and replace from there
    const cursorPos = textareaRef.current?.selectionStart ?? text.length;
    const textBeforeCursor = text.slice(0, cursorPos);
    const atMatch = /(?:^|\s)@([^\s@]*)$/.exec(textBeforeCursor);
    if (atMatch) {
      const atStart = atMatch.index + (atMatch[0].startsWith(" ") ? 1 : 0);
      const before = text.slice(0, atStart);
      const after = text.slice(cursorPos);
      // For directories: insert @dir/ (trailing slash) so user can keep drilling
      // For files: insert @path and a trailing space
      const insertion = isDirectory ? `@${relativePath}/` : `@${relativePath} `;
      setText(before + insertion + after);
      requestAnimationFrame(() => {
        const newCursorPos = before.length + insertion.length;
        textareaRef.current?.setSelectionRange(newCursorPos, newCursorPos);
        textareaRef.current?.focus();
      });
      // Keep completer open for directories (user may continue typing path)
      if (!isDirectory) setShowFileMentions(false);
    }
  }, [text]);

  // ── Status: first entry = left, second+ = right ──
  const statusArr = Object.entries(statusEntries);
  const statusLeft = statusArr[0];
  const statusRight = statusArr.slice(1);

  // ── belowEditor widgets go on the right side of the status row ──
  const belowWidgetLines: string[] = [];
  for (const [, w] of Object.entries(widgets)) {
    if (w.placement === "belowEditor") belowWidgetLines.push(...w.lines);
  }

  // ── aboveEditor widgets ──
  const widgetsAbove = Object.entries(widgets).filter(([, w]) => w.placement === "aboveEditor");

  // ── Build the right-side status text ──
  const rightParts: string[] = [];
  if (belowWidgetLines.length > 0) rightParts.push(...belowWidgetLines.map(stripAnsi));
  for (const [, val] of statusRight) rightParts.push(stripAnsi(val));
  const rightText = rightParts.join("  ");

  const hasStatusRow = statusLeft || rightText;

  // ── Model / reasoning helpers ──
  const currentModel = ws.models.find(m => m.id === ws.state?.model);
  const thinkingLevel = ws.state?.thinkingLevel || "off";
  const tokenCount = sessionStats?.contextUsage?.tokens ?? sessionStats?.tokens?.totalTokens ?? null;
  const contextPercent = sessionStats?.contextUsage?.percent ?? null;

  return (
    <div className="px-2 md:px-4 pb-2 md:pb-4 pt-2 flex justify-center mobile-safe-bottom shrink-0 max-h-[45vh] overflow-y-auto">
      <div className="max-w-3xl w-full min-w-0">
        {/* Image previews */}
        {pendingImages.length > 0 && (
          <div className="flex gap-2 mb-2 flex-wrap px-2">
            {pendingImages.map((img, i) => (
              <div key={i} className="relative group">
                <img src={`data:${img.mimeType};base64,${img.data}`} alt="Attachment" className="h-12 rounded-lg border border-ink-700 object-cover" />
                <button onClick={() => removeImage(i)} className="absolute -top-1.5 -right-1.5 w-6 h-6 rounded-full bg-rose-600 text-white text-xs flex items-center justify-center opacity-70 group-hover:opacity-100 transition-opacity touch-target-sm" aria-label="Remove image">×</button>
              </div>
            ))}
          </div>
        )}

        {/* Widgets above editor */}
        {widgetsAbove.length > 0 && (
          <div className="flex flex-col gap-1 mb-2">
            {widgetsAbove.map(([key, widget]) => (
              <div key={key} className="px-3 py-1.5 bg-ink-950/60 backdrop-blur-sm border border-ink-800/50 rounded-xl text-ink-400 text-xs font-mono">
                {widget.lines.map((line, i) => <div key={i} className="whitespace-pre-wrap">{stripAnsi(line)}</div>)}
              </div>
            ))}
          </div>
        )}

        <div ref={inputContainerRef} className="relative">
          {showCommands && <CommandCompleter commands={commands} filter={commandFilter} onSelect={handleSelectCommand} onClose={() => setShowCommands(false)} />}
          {showFileMentions && atMatch && <FileMentionCompleter projectPath={projectPath} filter={fileMentionFilter} onSelect={handleSelectFile} onClose={() => setShowFileMentions(false)} />}

          {/* Upward-opening model selector dropdown */}
          <ModelSelectorDropdown ws={ws} open={modelOpen} onClose={() => setModelOpen(false)} />

          {/* ── Main rounded input container ── */}
          <div className="bg-ink-900/40 backdrop-blur-md border border-ink-700/50 rounded-2xl px-3 md:px-4 shadow-lg focus-within:border-amber-500/40 focus-within:shadow-[0_0_32px_rgba(192,141,14,0.06)] transition-all">
            {/* Status row */}
            {hasStatusRow && (
              <div className="flex items-center justify-between pt-2.5 pb-1 text-ink-500 text-[11px] font-mono">
                <span className="truncate max-w-[45%]">
                  {statusLeft ? stripAnsi(statusLeft[1]) : ""}
                </span>
                {rightText && (
                  <span className="shrink-0 text-right truncate max-w-[50%]">{rightText}</span>
                )}
              </div>
            )}

            {/* Textarea */}
            <div className="flex items-end gap-2 py-2 md:py-2.5">
              <textarea
                ref={textareaRef}
                value={text}
                onChange={handleChange}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder={isStreaming ? "Steer..." : "Ask PI..."}
                disabled={disabled}
                rows={1}
                className="flex-1 bg-transparent text-ink-100 text-sm placeholder-ink-500 resize-none outline-none max-h-[160px] md:max-h-[200px] leading-relaxed"
                enterKeyHint="send"
              />
            </div>

            {/* Bottom toolbar: model | thinking | spacer | tokens | terminal | send */}
            <div className="flex items-center gap-1.5 md:gap-2 pb-2.5 md:pb-3 pt-0.5 flex-wrap">
              {/* Model pill */}
              <button
                onClick={() => setModelOpen(true)}
                className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-ink-800/50 border border-ink-750 text-ink-300 text-xs font-mono hover:border-ink-600 hover:text-ink-200 transition-theme min-h-[28px] shrink-0"
                aria-label="Select model"
              >
                <Icon name="pi-logo" size={10} className="text-amber-500" />
                <span className="truncate max-w-[100px] md:max-w-[140px]">
                  {currentModel?.name || ws.state?.model || (ws.models.length === 0 && ws.isConnected ? "Loading…" : "Model")}
                </span>
              </button>

              {/* Reasoning / thinking level pill */}
              <button
                onClick={() => ws.cycleThinkingLevel()}
                className="px-2 py-1 rounded-full bg-ink-800/50 border border-ink-750 text-ink-300 text-xs font-mono hover:border-ink-600 hover:text-ink-200 transition-theme min-h-[28px] shrink-0"
                title="Cycle thinking level"
                aria-label="Cycle thinking level"
              >
                {thinkingLevel === "off" ? "No think" : thinkingLevel}
              </button>

              <div className="flex-1 min-w-[12px]" />

              {/* Token count */}
              {tokenCount !== null && (
                <span
                  className={`text-xs font-mono shrink-0 ${contextPercent && contextPercent > 80 ? "text-rose-400" : contextPercent && contextPercent > 60 ? "text-amber-400" : "text-ink-500"}`}
                  title={contextPercent ? `${contextPercent.toFixed(0)}% context used` : `${tokenCount.toLocaleString()} tokens`}
                >
                  {tokenCount.toLocaleString()}
                </span>
              )}

              {/* Terminal toggle */}
              {showTerminal && (
                <button
                  className="p-2 rounded-full bg-amber-600/20 text-amber-500 transition-theme touch-target shrink-0"
                  title="Terminal open"
                  aria-label="Terminal open"
                >
                  <Icon name="terminal" size={14} />
                </button>
              )}

              {/* Send / Abort */}
              {isStreaming ? (
                <button
                  onClick={onAbort}
                  className="p-2 rounded-full bg-rose-600/20 text-rose-500 hover:bg-rose-600/30 transition-theme touch-target shrink-0"
                  title="Abort"
                  aria-label="Abort"
                >
                  <Icon name="abort" size={14} />
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  disabled={(!text.trim() && pendingImages.length === 0) || disabled}
                  className="p-2 rounded-full bg-amber-600 text-ink-950 hover:bg-amber-500 disabled:opacity-30 disabled:cursor-not-allowed transition-theme touch-target shrink-0"
                  title="Send"
                  aria-label="Send message"
                >
                  <Icon name="send" size={14} />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Auto-retry indicator */}
        {autoRetry && (
          <div className="flex items-center gap-2 mt-2 px-3 py-1.5 bg-amber-900/40 backdrop-blur-sm border border-amber-700/30 rounded-xl text-amber-200 text-xs">
            <span className="animate-spin-slow">⟳</span>
            <span>Retrying ({autoRetry.attempt}/{autoRetry.maxAttempts})</span>
            <span className="text-amber-400/70 truncate max-w-24 sm:max-w-32" title={stripAnsi(autoRetry.errorMessage)}>{stripAnsi(autoRetry.errorMessage).slice(0, 40)}</span>
            <button onClick={onAbortRetry} className="ml-auto text-amber-400 hover:text-amber-200 transition-colors">Cancel</button>
          </div>
        )}
      </div>

    </div>
  );
}
