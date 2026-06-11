import { useState, useEffect, useRef, type ReactNode } from "react";
import type { WorkspacePanelKind } from "@pi-web/shared";
import type { WorkspacePanelConfig } from "./WorkspaceDock";
import { Icon } from "./Icon";

interface MobileShellProps {
  panels: WorkspacePanelConfig[];
  closedPanels: WorkspacePanelConfig[];
  activePanelId: WorkspacePanelKind;
  onActivatePanel: (id: WorkspacePanelKind) => void;
  onReopenPanel: (id: WorkspacePanelKind) => void;
}

export function MobileShell({
  panels,
  closedPanels,
  activePanelId,
  onActivatePanel,
  onReopenPanel,
}: MobileShellProps) {
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!overflowOpen) return;
    const handler = (e: MouseEvent) => {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
        setOverflowOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [overflowOpen]);

  const activePanel = panels.find((p) => p.id === activePanelId) || panels[0];

  return (
    <div className="flex flex-col h-full w-full overflow-hidden bg-ink-950">
      {/* Viewport: all panels rendered, only active is visible */}
      <div className="relative flex-1 min-h-0 overflow-hidden mobile-safe-top">
        {panels.map((panel) => {
          const isActive = panel.id === (activePanel?.id ?? activePanelId);
          return (
          <div
            key={panel.id}
            className={`absolute inset-0 flex-col ${
              isActive ? "flex" : "hidden"
            }`}
          >
            {/* Generic top frame — skip when panel supplies its own header or is chat */}
            {!panel.header && panel.id !== "chat" && (
            <div className="shrink-0 flex items-center gap-2 px-3 h-12 border-b border-ink-800">
              <span className="text-amber-500">{panel.icon}</span>
              <span className="flex-1 truncate text-sm text-ink-100">
                {panel.title}
              </span>
              {panel.onClose && (
                <button
                  onClick={panel.onClose}
                  className="p-1 rounded-md hover:bg-ink-800 text-ink-400"
                  aria-label={`Close ${panel.title}`}
                  title={`Close ${panel.title}`}
                >
                  <Icon name="close" size={14} />
                </button>
              )}
            </div>
            )}
            {/* Panel-specific header (e.g. Terminal tabs) */}
            {panel.header && <div className="shrink-0">{panel.header}</div>}
            {/* Close button when panel has own header but also has onClose */}
            {panel.header && panel.onClose && (
              <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-ink-800">
                <button
                  onClick={panel.onClose}
                  className="p-1 rounded-md hover:bg-ink-800 text-ink-400 text-xs font-mono flex items-center gap-1"
                  aria-label={`Close ${panel.title}`}
                  title={`Close ${panel.title}`}
                >
                  <Icon name="close" size={12} />
                  Close
                </button>
              </div>
            )}
            {/* Panel content */}
            <div className="flex-1 min-h-0 overflow-hidden">{panel.children}</div>
          </div>
          );
        })}
      </div>

      {/* Bottom tab bar */}
      <div
        className="shrink-0 h-14 flex items-center justify-around border-t border-ink-800 bg-ink-950"
        style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
      >
        {panels.map((panel) => {
          const isActive = panel.id === (activePanel?.id ?? activePanelId);
          return (
            <button
              key={panel.id}
              onClick={() => onActivatePanel(panel.id)}
              className={`flex flex-col items-center justify-center gap-0.5 w-14 h-14 ${
                isActive ? "text-amber-500" : "text-ink-400"
              }`}
              aria-label={panel.title}
              aria-pressed={isActive}
            >
              <span className="scale-90">{panel.icon}</span>
              <span className="text-[0.65rem] leading-none">{panel.title}</span>
            </button>
          );
        })}

        {/* Overflow + for closed panels */}
        {closedPanels.length > 0 && (
          <div ref={overflowRef} className="relative">
            <button
              onClick={() => setOverflowOpen((v) => !v)}
              className={`flex flex-col items-center justify-center gap-0.5 w-14 h-14 ${
                overflowOpen ? "text-amber-500" : "text-ink-400"
              }`}
              aria-label="Reopen closed panel"
              aria-expanded={overflowOpen}
            >
              <Icon name="plus" size={14} />
              <span className="text-[0.65rem] leading-none">More</span>
            </button>
            {overflowOpen && (
              <div className="absolute bottom-full right-0 mb-1 z-50 min-w-[10rem] border border-ink-700 rounded-lg bg-ink-900 shadow-xl overflow-hidden">
                {closedPanels.map((panel) => (
                  <button
                    key={panel.id}
                    onClick={() => {
                      onReopenPanel(panel.id);
                      onActivatePanel(panel.id);
                      setOverflowOpen(false);
                    }}
                    className="flex items-center gap-2 w-full px-3 py-2.5 text-left text-sm text-ink-200 hover:bg-ink-800 hover:text-amber-500 transition-colors"
                  >
                    <span className="scale-90">{panel.icon}</span>
                    <span>{panel.title}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
