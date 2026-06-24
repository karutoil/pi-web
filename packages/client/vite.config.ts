import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

let authEnabled = false;

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "pi-web-auth-injector",
      apply: "serve",
      async configureServer(server) {
        const serverPort = parseInt(process.env.SERVER_PORT || "3069", 10);
        try {
          const res = await fetch(`http://localhost:${serverPort}/api/auth-status`);
          const data = await res.json();
          authEnabled = data.enabled === true;
        } catch {
          // server might not be up yet; auth defaults to false, re-check on HMR
        }
        return () => {
          server.middlewares.use((req, res, next) => {
            if (req.url === "/") {
              const htmlPath = path.join(server.config.root, "index.html");
              const fs = require("fs");
              let html = fs.readFileSync(htmlPath, "utf-8");
              html = html.replace("<head>", `<head><script>window.__PI_WEB_AUTH__=${authEnabled}</script>`);
              res.setHeader("Content-Type", "text/html");
              res.end(html);
            } else {
              next();
            }
          });
        };
      },
    },
  ],
  resolve: {
    alias: {
      '@pi-web/shared': path.resolve(__dirname, '../shared/src/index.ts'),
    },
  },
  server: {
    port: parseInt(process.env.CLIENT_PORT || "0", 10) || 0,
    proxy: {
      "/api": `http://localhost:${process.env.SERVER_PORT || "3069"}`,
      "/ws": {
        target: `ws://localhost:${process.env.SERVER_PORT || "3069"}`,
        ws: true,
      },
      "/preview": `http://localhost:${process.env.SERVER_PORT || "3069"}`,
      "/__preview": `http://localhost:${process.env.SERVER_PORT || "3069"}`,
    },
  },
});
