export const SCROLL_THRESHOLD = 120;
export const SCROLL_THROTTLE_MS = 100;
export const SESSION_FETCH_DELAY_MS = 1500;
export const NOTIFY_TIMEOUT_MS = 4000;
export const IMAGE_MAX_DIM = 1920;
export const IMAGE_QUALITY = 0.8;
export const SESSION_CACHE_TTL = 30000;
// Live-refresh backfills. The WS push misses mid-run session-summary changes
// (only fires on agent_end/session_loaded) and agent-driven git ops (no push
// exists at all). These polls close the gap; cheap: sessions are mtime-cached,
// git status is one fast subprocess.
export const SESSIONS_POLL_MS = 5000;
export const GIT_POLL_MS = 4000;
