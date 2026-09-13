// installShims against a real filesystem. Every home is a scratch one, so the
// shims and the PATH line land under it and never in the developer's own
// ~/.ledge-server or ~/.zshrc.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installShims, isLedgeShim, PATH_LINE } from "./cliShim";

let HOME = "";
let BIN = "";
let ENTRY = "";

beforeEach(async () => {
  HOME = await mkdtemp(join(tmpdir(), "ledge-shim-"));
  BIN = join(HOME, ".ledge-server", "bin");
  ENTRY = join(HOME, "serve.js");
  await writeFile(ENTRY, "// pretend bundle\n");
});

afterEach(async () => {
  await rm(HOME, { recursive: true, force: true });
});

const install = (over: Partial<Parameters<typeof installShims>[0]> = {}) =>
  installShims({ execPath: "/runtime/bun", entryPath: ENTRY, pathVar: "/usr/bin", shellVar: "/bin/zsh", home: HOME, platform: "darwin", ...over });

describe("installShims", () => {
  test("writes both executable shims into ~/.ledge-server/bin: ledge runs the cli verb, ledge-server the caller's", async () => {
    const res = await install({ pathVar: `/usr/bin:${BIN}` });
    expect(res).toEqual({ dir: BIN, onPath: true, pathAdded: null });
    const ledge = await readFile(join(BIN, "ledge"), "utf8");
    const server = await readFile(join(BIN, "ledge-server"), "utf8");
    expect(isLedgeShim(ledge) && isLedgeShim(server)).toBe(true);
    expect(ledge).toContain(`exec "/runtime/bun" "${ENTRY}" cli "$@"`);
    expect(server).toContain(`exec "/runtime/bun" "${ENTRY}" "$@"`);
    for (const name of ["ledge", "ledge-server"]) {
      expect(((await stat(join(BIN, name))).mode & 0o111) !== 0).toBe(true);
    }
  });

  test("off PATH, the line goes into the login shell's startup file once, and a second install leaves it", async () => {
    const first = await install();
    expect(first.onPath).toBe(false);
    expect(first.pathAdded).toBe(join(HOME, ".zshrc"));
    const again = await install();
    expect(again.pathAdded).toBeNull();
    const lines = (await readFile(join(HOME, ".zshrc"), "utf8")).split("\n");
    expect(lines.filter((l) => l === PATH_LINE)).toHaveLength(1);
  });

  test("a startup file that already names the directory, in the user's own words, is left alone", async () => {
    await writeFile(join(HOME, ".zshrc"), 'path=("$HOME/.ledge-server/bin" $path)\n');
    expect((await install()).pathAdded).toBeNull();
    expect(await readFile(join(HOME, ".zshrc"), "utf8")).not.toContain(PATH_LINE);
  });

  test("a shell the line cannot go in gets no file touched, and the result says so", async () => {
    const res = await install({ shellVar: "/opt/homebrew/bin/fish" });
    expect(res.pathAdded).toBeNull();
    expect(res.onPath).toBe(false);
  });

  test("reinstalling over its own shims repoints them", async () => {
    await install({ execPath: "/old/bun" });
    await install({ execPath: "/new/bun" });
    for (const name of ["ledge", "ledge-server"]) {
      const text = await readFile(join(BIN, name), "utf8");
      expect(text).toContain("/new/bun");
      expect(text).not.toContain("/old/bun");
    }
  });

  test("replaces server.sh's launcher, which is Ledge's too", async () => {
    await mkdir(BIN, { recursive: true });
    await writeFile(join(BIN, "ledge-server"), "#!/bin/sh\n# Written by https://ledge.sh/server.sh. Runs ledge-server on the Bun installed beside it.\nexec x\n");
    await install();
    expect(await readFile(join(BIN, "ledge-server"), "utf8")).toContain(`"${ENTRY}"`);
  });

  test("refuses to overwrite a file that is not a Ledge shim, leaving both names untouched", async () => {
    await mkdir(BIN, { recursive: true });
    await writeFile(join(BIN, "ledge-server"), "#!/bin/sh\nsomebody else's server\n");
    await expect(install()).rejects.toThrow(/not a Ledge shim/);
    expect(await readFile(join(BIN, "ledge-server"), "utf8")).toContain("somebody else's");
    await expect(stat(join(BIN, "ledge"))).rejects.toThrow(); // the other was not written either
  });

  test("a missing entry fails the install up front, not at a shim's first use", async () => {
    await expect(install({ entryPath: join(HOME, "gone.js") })).rejects.toThrow(/rebuild the app/);
    await expect(stat(BIN)).rejects.toThrow();
  });
});
