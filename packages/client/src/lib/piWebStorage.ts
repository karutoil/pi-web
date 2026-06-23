/**
 * DB-backed key/value store that replaces localStorage for pi-web settings
 * (theme, panel widths, chat prefs, PWA dismissals).
 *
 * Seeds synchronously from `window.__PI_WEB_SETTINGS__`, which the server
 * inlines into index.html before the bundle loads — so theme/widths apply on
 * first paint with no flash and no localStorage. Writes persist to the DB via
 * per-key PUTs (debounced) and sync across tabs via BroadcastChannel.
 *
 * ponytail: drop-in localStorage shape so each consumer only swaps the backend;
 * native BroadcastChannel over a custom cross-tab sync layer.
 */

type Listener = () => void;

const listeners = new Set<Listener>();
function emit() { listeners.forEach((l) => l()); }

const bootstrap =
  (globalThis as unknown as { __PI_WEB_SETTINGS__?: Record<string, string> }).__PI_WEB_SETTINGS__;
let store: Record<string, string> =
  bootstrap && typeof bootstrap === "object" ? { ...bootstrap } : {};

/** True for keys this store owns (excludes pi-web-prompt-library, editor tabs, etc.). */
function isSettingKey(k: string): boolean {
  if (k === "pi-web-theme" || k === "pi-preview-width" ||
      k === "files-panel-explorer-width" || k === "pi-git-width") return true;
  if (k.startsWith("pi-web-auto-expand-")) return true;
  if (k.startsWith("pwa-dismiss-")) return true;
  return false;
}

// One-time migration: lift pre-DB localStorage settings into the DB, then drop
// them from localStorage. Runs only while old keys still linger locally.
try {
  const migrated: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !isSettingKey(k)) continue;
    if (!Object.prototype.hasOwnProperty.call(store, k)) {
      store[k] = localStorage.getItem(k) || "";
      migrated.push(k);
    }
  }
  if (migrated.length) {
    migrated.forEach((k) => schedulePut(k, store[k]));
    setTimeout(() => {
      try { migrated.forEach((k) => localStorage.removeItem(k)); } catch {}
    }, 2000);
  }
} catch {}

// Dev fallback: no bootstrap (Vite serves index.html without injection).
if (!bootstrap) {
  fetch("/api/pi-web-settings")
    .then((r) => (r.ok ? r.json() : {}))
    .then((d: Record<string, string>) => {
      store = { ...store, ...d };
      emit();
    })
    .catch(() => {});
}

// Debounced per-key PUT so rapid changes (e.g. dragging a panel) batch up.
const putTimers = new Map<string, ReturnType<typeof setTimeout>>();
function schedulePut(key: string, value: string | null) {
  const existing = putTimers.get(key);
  if (existing) clearTimeout(existing);
  putTimers.set(
    key,
    setTimeout(() => {
      putTimers.delete(key);
      const url = `/api/pi-web-settings/${encodeURIComponent(key)}`;
      if (value === null) {
        fetch(url, { method: "DELETE" }).catch(() => {});
      } else {
        fetch(url, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value }),
        }).catch(() => {});
      }
    }, 300),
  );
}

// Cross-tab sync. BroadcastChannel does not echo to the sender, so no loop.
const channel: BroadcastChannel | null =
  typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("pi-web-settings") : null;
channel?.addEventListener("message", (e) => {
  const msg = e.data as { key?: string; value?: string | null; clear?: boolean } | null;
  if (!msg) return;
  if (msg.clear) { store = {}; emit(); return; }
  if (typeof msg.key !== "string") return;
  if (msg.value === null || msg.value === undefined) delete store[msg.key];
  else store[msg.key] = msg.value;
  emit();
});

export const piWebStorage = {
  getItem(key: string): string | null {
    return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
  },
  setItem(key: string, value: string): void {
    const v = String(value);
    store[key] = v;
    schedulePut(key, v);
    channel?.postMessage({ key, value: v });
    emit();
  },
  removeItem(key: string): void {
    if (!Object.prototype.hasOwnProperty.call(store, key)) return;
    delete store[key];
    schedulePut(key, null);
    channel?.postMessage({ key, value: null });
    emit();
  },
  clear(): void {
    store = {};
    putTimers.forEach((t) => clearTimeout(t));
    putTimers.clear();
    fetch("/api/pi-web-settings", { method: "DELETE" }).catch(() => {});
    channel?.postMessage({ clear: true });
    emit();
  },
  /** Subscribe to changes (local writes + cross-tab updates). */
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
};
