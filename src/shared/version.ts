// The app's version, a value Bun-side code can read without Electrobun.
// `Updater.getLocalInfo()` is the authority for a shipped app, and it also
// reports the channel and the build hash. Calling it needs the Electrobun
// runtime. The server never imports Electrobun (remote.md §1), so it cannot
// call that. The handshake still has to name a build, so the number lives
// here too. release.test.ts fails the build when this number disagrees with
// package.json and electrobun.config.ts.
export const BUILD_VERSION = "0.1.0";
