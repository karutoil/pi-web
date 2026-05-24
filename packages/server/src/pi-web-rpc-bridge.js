/**
 * Pi RPC Custom UI Bridge — Preload Script
 *
 * Injected via NODE_OPTIONS=--require into the pi RPC process.
 * Intercepts the rpc-mode module load and patches custom() to
 * bridge TUI overlay components to the web frontend.
 *
 * Strategy:
 * 1. When custom(factory, options) is called, invoke the factory
 *    with lightweight mock TUI objects
 * 2. Extract clarify data from the resulting component's properties
 * 3. Emit extension_ui_request with method="clarify" and the data
 * 4. Wait for extension_ui_response with the user's edits
 * 5. Return ChainClarifyResult to the extension
 *
 * If the factory throws (not a ChainClarifyComponent), fall back
 * to a simple confirm dialog.
 */

const Module = require("module");
const path = require("path");
const fs = require("fs");

let patched = false;

function findRpcModePath() {
  for (const pkgName of ["@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"]) {
    try {
      const pkgJson = require.resolve(pkgName + "/package.json");
      const candidate = path.join(path.dirname(pkgJson), "dist/modes/rpc/rpc-mode.js");
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  return null;
}

const rpcModePath = findRpcModePath();
if (!rpcModePath) return;

const originalLoad = Module._load;

Module._load = function (request, parent, isMain) {
  const filename = Module._resolveFilename(request, parent, false);

  if (!patched && filename === rpcModePath) {
    patched = true;

    const source = fs.readFileSync(filename, "utf-8");

    const pattern = /async\s+custom\s*\(\)\s*\{\s*\/\/\s*Custom UI not supported in RPC mode\s*\n\s*return undefined;\s*\}/;

    if (!pattern.test(source)) {
      console.error("[pi-web-bridge] custom() pattern not found in rpc-mode.js");
      return originalLoad.apply(this, arguments);
    }

    const patchedSource = source.replace(pattern, `async custom(factory, options) {
            // pi-web-bridge: bridge custom UI to web via clarify protocol
            if (typeof factory !== "function") return undefined;

            // Try to extract clarify data from the factory by calling it
            // with mock TUI objects and inspecting the component's properties
            let clarifyData = null;
            try {
              const mockTui = { requestRender: () => {}, setFocus: () => {}, getCols: () => 80, getRows: () => 24 };
              const mockTheme = { fg: (c, t) => t, bg: (c, t) => t, bold: t => t, dim: t => t };
              const mockKb = {};
              const component = factory(mockTui, mockTheme, mockKb, () => {});
              if (component && component.agentConfigs) {
                clarifyData = {
                  mode: component.mode || "chain",
                  steps: component.agentConfigs.map((cfg, i) => ({
                    agent: cfg.name || cfg.agent || "unknown",
                    task: component.templates?.[i] || "",
                    model: component.resolvedBehaviors?.[i]?.model || cfg.model || undefined,
                    output: component.resolvedBehaviors?.[i]?.output || undefined,
                    skills: component.resolvedBehaviors?.[i]?.skills || undefined,
                    reads: component.resolvedBehaviors?.[i]?.reads || undefined,
                    progress: component.resolvedBehaviors?.[i]?.progress || undefined,
                  })),
                  originalTask: component.originalTask || undefined,
                };
              }
              // Dispose if possible
              if (component && typeof component.dispose === "function") {
                try { component.dispose(); } catch {}
              }
            } catch (e) {
              // Factory requires real TUI objects; fall back to confirm
            }

            const clarifyId = crypto.randomUUID();
            return new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    pendingExtensionRequests.delete(clarifyId);
                    resolve(undefined);
                }, 5 * 60 * 1000);

                if (clarifyData) {
                  // Full clarify dialog with step editing
                  pendingExtensionRequests.set(clarifyId, {
                    resolve: (response) => {
                        clearTimeout(timeout);
                        if (response && response.confirmed) {
                            resolve({
                                confirmed: true,
                                templates: response.templates || clarifyData.steps.map(s => s.task),
                                behaviorOverrides: response.behaviorOverrides || clarifyData.steps.map(() => ({})),
                                runInBackground: response.runInBackground || false,
                            });
                        } else {
                            resolve(undefined);
                        }
                    },
                    reject: () => {
                        clearTimeout(timeout);
                        resolve(undefined);
                    },
                  });
                  output({
                    type: "extension_ui_request",
                    id: clarifyId,
                    method: "clarify",
                    overlay: options?.overlay || false,
                    overlayOptions: options?.overlayOptions || undefined,
                    clarifyData,
                  });
                } else {
                  // Fallback: simple confirm dialog
                  pendingExtensionRequests.set(clarifyId, {
                    resolve: (response) => {
                        clearTimeout(timeout);
                        if (response && response.confirmed) {
                            resolve({ confirmed: true, templates: [], behaviorOverrides: [], runInBackground: false });
                        } else {
                            resolve(undefined);
                        }
                    },
                    reject: () => {
                        clearTimeout(timeout);
                        resolve(undefined);
                    },
                  });
                  output({
                    type: "extension_ui_request",
                    id: clarifyId,
                    method: "confirm",
                    title: "Confirm Execution",
                    message: "A subagent is requesting confirmation to proceed. Edit is not available in web mode.",
                  });
                }
            });
        }`);

    const compiled = new Module(filename, parent);
    compiled.filename = filename;
    compiled.paths = Module._nodeModulePaths(path.dirname(filename));
    compiled._compile(patchedSource, filename);
    require.cache[filename] = compiled;

    console.log("[pi-web-bridge] Patched rpc-mode.js custom() for clarify support");
    return compiled.exports;
  }

  return originalLoad.apply(this, arguments);
};

console.log("[pi-web-bridge] Preload loaded, will patch rpc-mode on require");
