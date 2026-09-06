import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import config from "../../electrobun.config";
import { BUILD_VERSION } from "../shared/version";
import { manifest } from "./npmPackage";

const ROOT = resolve(import.meta.dir, "..", "..");

// The build config decides what a released app is, and the release path that
// consumes it runs about once per release. These tests cover the parts of it
// that fail silently. A wrong version reaches users as a wrong About box. A
// build that skips signing reaches them as an app that will not open.
describe("the release build config", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    version: string;
    scripts: Record<string, string>;
  };

  // Two files carry the version. electrobun.config.ts is the copy that reaches
  // the bundle: it becomes CFBundleVersion, and scripts/stamp-version.ts copies
  // it into CFBundleShortVersionString. package.json is the copy a reader looks
  // at first. A release where they disagree ships a bundle whose version is not
  // the one the repo names.
  test("both files name the same version", () => {
    expect(config.app.version).toBe(pkg.version);
  });

  // shared/version.ts holds a third copy, for the server. The server has no
  // Electrobun runtime to ask for a version, and the number it reports in its
  // handshake is the build a client sees across an ssh connection.
  test("the server reports that version too", () => {
    expect(BUILD_VERSION).toBe(pkg.version);
  });

  // npm carries a fourth copy. The handshake's refusal names the build the peer
  // is running (remote.md §11), and a `ledge-server` published under any other
  // version would put a build nobody can install into that message. The
  // published package.json is generated from `manifest` by scripts/build-npm.ts
  // rather than checked in, which is what stops that drift (npmPackage.ts,
  // releasing.md §2).
  test("a published server is versioned as the app it belongs to", () => {
    expect(manifest(pkg.version).version).toBe(BUILD_VERSION);
  });

  // A range or a leading v is accepted into package.json and then rejected at
  // publish. npm checks the version where Apple's tools do not: the same string
  // goes into the plist below without complaint.
  test("the package version is a plain semver", () => {
    expect(manifest(pkg.version).version).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
  });

  // CFBundleShortVersionString has a defined grammar: one to three
  // dot-separated integers. Apple's tools accept `v0.1.0` or `0.1.0-beta` into
  // the plist and then sort them wrongly.
  test("the version is a plain release number", () => {
    expect(config.app.version).toMatch(/^\d+(\.\d+){0,2}$/);
  });

  test("the release script builds the stable channel", () => {
    expect(pkg.scripts["release"]).toContain("--env=stable");
    // The preflight catches a mistyped signing identity before the build
    // starts, rather than minutes later when the build fails at signing.
    expect(pkg.scripts["release"]).toContain("release-preflight.ts");
  });
});

// LEDGE_UNSIGNED turns signing off. These tests pin both positions of the
// switch: on when nobody sets the variable, and off for both codesign and
// notarize when it is set. Each case reads the config from a fresh process,
// because electrobun.config.ts decides `signed` at import time.
describe("signing", () => {
  function macConfigWith(env: Record<string, string | undefined>): { codesign: boolean; notarize: boolean } {
    const p = Bun.spawnSync(
      [process.execPath, "-e", "import c from './electrobun.config'; console.log(JSON.stringify(c.build.mac))"],
      { cwd: ROOT, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" },
    );
    if (p.exitCode !== 0) throw new Error(p.stderr.toString());
    return JSON.parse(p.stdout.toString()) as { codesign: boolean; notarize: boolean };
  }

  test("is on unless it is deliberately turned off", () => {
    const mac = macConfigWith({ LEDGE_UNSIGNED: undefined });
    expect(mac.codesign).toBe(true);
    expect(mac.notarize).toBe(true);
  });

  test("LEDGE_UNSIGNED=1 turns off both halves, not one", () => {
    // Gatekeeper refuses an app that is signed but not notarized. A dry run
    // that turned off only one of the two would spend the notarization round
    // trip to Apple's servers and prove nothing.
    const mac = macConfigWith({ LEDGE_UNSIGNED: "1" });
    expect(mac.codesign).toBe(false);
    expect(mac.notarize).toBe(false);
  });
});
