#!/usr/bin/env bun
// Assemble the publishable `ledge-server` package into dist-npm/:
//
//   bun run build:npm            every target; what a release publishes
//   bun run build:npm -- --targets=darwin-arm64    one, for a fast local loop
//
// The shape of the package and the rules about what makes one complete live in
// src/bun/npmPackage.ts, where `bun test` can reach them; this file is the part
// that spawns compilers and writes to disk.
//
// Publishing is deliberately NOT here. `npm publish` from a script is a
// one-way action with no undo, and the release runbook (docs/contributor/
// releasing.md) is where irreversible steps belong, next to the signing
// credentials and with a human reading them.
import { chmodSync, copyFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  dockerPlatform,
  ELF_MACHINE,
  elfMachine,
  manifest,
  missingTargets,
  NATIVE_TARGETS,
  nativePath,
  PACKAGE_NAME,
  routeFor,
  type NativeTarget,
} from "../src/bun/npmPackage";
import { nativeLibName } from "../src/bun/ptyNative";

const ROOT = resolve(import.meta.dir, "..");
const OUT = join(ROOT, "dist-npm");

const flag = process.argv.find((a) => a.startsWith("--targets="));
const wanted = flag
  ? new Set(flag.slice("--targets=".length).split(",").map((s) => s.trim()).filter(Boolean))
  : null;
const targets = NATIVE_TARGETS.filter((t) => !wanted || wanted.has(`${t.platform}-${t.arch}`));
if (wanted && targets.length === 0) {
  console.error(`[npm] --targets matched none of: ${NATIVE_TARGETS.map((t) => `${t.platform}-${t.arch}`).join(", ")}`);
  process.exit(2);
}

function run(argv: string[], label: string): void {
  const p = Bun.spawnSync(argv, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0) {
    console.error(`[npm] ${label} failed (exit ${p.exitCode})`);
    process.exit(1);
  }
}

function copyInto(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}

/** The first `n` bytes of a file, for the header checks below. */
function head(path: string, n: number): Uint8Array {
  const buf = new Uint8Array(n);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, n, 0);
  } finally {
    closeSync(fd);
  }
  return buf;
}

// --- start clean -------------------------------------------------------------
//
// A stale tree is the failure this removes: a native directory left by an
// earlier run makes the completeness check below pass while shipping the
// previous build's trampolines.
rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "bin"), { recursive: true });
mkdirSync(join(OUT, "lib"), { recursive: true });

// --- the server, as one file -------------------------------------------------
//
// `--target=bun` and not `--compile`: the point of the package is that npm
// carries every architecture in one tarball, and a compiled binary is one
// architecture by construction. What ships is the bundle plus a trampoline per
// target, which is also why `import.meta.dir` matters — pty.ts resolves native/
// against this file's directory at runtime (bun/pty.ts, libCandidates).
run(
  [process.execPath, "build", "src/bun/serve.ts", "--target=bun", "--outfile", join(OUT, "lib", "serve.js")],
  "bundling src/bun/serve.ts",
);

// --- the hand-written files --------------------------------------------------
copyInto(join(ROOT, "npm", "bin", "ledge-server.js"), join(OUT, "bin", "ledge-server.js"));
// npm preserves the executable bit from the tarball; without it the shebang
// never gets a chance to choose Bun.
chmodSync(join(OUT, "bin", "ledge-server.js"), 0o755);
copyInto(join(ROOT, "npm", "README.md"), join(OUT, "README.md"));
copyInto(join(ROOT, "LICENSE"), join(OUT, "LICENSE"));

// --- the trampolines, one per target ----------------------------------------
const host = process.platform;

// One `cc -arch arm64 -arch x86_64` produces both Mach-O slices, so the Mac
// half is one build and two copies. Verified with lipo rather than assumed:
// build-native.ts falls back to a host-only build when the toolchain cannot do
// the second slice, and the result of that reaching a package is a darwin-x64
// directory holding an arm64 dylib.
const darwin = targets.filter((t) => t.platform === "darwin");
if (darwin.length > 0) {
  if (routeFor(darwin[0]!, host) === "unavailable") {
    console.error(`[npm] the Mach-O trampolines need a Mac to build: this is ${host}.`);
    console.error("[npm] a complete package can only be assembled on macOS (npmPackage.ts, routeFor).");
    process.exit(1);
  }
  run([process.execPath, "scripts/build-native.ts"], "building the universal dylib");
  const dylib = join(ROOT, "dist-native", nativeLibName("darwin"));
  const lipo = Bun.spawnSync(["lipo", "-archs", dylib], { stdout: "pipe", stderr: "pipe" });
  const slices = lipo.stdout.toString().trim().split(/\s+/);
  for (const t of darwin) {
    const want = t.arch === "x64" ? "x86_64" : "arm64";
    if (!slices.includes(want)) {
      console.error(`[npm] ${dylib} has no ${want} slice (lipo says: ${slices.join(", ") || "nothing"}).`);
      console.error("[npm] build-native.ts falls back to a host-only build when cross-compiling fails.");
      process.exit(1);
    }
    copyInto(dylib, join(OUT, nativePath(t)));
  }
}

// The ELF ones come out of a container per architecture, because ELF has no fat
// binary. `--output type=local` needs BuildKit, which is the default in every
// Docker that also understands `--platform`.
for (const t of targets.filter((x) => x.platform === "linux")) {
  const dest = join(OUT, dirname(nativePath(t)));
  mkdirSync(dest, { recursive: true });
  run(
    [
      "docker", "build",
      "--platform", dockerPlatform(t),
      "--target", "native-lib",
      "--output", `type=local,dest=${dest}`,
      ".",
    ],
    `building the ${t.platform}-${t.arch} trampolines`,
  );

  // Docker answers `--platform` with the host's architecture when it has no
  // emulator for the one asked for, and says so in a warning nobody reads.
  const lib = join(OUT, nativePath(t));
  if (!existsSync(lib)) {
    console.error(`[npm] docker produced no ${nativePath(t)}`);
    process.exit(1);
  }
  const got = elfMachine(head(lib, 20));
  const want = ELF_MACHINE[t.arch];
  if (got !== want) {
    console.error(
      `[npm] ${nativePath(t)} declares e_machine ${got === null ? "not-an-ELF" : `0x${got.toString(16)}`}, ` +
        `expected 0x${want!.toString(16)} for ${t.arch}.`,
    );
    console.error(`[npm] docker built for the wrong architecture; check that ${dockerPlatform(t)} can be emulated.`);
    process.exit(1);
  }
}

// --- the manifest, written last ---------------------------------------------
//
// Last because it is what makes the directory a package: a tree that failed
// halfway has no package.json and cannot be packed or published by accident.
const version = (JSON.parse(await Bun.file(join(ROOT, "package.json")).text()) as { version: string }).version;
writeFileSync(join(OUT, "package.json"), JSON.stringify(manifest(version), null, 2) + "\n");

// --- and say what it is ------------------------------------------------------
const present = NATIVE_TARGETS.map((t) => nativePath(t)).filter((p) => existsSync(join(OUT, p)));
const missing = missingTargets(present);
console.log(`[npm] ${PACKAGE_NAME}@${version} assembled in dist-npm/`);
for (const t of NATIVE_TARGETS) {
  const have = present.includes(nativePath(t));
  console.log(`[npm]   ${have ? "✓" : "·"} ${t.platform}-${t.arch}`);
}
if (missing.length > 0) {
  console.warn(`[npm] INCOMPLETE: ${missing.map((t) => `${t.platform}-${t.arch}`).join(", ")} missing.`);
  console.warn("[npm] this tree is for local testing. Do not publish it.");
  process.exit(wanted ? 0 : 1);
}
// `./dist-npm` and not `dist-npm`: npm reads a bare word as a name to look up
// in the registry, and answers a directory that happens to look like one with
// a 404 for a package nobody has published.
console.log("[npm] complete. `npm pack ./dist-npm` to build the tarball; releasing.md publishes it.");
