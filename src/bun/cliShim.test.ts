// The pure half of cliShim: the script's shape, the self-recognition marker,
// the PATH answer and the startup-file table. cliShim.fs.test.ts covers what
// installShims does to a real directory.
import { describe, expect, test } from "bun:test";
import { dirOnPath, isLedgeShim, shimDir, shimScript, startupFile } from "./cliShim";

describe("shimScript", () => {
  test("execs the given runtime and entry, then every argument: the caller's first word is the verb", () => {
    const s = shimScript("/App/Contents/MacOS/bun", "/App/Contents/Resources/app/bun/serve.js");
    expect(s.startsWith("#!/bin/sh\n")).toBe(true);
    expect(s).toContain('exec "/App/Contents/MacOS/bun" "/App/Contents/Resources/app/bun/serve.js" "$@"');
    expect(s.endsWith("\n")).toBe(true);
  });

  test("a path with sh-meaningful characters stays one quoted word", () => {
    const s = shimScript("/odd path/bu\"n", "/odd$dir/serve.js");
    expect(s).toContain('exec "/odd path/bu\\"n" "/odd\\$dir/serve.js" "$@"');
  });

  test("recognizes its own output and server.sh's launcher, and not a stranger's script", () => {
    expect(isLedgeShim(shimScript("/bin/bun", "/x/serve.js"))).toBe(true);
    expect(isLedgeShim("#!/bin/sh\n# Written by https://ledge.sh/server.sh. Runs ledge on the Bun installed beside it.\n")).toBe(true);
    expect(isLedgeShim("#!/bin/sh\nexec something else\n")).toBe(false);
  });
});

test("the shim goes where the ssh command looks first", () => {
  expect(shimDir("/Users/u")).toBe("/Users/u/.ledge/.server/bin");
});

describe("dirOnPath", () => {
  test("matches an entry exactly, resolved, and ignores empty segments", () => {
    expect(dirOnPath("/usr/local/bin", "/usr/bin:/usr/local/bin")).toBe(true);
    expect(dirOnPath("/usr/local/bin", "/usr/local/bin/../bin")).toBe(true);
    expect(dirOnPath("/usr/local/bin", ":/usr/bin:")).toBe(false);
    expect(dirOnPath("/usr/local/bin", "")).toBe(false);
  });
});

// server.sh's add_to_path, line for line: the two installers must edit the
// same file, or a Mac that ran both gets the line twice.
describe("startupFile", () => {
  test("zsh reads .zshrc, bash reads .bash_profile on a Mac and .bashrc elsewhere", () => {
    expect(startupFile("/bin/zsh", "/h", "darwin")).toBe("/h/.zshrc");
    expect(startupFile("/bin/bash", "/h", "darwin")).toBe("/h/.bash_profile");
    expect(startupFile("/bin/bash", "/h", "linux")).toBe("/h/.bashrc");
    expect(startupFile("/bin/sh", "/h", "darwin")).toBe("/h/.profile");
    expect(startupFile("", "/h", "darwin")).toBe("/h/.profile");
  });

  test("fish and the csh family get no line, since the syntax is not theirs", () => {
    expect(startupFile("/opt/homebrew/bin/fish", "/h")).toBeNull();
    expect(startupFile("/bin/tcsh", "/h")).toBeNull();
  });
});
