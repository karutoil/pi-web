import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addProject, removeProject } from "./db";
import { app } from "./index";

// Exercises the new fs mutation routes + their path-safety validation via
// Hono's in-process app.request(). No real port is bound (index.ts guards
// Bun.serve behind import.meta.main).

let tmpProject: string;
let projectId: string;

beforeEach(() => {
  tmpProject = mkdtempSync(join(tmpdir(), "pi-fs-test-"));
  projectId = addProject("fs-test", tmpProject).id;
});

afterEach(() => {
  try { removeProject(projectId); } catch {}
  try { rmSync(tmpProject, { recursive: true, force: true }); } catch {}
});

async function post(path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
async function del(path: string, body: unknown) {
  return app.request(path, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("fs mutation endpoints", () => {
  it("create + delete an empty file", async () => {
    const res = await post("/api/fs/create", { path: join(tmpProject, "hello.txt"), projectId, kind: "file" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(existsSync(join(tmpProject, "hello.txt"))).toBe(true);

    const d = await del("/api/fs/delete", { path: join(tmpProject, "hello.txt"), projectId });
    expect(d.status).toBe(200);
    expect((await d.json()).success).toBe(true);
    expect(existsSync(join(tmpProject, "hello.txt"))).toBe(false);
  });

  it("create + delete a folder recursively", async () => {
    const res = await post("/api/fs/create", { path: join(tmpProject, "sub"), projectId, kind: "folder" });
    expect(res.status).toBe(200);
    writeFileSync(join(tmpProject, "sub", "inner.txt"), "x");
    const d = await del("/api/fs/delete", { path: join(tmpProject, "sub"), projectId });
    expect(d.status).toBe(200);
    expect(existsSync(join(tmpProject, "sub"))).toBe(false);
  });

  it("409s on duplicate create", async () => {
    writeFileSync(join(tmpProject, "dup.txt"), "x");
    const res = await post("/api/fs/create", { path: join(tmpProject, "dup.txt"), projectId, kind: "file" });
    expect(res.status).toBe(409);
  });

  it("rejects path traversal outside the project", async () => {
    const res = await post("/api/fs/create", { path: join(tmpProject, "..", "escape.txt"), projectId, kind: "file" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/outside project/i);
  });

  it("rename moves a file and 409s on collision", async () => {
    writeFileSync(join(tmpProject, "a.txt"), "hi");
    writeFileSync(join(tmpProject, "b.txt"), "yo");
    const ok = await post("/api/fs/rename", { path: join(tmpProject, "a.txt"), destination: join(tmpProject, "c.txt"), projectId });
    expect(ok.status).toBe(200);
    expect(existsSync(join(tmpProject, "c.txt"))).toBe(true);
    expect(existsSync(join(tmpProject, "a.txt"))).toBe(false);

    const conflict = await post("/api/fs/rename", { path: join(tmpProject, "c.txt"), destination: join(tmpProject, "b.txt"), projectId });
    expect(conflict.status).toBe(409);
  });

  it("delete on a missing path returns 403 with an error", async () => {
    const res = await del("/api/fs/delete", { path: join(tmpProject, "nope.txt"), projectId });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBeDefined();
  });

  it("rejects a missing projectId", async () => {
    const res = await post("/api/fs/create", { path: join(tmpProject, "x"), kind: "file" });
    expect(res.status).toBe(400);
  });
});
