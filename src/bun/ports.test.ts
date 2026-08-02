// remote.md §3's first sentence as a test: **the server opens no port.**
//
// Everything §4 does rests on that. TLS, certificate rotation, an ingress and
// an authentication system of Ledge's own are all absent because there is
// nothing listening to authenticate to, and an `authorized_keys` forced
// command can only narrow what ssh already let in — it cannot restrict a
// socket that answered somebody directly.
//
// The claim is one sentence and its violation is one line, which is exactly
// the ratio that makes it worth a test rather than a review. ios.md phase 3
// added a fixture that DOES open a port (scripts/lan-bridge.ts), and the
// reason that is safe is structural: scripts/ is in no build. This is the
// other half — the half that stops the fixture from being moved somewhere it
// would ship, or a second one from being written under src/ by somebody who
// only read the fixture.
//
// Source is scanned rather than behavior observed, for portable.test.ts's
// reason: a test that merely ran the code would prove this process opened no
// port today, not that no code path can.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..");
const REPO = join(SRC, "..");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(path));
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** Prose may say "listen on a port"; code may not do it. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const files = sources(SRC);
const relative = (path: string): string => path.slice(REPO.length + 1);
const named = files.map((p) => [relative(p), p] as const);

// Bun.listen with a type parameter, which daemon.ts has. Anything up to the
// call's own paren, so a generic containing its own angle brackets still
// matches.
const ANY_LISTEN = /\bBun\s*\.\s*listen\b/g;
const UNIX_LISTEN = /\bBun\s*\.\s*listen\s*(?:<[^(]*>)?\s*\(\s*\{\s*unix\s*:/g;

const count = (text: string, re: RegExp): number => text.match(re)?.length ?? 0;

describe("nothing under src/ opens a port", () => {
  test("there is something to check", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  test.each(named)("%s", (name, path) => {
    const text = code(readFileSync(path, "utf8"));
    // Every listen is a unix socket listen. Counted rather than pattern-tested
    // so that a file with one of each is caught by the file that has the
    // legitimate one — daemon.ts is where a second, TCP listen would most
    // plausibly be added.
    expect({ file: name, listens: count(text, ANY_LISTEN), unix: count(text, UNIX_LISTEN) }).toEqual({
      file: name,
      listens: count(text, UNIX_LISTEN),
      unix: count(text, UNIX_LISTEN),
    });
    // A port by another route. `Bun.serve` is an HTTP server; the node
    // builtins are the same thing spelled older. `node:crypto`, `node:fs`,
    // `node:os` and `node:path` are the only ones this repo uses, so the list
    // costs nothing to keep closed.
    for (const [what, pattern] of [
      ["Bun.serve", /\bBun\s*\.\s*serve\s*\(/],
      ["a network builtin", /["']node:(?:net|http|https|http2|tls|dgram)["']/],
    ] as const) {
      expect({ file: name, opens: pattern.test(text) ? what : null }).toEqual({ file: name, opens: null });
    }
  });
});

// The fixture is only safe where it is. An import would drag it into whatever
// imported it, and the two things that import src/bun/ are the app bundle and
// the server binary.
describe("src/ does not import the fixtures", () => {
  test.each(named)("%s", (name, path) => {
    const text = code(readFileSync(path, "utf8"));
    expect({ file: name, imports: /["'](?:\.\.\/)+scripts\//.test(text) ? "scripts/" : null }).toEqual({
      file: name,
      imports: null,
    });
  });
});
