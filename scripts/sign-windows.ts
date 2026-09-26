// Signs a Windows release with Azure Artifact Signing (releasing.md §10). Two
// Electrobun hooks call this: sign-windows-app.ts after the build, so the
// update tarball and the installer carry signed executables, and
// sign-windows-setup.ts after packaging, for the installer itself. The scripts
// they run are built in src/bun/windowsSigning.ts.
//
// It signs as whoever the Azure CLI is signed in as. The release workflow's
// `azure/login` step does that, and installs the ArtifactSigning module the
// scripts import. release-preflight.ts checks both before the build starts.
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractSetupScript,
  isSetupZip,
  isSignable,
  replaceSetupScript,
  signScript,
  signsWindows,
  unsignedScript,
} from "../src/bun/windowsSigning";

/** Runs a PowerShell 7 script and returns what it printed. A script goes in a
 * file rather than on the command line, which a long file list would outgrow. */
function pwsh(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ledge-sign-"));
  try {
    const file = join(dir, "run.ps1");
    writeFileSync(file, script);
    const p = Bun.spawnSync(["pwsh", "-NoProfile", "-NonInteractive", "-File", file], { stdout: "pipe", stderr: "pipe" });
    const out = p.stdout.toString();
    if (p.exitCode !== 0) {
      throw new Error(`pwsh exited ${p.exitCode}:\n${out}${p.stderr.toString()}`);
    }
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function unsigned(files: readonly string[]): string[] {
  if (files.length === 0) return [];
  return pwsh(unsignedScript(files))
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

/** Signs whichever of `files` lack a valid signature, then fails unless every
 * one of them has one. */
function signAll(files: readonly string[], what: string): void {
  const todo = unsigned(files);
  if (todo.length === 0) {
    console.log(`[sign] ${what}: all ${files.length} already signed`);
    return;
  }
  for (const f of todo) console.log(`[sign] ${what}: signing ${f}`);
  pwsh(signScript(todo));
  const still = unsigned(files);
  if (still.length > 0) throw new Error(`still unsigned after signing:\n  ${still.join("\n  ")}`);
  console.log(`[sign] ${what}: ${todo.length} signed`);
}

function signableUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...signableUnder(path));
    else if (isSignable(name)) out.push(path);
  }
  return out;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[sign] ${name} is set by electrobun; run this as its build hook.`);
    process.exit(1);
  }
  return value;
}

/** The postBuild hook: every executable and library in the built app that is
 * not signed already. */
export function signApp(): void {
  if (!signsWindows(process.env)) {
    console.log("[sign] not a signed Windows build; nothing to sign");
    return;
  }
  const files = signableUnder(required("ELECTROBUN_BUILD_DIR"));
  if (files.length === 0) throw new Error("no .exe or .dll in the build: the hook ran before the app existed");
  signAll(files, "app");
}

/** The postPackage hook: the installer inside each setup zip, and a second
 * look at the app, in case packaging rewrote a file after it was signed. */
export function signSetup(): void {
  if (!signsWindows(process.env)) {
    console.log("[sign] not a signed Windows build; nothing to sign");
    return;
  }
  const still = unsigned(signableUnder(required("ELECTROBUN_BUILD_DIR")));
  if (still.length > 0) throw new Error(`packaging left the app unsigned:\n  ${still.join("\n  ")}`);

  const artifacts = required("ELECTROBUN_ARTIFACT_DIR");
  const zips = readdirSync(artifacts).filter(isSetupZip);
  if (zips.length === 0) throw new Error(`no setup zip in ${artifacts}`);
  for (const name of zips) {
    const zip = join(artifacts, name);
    const dir = mkdtempSync(join(tmpdir(), "ledge-setup-"));
    try {
      const exe = pwsh(extractSetupScript(zip, dir)).trim().split(/\r?\n/).pop()!.trim();
      signAll([exe], name);
      pwsh(replaceSetupScript(zip, exe));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
