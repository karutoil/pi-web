// Runtime check for the disabled-auth path, spawned by auth.test.ts as a
// subprocess so AUTH_ENABLED resolves false (env must be set before import).
// Excluded from tsc -b by the src/_*.ts pattern in tsconfig.json.
process.env.PI_WEB_AUTH = "off";
process.env.PI_WEB_DB_PATH = "/tmp/piweb-auth-test-off.db";
process.env.BETTER_AUTH_SECRET = "test-secret-32-chars-min!!test-secret";
process.env.BETTER_AUTH_URL = "http://localhost:3069";
const { Hono } = await import("hono");
const { requireAuth, AUTH_ENABLED } = await import("./auth");
const app = new Hono();
app.use("/api/projects", requireAuth);
app.get("/api/projects", (c) => c.json({ projects: [] }));
const res = await app.request("/api/projects");
console.log(JSON.stringify({ enabled: AUTH_ENABLED, status: res.status }));
