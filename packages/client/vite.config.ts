import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // Intentionally points to TypeScript source for HMR during development.
      // Production builds use the compiled dist/ via workspace resolution.
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
    },
  },
});
