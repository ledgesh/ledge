// The orphan sweep against a real filesystem. Each test is one way a sweep
// could take an image a note still shows (architecture.md §3): a reference the
// note parser cannot read, a note no listing shows, a locked body, an undo the
// sweep never saw. Plus the purge's guard, which is the one asset unlink.
//
// These run against the scratch app home src/test-preload.ts sets. The guard
// below re-checks that, because beforeEach wipes the app home.
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { APP_HOME, createManaged, loadWorkspaces } from "./workspaces";
import { assetsDirOf, readAsset, savePastedImage, trashedAssetsDirOf } from "./assets";
import { changeVaultPassphrase, createNote, deleteNote, lockNote, trashDirOf } from "./notes";
import { createVault, lockVault, resetVaultForTests, unlockVault } from "./vault";
import { ASSET_GRACE_MS, assertTrashedAsset, purgeTrashedAssets, sweepOrphanAssets, tidyAssets } from "./assetSweep";

if (!resolve(APP_HOME).startsWith(resolve(tmpdir()) + sep)) {
  throw new Error(`refusing to run filesystem tests against ${APP_HOME} — is the preload configured?`);
}

const DEVICE = "device-under-test";
const BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const TTL = 30 * 24 * 60 * 60 * 1000;

let ROOT = "";
let POOL = "";
let TRASHED = "";

// A moment past the grace period, so every image pasted in a test is old
// enough to trash.
const later = (): number => Date.now() + ASSET_GRACE_MS + 1000;

async function paste(): Promise<string> {
  return savePastedImage(ROOT, BYTES);
}

async function pool(): Promise<string[]> {
  return (await readdir(POOL).catch(() => [])).sort();
}

async function trashed(): Promise<string[]> {
  return (await readdir(TRASHED).catch(() => [])).sort();
}

beforeEach(async () => {
  await rm(APP_HOME, { recursive: true, force: true });
  await mkdir(APP_HOME, { recursive: true });
  await loadWorkspaces();
  resetVaultForTests();
  ROOT = await createManaged("Notes");
  POOL = assetsDirOf(ROOT);
  TRASHED = trashedAssetsDirOf(ROOT);
});

describe("sweepOrphanAssets", () => {
  test("an image no note names goes to the trash; a named one stays", async () => {
    const kept = await paste();
    const unused = await paste();
    await createNote(ROOT, `# Kept\n\n![](${kept})\n`);
    const res = await sweepOrphanAssets(ROOT, later());
    expect(res).toEqual({ trashed: 1, restored: 0, held: false });
    expect(await pool()).toEqual([kept.split("/").pop()!]);
    expect(await trashed()).toEqual([unused.split("/").pop()!]);
  });

  test("an image younger than the grace period stays, named or not", async () => {
    await paste();
    expect((await sweepOrphanAssets(ROOT)).trashed).toBe(0);
    expect(await pool()).toHaveLength(1);
  });

  test("the sweep writes the trash's .gitignore when it creates the trash", async () => {
    await paste();
    await sweepOrphanAssets(ROOT, later());
    expect(await readFile(join(trashDirOf(ROOT), ".gitignore"), "utf8")).toContain("*");
  });

  test("a deleted note still in the trash keeps its images", async () => {
    const ref = await paste();
    const note = await createNote(ROOT, `# Gone\n\n![](${ref})\n`);
    await deleteNote(note.path);
    expect((await sweepOrphanAssets(ROOT, later())).trashed).toBe(0);
  });

  test("notes no listing shows keep their images: an ignored folder, a dot-folder", async () => {
    const a = (await paste()).split("/").pop()!;
    const b = (await paste()).split("/").pop()!;
    await writeFile(join(ROOT, ".ledgeignore"), "private\n");
    await mkdir(join(ROOT, "private"));
    await writeFile(join(ROOT, "private", "n.md"), `# P\n\n![](../.ledge-assets/${a})\n`);
    await mkdir(join(ROOT, ".drafts"));
    await writeFile(join(ROOT, ".drafts", "n.md"), `# D\n\n![](../.ledge-assets/${b})\n`);
    expect((await sweepOrphanAssets(ROOT, later())).trashed).toBe(0);
  });

  test("reference syntaxes the note parser does not read still keep an image", async () => {
    await mkdir(POOL, { recursive: true });
    const names = ["title.png", "tag.png", "refdef.png", "My Pic.png", "space two.png"];
    for (const name of names) await writeFile(join(POOL, name), BYTES);
    await createNote(
      ROOT,
      [
        "# Refs",
        "",
        '![a](.ledge-assets/title.png "a title")',
        '<img src=".ledge-assets/tag.png" width="300">',
        "![r][pic]",
        "[pic]: .ledge-assets/refdef.png",
        "![](<.ledge-assets/my pic.png>)", // another case: APFS treats it as the same file
        "![](.ledge-assets/space%20two.png)",
        "",
      ].join("\n"),
    );
    expect((await sweepOrphanAssets(ROOT, later())).trashed).toBe(0);
  });

  test("a locked note holds the sweep while the vault is shut, and counts once it is open", async () => {
    await createVault("pass", DEVICE);
    const mine = await paste();
    const unused = (await paste()).split("/").pop()!;
    const note = await createNote(ROOT, `# Secret\n\n![](${mine})\n`);
    await lockNote(note.path);
    expect(await readFile(note.path, "utf8")).not.toContain(mine); // the reference is ciphertext now
    lockVault();

    const held = await tidyAssets(ROOT, 0, later());
    expect(held).toEqual({ trashed: 0, restored: 0, held: true, purged: 0 });
    expect(await pool()).toHaveLength(2);

    expect(await unlockVault("pass", DEVICE)).toBe(true);
    expect(await sweepOrphanAssets(ROOT, later())).toEqual({ trashed: 1, restored: 0, held: false });
    expect(await trashed()).toEqual([unused]);
  });

  test("a trashed image a note names again comes back to the pool", async () => {
    const ref = await paste();
    await sweepOrphanAssets(ROOT, later());
    expect(await pool()).toEqual([]);
    await createNote(ROOT, `# Undone\n\n![](${ref})\n`);
    expect(await sweepOrphanAssets(ROOT, later())).toEqual({ trashed: 0, restored: 1, held: false });
    expect(await pool()).toEqual([ref.split("/").pop()!]);
  });

  test("an image copied in by hand under a trashed image's name stays in the pool", async () => {
    const name = (await paste()).split("/").pop()!;
    await sweepOrphanAssets(ROOT, later());
    await writeFile(join(POOL, name), BYTES);
    expect((await sweepOrphanAssets(ROOT, later())).trashed).toBe(0);
    expect(await pool()).toEqual([name]);
    expect(await trashed()).toEqual([name]);
  });
});

describe("a swept image comes back when a note asks for it", () => {
  test("readAsset moves it back out of the trash and reads it", async () => {
    const ref = await paste();
    const note = await createNote(ROOT, "# Later\n\nno image yet\n");
    await sweepOrphanAssets(ROOT, later());
    const read = await readAsset(ROOT, ref, note.path);
    expect(read && "dataB64" in read ? Buffer.from(read.dataB64, "base64") : null).toEqual(Buffer.from(BYTES));
    expect(await pool()).toEqual([ref.split("/").pop()!]);
    expect(await trashed()).toEqual([]);
  });

  test("a new paste never takes a trashed image's name", async () => {
    const first = await paste();
    await sweepOrphanAssets(ROOT, later());
    const second = await paste();
    expect(second).not.toBe(first);
  });

  test("a passphrase change rewraps a sealed image in the trash, so it opens when it comes back", async () => {
    await createVault("old pass", DEVICE);
    const ref = await savePastedImage(ROOT, BYTES, ".png", true);
    await sweepOrphanAssets(ROOT, later());
    expect(await trashed()).toHaveLength(1);

    expect(await changeVaultPassphrase("new pass", [ROOT])).toBe(1);
    lockVault();
    expect(await unlockVault("new pass", DEVICE)).toBe(true);
    const read = await readAsset(ROOT, ref);
    expect(read && "dataB64" in read ? Buffer.from(read.dataB64, "base64") : null).toEqual(Buffer.from(BYTES));
  });
});

describe("purgeTrashedAssets", () => {
  test("only images past the TTL go", async () => {
    await paste();
    await sweepOrphanAssets(ROOT, later());
    expect(await purgeTrashedAssets(ROOT, TTL)).toBe(0);
    expect(await trashed()).toHaveLength(1);
    expect(await purgeTrashedAssets(ROOT, TTL, Date.now() + TTL + 1000)).toBe(1);
    expect(await trashed()).toEqual([]);
  });

  test("it touches nothing but images directly in the trashed pool", async () => {
    await mkdir(join(TRASHED, "sub"), { recursive: true });
    await writeFile(join(TRASHED, "note.md"), "# not an image\n");
    await writeFile(join(TRASHED, ".asset.tmp-1"), BYTES);
    await writeFile(join(TRASHED, "sub", "deep.png"), BYTES);
    expect(await purgeTrashedAssets(ROOT, 0, Date.now() + 1000)).toBe(0);
    expect((await readdir(TRASHED)).sort()).toEqual([".asset.tmp-1", "note.md", "sub"]);
  });
});

describe("assertTrashedAsset", () => {
  test("accepts an image directly in the trashed pool", () => {
    expect(assertTrashedAsset(join(TRASHED, "pasted.png"))).toBe(resolve(ROOT));
  });

  test("refuses a live pool image", () => {
    expect(() => assertTrashedAsset(join(POOL, "pasted.png"))).toThrow(/not a trashed image/);
  });

  test("refuses a trashed note", () => {
    expect(() => assertTrashedAsset(join(trashDirOf(ROOT), "note.md"))).toThrow(/not a trashed image/);
  });

  test("refuses a non-image in the trashed pool", () => {
    expect(() => assertTrashedAsset(join(TRASHED, "note.md"))).toThrow(/not a trashed image/);
  });

  test("refuses a dotted file in the trashed pool", () => {
    expect(() => assertTrashedAsset(join(TRASHED, ".hidden.png"))).toThrow(/not a trashed image/);
  });

  test("refuses an image in a folder below the trashed pool", () => {
    expect(() => assertTrashedAsset(join(TRASHED, "sub", "x.png"))).toThrow(/not a trashed image/);
  });

  test("refuses a path outside every workspace", () => {
    expect(() => assertTrashedAsset(join(tmpdir(), ".ledge-trash", ".ledge-assets", "x.png"))).toThrow(/not a trashed image/);
  });
});
