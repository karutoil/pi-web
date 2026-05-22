import { useState, useEffect, useRef, useCallback } from "react";
import { Icon } from "./Icon";

// ─── Types ───

interface TerminalTab {
  id: string;
  name: string;
  projectId: string;
  cwd: string;
}

// ─── Single Terminal Instance ───

function TerminalInstance({ tab, visible }: { tab: TerminalTab; visible: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<any>(null); // xterm Terminal instance
  const wsRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<any>(null);
  const initializedRef = useRef(false);

  useEffect(() => {
    if (!containerRef.current || initializedRef.current) return;
    initializedRef.current = true;

    let destroyed = false;

    // Dynamic imports for xterm — heavy libs, only load when needed
    Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
      import("@xterm/addon-web-links"),
    ]).then(([{ Terminal }, { FitAddon }, { WebLinksAddon }]) => {
      if (destroyed || !containerRef.current) return;

      const term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
        theme: {
          background: "#0d0c0a",
          foreground: "#c8c0b4",
          cursor: "#e2a832",
          cursorAccent: "#0d0c0a",
          selectionBackground: "#e2a83240",
          black: "#1c1a16",
          red: "#c45454",
          green: "#6aab73",
          yellow: "#e2a832",
          blue: "#6a9ec8",
          magenta: "#b07dc8",
          cyan: "#6ab0b8",
          white: "#c8c0b4",
          brightBlack: "#6e685d",
          brightRed: "#e07070",
          brightGreen: "#8cc897",
          brightYellow: "#f0c850",
          brightBlue: "#8abce0",
          brightMagenta: "#c89de0",
          brightCyan: "#8ad0d8",
          brightWhite: "#fcfaf6",
        },
        allowProposedApi: true,
        scrollback: 5000,
      });

      const fitAddon = new FitAddon();
      const webLinksAddon = new WebLinksAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(webLinksAddon);
      term.open(containerRef.current);

      termRef.current = term;
      fitAddonRef.current = fitAddon;

      // Connect to terminal WS
      const protocol = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${protocol}://${location.host}/ws?type=terminal&id=${encodeURIComponent(tab.id)}`);
      wsRef.current = ws;

      ws.onopen = () => {
        // Initial fit after connect
        requestAnimationFrame(() => {
          try { fitAddon.fit(); } catch {}
          const dims = fitAddon.proposeDimensions();
          if (dims && ws.readyState === WebSocket.OPEN) {
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
            ws.close();
          }
        } catch {}
      };

      ws.onclose = () => {
        // Auto-reconnect
        if (!destroyed) {
          setTimeout(() => {
            if (!destroyed && containerRef.current) {
              const newWs = new WebSocket(`${protocol}://${location.host}/ws?type=terminal&id=${encodeURIComponent(tab.id)}`);
              wsRef.current = newWs;
              // Same handlers
              newWs.onopen = ws.onopen;
              newWs.onmessage = ws.onmessage;
              newWs.onclose = ws.onclose;
            }
          }, 2000);
        }
      };

      // Terminal input → WS
      term.onData((data: string) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "term_input", data }));
        }
      });

      // Resize handling
      term.onResize(({ cols, rows }) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "term_resize", cols, rows }));
        }
      });

      // Fit on first render
      requestAnimationFrame(() => {
        try { fitAddon.fit(); } catch {}
      });
    });

    return () => {
      destroyed = true;
      wsRef.current?.close();
      termRef.current?.dispose();
    };
  }, [tab.id]);

  // Fit when visibility changes
  useEffect(() => {
    if (visible && fitAddonRef.current && termRef.current) {
      requestAnimationFrame(() => {
        try { fitAddonRef.current.fit(); } catch {}
      });
    }
  }, [visible]);

  return (
    <div
      ref={containerRef}
      className={`w-full h-full ${visible ? "" : "hidden"}`}
      style={{ padding: "4px 4px 0" }}
    />
  );
}

// ─── Terminal Panel ───

interface TerminalPanelProps {
  projectId: string | null;
  projectPath: string | null;
  visible: boolean;
  onClose: () => void;
}

export function TerminalPanel({ projectId, projectPath, visible, onClose }: TerminalPanelProps) {
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [height, setHeight] = useState(240);
  const [isResizing, setIsResizing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);

  // Load existing terminals for this project
  useEffect(() => {
    if (!projectId || !visible) return;
    fetch(`/api/terminals?projectId=${encodeURIComponent(projectId)}`)
      .then(r => r.json())
      .then(d => {
        const existing: TerminalTab[] = d.terminals || [];
        if (existing.length > 0) {
          setTabs(existing);
          setActiveTabId(existing[0].id);
        }
      })
      .catch(() => {});
  }, [projectId, visible]);

  const addTerminal = useCallback(async () => {
    if (!projectId || !projectPath) return;
    const id = crypto.randomUUID();
    const name = `Terminal ${tabs.length + 1}`;
    try {
      const r = await fetch("/api/terminals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, projectId, cwd: projectPath, name }),
      });
      if (r.ok) {
        const tab: TerminalTab = { id, name, projectId, cwd: projectPath };
        setTabs(prev => [...prev, tab]);
        setActiveTabId(id);
      }
    } catch {}
  }, [projectId, projectPath, tabs.length]);

  const removeTab = useCallback(async (tabId: string) => {
    try { await fetch(`/api/terminals/${tabId}`, { method: "DELETE" }); } catch {}
    setTabs(prev => {
      const next = prev.filter(t => t.id !== tabId);
      if (activeTabId === tabId) {
        setActiveTabId(next.length > 0 ? next[0].id : null);
      }
      return next;
    });
  }, [activeTabId]);

  const renameTab = useCallback((tabId: string, name: string) => {
    setTabs(prev => prev.map(t => t.id === tabId ? { ...t, name } : t));
  }, []);

  // Resize drag handler
  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    startYRef.current = e.clientY;
    startHeightRef.current = height;

    const handleMouseMove = (ev: MouseEvent) => {
      // Dragging UP = increasing height (mouse moves up, clientY decreases)
      const delta = startYRef.current - ev.clientY;
      const newHeight = Math.max(120, Math.min(window.innerHeight * 0.7, startHeightRef.current + delta));
      setHeight(newHeight);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      // Refit xterm after resize
      requestAnimationFrame(() => {
        // Dispatch a resize event so xterm fitAddon picks it up
        window.dispatchEvent(new Event("resize"));
      });
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  }, [height]);

  // Fit xterm on panel height change
  useEffect(() => {
    if (visible) {
      requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    }
  }, [visible, height]);

  if (!visible) return null;

  const activeTab = tabs.find(t => t.id === activeTabId);

  return (
    <div
      ref={panelRef}
      className="flex flex-col bg-ink-950 border-t border-ink-800/60 select-none"
      style={{ height: `${height}px` }}
    >
      {/* ── Resize handle ── */}
      <div
        className="h-1.5 cursor-ns-resize flex items-center justify-center group hover:bg-amber-500/10 transition-theme"
        onMouseDown={handleResizeMouseDown}
      >
        <div className={`w-8 h-0.5 rounded-full transition-theme ${isResizing ? "bg-amber-500" : "bg-ink-700 group-hover:bg-ink-500"}`} />
      </div>

      {/* ── Tab bar ── */}
      <div className="flex items-center gap-0 px-1 border-b border-ink-800/40 min-h-0">
        <div className="flex items-center flex-1 overflow-x-auto custom-scrollbar-x">
          {tabs.map(tab => (
            <TabButton
              key={tab.id}
              tab={tab}
              isActive={tab.id === activeTabId}
              onSelect={() => setActiveTabId(tab.id)}
              onClose={() => removeTab(tab.id)}
              onRename={(name) => renameTab(tab.id, name)}
            />
          ))}
        </div>

        <div className="flex items-center gap-0.5 shrink-0 pl-1">
          <button
            onClick={addTerminal}
            className="p-1.5 text-ink-600 hover:text-amber-500 transition-theme rounded hover:bg-ink-800/50"
            title="New terminal"
            aria-label="New terminal"
          >
            <Icon name="plus" size={12} />
          </button>
          <button
            onClick={onClose}
            className="p-1.5 text-ink-600 hover:text-ink-300 transition-theme rounded hover:bg-ink-800/50"
            title="Close panel"
            aria-label="Close terminal panel"
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      </div>

      {/* ── Terminal content ── */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {tabs.map(tab => (
          <TerminalInstance
            key={tab.id}
            tab={tab}
            visible={tab.id === activeTabId}
          />
        ))}
        {!activeTab && (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <p className="text-ink-600 text-xs font-mono mb-3">No terminals open</p>
              <button
                onClick={addTerminal}
                className="px-3 py-1.5 bg-amber-600/80 hover:bg-amber-500 text-ink-950 text-xs font-medium rounded-md transition-theme"
              >
                Open Terminal
              </button>
            </div>
          </div>
        )}
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
      className={`flex items-center gap-1.5 px-2.5 py-1 text-xs cursor-pointer group transition-theme border-b-2 ${
        isActive
          ? "text-amber-400 bg-ink-900/40 border-b-amber-500"
          : "text-ink-500 hover:text-ink-300 border-b-transparent hover:bg-ink-900/20"
      }`}
      onClick={onSelect}
      onDoubleClick={() => setIsRenaming(true)}
    >
      <Icon name="terminal" size={10} className={isActive ? "text-amber-500" : "text-ink-600"} />
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
          className="bg-ink-900 border border-ink-700 rounded px-1 py-0 text-xs text-ink-200 outline-none focus:border-amber-500/50 w-20"
        />
      ) : (
        <span className="truncate max-w-[100px]">{tab.name}</span>
      )}
      <button
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        className="opacity-0 group-hover:opacity-100 text-ink-600 hover:text-rose-400 transition-all ml-0.5"
        aria-label={`Close ${tab.name}`}
      >
        <Icon name="close" size={8} />
      </button>
    </div>
  );
}
