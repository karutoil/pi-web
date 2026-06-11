import { useState, useEffect, useRef, useCallback } from "react";
import { Icon } from "./Icon";
import { useIsMobile } from "../hooks/useIsMobile";

// ─── Types ───

export interface TerminalTab {
  id: string;
  name: string;
  projectId: string;
  cwd: string;
}

// ─── Theme-safe xterm colors (match ink palette) ───

const XTERM_THEME_DARK = {
  background: "#1c1a16",
  foreground: "#b0a798",
  cursor: "#d4a020",
  cursorAccent: "#1c1a16",
  selectionBackground: "#d4a02040",
  black: "#1c1a16",
  red: "#c45454",
  green: "#6aab73",
  yellow: "#e2a832",
  blue: "#6a9ec8",
  magenta: "#b07dc8",
  cyan: "#6ab0b8",
  white: "#b0a798",
  brightBlack: "#7d7568",
  brightRed: "#e07070",
  brightGreen: "#8cc897",
  brightYellow: "#f0c850",
  brightBlue: "#8abce0",
  brightMagenta: "#c89de0",
  brightCyan: "#8ad0d8",
  brightWhite: "#faf6ed",
};

const XTERM_THEME_LIGHT = {
  background: "#ede7df",
  foreground: "#423b33",
  cursor: "#a07508",
  cursorAccent: "#ede7df",
  selectionBackground: "#c08d0e40",
  black: "#ede7df",
  red: "#b03030",
  green: "#3a7a43",
  yellow: "#906a10",
  blue: "#3a6a98",
  magenta: "#7a50a0",
  cyan: "#3a8088",
  white: "#423b33",
  brightBlack: "#80776b",
  brightRed: "#c04040",
  brightGreen: "#5a9a63",
  brightYellow: "#b08a20",
  brightBlue: "#5a8ab8",
  brightMagenta: "#9a6ac0",
  brightCyan: "#5aa0a8",
  brightWhite: "#17120e",
};

// ─── Single Terminal Instance ───

function TerminalInstance({ tab }: { tab: TerminalTab }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<any>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<any>(null);
  const isMobile = useIsMobile();

  // Detect current theme for xterm
  const [isDark, setIsDark] = useState(() => {
    try {
      return document.documentElement.getAttribute("data-theme") === "dark";
    } catch { return false; }
  });

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.getAttribute("data-theme") === "dark");
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let destroyed = false;
    let term: any = null;
    let fitAddon: any = null;
    let ws: WebSocket | null = null;

    Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
      import("@xterm/addon-web-links"),
    ]).then(([{ Terminal }, { FitAddon }, { WebLinksAddon }]) => {
      if (destroyed || !containerRef.current) return;

      term = new Terminal({
        cursorBlink: true,
        fontSize: isMobile ? 14 : 13,
        fontFamily: "'Geist Mono', 'JetBrains Mono', 'Fira Code', monospace",
        theme: isDark ? XTERM_THEME_DARK : XTERM_THEME_LIGHT,
        allowProposedApi: true,
        scrollback: 5000,
      });

      fitAddon = new FitAddon();
      const webLinksAddon = new WebLinksAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(webLinksAddon);
      term.open(container);

      termRef.current = term;
      fitAddonRef.current = fitAddon;

      // Fit — may need a few attempts as container settles
      const tryFit = (attempt: number) => {
        if (attempt > 10 || destroyed) return;
        try {
          fitAddon.fit();
        } catch {
          setTimeout(() => tryFit(attempt + 1), 100);
        }
      };
      requestAnimationFrame(() => tryFit(0));

      let retryCount = 0;
      const MAX_RETRIES = 5;

      const connectWs = () => {
        const protocol = location.protocol === "https:" ? "wss" : "ws";
        ws = new WebSocket(`${protocol}://${location.host}/ws?type=terminal&id=${encodeURIComponent(tab.id)}`);
        wsRef.current = ws;

        ws.onopen = () => {
          retryCount = 0;
          requestAnimationFrame(() => {
            if (destroyed) return;
            try { fitAddon.fit(); } catch {}
            const dims = fitAddon.proposeDimensions();
            if (dims && ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "term_resize", cols: dims.cols, rows: dims.rows }));
            }
          });
        };

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === "term_output") {
              term.write(msg.data);
            } else if (msg.type === "term_exit") {
              term.write(`\r\n\x1b[38;5;196m[Process exited with code ${msg.exitCode}]\x1b[0m\r\n`);
              ws?.close();
            }
          } catch {}
        };

        ws.onclose = () => {
          if (!destroyed && retryCount < MAX_RETRIES) {
            retryCount++;
            const delay = Math.min(2000 * Math.pow(2, retryCount - 1), 30000);
            setTimeout(() => {
              if (!destroyed && containerRef.current) {
                connectWs();
              }
            }, delay);
          }
        };
      };

      connectWs();

      term.onData((data: string) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "term_input", data }));
        }
      });

      term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "term_resize", cols, rows }));
        }
      });
    });

    return () => {
      destroyed = true;
      wsRef.current?.close();
      wsRef.current = null;
      if (term) { term.dispose(); }
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, [tab.id, isDark]);

  // Fit on window resize
  useEffect(() => {
    const handleResize = () => {
      if (fitAddonRef.current && termRef.current) {
        try { fitAddonRef.current.fit(); } catch {}
      }
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  return (
    <div
      ref={containerRef}
      className="terminal-instance"
    />
  );
}

// ─── Terminal Panel (bottom) ───

interface TerminalPanelProps {
  visible: boolean;
  onClose: () => void;
  embedded?: boolean;
  tabs: TerminalTab[];
  activeTabId: string | null;
  onAddTerminal: () => void;
}

export function TerminalPanel({ visible, onClose, embedded = false, tabs, activeTabId, onAddTerminal }: TerminalPanelProps) {
  const [height, setHeight] = useState(240);
  const [isResizing, setIsResizing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);
  // Terminal tabs are owned by App so they can live in the shared panel header.

  // Resize drag handler
  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    startYRef.current = e.clientY;
    startHeightRef.current = height;

    const handleMouseMove = (ev: MouseEvent) => {
      const delta = startYRef.current - ev.clientY;
      const newHeight = Math.max(120, Math.min(window.innerHeight * 0.7, startHeightRef.current + delta));
      setHeight(newHeight);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  }, [height]);

  const handleResizeTouchStart = useCallback((e: React.TouchEvent) => {
    e.preventDefault();
    setIsResizing(true);
    startYRef.current = e.touches[0].clientY;
    startHeightRef.current = height;

    const handleTouchMove = (ev: TouchEvent) => {
      const delta = startYRef.current - ev.touches[0].clientY;
      const newHeight = Math.max(120, Math.min(window.innerHeight * 0.7, startHeightRef.current + delta));
      setHeight(newHeight);
    };

    const handleTouchEnd = () => {
      setIsResizing(false);
      document.removeEventListener("touchmove", handleTouchMove);
      document.removeEventListener("touchend", handleTouchEnd);
      requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    };

    document.addEventListener("touchmove", handleTouchMove);
    document.addEventListener("touchend", handleTouchEnd);
  }, [height]);

  if (!visible) return null;

  const activeTab = tabs.find(t => t.id === activeTabId);

  return (
    <>
    <div
      ref={panelRef}
      className="terminal-shell select-none"
      style={{ touchAction: "manipulation", ...(embedded ? {} : { height: `${height}px` }) }}
    >
      {/* ── Resize handle ── */}
      {!embedded && (
          <div
            className="terminal-resize-handle"
            data-resizing={isResizing}
            onMouseDown={handleResizeMouseDown}
            onTouchStart={handleResizeTouchStart}
          >
            <div className="terminal-resize-grip" />
          </div>
      )}

      {/* ── Terminal content ── */}
      <div className="terminal-content">
        {activeTab && (
          <TerminalInstance key={activeTab.id} tab={activeTab} />
        )}
        {!activeTab && (
          <div className="terminal-empty">
            <div>
              <strong>No terminals open</strong>
              <span>Open a shell to run project commands.</span>
              <button className="modal-button modal-button--primary" onClick={onAddTerminal}>Open Terminal</button>
            </div>
          </div>
        )}
      </div>
    </div>
    </>
  );
}

// ─── Header: tabs live in WorkspaceDock panel header ───

export function TerminalPanelHeader({
  tabs,
  activeTabId,
  onSelectTab,
  onAddTerminal,
  onRemoveTab,
  onRenameTab,
}: {
  tabs: TerminalTab[];
  activeTabId: string | null;
  onSelectTab: (id: string) => void;
  onAddTerminal: () => void;
  onRemoveTab: (id: string) => void;
  onRenameTab: (id: string, name: string) => void;
}) {
  return (
    <div className="terminal-tabs" aria-label="Terminal tabs">
      <div className="terminal-tab-scroller custom-scrollbar-x">
        {tabs.map(tab => (
          <TabButton
            key={tab.id}
            tab={tab}
            isActive={tab.id === activeTabId}
            onSelect={() => onSelectTab(tab.id)}
            onClose={() => onRemoveTab(tab.id)}
            onRename={(name) => onRenameTab(tab.id, name)}
          />
        ))}
      </div>

      <div className="terminal-actions">
        <button
          type="button"
          onClick={onAddTerminal}
          className="terminal-icon-button"
          title="New terminal"
          aria-label="New terminal"
        >
          <Icon name="plus" size={12} />
        </button>
      </div>
    </div>
  );
}

// ─── Tab Button ───

function TabButton({ tab, isActive, onSelect, onClose, onRename }: {
  tab: TerminalTab;
  isActive: boolean;
  onSelect: () => void;
  onClose: () => void;
  onRename: (name: string) => void;
}) {
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(tab.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isRenaming && inputRef.current) inputRef.current.focus();
  }, [isRenaming]);

  const handleRenameSubmit = () => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== tab.name) onRename(trimmed);
    setIsRenaming(false);
  };

  return (
    <div
      className="terminal-tab"
      data-active={isActive}
      onClick={onSelect}
      onDoubleClick={() => setIsRenaming(true)}
    >
      <Icon name="terminal" size={10} className="terminal-tab-icon" />
      {isRenaming ? (
        <input
          ref={inputRef}
          value={renameValue}
          onChange={e => setRenameValue(e.target.value)}
          onBlur={handleRenameSubmit}
          onKeyDown={e => {
            if (e.key === "Enter") handleRenameSubmit();
            if (e.key === "Escape") { setRenameValue(tab.name); setIsRenaming(false); }
          }}
          onClick={e => e.stopPropagation()}
          className="terminal-tab-input"
        />
      ) : (
        <span className="terminal-tab-label">{tab.name}</span>
      )}
      <button
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        className="terminal-tab-close"
        aria-label={`Close ${tab.name}`}
      >
        <Icon name="close" size={8} />
      </button>
    </div>
  );
}
