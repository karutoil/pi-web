import { useState, useEffect, useCallback, useRef } from "react";
import { Icon } from "./Icon";
import { ConfirmDialog } from "./ConfirmDialog";
import { SkillDetailModal } from "./SkillDetailModal";

type SkillScope = "global" | "project";

interface InstalledSkill {
  id: string;
  name: string;
  path: string;
  scope: SkillScope;
  enabled: boolean;
  agents: string[];
  source?: string;
}

interface SearchResult {
  id: string;
  skillId: string;
  name: string;
  source: string;
  installs: number;
}

interface SkillSummary {
  id: string;
  name: string;
  source?: string;
  skillId?: string;
  path?: string;
  installs?: number;
}

type TabView = "installed" | "search";

function formatInstalls(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

interface SkillsPanelProps {
  visible: boolean;
  onClose: () => void;
  embedded?: boolean;
  project?: { id: string; path: string; name: string } | null;
}

export function SkillsPanel({ visible, onClose, embedded, project }: SkillsPanelProps) {
  const [tab, setTab] = useState<TabView>("installed");
  const [skills, setSkills] = useState<InstalledSkill[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [installScope, setInstallScope] = useState<SkillScope>("global");
  const [installing, setInstalling] = useState<string | null>(null);
  const [uninstalling, setUninstalling] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [restartNotice, setRestartNotice] = useState(false);
  const [selectedSkill, setSelectedSkill] = useState<SearchResult | InstalledSkill | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean;
    title: string;
    message: string;
    confirmLabel?: string;
    destructiveHint?: string | false;
    onConfirm: () => void;
  }>({ open: false, title: "", message: "", onConfirm: () => {} });
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
      searchAbortRef.current?.abort();
    };
  }, []);

  const fetchSkills = useCallback(async () => {
    setLoading(true);
    setError(null);
    setActionError(null);
    try {
      const query = project?.path ? `?cwd=${encodeURIComponent(project.path)}` : "";
      const res = await fetch(`/api/skills${query}`);
      if (!res.ok) throw new Error("Failed to fetch skills");
      const data = await res.json();
      if (mountedRef.current) setSkills(data.skills || []);
    } catch (e: any) {
      if (mountedRef.current) setError(e.message || "Failed to load skills");
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [project?.path]);

  useEffect(() => {
    if (installScope === "project" && !project) setInstallScope("global");
  }, [installScope, project]);

  useEffect(() => {
    if (visible) fetchSkills();
  }, [visible, fetchSkills]);

  const performSearch = useCallback(async (query: string) => {
    const q = query.trim() || "all";
    searchAbortRef.current?.abort();
    const ctrl = new AbortController();
    searchAbortRef.current = ctrl;
    if (mountedRef.current) {
      setSearchLoading(true);
      setSearchError(null);
    }
    try {
      const res = await fetch(`/api/skills/search?${new URLSearchParams({ q })}`, {
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error("Search failed");
      const data = await res.json();
      if (searchAbortRef.current === ctrl && mountedRef.current) {
        setSearchResults(data.skills || []);
      }
    } catch (e: any) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      if (searchAbortRef.current === ctrl && mountedRef.current) {
        setSearchError(e.message || "Search failed");
      }
    } finally {
      if (searchAbortRef.current === ctrl && mountedRef.current) setSearchLoading(false);
    }
  }, []);

  const handleSearchInput = useCallback(
    (value: string) => {
      setSearchQuery(value);
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
      searchDebounceRef.current = setTimeout(() => performSearch(value), 300);
    },
    [performSearch],
  );

  // Load the default most-downloaded list when the Browse tab opens.
  useEffect(() => {
    if (tab === "search" && searchResults.length === 0 && !searchLoading) {
      performSearch(searchQuery);
    }
  }, [tab, searchResults.length, searchQuery, searchLoading, performSearch]);

  const handleInstall = useCallback(
    async (result: SkillSummary, scope: SkillScope = installScope) => {
      if (!result.source || !result.skillId) return;
      setInstalling(result.id);
      setActionError(null);
      try {
        const body: { source: string; skillId: string; scope?: SkillScope; cwd?: string } = {
          source: result.source,
          skillId: result.skillId,
        };
        if (scope === "project" && project?.path) {
          body.scope = "project";
          body.cwd = project.path;
        }
        const res = await fetch("/api/skills/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) {
          setActionError(data.error || "Installation failed");
          return;
        }
        setRestartNotice(true);
        fetchSkills();
      } catch (e: any) {
        setActionError(e.message || "Installation failed");
      } finally {
        setInstalling(null);
      }
    },
    [fetchSkills, installScope, project?.path],
  );

  const handleUninstall = useCallback(
    (skill: InstalledSkill) => {
      setConfirmDialog({
        open: true,
        title: `Remove ${skill.name}?`,
        message: `This will remove ${skill.name} from the ${skill.scope} PI skills directory.`,
        confirmLabel: "Remove",
        destructiveHint: false,
        onConfirm: async () => {
          setConfirmDialog((s) => ({ ...s, open: false }));
          setUninstalling(skill.id);
          setActionError(null);
          try {
            const body: { name: string; scope?: SkillScope; cwd?: string } = { name: skill.name };
            if (skill.scope === "project" && project?.path) {
              body.scope = "project";
              body.cwd = project.path;
            }
            const res = await fetch("/api/skills/uninstall", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            });
            const data = await res.json();
            if (!res.ok) {
              setActionError(data.error || "Remove failed");
              return;
            }
            setRestartNotice(true);
            fetchSkills();
          } catch (e: any) {
            setActionError(e.message || "Remove failed");
          } finally {
            setUninstalling(null);
          }
        },
      });
    },
    [fetchSkills, project?.path],
  );

  const handleToggle = useCallback(
    async (skill: InstalledSkill) => {
      const newState = !skill.enabled;
      setToggling(skill.id);
      setActionError(null);
      try {
        const body: { enabled: boolean; scope?: SkillScope; cwd?: string } = { enabled: newState };
        if (skill.scope === "project" && project?.path) {
          body.scope = "project";
          body.cwd = project.path;
        }
        const res = await fetch(`/api/skills/${encodeURIComponent(skill.name)}/toggle`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) {
          setActionError(data.error || "Toggle failed");
          return;
        }
        if (newState) setRestartNotice(true);
        fetchSkills();
      } catch (e: any) {
        setActionError(e.message || "Toggle failed");
      } finally {
        setToggling(null);
      }
    },
    [fetchSkills, project?.path],
  );

  const handleRestart = useCallback(() => {
    setConfirmDialog({
      open: true,
      title: "Restart all PI instances?",
      message:
        "This will restart all running PI instances, not just PI Web. Any in-progress work will be interrupted and lost.",
      confirmLabel: "Restart All",
      destructiveHint: false,
      onConfirm: async () => {
        setConfirmDialog((s) => ({ ...s, open: false }));
        setRestartNotice(false);
        try {
          const res = await fetch("/api/extensions/restart", { method: "POST" });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            setActionError(data.error || "Failed to restart PI instances");
          } else {
            window.location.reload();
          }
        } catch (e: any) {
          setActionError(e.message || "Failed to restart PI instances");
        }
      },
    });
  }, []);

  if (!visible) return null;

  return (
    <div className="extensions-panel flex flex-col h-full min-w-0 overflow-hidden">
      <div className="extensions-panel-header shrink-0 flex items-center gap-2 px-3 py-2 border-b border-ink-800">
        <Icon name="spark" size={14} className="text-amber-500" />
        <span className="text-xs font-semibold text-ink-200 uppercase tracking-wider">Skills</span>
        <div className="flex-1" />
        {embedded && (
          <button onClick={onClose} className="extensions-panel-icon-btn" aria-label="Close">
            <Icon name="close" size={12} />
          </button>
        )}
      </div>

      {actionError && (
        <div className="extensions-panel-error-banner shrink-0" role="alert" aria-live="assertive">
          <div className="flex items-start gap-2">
            <Icon name="close-thick" size={12} className="text-rose-400 shrink-0 mt-0.5" />
            <p className="text-xs text-rose-300 flex-1 min-w-0">{actionError}</p>
            <button
              onClick={() => setActionError(null)}
              className="extensions-panel-dismiss-btn"
              aria-label="Dismiss error"
            >
              <Icon name="close" size={10} />
            </button>
          </div>
        </div>
      )}

      {restartNotice && (
        <div className="extensions-panel-restart-banner shrink-0" role="status" aria-live="polite">
          <div className="flex items-start gap-2">
            <Icon name="spark" size={12} className="text-amber-400 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-amber-300">Restart Required</p>
              <p className="text-[0.65rem] text-ink-400 mt-0.5">
                PI needs to be restarted for skill changes to take effect.
              </p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button onClick={handleRestart} className="extensions-panel-restart-btn">
                Restart All
              </button>
              <button
                onClick={() => setRestartNotice(false)}
                className="extensions-panel-dismiss-btn"
                aria-label="Dismiss"
              >
                <Icon name="close" size={10} />
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="extensions-panel-tabs shrink-0 flex border-b border-ink-800">
        <button
          onClick={() => setTab("installed")}
          className={`extensions-panel-tab ${tab === "installed" ? "active" : ""}`}
        >
          Installed
          {skills.length > 0 && <span className="extensions-panel-tab-count">{skills.length}</span>}
        </button>
        <button
          onClick={() => setTab("search")}
          className={`extensions-panel-tab ${tab === "search" ? "active" : ""}`}
        >
          Browse
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
        {tab === "installed" ? (
          <InstalledView
            skills={skills}
            loading={loading}
            error={error}
            toggling={toggling}
            uninstalling={uninstalling}
            onToggle={handleToggle}
            onUninstall={handleUninstall}
            onRetry={fetchSkills}
            onSelect={setSelectedSkill}
          />
        ) : (
          <SearchView
            query={searchQuery}
            results={searchResults}
            loading={searchLoading}
            error={searchError}
            installing={installing}
            installed={skills}
            installScope={installScope}
            setInstallScope={setInstallScope}
            projectName={project?.name}
            onSearchInput={handleSearchInput}
            onInstall={handleInstall}
            onSelect={setSelectedSkill}
          />
        )}
      </div>

      <ConfirmDialog
        open={confirmDialog.open}
        title={confirmDialog.title}
        message={confirmDialog.message}
        confirmLabel={confirmDialog.confirmLabel}
        destructiveHint={confirmDialog.destructiveHint}
        onConfirm={() => {
          confirmDialog.onConfirm();
          setConfirmDialog((s) => ({ ...s, open: false }));
        }}
        onCancel={() => setConfirmDialog((s) => ({ ...s, open: false }))}
      />

      {selectedSkill && (
        <SkillDetailModal
          skill={selectedSkill}
          onClose={() => setSelectedSkill(null)}
          onInstall={selectedSkill.source ? handleInstall : undefined}
          isInstalled={skills.some(
            (s) =>
              s.name === selectedSkill.name &&
              s.scope === installScope
          )}
          isInstalling={installing === selectedSkill.id}
          installScope={installScope}
          setInstallScope={project ? setInstallScope : undefined}
          projectName={project?.name}
        />
      )}
    </div>
  );
}

function InstalledView({
  skills,
  loading,
  error,
  toggling,
  uninstalling,
  onToggle,
  onUninstall,
  onRetry,
  onSelect,
}: {
  skills: InstalledSkill[];
  loading: boolean;
  error: string | null;
  toggling: string | null;
  uninstalling: string | null;
  onToggle: (skill: InstalledSkill) => void;
  onUninstall: (skill: InstalledSkill) => void;
  onRetry: () => void;
  onSelect: (skill: InstalledSkill) => void;
}) {
  if (loading && skills.length === 0) {
    return (
      <div className="extensions-panel-empty">
        <div className="extensions-panel-spinner" />
        <p className="text-ink-500 text-xs mt-2">Loading skills...</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="extensions-panel-empty">
        <p className="text-rose-400 text-xs">{error}</p>
        <button onClick={onRetry} className="extensions-panel-retry-btn">
          Retry
        </button>
      </div>
    );
  }
  if (skills.length === 0) {
    return (
      <div className="extensions-panel-empty">
        <Icon name="spark" size={24} className="text-ink-600 mb-2" />
        <p className="text-ink-400 text-xs">No skills installed</p>
        <p className="text-ink-600 text-[0.65rem] mt-1">Browse skills.sh to install one.</p>
      </div>
    );
  }

  const sorted = [...skills].sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === "project" ? -1 : 1;
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <div className="extensions-panel-list">
      {sorted.map((skill) => (
        <div key={skill.id} className={`extensions-panel-card ${!skill.enabled ? "disabled" : ""}`}>
          <div className="flex items-start gap-2.5 min-w-0">
            <button
              onClick={() => onToggle(skill)}
              disabled={toggling === skill.id || uninstalling === skill.id}
              className={`extensions-panel-toggle ${skill.enabled ? "on" : "off"}`}
              aria-label={skill.enabled ? "Disable skill" : "Enable skill"}
              title={skill.enabled ? "Click to disable" : "Click to enable"}
            >
              <span className="extensions-panel-toggle-thumb" />
            </button>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => onSelect(skill)}
                  className={`text-xs font-medium truncate pkg-name-clickable ${skill.enabled ? "text-ink-200" : "text-ink-500"}`}
                  title="View details"
                >
                  {skill.name}
                </button>
                <span className={`extensions-panel-scope-badge ${skill.scope}`}>{skill.scope}</span>
              </div>
              {skill.source && <p className="text-[0.6rem] text-ink-600 mt-0.5 truncate">{skill.source}</p>}
              {skill.agents.length > 0 && (
                <p className="text-[0.6rem] text-ink-700 mt-0.5">Agents: {skill.agents.join(", ")}</p>
              )}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {toggling === skill.id && <div className="extensions-panel-spinner-sm" />}
              {uninstalling === skill.id ? (
                <div className="extensions-panel-spinner-sm" />
              ) : (
                <button
                  onClick={() => onUninstall(skill)}
                  disabled={toggling === skill.id || uninstalling === skill.id}
                  className="extensions-panel-action-btn"
                  aria-label="Remove"
                  title="Remove skill"
                >
                  <Icon name="trash" size={11} />
                </button>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function SearchView({
  query,
  results,
  loading,
  error,
  installing,
  installed,
  installScope,
  setInstallScope,
  projectName,
  onSearchInput,
  onInstall,
  onSelect,
}: {
  query: string;
  results: SearchResult[];
  loading: boolean;
  error: string | null;
  installing: string | null;
  installed: InstalledSkill[];
  installScope: SkillScope;
  setInstallScope: (scope: SkillScope) => void;
  projectName?: string | null;
  onSearchInput: (value: string) => void;
  onInstall: (result: SkillSummary, scope: SkillScope) => void;
  onSelect: (result: SearchResult) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 100);
    return () => clearTimeout(timer);
  }, []);

  const installedNamesInScope = new Set(
    installed.filter((s) => s.scope === installScope || installScope === "global" ? s.scope === installScope : false).map((s) => s.name),
  );

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 px-3 py-2 border-b border-ink-800">
        <div className="extensions-panel-search-input-wrap">
          <Icon name="search" size={12} className="text-ink-600 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => onSearchInput(e.target.value)}
            placeholder="Search skills.sh..."
            aria-label="Search skills"
            className="extensions-panel-search-input"
            spellCheck={false}
          />
          {loading && <div className="extensions-panel-spinner-sm" />}
        </div>

        <div className="flex items-center gap-1 mt-2">
          <span className="text-[0.6rem] text-ink-600 uppercase tracking-wider">Install scope</span>
          <button
            type="button"
            onClick={() => setInstallScope("global")}
            className={`extensions-panel-scope-pill ${installScope === "global" ? "active" : ""}`}
            title="Install to global PI settings"
          >
            <Icon name="globe" size={9} />
            Global
          </button>
          <button
            type="button"
            onClick={() => projectName && setInstallScope("project")}
            className={`extensions-panel-scope-pill ${installScope === "project" ? "active" : ""} ${!projectName ? "disabled" : ""}`}
            disabled={!projectName}
            title={projectName ? `Install to ${projectName}` : "Select a project to install locally"}
          >
            <Icon name="folder" size={9} />
            {projectName ? "Project" : "No project"}
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
        {error && (
          <div className="extensions-panel-empty">
            <p className="text-rose-400 text-xs">{error}</p>
          </div>
        )}
        {!query && !loading && results.length === 0 && !error && (
          <div className="extensions-panel-empty">
            <div className="extensions-panel-spinner" />
            <p className="text-ink-500 text-xs mt-2">Loading top skills...</p>
          </div>
        )}
        {!query && !loading && results.length > 0 && !error && (
          <div className="extensions-panel-section-label px-3 py-2">
            <Icon name="spark" size={10} className="text-amber-500" />
            Most downloaded skills
          </div>
        )}
        {query && !loading && results.length === 0 && !error && (
          <div className="extensions-panel-empty">
            <Icon name="search" size={20} className="text-ink-700 mb-2" />
            <p className="text-ink-500 text-xs">No skills found for &quot;{query}&quot;</p>
          </div>
        )}
        {results.length > 0 && (
          <div className="extensions-panel-list">
            {results.map((result) => {
              const isInstalling = installing === result.id;
              const isInstalled = installedNamesInScope.has(result.name);
              return (
                <div key={result.id} className="extensions-panel-search-card">
                  <div className="flex items-start gap-2.5 min-w-0">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => onSelect(result)}
                          className="text-xs font-medium truncate pkg-name-clickable text-ink-200"
                          title="View details"
                        >
                          {result.name}
                        </button>
                        <span className="text-[0.6rem] text-ink-600 font-mono shrink-0">
                          {formatInstalls(result.installs)} installs
                        </span>
                      </div>
                      <p className="text-[0.65rem] text-ink-600 mt-0.5 truncate">{result.source}</p>
                    </div>
                    <div className="shrink-0">
                      {isInstalled ? (
                        <span className="extensions-panel-installed-badge">Installed</span>
                      ) : isInstalling ? (
                        <div className="extensions-panel-spinner-sm" />
                      ) : (
                        <button
                          onClick={() => onInstall(result, installScope)}
                          className="extensions-panel-install-btn"
                          title={
                            installScope === "project" && projectName
                              ? `Install into ${projectName}`
                              : "Install globally"
                          }
                        >
                          <Icon name="download" size={10} />
                          Install
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
