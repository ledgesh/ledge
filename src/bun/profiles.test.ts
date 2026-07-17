import { describe, expect, test } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertProfileName, ensureProfileFile, readProfile, writeProfile } from "./profiles";
import { PROFILES_DIR } from "./spawnParams";

// PROFILES_DIR points at a scratch dir here (test-preload.ts), same deal as
// the notes root: these tests touch a real filesystem, never the real config.

describe("assertProfileName", () => {
  test("a name that could steer the path is refused", () => {
    // The name becomes a filename; this guard is the entire trust story for
    // profileOpen, which takes it from the least-trusted end of the RPC.
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
    // The seed documents the format and names the frontmatter line that uses
    // it — the file is the UI, so it explains itself.
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
    // The atomic-save temp is dotted and renamed away; nothing may linger.
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(PROFILES_DIR)).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });

  test("neither call takes a name that could steer the path", async () => {
    await expect(readProfile("../up")).rejects.toThrow();
    await expect(writeProfile("a/b", "X=1\n")).rejects.toThrow();
  });
});
