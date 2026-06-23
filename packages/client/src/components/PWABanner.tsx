import { useState, useEffect } from "react";
import { usePWAInstall, useServiceWorkerUpdate, useOnlineStatus } from "../hooks/usePWA";
import { Icon } from "./Icon";
import { piWebStorage } from "../lib/piWebStorage";

// Persist dismissal in the DB so it doesn't reappear
function useDismissed(key: string): [boolean, () => void] {
  const storageKey = `pwa-dismiss-${key}`;
  const [dismissed, setDismissed] = useState(() => piWebStorage.getItem(storageKey) === "true");
  const dismiss = () => {
    setDismissed(true);
    piWebStorage.setItem(storageKey, "true");
  };
  return [dismissed, dismiss];
}

export function PWABanner() {
  const { isInstallable, isInstalled, install } = usePWAInstall();
  const { hasUpdate, applyUpdate } = useServiceWorkerUpdate();
  const isOnline = useOnlineStatus();
  const [installDismissed, dismissInstall] = useDismissed("install");
  const [updateDismissed, dismissUpdate] = useDismissed("update");

  // iOS detection — iOS has no `beforeinstallprompt` event.
  // Users must manually add to Home Screen via Share → "Add to Home Screen".
  const [isIOS, setIsIOS] = useState(false);
  const [showIOSHint, setShowIOSHint] = useState(false);
  const [iosHintDismissed, dismissIOSHint] = useDismissed("ios-install");

  useEffect(() => {
    const ua = navigator.userAgent;
    const inStandalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as any).standalone === true;
    setIsIOS(/iPhone|iPad|iPod/.test(ua) && !(window as any).MSStream && !inStandalone);
  }, []);

  // Show the iOS hint after 5s so the user has seen the app first
  useEffect(() => {
    if (!isIOS || iosHintDismissed) return;
    const t = setTimeout(() => setShowIOSHint(true), 5000);
    return () => clearTimeout(t);
  }, [isIOS, iosHintDismissed]);

  const showInstall = isInstallable && !isInstalled && !installDismissed;
  const showUpdate = hasUpdate && !updateDismissed;

  return (
    <>
      {/* Offline banner — always shown, not dismissible */}
      {!isOnline && (
        <div className="fixed top-0 left-0 right-0 z-[100] bg-ink-800 border-b border-ink-700 px-4 py-2 flex items-center justify-center gap-2 text-ink-200 text-xs font-mono">
          <span className="animate-pulse">●</span>
          <span>Offline — some features may be unavailable</span>
        </div>
      )}

      {/* Install prompt — Chrome/Edge only (fires `beforeinstallprompt`) */}
      {showInstall && (
        <div className="fixed top-12 left-3 right-3 md:top-12 md:left-auto md:right-4 md:w-80 z-[90] bg-ink-900/95 backdrop-blur-md border border-ink-700 rounded-xl px-3 py-2.5 flex items-center gap-2.5 shadow-lg animate-slide-down">
          <div className="w-8 h-8 rounded-lg bg-amber-600/20 flex items-center justify-center shrink-0">
            <Icon name="download" size={16} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-ink-100 text-sm font-medium">Install PI</div>
            <div className="text-ink-400 text-[0.7rem] leading-tight">Add to home screen for full-screen experience</div>
          </div>
          <button
            onClick={install}
            className="px-2.5 py-1 bg-amber-600 text-ink-950 rounded-lg text-[0.7rem] font-semibold hover:bg-amber-500 transition-theme shrink-0"
          >
            Install
          </button>
          <button
            onClick={dismissInstall}
            className="p-1 text-ink-500 hover:text-ink-300 transition-colors shrink-0 touch-target-sm"
            aria-label="Dismiss install prompt"
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      )}

      {/* iOS "Add to Home Screen" hint */}
      {isIOS && showIOSHint && !iosHintDismissed && (
        <div className="fixed top-12 left-3 right-3 md:top-12 md:left-auto md:right-4 md:w-80 z-[90] bg-ink-900/95 backdrop-blur-md border border-ink-700 rounded-xl px-3 py-2.5 flex items-center gap-2.5 shadow-lg animate-slide-down">
          <div className="w-8 h-8 rounded-lg bg-amber-600/20 flex items-center justify-center shrink-0">
            <Icon name="download" size={16} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-ink-100 text-sm font-medium">Install PI</div>
            <div className="text-ink-400 text-[0.7rem] leading-tight">Tap <strong>Share</strong> <span className="ml-0.5">⋯</span> then "Add to Home Screen"</div>
          </div>
          <button
            onClick={dismissIOSHint}
            className="p-1 text-ink-500 hover:text-ink-300 transition-colors shrink-0 touch-target-sm"
            aria-label="Dismiss install prompt"
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      )}

      {/* Update available — cascades below the install banner. */}
      {showUpdate && (
        <div className={`fixed ${showInstall ? 'top-[7.25rem] md:top-[7.25rem]' : 'top-12 md:top-12'} left-3 right-3 md:left-auto md:right-4 md:w-80 z-[89] bg-ink-900/95 backdrop-blur-md border border-amber-700/50 rounded-xl px-3 py-2.5 flex items-center gap-2.5 shadow-lg animate-slide-down`}>
          <div className="w-8 h-8 rounded-lg bg-amber-600/50 flex items-center justify-center shrink-0">
            <Icon name="refresh" size={16} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-ink-100 text-sm font-medium">Update available</div>
            <div className="text-ink-400 text-[0.7rem] leading-tight">A new version is ready</div>
          </div>
          <button
            onClick={applyUpdate}
            className="px-2.5 py-1 bg-amber-600 text-ink-950 rounded-lg text-[0.7rem] font-semibold hover:bg-amber-500 transition-theme shrink-0"
          >
            Update
          </button>
          <button
            onClick={dismissUpdate}
            className="p-1 text-ink-500 hover:text-ink-300 transition-colors shrink-0 touch-target-sm"
            aria-label="Dismiss update prompt"
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
    </>
  );
}
