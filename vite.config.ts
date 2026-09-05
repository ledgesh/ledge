import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { electrobunViteAliases } from "./.hutch/devkit/api/config/electrobun-vite";

// The view is a standalone SPA that Vite builds to dist/. Electrobun then copies
// dist/ into the app bundle (see electrobun.config.ts). Relative base so the
// bundled index.html resolves ./assets/* under the views:// scheme.
//
// Hutch injects the devkit aliases into the bundles it builds itself, but Vite
// resolves on its own and would find node_modules/electrobun, whose only module
// throws by design. So main.tsx's `electrobun/view` import needs the aliases
// spelled out here; the helper derives them from the devkit's export map, which
// is why the array form is required (an object alias cannot carry them).
export default defineConfig({
  plugins: [react()],
  root: "src/mainview",
  base: "./",
  resolve: {
    alias: [
      { find: "@", replacement: resolve(__dirname, "src/mainview") },
      ...electrobunViteAliases(resolve(__dirname, ".hutch/devkit")),
    ],
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
