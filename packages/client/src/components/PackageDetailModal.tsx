import { useState, useEffect, useCallback, useRef, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { Icon } from "./Icon";

function safeOpenUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  if (/^https?:\/\//i.test(url)) return url;
  return undefined;
}

// ─── Types ───

interface PackageDetail {
  name: string;
  description: string;
  latestVersion?: string;
  license?: string | null;
  homepage?: string | null;
  repository?: { type: string; url: string } | null;
  author?: { name: string; email?: string; url?: string } | null;
  maintainers: Array<{ name: string; email?: string | null }>;
  keywords: string[];
  pi?: Record<string, unknown> | null;
  dependencies: string[];
  peerDependencies: string[];
  readme: string | null;
  versions: Array<{ version: string; date: string }>;
  created: string | null;
  modified: string | null;
  downloads: number;
  weeklyDownloads: number;
}

// ─── Component ───

type ExtensionScope = "global" | "project";

interface PackageDetailModalProps {
  packageName: string;
  onClose: () => void;
  onInstall?: (name: string, scope: ExtensionScope) => void;
  isInstalled?: boolean;
  isInstalling?: boolean;
  installedElsewhere?: string | null;
  installScope?: ExtensionScope;
  setInstallScope?: (scope: ExtensionScope) => void;
  projectName?: string | null;
}

const titleId = "pkg-modal-title";

export function PackageDetailModal({
  packageName,
  onClose,
  onInstall,
  isInstalled,
  installedElsewhere,
  isInstalling,
  installScope = "global",
  setInstallScope,
  projectName,
}: PackageDetailModalProps) {
  const [detail, setDetail] = useState<PackageDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [readmeTab, setReadmeTab] = useState<"readme" | "versions" | "deps">("readme");
  const modalRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  // Initial focus, focus trap, and restore focus on close
  useEffect(() => {
    const modal = modalRef.current;
    if (!modal) return;
    triggerRef.current = document.activeElement as HTMLElement | null;
    modal.focus();

    const focusableSelector = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusable = Array.from(modal.querySelectorAll<HTMLElement>(focusableSelector)).filter(el => el.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    modal.addEventListener("keydown", handler);
    return () => {
      modal.removeEventListener("keydown", handler);
      triggerRef.current?.focus();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/extensions/detail?name=${encodeURIComponent(packageName)}`)
      .then(r => {
        if (!r.ok) throw new Error("Package not found");
        return r.json();
      })
      .then(data => {
        if (!cancelled) {
          setDetail(data.detail);
          setLoading(false);
        }
      })
      .catch(e => {
        if (!cancelled) {
          setError(e.message || "Failed to load package details");
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [packageName]);

  // Initial focus to the modal container for screen readers
  useEffect(() => {
    modalRef.current?.focus();
  }, []);

  const handleBackdropClick = useCallback((e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  }, [onClose]);


  // Escape key to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // Parse repo URL for display
  const repoUrl = detail?.repository?.url || detail?.homepage || null;
  const displayRepo = repoUrl
    ? repoUrl.replace(/^git\+/, "").replace(/\.git$/, "").replace(/^https?:\/\/(www\.)?/, "").replace(/#.*$/, "")
    : null;

  return createPortal(
    <div className="pkg-modal-backdrop" onClick={handleBackdropClick}>
      <div
        ref={modalRef}
        className="pkg-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="pkg-modal-header">
          <div className="pkg-modal-header-info">
            <h2 id={titleId} className="pkg-modal-title">{packageName}</h2>
            {detail?.latestVersion && (
              <span className="pkg-modal-version">v{detail.latestVersion}</span>
            )}
          </div>
          <div className="pkg-modal-header-actions">
            {setInstallScope && (
              <div className="pkg-modal-scope-switch" role="group" aria-label="Install scope">
                <button
                  type="button"
                  onClick={() => setInstallScope("global")}
                  className={`pkg-modal-scope-btn ${installScope === "global" ? "active" : ""}`}
                  title="Install to global PI settings"
                >
                  Global
                </button>
                <button
                  type="button"
                  onClick={() => setInstallScope("project")}
                  className={`pkg-modal-scope-btn ${installScope === "project" ? "active" : ""} ${!projectName ? "disabled" : ""}`}
                  disabled={!projectName}
                  title={projectName ? `Install to ${projectName}` : "Select a project to install locally"}
                >
                  {projectName ? "Project" : "No project"}
                </button>
              </div>
            )}
            {onInstall && !isInstalled && (
              <button
                onClick={() => onInstall(packageName, installScope)}
                disabled={isInstalling || (installScope === "project" && !projectName)}
                className="pkg-modal-install-btn"
              >
                {isInstalling ? (
                  <div className="extensions-panel-spinner-sm" />
                ) : (
                  <>
                    <Icon name="download" size={10} />
                    Install
                  </>
                )}
              </button>
            )}
            {(isInstalled || installedElsewhere) && (
              <span
                className="pkg-modal-installed-badge"
                title={isInstalled ? undefined : `Installed in ${installedElsewhere} scope`}
              >
                {isInstalled ? "Installed" : `Installed (${installedElsewhere})`}
              </span>
            )}
            <button onClick={onClose} className="pkg-modal-close-btn" aria-label="Close">
              <Icon name="close" size={14} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="pkg-modal-body">
          {loading && (
            <div className="pkg-modal-loading">
              <div className="extensions-panel-spinner" />
              <p className="text-ink-500 text-xs mt-3">Loading package details...</p>
            </div>
          )}

          {error && (
            <div className="pkg-modal-loading">
              <Icon name="close-thick" size={20} className="text-rose-400 mb-2" />
              <p className="text-rose-400 text-xs">{error}</p>
            </div>
          )}

          {detail && !loading && (
            <>
              {/* Description */}
              {detail.description && (
                <p className="pkg-modal-description">{detail.description}</p>
              )}

              {/* Meta grid */}
              <div className="pkg-modal-meta-grid">
                {detail.weeklyDownloads > 0 && (
                  <div className="pkg-modal-meta-item">
                    <span className="pkg-modal-meta-label">Weekly</span>
                    <span className="pkg-modal-meta-value">{detail.weeklyDownloads.toLocaleString()}/wk</span>
                  </div>
                )}
                {detail.downloads > 0 && (
                  <div className="pkg-modal-meta-item">
                    <span className="pkg-modal-meta-label">Monthly</span>
                    <span className="pkg-modal-meta-value">{detail.downloads.toLocaleString()}/mo</span>
                  </div>
                )}
                {detail.license && (
                  <div className="pkg-modal-meta-item">
                    <span className="pkg-modal-meta-label">License</span>
                    <span className="pkg-modal-meta-value">{detail.license}</span>
                  </div>
                )}
                {detail.author && (
                  <div className="pkg-modal-meta-item">
                    <span className="pkg-modal-meta-label">Author</span>
                    <span className="pkg-modal-meta-value">{detail.author.name}</span>
                  </div>
                )}
                {detail.created && (
                  <div className="pkg-modal-meta-item">
                    <span className="pkg-modal-meta-label">Published</span>
                    <span className="pkg-modal-meta-value">{new Date(detail.created).toLocaleDateString()}</span>
                  </div>
                )}
                {detail.modified && (
                  <div className="pkg-modal-meta-item">
                    <span className="pkg-modal-meta-label">Last updated</span>
                    <span className="pkg-modal-meta-value">{new Date(detail.modified).toLocaleDateString()}</span>
                  </div>
                )}
                {displayRepo && (
                  <div className="pkg-modal-meta-item pkg-modal-meta-wide">
                    <span className="pkg-modal-meta-label">Repository</span>
                    {safeOpenUrl(repoUrl) ? (
                      <a
                        href={safeOpenUrl(repoUrl)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="pkg-modal-meta-link"
                      >
                        {displayRepo}
                      </a>
                    ) : (
                      <span className="pkg-modal-meta-link">{displayRepo}</span>
                    )}
                  </div>
                )}
              </div>

              {/* Maintainers */}
              {detail.maintainers.length > 0 && (
                <div className="pkg-modal-section">
                  <span className="pkg-modal-section-label">Maintainers</span>
                  <div className="pkg-modal-maintainers">
                    {detail.maintainers.map(m => (
                      <span key={m.name} className="pkg-modal-maintainer-chip">{m.name}</span>
                    ))}
                  </div>
                </div>
              )}

              {/* Keywords */}
              {detail.keywords.length > 0 && (
                <div className="pkg-modal-section">
                  <span className="pkg-modal-section-label">Keywords</span>
                  <div className="pkg-modal-keywords">
                    {detail.keywords.filter(k => k !== "pi-package" && k !== "pi-extension").map(kw => (
                      <span key={kw} className="extensions-panel-keyword-tag">{kw}</span>
                    ))}
                  </div>
                </div>
              )}

              {/* PI Resources */}
              {detail.pi && (
                <div className="pkg-modal-section">
                  <span className="pkg-modal-section-label">PI Resources</span>
                  <div className="pkg-modal-pi-resources">
                    {Boolean((detail.pi as any).extensions) && (
                      <span className="pkg-modal-pi-tag extensions">Extensions</span>
                    )}
                    {Boolean((detail.pi as any).skills) && (
                      <span className="pkg-modal-pi-tag skills">Skills</span>
                    )}
                    {Boolean((detail.pi as any).prompts) && (
                      <span className="pkg-modal-pi-tag prompts">Prompts</span>
                    )}
                    {Boolean((detail.pi as any).themes) && (
                      <span className="pkg-modal-pi-tag themes">Themes</span>
                    )}
                  </div>
                </div>
              )}

              {/* Content tabs */}
              <div className="pkg-modal-tabs">
                <button
                  onClick={() => setReadmeTab("readme")}
                  className={`pkg-modal-tab ${readmeTab === "readme" ? "active" : ""}`}
                >
                  Readme
                </button>
                <button
                  onClick={() => setReadmeTab("versions")}
                  className={`pkg-modal-tab ${readmeTab === "versions" ? "active" : ""}`}
                >
                  Versions {detail.versions.length > 0 && <span className="pkg-modal-tab-count">{detail.versions.length}</span>}
                </button>
                <button
                  onClick={() => setReadmeTab("deps")}
                  className={`pkg-modal-tab ${readmeTab === "deps" ? "active" : ""}`}
                >
                  Dependencies
                  {(detail.dependencies.length + detail.peerDependencies.length) > 0 && (
                    <span className="pkg-modal-tab-count">{detail.dependencies.length + detail.peerDependencies.length}</span>
                  )}
                </button>
              </div>

              {/* Tab content */}
              <div className="pkg-modal-tab-content">
                {readmeTab === "readme" && (
                  <ReadmeView readme={detail.readme} />
                )}
                {readmeTab === "versions" && (
                  <VersionsView versions={detail.versions} />
                )}
                {readmeTab === "deps" && (
                  <DepsView dependencies={detail.dependencies} peerDependencies={detail.peerDependencies} />
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

// ─── Readme View ───

function ReadmeView({ readme }: { readme: string | null }) {
  if (!readme) {
    return (
      <div className="pkg-modal-empty-tab">
        <p className="text-ink-500 text-xs">No readme available</p>
      </div>
    );
  }

  return (
    <div className="pkg-modal-readme custom-scrollbar">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
        {readme}
      </ReactMarkdown>
    </div>
  );
}

// ─── Versions View ───

function VersionsView({ versions }: { versions: Array<{ version: string; date: string }> }) {
  if (versions.length === 0) {
    return (
      <div className="pkg-modal-empty-tab">
        <p className="text-ink-500 text-xs">No version history available</p>
      </div>
    );
  }

  return (
    <div className="pkg-modal-versions custom-scrollbar">
      {versions.map(v => (
        <div key={v.version} className="pkg-modal-version-row">
          <span className="pkg-modal-version-name">v{v.version}</span>
          <span className="pkg-modal-version-date">{new Date(v.date).toLocaleDateString()}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Dependencies View ───

function DepsView({ dependencies, peerDependencies }: { dependencies: string[]; peerDependencies: string[] }) {
  if (dependencies.length === 0 && peerDependencies.length === 0) {
    return (
      <div className="pkg-modal-empty-tab">
        <p className="text-ink-500 text-xs">No dependencies</p>
      </div>
    );
  }

  return (
    <div className="pkg-modal-deps custom-scrollbar">
      {peerDependencies.length > 0 && (
        <div className="pkg-modal-deps-section">
          <span className="pkg-modal-deps-section-label">Peer Dependencies</span>
          {peerDependencies.map(dep => (
            <div key={dep} className="pkg-modal-dep-row">
              <span className="pkg-modal-dep-name">{dep}</span>
              <span className="pkg-modal-dep-badge peer">peer</span>
            </div>
          ))}
        </div>
      )}
      {dependencies.length > 0 && (
        <div className="pkg-modal-deps-section">
          <span className="pkg-modal-deps-section-label">Runtime Dependencies</span>
          {dependencies.map(dep => (
            <div key={dep} className="pkg-modal-dep-row">
              <span className="pkg-modal-dep-name">{dep}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
