#!/usr/bin/env bun
// Compile the PTY trampolines (src/bun/ptyNative.ts) into the library that
// ships beside the code: a signed universal dylib in the Mac app bundle, a
// plain .so beside the server binary on Linux. Runs as electrobun's `preBuild`
// hook, so every `bun run build` and `bun run dev` refreshes it before the copy
// map picks it up; also as a step in the `Dockerfile`, and on its own as
// `bun run build:native`.
//
// This compiles at build time rather than in-process at run time, because
// TinyCC needs the system headers and a machine that downloads Ledge has no
// reason to carry them: a Mac without Xcode or the Command Line Tools has no
// /usr/include, and a debian-slim runtime has no libc6-dev. Whichever machine
// runs this script has the headers by construction. pty.ts falls back to
// compiling in-process when no prebuilt library is on its search path.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { NATIVE_C, NATIVE_LIB } from "../src/bun/ptyNative";

const OUT_DIR = resolve(import.meta.dir, "..", "dist-native");
const OUT = join(OUT_DIR, NATIVE_LIB);
const SRC = join(OUT_DIR, "ledge_pty.c");

const MAC = process.platform === "darwin";

// The oldest macOS the dylib will load on. Without the flag, clang stamps the
// build machine's own version as the minimum, so a dylib built on the newest
// macOS refuses to load on anything older and takes Ctrl-C down with it. 13.0
// is below every other floor in the bundle, so it is never the binding
// constraint.
const MIN_MACOS = "13.0";

// Which slices to build. Electrobun passes the target arch as ELECTROBUN_ARCH
// when it runs this as preBuild; a bare `bun run build:native` has no target,
// so it builds both and the bundle takes what it needs. Universal is also what
// makes a dylib built on an arm64 laptop correct inside an x64 build.
//
// Linux gets no equivalent: ELF has no fat binary, and a second architecture
// there needs a cross toolchain rather than a flag. The server is built in a
// container of its target's architecture instead (`Dockerfile`).
const ARCH_FLAGS: Record<string, string[]> = {
  arm64: ["-arch", "arm64"],
  x64: ["-arch", "x86_64"],
};
const target = process.env["ELECTROBUN_ARCH"];
const arches = !MAC
  ? []
  : target && ARCH_FLAGS[target]
    ? ARCH_FLAGS[target]
    : ["-arch", "arm64", "-arch", "x86_64"];

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(SRC, NATIVE_C);

// -lutil is the one link flag the port needs. It is a no-op on a modern glibc,
// which folded libutil into libc.so.6 in 2.34, and stays for older ones, where
// login_tty and openpty are still in libutil.
function compile(archFlags: string[]): { ok: boolean; stderr: string } {
  const flags = MAC
    ? [...archFlags, `-mmacosx-version-min=${MIN_MACOS}`, "-dynamiclib"]
    : ["-shared", "-fPIC"];
  const p = Bun.spawnSync(["cc", ...flags, "-O2", "-o", OUT, SRC, ...(MAC ? [] : ["-lutil"])], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return { ok: p.exitCode === 0, stderr: p.stderr.toString().trim() };
}

let result = compile(arches);
if (!result.ok && arches.length > 2) {
  // A toolchain that cannot cross-compile the second slice should still yield
  // a working app for the build machine, so retry host-only rather than
  // failing the build.
  console.warn("[native] universal build failed, falling back to this machine's arch:\n" + result.stderr);
  const host = process.arch === "x64" ? "x64" : "arm64";
  result = compile(ARCH_FLAGS[host]);
}
if (!result.ok) {
  console.error(
    "[native] could not compile " + NATIVE_LIB + " — Ledge would ship without Ctrl-C on machines\n" +
      (MAC
        ? "         that have no macOS SDK. Install Xcode or the Command Line Tools.\n"
        : "         that have no libc headers. Install build-essential (or gcc and libc6-dev).\n") +
      result.stderr,
  );
  process.exit(1);
}

// Sign the dylib here, with the same identity and hardened-runtime flag the
// app gets. Electrobun signs the bundle without --deep and sweeps only *.node
// under Resources/app/bun, so nothing else in the pipeline signs this file, and
// an unsigned Mach-O inside the bundle fails notarization.
const identity = MAC ? process.env["ELECTROBUN_DEVELOPER_ID"] : undefined;
if (!MAC) {
  console.log(`[native] ${NATIVE_LIB} built for linux-${process.arch}`);
} else if (identity) {
  const p = Bun.spawnSync(
    ["codesign", "--force", "--timestamp", "--options", "runtime", "--sign", identity, OUT],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (p.exitCode !== 0) {
    console.error("[native] codesign failed:\n" + p.stderr.toString().trim());
    process.exit(1);
  }
  console.log(`[native] ${NATIVE_LIB} built and signed (${identity})`);
} else {
  console.log(`[native] ${NATIVE_LIB} built (unsigned: ELECTROBUN_DEVELOPER_ID is not set)`);
}

if (!existsSync(OUT)) process.exit(1);
