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
      // The CLI, prebuilt by `bun run build:cli` (electrobun bundles only the
      // one bun entrypoint), landing beside index.js so a `ledge` shim can
      // exec <bundle>/MacOS/bun against it. See src/bun/cliShim.ts.
      "dist-cli/cli.js": "bun/cli.js",
    },
    // Vite owns view rebuilds (and HMR); keep electrobun's watcher off its
    // output — and off the CLI prebuild's, same reason.
    watchIgnore: ["dist/**", "dist-cli/**"],
    // Use the system WebView (WKWebView on macOS), not bundled Chromium.
    mac: { bundleCEF: false },
    linux: { bundleCEF: false },
    win: { bundleCEF: false },
  },
} satisfies ElectrobunConfig;
