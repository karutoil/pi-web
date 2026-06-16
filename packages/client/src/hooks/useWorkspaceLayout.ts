import { useCallback, useEffect, useState } from "react";
import type { WorkspaceLayout, WorkspacePanelKind, WorkspaceRegionId, WorkspaceRegionMode } from "@pi-web/shared";

const REGION_IDS: WorkspaceRegionId[] = ["left", "center", "right", "top", "bottom"];
const PANEL_IDS: WorkspacePanelKind[] = ["channels", "chat", "terminal", "preview", "git", "files", "extensions", "skills", "rail"];

const DEFAULT_REGIONS: WorkspaceLayout["regions"] = [
  { id: "left", size: 352, mode: "split" },
  { id: "center", size: 100, mode: "tabs" },
  { id: "right", size: 420, mode: "tabs" },
  { id: "top", size: 220, mode: "tabs" },
  { id: "bottom", size: 260, mode: "tabs" },
];

const DEFAULT_PANELS: WorkspaceLayout["panels"] = [
  { id: "channels", region: "left", order: 0, size: 100 },
  { id: "chat", region: "center", order: 0, size: 100 },
  { id: "terminal", region: "bottom", order: 0, size: 100 },
  { id: "preview", region: "right", order: 0, size: 100 },
  { id: "git", region: "right", order: 1, size: 100 },
  { id: "files", region: "right", order: 2, size: 100 },
  { id: "extensions", region: "right", order: 3, size: 100 },
  { id: "skills", region: "right", order: 4, size: 100 },
];

type DropPlacement = "tab" | "split-left" | "split-right" | "split-up" | "split-down";

interface MovePanelOptions {
  placement: DropPlacement;
  beforePanelId?: WorkspacePanelKind;
}

export const DEFAULT_WORKSPACE_LAYOUT: WorkspaceLayout = {
  version: 2,
  regions: DEFAULT_REGIONS,
  panels: DEFAULT_PANELS,
  updatedAt: null,
};

function isPanelId(value: unknown): value is WorkspacePanelKind {
  return typeof value === "string" && PANEL_IDS.includes(value as WorkspacePanelKind);
}

function isRegionId(value: unknown): value is WorkspaceRegionId {
  return typeof value === "string" && REGION_IDS.includes(value as WorkspaceRegionId);
}

function normalizeSize(value: unknown, fallback: number, min: number, max: number) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(n, max));
}

function normalizeLayout(value: unknown): WorkspaceLayout {
  const source = value as Partial<WorkspaceLayout> | null;
  const regions = Array.isArray(source?.regions) ? source.regions : DEFAULT_REGIONS;
  const panels = Array.isArray(source?.panels) ? source.panels : DEFAULT_PANELS;
  const seenPanels = new Set<WorkspacePanelKind>();

  const normalizedRegions = REGION_IDS.map((id, index) => {
    const region = regions.find(r => r?.id === id) ?? DEFAULT_REGIONS[index];
    const mode: WorkspaceRegionMode = region?.mode === "split" ? "split" : "tabs";
    return {
      id,
      size: normalizeSize(region?.size, region?.size ?? DEFAULT_REGIONS[index].size, id === "left" || id === "right" ? 0 : 80, id === "left" || id === "right" ? 720 : 520),
      mode,
    };
  });

  const normalizedPanels = panels
    .map((panel, index) => {
      const id = isPanelId(panel?.id) ? panel.id : null;
      if (!id || seenPanels.has(id)) return null;
      seenPanels.add(id);
      return {
        id,
        region: isRegionId(panel?.region) ? panel.region : DEFAULT_PANELS[index]?.region ?? "center",
        order: Number.isFinite(Number(panel?.order)) ? Number(panel.order) : index,
        size: normalizeSize(panel?.size, DEFAULT_PANELS[index]?.size ?? 100, 8, 100),
      };
    })
    .filter((panel): panel is WorkspaceLayout["panels"][number] => panel !== null);

  const hasRail = normalizedPanels.some(panel => panel.id === "rail");
  const hasChannels = normalizedPanels.some(panel => panel.id === "channels");
  if (hasRail && hasChannels) {
    normalizedPanels.splice(0, normalizedPanels.length, ...normalizedPanels.filter(panel => panel.id !== "rail"));
    seenPanels.delete("rail");
  } else if (hasRail && !hasChannels) {
    normalizedPanels.splice(0, normalizedPanels.length, ...normalizedPanels.map(panel => panel.id === "rail" ? { ...panel, id: "channels" as const } : panel));
    seenPanels.delete("rail");
    seenPanels.add("channels");
  }

  for (const panel of DEFAULT_PANELS) {
    if (!seenPanels.has(panel.id)) normalizedPanels.push({ ...panel });
  }

  return {
    version: 2,
    regions: normalizedRegions,
    panels: normalizedPanels,
    updatedAt: typeof source?.updatedAt === "string" ? source.updatedAt : null,
  };
}

export function useWorkspaceLayout() {
  const [layout, setLayout] = useState<WorkspaceLayout>(DEFAULT_WORKSPACE_LAYOUT);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (window as unknown as Record<string, unknown>).__copyLayout = () => {
      console.log(JSON.stringify(layout, null, 2));
    };
  }, [layout]);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/layout");
      if (!r.ok) throw new Error(`Failed to load layout (${r.status})`);
      const d = await r.json();
      setLayout(normalizeLayout(d.layout));
      setError(null);
    } catch (e: any) {
      setError(e.message || "Failed to load layout");
    } finally {
      setLoading(false);
    }
  }, []);

  const save = useCallback(async (next: WorkspaceLayout) => {
    setSaving(true);
    try {
      const r = await fetch("/api/layout", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ layout: next }),
      });
      if (!r.ok) throw new Error(`Failed to save layout (${r.status})`);
      const d = await r.json().catch(() => ({}));
      setLayout(normalizeLayout(d.layout || next));
      setError(null);
    } catch (e: any) {
      setError(e.message || "Failed to save layout");
    } finally {
      setSaving(false);
    }
  }, []);

  const updateLayout = useCallback((updater: (current: WorkspaceLayout) => WorkspaceLayout, persist = true) => {
    setLayout(prev => {
      const next = updater(prev);
      if (persist) save(next);
      return next;
    });
  }, [save]);

  const reset = useCallback(async () => {
    const next = { ...DEFAULT_WORKSPACE_LAYOUT, updatedAt: new Date().toISOString() };
    setLayout(next);
    await save(next);
  }, [save]);

  const movePanel = useCallback((panelId: WorkspacePanelKind, region: WorkspaceRegionId, options?: MovePanelOptions) => {
    updateLayout(prev => {
      const panels = prev.panels.filter(p => p.id !== panelId);
      const existing = prev.panels.find(p => p.id === panelId);
      const moved = existing ? { ...existing, region, order: 0 } : { id: panelId, region, order: 0, size: 100 };
      const nextPanels = [...panels];
      const placement = options?.placement ?? "tab";
      const isSplit = placement !== "tab";
      let targetIndex = -1;

      if (placement === "split-right" || placement === "split-down") {
        const beforeIndex = options?.beforePanelId ? panels.findIndex(p => p.id === options.beforePanelId) : -1;
        targetIndex = beforeIndex >= 0 ? beforeIndex + 1 : nextPanels.length;
      } else if (options?.beforePanelId) {
        targetIndex = panels.findIndex(p => p.id === options.beforePanelId);
      }

      if (targetIndex >= 0) nextPanels.splice(targetIndex, 0, moved);
      else nextPanels.push(moved);

      return {
        ...prev,
        panels: nextPanels.map((panel, index) => ({ ...panel, order: index })),
        regions: prev.regions.map(r => r.id === region ? { ...r, mode: isSplit ? "split" : "tabs" } : r),
        updatedAt: new Date().toISOString(),
      };
    });
  }, [updateLayout]);

  const resizeRegion = useCallback((region: WorkspaceRegionId, size: number, persist = true) => {
    updateLayout(prev => ({
      ...prev,
      regions: prev.regions.map(r => r.id === region ? { ...r, size } : r),
      updatedAt: new Date().toISOString(),
    }), persist);
  }, [updateLayout]);

  const resizePanel = useCallback((panelId: WorkspacePanelKind, size: number, persist = true) => {
    updateLayout(prev => ({
      ...prev,
      panels: prev.panels.map(p => p.id === panelId ? { ...p, size } : p),
      updatedAt: new Date().toISOString(),
    }), persist);
  }, [updateLayout]);

  const setRegionMode = useCallback((region: WorkspaceRegionId, mode: WorkspaceRegionMode) => {
    updateLayout(prev => ({
      ...prev,
      regions: prev.regions.map(r => r.id === region ? { ...r, mode } : r),
      updatedAt: new Date().toISOString(),
    }));
  }, [updateLayout]);

  useEffect(() => {
    load();
  }, [load]);

  return {
    layout,
    loading,
    saving,
    error,
    movePanel,
    resizeRegion,
    resizePanel,
    setRegionMode,
    reset,
    save,
  };
}
