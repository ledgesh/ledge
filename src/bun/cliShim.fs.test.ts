// installShim against a real filesystem — every dir a scratch one. The
// candidates are ALWAYS passed explicitly here: the real defaults include
// /opt/homebrew/bin, which on a dev machine exists, is writable, and must
// never receive a test's shim.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installShim, isLedgeShim } from "./cliShim";

let HOME = "";
let BIN = "";
let ENTRY = "";

beforeEach(async () => {
  HOME = await mkdtemp(join(tmpdir(), "ledge-shim-"));
  BIN = join(HOME, "bin");
  await mkdir(BIN, { recursive: true });
  ENTRY = join(HOME, "cli.js");
  await writeFile(ENTRY, "// pretend bundle\n");
});

afterEach(async () => {
  await rm(HOME, { recursive: true, force: true });
});

describe("installShim", () => {
  test("writes an executable shim and answers whether its dir is on PATH", async () => {
    const res = await installShim({ execPath: "/runtime/bun", entryPath: ENTRY, pathVar: `/usr/bin:${BIN}`, dir: BIN });
    expect(res).toEqual({ path: join(BIN, "ledge"), onPath: true });
    const text = await readFile(res.path, "utf8");
    expect(isLedgeShim(text)).toBe(true);
    expect(text).toContain(`exec "/runtime/bun" "${ENTRY}" "$@"`);
    expect(((await stat(res.path)).mode & 0o111) !== 0).toBe(true);
    const off = await installShim({ execPath: "/runtime/bun", entryPath: ENTRY, pathVar: "/usr/bin", dir: BIN });
    expect(off.onPath).toBe(false);
  });

  test("reinstalling over its own shim repoints it", async () => {
    await installShim({ execPath: "/old/bun", entryPath: ENTRY, pathVar: "", dir: BIN });
    await installShim({ execPath: "/new/bun", entryPath: ENTRY, pathVar: "", dir: BIN });
    const text = await readFile(join(BIN, "ledge"), "utf8");
    expect(text).toContain("/new/bun");
    expect(text).not.toContain("/old/bun");
  });

  test("refuses to overwrite a file that is not a Ledge shim, leaving it untouched", async () => {
    await writeFile(join(BIN, "ledge"), "#!/bin/sh\nsomebody else's ledge\n");
    await expect(
      installShim({ execPath: "/runtime/bun", entryPath: ENTRY, pathVar: "", dir: BIN }),
    ).rejects.toThrow(/not a Ledge shim/);
    expect(await readFile(join(BIN, "ledge"), "utf8")).toContain("somebody else's");
  });

  test("a missing CLI entry fails the install up front, not at the shim's first use", async () => {
    await expect(
      installShim({ execPath: "/runtime/bun", entryPath: join(HOME, "gone.js"), pathVar: "", dir: BIN }),
    ).rejects.toThrow(/rebuild the app/);
  });

  test("with no dir, the first writable candidate wins", async () => {
    const other = join(HOME, "other-bin");
    await mkdir(other, { recursive: true });
    const res = await installShim({
      execPath: "/runtime/bun",
      entryPath: ENTRY,
      pathVar: "",
      home: HOME,
      candidates: [join(HOME, "missing"), other, BIN],
    });
    expect(res.path).toBe(join(other, "ledge"));
  });

  test("with no candidate writable, ~/.local/bin is grown and used", async () => {
    const res = await installShim({
      execPath: "/runtime/bun",
      entryPath: ENTRY,
      pathVar: "",
      home: HOME,
      candidates: [join(HOME, "missing")],
    });
    expect(res.path).toBe(join(HOME, ".local", "bin", "ledge"));
    expect(isLedgeShim(await readFile(res.path, "utf8"))).toBe(true);
  });
});
