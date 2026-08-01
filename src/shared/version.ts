// The app's version, as a value Bun-side code can read without Electrobun.
//
// `Updater.getLocalInfo()` is the authority for a shipped app (it also knows
// the channel and the build hash), but it needs the Electrobun runtime, and
// the server deliberately has none (remote.md §1). The handshake still has to
// name a build, so the number lives here too and release.test.ts fails the
// build when it drifts from package.json and electrobun.config.ts.
export const BUILD_VERSION = "0.1.0";
