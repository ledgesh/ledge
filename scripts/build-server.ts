#!/usr/bin/env bun
// Assemble a server release into dist-server/ (remote.md §11):
//
//   bun run build:server                          every target; what a release uploads
//   bun run build:server -- --targets=linux-arm64 one, for a fast local loop
//
// It runs build-npm.ts first and packs the same bundle and trampolines, one
// tarball per target with the pinned Bun beside them (src/bun/serverRelease.ts).
// Uploading is not here: the GitHub release is created by hand (releasing.md §6).
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { NATIVE_TARGETS, nativePath, type NativeTarget } from "../src/bun/npmPackage";
import {
  BUN_LICENSE,
  BUN_VERSION,
  bunBuild,
  bunZipUrl,
  INSTALL_SCRIPT,
  releaseDownload,
  releaseName,
  renderInstallScript,
  SUMS_FILE,
  sumsText,
  targetKey,
} from "../src/bun/serverRelease";

const ROOT = resolve(import.meta.dir, "..");
const NPM = join(ROOT, "dist-npm");
const OUT = join(ROOT, "dist-server");
const CACHE = join(ROOT, "dist-bun", `bun-v${BUN_VERSION}`);

const flag = process.argv.find((a) => a.startsWith("--targets="));
const wanted = flag
  ? new Set(flag.slice("--targets=".length).split(",").map((s) => s.trim()).filter(Boolean))
  : null;
const targets = NATIVE_TARGETS.filter((t) => !wanted || wanted.has(targetKey(t)));
if (wanted && targets.length === 0) {
  console.error(`[server] --targets matched none of: ${NATIVE_TARGETS.map(targetKey).join(", ")}`);
  process.exit(2);
}

function run(argv: string[], label: string, env?: Record<string, string>): void {
  const p = Bun.spawnSync(argv, { cwd: ROOT, stdout: "inherit", stderr: "inherit", env: { ...process.env, ...env } });
  if (p.exitCode !== 0) {
    console.error(`[server] ${label} failed (exit ${p.exitCode})`);
    process.exit(1);
  }
}

function sha256(file: string): string {
  return new Bun.CryptoHasher("sha256").update(readFileSync(file)).digest("hex");
}

/** A pinned download, fetched once into dist-bun/ and checked every time it is used. */
async function pinned(url: string, file: string, want: string): Promise<string> {
  if (!existsSync(file)) {
    console.log(`[server] downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`[server] ${url} answered ${res.status}`);
      process.exit(1);
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, new Uint8Array(await res.arrayBuffer()));
  }
  const got = sha256(file);
  if (got !== want) {
    rmSync(file, { force: true });
    console.error(`[server] ${url} does not match its pin: expected ${want}, got ${got}. The file was deleted.`);
    process.exit(1);
  }
  return file;
}

// --- the package this release packs ------------------------------------------
run([process.execPath, "scripts/build-npm.ts", ...(flag ? [flag] : [])], "build-npm.ts");
const version = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const license = await pinned(BUN_LICENSE.url, join(CACHE, "LICENSE.md"), BUN_LICENSE.sha256);

// --- one tarball per target ---------------------------------------------------
const sums: Array<{ name: string; sha256: string }> = [];
const byTarget: Record<string, string> = {};
for (const t of targets) {
  const name = releaseName(version, t);
  const stage = join(OUT, "stage", name);
  const build = bunBuild(t);
  const zip = await pinned(bunZipUrl(t), join(CACHE, `${build.asset}.zip`), build.sha256);

  mkdirSync(stage, { recursive: true });
  const bun = Bun.spawnSync(["unzip", "-p", zip, `${build.asset}/bun`], { stdout: "pipe", stderr: "pipe" });
  if (bun.exitCode !== 0 || bun.stdout.length === 0) {
    console.error(`[server] ${zip} has no ${build.asset}/bun: ${bun.stderr.toString().trim()}`);
    process.exit(1);
  }
  writeFileSync(join(stage, "bun"), bun.stdout);
  chmodSync(join(stage, "bun"), 0o755);

  const copy = (from: string, to: string) => {
    mkdirSync(dirname(join(stage, to)), { recursive: true });
    copyFileSync(from, join(stage, to));
  };
  copy(join(NPM, "bin", "ledge-server.js"), "bin/ledge-server.js");
  copy(join(NPM, "lib", "serve.js"), "lib/serve.js");
  copy(join(NPM, nativePath(t)), nativePath(t));
  copy(join(ROOT, "LICENSE"), "LICENSE");
  copy(join(ROOT, "THIRD-PARTY-NOTICES.md"), "THIRD-PARTY-NOTICES.md");
  copy(license, "LICENSE.bun.md");

  // COPYFILE_DISABLE and --no-xattrs keep macOS's `._` files and extended
  // attributes out of a tarball Linux unpacks.
  const file = `${name}.tar.gz`;
  run(["tar", "--no-xattrs", "-czf", join(OUT, file), "-C", join(OUT, "stage"), name], `packing ${file}`, {
    COPYFILE_DISABLE: "1",
  });
  const sum = sha256(join(OUT, file));
  sums.push({ name: file, sha256: sum });
  byTarget[targetKey(t)] = sum;
}
rmSync(join(OUT, "stage"), { recursive: true, force: true });

// --- the script, then the sums that cover it ---------------------------------
const template = readFileSync(join(ROOT, "release", "server.sh"), "utf8");
writeFileSync(join(OUT, INSTALL_SCRIPT), renderInstallScript(template, { version, download: releaseDownload(version), sums: byTarget }));
chmodSync(join(OUT, INSTALL_SCRIPT), 0o755);
sums.push({ name: INSTALL_SCRIPT, sha256: sha256(join(OUT, INSTALL_SCRIPT)) });
writeFileSync(join(OUT, SUMS_FILE), sumsText(sums));

console.log(`[server] ledge-server ${version} with Bun ${BUN_VERSION}, in dist-server/`);
for (const t of NATIVE_TARGETS) {
  const file = join(OUT, `${releaseName(version, t)}.tar.gz`);
  const size = existsSync(file) ? `${(statSync(file).size / 1e6).toFixed(1)} MB` : "not built";
  console.log(`[server]   ${targets.includes(t as NativeTarget) ? "✓" : "·"} ${targetKey(t)}  ${size}`);
}
if (targets.length < NATIVE_TARGETS.length) {
  console.warn("[server] INCOMPLETE: this server.sh refuses the targets not built. Do not upload it.");
}
