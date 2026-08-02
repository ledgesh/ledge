// architecture.md §1 as a test: `src/shared/` is the contract between the two
// processes, so it imports from neither and runs on both. Until phase 1 of
// ios.md that rule was a sentence in a document, and it held because the only
// things in here were data and pure helpers. `shared/transport.ts` is neither —
// it is a live client, and the whole reason it moved is that a webview has to
// be able to run it (ios.md §2). A `Buffer` or a `../bun/` import would take
// that away silently, months before the Swift shell exists to notice.
//
// Scanned as source rather than proved by execution because the failure this
// guards against is a global that HAPPENS to exist in Bun. Every test in this
// repo runs in Bun, so a test that merely calls the code would go green on the
// exact thing being forbidden.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SHARED = import.meta.dir;
const MAINVIEW = join(SHARED, "..", "mainview");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(path));
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** Comments are prose and may say "Buffer" or "the running process." A rule
 * that could not tell those from code would be a rule nobody could write a
 * comment under. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const shared = sources(SHARED);
const relative = (path: string): string => path.slice(join(SHARED, "..", "..").length + 1);

describe("src/shared/ imports from neither side", () => {
  test("there is something to check", () => {
    expect(shared.length).toBeGreaterThan(10);
  });

  test.each(shared.map((p) => [relative(p), p]))("%s", (_name, path) => {
    const text = code(readFileSync(path, "utf8"));
    // Any depth of ../: shared/ is one level down today, and a subdirectory
    // tomorrow would otherwise walk out through a hole this test left.
    expect(text).not.toMatch(/from\s+["'](?:\.\.\/)+(?:bun|mainview)\//);
    expect(text).not.toMatch(/import\s*\(\s*["'](?:\.\.\/)+(?:bun|mainview)\//);
    // The view's own alias. A shared module reaching the view through it is
    // the same violation wearing a shorter path.
    expect(text).not.toMatch(/from\s+["']@\//);
  });
});

// The non-test half only. A test in here runs in Bun by definition and may use
// whatever Bun has; what ships to a webview is the other files.
const shipping = shared.filter((p) => !/\.test\.tsx?$/.test(p));

describe("src/shared/ reaches for nothing only Bun has", () => {
  // `process.` and friends are matched with a following identifier character
  // so that a comment surviving the stripper as prose does not read as code.
  const forbidden: ReadonlyArray<[string, RegExp]> = [
    ["the Bun global", /\bBun\s*\.\s*[A-Za-z_$]/],
    ["Buffer", /\bBuffer\s*\.\s*[A-Za-z_$]/],
    ["process", /\bprocess\s*\.\s*[A-Za-z_$]/],
    ["require()", /\brequire\s*\(/],
    ["__dirname", /\b__dirname\b/],
    ["import.meta.dir", /\bimport\s*\.\s*meta\s*\.\s*dir\b/],
    ["a node: builtin", /["']node:[a-z_]+["']/],
  ];

  test.each(shipping.map((p) => [relative(p), p]))("%s", (_name, path) => {
    const text = code(readFileSync(path, "utf8"));
    for (const [what, pattern] of forbidden) {
      expect({ file: relative(path), reaches: pattern.test(text) ? what : null }).toEqual({
        file: relative(path),
        reaches: null,
      });
    }
  });
});

// The other half of the same rule, and the one that has always been true: the
// view cannot import src/bun because the webview has no filesystem, no PTY and
// no process — the import would typecheck and fail at runtime.
describe("src/mainview/ does not import src/bun/", () => {
  const view = sources(MAINVIEW);

  test("there is something to check", () => {
    expect(view.length).toBeGreaterThan(10);
  });

  test.each(view.map((p) => [relative(p), p]))("%s", (_name, path) => {
    const text = code(readFileSync(path, "utf8"));
    expect(text).not.toMatch(/from\s+["'](?:\.\.\/)+bun\//);
    expect(text).not.toMatch(/import\s*\(\s*["'](?:\.\.\/)+bun\//);
  });
});
