// What a server release contains: one tarball per target, a SHA256SUMS file,
// and the install script `https://ledge.sh/server.sh` redirects to. The half of
// `scripts/build-server.ts` that `bun test` can reach. The tarball carries its
// own Bun, so a ```ts fence on the server runs with nothing else installed
// (remote.md §11).
import { NATIVE_TARGETS, type NativeTarget } from "./npmPackage";

/**
 * The Bun every tarball ships. The same version CI runs the suite on
 * (`.github/workflows/ci.yml`), which serverRelease.test.ts holds.
 */
export const BUN_VERSION = "1.3.14";

/**
 * Bun's release asset for each target, and the SHA-256 of that zip as Bun's own
 * SHASUMS256.txt for the release gives it. Pinned here so a build cannot pick up
 * a different file under the same name. x64 takes the baseline build, which
 * runs on CPUs without AVX2.
 */
export const BUN_BUILDS: Readonly<Record<string, { asset: string; sha256: string }>> = {
  "darwin-arm64": { asset: "bun-darwin-aarch64", sha256: "d8b96221828ad6f97ac7ac0ab7e95872341af763001e8803e8267652c2652620" },
  "darwin-x64": { asset: "bun-darwin-x64-baseline", sha256: "3e35ad6f53971a9834bf9e6786e2adf72b5f1921cc9a9c5fde073d2972944076" },
  "linux-arm64": { asset: "bun-linux-aarch64", sha256: "a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b" },
  "linux-x64": { asset: "bun-linux-x64-baseline", sha256: "a063908ae08b7852ca10939bbdc6ceed3ddabce8fb9402dce83d65d73b36e6c7" },
};

/** Bun's LICENSE.md at the pinned tag, which names the LGPL JavaScriptCore it links. */
export const BUN_LICENSE = {
  url: `https://raw.githubusercontent.com/oven-sh/bun/bun-v${BUN_VERSION}/LICENSE.md`,
  sha256: "2c6160ec8fb853f7e8f97d9b249e756c9b0ac44860a68b6bf4f1b0bcbc5c3741",
};

export function bunZipUrl(target: NativeTarget): string {
  return `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${bunBuild(target).asset}.zip`;
}

export function bunBuild(target: NativeTarget): { asset: string; sha256: string } {
  const build = BUN_BUILDS[targetKey(target)];
  if (!build) throw new Error(`no Bun build is pinned for ${targetKey(target)}`);
  return build;
}

/** `darwin-arm64`: how a target is spelled in file names and in `server.sh`. */
export function targetKey(target: NativeTarget): string {
  return `${target.platform}-${target.arch}`;
}

/** The directory inside a tarball, and the tarball's name without `.tar.gz`. */
export function releaseName(version: string, target: NativeTarget): string {
  return `ledge-server-${version}-${targetKey(target)}`;
}

export const INSTALL_SCRIPT = "server.sh";
export const SUMS_FILE = "SHA256SUMS";

/**
 * Where a release's files are downloaded from: the GitHub release for tag
 * `v<version>` (releasing.md §4). `server.sh` has this written in, and
 * `LEDGE_SERVER_DOWNLOAD` replaces it for a probe.
 */
export function releaseDownload(version: string): string {
  return `https://github.com/ledgesh/ledge/releases/download/v${version}`;
}

/** SHA256SUMS in the format `sha256sum -c` reads: hash, two spaces, name. */
export function sumsText(sums: ReadonlyArray<{ name: string; sha256: string }>): string {
  return sums.map((s) => `${s.sha256}  ${s.name}\n`).join("");
}

/**
 * `release/server.sh` with this release written in. `sums` maps a target key to
 * its tarball's SHA-256. A target missing from it gets an empty checksum, which
 * the script reports as a release with no build for that machine.
 */
export function renderInstallScript(
  template: string,
  release: { version: string; download: string; sums: Readonly<Record<string, string>> },
): string {
  if (!/^[0-9A-Za-z.+-]+$/.test(release.version)) throw new Error(`"${release.version}" cannot go in a file name`);
  const values: Record<string, string> = { VERSION: release.version, DOWNLOAD: release.download };
  for (const t of NATIVE_TARGETS) {
    const sum = release.sums[targetKey(t)] ?? "";
    if (sum !== "" && !/^[0-9a-f]{64}$/.test(sum)) throw new Error(`${targetKey(t)}: "${sum}" is not a SHA-256`);
    values[`SUM_${t.platform.toUpperCase()}_${t.arch.toUpperCase()}`] = sum;
  }
  for (const value of Object.values(values)) {
    if (value.includes("'")) throw new Error(`a value for server.sh contains a quote: ${value}`);
  }
  const out = template.replace(/@([A-Z0-9_]+)@/g, (whole, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`server.sh has a placeholder nothing fills: ${whole}`);
    return value;
  });
  return out;
}
