import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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

  // A link is a convenience; a wrong link is worse than none, because it is
  // the thing a reader would follow to find the canonical text.
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

  // Apache-2.0 §4(d): the NOTICE file travels with the license, so it is
  // collected too — after it, since it is an addendum and not the grant.
  test("NOTICE is kept, and kept last", () => {
    expect(licenseFilesOf(["NOTICE.md", "license.md"])).toEqual(["license.md", "NOTICE.md"]);
  });

  test("source files that merely start with the word are not license texts", () => {
    expect(licenseFilesOf(["licenses.ts", "README.md", "package.json"])).toEqual([]);
  });
});

describe("renderNotices", () => {
  // The H1 is the note title in the built-in docs (bun/docs.ts), so the first
  // line is load-bearing rather than decorative.
  test("the file leads with its title", () => {
    expect(renderNotices([]).split("\n")[0]).toBe("# Third-Party Licenses");
  });

  test("a license text is reproduced exactly, inside a fence", () => {
    const text = "MIT License\n\nCopyright (c) 2019 Someone *and* others\n\nPermission is hereby granted...";
    const out = renderNotices([pkg({ texts: [{ file: "LICENSE", text }] })]);
    expect(out).toContain("```\n" + text + "\n```");
  });

  // Markdown would eat a notice that contains its own fence, and a notice that
  // has been eaten is not a notice.
  test("a text containing a fence gets a longer one", () => {
    const text = "Example:\n\n```\nrm -rf /\n```";
    const out = renderNotices([pkg({ texts: [{ file: "LICENSE", text }] })]);
    expect(out).toContain("````\n" + text + "\n````");
  });

  test("a package that publishes no text says so rather than inventing one", () => {
    const out = renderNotices([pkg({ name: "electrobun", license: "MIT" })]);
    expect(out).toContain("### electrobun 1.0.0");
    expect(out).toContain("The published package contains no license file.");
    // The standard MIT wording, which a fabricated notice would have to use.
    expect(out).not.toContain("Permission is hereby granted");
  });

  test("the repository is a link when there is one, and absent when there is not", () => {
    expect(renderNotices([pkg({ repository: "https://github.com/x/y" })])).toContain("MIT (https://github.com/x/y)");
    expect(renderNotices([pkg()])).toContain("\nMIT\n");
  });

  // The freshness check below compares two renders of the same tree; it can
  // only mean something if rendering is a function of its input alone.
  test("the same input renders the same file", () => {
    const input = [pkg({ texts: [{ file: "LICENSE", text: "MIT" }] })];
    expect(renderNotices(input)).toBe(renderNotices(input));
  });
});

// The point of the whole module (testing.md §3): the rule is "everything we
// redistribute is attributed", and this is the rule as a test.
describe("THIRD-PARTY-NOTICES.md", () => {
  const committed = readFileSync(join(ROOT, "THIRD-PARTY-NOTICES.md"), "utf8");
  const packages = collectPackages(ROOT);

  test("is current with the installed production tree", () => {
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

  test("reaches past the direct dependencies into their own", () => {
    // react does not vendor its scheduler; a walk that stopped at the top
    // level would attribute the one and not the other.
    expect(packages.map((p) => p.name)).toContain("scheduler");
  });

  test("accounts for the native binaries npm cannot see", () => {
    expect(committed).toContain("Contents/MacOS/bun");
    expect(committed).toContain("Contents/MacOS/launcher");
  });
});
