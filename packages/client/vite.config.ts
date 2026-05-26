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
    port: parseInt(process.env.CLIENT_PORT || "3070", 10),
    proxy: {
      "/api": `http://localhost:${process.env.SERVER_PORT || "3069"}`,
      "/ws": {
        target: `ws://localhost:${process.env.SERVER_PORT || "3069"}`,
        ws: true,
      },
    },
  },
});
