// What the published `ledge-server` package contains, and what makes one
// complete. The half of `scripts/build-npm.ts` that `bun test` can reach.
//
// The package exists because the alternative was asking a user to clone the
// repo, compile a binary on a machine of matching architecture, and copy two
// files that have to stay adjacent (docs/contributor/remote.md §11). Every
// comparable tool installs its far end in one step, and the reason Ledge could
// not was never the architecture: it was that `bun build --compile` produces
// one artifact per target and the trampolines sit BESIDE it as a second file.
// A package inverts both problems. npm already solves "one artifact per
// target" by shipping every target in one tarball, and it already solves
// adjacency by installing a directory rather than two loose files.
//
// What it costs, stated where the decision is: bun has to exist on the far
// machine. The compiled binary needed nothing there, and this needs a runtime.
// For the audience — a developer's own VPS — that is one curl, and it buys
// away the architecture matrix, the glibc floor as a user-facing rule, and the
// adjacency rule whose failure mode is Ctrl-C quietly not working.
import { nativeDir, nativeLibName } from "./ptyNative";

/** The name on npm, and the command it installs. */
export const PACKAGE_NAME = "ledge-server";

/**
 * The Bun floor. It is the version the suite runs on rather than the oldest
 * one that would work, and it points that way deliberately: too high asks
 * somebody to upgrade Bun, too low lets them find out from a stack trace.
 * Nothing in the server's runtime surface is exotic (dlopen, spawn, sockets),
 * so lowering it is an evidence question rather than a porting one.
 */
export const BUN_FLOOR = ">=1.3.0";

export interface NativeTarget {
  platform: "darwin" | "linux";
  arch: "arm64" | "x64";
}

/**
 * Every machine an installed package must be able to serve, all four carried
 * at once (ptyNative.ts, nativeDir).
 *
 * darwin-x64 is here and the Mac APP is arm64-only, which is not an
 * inconsistency: an old Intel Mac is a plausible always-on box for exactly the
 * user this is for, and the slice costs 33KB inside a tarball that is already
 * being downloaded.
 */
export const NATIVE_TARGETS: readonly NativeTarget[] = [
  { platform: "darwin", arch: "arm64" },
  { platform: "darwin", arch: "x64" },
  { platform: "linux", arch: "x64" },
  { platform: "linux", arch: "arm64" },
];

/** Where one target's trampolines sit, relative to the package root. */
export function nativePath(target: NativeTarget): string {
  return `lib/native/${nativeDir(target.platform, target.arch)}/${nativeLibName(target.platform)}`;
}

export type BuildRoute = "universal-dylib" | "docker" | "unavailable";

/**
 * How one target's trampolines get built on `hostPlatform`.
 *
 * The Mach-O slices come from one universal dylib because `cc -arch a -arch b`
 * on a Mac is a flag; the ELF ones come from a container per architecture
 * because ELF has no fat binary and a second architecture on Linux means a
 * cross toolchain (scripts/build-native.ts says the same thing from the other
 * side). What falls out is a rule worth stating plainly rather than
 * discovering: a COMPLETE package can only be assembled on a Mac. A Linux host
 * can build both Linux slices and cannot produce a Mach-O at all.
 */
export function routeFor(target: NativeTarget, hostPlatform: string): BuildRoute {
  if (target.platform !== "darwin") return "docker";
  return hostPlatform === "darwin" ? "universal-dylib" : "unavailable";
}

/** The Docker platform string for a target `routeFor` sends to a container. */
export function dockerPlatform(target: NativeTarget): string {
  return `linux/${target.arch === "x64" ? "amd64" : "arm64"}`;
}

/**
 * The targets `present` does not cover, given the package-relative paths a
 * tree actually holds.
 *
 * One function so the build script and the test that reads the built tree
 * agree on what "publishable" means. A package missing a target is not a
 * degraded package: on that machine it is a server whose shells have no
 * controlling terminal.
 */
export function missingTargets(present: readonly string[]): NativeTarget[] {
  const have = new Set(present);
  return NATIVE_TARGETS.filter((t) => !have.has(nativePath(t)));
}

/**
 * The `e_machine` an ELF built for each architecture declares. ELF's own
 * numbering, from the psABI: 0x3E is x86-64 and 0xB7 is AArch64.
 */
export const ELF_MACHINE: Readonly<Record<string, number>> = { x64: 0x3e, arm64: 0xb7 };

/**
 * The architecture an ELF header declares, or null when the bytes are not an
 * ELF at all.
 *
 * Worth doing rather than trusting the build: `docker build --platform` is a
 * request, and a daemon without the emulator for that platform can answer it
 * with the host's architecture instead. What ships then is a package whose
 * linux-arm64 slice is x86-64, which fails on the user's machine as a dlopen
 * error and falls through to the no-terminal path — the exact quiet failure
 * shipping prebuilt trampolines exists to prevent.
 */
export function elfMachine(header: Uint8Array): number | null {
  if (header.length < 20) return null;
  if (header[0] !== 0x7f || header[1] !== 0x45 || header[2] !== 0x4c || header[3] !== 0x46) return null;
  // e_machine is two bytes at 0x12, in the endianness EI_DATA (byte 5) names.
  const little = header[5] !== 2;
  const lo = header[0x12] ?? 0;
  const hi = header[0x13] ?? 0;
  return little ? lo | (hi << 8) : hi | (lo << 8);
}

export interface Manifest {
  name: string;
  version: string;
  description: string;
  license: string;
  type: "module";
  bin: Record<string, string>;
  files: string[];
  engines: { bun: string };
  os: string[];
  cpu: string[];
  repository: { type: string; url: string };
  homepage: string;
  keywords: string[];
}

/**
 * The published package.json, generated rather than checked in so its version
 * cannot drift from the app's (release.test.ts holds that).
 *
 * `os` and `cpu` are the two fields npm ENFORCES: an install on Windows fails
 * with EBADPLATFORM instead of succeeding into a server that cannot open a
 * pty. `private` is deliberately absent — the root package.json carries it,
 * this one must not, and a copied field would be a publish that silently
 * refuses.
 */
export function manifest(version: string): Manifest {
  return {
    name: PACKAGE_NAME,
    version,
    description: "The Ledge server: your notes and shells on another machine, reached over ssh.",
    license: "Apache-2.0",
    type: "module",
    bin: { [PACKAGE_NAME]: "bin/ledge-server.js" },
    files: ["bin", "lib", "README.md", "LICENSE"],
    engines: { bun: BUN_FLOOR },
    os: ["darwin", "linux"],
    cpu: ["arm64", "x64"],
    repository: { type: "git", url: "git+https://github.com/ledgesh/ledge.git" },
    homepage: "https://github.com/ledgesh/ledge",
    keywords: ["ledge", "notes", "markdown", "ssh", "remote", "terminal"],
  };
}
