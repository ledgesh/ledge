import { describe, expect, test } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertProfileName, ensureProfileFile, readProfile, writeProfile } from "./profiles";
import { PROFILES_DIR } from "./spawnParams";

// test-preload.ts points PROFILES_DIR at a scratch directory, the way it does
// the notes root. These tests write actual files, never the profiles
// directory of the account running them.

describe("assertProfileName", () => {
  test("a name that could steer the path is refused", () => {
    // The name becomes a filename, and it arrives from the view. Nothing
    // else validates it: the profileRead and profileWrite RPCs hand the name
    // straight to readProfile and writeProfile (server.ts), and the
    // assertProfileName those two call is the only check on the way to the
    // filesystem.
    for (const bad of ["../evil", "a/b", "a\\b", ".hidden", "name.env", "", "a b"]) {
      expect(() => assertProfileName(bad)).toThrow();
    }
  });

  test("plain names pass", () => {
    expect(assertProfileName("petstore")).toBe("petstore");
    expect(assertProfileName("stripe-test_2")).toBe("stripe-test_2");
  });
});

describe("ensureProfileFile", () => {
  test("a new profile is created seeded, 0600, under the profiles dir", async () => {
    const path = await ensureProfileFile("fresh");
    expect(path).toBe(join(PROFILES_DIR, "fresh.env"));
    const text = await readFile(path, "utf8");
    // The seed documents the KEY=value format and names the frontmatter line
    // that selects the profile.
    expect(text).toContain("profile: fresh");
    expect(text).toContain("KEY=value");
    // Secrets file: owner-only.
    expect(((await stat(path)).mode & 0o777).toString(8)).toBe("600");
  });

  test("an existing profile is never rewritten", async () => {
    const path = join(PROFILES_DIR, "keepme.env");
    await ensureProfileFile("keepme");
    await writeFile(path, "API_KEY=real-secret\n");
    await ensureProfileFile("keepme");
    expect(await readFile(path, "utf8")).toBe("API_KEY=real-secret\n");
  });

  test("a bad name never reaches the filesystem", async () => {
    await expect(ensureProfileFile("../escape")).rejects.toThrow();
  });
});

describe("readProfile / writeProfile (the editor's load/save)", () => {
  test("a round trip: first read seeds, write replaces, read returns it", async () => {
    const first = await readProfile("rt");
    expect(first).toContain("profile: rt"); // the seed
    await writeProfile("rt", "# kept\nAPI_KEY=abc\n");
    expect(await readProfile("rt")).toBe("# kept\nAPI_KEY=abc\n");
  });

  test("a write keeps the file 0600 and leaves no temp behind", async () => {
    await writeProfile("modes", "A=1\n");
    const path = join(PROFILES_DIR, "modes.env");
    expect(((await stat(path)).mode & 0o777).toString(8)).toBe("600");
    // The atomic save writes a dotted temp file and renames it into place.
    // writeProfile unlinks that temp when the write or the rename throws, so
    // the directory holds no leftover either way.
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(PROFILES_DIR)).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });

  test("neither call takes a name that could steer the path", async () => {
    await expect(readProfile("../up")).rejects.toThrow();
    await expect(writeProfile("a/b", "X=1\n")).rejects.toThrow();
  });
});
