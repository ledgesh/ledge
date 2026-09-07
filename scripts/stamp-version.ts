#!/usr/bin/env bun
// Add CFBundleShortVersionString to the built app bundle's Info.plist.
// Electrobun writes only CFBundleVersion, and without the short string the
// About panel and Finder's Get Info have no version to show (releasing.md §2).
//
// Runs as both `postBuild` and `postWrap`: a stable build produces two bundles
// with their own generated plists, the app and the self-extracting wrapper that
// carries it inside the DMG, and Finder describes the wrapper until the first
// launch replaces it. Both hooks land after their plist is written and before
// it is signed. A plist edited after signing breaks the signature, which
// surfaces as Gatekeeper refusing the app on someone else's Mac.
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
