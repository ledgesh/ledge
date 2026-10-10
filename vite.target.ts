// The syntax level every view build is compiled to: the Mac, Linux and Windows
// app, the iOS and Android bundles, and the minified harness the e2e suite
// smokes (vite.harness.config.ts).
//
// Vite's default target also names es2020, which makes esbuild rewrite
// `x ||= y`. esbuild 0.25 gets that wrong when it minifies: xterm's
// requestMode lost a `let` and threw on the mode query vim sends at startup,
// which froze the terminal. Every engine the view runs in supports the
// operator. release.test.ts pins this for each config.
export const VIEW_BUILD_TARGET = ["es2021", "chrome87", "safari14"];
