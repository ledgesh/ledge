// Hutch's own config, separate from electrobun.config.ts: it governs the
// toolchain and the package manager, not the app.
//
// Hutch ships a built-in npm-compatible resolver and prefers it, which would
// ignore bun.lock (never read, never migrated) and write a hutch.lock beside
// it, leaving two lockfiles disagreeing about the same tree. Naming bun here
// is the only way to keep the one lockfile this repo already has.
export default {
  packageManager: "bun",
};
