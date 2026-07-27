import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "Ledge",
    identifier: "sh.ledge.app",
    version: "0.0.1",
  },
  // The PTY trampolines, compiled to a dylib before anything else runs. They
  // are C that needs the macOS SDK's headers, and the user's Mac may have no
  // SDK at all — building here is what keeps Ctrl-C working there. See
  // scripts/build-native.ts and src/bun/ptyNative.ts.
  scripts: { preBuild: "scripts/build-native.ts" },
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
      // The PTY trampolines, beside index.js for the same reason: pty.ts finds
      // them at import.meta.dir, which reads the same in the bundle and in a
      // checkout.
      "dist-native/libledge_pty.dylib": "bun/libledge_pty.dylib",
    },
    // Vite owns view rebuilds (and HMR); keep electrobun's watcher off its
    // output — and off the CLI and native prebuilds', same reason.
    watchIgnore: ["dist/**", "dist-cli/**", "dist-native/**"],
    // Use the system WebView (WKWebView on macOS), not bundled Chromium.
    // icons: an Icon Composer bundle — actool compiles it to Assets.car (the
    // adaptive light/dark/tinted icon on macOS 26+) plus a .icns fallback.
    // Its mark.svg is generated from assets/logo.svg by `bun run icon`.
    mac: { bundleCEF: false, icons: "assets/Ledge.icon" },
    linux: { bundleCEF: false },
    win: { bundleCEF: false },
  },
} satisfies ElectrobunConfig;
