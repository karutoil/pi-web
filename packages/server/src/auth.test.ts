import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { rmSync } from "node:fs";

// ponytail: drive both auth states via env + a cache-busted second import.
// AUTH_ENABLED is fixed at import time, so the "off" case needs a fresh module.
const TEST_DB = "/tmp/piweb-auth-test.db";
const SECRET = "test-secret-32-chars-min!!test-secret";

// ── Enabled path: force PI_WEB_AUTH=on before importing auth.ts ───────────
process.env.PI_WEB_AUTH = "on";
process.env.HOST = "127.0.0.1";
process.env.PI_WEB_DB_PATH = TEST_DB;
process.env.BETTER_AUTH_SECRET = SECRET;
process.env.BETTER_AUTH_URL = "http://localhost:3069";
rmSync(TEST_DB, { force: true });

const authMod = await import("./auth");
const { computeAuthEnabled } = authMod;

let cookie = "";
const app = new Hono();
app.all("/api/auth/*", (c) => authMod.authHandler(c.req.raw));
// ponytail: app.use with the path applies requireAuth before the GET handler.
app.use("/api/projects", authMod.requireAuth);
app.get("/api/projects", (c) => c.json({ projects: [] }));

beforeAll(async () => {
  // Create the better-auth tables. initAuth's onboarding is intentionally NOT
  // called — the test signs up its own first user (allowed at count 0 by A1).
  await authMod.runAuthMigrations();
  // Sign up + sign in via the real better-auth HTTP handler, capture the cookie.
  await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "test@local.test", password: "supersecret12345", name: "Test" }),
  });
  const res = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "test@local.test", password: "supersecret12345" }),
  });
  const setCookie = res.headers.get("set-cookie") || "";
  cookie = setCookie.split(",")[0].split(";")[0];
});

afterAll(() => {
  rmSync(TEST_DB, { force: true });
  // Restore so the cached-auth-on state doesn't leak into later test files in
  // the same `bun test` process (pi-fs etc. import the real app and expect open).
  process.env.PI_WEB_AUTH = "off";
  // db.ts honors PI_WEB_DB_PATH now too — unset so pi-fs etc. use the real DB
  // instead of this test's (deleted) temp file.
  delete process.env.PI_WEB_DB_PATH;
});

describe("auth — enabled", () => {
  test("AUTH_ENABLED is on", () => {
    expect(authMod.AUTH_ENABLED).toBe(true);
  });

  test("protected route returns 401 without a cookie", async () => {
    const res = await app.request("/api/projects");
    expect(res.status).toBe(401);
  });

  test("protected route returns 200 with a signed-in cookie", async () => {
    expect(cookie).toMatch(/^better-auth\.session_token=/);
    const res = await app.request("/api/projects", { headers: { cookie } });
    expect(res.status).toBe(200);
  });

  test("/api/auth/* and /api/health stay open without auth", async () => {
    const ok = await app.request("/api/auth/ok");
    // better-auth's /ok endpoint returns 200; the handler must not be gated.
    expect(ok.status).toBe(200);
  });

  test("wsAuthOk rejects an unauthenticated WS upgrade", async () => {
    const ok = await authMod.wsAuthOk(new Headers());
    expect(ok).toBe(false);
  });

  test("wsAuthOk accepts an authenticated WS upgrade", async () => {
    const ok = await authMod.wsAuthOk(new Headers({ cookie }));
    expect(ok).toBe(true);
  });
});

// ── Disabled path: env decision logic + a subprocess that boots auth off ─
describe("auth — disabled", () => {
  test("computeAuthEnabled handles on / off / auto", () => {
    expect(computeAuthEnabled({ PI_WEB_AUTH: "on" } as any)).toBe(true);
    expect(computeAuthEnabled({ PI_WEB_AUTH: "off" } as any)).toBe(false);
    // auto: on when bound beyond loopback, off on localhost
    expect(computeAuthEnabled({ HOST: "0.0.0.0" } as any)).toBe(true);
    expect(computeAuthEnabled({ HOST: "127.0.0.1" } as any)).toBe(false);
    // unset HOST → server binds 127.0.0.1 (localhost) → auth off
    expect(computeAuthEnabled({} as any)).toBe(false);
  });

  test("protected route is open when PI_WEB_AUTH=off", async () => {
    // AUTH_ENABLED is fixed at import, so run a fresh process with auth off.
    const proc = Bun.spawn(["bun", "run", "_auth_off_check.ts"], {
      cwd: import.meta.dir,
      stdout: "pipe",
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    const out = JSON.parse(text.trim());
    expect(out.enabled).toBe(false);
    expect(out.status).toBe(200);
  });
});
