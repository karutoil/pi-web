import { createAuthClient } from "better-auth/react";
import { twoFactorClient } from "better-auth/client/plugins";
import { passkeyClient } from "@better-auth/passkey/client";

// Same origin — the server mounts /api/auth/* and serves the client shell, so
// cookie auth rides along on every existing fetch("/api/...") with no changes.
export const authClient = createAuthClient({
  baseURL: typeof window !== "undefined" ? window.location.origin : "http://localhost:3069",
  plugins: [twoFactorClient(), passkeyClient()],
});

// ponytail: window.__PI_WEB_AUTH__ is injected by the server (withPiWebSettings)
// so the client gates synchronously — no flash of the app before the SignIn view.
// Ceiling: if the flag is wrong (stale HTML), useSession() reconciles on mount.
export const AUTH_ENABLED: boolean =
  typeof window !== "undefined" ? (window as any).__PI_WEB_AUTH__ === true : false;
