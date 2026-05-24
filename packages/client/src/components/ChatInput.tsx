import { useState, useRef, useCallback, useEffect, type KeyboardEvent, type ClipboardEvent } from "react";
import type { CommandInfo } from "@pi-web/shared";
import { CommandCompleter } from "./CommandCompleter";
import { Icon } from "./Icon";
import { compressImage } from "../lib/imageUtils";

interface ChatInputProps {
  onSend: (text: string, images?: { data: string; mimeType: string }[]) => void;
  onAbort: () => void;
  isStreaming: boolean;
  disabled: boolean;
  commands: CommandInfo[];
  onRequestCommands: () => void;
  showTerminal?: boolean;
  onToggleTerminal?: () => void;
}

interface PendingImage { data: string; mimeType: string; }

export function ChatInput({ onSend, onAbort, isStreaming, disabled, commands, onRequestCommands, showTerminal, onToggleTerminal }: ChatInputProps) {
  const [text, setText] = useState("");
  const [showCommands, setShowCommands] = useState(false);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputContainerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef(text);
  useEffect(() => { textRef.current = text; }, [text]);
  const pendingImagesRef = useRef(pendingImages);
  useEffect(() => { pendingImagesRef.current = pendingImages; }, [pendingImages]);

  // Check if cursor is after a "/"
  const slashIndex = text.lastIndexOf("/");
  const commandFilter = (showCommands && slashIndex >= 0) ? text.slice(slashIndex + 1) : "";

  const handleSend = useCallback(() => {
    const trimmed = textRef.current.trim();
    if ((!trimmed && pendingImagesRef.current.length === 0) || disabled) return;
    
    // If it's a slash command, send as-is
    onSend(trimmed, pendingImagesRef.current.length > 0 ? pendingImagesRef.current : undefined);
    setText("");
    setPendingImages([]);
    setShowCommands(false);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, [disabled, onSend]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
    if (e.key === "Escape") {
      setShowCommands(false);
    }
    if (e.key === "Backspace" && showCommands && slashIndex === text.length - 1) {
      setShowCommands(false);
    }
  }, [handleSend, showCommands, slashIndex, text.length]);

  const handleInput = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, []);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setText(val);
    handleInput();
    
    // Trigger command completion on "/"
    if (val.endsWith("/")) {
      setShowCommands(true);
      onRequestCommands();
    }
    // Keep showing if still typing command
    const lastSlash = val.lastIndexOf("/");
    if (showCommands && lastSlash >= 0) {
      const afterSlash = val.slice(lastSlash + 1);
      if (afterSlash.includes(" ")) setShowCommands(false);
    }
  }, [handleInput, showCommands, commands.length, onRequestCommands]);

  // Image paste handler
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
          const dataUrl = reader.result as string;
          const base64 = dataUrl.split(",")[1];
          setPendingImages(prev => [...prev, { data: base64, mimeType: compressed.type || "image/jpeg" }]);
        };
        reader.onerror = () => console.error("[ChatInput] FileReader failed for pasted image");
        reader.readAsDataURL(compressed);
        }).catch((err) => console.error("[ChatInput] Image compression failed:", err));
      }
    }
  }, []);

  const removeImage = (idx: number) => {
    setPendingImages(prev => prev.filter((_, i) => i !== idx));
  };

  const handleSelectCommand = useCallback((name: string) => {
    // Replace the "/" and everything after it with "/name "
    const lastSlash = text.lastIndexOf("/");
    const before = text.slice(0, lastSlash);
    setText(before + "/" + name + " ");
    setShowCommands(false);
    textareaRef.current?.focus();
  }, [text]);

  return (
    <div className="px-2 md:px-4 pb-2 md:pb-4 pt-2 flex justify-center mobile-safe-bottom">
      <div className="max-w-3xl w-full">
        {/* Image previews */}
        {pendingImages.length > 0 && (
          <div className="flex gap-2 mb-2 flex-wrap px-2">
            {pendingImages.map((img, i) => (
              <div key={i} className="relative group">
                <img
                  src={`data:${img.mimeType};base64,${img.data}`}
                  alt="Attachment"
                  className="h-12 rounded-lg border border-ink-700 object-cover"
                />
                <button
                  onClick={() => removeImage(i)}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-rose-600 text-white text-xs flex items-center justify-center opacity-70 group-hover:opacity-100 transition-opacity"
                  aria-label="Remove image"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        <div ref={inputContainerRef} className="relative">
          {/* Command completer */}
          {showCommands && (
            <CommandCompleter
              commands={commands}
              filter={commandFilter}
              onSelect={handleSelectCommand}
              onClose={() => setShowCommands(false)}
            />
          )}

          <div className="flex items-end gap-2 bg-ink-950/80 backdrop-blur-md border border-ink-800/60 rounded-2xl px-3 md:px-4 py-2 md:py-2.5 shadow-lg focus-within:border-amber-500/60 focus-within:shadow-[0_0_32px_rgba(192,141,14,0.08)] transition-all">
            <textarea
              ref={textareaRef}
              value={text}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={isStreaming ? "Steer..." : "Ask PI..."}
              disabled={disabled}
              rows={1}
              className="flex-1 bg-transparent text-ink-100 text-sm placeholder-ink-500 resize-none outline-none max-h-[200px] leading-relaxed"
            />
            
            <div className="flex items-center gap-1 shrink-0">
              {/* Terminal toggle */}
              {onToggleTerminal && (
                <button
                  onClick={onToggleTerminal}
                  className={`p-1.5 rounded-full transition-theme touch-target ${showTerminal ? "bg-amber-600/20 text-amber-500" : "text-ink-400 hover:text-ink-400 hover:bg-ink-800/40"}`}
                  title="Toggle terminal"
                  aria-label="Toggle terminal"
                >
                  <Icon name="terminal" size={14} />
                </button>
              )}
              {isStreaming ? (
                <button onClick={onAbort} className="p-1.5 rounded-full bg-rose-600/20 text-rose-500 hover:bg-rose-600/30 transition-theme touch-target" title="Abort" aria-label="Abort">
                  <Icon name="abort" size={14} />
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  disabled={(!text.trim() && pendingImages.length === 0) || disabled}
                  className="p-1.5 rounded-full bg-amber-600 text-ink-950 hover:bg-amber-500 disabled:opacity-30 disabled:cursor-not-allowed transition-theme touch-target"
                  title="Send"
                  aria-label="Send message"
                >
                  <Icon name="send" size={14} />
                </button>
              )}
            </div>
          </div>
        </div>
        
        <p className="text-ink-500 text-[0.65rem] font-mono mt-1.5 text-center opacity-50 hidden md:block">
          {isStreaming ? "PI is working · type to steer"
            : disabled ? "Connecting..."
            : "Paste images · / for commands"}
        </p>
        <p className="text-ink-500 text-[0.65rem] font-mono mt-1.5 text-center opacity-50 md:hidden">
          {isStreaming ? "Type to steer"
            : disabled ? "Connecting..."
            : "Type a message..."}
        </p>
      </div>
    </div>
  );
}
