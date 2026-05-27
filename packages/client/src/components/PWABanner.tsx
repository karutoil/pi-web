import { usePWAInstall, useServiceWorkerUpdate, useOnlineStatus } from "../hooks/usePWA";
import { Icon } from "./Icon";

export function PWABanner() {
  const { isInstallable, install } = usePWAInstall();
  const { hasUpdate, applyUpdate } = useServiceWorkerUpdate();
  const isOnline = useOnlineStatus();

  return (
    <>
      {/* Offline banner */}
      {!isOnline && (
        <div className="fixed top-0 left-0 right-0 z-[100] bg-ink-800 border-b border-ink-700 px-4 py-2 flex items-center justify-center gap-2 text-ink-200 text-xs font-mono">
          <span className="animate-pulse">●</span>
          <span>Offline — some features may be unavailable</span>
        </div>
      )}

      {/* Install prompt */}
      {isInstallable && (
        <div className="fixed bottom-4 left-4 right-4 md:left-auto md:right-4 md:w-80 z-[90] bg-ink-900/95 backdrop-blur-md border border-ink-700 rounded-xl px-4 py-3 flex items-center gap-3 shadow-lg">
          <div className="w-10 h-10 rounded-lg bg-amber-600/20 flex items-center justify-center shrink-0">
            <Icon name="download" size={18} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-ink-100 text-sm font-medium">Install PI</div>
            <div className="text-ink-400 text-xs">Add to home screen for full-screen experience</div>
          </div>
          <button
            onClick={install}
            className="px-3 py-1.5 bg-amber-600 text-ink-950 rounded-lg text-xs font-semibold hover:bg-amber-500 transition-theme shrink-0"
          >
            Install
          </button>
        </div>
      )}

      {/* Update available */}
      {hasUpdate && (
        <div className="fixed bottom-4 left-4 right-4 md:left-auto md:right-4 md:w-80 z-[90] bg-ink-900/95 backdrop-blur-md border border-amber-700/50 rounded-xl px-4 py-3 flex items-center gap-3 shadow-lg">
          <div className="w-10 h-10 rounded-lg bg-amber-600/20 flex items-center justify-center shrink-0">
            <Icon name="refresh" size={18} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-ink-100 text-sm font-medium">Update available</div>
            <div className="text-ink-400 text-xs">A new version is ready</div>
          </div>
          <button
            onClick={applyUpdate}
            className="px-3 py-1.5 bg-amber-600 text-ink-950 rounded-lg text-xs font-semibold hover:bg-amber-500 transition-theme shrink-0"
          >
            Update
          </button>
        </div>
      )}
    </>
  );
}
