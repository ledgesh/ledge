// This file checks architecture.md §1: `src/shared/` is the contract between
// the two processes, so it imports from neither and runs on both. Until phase
// 1 of ios.md the rule held on its own: shared/ carried nothing but data and
// pure helpers. `shared/transport.ts` is neither. It is a live client a
// webview has to run (ios.md §2). A `Buffer` or a `../bun/` import would take
// that away, and nothing would fail until the iOS client is built and run.
//
// The check scans source rather than proving the rule by execution: it
// forbids globals that Bun happens to have. Every test in this repo runs in
// Bun, so a test that only called the code would pass on a forbidden global.
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

/** Strips comments so the checks below see only code. A comment is prose and
 * may say "Buffer" or "the running process" without breaking a rule. */
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
    // Match any depth of `../`. shared/ is one level down today, so a file
    // in a subdirectory added later would need more `../` segments to reach
    // the same imports. A fixed-depth pattern would let those through and
    // report nothing.
    expect(text).not.toMatch(/from\s+["'](?:\.\.\/)+(?:bun|mainview)\//);
    expect(text).not.toMatch(/import\s*\(\s*["'](?:\.\.\/)+(?:bun|mainview)\//);
    // `@/` is the view's own alias. A shared module importing the view through
    // it is the same violation by a shorter path.
    expect(text).not.toMatch(/from\s+["']@\//);
  });
});

// The non-test files only. A test in here runs in Bun by definition and may
// use whatever Bun has. Only the other files ship to a webview.
const shipping = shared.filter((p) => !/\.test\.tsx?$/.test(p));

describe("src/shared/ reaches for nothing only Bun has", () => {
  // The dotted globals only match with an identifier after the dot. A comment
  // that survives the stripper as prose then does not read as code.
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

// The other half of the same rule, true from the start. The view cannot
// import src/bun. The webview has no filesystem, no PTY and no process. Such
// an import would typecheck and then fail at runtime.
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
