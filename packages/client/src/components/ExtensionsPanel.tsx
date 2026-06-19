import { useState, useEffect, useCallback, useRef, useMemo, type KeyboardEvent } from "react";
import { Icon } from "./Icon";
import { ConfirmDialog } from "./ConfirmDialog";
import { PackageDetailModal } from "./PackageDetailModal";

// ─── Types ───

type ExtensionScope = "global" | "project";

interface InstalledExtension {
  id: string;
  name: string;
  source: string;
  type: "package" | "local";
  scope: ExtensionScope;
  enabled: boolean;
  version?: string;
  description?: string;
  path?: string;
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
}

interface SearchResult {
  name: string;
  version: string;
  description: string;
  keywords: string[];
  date?: string;
  publisher?: string;
  links?: Record<string, string>;
  pi?: Record<string, unknown>;
  downloads?: number;
  weeklyDownloads?: number;
}

type TabView = "installed" | "search";
type SortMode = "mostDownloaded" | "recentlyUploaded" | "name";

const SORT_OPTIONS: { value: SortMode; label: string; icon: string }[] = [
  { value: "mostDownloaded", label: "Most Downloaded", icon: "arrow-up" },
  { value: "recentlyUploaded", label: "Recently Uploaded", icon: "clock" },
  { value: "name", label: "A–Z", icon: "hash" },
];

function formatDownloads(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ─── Component ───

interface ExtensionsPanelProps {
  visible: boolean;
  onClose: () => void;
  embedded?: boolean;
  project?: { id: string; path: string; name: string } | null;
}

export function ExtensionsPanel({ visible, onClose, embedded, project }: ExtensionsPanelProps) {
  const [tab, setTab] = useState<TabView>("installed");
  const [extensions, setExtensions] = useState<InstalledExtension[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>("mostDownloaded");
  const [installScope, setInstallScope] = useState<ExtensionScope>("global");
  const [installing, setInstalling] = useState<string | null>(null);
  const [uninstalling, setUninstalling] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [restartNotice, setRestartNotice] = useState(false);
  // Restart messaging: what changed + a persistent dot that survives banner dismissal.
  const [pendingRestart, setPendingRestart] = useState(false);
  const [restartReason, setRestartReason] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [selectedPackage, setSelectedPackage] = useState<string | null>(null);
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
  const hasLoadedDefaultRef = useRef(false);
  const mountedRef = useRef(true);
  // Allow aborting an in-flight install (cleanup on unmount / superseded install).
  const installAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
      searchAbortRef.current?.abort();
      installAbortRef.current?.abort();
    };
  }, []);

  // Fetch installed extensions
  const fetchExtensions = useCallback(async () => {
    setLoading(true);
    setError(null);
    setActionError(null);
    try {
      const query = project?.path ? `?cwd=${encodeURIComponent(project.path)}` : "";
      const res = await fetch(`/api/extensions${query}`);
      if (!res.ok) throw new Error("Failed to fetch extensions");
      const data = await res.json();
      if (mountedRef.current) setExtensions(data.extensions || []);
    } catch (e: any) {
      if (mountedRef.current) setError(e.message || "Failed to load extensions");
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [project?.path]);

  // If the selected project disappears while project scope is selected, fall back to global
  useEffect(() => {
    if (installScope === "project" && !project) {
      setInstallScope("global");
    }
  }, [installScope, project]);

  useEffect(() => {
    if (visible) fetchExtensions();
  }, [visible, fetchExtensions]);

  // Search with debounce
  const performSearch = useCallback(async (query: string, sort: SortMode) => {
    // Abort any in-flight search request
    searchAbortRef.current?.abort();
    const ctrl = new AbortController();
    searchAbortRef.current = ctrl;

    if (mountedRef.current) setSearchLoading(true);
    if (mountedRef.current) setSearchError(null);
    try {
      const params = new URLSearchParams();
      if (query.trim()) params.set("q", query.trim());
      params.set("sort", sort);
      const res = await fetch(`/api/extensions/search?${params}`, { signal: ctrl.signal });
      if (!res.ok) throw new Error("Search failed");
      const data = await res.json();
      // Only update if this is still the latest request
      if (searchAbortRef.current === ctrl && mountedRef.current) {
        setSearchResults(data.packages || []);
      }
    } catch (e: any) {
      if (e instanceof DOMException && e.name === "AbortError") return; // cancelled — ignore
      if (searchAbortRef.current === ctrl && mountedRef.current) {
        setSearchError(e.message || "Search failed");
      }
    } finally {
      if (searchAbortRef.current === ctrl && mountedRef.current) {
        setSearchLoading(false);
      }
    }
  }, []);

  // Load default most-downloaded results when search tab is opened
  useEffect(() => {
    if (tab === "search" && !hasLoadedDefaultRef.current) {
      hasLoadedDefaultRef.current = true;
      performSearch("", sortMode);
    }
  }, [tab, sortMode, performSearch]);

  // Re-search when sort mode changes
  const handleSortChange = useCallback((newSort: SortMode) => {
    setSortMode(newSort);
    performSearch(searchQuery, newSort);
  }, [searchQuery, performSearch]);

  const handleSearchInput = useCallback((value: string) => {
    setSearchQuery(value);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => performSearch(value, sortMode), 300);
  }, [sortMode, performSearch]);

  const handleRetrySearch = useCallback(() => {
    performSearch(searchQuery, sortMode);
  }, [searchQuery, sortMode, performSearch]);

  // Install extension (also used for Update = reinstall to latest).
  const handleInstall = useCallback(async (
    packageName: string,
    scope: ExtensionScope = installScope,
    action: "install" | "update" = "install",
  ) => {
    const source = `npm:${packageName}`;
    setInstalling(packageName);
    setActionError(null);
    // Abort a previous in-flight install so its finally doesn't clobber this one's state.
    installAbortRef.current?.abort();
    const ctrl = new AbortController();
    installAbortRef.current = ctrl;
    try {
      const body: { source: string; scope?: ExtensionScope; cwd?: string } = { source };
      if (scope === "project" && project?.path) {
        body.scope = "project";
        body.cwd = project.path;
      }
      const res = await fetch("/api/extensions/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const data = await res.json();
      if (!res.ok) {
        if (mountedRef.current) setActionError(data.error || "Installation failed");
        return;
      }
      setRestartNotice(true);
      setPendingRestart(true);
      setRestartReason(`${action === "update" ? "Updated" : "Installed"} ${packageName}`);
      fetchExtensions();
    } catch (e: any) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      if (mountedRef.current) setActionError(e.message || "Installation failed");
    } finally {
      if (mountedRef.current && installAbortRef.current === ctrl) {
        setInstalling(null);
      }
    }
  }, [fetchExtensions, installScope, project?.path]);

  // Uninstall extension
  const handleUninstall = useCallback((ext: InstalledExtension) => {
    setConfirmDialog({
      open: true,
      title: `Uninstall ${ext.name}?`,
      message: `This will remove ${ext.name} from your PI configuration. You'll need to restart PI for this to take effect.`,
      confirmLabel: "Uninstall",
      destructiveHint: false,
      onConfirm: async () => {
        setConfirmDialog(s => ({ ...s, open: false }));
        setUninstalling(ext.id);
        setActionError(null);
        try {
          const source = ext.type === "package" ? ext.source : ext.source;
          const body: { source: string; scope?: ExtensionScope; cwd?: string } = { source };
          if (ext.scope === "project" && project?.path) {
            body.scope = "project";
            body.cwd = project.path;
          }
          const res = await fetch("/api/extensions/uninstall", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          const data = await res.json();
          if (!res.ok) {
            setActionError(data.error || "Uninstall failed");
            return;
          }
          setRestartNotice(true);
          setPendingRestart(true);
          setRestartReason(`Uninstalled ${ext.name}`);
          fetchExtensions();
        } catch (e: any) {
          setActionError(e.message || "Uninstall failed");
        } finally {
          setUninstalling(null);
        }
      },
    });
  }, [fetchExtensions, project?.path]);

  // Toggle extension enabled/disabled.
  // ponytail: pi reads extension settings at boot, so toggle still requires a restart
  // to take effect. Hot-reload would need a backend settings-watch signal; deferred.
  const handleToggle = useCallback(async (ext: InstalledExtension) => {
    const newState = !ext.enabled;
    setToggling(ext.id);
    setActionError(null);
    try {
      const body: { enabled: boolean; scope?: ExtensionScope; cwd?: string } = { enabled: newState };
      if (ext.scope === "project" && project?.path) {
        body.scope = "project";
        body.cwd = project.path;
      }
      const res = await fetch(`/api/extensions/${encodeURIComponent(ext.id)}/toggle`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setActionError(data.error || "Toggle failed");
        return;
      }
      setRestartNotice(true);
      setPendingRestart(true);
      setRestartReason(`${newState ? "Enabled" : "Disabled"} ${ext.name}`);
      fetchExtensions();
    } catch (e: any) {
      setActionError(e.message || "Toggle failed");
    } finally {
      setToggling(null);
    }
  }, [fetchExtensions, project?.path]);

  // Poll until the server responds again, then reload — avoids landing on a dead
  // page if the restart is still in progress.
  const reconnectAndReload = useCallback(async () => {
    setReconnecting(true);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch("/api/extensions", { method: "GET" });
        if (res.ok) {
          window.location.reload();
          return;
        }
      } catch {
        /* server not back yet */
      }
      await new Promise(r => setTimeout(r, 500));
    }
    if (mountedRef.current) {
      setReconnecting(false);
      setActionError("PI is still restarting and didn't respond within 20s. Please refresh the page.");
    }
  }, []);

  // Restart all PI instances
  const handleRestart = useCallback(() => {
    setConfirmDialog({
      open: true,
      title: "Restart all PI instances?",
      message: "This will restart all running PI instances, not just PI Web. Any in-progress work (running agents, active tool calls, streaming responses) will be interrupted and lost. Make sure no critical tasks are running before proceeding.",
      confirmLabel: "Restart All",
      // Genuinely destructive — surface the real consequence, don't hide it.
      destructiveHint: "All running PI agents and streaming responses will be interrupted and lost.",
      onConfirm: async () => {
        setConfirmDialog(s => ({ ...s, open: false }));
        setRestartNotice(false);
        try {
          const res = await fetch("/api/extensions/restart", { method: "POST" });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            setActionError(data.error || "Failed to restart PI instances");
          } else {
            setPendingRestart(false);
            reconnectAndReload();
          }
        } catch (e: any) {
          setActionError(e.message || "Failed to restart PI instances");
        }
      },
    });
  }, [reconnectAndReload]);

  const handleDismissRestartNotice = useCallback(() => {
    // Keep pendingRestart true so the header dot stays until an actual restart.
    setRestartNotice(false);
  }, []);

  const handleDismissActionError = useCallback(() => {
    setActionError(null);
  }, []);

  const handleCopyError = useCallback(async () => {
    if (!actionError) return;
    try {
      await navigator.clipboard.writeText(actionError);
    } catch {
      /* clipboard may be unavailable */
    }
  }, [actionError]);

  const handlePackageClick = useCallback((name: string) => {
    setSelectedPackage(name);
  }, []);

  if (!visible) return null;

  // Detect which scope(s) the selected package is already installed in (across ALL scopes).
  const selectedPkgScopes = selectedPackage
    ? extensions
        .filter(e => e.type === "package" && (e.source === `npm:${selectedPackage}` || e.name === selectedPackage))
        .map(e => e.scope)
    : [];
  const selectedInCurrent = selectedPkgScopes.includes(installScope);
  const selectedElsewhere = selectedPkgScopes.find(s => s !== installScope) ?? null;

  return (
    <div className="extensions-panel flex flex-col h-full min-w-0 overflow-hidden">
      {/* Header */}
      <header className="extensions-panel-header shrink-0 flex items-center gap-2">
        <Icon name="puzzle" size={14} className="text-amber-500" />
        <div className="min-w-0">
          <div className="extensions-panel-eyebrow">Extensions</div>
          <div className="extensions-panel-heading">Packages &amp; skills</div>
        </div>
        {/* Persistent indicator that a restart is pending (survives banner dismissal). */}
        {pendingRestart && (
          <span
            className="extensions-panel-pending-dot"
            title="Extension changes are pending — restart to apply"
          />
        )}
        <div className="flex-1" />
        {embedded && (
          <button
            onClick={onClose}
            className="extensions-panel-icon-btn"
            aria-label="Close"
          >
            <Icon name="close" size={12} />
          </button>
        )}
      </header>

      {/* Action Error Banner */}
      {actionError && (
        <div className="extensions-panel-error-banner shrink-0" role="alert" aria-live="assertive">
          <div className="flex items-start gap-2">
            <Icon name="close-thick" size={12} className="text-rose-400 shrink-0 mt-0.5" />
            <p className="text-xs text-rose-300 flex-1 min-w-0 extensions-panel-error-text">{actionError}</p>
            <button
              onClick={handleCopyError}
              className="extensions-panel-dismiss-btn"
              aria-label="Copy error"
              title="Copy error text"
            >
              <Icon name="copy-plain" size={10} />
            </button>
            <button
              onClick={handleDismissActionError}
              className="extensions-panel-dismiss-btn"
              aria-label="Dismiss error"
            >
              <Icon name="close" size={10} />
            </button>
          </div>
        </div>
      )}

      {/* Restart Notice Banner */}
      {restartNotice && (
        <div className="extensions-panel-restart-banner shrink-0" role="status" aria-live="polite">
          <div className="flex items-start gap-2">
            <Icon name="spark" size={12} className="text-amber-400 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-amber-300">Restart Required</p>
              <p className="text-[0.65rem] text-ink-400 mt-0.5">
                {restartReason ? `${restartReason}. ` : ""}
                PI needs to be restarted for extension changes to take effect. This will restart all PI instances, not just PI Web.
              </p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                onClick={handleRestart}
                className="extensions-panel-restart-btn"
              >
                Restart All
              </button>
              <button
                onClick={handleDismissRestartNotice}
                className="extensions-panel-dismiss-btn"
                aria-label="Dismiss"
              >
                <Icon name="close" size={10} />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="extensions-panel-tabs shrink-0 flex border-b border-ink-800">
        <button
          onClick={() => setTab("installed")}
          className={`extensions-panel-tab ${tab === "installed" ? "active" : ""}`}
        >
          Installed
          {extensions.length > 0 && (
            <span className="extensions-panel-tab-count">{extensions.length}</span>
          )}
        </button>
        <button
          onClick={() => setTab("search")}
          className={`extensions-panel-tab ${tab === "search" ? "active" : ""}`}
        >
          Browse
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
        {tab === "installed" ? (
          <InstalledView
            extensions={extensions}
            loading={loading}
            error={error}
            toggling={toggling}
            uninstalling={uninstalling}
            installing={installing}
            onToggle={handleToggle}
            onUninstall={handleUninstall}
            onUpdate={(ext) => handleInstall(ext.source.replace(/^npm:/, ""), ext.scope, "update")}
            onRetry={fetchExtensions}
            onPackageClick={handlePackageClick}
          />
        ) : (
          <SearchView
            query={searchQuery}
            results={searchResults}
            loading={searchLoading}
            error={searchError}
            sortMode={sortMode}
            installing={installing}
            extensions={extensions}
            installScope={installScope}
            setInstallScope={setInstallScope}
            projectName={project?.name}
            onSearchInput={handleSearchInput}
            onSortChange={handleSortChange}
            onRetrySearch={handleRetrySearch}
            onInstall={handleInstall}
            onPackageClick={handlePackageClick}
          />
        )}
      </div>

      {/* Reconnecting overlay */}
      {reconnecting && (
        <div className="extensions-panel-reconnecting" role="status" aria-live="polite">
          <div className="extensions-panel-spinner" />
          <p className="text-ink-400 text-xs mt-2">Restarting PI…</p>
        </div>
      )}

      {/* Confirm Dialog */}
      <ConfirmDialog
        open={confirmDialog.open}
        title={confirmDialog.title}
        message={confirmDialog.message}
        confirmLabel={confirmDialog.confirmLabel}
        destructiveHint={confirmDialog.destructiveHint}
        onConfirm={() => { confirmDialog.onConfirm(); setConfirmDialog(s => ({ ...s, open: false })); }}
        onCancel={() => setConfirmDialog(s => ({ ...s, open: false }))}
      />

      {/* Package Detail Modal */}
      {selectedPackage && (
        <PackageDetailModal
          packageName={selectedPackage}
          onClose={() => setSelectedPackage(null)}
          onInstall={handleInstall}
          isInstalled={selectedInCurrent}
          installedElsewhere={selectedElsewhere}
          isInstalling={installing === selectedPackage}
          installScope={installScope}
          setInstallScope={project ? setInstallScope : undefined}
          projectName={project?.name}
        />
      )}
    </div>
  );
}

// ─── Installed View ───

function InstalledView({
  extensions,
  loading,
  error,
  toggling,
  uninstalling,
  installing,
  onToggle,
  onUninstall,
  onUpdate,
  onRetry,
  onPackageClick,
}: {
  extensions: InstalledExtension[];
  loading: boolean;
  error: string | null;
  toggling: string | null;
  uninstalling: string | null;
  installing: string | null;
  onToggle: (ext: InstalledExtension) => void;
  onUninstall: (ext: InstalledExtension) => void;
  onUpdate: (ext: InstalledExtension) => void;
  onRetry: () => void;
  onPackageClick: (name: string) => void;
}) {
  const [filter, setFilter] = useState("");

  if (loading && extensions.length === 0) {
    return (
      <div className="extensions-panel-empty">
        <div className="extensions-panel-spinner" />
        <p className="text-ink-500 text-xs mt-2">Loading extensions...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="extensions-panel-empty">
        <p className="text-rose-400 text-xs">{error}</p>
        <button onClick={onRetry} className="extensions-panel-retry-btn">Retry</button>
      </div>
    );
  }

  if (extensions.length === 0) {
    return (
      <div className="extensions-panel-empty">
        <Icon name="puzzle" size={24} className="text-ink-600 mb-2" />
        <p className="text-ink-400 text-xs">No extensions installed</p>
        <p className="text-ink-600 text-[0.65rem] mt-1">
          Browse the registry to find and install extensions
        </p>
      </div>
    );
  }

  // Sort: project before global, enabled first, then packages before local, then alphabetical
  const sorted = [...extensions].sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === "project" ? -1 : 1;
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    if (a.type !== b.type) return a.type === "package" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const q = filter.trim().toLowerCase();
  const filtered = q
    ? sorted.filter(e =>
        e.name.toLowerCase().includes(q) ||
        (e.description ?? "").toLowerCase().includes(q)
      )
    : sorted;

  return (
    <div className="extensions-panel-list">
      {/* Filter input (sticky so it stays visible while scrolling) */}
      <div className="extensions-panel-installed-filter">
        <div className="extensions-panel-search-input-wrap">
          <Icon name="search" size={12} className="text-ink-600 shrink-0" />
          <input
            type="text"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="Filter installed extensions..."
            aria-label="Filter installed extensions"
            className="extensions-panel-search-input"
            spellCheck={false}
          />
          {filter && (
            <button
              onClick={() => setFilter("")}
              className="extensions-panel-dismiss-btn"
              aria-label="Clear filter"
            >
              <Icon name="close" size={10} />
            </button>
          )}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="extensions-panel-empty">
          <Icon name="search" size={20} className="text-ink-700 mb-2" />
          <p className="text-ink-500 text-xs">No extensions match "{filter}"</p>
        </div>
      ) : (
        filtered.map(ext => (
          <ExtensionCard
            key={`${ext.scope}:${ext.id}`}
            extension={ext}
            toggling={toggling === ext.id}
            uninstalling={uninstalling === ext.id}
            updating={ext.type === "package" && installing === ext.source.replace(/^npm:/, "")}
            onToggle={() => onToggle(ext)}
            onUninstall={() => onUninstall(ext)}
            onUpdate={() => onUpdate(ext)}
            onPackageClick={onPackageClick}
          />
        ))
      )}
    </div>
  );
}

// ─── Extension Card ───

function ExtensionCard({
  extension: ext,
  toggling,
  uninstalling,
  updating,
  onToggle,
  onUninstall,
  onUpdate,
  onPackageClick,
}: {
  extension: InstalledExtension;
  toggling: boolean;
  uninstalling: boolean;
  updating: boolean;
  onToggle: () => void;
  onUninstall: () => void;
  onUpdate: () => void;
  onPackageClick: (name: string) => void;
}) {
  const isBusy = toggling || uninstalling || updating;

  const handlePackageClick = useCallback(() => {
    // For local extensions, use the name directly; for packages, strip npm: prefix
    const name = ext.type === "package" ? ext.source.replace(/^npm:/, "") : ext.name;
    onPackageClick(name);
  }, [ext, onPackageClick]);

  return (
    <div className={`extensions-panel-card ${!ext.enabled ? "disabled" : ""}`}>
      <div className="flex items-start gap-2.5 min-w-0">
        {/* Toggle Switch — proper switch semantics for screen readers */}
        <button
          onClick={onToggle}
          disabled={isBusy}
          role="switch"
          aria-checked={ext.enabled}
          className={`extensions-panel-toggle ${ext.enabled ? "on" : "off"}`}
          aria-label={ext.enabled ? "Disable extension" : "Enable extension"}
          title={ext.enabled ? "Click to disable" : "Click to enable"}
        >
          <span className="extensions-panel-toggle-thumb" />
        </button>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              className={`text-xs font-medium truncate pkg-name-clickable ${ext.enabled ? "text-ink-200" : "text-ink-500"}`}
              onClick={handlePackageClick}
            >
              {ext.name}
            </button>
            {ext.version && (
              <span className="text-[0.6rem] text-ink-600 font-mono shrink-0">
                v{ext.version}
              </span>
            )}
            <span className={`extensions-panel-type-badge ${ext.type}`}>
              {ext.type}
            </span>
            <span className={`extensions-panel-scope-badge ${ext.scope}`}>
              {ext.scope}
            </span>
          </div>
          {ext.description && (
            <p className={`text-[0.65rem] mt-0.5 line-clamp-2 ${ext.enabled ? "text-ink-500" : "text-ink-700"}`}>
              {ext.description}
            </p>
          )}
          {/* Resource tags */}
          <div className="flex flex-wrap gap-1 mt-1.5">
            {ext.extensions && ext.extensions.length > 0 && (
              <span className="extensions-panel-resource-tag">extensions</span>
            )}
            {ext.skills && ext.skills.length > 0 && (
              <span className="extensions-panel-resource-tag">skills</span>
            )}
            {ext.prompts && ext.prompts.length > 0 && (
              <span className="extensions-panel-resource-tag">prompts</span>
            )}
            {ext.themes && ext.themes.length > 0 && (
              <span className="extensions-panel-resource-tag">themes</span>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0">
          {toggling && (
            <div className="extensions-panel-spinner-sm" />
          )}
          {/* Update (reinstall to latest) — package type only */}
          {ext.type === "package" && !isBusy && (
            <button
              onClick={onUpdate}
              className="extensions-panel-action-btn"
              aria-label="Update to latest version"
              title="Update to latest version"
            >
              <Icon name="refresh" size={11} />
            </button>
          )}
          {updating && (
            <div className="extensions-panel-spinner-sm" />
          )}
          {ext.type === "package" && !uninstalling && !updating && (
            <button
              onClick={onUninstall}
              disabled={isBusy}
              className="extensions-panel-action-btn"
              aria-label="Uninstall"
              title="Uninstall extension"
            >
              <Icon name="trash" size={11} />
            </button>
          )}
          {/* Local extensions can't be removed here — explain why instead of hiding the affordance */}
          {ext.type === "local" && (
            <button
              type="button"
              disabled
              className="extensions-panel-action-btn"
              aria-label="Local extensions are managed in your pi settings"
              title="Local extensions are managed in your pi settings file, not from this panel"
            >
              <Icon name="trash" size={11} />
            </button>
          )}
          {uninstalling && (
            <div className="extensions-panel-spinner-sm" />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Search View ───

function SearchView({
  query,
  results,
  loading,
  error,
  sortMode,
  installing,
  extensions,
  installScope,
  setInstallScope,
  projectName,
  onSearchInput,
  onSortChange,
  onRetrySearch,
  onInstall,
  onPackageClick,
}: {
  query: string;
  results: SearchResult[];
  loading: boolean;
  error: string | null;
  sortMode: SortMode;
  installing: string | null;
  extensions: InstalledExtension[];
  installScope: ExtensionScope;
  setInstallScope: (scope: ExtensionScope) => void;
  projectName?: string | null;
  onSearchInput: (value: string) => void;
  onSortChange: (sort: SortMode) => void;
  onRetrySearch: () => void;
  onInstall: (name: string, scope: ExtensionScope) => void;
  onPackageClick: (name: string) => void;
}) {
  // Map package name → scopes where it's installed (across ALL scopes, not just the active one).
  const installedByScope = useMemo(() => {
    const map = new Map<string, ExtensionScope[]>();
    for (const e of extensions) {
      if (e.type !== "package") continue;
      const name = e.source.replace(/^npm:/, "");
      const arr = map.get(name);
      if (arr) arr.push(e.scope);
      else map.set(name, [e.scope]);
    }
    return map;
  }, [extensions]);

  const inputRef = useRef<HTMLInputElement>(null);
  // Keyboard navigation through results.
  const [focusedIdx, setFocusedIdx] = useState<number>(-1);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Auto-focus on mount
  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 100);
    return () => clearTimeout(timer);
  }, []);

  // Reset focus when the result set changes
  useEffect(() => {
    setFocusedIdx(-1);
  }, [results]);

  const handleSearchKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusedIdx(i => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusedIdx(i => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      if (focusedIdx >= 0 && focusedIdx < results.length) {
        e.preventDefault();
        onPackageClick(results[focusedIdx].name);
      }
    }
  }, [results, focusedIdx, onPackageClick]);

  // Scroll the focused card into view
  useEffect(() => {
    if (focusedIdx >= 0) {
      cardRefs.current[focusedIdx]?.scrollIntoView({ block: "nearest" });
    }
  }, [focusedIdx]);

  return (
    <div className="flex flex-col h-full">
      {/* Search Input */}
      <div className="shrink-0 px-3 py-2 border-b border-ink-800">
        <div className="extensions-panel-search-input-wrap">
          <Icon name="search" size={12} className="text-ink-600 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => onSearchInput(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="Search PI extensions..."
            aria-label="Search extensions"
            className="extensions-panel-search-input"
            spellCheck={false}
          />
          {loading && <div className="extensions-panel-spinner-sm" />}
        </div>

        {/* Scope selector */}
        <div className="flex items-center gap-1 mt-2">
          <span className="text-[0.6rem] text-ink-600 uppercase tracking-wider">Install scope</span>
          <button
            type="button"
            onClick={() => setInstallScope("global")}
            className={`extensions-panel-scope-pill ${installScope === "global" ? "active" : ""}`}
            disabled={!projectName}
            title="Install to global PI settings"
          >
            <Icon name="globe" size={9} />
            Global
          </button>
          <button
            type="button"
            onClick={() => setInstallScope("project")}
            className={`extensions-panel-scope-pill ${installScope === "project" ? "active" : ""} ${!projectName ? "disabled" : ""}`}
            disabled={!projectName}
            title={projectName ? `Install to ${projectName}` : "Open a project in the sidebar to install extensions locally"}
          >
            <Icon name="folder" size={9} />
            {projectName ? "Project" : "No project"}
          </button>
        </div>

        {/* Sort pills */}
        <div className="flex items-center gap-1 mt-2">
          {SORT_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => onSortChange(opt.value)}
              className={`extensions-panel-sort-pill ${sortMode === opt.value ? "active" : ""}`}
            >
              <Icon name={opt.icon as any} size={9} />
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Results */}
      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
        {error && (
          <div className="extensions-panel-empty">
            <p className="text-rose-400 text-xs">{error}</p>
            <button onClick={onRetrySearch} className="extensions-panel-retry-btn">Retry</button>
          </div>
        )}

        {/* Only show the spinner while actually loading. */}
        {loading && results.length === 0 && !error && (
          <div className="extensions-panel-empty">
            <div className="extensions-panel-spinner" />
            <p className="text-ink-500 text-xs mt-2">Loading extensions…</p>
          </div>
        )}

        {!loading && results.length === 0 && !error && (
          <div className="extensions-panel-empty">
            <Icon name="search" size={20} className="text-ink-700 mb-2" />
            <p className="text-ink-500 text-xs">
              {query ? `No extensions found for "${query}"` : "No extensions available"}
            </p>
          </div>
        )}

        {results.length > 0 && (
          <div className="extensions-panel-list">
            {!query && (
              <div className="extensions-panel-section-label">
                <Icon name={SORT_OPTIONS.find(o => o.value === sortMode)?.icon as any || "spark"} size={10} className="text-amber-500" />
                {SORT_OPTIONS.find(o => o.value === sortMode)?.label} extensions
              </div>
            )}
            {results.map((pkg, idx) => {
              const installedScopes = installedByScope.get(pkg.name) ?? [];
              const inCurrentScope = installedScopes.includes(installScope);
              const otherScope = installedScopes.find(s => s !== installScope) ?? null;
              const isInstalling = installing === pkg.name;
              const isFocused = focusedIdx === idx;

              return (
                <div
                  key={pkg.name}
                  ref={el => { cardRefs.current[idx] = el; }}
                  className={`extensions-panel-search-card ${isFocused ? "focused" : ""}`}
                >
                  <div className="flex items-start gap-2.5 min-w-0">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          className="text-xs font-medium truncate pkg-name-clickable text-ink-200"
                          onClick={() => onPackageClick(pkg.name)}
                        >
                          {pkg.name}
                        </button>
                        <span className="text-[0.6rem] text-ink-600 font-mono shrink-0">
                          v{pkg.version}
                        </span>
                      </div>
                      {pkg.description && (
                        <p className="text-[0.65rem] text-ink-500 mt-0.5 line-clamp-2">
                          {pkg.description}
                        </p>
                      )}
                      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                        {/* Weekly downloads only on the card; full breakdown lives in the detail modal. */}
                        {(pkg.weeklyDownloads ?? 0) > 0 && (
                          <span className="extensions-panel-downloads-badge" title={`${pkg.weeklyDownloads?.toLocaleString()} downloads this week`}>
                            <Icon name="spark" size={8} />
                            {formatDownloads(pkg.weeklyDownloads!)}/wk
                          </span>
                        )}
                        {/* Publisher */}
                        {pkg.publisher && (
                          <span className="text-[0.6rem] text-ink-700">
                            by {pkg.publisher}
                          </span>
                        )}
                        {/* Date */}
                        {pkg.date && (
                          <span className="text-[0.6rem] text-ink-700">
                            {new Date(pkg.date).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                      {pkg.keywords.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {pkg.keywords.slice(0, 5).map(kw => (
                            <span key={kw} className="extensions-panel-keyword-tag">{kw}</span>
                          ))}
                          {pkg.keywords.length > 5 && (
                            <span className="extensions-panel-keyword-tag" title={pkg.keywords.slice(5).join(", ")}>
                              +{pkg.keywords.length - 5}
                            </span>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Install Button */}
                    <div className="shrink-0 flex flex-col items-end gap-1">
                      {inCurrentScope ? (
                        <span className="extensions-panel-installed-badge">Installed</span>
                      ) : isInstalling ? (
                        <div className="extensions-panel-spinner-sm" />
                      ) : (
                        <button
                          onClick={() => onInstall(pkg.name, installScope)}
                          className="extensions-panel-install-btn"
                          title={`Install ${installScope === "project" && projectName ? `into ${projectName}` : "globally"} (may take up to 60s)`}
                        >
                          <Icon name="download" size={10} />
                          Install
                        </button>
                      )}
                      {/* Surface when it's already installed in another scope. */}
                      {otherScope && !inCurrentScope && (
                        <span className="text-[0.55rem] text-ink-700" title={`Already installed in ${otherScope} scope`}>
                          in {otherScope}
                        </span>
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
