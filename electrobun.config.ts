import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "Ledge",
    identifier: "sh.ledge.app",
    version: "0.0.1",
  },
  build: {
    // Bun main process entrypoint defaults to src/bun/index.ts. The view is built
    // by Vite (see vite.config.ts) to dist/; we copy that output into the bundle.
    copy: {
      "dist/index.html": "views/mainview/index.html",
      "dist/assets": "views/mainview/assets",
    },
    // Vite owns view rebuilds (and HMR); keep electrobun's watcher off its output.
    watchIgnore: ["dist/**"],
    // Use the system WebView (WKWebView on macOS), not bundled Chromium.
    mac: { bundleCEF: false },
    linux: { bundleCEF: false },
    win: { bundleCEF: false },
  },
} satisfies ElectrobunConfig;
