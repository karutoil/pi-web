import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import type { WorkspaceLayout, WorkspacePanelKind, WorkspaceRegionId, WorkspaceRegionMode } from "@pi-web/shared";
import { Icon } from "./Icon";

interface WorkspacePanelConfig {
  id: WorkspacePanelKind;
  title: string;
  icon: ReactNode;
  children: ReactNode;
  minRegionSize?: number;
  onClose?: () => void;
}

type DropPlacement = "tab" | "split-left" | "split-right" | "split-up" | "split-down";

interface MovePanelOptions {
  placement: DropPlacement;
  beforePanelId?: WorkspacePanelKind;
}

interface WorkspaceDockProps {
  layout: WorkspaceLayout;
  panels: WorkspacePanelConfig[];
  onMovePanel: (panelId: WorkspacePanelKind, region: WorkspaceRegionId, options?: MovePanelOptions) => void;
  onResizeRegion: (region: WorkspaceRegionId, size: number, persist?: boolean) => void;
  onResizePanel: (panelId: WorkspacePanelKind, size: number, persist?: boolean) => void;
  onReset: () => void;
  closedPanels?: WorkspacePanelConfig[];
  onReopenPanel?: (panelId: WorkspacePanelKind) => void;
  saving: boolean;
  error: string | null;
}

const REGION_IDS: WorkspaceRegionId[] = ["left", "center", "right", "top", "bottom"];

const DEFAULT_REGION_SIZES: Record<WorkspaceRegionId, number> = {
  left: 352,
  right: 420,
  top: 220,
  bottom: 260,
  center: 100,
};

const REGION_LIMITS: Record<WorkspaceRegionId, { min: number; max: number; axis: "x" | "y" }> = {
  left: { min: 0, max: 720, axis: "x" },
  right: { min: 0, max: 720, axis: "x" },
  top: { min: 0, max: 520, axis: "y" },
  bottom: { min: 0, max: 520, axis: "y" },
  center: { min: 80, max: 100, axis: "y" },
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function regionSizeValue(layout: WorkspaceLayout, region: WorkspaceRegionId) {
  return layout.regions.find(r => r.id === region)?.size ?? 0;
}

function splitPanels(panels: WorkspaceLayout["panels"]) {
  return panels
    .map(panel => ({ panel, sort: panel.order ?? 0 }))
    .sort((a, b) => a.sort - b.sort)
    .map(item => item.panel);
}

function resolveDropPlacement(event: DragEvent, target: DOMRect): DropPlacement {
  const centerX = target.left + target.width / 2;
  const centerY = target.top + target.height / 2;
  const nx = (event.clientX - centerX) / Math.max(target.width / 2, 1);
  const ny = (event.clientY - centerY) / Math.max(target.height / 2, 1);
  const centerThreshold = 0.42;

  if (Math.max(Math.abs(nx), Math.abs(ny)) < centerThreshold) return "tab";
  if (Math.abs(nx) >= Math.abs(ny)) return nx < 0 ? "split-left" : "split-right";
  return ny < 0 ? "split-up" : "split-down";
}

function beforePanelForPlacement(placement: DropPlacement, panels: WorkspaceLayout["panels"]) {
  if (placement === "split-left" || placement === "split-up") return panels[0]?.id;
  if (placement === "split-right" || placement === "split-down") return panels[panels.length - 1]?.id;
  return undefined;
}

function isSide(region: WorkspaceRegionId) {
  return region === "left" || region === "right";
}

function splitAxis(region: WorkspaceRegionId) {
  return region === "top" || region === "bottom" ? "row" : "column";
}

function closedPanelEdge(panelId: WorkspacePanelKind): WorkspaceRegionId | null {
  if (panelId === "channels") return "left";
  if (panelId === "preview" || panelId === "git") return "right";
  if (panelId === "terminal") return "bottom";
  return null;
}

function closedPanelIcon(panelId: WorkspacePanelKind) {
  if (panelId === "channels") return "chevron-right";
  if (panelId === "terminal") return "chevron-down";
  return "chevron-left";
}

function dropRegionSize(region: WorkspaceRegionId) {
  if (region === "left" || region === "right") return 280;
  if (region === "top" || region === "bottom") return 180;
  return 100;
}

export function WorkspaceDock({ layout, panels, onMovePanel, onResizeRegion, onResizePanel, onReset, closedPanels = [], onReopenPanel, saving, error }: WorkspaceDockProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const resizeValueRef = useRef<number | null>(null);
  const panelConfigById = useMemo(() => new Map(panels.map(panel => [panel.id, panel])), [panels]);
  const [draggingPanel, setDraggingPanel] = useState<WorkspacePanelKind | null>(null);
  const [dropTarget, setDropTarget] = useState<{ region: WorkspaceRegionId; beforePanelId?: WorkspacePanelKind; placement: DropPlacement } | null>(null);
  const [resizingRegion, setResizingRegion] = useState<WorkspaceRegionId | null>(null);
  const [resizingPanel, setResizingPanel] = useState<{ panelId: WorkspacePanelKind; startSize: number } | null>(null);

  const regionMode = useCallback((region: WorkspaceRegionId) => layout.regions.find(r => r.id === region)?.mode ?? "tabs", [layout]);
  const panelsByRegion = useMemo(() => {
    const map = new Map<WorkspaceRegionId, WorkspaceLayout["panels"]>();
    for (const region of ["left", "center", "right", "top", "bottom"] as WorkspaceRegionId[]) {
      map.set(region, splitPanels(layout.panels.filter(panel => panel.region === region)));
    }
    return map;
  }, [layout.panels]);

  const handleDragStart = useCallback((panelId: WorkspacePanelKind) => (event: DragEvent) => {
    dragStartRef.current = { x: event.clientX, y: event.clientY };
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", panelId);
    }
    requestAnimationFrame(() => setDraggingPanel(panelId));
  }, []);

  const handleRegionDragOver = useCallback((region: WorkspaceRegionId, panels: WorkspaceLayout["panels"]) => (event: DragEvent) => {
    if (!draggingPanel) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const placement = resolveDropPlacement(event, event.currentTarget.getBoundingClientRect());
    setDropTarget({ region, beforePanelId: beforePanelForPlacement(placement, panels), placement });
  }, [draggingPanel]);

  const handleRegionDrop = useCallback((region: WorkspaceRegionId) => (event: DragEvent) => {
    event.preventDefault();
    if (!draggingPanel) return;
    const options = dropTarget && dropTarget.region === region
      ? { placement: dropTarget.placement, beforePanelId: dropTarget.beforePanelId }
      : { placement: "tab" as const };
    onMovePanel(draggingPanel, region, options);
    setDraggingPanel(null);
    setDropTarget(null);
    dragStartRef.current = null;
  }, [draggingPanel, dropTarget, onMovePanel]);

  const handlePanelDragOver = useCallback((region: WorkspaceRegionId, beforePanelId?: WorkspacePanelKind) => (event: DragEvent) => {
    if (!draggingPanel) return;
    event.preventDefault();
    const placement = resolveDropPlacement(event, event.currentTarget.getBoundingClientRect());
    setDropTarget({ region, beforePanelId, placement });
  }, [draggingPanel]);

  const handleDragEnd = useCallback(() => {
    setDraggingPanel(null);
    setDropTarget(null);
    dragStartRef.current = null;
  }, []);

  const startRegionResize = useCallback((region: WorkspaceRegionId) => (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const limits = REGION_LIMITS[region];
    const axis = limits.axis;
    const start = axis === "x" ? event.clientX : event.clientY;
    const startSize = regionSizeValue(layout, region);
    resizeValueRef.current = startSize;
    setResizingRegion(region);

    const move = (moveEvent: MouseEvent) => {
      const current = axis === "x" ? moveEvent.clientX : moveEvent.clientY;
      const delta = region === "right" || region === "bottom" ? start - current : current - start;
      const nextSize = clamp(startSize + delta, limits.min, limits.max);
      resizeValueRef.current = nextSize;
      onResizeRegion(region, nextSize, false);
    };

    const up = () => {
      setResizingRegion(null);
      onResizeRegion(region, resizeValueRef.current ?? regionSizeValue(layout, region), true);
      resizeValueRef.current = null;
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };

    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }, [layout, onResizeRegion]);

  const resetRegionSize = useCallback((region: WorkspaceRegionId) => (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onResizeRegion(region, DEFAULT_REGION_SIZES[region], true);
  }, [onResizeRegion]);

  const startPanelResize = useCallback((panelId: WorkspacePanelKind, startSize: number) => (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    resizeValueRef.current = startSize;
    setResizingPanel({ panelId, startSize });

    const move = (moveEvent: MouseEvent) => {
      const delta = ((moveEvent.movementY || moveEvent.movementX) / Math.max(containerRef.current?.getBoundingClientRect().height || 1, 1)) * 100;
      const nextSize = clamp(startSize + delta, 8, 100);
      resizeValueRef.current = nextSize;
      onResizePanel(panelId, nextSize, false);
    };

    const up = () => {
      setResizingPanel(null);
      onResizePanel(panelId, resizeValueRef.current ?? startSize, true);
      resizeValueRef.current = null;
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };

    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }, [onResizePanel]);

  const regionHasPanels = (region: WorkspaceRegionId) => (panelsByRegion.get(region) ?? []).some(panel => panelConfigById.has(panel.id));
  const activeRegionSize = (region: WorkspaceRegionId) => !regionHasPanels(region) ? (draggingPanel ? dropRegionSize(region) : 0) : regionSizeValue(layout, region);
  const gridTemplateColumns = `${activeRegionSize("left")}px minmax(0, 1fr) ${activeRegionSize("right")}px`;
  const gridTemplateRows = `${activeRegionSize("top")}px minmax(0, 1fr) ${activeRegionSize("bottom")}px`;
  const renderedRegionIds = REGION_IDS.filter(region => draggingPanel || regionHasPanels(region) || region === "center");

  return (
    <div ref={containerRef} className="relative flex-1 min-w-0 min-h-0 overflow-hidden bg-ink-950/20">
      {error && (
        <div className="absolute left-1/2 top-3 -translate-x-1/2 z-30 px-3 py-1.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-400 text-[0.65rem] font-mono">
          {error}
        </div>
      )}
      <div
        className={["grid min-w-0 min-h-0 h-full", draggingPanel ? "gap-px bg-ink-800/40" : ""].join(" ")}
        style={{ gridTemplateColumns, gridTemplateRows, gridTemplateAreas: `"left top right" "left center right" "left bottom right"` }}
      >
        {renderedRegionIds.map(region => (
          <RegionDock
            key={region}
            region={region}
            panels={panelsByRegion.get(region) ?? []}
            mode={regionMode(region)}
            panelConfigById={panelConfigById}
            draggingPanel={draggingPanel}
            dropTarget={dropTarget}
            resizingRegion={resizingRegion}
            resizingPanel={resizingPanel}
            onDragStart={handleDragStart}
            onRegionDragOver={handleRegionDragOver}
            onRegionDrop={handleRegionDrop}
            onPanelDragOver={handlePanelDragOver}
            onDragEnd={handleDragEnd}
            onMovePanel={onMovePanel}
            onResizeRegion={onResizeRegion}
            onResizePanel={onResizePanel}
            onReset={onReset}
            onRegionResizeMouseDown={startRegionResize}
            onRegionResizeDoubleClick={resetRegionSize}
            onPanelResizeMouseDown={startPanelResize}
            saving={saving}
          />
        ))}
      </div>
      {closedPanels.map(panel => {
        const edge = closedPanelEdge(panel.id);
        if (!edge) return null;
        const classes = edge === "left"
          ? "left-2 top-1/2 -translate-y-1/2"
          : edge === "right"
            ? "right-2 top-1/2 -translate-y-1/2"
            : "left-1/2 bottom-2 -translate-x-1/2";
        return (
          <button
            key={panel.id}
            onClick={() => onReopenPanel?.(panel.id)}
            className={`absolute z-30 ${classes} rounded-full bg-ink-900/90 border border-ink-700/70 text-ink-300 hover:text-amber-500 hover:border-amber-500/50 shadow-lg shadow-ink-950/60 p-1.5 transition-theme`}
            title={`Reopen ${panel.title}`}
            aria-label={`Reopen ${panel.title}`}
          >
            <Icon name={closedPanelIcon(panel.id)} size={12} />
          </button>
        );
      })}
    </div>
  );
}

function RegionDock({ region, panels, mode, panelConfigById, draggingPanel, dropTarget, resizingRegion, resizingPanel, onDragStart, onRegionDragOver, onRegionDrop, onPanelDragOver, onDragEnd, onMovePanel, onResizeRegion, onResizePanel, onReset, onRegionResizeMouseDown, onRegionResizeDoubleClick, onPanelResizeMouseDown, saving }: {
  region: WorkspaceRegionId;
  panels: WorkspaceLayout["panels"];
  mode: WorkspaceRegionMode;
  panelConfigById: Map<WorkspacePanelKind, WorkspacePanelConfig>;
  draggingPanel: WorkspacePanelKind | null;
  dropTarget: { region: WorkspaceRegionId; beforePanelId?: WorkspacePanelKind; placement: DropPlacement } | null;
  resizingRegion: WorkspaceRegionId | null;
  resizingPanel: { panelId: WorkspacePanelKind; startSize: number } | null;
  onDragStart: (panelId: WorkspacePanelKind) => (event: DragEvent) => void;
  onRegionDragOver: (region: WorkspaceRegionId, panels: WorkspaceLayout["panels"]) => (event: DragEvent) => void;
  onRegionDrop: (region: WorkspaceRegionId) => (event: DragEvent) => void;
  onPanelDragOver: (region: WorkspaceRegionId, beforePanelId?: WorkspacePanelKind) => (event: DragEvent) => void;
  onDragEnd: () => void;
  onMovePanel: (panelId: WorkspacePanelKind, region: WorkspaceRegionId, options?: MovePanelOptions) => void;
  onResizeRegion: (region: WorkspaceRegionId, size: number, persist?: boolean) => void;
  onResizePanel: (panelId: WorkspacePanelKind, size: number, persist?: boolean) => void;
  onReset: () => void;
  onRegionResizeMouseDown: (region: WorkspaceRegionId) => (event: ReactMouseEvent) => void;
  onRegionResizeDoubleClick: (region: WorkspaceRegionId) => (event: ReactMouseEvent) => void;
  onPanelResizeMouseDown: (panelId: WorkspacePanelKind, startSize: number) => (event: ReactMouseEvent) => void;
  saving: boolean;
}) {
  const limits = REGION_LIMITS[region];
  const configuredPanels = panels.map(panel => ({ layout: panel, config: panelConfigById.get(panel.id) })).filter((item): item is { layout: WorkspaceLayout["panels"][number]; config: WorkspacePanelConfig } => !!item.config);
  const isRegionDrop = dropTarget?.region === region;
  const activePanelId = configuredPanels[0]?.layout.id;
  const [activeTab, setActiveTab] = useState(activePanelId ?? null);
  useEffect(() => {
    if (!configuredPanels.some(panel => panel.layout.id === activeTab)) {
      setActiveTab(activePanelId ?? null);
    }
  }, [activePanelId, activeTab, configuredPanels]);

  const renderPanel = (panel: WorkspaceLayout["panels"][number], index: number, count: number) => {
    const config = panelConfigById.get(panel.id)!;
    const selected = mode === "tabs" ? activeTab === panel.id : true;
    const isDrop = dropTarget?.region === region && (dropTarget.placement === "tab" || dropTarget.beforePanelId === panel.id);
    return (
      <section
        key={panel.id}
        onDragOver={onPanelDragOver(region, panel.id)}
        onDrop={onRegionDrop(region)}
        onDragEnd={onDragEnd}
        className={[
          "relative flex flex-col min-w-0 min-h-0 h-full max-w-full max-h-full overflow-hidden bg-ink-900/35",
          draggingPanel === panel.id ? "opacity-45" : "",
          isDrop ? "ring-2 ring-amber-500/60 ring-inset z-20" : "",
          selected ? "" : "hidden",
        ].join(" ")}
        style={mode === "split" ? {
          flex: `${panel.size} 1 0%`,
          ...(index < count - 1 && splitAxis(region) === "column" ? { minHeight: 80 } : {}),
          ...(index < count - 1 && splitAxis(region) === "row" ? { minWidth: 120 } : {}),
        } : undefined}
      >
        <RegionHeader
          region={region}
          panel={config}
          active={selected}
          saving={saving}
          onReset={onReset}
          onDragStart={onDragStart}
        />
        <div className="flex-1 min-h-0 min-w-0 h-full overflow-hidden">{config.children}</div>
        {mode === "split" && index < count - 1 && (
          <div
            onMouseDown={onPanelResizeMouseDown(panel.id, panel.size)}
            onDoubleClick={() => configuredPanels.forEach(item => onResizePanel(item.layout.id, 100 / configuredPanels.length, true))}
            className={[
              splitAxis(region) === "column" ? "absolute left-0 right-0 bottom-0 h-1.5 cursor-row-resize" : "absolute top-0 bottom-0 right-0 w-1.5 cursor-col-resize",
              resizingPanel?.panelId === panel.id ? "bg-amber-500/40" : "hover:bg-amber-500/20",
            ].join(" ")}
            title="Drag to resize split"
          />
        )}
      </section>
    );
  };

  return (
    <div
      data-region={region}
      onDragOver={onRegionDragOver(region, panels)}
      onDrop={onRegionDrop(region)}
      className={[
        "relative min-w-0 min-h-0 h-full overflow-hidden bg-ink-950/10",
        isRegionDrop ? "ring-2 ring-inset ring-amber-500/50" : "",
      ].join(" ")}
      style={{ gridArea: region }}
    >
      {mode === "tabs" ? (
        <div className="flex flex-col min-w-0 min-h-0 h-full">
          <div className="flex items-center gap-1 h-9 shrink-0 border-b border-ink-800/50 bg-ink-950/40 px-1 overflow-x-auto custom-scrollbar-x">
            {configuredPanels.map(({ layout }, index) => (
              <button
                key={layout.id}
                draggable
                onDragStart={onDragStart(layout.id)}
                onDragOver={onPanelDragOver(region, layout.id)}
                onDrop={onRegionDrop(region)}
                onDragEnd={onDragEnd}
                onClick={() => setActiveTab(layout.id)}
                className={[
                  "flex items-center gap-1.5 shrink-0 px-2.5 py-1 rounded-md text-[0.65rem] font-mono uppercase tracking-[0.12em] transition-theme",
                  activeTab === layout.id ? "bg-ink-800/80 text-amber-500" : "text-ink-500 hover:text-ink-200 hover:bg-ink-800/40",
                ].join(" ")}
              >
                <span className="shrink-0">{panelConfigById.get(layout.id)?.icon}</span>
                {panelConfigById.get(layout.id)?.title}
              </button>
            ))}
            <div className="flex-1" />
          </div>
          <div className="flex-1 min-h-0 min-w-0 h-full overflow-hidden">
            {configuredPanels.map(({ layout }) => layout.id === activeTab ? renderPanel(layout, 0, configuredPanels.length) : null)}
          </div>
        </div>
      ) : (
        <div
          className="flex min-w-0 min-h-0 h-full"
          style={{ flexDirection: splitAxis(region) === "column" ? "column" : "row" }}
        >
          {configuredPanels.map((item, index) => renderPanel(item.layout, index, configuredPanels.length))}
          {configuredPanels.length === 0 && (
            <div className="flex-1 flex items-center justify-center text-ink-600 text-[0.65rem] font-mono">Drop a panel here</div>
          )}
        </div>
      )}

      {isSide(region) && (
        <div
          onMouseDown={onRegionResizeMouseDown(region)}
          onDoubleClick={onRegionResizeDoubleClick(region)}
          className={[
            region === "left" ? "absolute top-0 right-0 bottom-0 w-1.5 cursor-col-resize" : "absolute top-0 left-0 bottom-0 w-1.5 cursor-col-resize",
            resizingRegion === region ? "bg-amber-500/40" : "hover:bg-amber-500/20",
          ].join(" ")}
          title="Drag to resize region"
        />
      )}
      {!isSide(region) && region !== "center" && (
        <div
          onMouseDown={onRegionResizeMouseDown(region)}
          onDoubleClick={onRegionResizeDoubleClick(region)}
          className={[
            region === "top" ? "absolute left-0 right-0 bottom-0 h-1.5 cursor-row-resize" : "absolute left-0 right-0 top-0 h-1.5 cursor-row-resize",
            resizingRegion === region ? "bg-amber-500/40" : "hover:bg-amber-500/20",
          ].join(" ")}
          title="Drag to resize region"
        />
      )}
    </div>
  );
}

function RegionHeader({ region, panel, active, saving, onReset, onDragStart }: {
  region: WorkspaceRegionId;
  panel: WorkspacePanelConfig;
  active: boolean;
  saving: boolean;
  onReset: () => void;
  onDragStart: (panelId: WorkspacePanelKind) => (event: DragEvent) => void;
}) {
  return (
    <header className="h-9 shrink-0 flex items-center gap-1.5 px-2 border-b border-ink-800/50 bg-ink-950/40 select-none cursor-grab active:cursor-grabbing">
      <button draggable onDragStart={onDragStart(panel.id)} className="p-1 rounded text-ink-500 hover:text-amber-500 hover:bg-ink-800/50" aria-label={`Move ${panel.title}`}>
        <Icon name="grip" size={10} />
      </button>
      <span className="text-ink-400 shrink-0">{panel.icon}</span>
      <span className="text-ink-300 text-[0.68rem] font-mono uppercase tracking-[0.14em] truncate flex-1">{panel.title}</span>
      {region === "center" && active && (
        <button onClick={onReset} disabled={saving} className="px-2 py-1 rounded text-[0.6rem] font-mono text-ink-500 hover:text-amber-500 hover:bg-ink-800/50 disabled:opacity-50">Reset</button>
      )}
      {panel.onClose && active && (
        <button onClick={panel.onClose} className="p-1 rounded text-ink-500 hover:text-rose-400 hover:bg-rose-400/10 touch-target-sm" aria-label={`Close ${panel.title}`} title={`Close ${panel.title}`}>
          <Icon name="close" size={10} />
        </button>
      )}
    </header>
  );
}
