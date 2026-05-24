/**
 * Pi RPC Custom UI Bridge — Preload Script (.cjs)
 *
 * Injected via NODE_OPTIONS=--require into the pi RPC process.
 * Patches rpc-mode.js on disk before pi's ESM main module loads,
 * replacing custom() to bridge TUI overlay components to the web frontend.
 *
 * Pi-core uses ESM imports, so Module._load CJS hooks can't intercept.
 * Instead we patch the source file on disk and record the original content
 * for restoration after the process exits.
 */

(function () {
  "use strict";

  var fs = require("fs");
  var path = require("path");
  var os = require("os");

  var REPLACEMENT = [
    "async custom(factory, options) {",
    "  // pi-web-bridge: bridge custom UI to web via clarify protocol",
    "  if (typeof factory !== 'function') return undefined;",
    "",
    "  var clarifyData = null;",
    "  try {",
    "    var mockTui = { requestRender: function(){}, setFocus: function(){}, getCols: function(){ return 80; }, getRows: function(){ return 24; } };",
    "    var mockTheme = { fg: function(c,t){ return t; }, bg: function(c,t){ return t; }, bold: function(t){ return t; }, dim: function(t){ return t; } };",
    "    var mockKb = {};",
    "    var component = factory(mockTui, mockTheme, mockKb, function(){});",
    "    if (component && component.agentConfigs) {",
    "      clarifyData = {",
    "        mode: component.mode || 'chain',",
    "        steps: component.agentConfigs.map(function(cfg, i) {",
    "          return {",
    "            agent: cfg.name || cfg.agent || 'unknown',",
    "            task: (component.templates && component.templates[i]) || '',",
    "            model: (component.resolvedBehaviors && component.resolvedBehaviors[i] && component.resolvedBehaviors[i].model) || cfg.model || undefined,",
    "            output: (component.resolvedBehaviors && component.resolvedBehaviors[i] && component.resolvedBehaviors[i].output) || undefined,",
    "            skills: (component.resolvedBehaviors && component.resolvedBehaviors[i] && component.resolvedBehaviors[i].skills) || undefined,",
    "            reads: (component.resolvedBehaviors && component.resolvedBehaviors[i] && component.resolvedBehaviors[i].reads) || undefined,",
    "            progress: (component.resolvedBehaviors && component.resolvedBehaviors[i] && component.resolvedBehaviors[i].progress) || undefined,",
    "          };",
    "        }),",
    "        originalTask: component.originalTask || undefined,",
    "      };",
    "    }",
    "    if (component && typeof component.dispose === 'function') { try { component.dispose(); } catch(e){} }",
    "  } catch(e) {}",
    "",
    "  var clarifyId = crypto.randomUUID();",
    "  return new Promise(function(resolve) {",
    "    var timeout = setTimeout(function() {",
    "      pendingExtensionRequests.delete(clarifyId);",
    "      resolve(undefined);",
    "    }, 5 * 60 * 1000);",
    "    if (clarifyData) {",
    "      pendingExtensionRequests.set(clarifyId, {",
    "        resolve: function(response) {",
    "          clearTimeout(timeout);",
    "          if (response && response.confirmed) {",
    "            resolve({",
    "              confirmed: true,",
    "              templates: response.templates || clarifyData.steps.map(function(s){ return s.task; }),",
    "              behaviorOverrides: response.behaviorOverrides || clarifyData.steps.map(function(){ return {}; }),",
    "              runInBackground: response.runInBackground || false,",
    "            });",
    "          } else { resolve(undefined); }",
    "        },",
    "        reject: function() { clearTimeout(timeout); resolve(undefined); },",
    "      });",
    "      output({",
    "        type: 'extension_ui_request',",
    "        id: clarifyId,",
    "        method: 'clarify',",
    "        overlay: (options && options.overlay) || false,",
    "        overlayOptions: (options && options.overlayOptions) || undefined,",
    "        clarifyData: clarifyData,",
    "      });",
    "    } else {",
    "      pendingExtensionRequests.set(clarifyId, {",
    "        resolve: function(response) {",
    "          clearTimeout(timeout);",
    "          if (response && response.confirmed) {",
    "            resolve({ confirmed: true, templates: [], behaviorOverrides: [], runInBackground: false });",
    "          } else { resolve(undefined); }",
    "        },",
    "        reject: function() { clearTimeout(timeout); resolve(undefined); },",
    "      });",
    "      output({",
    "        type: 'extension_ui_request',",
    "        id: clarifyId,",
    "        method: 'confirm',",
    "        title: 'Confirm Execution',",
    "        message: 'A subagent is requesting confirmation to proceed. Edit is not available in web mode.',",
    "      });",
    "    }",
    "  });",
    "}",
  ].join("\n");

  function findRpcModePath() {
    var homeDir = process.env.HOME || "/root";
    var nodeVer = process.version;
    var globalPaths = [
      path.join(homeDir, ".bun/install/global/node_modules"),
      "/usr/local/lib/node_modules",
      path.join(homeDir, ".nvm/versions/node", nodeVer, "lib/node_modules"),
    ];
    var pkgNames = ["@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"];
    for (var i = 0; i < globalPaths.length; i++) {
      for (var j = 0; j < pkgNames.length; j++) {
        var candidate = path.join(globalPaths[i], pkgNames[j], "dist/modes/rpc/rpc-mode.js");
        if (fs.existsSync(candidate)) return candidate;
      }
    }
    return null;
  }

  var rpcModePath = findRpcModePath();
  if (!rpcModePath) {
    // Not found in global paths — pi may install locally
    // Will try again from the working directory
    return;
  }

  // Read original source
  var source = fs.readFileSync(rpcModePath, "utf-8");

  // Check if already patched
  if (source.indexOf("pi-web-bridge: bridge custom UI") !== -1) {
    return;
  }

  // Match the original custom() that returns undefined
  var pattern = /async\s+custom\s*\(\)\s*\{\s*\/\/\s*Custom UI not supported in RPC mode\s*\n\s*return undefined;\s*\}/;

  if (!pattern.test(source)) {
    console.error("[pi-web-bridge] custom() pattern not found in rpc-mode.js");
    return;
  }

  var patchedSource = source.replace(pattern, REPLACEMENT);

  // Save original for restoration
  var backupPath = path.join(os.tmpdir(), "pi-web-rpc-mode-backup.js");
  fs.writeFileSync(backupPath, source, "utf-8");

  // Write patched version
  fs.writeFileSync(rpcModePath, patchedSource, "utf-8");
  console.log("[pi-web-bridge] Patched rpc-mode.js custom() for clarify support");

  // Schedule restoration on process exit
  process.on("exit", function () {
    try {
      fs.writeFileSync(rpcModePath, source, "utf-8");
    } catch (e) {
      // Best effort
    }
  });
  process.on("SIGTERM", function () {
    try { fs.writeFileSync(rpcModePath, source, "utf-8"); } catch (e) {}
    process.exit(0);
  });
  process.on("SIGINT", function () {
    try { fs.writeFileSync(rpcModePath, source, "utf-8"); } catch (e) {}
    process.exit(0);
  });
})();
