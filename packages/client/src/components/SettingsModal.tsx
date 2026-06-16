import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon, type IconName } from "./Icon";
import { useTheme, type Theme } from "../hooks/useTheme";

// ─── PI Web settings ───

interface PiWebSettings {
  theme: Theme;
  previewWidth: number;
  filesExplorerWidth: number;
}

const PI_WEB_KEYS = ["pi-web-theme", "pi-preview-width", "files-panel-explorer-width"];

function loadPiWebSettings(): PiWebSettings {
  let theme: Theme = "light";
  try {
    const v = localStorage.getItem("pi-web-theme");
    if (v === "dark" || v === "light") theme = v;
  } catch {}
  let previewWidth = 480;
  try {
    const v = localStorage.getItem("pi-preview-width");
    const n = v ? parseInt(v, 10) : NaN;
    if (!isNaN(n)) previewWidth = Math.max(320, Math.min(n, Math.floor(window.innerWidth * 0.7)));
  } catch {}
  let filesExplorerWidth = 240;
  try {
    const v = localStorage.getItem("files-panel-explorer-width");
    const n = v ? parseInt(v, 10) : NaN;
    if (!isNaN(n)) filesExplorerWidth = Math.max(120, Math.min(n, 600));
  } catch {}
  return { theme, previewWidth, filesExplorerWidth };
}

function savePiWebKey(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch {}
}

// ─── PI config API ───

interface PiPackageEntry {
  source: string;
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
}

type PiSettings = Record<string, unknown> & {
  theme?: string;
  lastChangelogVersion?: string;
  packages?: (string | PiPackageEntry)[];
  defaultProvider?: string;
  defaultModel?: string;
  retry?: { enabled?: boolean };
  defaultThinkingLevel?: string;
  subagents?: { agentOverrides?: Record<string, { model?: string }> };
  compaction?: { enabled?: boolean };
  extensions?: string[];
  skills?: string[];
};

async function fetchPiConfig(file: "settings" | "models"): Promise<string> {
  const r = await fetch(`/api/pi-config/${file}`);
  if (!r.ok) throw new Error(`Failed to load PI ${file} config (${r.status})`);
  const d = await r.json();
  return typeof d.content === "string" ? d.content : "{}";
}

async function savePiConfig(file: "settings" | "models", content: string): Promise<void> {
  const r = await fetch(`/api/pi-config/${file}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(d.error || `Failed to save PI ${file} config (${r.status})`);
  }
}

// ─── Helpers ───

function parseSettings(raw: string): PiSettings {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as PiSettings) : {};
  } catch {
    return {};
  }
}

function formatJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function splitTags(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map(s => s.trim())
    .filter(Boolean);
}

function joinTags(values?: string[]): string {
  return (values || []).join(", ");
}

function normalizeEnabledFlag(value: string, enabled: boolean): string {
  const clean = value.replace(/^[+-]/, "");
  return enabled ? (clean.startsWith("+") ? clean : clean) : `-${clean}`;
}

function parseEnabledEntry(value: string): { path: string; enabled: boolean } {
  const enabled = !value.startsWith("-");
  const path = value.replace(/^[+-]/, "");
  return { path, enabled };
}

// ─── Shared UI primitives ───

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="space-y-1">
      <div className="text-ink-200 text-xs font-medium">{label}</div>
      {children}
      {hint && <div className="text-ink-600 text-[0.65rem]">{hint}</div>}
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <label className="inline-flex items-center gap-2 cursor-pointer">
      <span
        className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${checked ? "bg-amber-600" : "bg-ink-700"}`}
      >
        <input
          type="checkbox"
          className="peer sr-only"
          checked={checked}
          onChange={e => onChange(e.target.checked)}
        />
        <span className={`inline-block h-3 w-3 rounded-full bg-ink-100 transition-transform ${checked ? "translate-x-3.5" : "translate-x-0.5"}`} />
      </span>
      {label && <span className="text-ink-300 text-xs select-none">{label}</span>}
    </label>
  );
}

function TextInput({ value, onChange, placeholder = "", type = "text" }: { value: string; onChange: (v: string) => void; placeholder?: string; type?: string }) {
  return (
    <input
      type={type}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      className="modal-field w-full text-xs"
      spellCheck={false}
    />
  );
}

function Select({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="modal-field w-full text-xs"
    >
      {options.map(o => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

function Textarea({ value, onChange, placeholder = "", rows = 2 }: { value: string; onChange: (v: string) => void; placeholder?: string; rows?: number }) {
  return (
    <textarea
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      spellCheck={false}
      className="modal-field w-full text-xs font-mono resize-y min-h-[2.5rem]"
    />
  );
}

function IconButton({ icon, onClick, title, danger }: { icon: IconName; onClick: () => void; title: string; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={`p-1 rounded hover:bg-ink-800/60 transition-colors ${danger ? "text-red-400 hover:text-red-300" : "text-ink-500 hover:text-ink-300"}`}
    >
      <Icon name={icon} size={12} />
    </button>
  );
}

// ─── List editors ───

interface PackageForm {
  source: string;
  extensions: string;
  skills: string;
  prompts: string;
  themes: string;
}

function packageToForm(p: string | PiPackageEntry): PackageForm {
  if (typeof p === "string") {
    return { source: p, extensions: "", skills: "", prompts: "", themes: "" };
  }
  return {
    source: p.source,
    extensions: joinTags(p.extensions),
    skills: joinTags(p.skills),
    prompts: joinTags(p.prompts),
    themes: joinTags(p.themes),
  };
}

function formToPackage(f: PackageForm): string | PiPackageEntry {
  const extensions = splitTags(f.extensions);
  const skills = splitTags(f.skills);
  const prompts = splitTags(f.prompts);
  const themes = splitTags(f.themes);
  const hasFilters = extensions.length || skills.length || prompts.length || themes.length;
  if (!hasFilters) return f.source;
  return {
    source: f.source,
    ...(extensions.length ? { extensions } : {}),
    ...(skills.length ? { skills } : {}),
    ...(prompts.length ? { prompts } : {}),
    ...(themes.length ? { themes } : {}),
  };
}

function PackagesEditor({ value, onChange }: { value: PackageForm[]; onChange: (v: PackageForm[]) => void }) {
  const add = () => onChange([...value, { source: "", extensions: "", skills: "", prompts: "", themes: "" }]);
  const remove = (i: number) => onChange(value.filter((_, idx) => idx !== i));
  const update = (i: number, patch: Partial<PackageForm>) => {
    onChange(value.map((p, idx) => idx === i ? { ...p, ...patch } : p));
  };
  return (
    <div className="space-y-2">
      {value.map((pkg, i) => (
        <div key={i} className="rounded-md border border-ink-800/40 bg-ink-900/30 p-3 space-y-2">
          <div className="flex items-center gap-2">
            <TextInput value={pkg.source} onChange={v => update(i, { source: v })} placeholder="npm:package-name" />
            <IconButton icon="trash" onClick={() => remove(i)} title="Remove package" danger />
          </div>
          <Textarea value={pkg.extensions} onChange={v => update(i, { extensions: v })} placeholder="Extensions, comma or newline separated" />
          <div className="grid grid-cols-2 gap-2">
            <Textarea value={pkg.skills} onChange={v => update(i, { skills: v })} placeholder="Skills" />
            <Textarea value={pkg.prompts} onChange={v => update(i, { prompts: v })} placeholder="Prompts" />
          </div>
          <Textarea value={pkg.themes} onChange={v => update(i, { themes: v })} placeholder="Themes" />
        </div>
      ))}
      <button type="button" onClick={add} className="modal-button modal-button--ghost text-xs w-full flex items-center justify-center gap-1.5">
        <Icon name="plus" size={10} />
        Add package
      </button>
    </div>
  );
}

function EnabledStringList({ values, onChange, placeholder }: { values: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const entries = values.map(parseEnabledEntry);
  const update = (i: number, patch: Partial<{ path: string; enabled: boolean }>) => {
    const next = entries.map((e, idx) => idx === i ? { ...e, ...patch } : e);
    onChange(next.map(e => normalizeEnabledFlag(e.path, e.enabled)));
  };
  const add = () => onChange([...values, `-`]); // empty disabled entry
  const remove = (i: number) => onChange(values.filter((_, idx) => idx !== i));
  return (
    <div className="space-y-1.5">
      {entries.map((e, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            type="text"
            value={e.path}
            onChange={ev => update(i, { path: ev.target.value })}
            placeholder={placeholder}
            className="modal-field flex-1 text-xs"
            spellCheck={false}
          />
          <Toggle checked={e.enabled} onChange={enabled => update(i, { enabled })} />
          <IconButton icon="trash" onClick={() => remove(i)} title="Remove" danger />
        </div>
      ))}
      <button type="button" onClick={add} className="modal-button modal-button--ghost text-xs w-full flex items-center justify-center gap-1.5">
        <Icon name="plus" size={10} />
        Add
      </button>
    </div>
  );
}

function AgentOverridesEditor({ value, onChange }: { value: { name: string; model: string }[]; onChange: (v: { name: string; model: string }[]) => void }) {
  const add = () => onChange([...value, { name: "", model: "" }]);
  const remove = (i: number) => onChange(value.filter((_, idx) => idx !== i));
  const update = (i: number, patch: Partial<{ name: string; model: string }>) => {
    onChange(value.map((e, idx) => idx === i ? { ...e, ...patch } : e));
  };
  return (
    <div className="space-y-1.5">
      {value.map((e, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            type="text"
            value={e.name}
            onChange={ev => update(i, { name: ev.target.value })}
            placeholder="Agent name"
            className="modal-field flex-1 text-xs"
            spellCheck={false}
          />
          <input
            type="text"
            value={e.model}
            onChange={ev => update(i, { model: ev.target.value })}
            placeholder="Model"
            className="modal-field flex-1 text-xs"
            spellCheck={false}
          />
          <IconButton icon="trash" onClick={() => remove(i)} title="Remove" danger />
        </div>
      ))}
      <button type="button" onClick={add} className="modal-button modal-button--ghost text-xs w-full flex items-center justify-center gap-1.5">
        <Icon name="plus" size={10} />
        Add agent override
      </button>
    </div>
  );
}

// ─── Modal ───

interface SettingsModalProps {
  onClose: () => void;
  onResetWorkspace: () => void;
  projectId?: string;
}

type SettingsTab = "pi-settings" | "pi-models" | "pi-web" | "project";

export function SettingsModal({ onClose, onResetWorkspace, projectId }: SettingsModalProps) {
  const TABS: { id: SettingsTab; label: string }[] = [
    { id: "pi-settings", label: "PI Settings" },
    { id: "pi-models", label: "PI Models" },
    { id: "pi-web", label: "PI Web" },
    ...(projectId ? [{ id: "project" as const, label: "Project" }] : []),
  ];
  const [activeTab, setActiveTab] = useState<SettingsTab>("pi-settings");

  // PI settings
  const [settingsRaw, setSettingsRaw] = useState("{}");
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsLoadError, setSettingsLoadError] = useState<string | null>(null);
  const [settingsSaveError, setSettingsSaveError] = useState<string | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [showStructuredForm, setShowStructuredForm] = useState(false);

  // Project settings
  const [projectSystemPrompt, setProjectSystemPrompt] = useState("");
  const [projectInstructions, setProjectInstructions] = useState("");
  const [projectSaving, setProjectSaving] = useState(false);
  const [projectSaveError, setProjectSaveError] = useState<string | null>(null);
  const [projectDirty, setProjectDirty] = useState(false);

  useEffect(() => {
    if (!projectId) return;
    fetch(`/api/projects/${encodeURIComponent(projectId)}/settings`)
      .then(r => r.json())
      .then(d => {
        setProjectSystemPrompt(d.systemPrompt || "");
        setProjectInstructions(d.projectInstructions || "");
      })
      .catch(() => {});
  }, [projectId]);

  const handleSaveProjectSettings = useCallback(async () => {
    if (!projectId) return;
    setProjectSaving(true);
    setProjectSaveError(null);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ systemPrompt: projectSystemPrompt, projectInstructions: projectInstructions }),
      });
      if (!res.ok) throw new Error("Failed to save project settings");
      setProjectDirty(false);
    } catch (e: any) {
      setProjectSaveError(e.message || "Failed to save");
    } finally {
      setProjectSaving(false);
    }
  }, [projectId, projectSystemPrompt, projectInstructions]);

  // PI models
  const [modelsRaw, setModelsRaw] = useState("{}");
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsLoadError, setModelsLoadError] = useState<string | null>(null);
  const [modelsSaveError, setModelsSaveError] = useState<string | null>(null);
  const [modelsSaving, setModelsSaving] = useState(false);
  const [modelsDirty, setModelsDirty] = useState(false);

  // PI web
  const [theme, , setTheme] = useTheme();
  const [webSettings, setWebSettings] = useState<PiWebSettings>(() => loadPiWebSettings());
  const [webSaved, setWebSaved] = useState(false);

  useEffect(() => {
    setWebSettings(s => ({ ...s, theme }));
  }, [theme]);

  useEffect(() => {
    let mounted = true;
    fetchPiConfig("settings")
      .then(content => {
        if (!mounted) return;
        setSettingsRaw(content);
        setSettingsLoading(false);
      })
      .catch(e => {
        if (!mounted) return;
        setSettingsLoadError(e.message || "Failed to load PI settings");
        setSettingsLoading(false);
      });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    let mounted = true;
    fetchPiConfig("models")
      .then(content => {
        if (!mounted) return;
        setModelsRaw(formatJson(content));
        setModelsLoading(false);
      })
      .catch(e => {
        if (!mounted) return;
        setModelsLoadError(e.message || "Failed to load PI models");
        setModelsLoading(false);
      });
    return () => { mounted = false; };
  }, []);

  // Derived form state from settings raw
  const settings = useMemo(() => parseSettings(settingsRaw), [settingsRaw]);

  const form = useMemo(() => ({
    theme: settings.theme || "",
    lastChangelogVersion: settings.lastChangelogVersion || "",
    defaultProvider: settings.defaultProvider || "",
    defaultModel: settings.defaultModel || "",
    defaultThinkingLevel: settings.defaultThinkingLevel || "",
    retryEnabled: settings.retry?.enabled ?? false,
    compactionEnabled: settings.compaction?.enabled ?? false,
    packages: (settings.packages || []).map(packageToForm),
    extensions: settings.extensions || [],
    skills: settings.skills || [],
    agentOverrides: Object.entries(settings.subagents?.agentOverrides || {}).map(([name, cfg]) => ({ name, model: cfg.model || "" })),
  }), [settings]);

  function buildSettingsFromForm(values: typeof form): PiSettings {
    const next: PiSettings = { ...parseSettings(settingsRaw) };
    next.theme = values.theme || undefined;
    next.lastChangelogVersion = values.lastChangelogVersion || undefined;
    next.defaultProvider = values.defaultProvider || undefined;
    next.defaultModel = values.defaultModel || undefined;
    next.defaultThinkingLevel = values.defaultThinkingLevel || undefined;
    next.retry = values.retryEnabled ? { enabled: true } : undefined;
    next.compaction = values.compactionEnabled ? { enabled: true } : undefined;
    const validPackages = values.packages.filter(p => p.source.trim());
    next.packages = validPackages.length ? validPackages.map(formToPackage) : undefined;
    next.extensions = values.extensions.filter(e => parseEnabledEntry(e).path).length ? values.extensions.filter(e => parseEnabledEntry(e).path) : undefined;
    next.skills = values.skills.filter(e => parseEnabledEntry(e).path).length ? values.skills.filter(e => parseEnabledEntry(e).path) : undefined;
    const validOverrides = values.agentOverrides.filter(a => a.name.trim());
    next.subagents = validOverrides.length
      ? { agentOverrides: Object.fromEntries(validOverrides.map(a => [a.name.trim(), { model: a.model }])) }
      : undefined;
    return next;
  }

  const updateForm = useCallback((patch: Partial<typeof form>) => {
    const current = { ...form, ...patch };
    const next = buildSettingsFromForm(current);
    setSettingsRaw(JSON.stringify(next, null, 2));
    setSettingsDirty(true);
    setSettingsSaveError(null);
  }, [form, settingsRaw]);

  const handleSaveSettings = useCallback(async () => {
    const err = (() => {
      try {
        JSON.parse(settingsRaw);
        return null;
      } catch (e: any) {
        return e.message || "Invalid JSON";
      }
    })();
    if (err) {
      setSettingsSaveError(err);
      return;
    }
    setSettingsSaving(true);
    setSettingsSaveError(null);
    try {
      await savePiConfig("settings", settingsRaw);
      setSettingsDirty(false);
    } catch (e: any) {
      setSettingsSaveError(e.message || "Failed to save");
    } finally {
      setSettingsSaving(false);
    }
  }, [settingsRaw]);

  const handleSaveModels = useCallback(async () => {
    let err: string | null = null;
    try { JSON.parse(modelsRaw); } catch (e: any) { err = e.message || "Invalid JSON"; }
    if (err) {
      setModelsSaveError(err);
      return;
    }
    setModelsSaving(true);
    setModelsSaveError(null);
    try {
      await savePiConfig("models", modelsRaw);
      setModelsDirty(false);
    } catch (e: any) {
      setModelsSaveError(e.message || "Failed to save");
    } finally {
      setModelsSaving(false);
    }
  }, [modelsRaw]);

  const handleModelsChange = useCallback((value: string) => {
    setModelsRaw(value);
    setModelsDirty(true);
    setModelsSaveError(null);
  }, []);

  const handleFormatModels = useCallback(() => {
    setModelsRaw(prev => formatJson(prev));
  }, []);

  const handleThemeChange = useCallback((next: Theme) => {
    setTheme(next);
    setWebSettings(s => ({ ...s, theme: next }));
    triggerWebSaved();
  }, [setTheme]);

  const handlePreviewWidthChange = useCallback((value: string) => {
    const n = parseInt(value, 10);
    if (isNaN(n)) return;
    const clamped = Math.max(320, Math.min(n, Math.floor(window.innerWidth * 0.7)));
    savePiWebKey("pi-preview-width", String(clamped));
    setWebSettings(s => ({ ...s, previewWidth: clamped }));
    triggerWebSaved();
  }, []);

  const handleFilesWidthChange = useCallback((value: string) => {
    const n = parseInt(value, 10);
    if (isNaN(n)) return;
    const clamped = Math.max(120, Math.min(n, 600));
    savePiWebKey("files-panel-explorer-width", String(clamped));
    setWebSettings(s => ({ ...s, filesExplorerWidth: clamped }));
    triggerWebSaved();
  }, []);

  const handleClearPwaDismissals = useCallback(() => {
    try {
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith("pwa-dismiss-")) keys.push(k);
      }
      for (const k of keys) localStorage.removeItem(k);
    } catch {}
    triggerWebSaved();
  }, []);

  const handleResetAllWeb = useCallback(() => {
    try { for (const k of PI_WEB_KEYS) localStorage.removeItem(k); } catch {}
    setWebSettings(loadPiWebSettings());
    triggerWebSaved();
    window.setTimeout(() => window.location.reload(), 400);
  }, []);

  function triggerWebSaved() {
    setWebSaved(true);
    window.setTimeout(() => setWebSaved(false), 1200);
  }

  const settingsValidationError = useMemo(() => {
    try { JSON.parse(settingsRaw); return null; } catch (e: any) { return e.message || "Invalid JSON"; }
  }, [settingsRaw]);

  const renderPiSettings = () => {
    if (settingsLoading) return <div className="flex-1 flex items-center justify-center text-ink-500 text-sm">Loading PI settings…</div>;
    if (settingsLoadError) return <div className="text-red-400 text-xs bg-red-950/30 border border-red-900/40 rounded px-3 py-2">{settingsLoadError}</div>;

    return (
      <div className="flex flex-col gap-3 h-full min-h-0">
        <div className="flex items-center justify-between gap-2">
          <p className="text-ink-500 text-xs flex-1">
            Edit the full <code className="text-ink-300 bg-ink-900/50 px-1 rounded">settings.json</code> directly. Add any option PI supports (extensions, skills, packages, retry, subagents, etc.). Some changes require restarting PI.
          </p>
          <label className="flex items-center gap-1.5 text-ink-400 text-xs cursor-pointer shrink-0">
            <input
              type="checkbox"
              className="rounded border-ink-700 bg-ink-900 text-amber-600 focus:ring-amber-500"
              checked={showStructuredForm}
              onChange={e => setShowStructuredForm(e.target.checked)}
            />
            Structured form
          </label>
          {!showStructuredForm && (
            <button
              type="button"
              onClick={handleSaveSettings}
              disabled={settingsSaving || !!settingsValidationError || !settingsDirty}
              className={`modal-button modal-button--primary text-xs ${settingsSaving || !!settingsValidationError || !settingsDirty ? "opacity-45 cursor-not-allowed" : ""}`}
            >
              {settingsSaving ? "Saving…" : "Save PI settings"}
            </button>
          )}
        </div>
        {settingsValidationError && settingsDirty && (
          <div className="text-red-400 text-xs bg-red-950/30 border border-red-900/40 rounded px-3 py-2">{settingsValidationError}</div>
        )}
        {settingsSaveError && (
          <div className="text-red-400 text-xs bg-red-950/30 border border-red-900/40 rounded px-3 py-2">{settingsSaveError}</div>
        )}
        {!showStructuredForm ? (
          <div className="flex flex-col gap-2 h-full min-h-0">
            <textarea
              value={settingsRaw}
              onChange={e => { setSettingsRaw(e.target.value); setSettingsDirty(true); setSettingsSaveError(null); }}
              spellCheck={false}
              className={`flex-1 min-h-0 w-full rounded-md border bg-ink-950/60 text-ink-200 font-mono text-xs p-3 resize-none focus:outline-none focus:border-amber-500/60 custom-scrollbar ${settingsValidationError ? "border-red-800/60" : "border-ink-800/50"}`}
              style={{ minHeight: "22rem" }}
            />
            <div className="flex items-center justify-end gap-2">
              <button type="button" onClick={() => setSettingsRaw(prev => formatJson(prev))} className="modal-button modal-button--ghost text-xs">Format</button>
              <button
                type="button"
                onClick={handleSaveSettings}
                disabled={settingsSaving || !!settingsValidationError || !settingsDirty}
                className={`modal-button modal-button--primary text-xs ${settingsSaving || !!settingsValidationError || !settingsDirty ? "opacity-45 cursor-not-allowed" : ""}`}
              >
                {settingsSaving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto custom-scrollbar pr-1 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Theme" hint="PI terminal theme name">
                <TextInput value={form.theme} onChange={v => updateForm({ theme: v })} />
              </Field>
              <Field label="Last changelog version">
                <TextInput value={form.lastChangelogVersion} onChange={v => updateForm({ lastChangelogVersion: v })} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Default provider">
                <TextInput value={form.defaultProvider} onChange={v => updateForm({ defaultProvider: v })} />
              </Field>
              <Field label="Default model">
                <TextInput value={form.defaultModel} onChange={v => updateForm({ defaultModel: v })} />
              </Field>
            </div>
            <Field label="Default thinking level">
              <Select
                value={form.defaultThinkingLevel}
                onChange={v => updateForm({ defaultThinkingLevel: v })}
                options={[
                  { value: "", label: "Default" },
                  { value: "low", label: "Low" },
                  { value: "medium", label: "Medium" },
                  { value: "high", label: "High" },
                ]}
              />
            </Field>
            <div className="flex items-center gap-6">
              <Toggle checked={form.retryEnabled} onChange={v => updateForm({ retryEnabled: v })} label="Retry enabled" />
              <Toggle checked={form.compactionEnabled} onChange={v => updateForm({ compactionEnabled: v })} label="Compaction enabled" />
            </div>
            <Field label="Packages">
              <PackagesEditor value={form.packages} onChange={v => updateForm({ packages: v })} />
            </Field>
            <Field label="Extensions" hint="Prefix toggled via on/off switch">
              <EnabledStringList values={form.extensions} onChange={v => updateForm({ extensions: v })} placeholder="extensions/foo.ts" />
            </Field>
            <Field label="Skills" hint="Prefix toggled via on/off switch">
              <EnabledStringList values={form.skills} onChange={v => updateForm({ skills: v })} placeholder="skills/foo/SKILL.md" />
            </Field>
            <Field label="Subagent model overrides">
              <AgentOverridesEditor value={form.agentOverrides} onChange={v => updateForm({ agentOverrides: v })} />
            </Field>
          </div>
        )}
      </div>
    );
  };

  const renderPiModels = () => {
    if (modelsLoading) return <div className="flex-1 flex items-center justify-center text-ink-500 text-sm">Loading PI models…</div>;
    if (modelsLoadError) return <div className="text-red-400 text-xs bg-red-950/30 border border-red-900/40 rounded px-3 py-2">{modelsLoadError}</div>;
    let validationError: string | null = null;
    try { JSON.parse(modelsRaw); } catch (e: any) { validationError = e.message || "Invalid JSON"; }
    return (
      <div className="flex flex-col gap-3 h-full min-h-0">
        <div className="flex items-center justify-between gap-2">
          <p className="text-ink-500 text-xs flex-1">Edit PI models configuration. Invalid JSON cannot be saved.</p>
          <div className="flex items-center gap-2 shrink-0">
            <button type="button" onClick={handleFormatModels} className="modal-button modal-button--ghost text-xs">Format</button>
            <button
              type="button"
              onClick={handleSaveModels}
              disabled={modelsSaving || !!validationError || !modelsDirty}
              className={`modal-button modal-button--primary text-xs ${modelsSaving || !!validationError || !modelsDirty ? "opacity-45 cursor-not-allowed" : ""}`}
            >
              {modelsSaving ? "Saving…" : "Save models"}
            </button>
          </div>
        </div>
        {(validationError && modelsDirty) && (
          <div className="text-red-400 text-xs bg-red-950/30 border border-red-900/40 rounded px-3 py-2">{validationError}</div>
        )}
        {modelsSaveError && (
          <div className="text-red-400 text-xs bg-red-950/30 border border-red-900/40 rounded px-3 py-2">{modelsSaveError}</div>
        )}
        <textarea
          value={modelsRaw}
          onChange={e => handleModelsChange(e.target.value)}
          spellCheck={false}
          className={`flex-1 min-h-0 w-full rounded-md border bg-ink-950/60 text-ink-200 font-mono text-xs p-3 resize-none focus:outline-none focus:border-amber-500/60 custom-scrollbar ${validationError ? "border-red-800/60" : "border-ink-800/50"}`}
          style={{ minHeight: "24rem" }}
        />
      </div>
    );
  };

  const renderPiWeb = () => (
    <div className="flex flex-col gap-5 overflow-y-auto custom-scrollbar pr-1">
      {webSaved && (
        <div className="text-emerald-400 text-xs bg-emerald-950/20 border border-emerald-900/30 rounded px-3 py-2">Setting saved.</div>
      )}
      <section className="space-y-3">
        <h3 className="text-ink-200 text-sm font-medium">Appearance</h3>
        <div className="flex items-center justify-between gap-3 p-3 rounded-md border border-ink-800/40 bg-ink-900/30">
          <div>
            <div className="text-ink-200 text-xs font-medium">Theme</div>
            <div className="text-ink-500 text-xs">Light or dark interface.</div>
          </div>
          <select
            value={webSettings.theme}
            onChange={e => handleThemeChange(e.target.value as Theme)}
            className="modal-field w-28 text-xs"
          >
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </div>
      </section>
      <section className="space-y-3">
        <h3 className="text-ink-200 text-sm font-medium">Panel sizes</h3>
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3 p-3 rounded-md border border-ink-800/40 bg-ink-900/30">
            <div>
              <div className="text-ink-200 text-xs font-medium">Preview width</div>
              <div className="text-ink-500 text-xs">Default preview panel width in pixels. Reload to apply.</div>
            </div>
            <input
              type="number"
              min={320}
              max={Math.floor(window.innerWidth * 0.7)}
              value={webSettings.previewWidth}
              onChange={e => handlePreviewWidthChange(e.target.value)}
              className="modal-field w-24 text-xs"
            />
          </div>
          <div className="flex items-center justify-between gap-3 p-3 rounded-md border border-ink-800/40 bg-ink-900/30">
            <div>
              <div className="text-ink-200 text-xs font-medium">Files explorer width</div>
              <div className="text-ink-500 text-xs">File tree sidebar width in pixels. Reload to apply.</div>
            </div>
            <input
              type="number"
              min={120}
              max={600}
              value={webSettings.filesExplorerWidth}
              onChange={e => handleFilesWidthChange(e.target.value)}
              className="modal-field w-24 text-xs"
            />
          </div>
        </div>
      </section>
      <section className="space-y-3">
        <h3 className="text-ink-200 text-sm font-medium">Workspace</h3>
        <div className="flex items-center justify-between gap-3 p-3 rounded-md border border-ink-800/40 bg-ink-900/30">
          <div>
            <div className="text-ink-200 text-xs font-medium">Reset workspace layout</div>
            <div className="text-ink-500 text-xs">Restore the default panel layout.</div>
          </div>
          <button
            type="button"
            onClick={() => { onResetWorkspace(); triggerWebSaved(); }}
            className="modal-button modal-button--ghost text-xs"
          >
            Reset layout
          </button>
        </div>
      </section>
      <section className="space-y-3">
        <h3 className="text-ink-200 text-sm font-medium">Banners & reset</h3>
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3 p-3 rounded-md border border-ink-800/40 bg-ink-900/30">
            <div>
              <div className="text-ink-200 text-xs font-medium">Clear PWA banner dismissals</div>
              <div className="text-ink-500 text-xs">Re-enable install / update banners.</div>
            </div>
            <button type="button" onClick={handleClearPwaDismissals} className="modal-button modal-button--ghost text-xs">Clear</button>
          </div>
          <div className="flex items-center justify-between gap-3 p-3 rounded-md border border-red-900/30 bg-red-950/10">
            <div>
              <div className="text-ink-200 text-xs font-medium">Reset all PI Web state</div>
              <div className="text-ink-500 text-xs">Clear theme, panel widths, and banner state. Page will reload.</div>
            </div>
            <button type="button" onClick={handleResetAllWeb} className="modal-button modal-button--ghost text-xs text-red-400 hover:text-red-300">Reset all</button>
          </div>
        </div>
      </section>
    </div>
  );

  const renderProjectSettings = () => (
    <div className="flex flex-col gap-3 h-full min-h-0">
      <Field label="System prompt" hint="Sent as the first system context for every new prompt in this project.">
        <textarea
          value={projectSystemPrompt}
          onChange={e => { setProjectSystemPrompt(e.target.value); setProjectDirty(true); }}
          rows={4}
          className="modal-field w-full text-xs font-mono resize-y min-h-[4rem]"
          spellCheck={false}
          placeholder="You are an expert engineer working on this project..."
        />
      </Field>
      <Field label="Project instructions" hint="Always included alongside user messages from this project.">
        <textarea
          value={projectInstructions}
          onChange={e => { setProjectInstructions(e.target.value); setProjectDirty(true); }}
          rows={4}
          className="modal-field w-full text-xs font-mono resize-y min-h-[4rem]"
          spellCheck={false}
          placeholder="Follow the project's style guide and use TypeScript..."
        />
      </Field>
      {projectSaveError && <div className="text-red-400 text-xs bg-red-950/30 border border-red-900/40 rounded px-3 py-2">{projectSaveError}</div>}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={handleSaveProjectSettings}
          disabled={projectSaving || !projectDirty}
          className={`modal-button modal-button--primary text-xs ${projectSaving || !projectDirty ? "opacity-45 cursor-not-allowed" : ""}`}
        >
          {projectSaving ? "Saving…" : "Save project settings"}
        </button>
      </div>
    </div>
  );

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="modal-stage">
        <div
          className="modal-card modal-card--full explorer-modal animate-fade-in-up flex flex-col"
          style={{ maxHeight: "90vh", width: "min(820px, 94vw)" }}
        >
          <div className="modal-header mobile-safe-top">
            <div className="modal-header-icon"><Icon name="settings" size={14} /></div>
            <h2 className="modal-title">Settings</h2>
            <button onClick={onClose} className="modal-close" aria-label="Close"><Icon name="close" size={14} /></button>
          </div>
          <div className="px-4 pt-3 border-b border-ink-800/40">
            <div className="flex gap-1" role="tablist" aria-label="Settings categories">
              {TABS.map(tab => (
                <button
                  key={tab.id}
                  role="tab"
                  aria-selected={activeTab === tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-t-md transition-colors ${activeTab === tab.id ? "bg-ink-800/60 text-amber-500" : "text-ink-500 hover:text-ink-300 hover:bg-ink-800/30"}`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>
          <div className="modal-body modal-body--compact flex-1 min-h-0 flex flex-col">
            {activeTab === "pi-settings" && renderPiSettings()}
            {activeTab === "pi-models" && renderPiModels()}
            {activeTab === "pi-web" && renderPiWeb()}
          </div>
          <div className="modal-footer mobile-safe-bottom">
            <button onClick={onClose} className="modal-button modal-button--primary">Done</button>
          </div>
        </div>
      </div>
    </div>
  );
}
