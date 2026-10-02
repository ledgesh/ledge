// The app's version, a value Bun-side code can read without Electrobun.
// `Updater.getLocalInfo()` is the authority for a shipped app, and it also
// reports the channel and the build hash. Calling it needs the Electrobun
// runtime. The server never imports Electrobun (remote.md §1), so it cannot
// call that. The handshake still has to name a build, so the number lives
// here too. release.test.ts fails the build when this number disagrees with
// package.json and electrobun.config.ts.
export const BUILD_VERSION = "0.1.5";

/** What a running Ledge says about itself: the launch log's first line, About
 * Ledge, and `ledge --version`. A field this copy cannot know is "": a server
 * package has no channel or build hash, and a phone has no Bun. */
export interface AppInfo {
  version: string;
  channel: string;
  /** Electrobun's build hash, the one an update compares. */
  hash: string;
  platform: string;
  arch: string;
  bun: string;
}

/**
 * The one line a bug report should carry, e.g.
 * `Ledge 0.1.5 (stable, q5lncvui) on darwin arm64; bun 1.3.0`.
 * Empty fields drop out with their punctuation, so a server package prints
 * `Ledge 0.1.5 on linux x64; bun 1.3.0`.
 */
export function versionLine(info: AppInfo): string {
  const build = [info.channel, info.hash.slice(0, 8)].filter((s) => s !== "").join(", ");
  const on = [info.platform, info.arch].filter((s) => s !== "").join(" ");
  return (
    `Ledge ${info.version || "?"}` +
    (build ? ` (${build})` : "") +
    (on ? ` on ${on}` : "") +
    (info.bun ? `; bun ${info.bun}` : "")
  );
}
