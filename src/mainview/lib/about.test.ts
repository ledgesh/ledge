// About Ledge's text: the app's line, then the server's build when the
// handshake named one (lib/about.ts aboutText).
import { describe, expect, test } from "bun:test";
import { aboutText } from "./about";
import type { AppInfo } from "../../shared/version";

const INFO: AppInfo = { version: "0.1.5", channel: "stable", hash: "q5lncvuixtwy", platform: "linux", arch: "x64", bun: "1.3.0" };

describe("aboutText", () => {
  test("names the server this window is on and that server's build", () => {
    expect(aboutText(INFO, { build: "0.1.4" }, "vps")).toBe(
      "Ledge 0.1.5 (stable, q5lncvui) on linux x64; bun 1.3.0\nServer: vps, ledge 0.1.4",
    );
  });

  test("leaves the server line out when no build is known", () => {
    expect(aboutText(INFO, { build: "" }, "This Computer")).toBe("Ledge 0.1.5 (stable, q5lncvui) on linux x64; bun 1.3.0");
  });
});
