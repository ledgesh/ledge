#!/usr/bin/env bun
// Assemble a server release into dist-server/ (remote.md §11):
//
//   bun run build:server                          every target; what a release publishes
//   bun run build:server -- --targets=linux-arm64 one, for a fast local loop
//   --out=<dir>                                   somewhere other than dist-server/
//
// It runs build-npm.ts, packs dist-npm/ into the tarball a release publishes, and
// renders server.sh with that tarball's checksum and the Bun pinned in
// src/bun/serverRelease.ts. Publishing is not here: releasing.md §6 does it by hand.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { NATIVE_TARGETS } from "../src/bun/npmPackage";
import {
  BUN_PACKAGES,
  BUN_VERSION,
  INSTALL_SCRIPT,
  REGISTRY,
  renderInstallScript,
  serverTarball,
  SUMS_FILE,
  sumsText,
  tarballPath,
  targetKey,
} from "../src/bun/serverRelease";

const ROOT = resolve(import.meta.dir, "..");
// build:wsl builds a one-target release with this, into a directory that is
// never the one releasing.md §6 publishes from.
const outFlag = process.argv.find((a) => a.startsWith("--out="));
const OUT = outFlag ? resolve(ROOT, outFlag.slice("--out=".length)) : join(ROOT, "dist-server");
/** The Bun tarballs, downloaded once to check the pins and kept for probe:install. */
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

function run(argv: string[], label: string): string {
  const p = Bun.spawnSync(argv, { cwd: ROOT, stdout: "pipe", stderr: "inherit" });
  if (p.exitCode !== 0) {
    console.error(`[server] ${label} failed (exit ${p.exitCode})`);
    process.exit(1);
  }
  return p.stdout.toString();
}

function sha256(file: string): string {
  return new Bun.CryptoHasher("sha256").update(readFileSync(file)).digest("hex");
}

// --- the package, packed ------------------------------------------------------
const npm = Bun.spawnSync([process.execPath, "scripts/build-npm.ts", ...(flag ? [flag] : [])], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
if (npm.exitCode !== 0) {
  console.error(`[server] build-npm.ts failed (exit ${npm.exitCode})`);
  process.exit(1);
}
const version = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
// `./dist-npm` because npm reads a bare word as a package name (build-npm.ts).
const packed = JSON.parse(run(["npm", "pack", "./dist-npm", "--pack-destination", OUT, "--json"], "npm pack")) as Array<{ filename: string }>;
const tarball = serverTarball(version);
if (packed[0]?.filename !== tarball) {
  console.error(`[server] npm pack wrote ${packed[0]?.filename}, and server.sh downloads ${tarball}`);
  process.exit(1);
}

// --- the Bun each target installs, checked against its pin -------------------
for (const t of targets) {
  const pkg = BUN_PACKAGES[targetKey(t)]!;
  const path = tarballPath(pkg.name, BUN_VERSION);
  const file = join(CACHE, path);
  if (!existsSync(file)) {
    console.log(`[server] downloading ${REGISTRY}/${path}`);
    const res = await fetch(`${REGISTRY}/${path}`);
    if (!res.ok) {
      console.error(`[server] ${REGISTRY}/${path} answered ${res.status}`);
      process.exit(1);
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, new Uint8Array(await res.arrayBuffer()));
  }
  const got = sha256(file);
  if (got !== pkg.sha256) {
    rmSync(file, { force: true });
    console.error(`[server] ${path} does not match its pin: expected ${pkg.sha256}, got ${got}. The file was deleted.`);
    process.exit(1);
  }
}

// --- the script, then the sums that cover it ---------------------------------
const template = readFileSync(join(ROOT, "release", "server.sh"), "utf8");
const serverSum = sha256(join(OUT, tarball));
writeFileSync(join(OUT, INSTALL_SCRIPT), renderInstallScript(template, { version, registry: REGISTRY, serverSum }));
chmodSync(join(OUT, INSTALL_SCRIPT), 0o755);
writeFileSync(
  join(OUT, SUMS_FILE),
  sumsText([
    { name: tarball, sha256: serverSum },
    { name: INSTALL_SCRIPT, sha256: sha256(join(OUT, INSTALL_SCRIPT)) },
  ]),
);

console.log(`[server] ledge-server ${version} with Bun ${BUN_VERSION}, in ${OUT}`);
console.log(`[server]   ${tarball}  ${(statSync(join(OUT, tarball)).size / 1e3).toFixed(0)} KB`);
for (const t of NATIVE_TARGETS) console.log(`[server]   ${targets.includes(t) ? "✓" : "·"} ${targetKey(t)}`);
if (targets.length < NATIVE_TARGETS.length) {
  console.warn("[server] INCOMPLETE: the tarball lacks the targets not built, and server.sh refuses those machines. Do not publish either.");
}
