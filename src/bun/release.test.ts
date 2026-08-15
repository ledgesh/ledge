import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import config from "../../electrobun.config";
import { BUILD_VERSION } from "../shared/version";
import { manifest } from "./npmPackage";

const ROOT = resolve(import.meta.dir, "..", "..");

// The build config decides what a released app IS, and it is exercised about
// once per release. These are the parts of it that fail silently: a wrong
// version reaches users as a wrong About box, and a build that skips signing
// reaches them as an app that will not open.
describe("the release build config", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    version: string;
    scripts: Record<string, string>;
  };

  // Two files carry the version. electrobun.config.ts is the one that becomes
  // CFBundleVersion and CFBundleShortVersionString; package.json is the one a
  // reader looks at first. A release where they disagree has no version.
  test("both files name the same version", () => {
    expect(config.app.version).toBe(pkg.version);
  });

  // A third, for the server: it has no Electrobun runtime to ask
  // (shared/version.ts), and the number it reports is what a client compares
  // builds against across an ssh connection.
  test("the server reports that version too", () => {
    expect(BUILD_VERSION).toBe(pkg.version);
  });

  // And a fourth, on npm. The handshake refuses a schema mismatch by naming
  // both builds (remote.md §11), so the number a published `ledge-server`
  // reports has to be the number it was published under — a package whose
  // version is its own would make that message name a build nobody can
  // install. Generated rather than checked in for exactly this reason;
  // the test is what makes the generator's input the right one.
  test("a published server is versioned as the app it belongs to", () => {
    expect(manifest(pkg.version).version).toBe(BUILD_VERSION);
  });

  // npm's own grammar, which is stricter than Apple's above: a range or a
  // leading v is accepted into package.json and rejected at publish.
  test("the package version is a plain semver", () => {
    expect(manifest(pkg.version).version).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
  });

  // CFBundleShortVersionString has a defined grammar: one to three
  // dot-separated integers. Apple's tools accept `v0.1.0` or `0.1.0-beta` into
  // the plist and then sort them wrongly forever.
  test("the version is a plain release number", () => {
    expect(config.app.version).toMatch(/^\d+(\.\d+){0,2}$/);
  });

  test("the release script builds the stable channel", () => {
    expect(pkg.scripts["release"]).toContain("--env=stable");
    // The preflight is the only thing standing between a mistyped identity and
    // a three-minute build that fails at the end of it.
    expect(pkg.scripts["release"]).toContain("release-preflight.ts");
  });
});

// The escape hatch is a switch that turns signing OFF, so the interesting
// question is which way it points when nobody touches it. Read from a fresh
// process because the config decides this at import time.
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
    // Signing without notarizing produces an app Gatekeeper still refuses, so
    // a dry run that dropped only one of them would waste the round trip and
    // prove nothing.
    const mac = macConfigWith({ LEDGE_UNSIGNED: "1" });
    expect(mac.codesign).toBe(false);
    expect(mac.notarize).toBe(false);
  });
});
