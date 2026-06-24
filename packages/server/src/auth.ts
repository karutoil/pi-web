import { betterAuth } from "better-auth";
import { twoFactor } from "better-auth/plugins/two-factor";
import { passkey } from "@better-auth/passkey";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import type { MiddlewareHandler } from "hono";

// ─── Auth enable flag ─────────────────────────────────────────────────────
// ponytail: single env flag, no settings-UI toggle (single-user local tool).
// Auto-on when bound beyond loopback — docker-compose sets HOST=0.0.0.0 and
// exposes the port with $HOME mounted RW, which is unauthenticated RCE.
// PI_WEB_AUTH=off forces open (localhost dev); =on forces on (testing).
// requireAuth/wsAuthOk re-evaluate this per request so the flag can be toggled
// without a restart; AUTH_ENABLED below is the boot snapshot for the HTML flag.
export function computeAuthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.PI_WEB_AUTH === "on") return true;
  if (env.PI_WEB_AUTH === "off") return false;
  // auto: on only when explicitly bound beyond loopback. Unset HOST means the
  // server binds 127.0.0.1 (localhost dev) → safe → auth off. docker-compose
  // sets HOST=0.0.0.0 → on.
  const host = env.HOST;
  return (
    !!host &&
    host !== "127.0.0.1" &&
    host !== "localhost" &&
    host !== "::1" &&
    host !== "[::1]"
  );
}
export const AUTH_ENABLED = computeAuthEnabled();

// ─── DB + secret ───────────────────────────────────────────────────────────
const PI_WEB_DIR = join(homedir(), ".pi-web");
// ponytail: PI_WEB_DB_PATH override lets tests (and split-DB deployments) point
// auth at a separate SQLite file. Default reuses the existing app DB.
const DB_PATH = process.env.PI_WEB_DB_PATH || join(PI_WEB_DIR, ".pi-web.db");
const SECRET_PATH = join(PI_WEB_DIR, ".auth_secret");

function loadSecret(): string {
  if (process.env.BETTER_AUTH_SECRET) return process.env.BETTER_AUTH_SECRET;
  try {
    if (existsSync(SECRET_PATH)) return readFileSync(SECRET_PATH, "utf-8").trim();
  } catch (e: any) {
    // Don't silently swallow — a read failure would otherwise overwrite the
    // existing secret and invalidate every active session.
    console.error("[auth] failed to read existing secret, generating a new one:", e?.message);
  }
  // ponytail: persistent random secret in a 0600 file — survives restarts
  // without env plumbing. Upgrade path: BETTER_AUTH_SECRET env for deployments.
  mkdirSync(PI_WEB_DIR, { recursive: true });
  const generated = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  writeFileSync(SECRET_PATH, generated, { mode: 0o600 });
  try { chmodSync(SECRET_PATH, 0o600); } catch {}
  return generated;
}

const PORT = process.env.PORT || "3069";
// baseURL is the origin clients reach the server at. Drives passkey rpID/origin.
const baseURL = process.env.BETTER_AUTH_URL || `http://localhost:${PORT}`;
const rpHost = (() => { try { return new URL(baseURL).hostname; } catch { return "localhost"; } })();

// Separate connection to the same SQLite file. WAL (set by db.ts) allows a
// concurrent reader/writer; better-auth owns its own tables here.
const authDb = new Database(DB_PATH, { create: true });
authDb.run("PRAGMA journal_mode = WAL");
authDb.run("PRAGMA foreign_keys = ON");

// ponytail: single-user — block any second account at the data layer so public
// sign-up can't create a rival admin. The admin is either seeded by initAuth()
// (when PI_WEB_ADMIN_EMAIL is set) or created by the first manual sign-up.
// Ceiling: two concurrent first-time sign-ups on an empty DB could both see
// count 0; negligible for a single-user tool booted then immediately claimed.
// Upgrade path: real allowlist / single-row user table.
const blockSecondUser = {
  before: async () => {
    const r = authDb.query("SELECT COUNT(*) AS n FROM user").get() as { n: number } | undefined;
    if ((r?.n ?? 0) > 0) throw new Error("Sign-up is disabled — single-user mode");
  },
};

const auth = betterAuth({
  database: authDb,
  baseURL,
  secret: loadSecret(),
  appName: "PI Web",
  // No email verification flow — single-user local tool (YAGNI).
  emailAndPassword: { enabled: true, requireEmailVerification: false, autoSignIn: true },
  plugins: [
    twoFactor({ issuer: "PI Web" }),
    // rpID/origin from baseURL. Passkey works on localhost or a real domain;
    // a raw LAN IP may be rejected by some authenticators (WebAuthn limitation).
    passkey({ rpID: rpHost, rpName: "PI Web", origin: baseURL }),
  ],
  session: { cookieCache: { enabled: true, maxAge: 5 * 60 } },
  advanced: {
    // ponytail: secure cookies when baseURL is https OR the operator opts in
    // behind a TLS-terminating proxy. ipAddressHeaders: [] uses the socket
    // remote address (not spoofable X-Forwarded-For) so the sign-in rate
    // limiter can't be rotated past by faking headers.
    useSecureCookies: baseURL.startsWith("https://") || process.env.PI_WEB_SECURE_COOKIES === "on",
    ipAddress: { ipAddressHeaders: [] },
  },
  // ponytail: better-auth calls this with the request and SPREADS the return
  // into the trusted set (so it must be an array, not a boolean). baseURL is
  // already trusted; we add any OTHER origin we accept. We match on HOST, not
  // the full origin, so a TLS-terminating proxy works: the container listens
  // on http but browsers reach it via https://<domain>, and operators often
  // set BETTER_AUTH_URL=http://<domain>. An exact http/https match 403s those
  // legit sign-ins. Host-match keeps foreign origins rejected; sameSite=lax
  // cookies mitigate CSRF. Ceiling: a same-host http MitM could pass — add
  // HSTS + exact-origin match if that threat matters. When nothing is
  // configured (dev / misconfigured docker LAN) we accept whatever reached us.
  trustedOrigins: async (request?: Request) => {
    // request may be undefined at init (createAuthContext) — guard it.
    const origin = request?.headers?.get?.("origin") ?? "";
    if (!origin || origin === baseURL) return [];
    const hostOf = (u: string | undefined): string => {
      try { return u ? new URL(u).hostname : ""; } catch { return ""; }
    };
    const cfgHosts = [hostOf(baseURL), hostOf(process.env.PI_WEB_ORIGIN)].filter(Boolean);
    if (cfgHosts.includes(hostOf(origin))) return [origin];
    if (!process.env.BETTER_AUTH_URL && !process.env.PI_WEB_ORIGIN) return [origin];
    return [];
  },
  databaseHooks: { user: { create: blockSecondUser } },
});

// ─── First-run init (migration + onboarding) ──────────────────────────────
// Awaited by index.ts before Bun.serve so a public sign-up can't race the
// seed. $context is better-auth's internal init context (a Promise in v1.x);
// guard the thenable so a non-Promise $context doesn't crash boot.
export async function runAuthMigrations(): Promise<void> {
  const c = (auth as any).$context;
  const ctx = c && typeof c.then === "function" ? await c : c;
  if (ctx && typeof ctx.runMigrations === "function") {
    await ctx.runMigrations().catch((e: any) => console.error("[auth] migration failed:", e?.message || e));
  }
}

export async function initAuth(): Promise<void> {
  await runAuthMigrations();
  if (!computeAuthEnabled()) return;
  if (!process.env.BETTER_AUTH_URL) {
    console.warn(
      "[auth] BETTER_AUTH_URL not set — passkey rpID defaults to localhost. " +
        "Set it to the real access URL for LAN/docker/HTTPS deployments.",
    );
  }
  try {
    const row = authDb.query("SELECT COUNT(*) AS n FROM user").get() as { n: number } | undefined;
    if ((row?.n ?? 0) > 0) return;
    // ponytail: only pre-seed when the operator opts in via PI_WEB_ADMIN_EMAIL.
    // Otherwise leave the table empty so the FIRST manual sign-up (UI) becomes
    // the single admin — no static creds in .env, no stale-password lockout.
    // When the email IS set, a password may still be omitted: a random one is
    // generated and printed once, so the email can be claimed without a stored
    // secret. (blockSecondUser caps total users at 1.)
    const email = process.env.PI_WEB_ADMIN_EMAIL;
    if (!email) {
      console.warn(
        "[auth] no admin seeded (PI_WEB_ADMIN_EMAIL unset). Sign up via the UI — " +
          "the first account becomes the single admin; further sign-ups are blocked.",
      );
      return;
    }
    const password = process.env.PI_WEB_ADMIN_PASSWORD || crypto.randomUUID().slice(0, 18);
    await auth.api.signUpEmail({ body: { email, password, name: "admin" } });
    if (process.env.PI_WEB_ADMIN_PASSWORD) {
      console.log(`[auth] created admin user ${email}`);
    } else {
      console.warn(
        `\n[auth] ⚠️  FIRST RUN — created admin user ${email}\n` +
          `  Password: ${password}\n` +
          `  Save this now — it will not be shown again.\n` +
          `  (Set PI_WEB_ADMIN_PASSWORD to control this on next start.)\n`,
      );
    }
  } catch (e: any) {
    console.error("[auth] onboarding failed:", e?.message || e);
  }
}

// ─── HTTP middleware ───────────────────────────────────────────────────────
// Gates /api (data), /preview, /__preview, and /ws. /api/auth/*, /api/health,
// /api/auth-status stay open. WS is gated here (401 before upgrade) with the
// in-handler wsAuthOk as defense-in-depth.
export const requireAuth: MiddlewareHandler = async (c, next) => {
  // Re-evaluate per request (not the boot-cached AUTH_ENABLED) so the flag can
  // be toggled without a restart, and so test files sharing one process don't
  // freeze the decision at the first import. Cheap: a couple env reads.
  if (!computeAuthEnabled()) return next();
  const p = c.req.path;
  const isAuthInfra = p.startsWith("/api/auth/") || p === "/api/health" || p === "/api/auth-status";
  const isGated =
    p.startsWith("/api/") || p.startsWith("/preview/") || p.startsWith("/__preview/") || p.startsWith("/ws");
  if (!isGated || isAuthInfra) return next();
  const sess = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!sess) return c.json({ error: "unauthorized" }, 401);
  return next();
};

// ─── WS auth guard (defense-in-depth) ─────────────────────────────────────
// requireAuth returns 401 before the upgrade for unauthenticated WS; this is
// the in-handler backstop. Returns true when authenticated (or auth disabled).
export async function wsAuthOk(headers: Headers): Promise<boolean> {
  if (!computeAuthEnabled()) return true;
  const sess = await auth.api.getSession({ headers });
  return !!sess;
}

// Mount point: app.all("/api/auth/*", (c) => authHandler(c.req.raw))
export function authHandler(req: Request): Promise<Response> | Response {
  return auth.handler(req);
}

// ponytail: simple user-count check so the client can disable sign-up after
// the first account is created. Raw SQL — avoids better-auth API churn.
export async function countUsers(): Promise<number> {
  const r = authDb.query("SELECT COUNT(*) AS n FROM user").get() as { n: number } | undefined;
  return r?.n ?? 0;
}

export async function userExists(): Promise<boolean> {
  const row = authDb.query("SELECT 1 FROM user LIMIT 1").get() as { [key: string]: any } | undefined;
  return !!row;
}
