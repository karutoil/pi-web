import { useState, useRef, useCallback, useEffect, type KeyboardEvent, type ClipboardEvent } from "react";
import type { CommandInfo } from "@pi-web/shared";
import type { AutoRetryState } from "../lib/types";
import { CommandCompleter } from "./CommandCompleter";
import { Icon } from "./Icon";
import { compressImage } from "../lib/imageUtils";

/** Strip ANSI escape sequences */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\].*?\x07/g, "");
}

interface ChatInputProps {
  onSend: (text: string, images?: { data: string; mimeType: string }[]) => void;
  onAbort: () => void;
  isStreaming: boolean;
  disabled: boolean;
  commands: CommandInfo[];
  onRequestCommands: () => void;
  showTerminal?: boolean;
  onToggleTerminal?: () => void;
  // Extension UI state
  statusEntries: Record<string, string>;
  widgets: Record<string, { lines: string[]; placement: string }>;
  autoRetry: AutoRetryState | null;
  onAbortRetry: () => void;
}

interface PendingImage { data: string; mimeType: string; }

export function ChatInput({ onSend, onAbort, isStreaming, disabled, commands, onRequestCommands, showTerminal, onToggleTerminal, statusEntries, widgets, autoRetry, onAbortRetry }: ChatInputProps) {
  const [text, setText] = useState("");
  const [showCommands, setShowCommands] = useState(false);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputContainerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef(text);
  useEffect(() => { textRef.current = text; }, [text]);
  const pendingImagesRef = useRef(pendingImages);
  useEffect(() => { pendingImagesRef.current = pendingImages; }, [pendingImages]);

  const slashIndex = text.lastIndexOf("/");
  const commandFilter = (showCommands && slashIndex >= 0) ? text.slice(slashIndex + 1) : "";

  const handleSend = useCallback(() => {
    const trimmed = textRef.current.trim();
    if ((!trimmed && pendingImagesRef.current.length === 0) || disabled) return;
    onSend(trimmed, pendingImagesRef.current.length > 0 ? pendingImagesRef.current : undefined);
    setText("");
    setPendingImages([]);
    setShowCommands(false);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, [disabled, onSend]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
    if (e.key === "Escape") setShowCommands(false);
    if (e.key === "Backspace" && showCommands && slashIndex === text.length - 1) setShowCommands(false);
  }, [handleSend, showCommands, slashIndex, text.length]);

  const handleInput = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const maxH = window.innerWidth < 768 ? 160 : 200;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, maxH) + "px";
  }, []);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setText(val);
    handleInput();
    if (val.endsWith("/")) { setShowCommands(true); onRequestCommands(); }
    const lastSlash = val.lastIndexOf("/");
    if (showCommands && lastSlash >= 0 && val.slice(lastSlash + 1).includes(" ")) setShowCommands(false);
  }, [handleInput, showCommands, commands.length, onRequestCommands]);

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

  return (
    <div className="px-2 md:px-4 pb-2 md:pb-4 pt-2 flex justify-center mobile-safe-bottom shrink-0">
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

          <div className="bg-ink-950/80 backdrop-blur-md border border-ink-800/60 rounded-2xl px-3 md:px-4 shadow-lg focus-within:border-amber-500/60 focus-within:shadow-[0_0_32px_rgba(192,141,14,0.08)] transition-all">
            {/* Status row — same div, above the textarea */}
            {hasStatusRow && (
              <div className="flex items-center justify-between pt-2 pb-1 text-ink-500 text-[11px] font-mono">
                <span className="truncate max-w-[45%]">
                  {statusLeft ? stripAnsi(statusLeft[1]) : ""}
                </span>
                {rightText && (
                  <span className="shrink-0 text-right truncate max-w-[50%]">{rightText}</span>
                )}
              </div>
            )}

            {/* Input row */}
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
              <div className="flex items-center gap-1 shrink-0">
                {onToggleTerminal && (
                  <button onClick={onToggleTerminal} className={`p-1.5 rounded-full transition-theme touch-target ${showTerminal ? "bg-amber-600/20 text-amber-500" : "text-ink-400 hover:text-ink-400 hover:bg-ink-800/40"}`} title="Toggle terminal" aria-label="Toggle terminal">
                    <Icon name="terminal" size={14} />
                  </button>
                )}
                {isStreaming ? (
                  <button onClick={onAbort} className="p-1.5 rounded-full bg-rose-600/20 text-rose-500 hover:bg-rose-600/30 transition-theme touch-target" title="Abort" aria-label="Abort"><Icon name="abort" size={14} /></button>
                ) : (
                  <button onClick={handleSend} disabled={(!text.trim() && pendingImages.length === 0) || disabled} className="p-1.5 rounded-full bg-amber-600 text-ink-950 hover:bg-amber-500 disabled:opacity-30 disabled:cursor-not-allowed transition-theme touch-target" title="Send" aria-label="Send message"><Icon name="send" size={14} /></button>
                )}
              </div>
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

        <p className="text-ink-500 text-[0.65rem] font-mono mt-1.5 text-center opacity-50 hidden md:block">
          {isStreaming ? "PI is working · type to steer" : disabled ? "Connecting..." : "Paste images · / for commands"}
        </p>
        <p className="text-ink-500 text-[0.65rem] font-mono mt-1.5 text-center opacity-50 md:hidden">
          {isStreaming ? "Type to steer" : disabled ? "Connecting..." : "Type a message..."}
        </p>
      </div>
    </div>
  );
}
