import { useEffect, useState, useCallback, useRef } from "react";
import type { VersionInfo } from "@pi-web/shared";
import { Icon } from "./Icon";

/**
 * Sidebar widget that shows the running server's git commit + whether it
 * is up to date with `origin/<defaultBranch>`. Mirrors the design language
 * of the existing footer (tiny font, ink-500 muted, monospace).
 *
 * Polls `/api/version` every 5 minutes — cheap endpoint, no streaming
 * needed. Manual refresh via the icon button.
 */
export function VersionChecker() {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef<AbortController | null>(null);

  const fetchInfo = useCallback(async (withNetwork = true) => {
    inFlight.current?.abort();
    const ctrl = new AbortController();
    inFlight.current = ctrl;
    setLoading(true);
    setError(null);
    try {
      const url = withNetwork ? "/api/version" : "/api/version?noFetch=1";
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: VersionInfo = await res.json();
      setInfo(data);
    } catch (e: any) {
      if (e?.name !== "AbortError") {
        setError(e?.message || "Failed to load version");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch + 5-minute background refresh
  useEffect(() => {
    fetchInfo(true);
    const id = setInterval(() => fetchInfo(true), 5 * 60 * 1000);
    return () => {
      clearInterval(id);
      inFlight.current?.abort();
    };
  }, [fetchInfo]);

  // Loading / error states — keep the widget visible but uninformative
  if (error && !info) {
    return (
      <div
        className="px-4 pb-2.5 -mt-1 flex items-center gap-1.5 text-ink-500 text-[0.6rem] font-mono mobile-safe-bottom"
        title={error}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-rose-500/70 shrink-0" />
        <span className="truncate">version unavailable</span>
        <button
          onClick={() => fetchInfo(true)}
          className="ml-auto text-ink-500 hover:text-ink-300 transition-theme p-0.5"
          aria-label="Retry version check"
          title="Retry"
        >
          <Icon name="refresh" size={9} />
        </button>
      </div>
    );
  }

  if (!info) {
    return (
      <div className="px-4 pb-2.5 -mt-1 flex items-center gap-1.5 text-ink-500 text-[0.6rem] font-mono mobile-safe-bottom">
        <span className="w-1.5 h-1.5 rounded-full bg-ink-600 animate-pulse shrink-0" />
        <span>loading version…</span>
      </div>
    );
  }

  if (info.unavailable) {
    return (
      <div
        className="px-4 pb-2.5 -mt-1 flex items-center gap-1.5 text-ink-500 text-[0.6rem] font-mono mobile-safe-bottom"
        title="Server is not running from inside a git working tree"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-ink-600 shrink-0" />
        <span>no git info</span>
      </div>
    );
  }

  const dot = dotColor(info);
  const label = statusLabel(info);
  const tooltip = statusTooltip(info);

  return (
    <div
      className="px-4 pb-2.5 -mt-1 flex items-center gap-1.5 text-ink-500 text-[0.6rem] font-mono mobile-safe-bottom"
      title={tooltip}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot}`}
        aria-hidden
      />
      <span className="text-ink-400">{info.commit}</span>
      <span className="text-ink-600">·</span>
      <span className="truncate">{label}</span>
      <button
        onClick={() => fetchInfo(true)}
        disabled={loading}
        className="ml-auto text-ink-500 hover:text-ink-300 transition-theme p-0.5 disabled:opacity-40"
        aria-label="Refresh version info"
        title="Check for updates"
      >
        <Icon
          name="refresh"
          size={9}
          className={loading ? "animate-spin" : ""}
        />
      </button>
    </div>
  );
}

function dotColor(info: VersionInfo): string {
  if (info.dirty) return "bg-amber-500/80";
  if (info.behind > 0) return "bg-amber-500/80";
  if (info.ahead > 0) return "bg-teal-500/80";
  if (info.upToDate) return "bg-teal-500/70";
  if (!info.hasRemote) return "bg-ink-500/60";
  return "bg-ink-500/60";
}

function statusLabel(info: VersionInfo): string {
  if (info.dirty) return "uncommitted changes";
  if (info.behind > 0) return `${info.behind} behind ${info.defaultBranch}`;
  if (info.ahead > 0) return `${info.ahead} ahead of ${info.defaultBranch}`;
  if (info.upToDate) return `up to date`;
  if (!info.hasRemote) return `no origin/${info.defaultBranch}`;
  return info.branch;
}

function statusTooltip(info: VersionInfo): string {
  const lines = [
    `${info.branch} @ ${info.fullCommit || info.commit}`,
    info.commitMessage,
    info.dirty ? "Working tree has uncommitted changes." : "Working tree clean.",
  ];
  if (info.hasRemote) {
    if (info.ahead || info.behind) {
      lines.push(
        `${info.ahead} ahead, ${info.behind} behind origin/${info.defaultBranch}`,
      );
    } else if (info.upToDate) {
      lines.push(`Matches origin/${info.defaultBranch}.`);
    }
  } else {
    lines.push(
      `No origin/${info.defaultBranch} ref \u2014 cannot check for updates.`,
    );
  }
  lines.push(`Snapshot: ${new Date(info.fetchedAt).toLocaleTimeString()}`);
  return lines.filter(Boolean).join("\n");
}
