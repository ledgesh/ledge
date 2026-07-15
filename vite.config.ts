import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// The view is a standalone SPA that Vite builds to dist/. Electrobun then copies
// dist/ into the app bundle (see electrobun.config.ts). Relative base so the
// bundled index.html resolves ./assets/* under the views:// scheme.
export default defineConfig({
  plugins: [react()],
  root: "src/mainview",
  base: "./",
  resolve: {
    alias: { "@": resolve(__dirname, "src/mainview") },
  },
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
