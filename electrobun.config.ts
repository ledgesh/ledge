import type { ElectrobunConfig } from "electrobun";

// Signing and notarization are on for every non-dev build (electrobun ignores
// both for `--env=dev`). They need ELECTROBUN_DEVELOPER_ID and the notarization
// credentials in the environment — docs/contributor/releasing.md. LEDGE_UNSIGNED=1
// turns them off for a dry run of the packaging path; the .app that produces
// runs here and nowhere else, since Gatekeeper rejects it on any other Mac.
const signed = process.env["LEDGE_UNSIGNED"] !== "1";

export default {
  app: {
    name: "Ledge",
    identifier: "sh.ledge.app",
    // Keep in step with package.json's version; release.test.ts fails
    // otherwise. This is the copy that reaches the bundle.
    version: "0.1.0",
  },
  scripts: {
    // The PTY trampolines, compiled to a dylib before anything else runs. They
    // are C that needs the macOS SDK's headers, and the user's Mac may have no
    // SDK at all — building here is what keeps Ctrl-C working there. See
    // scripts/build-native.ts and src/bun/ptyNative.ts.
    preBuild: "scripts/build-native.ts",
    // The same script twice: it adds CFBundleShortVersionString to a generated
    // Info.plist, and a stable build generates two of them (the app, then the
    // self-extracting wrapper the DMG carries). Each hook fires after its own
    // plist is written and before it is signed. See scripts/stamp-version.ts.
    postBuild: "scripts/stamp-version.ts",
    postWrap: "scripts/stamp-version.ts",
  },
  build: {
    // Bun, not the 2.x default of Cottontail. This is not a preference: the
    // main process calls into libledge_pty.dylib through bun:ffi (ptyNative.ts)
    // and the `ledge` shim execs Contents/MacOS/bun against cli.js
    // (cliShim.ts), so the runtime IS the native seam here. Moving to
    // Cottontail is a separate project, not a config edit.
    mainProcess: "bun",
    bun: { entrypoint: "src/bun/index.ts" },
    // 0.1.0 is Apple Silicon only: an x86_64 slice would ship with its PTY
    // dylib and its whole native seam untested, since there is no Intel Mac
    // here to run it on. v1's `targets` key is gone — Hutch builds for the
    // build host — so what used to be stated here is now a fact about the
    // machine. release-preflight.ts refuses a release off an Intel host.
    // The view is built by Vite (see vite.config.ts) to dist/; we copy that
    // output into the bundle.
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
    mac: {
      bundleCEF: false,
      icons: "assets/Ledge.icon",
      // Both, or neither: a signed build that skips notarization is one
      // Gatekeeper refuses anyway, so there is no useful third state.
      codesign: signed,
      notarize: signed,
    },
    linux: { bundleCEF: false },
    win: { bundleCEF: false },
  },
} satisfies ElectrobunConfig;
