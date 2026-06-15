import { useState, useEffect, useCallback, useRef } from "react";
import { Icon } from "./Icon";
import { ConfirmDialog } from "./ConfirmDialog";
import { PackageDetailModal } from "./PackageDetailModal";

// ─── Types ───

interface InstalledExtension {
  id: string;
  name: string;
  source: string;
  type: "package" | "local";
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
}

export function ExtensionsPanel({ visible, onClose, embedded }: ExtensionsPanelProps) {
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
  const [installing, setInstalling] = useState<string | null>(null);
  const [uninstalling, setUninstalling] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [restartNotice, setRestartNotice] = useState(false);
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

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
      searchAbortRef.current?.abort();
    };
  }, []);

  // Fetch installed extensions
  const fetchExtensions = useCallback(async () => {
    setLoading(true);
    setError(null);
    setActionError(null);
    try {
      const res = await fetch("/api/extensions");
      if (!res.ok) throw new Error("Failed to fetch extensions");
      const data = await res.json();
      if (mountedRef.current) setExtensions(data.extensions || []);
    } catch (e: any) {
      if (mountedRef.current) setError(e.message || "Failed to load extensions");
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

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

  // Install extension
  const handleInstall = useCallback(async (packageName: string) => {
    const source = `npm:${packageName}`;
    setInstalling(packageName);
    setActionError(null);
    try {
      const res = await fetch("/api/extensions/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source }),
      });
      const data = await res.json();
      if (!res.ok) {
        setActionError(data.error || "Installation failed");
        return;
      }
      setRestartNotice(true);
      fetchExtensions();
    } catch (e: any) {
      setActionError(e.message || "Installation failed");
    } finally {
      setInstalling(null);
    }
  }, [fetchExtensions]);

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
          const res = await fetch("/api/extensions/uninstall", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ source }),
          });
          const data = await res.json();
          if (!res.ok) {
            setActionError(data.error || "Uninstall failed");
            return;
          }
          setRestartNotice(true);
          fetchExtensions();
        } catch (e: any) {
          setActionError(e.message || "Uninstall failed");
        } finally {
          setUninstalling(null);
        }
      },
    });
  }, [fetchExtensions]);

  // Toggle extension enabled/disabled
  const handleToggle = useCallback(async (ext: InstalledExtension) => {
    const newState = !ext.enabled;
    setToggling(ext.id);
    setActionError(null);
    try {
      const res = await fetch(`/api/extensions/${encodeURIComponent(ext.id)}/toggle`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: newState }),
      });
      const data = await res.json();
      if (!res.ok) {
        setActionError(data.error || "Toggle failed");
        return;
      }
      setRestartNotice(true);
      fetchExtensions();
    } catch (e: any) {
      setActionError(e.message || "Toggle failed");
    } finally {
      setToggling(null);
    }
  }, [fetchExtensions]);

  // Restart all PI instances
  const handleRestart = useCallback(() => {
    setConfirmDialog({
      open: true,
      title: "Restart all PI instances?",
      message: "This will restart all running PI instances, not just PI Web. Any in-progress work (running agents, active tool calls, streaming responses) will be interrupted and lost. Make sure no critical tasks are running before proceeding.",
      confirmLabel: "Restart All",
      destructiveHint: false,
      onConfirm: async () => {
        setConfirmDialog(s => ({ ...s, open: false }));
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

  const handleDismissRestartNotice = useCallback(() => {
    setRestartNotice(false);
  }, []);

  const handleDismissActionError = useCallback(() => {
    setActionError(null);
  }, []);

  const handlePackageClick = useCallback((name: string) => {
    setSelectedPackage(name);
  }, []);

  if (!visible) return null;

  return (
    <div className="extensions-panel flex flex-col h-full min-w-0 overflow-hidden">
      {/* Header */}
      <div className="extensions-panel-header shrink-0 flex items-center gap-2 px-3 py-2 border-b border-ink-800">
        <Icon name="puzzle" size={14} className="text-amber-500" />
        <span className="text-xs font-semibold text-ink-200 uppercase tracking-wider">Extensions</span>
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
      </div>

      {/* Action Error Banner */}
      {actionError && (
        <div className="extensions-panel-error-banner shrink-0" role="alert" aria-live="assertive">
          <div className="flex items-start gap-2">
            <Icon name="close-thick" size={12} className="text-rose-400 shrink-0 mt-0.5" />
            <p className="text-xs text-rose-300 flex-1 min-w-0">{actionError}</p>
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
            onToggle={handleToggle}
            onUninstall={handleUninstall}
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
            installedNames={extensions.filter(e => e.type === "package").map(e => e.source.replace(/^npm:/, ""))}
            onSearchInput={handleSearchInput}
            onSortChange={handleSortChange}
            onInstall={handleInstall}
            onPackageClick={handlePackageClick}
          />
        )}
      </div>

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
          isInstalled={extensions.filter(e => e.type === "package").some(e => e.source === `npm:${selectedPackage}` || e.name === selectedPackage)}
          isInstalling={installing === selectedPackage}
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
  onToggle,
  onUninstall,
  onRetry,
  onPackageClick,
}: {
  extensions: InstalledExtension[];
  loading: boolean;
  error: string | null;
  toggling: string | null;
  uninstalling: string | null;
  onToggle: (ext: InstalledExtension) => void;
  onUninstall: (ext: InstalledExtension) => void;
  onRetry: () => void;
  onPackageClick: (name: string) => void;
}) {
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

  // Sort: enabled first, then packages before local, then alphabetical
  const sorted = [...extensions].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    if (a.type !== b.type) return a.type === "package" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <div className="extensions-panel-list">
      {sorted.map(ext => (
        <ExtensionCard
          key={ext.id}
          extension={ext}
          toggling={toggling === ext.id}
          uninstalling={uninstalling === ext.id}
          onToggle={() => onToggle(ext)}
          onUninstall={() => onUninstall(ext)}
          onPackageClick={onPackageClick}
        />
      ))}
    </div>
  );
}

// ─── Extension Card ───

function ExtensionCard({
  extension: ext,
  toggling,
  uninstalling,
  onToggle,
  onUninstall,
  onPackageClick,
}: {
  extension: InstalledExtension;
  toggling: boolean;
  uninstalling: boolean;
  onToggle: () => void;
  onUninstall: () => void;
  onPackageClick: (name: string) => void;
}) {
  const isBusy = toggling || uninstalling;

  const handlePackageClick = useCallback(() => {
    // For local extensions, use the name directly; for packages, strip npm: prefix
    const name = ext.type === "package" ? ext.source.replace(/^npm:/, "") : ext.name;
    onPackageClick(name);
  }, [ext, onPackageClick]);

  return (
    <div className={`extensions-panel-card ${!ext.enabled ? "disabled" : ""}`}>
      <div className="flex items-start gap-2.5 min-w-0">
        {/* Toggle Switch */}
        <button
          onClick={onToggle}
          disabled={isBusy}
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
          {ext.type === "package" && !uninstalling && (
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
  installedNames,
  onSearchInput,
  onSortChange,
  onInstall,
  onPackageClick,
}: {
  query: string;
  results: SearchResult[];
  loading: boolean;
  error: string | null;
  sortMode: SortMode;
  installing: string | null;
  installedNames: string[];
  onSearchInput: (value: string) => void;
  onSortChange: (sort: SortMode) => void;
  onInstall: (name: string) => void;
  onPackageClick: (name: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus on mount
  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 100);
    return () => clearTimeout(timer);
  }, []);

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
            placeholder="Search PI extensions..."
            aria-label="Search extensions"
            className="extensions-panel-search-input"
            spellCheck={false}
          />
          {loading && <div className="extensions-panel-spinner-sm" />}
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
          </div>
        )}

        {!query && !loading && results.length === 0 && !error && (
          <div className="extensions-panel-empty">
            <div className="extensions-panel-spinner" />
            <p className="text-ink-500 text-xs mt-2">Loading extensions...</p>
          </div>
        )}

        {query && !loading && results.length === 0 && !error && (
          <div className="extensions-panel-empty">
            <Icon name="search" size={20} className="text-ink-700 mb-2" />
            <p className="text-ink-500 text-xs">No extensions found for "{query}"</p>
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
            {results.map(pkg => {
              const isAlreadyInstalled = installedNames.includes(pkg.name);
              const isInstalling = installing === pkg.name;

              return (
                <div key={pkg.name} className="extensions-panel-search-card">
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
                        {/* Downloads badges */}
                        {(pkg.weeklyDownloads ?? 0) > 0 && (
                          <span className="extensions-panel-downloads-badge" title={`${pkg.weeklyDownloads?.toLocaleString()} downloads this week`}>
                            <Icon name="spark" size={8} />
                            {formatDownloads(pkg.weeklyDownloads!)}/wk
                          </span>
                        )}
                        {(pkg.downloads ?? 0) > 0 && (
                          <span className="extensions-panel-downloads-badge extensions-panel-downloads-badge--total" title={`${pkg.downloads?.toLocaleString()} downloads this month`}>
                            <Icon name="arrow-up" size={8} />
                            {formatDownloads(pkg.downloads!)}/mo
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
                        </div>
                      )}
                    </div>

                    {/* Install Button */}
                    <div className="shrink-0">
                      {isAlreadyInstalled ? (
                        <span className="extensions-panel-installed-badge">Installed</span>
                      ) : isInstalling ? (
                        <div className="extensions-panel-spinner-sm" />
                      ) : (
                        <button
                          onClick={() => onInstall(pkg.name)}
                          className="extensions-panel-install-btn"
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
