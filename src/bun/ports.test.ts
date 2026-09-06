// The server opens no port, and this file checks that. remote.md §3 says
// what no port removes: TLS, certificate rotation, an ingress, and an
// authentication system of Ledge's own. An `authorized_keys` forced command
// (remote.md §4a) can only narrow what ssh already let in. It cannot restrict
// a socket that answered someone directly. One added line would break the
// claim, so a test checks it rather than a review.
//
// The scan covers the whole repository, not just `src/`, so nothing listens
// anywhere, the tools included. A fixture cannot come back in `scripts/`, the
// corner where it would be least noticed. The scan was `src/` while ios.md
// §14 phase 3 had a fixture that opened a port (`lan-bridge.ts`, safe because
// `scripts/` is in no build). Phase 4 gave the phone a real ssh transport.
// The fixture lost its only client, and deleting it let the scan widen.
//
// The one port a developer's machine opens is Vite's. `playwright.config.ts`
// asks for it by name. It is a dependency's dev server, which a test run
// starts and no build ships.
//
// The scan reads source rather than running the code, for portable.test.ts's
// reason: running the code would show that this process opened no port today,
// not that no code path can.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");

// Everything that is checked in and compiled or run. The rest is either
// generated (dist, build) or somebody else's (node_modules, .build).
const SKIP = new Set(["node_modules", ".git", "dist", "dist-cli", "dist-ios", "dist-native", "build", ".build", "artifacts"]);

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(path));
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** Strips comments so the checks below see only code. Prose may say "listen
 * on a port"; code may not do it. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const files = sources(REPO);
const relative = (path: string): string => path.slice(REPO.length + 1);
const named = files.map((p) => [relative(p), p] as const);

// ANY_LISTEN matches every `Bun.listen`. UNIX_LISTEN matches only the calls
// whose options object opens with `unix:`, which is how daemon.ts writes it.
// daemon.ts also passes a type parameter, so the pattern allows one. It
// matches up to the call's paren, so a type parameter with angle brackets
// inside it still matches.
const ANY_LISTEN = /\bBun\s*\.\s*listen\b/g;
const UNIX_LISTEN = /\bBun\s*\.\s*listen\s*(?:<[^(]*>)?\s*\(\s*\{\s*unix\s*:/g;

const count = (text: string, re: RegExp): number => text.match(re)?.length ?? 0;

describe("nothing in this repository opens a port", () => {
  test("there is something to check", () => {
    expect(files.length).toBeGreaterThan(150);
  });

  test.each(named)("%s", (name, path) => {
    const text = code(readFileSync(path, "utf8"));
    // Every listen in the file is a unix socket listen. Comparing the two
    // counts, rather than looking for a single unix match, fails a file that
    // has a listen of each kind: daemon.ts gaining a TCP listen beside its
    // unix one.
    expect({ file: name, listens: count(text, ANY_LISTEN), unix: count(text, UNIX_LISTEN) }).toEqual({
      file: name,
      listens: count(text, UNIX_LISTEN),
      unix: count(text, UNIX_LISTEN),
    });
    // A port by another route. `Bun.serve` is an HTTP server, and the node
    // builtins below are the older way to open one. The node builtins this
    // repo imports are `node:crypto`, `node:fs`, `node:fs/promises`,
    // `node:os` and `node:path`, so forbidding the network ones costs
    // nothing.
    for (const [what, pattern] of [
      ["Bun.serve", /\bBun\s*\.\s*serve\s*\(/],
      ["a network builtin", /["']node:(?:net|http|https|http2|tls|dgram)["']/],
    ] as const) {
      expect({ file: name, opens: pattern.test(text) ? what : null }).toEqual({ file: name, opens: null });
    }
  });
});

// The build boundary points one way. Nothing in `scripts/` ships: not through
// electrobun.config.ts's copy map, not through `build:cli`, not into the
// Docker image. A tool may import the app's modules (`scripts/licenses.ts`
// calls `src/bun/licenses.ts`, which is what makes that logic testable). The
// app may never import a tool, because that would quietly make a developer's
// script part of what ships.
describe("src/ does not import the tools", () => {
  const inSrc = named.filter(([name]) => name.startsWith("src/"));
  test.each(inSrc)("%s", (name, path) => {
    const text = code(readFileSync(path, "utf8"));
    expect({ file: name, imports: /["'](?:\.\.\/)+scripts\//.test(text) ? "scripts/" : null }).toEqual({
      file: name,
      imports: null,
    });
  });
});
