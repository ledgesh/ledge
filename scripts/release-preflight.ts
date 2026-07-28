#!/usr/bin/env bun
// Everything `bun run release` needs, checked before it starts. A signed and
// notarized build takes minutes and asks Apple's servers for two round trips;
// discovering a missing environment variable at the end of that is the kind of
// thing that turns a release into an evening. Each failure below names the
// thing to do about it, because a release is run rarely and usually by someone
// who last did it months ago.
//
// This checks the inputs. It cannot check the output: whether the signed app
// actually runs under the hardened runtime is a live question that only the
// signed build can answer, and docs/contributor/releasing.md carries that
// checklist.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import config from "../electrobun.config";

const ROOT = resolve(import.meta.dir, "..");
const problems: string[] = [];
const notes: string[] = [];

function ok(line: string): void {
  console.log(`  ok    ${line}`);
}
function bad(line: string, fix: string): void {
  console.log(`  FAIL  ${line}`);
  problems.push(`${line}\n        ${fix}`);
}

console.log("release preflight");

// --- the version --------------------------------------------------------------
// Two files carry it and only one reaches the bundle, so they are checked
// together here and in src/bun/release.test.ts.
const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as { version: string };
if (pkg.version === config.app.version) {
  ok(`version ${config.app.version}`);
} else {
  bad(
    `package.json says ${pkg.version}, electrobun.config.ts says ${config.app.version}`,
    "Set both to the version being released.",
  );
}

// A dirty tree is not fatal: a release is sometimes cut with a local tweak in
// hand. It is worth saying out loud, because the artifact is about to be
// stamped with a commit that does not describe it.
const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
if (status.stdout.toString().trim().length > 0) {
  notes.push("The working tree has uncommitted changes; the build will include them.");
}

// --- signing ------------------------------------------------------------------
if (process.env["LEDGE_UNSIGNED"] === "1") {
  console.log("  skip  signing and notarization (LEDGE_UNSIGNED=1)");
  notes.push(
    "This is a dry run. The .app it produces runs on this Mac and nowhere else:\n" +
      "Gatekeeper rejects an unsigned bundle on any machine it did not come from.",
  );
} else {
  const identity = process.env["ELECTROBUN_DEVELOPER_ID"];
  if (!identity) {
    bad(
      "ELECTROBUN_DEVELOPER_ID is not set",
      'Set it to the full certificate name, e.g. "Developer ID Application: Your Name (TEAMID)".\n' +
        "        `security find-identity -v -p codesigning` lists what this Mac has.",
    );
  } else {
    // Matched against the keychain rather than merely being non-empty: a typo
    // here fails deep inside the build, one `codesign` call at a time.
    const found = Bun.spawnSync(["security", "find-identity", "-v", "-p", "codesigning"], {
      stdout: "pipe",
      stderr: "pipe",
    }).stdout.toString();
    if (found.includes(identity)) {
      ok(`signing identity ${identity}`);
    } else {
      bad(
        `no codesigning identity named ${identity} in the keychain`,
        "Create a Developer ID Application certificate at developer.apple.com and download it,\n" +
          "        or unlock the keychain that holds it. `security find-identity -v -p codesigning` lists them.",
      );
    }
  }

  // Before the credentials, because the check below is made THROUGH this tool.
  // notarytool ships with Xcode, not with the Command Line Tools alone.
  const notarytool = Bun.spawnSync(["xcrun", "--find", "notarytool"], { stdout: "pipe", stderr: "pipe" });
  if (notarytool.exitCode === 0) ok("xcrun notarytool");
  else bad("xcrun cannot find notarytool", "Install Xcode (the Command Line Tools alone do not carry it) and run `sudo xcode-select -s /Applications/Xcode.app`.");

  // Notarization takes either of two credential sets. Both are all-or-nothing,
  // so a half-filled one is reported as the mistake it is rather than as an
  // absence.
  const apiKey = ["ELECTROBUN_APPLEAPIISSUER", "ELECTROBUN_APPLEAPIKEY", "ELECTROBUN_APPLEAPIKEYPATH"];
  const appleId = ["ELECTROBUN_APPLEID", "ELECTROBUN_APPLEIDPASS", "ELECTROBUN_TEAMID"];
  const have = (names: string[]) => names.filter((n) => (process.env[n] ?? "").length > 0);
  const keyHave = have(apiKey);
  const idHave = have(appleId);

  // Asking Apple rather than inspecting the strings. Every cheap check here
  // passes on a placeholder: the issuer is a UUID nobody can validate offline,
  // and a revoked key looks exactly like a live one. `notarytool history` is
  // the smallest call that authenticates, and it answers in a second or two
  // against a build that takes minutes and dies at the very end.
  function credentialsWork(args: string[]): void {
    if (notarytool.exitCode !== 0) return; // already reported; nothing to ask with
    const p = Bun.spawnSync(["xcrun", "notarytool", "history", ...args], { stdout: "pipe", stderr: "pipe" });
    if (p.exitCode === 0) {
      ok("Apple accepts the notarization credentials");
      return;
    }
    const why = (p.stderr.toString() + p.stdout.toString()).trim().split("\n").slice(0, 4).join("\n        ");
    bad("Apple rejected the notarization credentials", `${why}\n        Check the issuer UUID, the key ID, and that the key is still active in App Store Connect.`);
  }

  if (keyHave.length === apiKey.length) {
    const path = process.env["ELECTROBUN_APPLEAPIKEYPATH"]!;
    if (!existsSync(path)) {
      bad(`ELECTROBUN_APPLEAPIKEYPATH points at nothing: ${path}`, "Point it at the .p8 file downloaded from App Store Connect.");
    } else {
      ok("notarization credentials (App Store Connect API key)");
      credentialsWork([
        "--key", path,
        "--key-id", process.env["ELECTROBUN_APPLEAPIKEY"]!,
        "--issuer", process.env["ELECTROBUN_APPLEAPIISSUER"]!,
      ]);
    }
  } else if (idHave.length === appleId.length) {
    ok("notarization credentials (Apple ID and app-specific password)");
    credentialsWork([
      "--apple-id", process.env["ELECTROBUN_APPLEID"]!,
      "--password", process.env["ELECTROBUN_APPLEIDPASS"]!,
      "--team-id", process.env["ELECTROBUN_TEAMID"]!,
    ]);
  } else if (keyHave.length > 0 || idHave.length > 0) {
    const partial = keyHave.length > 0 ? apiKey : appleId;
    bad(
      `notarization credentials are half set: missing ${partial.filter((n) => !(process.env[n] ?? "").length).join(", ")}`,
      "Set the rest of that set, or unset it and use the other one.",
    );
  } else {
    bad(
      "no notarization credentials",
      "Set ELECTROBUN_APPLEAPIISSUER, ELECTROBUN_APPLEAPIKEY and ELECTROBUN_APPLEAPIKEYPATH (App Store Connect API key),\n" +
        "        or ELECTROBUN_APPLEID, ELECTROBUN_APPLEIDPASS and ELECTROBUN_TEAMID (Apple ID with an app-specific password).",
    );
  }
}

for (const note of notes) console.log(`  note  ${note.replace(/\n/g, "\n        ")}`);

if (problems.length > 0) {
  console.error(`\n${problems.length} problem${problems.length === 1 ? "" : "s"} to fix before releasing:\n`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error("\nTo package without signing anything, run: LEDGE_UNSIGNED=1 bun run release");
  process.exit(1);
}
console.log("ready\n");
