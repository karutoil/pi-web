import { useState, useRef, useCallback, useEffect, useMemo, type KeyboardEvent, type ClipboardEvent } from "react";
import type { CommandInfo, SessionStats } from "@pi-web/shared";
import type { AutoRetryState, WSBridge } from "../lib/types";
import { CommandCompleter } from "./CommandCompleter";
import { Icon } from "./Icon";
import { ModelSelectorDropdown } from "./ModelSelectorDropdown";
import { compressImage } from "../lib/imageUtils";
import { stripAnsi } from "../lib/stripAnsi";
import { FileMentionCompleter } from "./FileMentionCompleter";
import { PromptLibraryModal } from "./PromptLibraryModal";
import { usePreviewStore } from "../hooks/usePreviewStore";
import { buildElementContext } from "../lib/elementMention";
import { usePromptLibrary } from "../hooks/usePromptLibrary";

interface ChatInputProps {
  onSend: (text: string, images?: { data: string; mimeType: string }[]) => void;
  onSteer?: (text: string, images?: { data: string; mimeType: string }[]) => void;
  onFollowUp?: (text: string, images?: { data: string; mimeType: string }[]) => void;
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

export function ChatInput({ onSend, onSteer, onFollowUp, onAbort, isStreaming, disabled, commands, onRequestCommands, showTerminal, statusEntries, widgets, autoRetry, onAbortRetry, projectPath, ws, sessionStats }: ChatInputProps) {
  const [text, setText] = useState("");
  const [showCommands, setShowCommands] = useState(false);
  const [showFileMentions, setShowFileMentions] = useState(false);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [modelOpen, setModelOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [showPromptLibrary, setShowPromptLibrary] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputWrapRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCountRef = useRef(0);
  const recognitionRef = useRef<unknown>(null);
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

  const submitAs = useCallback((sendFn: (text: string, images?: { data: string; mimeType: string }[]) => void, e?: KeyboardEvent) => {
    const trimmed = textRef.current.trim();
    if ((!trimmed && pendingImagesRef.current.length === 0) || disabledRef.current) return;
    sendFn(trimmed, pendingImagesRef.current.length > 0 ? pendingImagesRef.current : undefined);
    setText("");
    setPendingImages([]);
    setShowCommands(false);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    e?.stopPropagation();
  }, []);

  const handleSend = useCallback((e?: KeyboardEvent) => {
    submitAs(isStreaming ? onFollowUp ?? onSend : onSend, e);
  }, [submitAs, isStreaming, onFollowUp, onSend]);

  const handleSteer = useCallback((e?: KeyboardEvent) => {
    if (isStreaming && onSteer) {
      submitAs(onSteer, e);
    } else {
      handleSend(e);
    }
  }, [submitAs, isStreaming, onSteer, handleSend]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (isStreaming && e.ctrlKey) {
        handleSteer(e);
      } else {
        handleSend(e);
      }
    }
    if (e.key === "Escape") { setShowCommands(false); setShowFileMentions(false); }
    if (e.key === "Backspace" && showCommands && slashIndex === text.length - 1) setShowCommands(false);
    if (e.key === "Backspace" && showFileMentions && !atMatch) setShowFileMentions(false);
  }, [handleSend, handleSteer, isStreaming, showCommands, showFileMentions, slashIndex, text.length, atMatch]);

  const handleInput = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const maxH = window.innerWidth < 768 ? 160 : 200;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, maxH) + "px";
  }, []);

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

    const cursorPos = e.target.selectionStart ?? val.length;
    const textBeforeCursor = val.slice(0, cursorPos);
    const atTrigger = /(?:^|\s)@([^\s@]*)$/.exec(textBeforeCursor);
    if (atTrigger) {
      setShowFileMentions(true);
    } else if (showFileMentions) {
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

  const processImageFiles = useCallback((files: FileList | null) => {
    if (!files) return;
    Array.from(files).forEach((file) => {
      if (!file.type.startsWith("image/")) return;
      compressImage(file).then((compressed) => {
        const reader = new FileReader();
        reader.onload = () => {
          if (!mountedRef.current) return;
          const base64 = (reader.result as string).split(",")[1];
          setPendingImages(prev => [...prev, { data: base64, mimeType: compressed.type || "image/jpeg" }]);
        };
        reader.readAsDataURL(compressed);
      }).catch(console.error);
    });
  }, []);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    processImageFiles(e.target.files);
    e.currentTarget.value = "";
  }, [processImageFiles]);

  const handleDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const types = Array.from(e.dataTransfer.types);
    if (types.includes("Files")) {
      dragCountRef.current++;
      setIsDragging(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragCountRef.current = Math.max(0, dragCountRef.current - 1);
    if (dragCountRef.current === 0) setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragCountRef.current = 0;
    setIsDragging(false);
    processImageFiles(e.dataTransfer.files);
  }, [processImageFiles]);

  const getSpeechRecognition = useCallback((): (new () => unknown) | null => {
    if (typeof window === "undefined") return null;
    const w = window as unknown as { SpeechRecognition?: new () => unknown; webkitSpeechRecognition?: new () => unknown };
    return w.SpeechRecognition || w.webkitSpeechRecognition || null;
  }, []);
  const speechAvailable = getSpeechRecognition() !== null;

  const handleMicToggle = useCallback(() => {
    const Recognition = getSpeechRecognition();
    if (!Recognition) return;
    if (isListening) {
      (recognitionRef.current as { stop?: () => void } | null)?.stop?.();
      return;
    }
    const rec = new Recognition();
    (rec as { continuous: boolean; interimResults: boolean; lang: string }).continuous = false;
    (rec as { continuous: boolean; interimResults: boolean; lang: string }).interimResults = false;
    (rec as { continuous: boolean; interimResults: boolean; lang: string }).lang = "en-US";
    (rec as { onresult: (event: unknown) => void }).onresult = (event: unknown) => {
      const resultEvent = event as { results: { isFinal: boolean; 0: { transcript: string } }[] };
      const transcript = Array.from(resultEvent.results).map(r => r[0].transcript).join("");
      setText(prev => (prev ? prev + " " + transcript : transcript).trimStart());
    };
    (rec as { onerror: (() => void) | null }).onerror = () => setIsListening(false);
    (rec as { onend: (() => void) | null }).onend = () => setIsListening(false);
    recognitionRef.current = rec;
    (rec as { start: () => void }).start();
    setIsListening(true);
  }, [isListening, speechAvailable]);

  const { commands: promptCommands, findByName, insertText, ...promptLibrary } = usePromptLibrary();

  const allCommands = useMemo(() => [...commands, ...promptCommands], [commands, promptCommands]);

  const handleSelectCommand = useCallback((name: string) => {
    const lastSlash = text.lastIndexOf("/");
    const before = text.slice(0, lastSlash);
    const template = findByName(name);
    if (template) {
      const inserted = insertText(template.text, textareaRef.current);
      setText(before + inserted);
    } else {
      setText(before + "/" + name + " ");
      textareaRef.current?.focus();
    }
    setShowCommands(false);
  }, [text, findByName, insertText]);

  const handleSelectFile = useCallback((relativePath: string, isDirectory: boolean) => {
    const cursorPos = textareaRef.current?.selectionStart ?? text.length;
    const textBeforeCursor = text.slice(0, cursorPos);
    const atMatch = /(?:^|\s)@([^\s@]*)$/.exec(textBeforeCursor);
    if (atMatch) {
      const atStart = atMatch.index + (atMatch[0].startsWith(" ") ? 1 : 0);
      const before = text.slice(0, atStart);
      const after = text.slice(cursorPos);
      const insertion = isDirectory ? `@${relativePath}/` : `@${relativePath} `;
      setText(before + insertion + after);
      requestAnimationFrame(() => {
        const newCursorPos = before.length + insertion.length;
        textareaRef.current?.setSelectionRange(newCursorPos, newCursorPos);
        textareaRef.current?.focus();
      });
      if (!isDirectory) setShowFileMentions(false);
    }
  }, [text]);

  const statusArr = Object.entries(statusEntries);
  const statusLeft = statusArr[0];
  const statusRight = statusArr.slice(1);

  const belowWidgetLines: string[] = [];
  for (const [, w] of Object.entries(widgets)) {
    if (w.placement === "belowEditor") belowWidgetLines.push(...w.lines);
  }

  const widgetsAbove = Object.entries(widgets).filter(([, w]) => w.placement === "aboveEditor");

  const rightParts: string[] = [];
  if (belowWidgetLines.length > 0) rightParts.push(...belowWidgetLines.map(stripAnsi));
  for (const [, val] of statusRight) rightParts.push(stripAnsi(val));
  const rightText = rightParts.join("  ");

  const hasStatusRow = statusLeft || rightText;

  const currentModel = ws.models.find(m => m.id === ws.state?.model);
  const thinkingLevel = ws.state?.thinkingLevel || "off";
  const tokenCount = sessionStats?.contextUsage?.tokens ?? sessionStats?.tokens?.totalTokens ?? null;
  const contextPercent = sessionStats?.contextUsage?.percent ?? null;
  const tokenWarn = contextPercent !== null && contextPercent > 60;

  return (
    <div className="conversation-input-dock shrink-0">
      <div
        ref={inputWrapRef}
        className="conversation-input-wrap min-w-0"
        onDragEnter={handleDragEnter}
        onDragOver={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {isDragging && (
          <div className="absolute inset-0 z-10 bg-amber-500/10 border-2 border-dashed border-amber-500 rounded-lg flex items-center justify-center text-amber-500 text-xs pointer-events-none">
            Drop images to attach
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={handleFileChange}
          aria-hidden="true"
        />
        {pendingImages.length > 0 && (
          <div className="conversation-image-list">
            {pendingImages.map((img, i) => (
              <div key={i} className="conversation-image-preview">
                <img src={`data:${img.mimeType};base64,${img.data}`} alt="Attachment" />
                <button onClick={() => removeImage(i)} className="conversation-image-remove" aria-label="Remove image">×</button>
              </div>
            ))}
          </div>
        )}

        {widgetsAbove.length > 0 && (
          <div className="conversation-widget-stack">
            {widgetsAbove.map(([key, widget]) => (
              <div key={key} className="conversation-widget">
                {widget.lines.map((line, i) => <div key={i} className="whitespace-pre-wrap">{stripAnsi(line)}</div>)}
              </div>
            ))}
          </div>
        )}

        <div className="relative">
          {showCommands && <CommandCompleter commands={allCommands} filter={commandFilter} onSelect={handleSelectCommand} onClose={() => setShowCommands(false)} anchorRef={inputWrapRef} />}
          {showFileMentions && atMatch && <FileMentionCompleter projectPath={projectPath} filter={fileMentionFilter} onSelect={handleSelectFile} onClose={() => setShowFileMentions(false)} anchorRef={inputWrapRef} />}

          <ModelSelectorDropdown ws={ws} open={modelOpen} onClose={() => setModelOpen(false)} anchorRef={inputWrapRef} />

          <div className={`conversation-editor-shell${isStreaming ? " is-streaming" : ""}`}>
            {hasStatusRow && (
              <div className="conversation-status-row">
                <span>{statusLeft ? stripAnsi(statusLeft[1]) : ""}</span>
                {rightText && <span>{rightText}</span>}
              </div>
            )}

            <textarea
              ref={textareaRef}
              value={text}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={isStreaming ? "Steer..." : "Ask PI..."}
              disabled={disabled}
              rows={1}
              className="conversation-textarea"
              enterKeyHint="send"
            />

            <div className="conversation-toolbar">
              <button
                type="button"
                onClick={() => setModelOpen(true)}
                className="conversation-toolbar-pill"
                aria-label="Select model"
              >
                <Icon name="pi-logo" size={10} />
                <span className="truncate max-w-[8rem] md:max-w-[10rem]">
                  {currentModel?.name || ws.state?.model || (ws.models.length === 0 && ws.isConnected ? "Loading…" : "Model")}
                </span>
              </button>

              <button
                type="button"
                onClick={() => ws.cycleThinkingLevel()}
                className="conversation-toolbar-pill"
                title="Cycle thinking level"
                aria-label="Cycle thinking level"
              >
                {thinkingLevel === "off" ? "No think" : thinkingLevel}
              </button>

              <div className="conversation-toolbar-spacer" />

              <button
                type="button"
                onClick={() => setShowPromptLibrary(true)}
                className="conversation-toolbar-pill"
                title="Prompt library"
                aria-label="Prompt library"
              >
                <Icon name="pencil" size={12} />
              </button>

              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="conversation-toolbar-pill"
                title="Attach image"
                aria-label="Attach image"
              >
                <Icon name="image" size={12} />
              </button>

              {speechAvailable && (
                <button
                  type="button"
                  onClick={handleMicToggle}
                  className={`conversation-toolbar-pill ${isListening ? "text-rose-500 bg-rose-500/10" : ""}`}
                  title={isListening ? "Stop listening" : "Voice input"}
                  aria-label={isListening ? "Stop listening" : "Voice input"}
                >
                  <Icon name="microphone" size={12} />
                </button>
              )}

              {tokenCount !== null && (
                <span className="conversation-token-count" data-warn={tokenWarn} title={contextPercent ? `${contextPercent.toFixed(0)}% context used` : `${tokenCount.toLocaleString()} tokens`}>
                  {tokenCount.toLocaleString()}
                </span>
              )}

              {showTerminal && (
                <button type="button" className="conversation-terminal-button" title="Terminal open" aria-label="Terminal open">
                  <Icon name="terminal" size={14} />
                </button>
              )}

              {isStreaming ? (
                <>
                  <button type="button" onClick={onAbort} className="conversation-abort-button" title="Abort" aria-label="Abort">
                    <Icon name="abort" size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSend()}
                    disabled={(!text.trim() && pendingImages.length === 0) || disabled}
                    className="conversation-send-button"
                    title="Follow up (Enter)"
                    aria-label="Send follow-up message"
                  >
                    <Icon name="send" size={14} />
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => handleSend()}
                  disabled={(!text.trim() && pendingImages.length === 0) || disabled}
                  className="conversation-send-button"
                  title="Send"
                  aria-label="Send message"
                >
                  <Icon name="send" size={14} />
                </button>
              )}
            </div>
          </div>
        </div>

        {autoRetry && (
          <div className="conversation-auto-retry">
            <span>⟳</span>
            <span>Retrying ({autoRetry.attempt}/{autoRetry.maxAttempts})</span>
            <span className="truncate max-w-24 sm:max-w-32" title={stripAnsi(autoRetry.errorMessage)}>{stripAnsi(autoRetry.errorMessage).slice(0, 40)}</span>
            <button type="button" onClick={onAbortRetry}>Cancel</button>
          </div>
        )}

        {showPromptLibrary && (
          <PromptLibraryModal
            templates={promptLibrary.templates}
            onAdd={promptLibrary.add}
            onUpdate={promptLibrary.update}
            onRemove={promptLibrary.remove}
            onClose={() => setShowPromptLibrary(false)}
          />
        )}
      </div>
    </div>
  );
}
