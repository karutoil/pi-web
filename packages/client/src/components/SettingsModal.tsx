import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChangeEvent, ReactNode } from "react";
import { Icon, type IconName } from "./Icon";
import { useTheme, type Theme } from "../hooks/useTheme";
import { useChatPrefs, resetChatPrefs } from "../hooks/useChatPrefs";
import type { UsageSummary } from "@pi-web/shared";
import { formatTokenCount } from "../lib/formatters";
import { formatCost } from "../lib/utils";
import { piWebStorage } from "../lib/piWebStorage";


// ─── PI Web settings ───

interface PiWebSettings {
  theme: Theme;
  previewWidth: number;
  filesExplorerWidth: number;
}

function loadPiWebSettings(): PiWebSettings {
  let theme: Theme = "light";
  const tv = piWebStorage.getItem("pi-web-theme");
  if (tv === "dark" || tv === "light") theme = tv;
  let previewWidth = 480;
  const pv = piWebStorage.getItem("pi-preview-width");
  const pn = pv ? parseInt(pv, 10) : NaN;
  if (!isNaN(pn)) previewWidth = Math.max(320, Math.min(pn, Math.floor(window.innerWidth * 0.7)));
  let filesExplorerWidth = 240;
  const fv = piWebStorage.getItem("files-panel-explorer-width");
  const fn = fv ? parseInt(fv, 10) : NaN;
  if (!isNaN(fn)) filesExplorerWidth = Math.max(120, Math.min(fn, 600));
  return { theme, previewWidth, filesExplorerWidth };
}

function savePiWebKey(key: string, value: string) {
  piWebStorage.setItem(key, value);
}

// ── Chat-display setting previews (static, expanded) ───────────────────────

function ChatPrefRow({ title, desc, checked, onChange, preview }: {
  title: string;
  desc: string;
  checked: boolean;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  preview: ReactNode;
}) {
  return (
    <div className="p-3 rounded-md border border-ink-800/40 bg-ink-900/30 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-ink-200 text-xs font-medium">{title}</div>
          <div className="text-ink-500 text-xs">{desc}</div>
        </div>
        <input type="checkbox" checked={checked} onChange={onChange} className="h-4 w-4 accent-amber-500 cursor-pointer" />
      </div>
      <div className="chat-pref-preview">{preview}</div>
    </div>
  );
}

function ReasoningPreview() {
  return (
    <div className="conversation-thinking-block" data-open="true">
      <div className="conversation-reasoning-link">
        <Icon name="spark" size={11} />
        <span>Reasoning</span>
      </div>
      <div className="conversation-reasoning-body-wrap">
        <div className="conversation-reasoning-body">The user wants a test for the refresh path. I'll cover the expiry edge case — within 5s of expiry, refreshToken should rotate instead of returning the stale value.</div>
      </div>
    </div>
  );
}

function ToolGroupPreview() {
  return (
    <div className="exec open">
      <div className="exec-head">
        <span className="exec-dots"><i data-k="read"></i><i data-k="edit"></i><i data-k="bash"></i></span>
        <b>Ran 3 tools</b>
        <Icon name="chevron-right-sm" size={11} className="exec-chev" />
      </div>
      <div className="exec-rail">
        <div className="exec-node" data-k="read">
          <div className="exec-node-head"><span className="k">read</span><span className="path">src/auth/middleware.ts</span><span className="meta">142 lines</span><Icon name="chevron-right-sm" size={11} className="node-chev" /></div>
        </div>
        <div className="exec-node" data-k="edit">
          <div className="exec-node-head"><span className="k">edit</span><span className="path">middleware.ts</span><span className="meta">2 edits</span><Icon name="chevron-right-sm" size={11} className="node-chev" /></div>
        </div>
        <div className="exec-node" data-k="bash">
          <div className="exec-node-head"><span className="k">bash</span><span className="path">bun test src/auth</span><span className="meta">exit 0</span><Icon name="chevron-right-sm" size={11} className="node-chev" /></div>
        </div>
      </div>
    </div>
  );
}

function ToolCallPreview() {
  return (
    <div className="exec open">
      <div className="exec-rail">
        <div className="exec-node open" data-k="bash">
          <div className="exec-node-head">
            <span className="k">bash</span>
            <span className="path">bun test src/auth</span>
            <span className="meta">exit 0</span>
            <Icon name="chevron-right-sm" size={11} className="node-chev" />
          </div>
          <div className="exec-detail">
            <div className="conversation-tool-body conversation-result-panel">
              <pre className="conversation-result-pre">{"✓ src/auth/middleware.test.ts (3)\n  ✓ rotates within 5s of expiry\n  ✓ keeps valid token\n  3 passed (3)"}</pre>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
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
  defaultThinkingLevel?: string;
  hideThinkingBlock?: boolean;
  thinkingBudgets?: Record<string, number>;
  retry?: { enabled?: boolean; maxRetries?: number; baseDelayMs?: number; provider?: { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs?: number } };
  subagents?: { agentOverrides?: Record<string, { model?: string }> };
  compaction?: { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number };
  branchSummary?: { reserveTokens?: number; skipPrompt?: boolean };
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
  enableSkillCommands?: boolean;
  enabledModels?: string[];
  warnings?: { anthropicExtraUsage?: boolean };
  steeringMode?: string;
  followUpMode?: string;
  transport?: string;
  sessionDir?: string;
  shellPath?: string;
  shellCommandPrefix?: string;
  npmCommand?: string[];
  markdown?: { codeBlockIndent?: string };
  quietStartup?: boolean;
  collapseChangelog?: boolean;
  enableInstallTelemetry?: boolean;
  doubleEscapeAction?: string;
  treeFilterMode?: string;
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

function NumberInput({ value, onChange, min, max, placeholder = "" }: { value: number | string; onChange: (v: number | undefined) => void; min?: number; max?: number; placeholder?: string }) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      placeholder={placeholder}
      onChange={e => {
        const raw = e.target.value;
        if (raw === "") { onChange(undefined); return; }
        const n = parseInt(raw, 10);
        onChange(isNaN(n) ? undefined : n);
      }}
      className="modal-field w-full text-xs"
      spellCheck={false}
    />
  );
}

function FormSection({ title, children, hint }: { title: string; children: React.ReactNode; hint?: string }) {
  return (
    <section className="space-y-2 border-t border-ink-800/40 pt-3 first:border-t-0 first:pt-0">
      <div>
        <h4 className="text-ink-200 text-xs font-semibold">{title}</h4>
        {hint && <p className="text-ink-600 text-[0.65rem] mt-0.5">{hint}</p>}
      </div>
      <div className="space-y-2">{children}</div>
    </section>
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

type SettingsTab = "usage" | "pi-settings" | "pi-models" | "pi-web" | "project";


export function SettingsModal({ onClose, onResetWorkspace, projectId }: SettingsModalProps) {
  const TABS: { id: SettingsTab; label: string }[] = [
    { id: "usage", label: "Usage" },
    { id: "pi-settings", label: "PI Settings" },
    { id: "pi-models", label: "PI Models" },
    { id: "pi-web", label: "PI Web" },
    ...(projectId ? [{ id: "project" as const, label: "Project" }] : []),
  ];
  const [activeTab, setActiveTab] = useState<SettingsTab>("usage");

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

  // Usage (aggregate across all sessions)
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [usageLoadedAt, setUsageLoadedAt] = useState(0);

  const loadUsage = useCallback(async () => {
    setUsageLoading(true);
    setUsageError(null);
    try {
      const r = await fetch("/api/usage");
      if (!r.ok) throw new Error(`Failed to load usage (${r.status})`);
      const d = (await r.json()) as UsageSummary;
      setUsage(d);
      setUsageLoadedAt(Date.now());
    } catch (e: any) {
      setUsageError(e.message || "Failed to load usage");
    } finally {
      setUsageLoading(false);
    }
  }, []);

  // Fetch usage when the tab becomes active (and allow manual refresh).
  useEffect(() => {
    if (activeTab === "usage" && !usage && !usageLoading) loadUsage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

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
  const [chatPrefs, setChatPref] = useChatPrefs();

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
    // Model & Thinking
    defaultProvider: settings.defaultProvider || "",
    defaultModel: settings.defaultModel || "",
    defaultThinkingLevel: settings.defaultThinkingLevel || "",
    hideThinkingBlock: settings.hideThinkingBlock ?? false,
    enabledModels: settings.enabledModels || [],
    // Compaction & branch summary
    compactionEnabled: settings.compaction?.enabled ?? true,
    compactionReserveTokens: settings.compaction?.reserveTokens,
    compactionKeepRecentTokens: settings.compaction?.keepRecentTokens,
    branchSummaryReserveTokens: settings.branchSummary?.reserveTokens,
    branchSummarySkipPrompt: settings.branchSummary?.skipPrompt ?? false,
    // Retry
    retryEnabled: settings.retry?.enabled ?? true,
    retryMaxRetries: settings.retry?.maxRetries,
    retryBaseDelayMs: settings.retry?.baseDelayMs,
    retryProviderTimeoutMs: settings.retry?.provider?.timeoutMs,
    retryProviderMaxRetries: settings.retry?.provider?.maxRetries,
    retryProviderMaxRetryDelayMs: settings.retry?.provider?.maxRetryDelayMs,
    // Message delivery
    steeringMode: settings.steeringMode || "",
    followUpMode: settings.followUpMode || "",
    transport: settings.transport || "",
    // Warnings
    warningsAnthropicExtraUsage: settings.warnings?.anthropicExtraUsage ?? true,
    // Shell
    shellPath: settings.shellPath || "",
    shellCommandPrefix: settings.shellCommandPrefix || "",
    npmCommand: (settings.npmCommand || []).join(" "),
    // Sessions
    sessionDir: settings.sessionDir || "",
    // Markdown
    markdownCodeBlockIndent: settings.markdown?.codeBlockIndent || "",
    // UI & display (terminal-only; surfaced for completeness)
    theme: settings.theme || "",
    quietStartup: settings.quietStartup ?? false,
    collapseChangelog: settings.collapseChangelog ?? false,
    enableInstallTelemetry: settings.enableInstallTelemetry ?? true,
    doubleEscapeAction: settings.doubleEscapeAction || "",
    treeFilterMode: settings.treeFilterMode || "",
    lastChangelogVersion: settings.lastChangelogVersion || "",
    // Resources
    packages: (settings.packages || []).map(packageToForm),
    extensions: settings.extensions || [],
    skills: settings.skills || [],
    prompts: settings.prompts || [],
    themes: settings.themes || [],
    enableSkillCommands: settings.enableSkillCommands ?? true,
    // Subagents
    agentOverrides: Object.entries(settings.subagents?.agentOverrides || {}).map(([name, cfg]) => ({ name, model: cfg.model || "" })),
  }), [settings]);

  // Write a boolean toggle: keep the file clean by omitting default values,
  // but preserve a key that was already present so no-op saves are stable.
  function boolToggle(current: unknown, value: boolean, defaultValue: boolean): boolean | undefined {
    const exists = current !== undefined;
    if (value === defaultValue && !exists) return undefined;
    return value;
  }

  function buildSettingsFromForm(values: typeof form): PiSettings {
    const next: PiSettings = { ...parseSettings(settingsRaw) };
    // Helper: patch a nested object, preserving existing keys and omitting empties.
    const patchObj = <T extends Record<string, unknown>>(existing: T | undefined, patch: Record<string, unknown>): T | undefined => {
      const merged = { ...(existing || {}), ...patch };
      // Drop keys whose value is undefined (form field cleared / default-omitted).
      const cleaned: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(merged)) if (v !== undefined) cleaned[k] = v;
      return Object.keys(cleaned).length ? (cleaned as T) : undefined;
    };

    // Model & Thinking
    next.defaultProvider = values.defaultProvider || undefined;
    next.defaultModel = values.defaultModel || undefined;
    next.defaultThinkingLevel = values.defaultThinkingLevel || undefined;
    next.hideThinkingBlock = boolToggle(next.hideThinkingBlock, values.hideThinkingBlock, false);
    next.enabledModels = values.enabledModels.filter(e => parseEnabledEntry(e).path).length ? values.enabledModels.filter(e => parseEnabledEntry(e).path) : undefined;

    // Compaction & branch summary
    next.compaction = patchObj(next.compaction, {
      enabled: boolToggle(next.compaction?.enabled, values.compactionEnabled, true),
      reserveTokens: values.compactionReserveTokens,
      keepRecentTokens: values.compactionKeepRecentTokens,
    });
    next.branchSummary = patchObj(next.branchSummary, {
      reserveTokens: values.branchSummaryReserveTokens,
      skipPrompt: boolToggle(next.branchSummary?.skipPrompt, values.branchSummarySkipPrompt, false),
    });

    // Retry
    const retryProvider = patchObj(next.retry?.provider, {
      timeoutMs: values.retryProviderTimeoutMs,
      maxRetries: values.retryProviderMaxRetries,
      maxRetryDelayMs: values.retryProviderMaxRetryDelayMs,
    });
    next.retry = patchObj(next.retry, {
      enabled: boolToggle(next.retry?.enabled, values.retryEnabled, true),
      maxRetries: values.retryMaxRetries,
      baseDelayMs: values.retryBaseDelayMs,
      provider: retryProvider,
    });
    // Message delivery
    next.steeringMode = values.steeringMode || undefined;
    next.followUpMode = values.followUpMode || undefined;
    next.transport = values.transport || undefined;
    // Warnings
    next.warnings = patchObj(next.warnings, { anthropicExtraUsage: boolToggle(next.warnings?.anthropicExtraUsage, values.warningsAnthropicExtraUsage, true) });
    // Shell
    next.shellPath = values.shellPath || undefined;
    next.shellCommandPrefix = values.shellCommandPrefix || undefined;
    const npmParts = splitTags(values.npmCommand);
    next.npmCommand = npmParts.length ? npmParts : undefined;
    // Sessions
    next.sessionDir = values.sessionDir || undefined;
    // Markdown
    next.markdown = patchObj(next.markdown, { codeBlockIndent: values.markdownCodeBlockIndent || undefined });
    // UI & display
    next.theme = values.theme || undefined;
    next.quietStartup = boolToggle(next.quietStartup, values.quietStartup, false);
    next.collapseChangelog = boolToggle(next.collapseChangelog, values.collapseChangelog, false);
    next.enableInstallTelemetry = boolToggle(next.enableInstallTelemetry, values.enableInstallTelemetry, true);
    next.doubleEscapeAction = values.doubleEscapeAction || undefined;
    next.treeFilterMode = values.treeFilterMode || undefined;
    next.lastChangelogVersion = values.lastChangelogVersion || undefined;
    // Resources
    const validPackages = values.packages.filter(p => p.source.trim());
    next.packages = validPackages.length ? validPackages.map(formToPackage) : undefined;
    next.extensions = values.extensions.filter(e => parseEnabledEntry(e).path).length ? values.extensions.filter(e => parseEnabledEntry(e).path) : undefined;
    next.skills = values.skills.filter(e => parseEnabledEntry(e).path).length ? values.skills.filter(e => parseEnabledEntry(e).path) : undefined;
    next.prompts = values.prompts.filter(e => parseEnabledEntry(e).path).length ? values.prompts.filter(e => parseEnabledEntry(e).path) : undefined;
    next.themes = values.themes.filter(e => parseEnabledEntry(e).path).length ? values.themes.filter(e => parseEnabledEntry(e).path) : undefined;
    next.enableSkillCommands = boolToggle(next.enableSkillCommands, values.enableSkillCommands, true);
    // Subagents
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
    ["install", "update", "ios-install"].forEach((k) =>
      piWebStorage.removeItem(`pwa-dismiss-${k}`),
    );
    triggerWebSaved();
  }, []);

  const handleResetAllWeb = useCallback(() => {
    piWebStorage.clear();
    resetChatPrefs();
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

  const renderUsage = () => {
    if (usageLoading && !usage) return <div className="flex-1 flex items-center justify-center text-ink-500 text-sm">Loading usage...</div>;
    if (usageError && !usage) return <div className="text-red-400 text-xs bg-red-950/30 border border-red-900/40 rounded px-3 py-2">{usageError}</div>;
    if (!usage) return null;

    const totalProjects = usage.projects.length;
    const activeProjects = usage.projects.filter(p => p.sessionCount > 0).length;
    const avgCost = usage.totalSessions > 0 ? usage.totalCost / usage.totalSessions : 0;
    const topModel = usage.byModel[0];
    const staleMs = Date.now() - usageLoadedAt;

    return (
      <div className="flex flex-col gap-4 overflow-y-auto custom-scrollbar pr-1">
        <div className="flex items-center justify-between gap-2">
          <p className="text-ink-500 text-xs flex-1">
            Token and cost roll-up across every PI session for all known projects.
            {usageLoadedAt > 0 && (
              <> Computed {staleMs < 60000 ? "just now" : `${Math.floor(staleMs / 60000)}m ago`}.</>
            )}
          </p>
          <button
            type="button"
            onClick={loadUsage}
            disabled={usageLoading}
            className="modal-button modal-button--ghost text-xs"
          >
            {usageLoading ? "Refreshing..." : "Refresh"}
          </button>
        </div>

        {usageError && (
          <div className="text-red-400 text-xs bg-red-950/30 border border-red-900/40 rounded px-3 py-2">{usageError}</div>
        )}

        {/* Headline totals */}
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-md border border-ink-800/40 bg-ink-900/30 p-3">
            <div className="text-ink-500 text-[0.65rem] uppercase tracking-wide">Total tokens</div>
            <div className="text-ink-100 text-lg font-semibold mt-0.5">{formatTokenCount(usage.totalTokens)}</div>
            <div className="text-ink-600 text-[0.65rem] mt-0.5">{usage.totalTokens.toLocaleString()}</div>
          </div>
          <div className="rounded-md border border-ink-800/40 bg-ink-900/30 p-3">
            <div className="text-ink-500 text-[0.65rem] uppercase tracking-wide">Total cost</div>
            <div className="text-amber-500 text-lg font-semibold mt-0.5">{formatCost(usage.totalCost) || "$0.00"}</div>
            <div className="text-ink-600 text-[0.65rem] mt-0.5">avg {formatCost(avgCost) || "$0.00"}/session</div>
          </div>
          <div className="rounded-md border border-ink-800/40 bg-ink-900/30 p-3">
            <div className="text-ink-500 text-[0.65rem] uppercase tracking-wide">Sessions</div>
            <div className="text-ink-100 text-lg font-semibold mt-0.5">{usage.totalSessions.toLocaleString()}</div>
            <div className="text-ink-600 text-[0.65rem] mt-0.5">{activeProjects} of {totalProjects} projects active</div>
          </div>
        </div>

        {/* Per-project breakdown */}
        <section className="space-y-2">
          <h3 className="text-ink-200 text-sm font-medium">Per project</h3>
          {usage.projects.length === 0 ? (
            <div className="text-ink-500 text-xs">No projects added yet.</div>
          ) : (
            <div className="rounded-md border border-ink-800/40 overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-ink-900/40 text-ink-500">
                  <tr>
                    <th className="text-left font-medium px-3 py-1.5">Project</th>
                    <th className="text-right font-medium px-3 py-1.5">Sessions</th>
                    <th className="text-right font-medium px-3 py-1.5">Messages</th>
                    <th className="text-right font-medium px-3 py-1.5">Tokens</th>
                    <th className="text-right font-medium px-3 py-1.5">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.projects.map(p => (
                    <tr key={p.id} className="border-t border-ink-800/30">
                      <td className="px-3 py-1.5">
                        <div className="text-ink-200">{p.name}</div>
                        <div className="text-ink-600 text-[0.65rem] truncate max-w-[16rem]">{p.path}</div>
                      </td>
                      <td className="text-right px-3 py-1.5 text-ink-300">{p.sessionCount.toLocaleString()}</td>
                      <td className="text-right px-3 py-1.5 text-ink-400">{p.totalMessages.toLocaleString()}</td>
                      <td className="text-right px-3 py-1.5 text-ink-300">{formatTokenCount(p.totalTokens)}</td>
                      <td className="text-right px-3 py-1.5 text-amber-500/80">{formatCost(p.totalCost) || "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Per-model breakdown */}
        {usage.byModel.length > 0 && (
          <section className="space-y-2">
            <h3 className="text-ink-200 text-sm font-medium">Per model</h3>
            <div className="rounded-md border border-ink-800/40 overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-ink-900/40 text-ink-500">
                  <tr>
                    <th className="text-left font-medium px-3 py-1.5">Model</th>
                    <th className="text-right font-medium px-3 py-1.5">Sessions</th>
                    <th className="text-right font-medium px-3 py-1.5">Tokens</th>
                    <th className="text-right font-medium px-3 py-1.5">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.byModel.slice(0, 10).map(m => (
                    <tr key={m.model} className="border-t border-ink-800/30">
                      <td className="px-3 py-1.5 text-ink-300 font-mono">{m.model}</td>
                      <td className="text-right px-3 py-1.5 text-ink-400">{m.sessions.toLocaleString()}</td>
                      <td className="text-right px-3 py-1.5 text-ink-300">{formatTokenCount(m.tokens)}</td>
                      <td className="text-right px-3 py-1.5 text-amber-500/80">{formatCost(m.cost) || "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {topModel && (
              <p className="text-ink-600 text-[0.65rem]">Top model: <span className="text-ink-400 font-mono">{topModel.model}</span> ({formatTokenCount(topModel.tokens)} tokens).</p>
            )}
          </section>
        )}
      </div>
    );
  };
  const renderPiSettings = () => {
    if (settingsLoading) return <div className="flex-1 flex items-center justify-center text-ink-500 text-sm">Loading PI settings...</div>;
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
              {settingsSaving ? "Saving..." : "Save PI settings"}
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
                {settingsSaving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3 min-h-0 flex-1">
          <div className="flex-1 overflow-y-auto custom-scrollbar pr-1 space-y-5">
            <FormSection title="Model & thinking" hint="Default provider/model and reasoning level used by every new prompt.">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Default provider" hint='e.g. "anthropic", "openai", "umans"'>
                  <TextInput value={form.defaultProvider} onChange={v => updateForm({ defaultProvider: v })} placeholder="anthropic" />
                </Field>
                <Field label="Default model">
                  <TextInput value={form.defaultModel} onChange={v => updateForm({ defaultModel: v })} placeholder="claude-sonnet-4-20250514" />
                </Field>
              </div>
              <Field label="Default thinking level">
                <Select
                  value={form.defaultThinkingLevel}
                  onChange={v => updateForm({ defaultThinkingLevel: v })}
                  options={[
                    { value: "", label: "Default (off)" },
                    { value: "off", label: "Off" },
                    { value: "minimal", label: "Minimal" },
                    { value: "low", label: "Low" },
                    { value: "medium", label: "Medium" },
                    { value: "high", label: "High" },
                    { value: "xhigh", label: "Extra high" },
                  ]}
                />
              </Field>
              <div className="flex items-center gap-6">
                <Toggle checked={form.hideThinkingBlock} onChange={v => updateForm({ hideThinkingBlock: v })} label="Hide thinking blocks" />
              </div>
              <Field label="Enabled models" hint="Glob patterns for Ctrl+P model cycling.">
                <EnabledStringList values={form.enabledModels} onChange={v => updateForm({ enabledModels: v })} placeholder="claude-*" />
              </Field>
            </FormSection>

            <FormSection title="Compaction" hint="Auto-summarize the context when it grows too large.">
              <Toggle checked={form.compactionEnabled} onChange={v => updateForm({ compactionEnabled: v })} label="Compaction enabled" />
              <div className="grid grid-cols-2 gap-3">
                <Field label="Reserve tokens" hint="Tokens reserved for the LLM response.">
                  <NumberInput value={form.compactionReserveTokens ?? ""} onChange={v => updateForm({ compactionReserveTokens: v })} placeholder="16384" />
                </Field>
                <Field label="Keep recent tokens" hint="Recent tokens kept (not summarized).">
                  <NumberInput value={form.compactionKeepRecentTokens ?? ""} onChange={v => updateForm({ compactionKeepRecentTokens: v })} placeholder="20000" />
                </Field>
              </div>
            </FormSection>

            <FormSection title="Branch summary" hint="Summarization when navigating the session tree.">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Reserve tokens">
                  <NumberInput value={form.branchSummaryReserveTokens ?? ""} onChange={v => updateForm({ branchSummaryReserveTokens: v })} placeholder="16384" />
                </Field>
                <Toggle checked={form.branchSummarySkipPrompt} onChange={v => updateForm({ branchSummarySkipPrompt: v })} label="Skip summary prompt" />
              </div>
            </FormSection>

            <FormSection title="Retry" hint="Automatic retry on transient errors.">
              <Toggle checked={form.retryEnabled} onChange={v => updateForm({ retryEnabled: v })} label="Retry enabled" />
              <div className="grid grid-cols-2 gap-3">
                <Field label="Max retries">
                  <NumberInput value={form.retryMaxRetries ?? ""} onChange={v => updateForm({ retryMaxRetries: v })} placeholder="3" />
                </Field>
                <Field label="Base delay (ms)">
                  <NumberInput value={form.retryBaseDelayMs ?? ""} onChange={v => updateForm({ retryBaseDelayMs: v })} placeholder="2000" />
                </Field>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <Field label="Provider timeout (ms)">
                  <NumberInput value={form.retryProviderTimeoutMs ?? ""} onChange={v => updateForm({ retryProviderTimeoutMs: v })} placeholder="3600000" />
                </Field>
                <Field label="Provider max retries">
                  <NumberInput value={form.retryProviderMaxRetries ?? ""} onChange={v => updateForm({ retryProviderMaxRetries: v })} placeholder="0" />
                </Field>
                <Field label="Max retry delay (ms)">
                  <NumberInput value={form.retryProviderMaxRetryDelayMs ?? ""} onChange={v => updateForm({ retryProviderMaxRetryDelayMs: v })} placeholder="60000" />
                </Field>
              </div>
            </FormSection>

            <FormSection title="Message delivery" hint="How queued steering/follow-up messages are sent.">
              <div className="grid grid-cols-3 gap-3">
                <Field label="Steering mode">
                  <Select value={form.steeringMode} onChange={v => updateForm({ steeringMode: v })} options={[{ value: "", label: "Default" }, { value: "all", label: "All" }, { value: "one-at-a-time", label: "One at a time" }]} />
                </Field>
                <Field label="Follow-up mode">
                  <Select value={form.followUpMode} onChange={v => updateForm({ followUpMode: v })} options={[{ value: "", label: "Default" }, { value: "all", label: "All" }, { value: "one-at-a-time", label: "One at a time" }]} />
                </Field>
                <Field label="Transport">
                  <Select value={form.transport} onChange={v => updateForm({ transport: v })} options={[{ value: "", label: "Default" }, { value: "sse", label: "SSE" }, { value: "websocket", label: "WebSocket" }, { value: "auto", label: "Auto" }]} />
                </Field>
              </div>
            </FormSection>

            <FormSection title="Warnings">
              <Toggle checked={form.warningsAnthropicExtraUsage} onChange={v => updateForm({ warningsAnthropicExtraUsage: v })} label="Warn on Anthropic extra usage" />
            </FormSection>

            <FormSection title="Shell" hint="Customize the shell and npm command used by PI's bash tool.">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Shell path" hint="e.g. for Cygwin on Windows">
                  <TextInput value={form.shellPath} onChange={v => updateForm({ shellPath: v })} placeholder="/bin/bash" />
                </Field>
                <Field label="Shell command prefix">
                  <TextInput value={form.shellCommandPrefix} onChange={v => updateForm({ shellCommandPrefix: v })} placeholder="shopt -s expand_aliases" />
                </Field>
              </div>
              <Field label="npm command" hint="argv for npm operations, space-separated">
                <TextInput value={form.npmCommand} onChange={v => updateForm({ npmCommand: v })} placeholder="mise exec node@20 -- npm" />
              </Field>
            </FormSection>

            <FormSection title="Sessions">
              <Field label="Session directory" hint="Where session files are stored. Accepts ~ and relative paths.">
                <TextInput value={form.sessionDir} onChange={v => updateForm({ sessionDir: v })} placeholder=".pi/sessions" />
              </Field>
            </FormSection>

            <FormSection title="Markdown">
              <Field label="Code block indent">
                <TextInput value={form.markdownCodeBlockIndent} onChange={v => updateForm({ markdownCodeBlockIndent: v })} placeholder="  " />
              </Field>
            </FormSection>

            <FormSection title="UI & display" hint="Terminal-only display options; surfaced here for completeness.">
              <Field label="Theme" hint="PI terminal theme name">
                <TextInput value={form.theme} onChange={v => updateForm({ theme: v })} placeholder="dark" />
              </Field>
              <div className="flex items-center gap-6 flex-wrap">
                <Toggle checked={form.quietStartup} onChange={v => updateForm({ quietStartup: v })} label="Quiet startup" />
                <Toggle checked={form.collapseChangelog} onChange={v => updateForm({ collapseChangelog: v })} label="Collapse changelog" />
                <Toggle checked={form.enableInstallTelemetry} onChange={v => updateForm({ enableInstallTelemetry: v })} label="Install telemetry" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Double-escape action">
                  <Select value={form.doubleEscapeAction} onChange={v => updateForm({ doubleEscapeAction: v })} options={[{ value: "", label: "Default (tree)" }, { value: "tree", label: "Tree" }, { value: "fork", label: "Fork" }, { value: "none", label: "None" }]} />
                </Field>
                <Field label="Tree filter mode">
                  <Select value={form.treeFilterMode} onChange={v => updateForm({ treeFilterMode: v })} options={[{ value: "", label: "Default" }, { value: "default", label: "Default" }, { value: "no-tools", label: "No tools" }, { value: "user-only", label: "User only" }, { value: "labeled-only", label: "Labeled only" }, { value: "all", label: "All" }]} />
                </Field>
              </div>
              <Field label="Last changelog version">
                <TextInput value={form.lastChangelogVersion} onChange={v => updateForm({ lastChangelogVersion: v })} />
              </Field>
            </FormSection>

            <FormSection title="Resources" hint="Where PI loads extensions, skills, prompts, and themes from.">
              <Field label="Packages">
                <PackagesEditor value={form.packages} onChange={v => updateForm({ packages: v })} />
              </Field>
              <Field label="Extensions" hint="Local paths. Toggle on/off via the switch.">
                <EnabledStringList values={form.extensions} onChange={v => updateForm({ extensions: v })} placeholder="extensions/foo.ts" />
              </Field>
              <Field label="Skills" hint="Local paths. Toggle on/off via the switch.">
                <EnabledStringList values={form.skills} onChange={v => updateForm({ skills: v })} placeholder="skills/foo/SKILL.md" />
              </Field>
              <Field label="Prompts" hint="Local paths. Toggle on/off via the switch.">
                <EnabledStringList values={form.prompts} onChange={v => updateForm({ prompts: v })} placeholder="prompts/foo.md" />
              </Field>
              <Field label="Themes" hint="Local paths. Toggle on/off via the switch.">
                <EnabledStringList values={form.themes} onChange={v => updateForm({ themes: v })} placeholder="themes/foo.json" />
              </Field>
              <Toggle checked={form.enableSkillCommands} onChange={v => updateForm({ enableSkillCommands: v })} label="Register skills as /skill:name commands" />
            </FormSection>

            <FormSection title="Subagents" hint="Per-agent model overrides.">
              <Field label="Subagent model overrides">
                <AgentOverridesEditor value={form.agentOverrides} onChange={v => updateForm({ agentOverrides: v })} />
              </Field>
            </FormSection>
          </div>
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-ink-800/40">
            <span className="text-ink-500 text-[0.65rem] mr-auto">{settingsDirty ? "Unsaved changes" : "All changes saved"}</span>
            {settingsValidationError && (
              <span className="text-red-400 text-xs">{settingsValidationError}</span>
            )}
            <button
              type="button"
              onClick={handleSaveSettings}
              disabled={settingsSaving || !!settingsValidationError || !settingsDirty}
              className={`modal-button modal-button--primary text-xs ${settingsSaving || !!settingsValidationError || !settingsDirty ? "opacity-45 cursor-not-allowed" : ""}`}
            >
              {settingsSaving ? "Saving..." : "Save PI settings"}
            </button>
          </div>
          </div>
        )}
      </div>
    );
  };

  const renderPiModels = () => {
    if (modelsLoading) return <div className="flex-1 flex items-center justify-center text-ink-500 text-sm">Loading PI models...</div>;
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
              {modelsSaving ? "Saving..." : "Save models"}
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
        <h3 className="text-ink-200 text-sm font-medium">Chat</h3>
        <div className="space-y-2">
          <ChatPrefRow
            title="Auto-expand reasoning"
            desc="Show reasoning inline by default; flows with the chat."
            checked={chatPrefs.autoExpandReasoning}
            onChange={e => setChatPref("autoExpandReasoning", e.target.checked)}
            preview={<ReasoningPreview />}
          />
          <ChatPrefRow
            title="Auto-expand tool group"
            desc="Open the per-turn tool rail by default."
            checked={chatPrefs.autoExpandToolGroup}
            onChange={e => setChatPref("autoExpandToolGroup", e.target.checked)}
            preview={<ToolGroupPreview />}
          />
          <ChatPrefRow
            title="Auto-expand each tool call"
            desc="Open every tool's detail by default."
            checked={chatPrefs.autoExpandToolCalls}
            onChange={e => setChatPref("autoExpandToolCalls", e.target.checked)}
            preview={<ToolCallPreview />}
          />
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
          {projectSaving ? "Saving..." : "Save project settings"}
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
            {activeTab === "usage" && renderUsage()}
            {activeTab === "pi-settings" && renderPiSettings()}
            {activeTab === "pi-models" && renderPiModels()}
            {activeTab === "pi-web" && renderPiWeb()}
            {activeTab === "project" && renderProjectSettings()}
          </div>
          <div className="modal-footer mobile-safe-bottom">
            <button onClick={onClose} className="modal-button modal-button--primary">Done</button>
          </div>
        </div>
      </div>
    </div>
  );
}
