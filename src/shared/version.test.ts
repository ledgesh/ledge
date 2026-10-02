// The version line every surface prints: the launch log, About Ledge and
// `ledge version` (shared/version.ts versionLine).
import { describe, expect, test } from "bun:test";
import { versionLine, type AppInfo } from "./version";

const DESKTOP: AppInfo = { version: "0.1.5", channel: "stable", hash: "q5lncvuixtwy", platform: "darwin", arch: "arm64", bun: "1.3.0" };

describe("versionLine", () => {
  test("a desktop app names its channel, its short build hash, the platform and Bun", () => {
    expect(versionLine(DESKTOP)).toBe("Ledge 0.1.5 (stable, q5lncvui) on darwin arm64; bun 1.3.0");
  });

  test("a server package has no channel or hash, and the parentheses go with them", () => {
    expect(versionLine({ ...DESKTOP, channel: "", hash: "", platform: "linux", arch: "x64" })).toBe(
      "Ledge 0.1.5 on linux x64; bun 1.3.0",
    );
  });

  test("a phone has no arch and no Bun", () => {
    expect(versionLine({ ...DESKTOP, channel: "", hash: "", platform: "ios", arch: "", bun: "" })).toBe("Ledge 0.1.5 on ios");
  });

  test("a channel without a hash keeps the channel", () => {
    expect(versionLine({ ...DESKTOP, hash: "" })).toBe("Ledge 0.1.5 (stable) on darwin arm64; bun 1.3.0");
  });
});
