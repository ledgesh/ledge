import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  collectPackages,
  declaredLicense,
  licenseFilesOf,
  normalizeRepo,
  renderNotices,
  type PackageNotice,
} from "./licenses";

const ROOT = resolve(import.meta.dir, "..", "..");

function pkg(over: Partial<PackageNotice> = {}): PackageNotice {
  return { name: "thing", version: "1.0.0", license: "MIT", repository: null, texts: [], ...over };
}

describe("normalizeRepo", () => {
  test("the shapes package.json uses all reduce to a browsable URL", () => {
    expect(normalizeRepo({ type: "git", url: "git+https://github.com/x/y.git" })).toBe("https://github.com/x/y");
    expect(normalizeRepo("git://github.com/x/y.git")).toBe("https://github.com/x/y");
    expect(normalizeRepo("ssh://git@github.com/x/y.git")).toBe("https://github.com/x/y");
    expect(normalizeRepo("https://gitlab.com/x/y")).toBe("https://gitlab.com/x/y");
  });

  // npm accepts "user/repo" as a whole repository field, and several packages
  // in this tree use it.
  test("the owner/name shorthand becomes a GitHub URL", () => {
    expect(normalizeRepo("codemirror/state")).toBe("https://github.com/codemirror/state");
  });

  // The link is a convenience. A wrong one is worse than none: a reader
  // follows it to find the canonical license text.
  test("anything unrecognizable is no link rather than a guess", () => {
    expect(normalizeRepo(undefined)).toBeNull();
    expect(normalizeRepo({})).toBeNull();
    expect(normalizeRepo("see the tarball")).toBeNull();
  });
});

describe("declaredLicense", () => {
  test("the modern field wins", () => {
    expect(declaredLicense({ license: "Apache-2.0" })).toBe("Apache-2.0");
  });

  test("the two legacy shapes are still read", () => {
    expect(declaredLicense({ license: { type: "MIT", url: "x" } })).toBe("MIT");
    expect(declaredLicense({ licenses: [{ type: "MIT" }, { type: "GPL-2.0" }] })).toBe("MIT OR GPL-2.0");
  });

  test("a package that declares nothing says so instead of defaulting to MIT", () => {
    expect(declaredLicense({})).toBe("UNKNOWN");
  });
});

describe("licenseFilesOf", () => {
  test("the spellings publishers actually use are all found", () => {
    expect(licenseFilesOf(["LICENSE"])).toEqual(["LICENSE"]);
    expect(licenseFilesOf(["license.md"])).toEqual(["license.md"]);
    expect(licenseFilesOf(["LICENCE.txt"])).toEqual(["LICENCE.txt"]);
    expect(licenseFilesOf(["COPYING"])).toEqual(["COPYING"]);
    expect(licenseFilesOf(["LICENSE.BSD"])).toEqual(["LICENSE.BSD"]);
  });

  // Apache-2.0 §4(d) requires the NOTICE file to travel with the license, so
  // licenseFilesOf collects it too. NOTICE sorts after the license files: it
  // is an addendum, not the grant.
  test("NOTICE is kept, and kept last", () => {
    expect(licenseFilesOf(["NOTICE.md", "license.md"])).toEqual(["license.md", "NOTICE.md"]);
  });

  test("source files that merely start with the word are not license texts", () => {
    expect(licenseFilesOf(["licenses.ts", "README.md", "package.json"])).toEqual([]);
  });
});

describe("renderNotices", () => {
  // The first line is the title of a built-in docs page: docsContent.ts
  // compiles this file into the manual, and a page's title is its H1.
  test("the file leads with its title", () => {
    expect(renderNotices([]).split("\n")[0]).toBe("# Third-Party Licenses");
  });

  test("a license text is reproduced exactly, inside a fence", () => {
    const text = "MIT License\n\nCopyright (c) 2019 Someone *and* others\n\nPermission is hereby granted...";
    const out = renderNotices([pkg({ texts: [{ file: "LICENSE", text }] })]);
    expect(out).toContain("```\n" + text + "\n```");
  });

  // A notice containing its own fence would close the block early, and the
  // rest would render as Markdown. fenceFor picks a fence longer than any run
  // of backticks in the text.
  test("a text containing a fence gets a longer one", () => {
    const text = "Example:\n\n```\nrm -rf /\n```";
    const out = renderNotices([pkg({ texts: [{ file: "LICENSE", text }] })]);
    expect(out).toContain("````\n" + text + "\n````");
  });

  test("a package that publishes no text says so rather than inventing one", () => {
    const out = renderNotices([pkg({ name: "electrobun", license: "MIT" })]);
    expect(out).toContain("### electrobun 1.0.0");
    expect(out).toContain("The published package contains no license file.");
    // An invented MIT notice would have to carry this standard wording.
    expect(out).not.toContain("Permission is hereby granted");
  });

  test("the repository is a link when there is one, and absent when there is not", () => {
    expect(renderNotices([pkg({ repository: "https://github.com/x/y" })])).toContain("MIT (https://github.com/x/y)");
    expect(renderNotices([pkg()])).toContain("\nMIT\n");
  });

  // The freshness check below compares a fresh render against the committed
  // file, which is itself an earlier render of the same tree. That comparison
  // only means something if renderNotices depends on its input alone.
  test("the same input renders the same file", () => {
    const input = [pkg({ texts: [{ file: "LICENSE", text: "MIT" }] })];
    expect(renderNotices(input)).toBe(renderNotices(input));
  });
});

// The invariant the module exists for (testing.md §3): everything the app
// redistributes is attributed. These tests enforce it.
describe("THIRD-PARTY-NOTICES.md", () => {
  const committed = readFileSync(join(ROOT, "THIRD-PARTY-NOTICES.md"), "utf8");
  const packages = collectPackages(ROOT);

  // Two tests below read the installed tree, so they skip when node_modules is
  // missing. A machine that builds the app has one. The server's container
  // (`Dockerfile`) does not, because the server has no npm dependencies. There
  // collectPackages marks every declared dependency "not installed", so the
  // render would differ from the committed file without the file having
  // drifted.
  const installed = existsSync(join(ROOT, "node_modules"));

  test.skipIf(!installed)("is current with the installed production tree", () => {
    // Failing here means a dependency moved and the file did not: run
    // `bun run licenses` and commit the result.
    expect(renderNotices(packages)).toBe(committed);
  });

  test("names every direct dependency the app declares", () => {
    const declared = Object.keys(
      (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { dependencies: Record<string, string> })
        .dependencies,
    );
    for (const name of declared) expect(committed).toContain(`### ${name} `);
  });

  test.skipIf(!installed)("reaches past the direct dependencies into their own", () => {
    // scheduler arrives through react-dom rather than as a declared
    // dependency. A walk that stopped at the top level would miss it.
    expect(packages.map((p) => p.name)).toContain("scheduler");
  });

  test("accounts for the native binaries npm cannot see", () => {
    expect(committed).toContain("Contents/MacOS/bun");
    expect(committed).toContain("Contents/MacOS/launcher");
  });
});
