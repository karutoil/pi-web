import { useState, useEffect, useRef, useCallback } from "react";
import { Icon } from "./Icon";
import { useIsMobile } from "../hooks/useIsMobile";

// ─── Types ───

interface TerminalTab {
  id: string;
  name: string;
  projectId: string;
  cwd: string;
}

// ─── Single Terminal Instance ───
// Only rendered when it's the active tab. xterm needs a real visible container.

function TerminalInstance({ tab }: { tab: TerminalTab }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<any>(null); // xterm Terminal instance
  const wsRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<any>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let destroyed = false;
    let term: any = null;
    let fitAddon: any = null;
    let ws: WebSocket | null = null;

    // Dynamic imports for xterm — heavy libs, only load when needed
    Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
      import("@xterm/addon-web-links"),
    ]).then(([{ Terminal }, { FitAddon }, { WebLinksAddon }]) => {
      if (destroyed || !containerRef.current) return;

      term = new Terminal({
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

      // Connect to terminal WS
      const protocol = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${protocol}://${location.host}/ws?type=terminal&id=${encodeURIComponent(tab.id)}`);
      wsRef.current = ws;

      ws.onopen = () => {
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
        if (!destroyed) {
          setTimeout(() => {
            if (!destroyed && containerRef.current) {
              const newWs = new WebSocket(`${protocol}://${location.host}/ws?type=terminal&id=${encodeURIComponent(tab.id)}`);
              wsRef.current = newWs;
              newWs.onopen = ws!.onopen;
              newWs.onmessage = ws!.onmessage;
              newWs.onclose = ws!.onclose;
            }
          }, 2000);
        }
      };

      // Terminal input → WS
      term.onData((data: string) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "term_input", data }));
        }
      });

      // Resize handling
      term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "term_resize", cols, rows }));
        }
      });
    }); // end Promise.all().then()

    return () => {
      destroyed = true;
      wsRef.current?.close();
      wsRef.current = null;
      if (term) { term.dispose(); }
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, [tab.id]);

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
      className="w-full h-full"
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
  const isMobile = useIsMobile();

  // Mobile: bottom-sheet snap heights as percentage of viewport
  const SNAP_POINTS = [0.3, 0.5, 0.7];
  const [mobileSnap, setMobileSnap] = useState(0.5); // default to 50%
  const mobileDragStart = useRef<{ y: number; snap: number } | null>(null);

  // Mobile touch drag handler for bottom sheet
  const handleMobileTouchStart = useCallback((e: React.TouchEvent) => {
    mobileDragStart.current = { y: e.touches[0].clientY, snap: mobileSnap };
  }, [mobileSnap]);

  const handleMobileTouchMove = useCallback((e: React.TouchEvent) => {
    if (!mobileDragStart.current) return;
    const dy = mobileDragStart.current.y - e.touches[0].clientY;
    const vh = window.innerHeight;
    const deltaSnap = dy / vh;
    setMobileSnap(Math.max(0.2, Math.min(0.85, mobileDragStart.current.snap + deltaSnap)));
  }, []);

  const handleMobileTouchEnd = useCallback(() => {
    if (mobileDragStart.current === null) return;
    // Snap to nearest snap point
    const nearest = SNAP_POINTS.reduce((best, point) =>
      Math.abs(point - mobileSnap) < Math.abs(best - mobileSnap) ? point : best
    );
    // Only snap if close enough, otherwise keep current position
    if (Math.abs(nearest - mobileSnap) < 0.08) {
      setMobileSnap(nearest);
    }
    mobileDragStart.current = null;
  }, [mobileSnap]);

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
      const delta = startYRef.current - ev.clientY;
      const newHeight = Math.max(120, Math.min(window.innerHeight * 0.7, startHeightRef.current + delta));
      setHeight(newHeight);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      // Refit xterm after resize
      requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  }, [height]);

  if (!visible) return null;

  const activeTab = tabs.find(t => t.id === activeTabId);

  return (
    <>
    {/* Mobile: backdrop behind bottom sheet */}
    {isMobile && (
      <div className="fixed inset-0 z-39 bg-ink-950/40" onClick={onClose} />
    )}
    <div
      ref={panelRef}
      className={`flex flex-col bg-ink-950 border-t border-ink-800/60 select-none ${
        isMobile ? "fixed bottom-0 left-0 right-0 z-40 border-t-0 rounded-t-xl" : ""
      }`}
      style={isMobile ? { height: `${mobileSnap * 100}vh` } : { height: `${height}px` }}
    >
      {/* ── Resize handle (desktop: drag, mobile: touch drag bottom sheet) ── */}
      {!isMobile ? (
      <div
        className="h-1.5 cursor-ns-resize flex items-center justify-center group hover:bg-amber-500/10 transition-theme"
        onMouseDown={handleResizeMouseDown}
      >
        <div className={`w-8 h-0.5 rounded-full transition-theme ${isResizing ? "bg-amber-500" : "bg-ink-700 group-hover:bg-ink-500"}`} />
      </div>
      ) : (
      <div
        className="h-8 flex items-center justify-center cursor-grab active:cursor-grabbing touch-none"
        onTouchStart={handleMobileTouchStart}
        onTouchMove={handleMobileTouchMove}
        onTouchEnd={handleMobileTouchEnd}
      >
        <div className="w-10 h-1 rounded-full bg-ink-600" />
      </div>
      )}

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
            className="p-1.5 text-ink-400 hover:text-amber-500 transition-theme rounded hover:bg-ink-800/50"
            title="New terminal"
            aria-label="New terminal"
          >
            <Icon name="plus" size={12} />
          </button>
          <button
            onClick={onClose}
            className="p-1.5 text-ink-400 hover:text-ink-300 transition-theme rounded hover:bg-ink-800/50"
            title="Close panel"
            aria-label="Close terminal panel"
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      </div>

      {/* ── Terminal content ── */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {activeTab && (
          <TerminalInstance key={activeTab.id} tab={activeTab} />
        )}
        {!activeTab && (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <p className="text-ink-500 text-xs font-mono mb-3">No terminals open</p>
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
    </>
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
      <Icon name="terminal" size={10} className={isActive ? "text-amber-500" : "text-ink-500"} />
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
        className="opacity-0 group-hover:opacity-100 sm:opacity-40 sm:group-hover:opacity-100 text-ink-500 hover:text-rose-400 transition-all ml-0.5"
        aria-label={`Close ${tab.name}`}
      >
        <Icon name="close" size={8} />
      </button>
    </div>
  );
}
