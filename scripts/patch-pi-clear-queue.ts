/**
 * Postinstall patch for @earendil-works/pi-coding-agent.
 *
 * The web UI exposes queued steering/follow-up messages with a "Cancel all"
 * button. The underlying PI agent already supports `AgentSession.clearQueue()`,
 * but the RPC mode does not expose it. This script patches the installed
 * `rpc-mode.js` to accept a `clear_queue` command.
 *
 * The patch is idempotent; running it multiple times is safe.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const TARGET_FILE = "@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-mode.js";

async function tryResolve(request: string): Promise<string | null> {
  try {
    const url = await import.meta.resolve?.(request, `file://${resolve(__dirname, "../package.json")}`);
    if (url) return fileURLToPath(url);
  } catch {}
  try {
    const url = await import.meta.resolve?.(request);
    if (url) return fileURLToPath(url);
  } catch {}
  return null;
}

async function patchFile(filePath: string): Promise<boolean> {
  let source: string;
  try {
    source = await readFile(filePath, "utf-8");
  } catch {
    return false;
  }
  if (source.includes('case "clear_queue":')) {
    return false;
  }
  const marker = `            case "follow_up": {
                await session.followUp(command.message, command.images);
                return success(id, "follow_up");
            }
            case "abort": {`;
  const replacement = `            case "follow_up": {
                await session.followUp(command.message, command.images);
                return success(id, "follow_up");
            }
            case "clear_queue": {
                session.clearQueue();
                return success(id, "clear_queue");
            }
            case "abort": {`;
  if (!source.includes(marker)) {
    console.warn(`[patch-pi-clear-queue] Could not find insertion point in ${filePath}`);
    return false;
  }
  await writeFile(filePath, source.replace(marker, replacement), "utf-8");
  console.log(`[patch-pi-clear-queue] Patched ${filePath}`);
  return true;
}

let patchedAny = false;
for (const request of [TARGET_FILE, `@earendil-works/pi-coding-agent/package.json`]) {
  const resolved = await tryResolve(request);
  if (!resolved) continue;
  const filePath = resolve(dirname(resolved), request.endsWith("package.json") ? "dist/modes/rpc/rpc-mode.js" : "");
  const patched = await patchFile(filePath);
  if (patched) patchedAny = true;
}

if (!patchedAny) {
  console.log("[patch-pi-clear-queue] No patch needed or target not found.");
}
