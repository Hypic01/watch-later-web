import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

// Multi-page: landing (static-ish) at /, the app at /app/.
export default defineConfig({
  root: dir,
  plugins: [react()],
  build: {
    outDir: path.join(dir, "dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        landing: path.join(dir, "index.html"),
        app: path.join(dir, "app", "index.html"),
      },
    },
  },
  server: {
    proxy: {
      "/api": "http://localhost:4400",
      "/collector.js": "http://localhost:4400",
    },
  },
});
