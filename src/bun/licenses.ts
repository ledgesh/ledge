// Attribution for everything the app redistributes: the npm packages the
// build draws on, and the native binaries in the bundle. `bun run licenses`
// renders it to THIRD-PARTY-NOTICES.md; licenses.test.ts re-renders and
// compares, so a dependency added without regenerating turns the suite red
// rather than shipping unattributed. MIT and BSD ask that their notice
// travel with the binary. docsContent.ts compiles THIRD-PARTY-NOTICES.md
// into the built-in docs, so it reaches the user's copy and not only the
// repository.
//
// This module sits under src/ rather than beside scripts/licenses.ts because
// tests are colocated (testing.md §1). Pure core here and the runner in
// scripts/, the same split as ptyNative.ts and scripts/build-native.ts.
// Nothing in the app imports it, so none of it reaches the bundle.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface LicenseText {
  /**
   * The file's name in the package directory, such as `LICENSE.md`. A reader
   * of the notices follows the name back to the original.
   */
  file: string;
  text: string;
}

export interface PackageNotice {
  name: string;
  version: string;
  /** SPDX id as the package declares it, or "UNKNOWN" when it declares none. */
  license: string;
  repository: string | null;
  texts: LicenseText[];
}

export interface NativeComponent {
  name: string;
  license: string;
  url: string;
  /** Which files in the bundle this covers, and what each one is. */
  note: string;
}

// A hand-maintained list of the binaries inside Ledge.app, most of them in
// Contents/MacOS. The dependency walk below cannot see them: they arrive
// prebuilt from the Electrobun toolchain, which Hutch downloads rather than
// npm installing (architecture.md §8), so the walk finds only a
// dependency-free bootstrap package. Under 1.x the walk did see that
// package's dependencies, and reported build-time ones such as
// @babylonjs/core that never reached the bundle. Losing those costs no
// coverage, so this list is the whole account. Every binary is listed, this
// project's own included, so a reader can look up any file in the bundle and
// not only the ones carrying an obligation.
export const NATIVE_COMPONENTS: readonly NativeComponent[] = [
  {
    name: "Bun 1.4.0",
    license: "MIT",
    url: "https://github.com/oven-sh/bun/blob/bun-v1.4.0/LICENSE.md",
    note:
      "`Contents/MacOS/bun`: the runtime the main process runs on. Electrobun bundles it, so its version tracks Electrobun's rather than the `bun` on the build machine; `Contents/MacOS/bun --version` against a build is what confirms which one shipped. Bun redistributes third-party components of its own, JavaScriptCore among them, under their own licenses, and the LICENSE.md linked above carries those notices in full.",
  },
  {
    name: "Electrobun 2.0.1",
    license: "MIT",
    url: "https://github.com/blackboardsh/electrobun/blob/main/LICENSE",
    note:
      "`Contents/MacOS/launcher`, `libElectrobunCore.dylib`, `libNativeWrapper.dylib`, `libasar.dylib`, `zig-zstd`, and `bspatch`: the process launcher, the core runtime, the WKWebView bridge, and the updater's archive and patch tools, all built from the Electrobun project and covered by its license. These reach the bundle from the toolchain Hutch downloads into `~/.hutch`, not from npm: the 2.x npm package is a dependency-free bootstrap, which is why the walk below reports nothing for it at all. It does ship a LICENSE, and MIT is what it and the repository both state.",
  },
  {
    name: "Ledge PTY trampolines",
    license: "Apache-2.0",
    url: "https://github.com/ledgesh/ledge",
    note:
      "`Contents/Resources/app/bun/libledge_pty.dylib`, which is not third-party. It is this project's own C, compiled from `src/bun/ptyNative.ts` by `scripts/build-native.ts`, and the LICENSE at the repository root covers it. Listed here so the bundle's binaries are accounted for without a gap a reader has to resolve.",
  },
];

// The files worth reproducing. NOTICE is matched separately because
// Apache-2.0 §4(d) requires it travel with the license. Nothing the walk
// below reaches publishes one now: @babylonjs/core still ships a NOTICE.md
// in node_modules, but the Electrobun 2.x walk no longer reaches it, and the
// playwright packages that carry one are devDependencies.
const LICENSE_FILE = /^(LICEN[CS]E|COPYING)([-.].*)?$/i;
const NOTICE_FILE = /^NOTICE([-.].*)?$/i;

/** The license files in a directory listing, licenses first and NOTICE last. */
export function licenseFilesOf(names: readonly string[]): string[] {
  const sorted = [...names].sort();
  return [...sorted.filter((n) => LICENSE_FILE.test(n)), ...sorted.filter((n) => NOTICE_FILE.test(n))];
}

/**
 * A package.json repository field as a browsable https URL, or null. Handles
 * the `git+`, `git://`, and `ssh://git@` prefixes and a trailing `.git`.
 */
export function normalizeRepo(repository: unknown): string | null {
  const raw =
    typeof repository === "string"
      ? repository
      : typeof (repository as { url?: unknown } | null)?.url === "string"
        ? (repository as { url: string }).url
        : null;
  if (!raw) return null;
  // The owner/name shorthand npm accepts in place of a URL.
  if (/^[\w.-]+\/[\w.-]+$/.test(raw)) return `https://github.com/${raw}`;
  const url = raw
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^ssh:\/\/git@/, "https://")
    .replace(/\.git$/, "");
  return url.startsWith("http") ? url : null;
}

/** The license the package declares, across the field shapes npm has used. */
export function declaredLicense(pkg: {
  license?: unknown;
  licenses?: unknown;
}): string {
  if (typeof pkg.license === "string") return pkg.license;
  // Two legacy shapes: `license` as a {type, url} object, and the pre-2015
  // `licenses` as an array of them. Rare, but they outlive `license` in
  // unmaintained packages, where attribution is hard to reconstruct by hand.
  if (typeof (pkg.license as { type?: unknown } | null)?.type === "string") {
    return (pkg.license as { type: string }).type;
  }
  if (Array.isArray(pkg.licenses)) {
    const types = pkg.licenses
      .map((l: unknown) => (l as { type?: unknown })?.type)
      .filter((t): t is string => typeof t === "string");
    if (types.length > 0) return types.join(" OR ");
  }
  return "UNKNOWN";
}

// Walk the production closure: package.json's `dependencies`, then theirs,
// and so on. devDependencies are skipped because they never reach a user. The
// bundler's actual output is not consulted either; renderNotices writes the
// reason for listing the superset into the file itself.
export function collectPackages(root: string): PackageNotice[] {
  const modules = join(root, "node_modules");
  const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const found = new Map<string, PackageNotice>();
  const queue = Object.keys(rootPkg.dependencies ?? {});
  const seen = new Set(queue);

  while (queue.length > 0) {
    const name = queue.shift()!;
    const dir = join(modules, name);
    let pkg: { version?: string; dependencies?: Record<string, string> };
    try {
      pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    } catch {
      // An optional dependency that did not install for this platform. It is
      // not redistributed, so there is nothing to attribute. The row is still
      // written, as "not installed", because a silent skip and a missing
      // package look identical in the output.
      found.set(name, { name, version: "not installed", license: "UNKNOWN", repository: null, texts: [] });
      continue;
    }
    let files: string[] = [];
    try {
      files = licenseFilesOf(readdirSync(dir));
    } catch {
      files = [];
    }
    found.set(name, {
      name,
      version: pkg.version ?? "?",
      license: declaredLicense(pkg as { license?: unknown }),
      repository: normalizeRepo((pkg as { repository?: unknown }).repository),
      texts: files.map((file) => ({ file, text: readFileSync(join(dir, file), "utf8") })),
    });
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      if (!seen.has(dep)) {
        seen.add(dep);
        queue.push(dep);
      }
    }
  }

  return [...found.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// A fence longer than any run of backticks in the text. License texts go
// inside a fence so that Markdown leaves them alone: a BSD notice full of
// asterisks would otherwise render as emphasis, and the notice has to be
// reproduced as written.
function fenceFor(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return "`".repeat(Math.max(3, longest + 1));
}

function trimText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\s+$/, "");
}

/**
 * The whole of THIRD-PARTY-NOTICES.md. The output does not vary between runs:
 * no dates, no machine paths, and no dependence on directory order, since
 * collectPackages and licenseFilesOf sort what they return. licenses.test.ts
 * compares this against the committed file, which works only on a generator
 * that depends on nothing but its input.
 */
export function renderNotices(packages: readonly PackageNotice[]): string {
  const out: string[] = [];
  out.push("# Third-Party Licenses");
  out.push("");
  out.push(
    "Ledge itself is Apache-2.0: see LICENSE at the repository root. This file is the attribution for everything the app ships alongside its own code, which the MIT, BSD, and ISC licenses ask travel with the binary rather than stay behind in a repository.",
  );
  out.push("");
  out.push(
    "It is generated. Run `bun run licenses` after changing a dependency; `src/bun/licenses.test.ts` fails when it has drifted from the installed tree, so the regeneration is not left to memory.",
  );
  out.push("");
  out.push(
    "The npm list below is the production dependency closure, not the set of packages a bundler actually emitted bytes from. Which modules survive tree-shaking is a property of one build and can change without any dependency changing, while the obligation does not: over-attribution is the safe direction, so a package that contributed nothing to the bundle is listed anyway.",
  );
  out.push("");

  out.push("## Native components");
  out.push("");
  out.push(
    "These are binaries inside `Ledge.app`, which the dependency walk cannot see: they arrive prebuilt, so npm has only a package.json to show for them.",
  );
  out.push("");
  for (const c of NATIVE_COMPONENTS) {
    out.push(`### ${c.name}`);
    out.push("");
    out.push(`${c.license} (${c.url})`);
    out.push("");
    out.push(c.note);
    out.push("");
  }

  out.push("## npm packages");
  out.push("");
  for (const p of packages) {
    out.push(`### ${p.name} ${p.version}`);
    out.push("");
    out.push(p.repository ? `${p.license} (${p.repository})` : p.license);
    out.push("");
    if (p.texts.length === 0) {
      // A package that publishes no license text gets its declared id and a
      // pointer to the project, and nothing more. Writing out the standard
      // text of that license would mean guessing a copyright holder, which
      // would make the notice a fabrication.
      out.push(
        "The published package contains no license file. The license above is the one its package.json declares; the canonical text is with the project.",
      );
      out.push("");
      continue;
    }
    for (const t of p.texts) {
      const body = trimText(t.text);
      const fence = fenceFor(body);
      out.push(`${t.file}:`);
      out.push("");
      out.push(fence);
      out.push(body);
      out.push(fence);
      out.push("");
    }
  }

  // Joined as-is. A pass that tidied blank lines would reach inside the quoted
  // notices as well, and they have to be reproduced as written. The section
  // builders above are what keep the spacing even.
  return `${out.join("\n").trimEnd()}\n`;
}
