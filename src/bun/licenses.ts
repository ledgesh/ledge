// Attribution for everything the app redistributes: the npm packages the build
// draws on, and the native binaries sitting in the bundle beside them.
// `bun run licenses` renders it to THIRD-PARTY-NOTICES.md; licenses.test.ts
// re-renders and compares, so a dependency added without regenerating turns
// the suite red rather than shipping unattributed. MIT and BSD both ask that
// their notice travel with the binary, which makes this file a shipping
// artifact and not paperwork: docsContent.ts compiles it into the built-in
// docs, so it reaches the user's copy and not only the repository.
//
// This module lives under src/ rather than beside scripts/licenses.ts because
// src/ is where the test runner looks (bunfig.toml roots `bun test` there) —
// the same split as ptyNative.ts and scripts/build-native.ts, pure core here
// and the runner over there. Nothing in the app imports it, so none of it
// reaches the bundle.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface LicenseText {
  /** The file it came from, named so a reader can go check it. */
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
  /** Which files in the bundle this covers, and anything a reader needs told. */
  note: string;
}

// The binaries in Contents/MacOS. npm cannot describe them: they arrive
// prebuilt inside the electrobun package, so the dependency walk below sees a
// package.json and none of what it actually ships. Hand-maintained, therefore,
// and deliberately covering EVERY binary in the bundle — including our own —
// so that the section answers "what is this file" for each one rather than
// only for the ones with an obligation attached.
export const NATIVE_COMPONENTS: readonly NativeComponent[] = [
  {
    name: "Bun 1.3.13",
    license: "MIT",
    url: "https://github.com/oven-sh/bun/blob/bun-v1.3.13/LICENSE.md",
    note:
      "`Contents/MacOS/bun`: the runtime the main process runs on. Electrobun bundles it, so its version tracks Electrobun's rather than the `bun` on the build machine; `Contents/MacOS/bun --version` against a build is what confirms which one shipped. Bun redistributes third-party components of its own, JavaScriptCore among them, under their own licenses, and the LICENSE.md linked above carries those notices in full.",
  },
  {
    name: "Electrobun 1.18.1",
    license: "MIT",
    url: "https://github.com/blackboardsh/electrobun",
    note:
      "`Contents/MacOS/launcher`, `libNativeWrapper.dylib`, `libasar.dylib`, `zig-zstd`, and `bspatch`: the process launcher, the WKWebView bridge, and the updater's archive and patch tools, all built from the Electrobun project and covered by its license. The published npm package ships no license file of its own; MIT is what its package.json declares and what the repository states.",
  },
  {
    name: "Ledge PTY trampolines",
    license: "Apache-2.0",
    url: "https://github.com/danhstevens/ledge",
    note:
      "`Contents/Resources/app/bun/libledge_pty.dylib`, which is not third-party. It is this project's own C, compiled from `src/bun/ptyNative.ts` by `scripts/build-native.ts`, and the LICENSE at the repository root covers it. Listed here so the bundle's binaries are accounted for without a gap a reader has to resolve.",
  },
];

// Files worth reproducing. NOTICE earns its place separately: Apache-2.0 §4(d)
// requires it be passed along with the license, and @babylonjs/core is the
// package that makes that concrete here.
const LICENSE_FILE = /^(LICEN[CS]E|COPYING)([-.].*)?$/i;
const NOTICE_FILE = /^NOTICE([-.].*)?$/i;

/** The license-ish files in a package directory, licenses first, then NOTICE. */
export function licenseFilesOf(names: readonly string[]): string[] {
  const sorted = [...names].sort();
  return [...sorted.filter((n) => LICENSE_FILE.test(n)), ...sorted.filter((n) => NOTICE_FILE.test(n))];
}

/** `git+https://github.com/x/y.git` and its cousins reduced to a browsable URL. */
export function normalizeRepo(repository: unknown): string | null {
  const raw =
    typeof repository === "string"
      ? repository
      : typeof (repository as { url?: unknown } | null)?.url === "string"
        ? (repository as { url: string }).url
        : null;
  if (!raw) return null;
  // The shorthand forms npm accepts in place of a URL.
  if (/^[\w.-]+\/[\w.-]+$/.test(raw)) return `https://github.com/${raw}`;
  const url = raw
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^ssh:\/\/git@/, "https://")
    .replace(/\.git$/, "");
  return url.startsWith("http") ? url : null;
}

/** What the package says it is licensed as, across the two shapes npm has used. */
export function declaredLicense(pkg: {
  license?: unknown;
  licenses?: unknown;
}): string {
  if (typeof pkg.license === "string") return pkg.license;
  // The pre-2015 form: an array of {type, url}. Rare, but `licenses` outliving
  // `license` in an unmaintained package is exactly when attribution is hard
  // to reconstruct by hand.
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

// Walk the PRODUCTION closure: package.json's `dependencies`, then theirs, and
// so on. Not devDependencies, which never reach a user, and not the bundler's
// actual output either — see the note renderNotices writes into the file about
// why the superset is the right set.
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
      // An optional dependency that did not install for this platform. Nothing
      // is redistributed that is not installed, so there is nothing to
      // attribute — but say so, because a silent skip and a missing package
      // look identical in the output.
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

// A fence long enough to survive whatever backticks the text contains. License
// texts are quoted rather than inlined so that Markdown leaves them alone: a
// BSD notice full of asterisks would otherwise render as emphasis, and a
// reproduced notice that has been reformatted is not the notice.
function fenceFor(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return "`".repeat(Math.max(3, longest + 1));
}

function trimText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\s+$/, "");
}

/**
 * The whole file. Deterministic by construction — no dates, no machine paths,
 * no dependence on directory order — because the test compares this against
 * what is committed, and a generator that varies between runs can only be
 * enforced by ignoring it.
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
      // Nothing is invented here. A package that publishes no license text
      // gets its declared id and a pointer, which is all anyone can honestly
      // reproduce; writing out the standard text under a guessed copyright
      // holder would be a fabricated notice.
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

  // Joined as-is: a pass that tidied blank lines would reach inside the quoted
  // notices too, and a reformatted notice is not the notice. The section
  // builders above are what keep the spacing even.
  return `${out.join("\n").trimEnd()}\n`;
}
