import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@pi-web/shared": path.resolve(__dirname, "../shared/src/index.ts"),
    },
  },
  server: {
    port: 3070,
    proxy: {
      "/api": "http://localhost:3069",
      "/ws": {
        target: "ws://localhost:3069",
        ws: true,
      },
    },
  },
});
