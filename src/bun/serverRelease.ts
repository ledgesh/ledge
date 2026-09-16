// What a server release contains: the packed `ledge-server` npm tarball, a
// SHA256SUMS file, and the install script `https://ledge.sh/server.sh`
// redirects to. The script downloads that tarball and a pinned Bun from the npm
// registry, so a ```ts fence on the server runs with nothing else installed.
// The half of `scripts/build-server.ts` that `bun test` can reach (remote.md §11).
import { NATIVE_TARGETS, PACKAGE_NAME } from "./npmPackage";

/**
 * The Bun every install gets. The same version CI runs the suite on
 * (`.github/workflows/ci.yml`), which serverRelease.test.ts holds.
 */
export const BUN_VERSION = "1.4.2";

/** Where both downloads come from. `LEDGE_SERVER_REGISTRY` replaces it for a mirror. */
export const REGISTRY = "https://registry.npmjs.org";

/**
 * Bun's own npm package for each target, and the SHA-256 of its tarball at
 * BUN_VERSION. Each hash was checked against the registry's sha512 `integrity`
 * for that version. x64 takes the baseline build, which runs on CPUs without AVX2.
 */
export const BUN_PACKAGES: Readonly<Record<string, { name: string; sha256: string }>> = {
  "darwin-arm64": { name: "@oven/bun-darwin-aarch64", sha256: "a9df486eaf7e9db9bdebb1fa425e8c9809abd783b1c518d1dbc5096a53b861ed" },
  "darwin-x64": { name: "@oven/bun-darwin-x64-baseline", sha256: "625b1f4fd5460fcd62ef8e4b672f181ef22bcdf4a15275eeac790c708add4950" },
  "linux-arm64": { name: "@oven/bun-linux-aarch64", sha256: "9ab3970a19660b5cd089f17fb021d900e1ca1b988dafd461d66d0a0ff4d6eac4" },
  "linux-x64": { name: "@oven/bun-linux-x64-baseline", sha256: "129ae8dfaca565e8008735e3d6adae7515421c5b226d6f1f90c4bcb35803a647" },
};

/** `darwin-arm64`: how a target is spelled in `server.sh` and on the command line. */
export function targetKey(target: { platform: string; arch: string }): string {
  return `${target.platform}-${target.arch}`;
}

/**
 * Where a registry serves a package's tarball, relative to the registry:
 * `@oven/bun-linux-aarch64/-/bun-linux-aarch64-1.4.2.tgz`. `server.sh` builds
 * the same path in shell.
 */
export function tarballPath(name: string, version: string): string {
  return `${name}/-/${name.split("/").pop()}-${version}.tgz`;
}

/** The file `npm pack` writes, and the one a release publishes. */
export function serverTarball(version: string): string {
  return tarballPath(PACKAGE_NAME, version).split("/").pop()!;
}

export const INSTALL_SCRIPT = "server.sh";
export const SUMS_FILE = "SHA256SUMS";

/** SHA256SUMS in the format `sha256sum -c` reads: hash, two spaces, name. */
export function sumsText(sums: ReadonlyArray<{ name: string; sha256: string }>): string {
  return sums.map((s) => `${s.sha256}  ${s.name}\n`).join("");
}

export interface InstallRelease {
  version: string;
  /** Written into the script as the registry to download from. */
  registry: string;
  /** The SHA-256 of `ledge-server-<version>.tgz`. */
  serverSum: string;
  /** Replaces the pinned Bun, for a test's fake one. */
  bun?: { version: string; packages: Readonly<Record<string, { name: string; sha256: string }>> };
}

/**
 * `release/server.sh` with this release written in. Every target needs a Bun
 * package; a target the server tarball has no trampolines for is refused by the
 * script after it downloads that tarball.
 */
export function renderInstallScript(template: string, release: InstallRelease): string {
  const bun = release.bun ?? { version: BUN_VERSION, packages: BUN_PACKAGES };
  const sha256 = (what: string, sum: string) => {
    if (!/^[0-9a-f]{64}$/.test(sum)) throw new Error(`${what}: "${sum}" is not a SHA-256`);
    return sum;
  };
  for (const v of [release.version, bun.version]) {
    if (!/^[0-9A-Za-z.+-]+$/.test(v)) throw new Error(`"${v}" cannot go in a file name`);
  }
  const values: Record<string, string> = {
    VERSION: release.version,
    REGISTRY: release.registry,
    SERVER_SUM: sha256(PACKAGE_NAME, release.serverSum),
    BUN_VERSION: bun.version,
  };
  for (const t of NATIVE_TARGETS) {
    const pkg = bun.packages[targetKey(t)];
    if (!pkg) throw new Error(`no Bun package is pinned for ${targetKey(t)}`);
    if (!/^@?[a-z0-9._-]+(\/[a-z0-9._-]+)?$/.test(pkg.name)) throw new Error(`"${pkg.name}" is not a package name`);
    const suffix = `${t.platform.toUpperCase()}_${t.arch.toUpperCase()}`;
    values[`BUN_PACKAGE_${suffix}`] = pkg.name;
    values[`BUN_SUM_${suffix}`] = sha256(pkg.name, pkg.sha256);
  }
  for (const value of Object.values(values)) {
    if (value.includes("'")) throw new Error(`a value for server.sh contains a quote: ${value}`);
  }
  return template.replace(/@([A-Z0-9_]+)@/g, (whole, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`server.sh has a placeholder nothing fills: ${whole}`);
    return value;
  });
}
