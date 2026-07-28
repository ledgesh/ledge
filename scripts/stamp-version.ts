#!/usr/bin/env bun
// Add CFBundleShortVersionString to the built app bundle's Info.plist.
// Electrobun's template writes CFBundleVersion and stops there, and the two
// keys are not interchangeable: the short string is the RELEASE version, and
// it is what macOS shows in the About panel (the first item in the app menu)
// and in Finder's Get Info. Without it the About box can only show a build
// number, and an app that cannot name its own version is a poor thing to hand
// someone who is about to file a bug.
//
// Runs as BOTH `postBuild` and `postWrap`, because a stable build produces two
// bundles and each gets its own generated Info.plist: the app itself, and the
// self-extracting wrapper that carries it inside the DMG. The wrapper is what
// a user downloads and what Finder describes until the first launch replaces
// it, so a version on one and not the other is only half an answer. Both hooks
// land after their plist is written and before it is signed, and that order is
// the whole reason for the choice: a plist edited after signing breaks the
// signature, and the break only shows up as Gatekeeper refusing the app on
// someone else's Mac.
import { readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const buildDir = process.env["ELECTROBUN_BUILD_DIR"];
const version = process.env["ELECTROBUN_APP_VERSION"];
if (!buildDir || !version) {
  console.error("[version] ELECTROBUN_BUILD_DIR and ELECTROBUN_APP_VERSION are set by electrobun; run this as its postBuild/postWrap hook.");
  process.exit(1);
}

// postWrap names its bundle outright. postBuild does not, so the app is found
// by extension: it is `Ledge.app` on the stable channel and `Ledge-dev.app` on
// the dev one, and a hardcoded name would fail on whichever of the two nobody
// tried.
const wrapper = process.env["ELECTROBUN_WRAPPER_BUNDLE_PATH"];
const bundles = wrapper ? [resolve(wrapper)] : readdirSync(resolve(buildDir)).filter((e) => e.endsWith(".app")).map((e) => join(resolve(buildDir), e));
if (bundles.length === 0) {
  console.error(`[version] no .app bundle in ${buildDir} — the hook ran before the bundle existed.`);
  process.exit(1);
}

for (const bundlePath of bundles) {
  const bundle = basename(bundlePath);
  const plist = join(bundlePath, "Contents", "Info.plist");
  // -replace rather than -insert: it writes the key whether or not it is
  // already there, so this stays correct if electrobun starts emitting it.
  const p = Bun.spawnSync(["plutil", "-replace", "CFBundleShortVersionString", "-string", version, plist], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (p.exitCode !== 0) {
    console.error(`[version] could not stamp ${bundle}:\n` + p.stderr.toString().trim());
    process.exit(1);
  }
  console.log(`[version] ${bundle} is version ${version}`);
}
