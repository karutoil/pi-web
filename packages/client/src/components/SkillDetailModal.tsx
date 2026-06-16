import { useState, useEffect, useCallback, useRef, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { Icon } from "./Icon";

interface SkillDetail {
  name: string;
  source?: string;
  skillId?: string;
  path?: string;
  content: string;
}

interface SkillSummary {
  id: string;
  name: string;
  source?: string;
  skillId?: string;
  path?: string;
  installs?: number;
}

type SkillScope = "global" | "project";

interface SkillDetailModalProps {
  skill: SkillSummary;
  onClose: () => void;
  onInstall?: (skill: SkillSummary, scope: SkillScope) => void;
  isInstalled?: boolean;
  isInstalling?: boolean;
  installScope?: SkillScope;
  setInstallScope?: (scope: SkillScope) => void;
  projectName?: string | null;
}

export function SkillDetailModal({
  skill,
  onClose,
  onInstall,
  isInstalled,
  isInstalling,
  installScope = "global",
  setInstallScope,
  projectName,
}: SkillDetailModalProps) {
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const modal = modalRef.current;
    if (!modal) return;
    triggerRef.current = document.activeElement as HTMLElement | null;
    modal.focus();
    const focusableSelector = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusable = Array.from(modal.querySelectorAll<HTMLElement>(focusableSelector)).filter((el) => el.offsetParent !== null);
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
    modalRef.current?.focus();
  }, []);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    params.set("name", skill.name);
    if (skill.source) params.set("source", skill.source);
    if (skill.skillId) params.set("skillId", skill.skillId);
    if (skill.path) params.set("path", skill.path);
    fetch(`/api/skills/detail?${params}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Skill not found");
        return r.json();
      })
      .then((data) => {
        if (!cancelled) {
          setDetail(data as SkillDetail);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e.message || "Failed to load skill details");
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [skill.id, skill.name, skill.source, skill.skillId, skill.path]);

  const handleBackdropClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  const repoUrl = skill.source ? `https://github.com/${skill.source}` : undefined;
  const displayRepo = repoUrl ? repoUrl.replace(/^https?:\/\/(www\.)?/, "").replace(/\.git$/, "") : undefined;

  return createPortal(
    <div className="pkg-modal-backdrop" onClick={handleBackdropClick}>
      <div
        ref={modalRef}
        className="pkg-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="skill-modal-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="pkg-modal-header">
          <div className="pkg-modal-header-info">
            <h2 id="skill-modal-title" className="pkg-modal-title">
              {skill.name}
            </h2>
            {skill.installs !== undefined && skill.installs > 0 && (
              <span className="pkg-modal-version">{skill.installs.toLocaleString()} installs</span>
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
                  onClick={() => projectName && setInstallScope("project")}
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
                onClick={() => onInstall(skill, installScope)}
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
            {isInstalled && <span className="pkg-modal-installed-badge">Installed</span>}
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
              <p className="text-ink-500 text-xs mt-3">Loading skill details...</p>
            </div>
          )}

          {error && (
            <div className="pkg-modal-loading">
              <Icon name="close-thick" size={20} className="text-rose-400 mb-2" />
              <p className="text-rose-400 text-xs">{error}</p>
            </div>
          )}

          {!loading && !error && detail && (
            <div className="flex flex-col min-h-0 gap-3">
              {/* Meta */}
              <div className="pkg-modal-meta-grid">
                {skill.source && (
                  <div className="pkg-modal-meta-item pkg-modal-meta-wide">
                    <span className="pkg-modal-meta-label">Source</span>
                    <a
                      href={repoUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="pkg-modal-meta-link"
                    >
                      {displayRepo}
                    </a>
                  </div>
                )}
                {skill.path && (
                  <div className="pkg-modal-meta-item pkg-modal-meta-wide">
                    <span className="pkg-modal-meta-label">Path</span>
                    <span className="text-[0.6rem] text-ink-300 font-mono truncate" title={skill.path}>
                      {skill.path}
                    </span>
                  </div>
                )}
              </div>

              {/* Readme */}
              <div className="pkg-modal-readme custom-scrollbar flex-1 min-h-0">
                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
                  {detail.content}
                </ReactMarkdown>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
