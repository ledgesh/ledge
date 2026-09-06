// What the published `ledge-server` package contains, and what makes one
// complete. The half of `scripts/build-npm.ts` that `bun test` can reach.
//
// Before the package, installing the server meant cloning the repo, compiling
// a binary of matching architecture, and copying two files that have to stay
// adjacent. The blocker was not portability. `bun build --compile` produces
// one artifact per target, and the trampolines sit beside it as a second file.
// npm carries every target in one tarball and installs a directory rather than
// two loose files. The cost is Bun on the far machine. The compiled binary
// needed nothing installed there (docs/contributor/remote.md §11).
import { nativeDir, nativeLibName } from "./ptyNative";

/** The name on npm, and the command it installs. */
export const PACKAGE_NAME = "ledge-server";

/**
 * The minimum Bun the package declares: the version the suite runs on, not
 * the oldest one that would work. A higher floor asks a user to upgrade Bun.
 * A lower one lets them find out from a stack trace. The server's runtime
 * surface is ordinary (dlopen, spawn, sockets), so lowering the floor means
 * testing an older Bun rather than changing the server.
 */
export const BUN_FLOOR = ">=1.3.0";

export interface NativeTarget {
  platform: "darwin" | "linux";
  arch: "arm64" | "x64";
}

/**
 * Every machine an installed package must be able to serve, all four in one
 * tarball. `nativeDir` (ptyNative.ts) names the directory each target's
 * library sits in.
 *
 * darwin-x64 is here even though the Mac app is arm64-only: an old Intel Mac
 * is a plausible always-on box for the user this is for, and the slice costs
 * 33KB inside a tarball that is already being downloaded.
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
 * How one target's trampolines get built on `hostPlatform`. Both Mach-O
 * slices come from one universal dylib, which on a Mac is one `cc` call with
 * two `-arch` flags. Each ELF slice comes from its own container, because ELF
 * has no fat binary and a second architecture on Linux means a cross
 * toolchain (scripts/build-native.ts and docs/contributor/remote.md §11 say
 * the same). So only a Mac can assemble a complete package. A Linux host
 * builds both Linux slices, and cannot produce a Mach-O at all.
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
 * agree on what "publishable" means. Three targets out of four is not a
 * degraded package but an unpublishable one: on the missing machine the
 * server runs its shells without the trampolines, so terminal resize is a
 * no-op and a write to a shell that is not reading can stall (pty.ts,
 * loadNative).
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
 * scripts/build-npm.ts reads this back out of each container's output rather
 * than trusting the build: `docker build --platform` is a request, and a
 * daemon without the emulator for that platform can answer it with the host's
 * architecture instead. A package whose linux-arm64 slice is x86-64 fails
 * quietly on the user's machine, as a dlopen error that leaves the server
 * running shells whose resize does nothing (pty.ts, loadNative). Docker warns
 * when it substitutes an architecture, in a line nobody reads.
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
 * `os` and `cpu` are the two fields npm enforces: an install on Windows fails
 * with EBADPLATFORM instead of succeeding into a server that cannot open a
 * pty. `private` is absent. The root package.json carries it, this one must
 * not, and npm refuses to publish a private package. That refusal lands at
 * the end of a release rather than the start of one (npmPackage.test.ts).
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
