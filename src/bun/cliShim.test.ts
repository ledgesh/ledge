// The shim's pure half: the script's shape, the self-recognition marker, and
// the PATH answer. What installShim does to a real bin dir is
// cliShim.fs.test.ts's subject.
import { describe, expect, test } from "bun:test";
import { dirOnPath, isLedgeShim, shimDirCandidates, shimScript } from "./cliShim";

describe("shimScript", () => {
  test("execs the given runtime and entry, forwarding every argument", () => {
    const s = shimScript("/App/Contents/MacOS/bun", "/App/Contents/Resources/app/bun/cli.js");
    expect(s.startsWith("#!/bin/sh\n")).toBe(true);
    expect(s).toContain('exec "/App/Contents/MacOS/bun" "/App/Contents/Resources/app/bun/cli.js" "$@"');
    expect(s.endsWith("\n")).toBe(true);
  });

  test("a path with sh-meaningful characters stays one quoted word", () => {
    const s = shimScript("/odd path/bu\"n", "/odd$dir/cli.js");
    expect(s).toContain('exec "/odd path/bu\\"n" "/odd\\$dir/cli.js" "$@"');
  });

  test("recognizes its own output, and not a stranger's script", () => {
    expect(isLedgeShim(shimScript("/bin/bun", "/x/cli.js"))).toBe(true);
    expect(isLedgeShim("#!/bin/sh\nexec something else\n")).toBe(false);
  });
});

describe("dirOnPath", () => {
  test("matches an entry exactly, resolved, and ignores empty segments", () => {
    expect(dirOnPath("/usr/local/bin", "/usr/bin:/usr/local/bin")).toBe(true);
    expect(dirOnPath("/usr/local/bin", "/usr/local/bin/../bin")).toBe(true);
    expect(dirOnPath("/usr/local/bin", ":/usr/bin:")).toBe(false);
    expect(dirOnPath("/usr/local/bin", "")).toBe(false);
  });
});

test("candidate dirs prefer the shared bins and end at the user's own", () => {
  expect(shimDirCandidates("/home/u")).toEqual(["/opt/homebrew/bin", "/usr/local/bin", "/home/u/.local/bin"]);
});
