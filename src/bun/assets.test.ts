// The asset guard, plus the save and read paths around it. assetPathOf is the
// only guard on assetRead, the one RPC that takes a view-supplied relative
// path. Each of its refusals gets a named test, the way assertTrashed's do
// (testing.md §3). Since the per-workspace split the reference resolves
// against a caller-named root. That makes "which root" part of the guard too.
// These tests run against the scratch app home src/test-preload.ts sets. The
// guard below re-checks that, because beforeEach wipes the app home and must
// never wipe the wrong folder (notes.fs.test.ts guards it for that reason).
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { APP_HOME, createManaged, loadWorkspaces } from "./workspaces";
import {
  assetsDirOf,
  assetPathOf,
  assetRefFor,
  extensionFor,
  imageMimeOf,
  readAsset,
  savePastedImage,
  writePastedImage,
} from "./assets";

if (!resolve(APP_HOME).startsWith(resolve(tmpdir()) + sep)) {
  throw new Error(`refusing to run filesystem tests against ${APP_HOME} — is the preload configured?`);
}

let ROOT = "";
let ASSETS = "";

beforeEach(async () => {
  await rm(APP_HOME, { recursive: true, force: true });
  await mkdir(APP_HOME, { recursive: true });
  await loadWorkspaces();
  ROOT = await createManaged("Notes");
  ASSETS = assetsDirOf(ROOT);
  await mkdir(ASSETS, { recursive: true });
});

// Not a real image. readAsset reads the mime off the extension. The guard
// decides which files may be read, not what is in them.
const BYTES = new Uint8Array([1, 2, 3, 4]);

describe("assetPathOf", () => {
  test("a note-relative image path resolves inside its workspace root", () => {
    expect(assetPathOf(ROOT, ".ledge-assets/x.png")).toBe(join(ROOT, ".ledge-assets", "x.png"));
  });

  test("an image sitting outside .ledge-assets/ but inside the root is allowed", () => {
    // Where the user files an image is their business, so an image outside
    // .ledge-assets/ is served too. The root bounds it, and the dot-entry and
    // extension rules below still apply. An attached project's own visible
    // assets/ folder is one such place.
    expect(assetPathOf(ROOT, "pics/x.jpeg")).toBe(join(ROOT, "pics", "x.jpeg"));
    expect(assetPathOf(ROOT, "assets/x.png")).toBe(join(ROOT, "assets", "x.png"));
  });

  test("an unregistered root is refused before the reference is even looked at", () => {
    expect(() => assetPathOf(APP_HOME, ".ledge-assets/x.png")).toThrow(/not a registered workspace root/);
    expect(() => assetPathOf(join(ROOT, "sub"), ".ledge-assets/x.png")).toThrow(/not a registered workspace root/);
  });

  test("a traversal out of the root is rejected", () => {
    expect(() => assetPathOf(ROOT, "../outside.png")).toThrow();
    expect(() => assetPathOf(ROOT, ".ledge-assets/../../outside.png")).toThrow();
  });

  test("an absolute path is rejected", () => {
    expect(() => assetPathOf(ROOT, "/etc/passwd.png")).toThrow();
  });

  test("a dot-entry anywhere in the path is rejected — invisible stays unservable", () => {
    expect(() => assetPathOf(ROOT, ".ledge-trash/x.png")).toThrow();
    expect(() => assetPathOf(ROOT, ".git/logo.png")).toThrow();
    // The app's own assets dir is the single exception, and only as the first
    // segment. A dotted name inside it stays unservable (the in-flight
    // .asset.tmp files among them), and the dir earns no exception deeper in
    // the path.
    expect(() => assetPathOf(ROOT, ".ledge-assets/.hidden.png")).toThrow();
    expect(() => assetPathOf(ROOT, "sub/.ledge-assets/x.png")).toThrow();
  });

  test("a non-image extension is rejected — this call must not read notes or config", () => {
    expect(() => assetPathOf(ROOT, "config.json")).toThrow();
    expect(() => assetPathOf(ROOT, "note.md")).toThrow();
    expect(() => assetPathOf(ROOT, ".ledge-assets/archive.zip")).toThrow();
  });

  test("a URL is not an asset reference, however image-shaped it looks", () => {
    // `resolve` turns these into in-root paths that pass every other check
    // (`<root>/https:/example.com/x.png`). The view draws them as remote
    // images and never asks for bytes, so both ends have to agree on what is
    // an asset. moveNote rewrites every reference this function accepts, so
    // accepting a URL here would rewrite the URL.
    expect(() => assetPathOf(ROOT, "https://example.com/x.png")).toThrow(/not an asset reference/);
    expect(() => assetPathOf(ROOT, "file:///etc/x.png")).toThrow(/not an asset reference/);
    expect(() => assetPathOf(ROOT, "www.example.com/x.png")).toThrow(/not an asset reference/);
  });

  test("backslashes are rejected rather than interpreted", () => {
    expect(() => assetPathOf(ROOT, "assets\\x.png")).toThrow();
  });
});

describe("imageMimeOf", () => {
  test("extensions map case-insensitively, unknowns to null", () => {
    expect(imageMimeOf("a.PNG")).toBe("image/png");
    expect(imageMimeOf("a.jpg")).toBe("image/jpeg");
    expect(imageMimeOf("a.txt")).toBeNull();
    expect(imageMimeOf("a")).toBeNull();
  });
});


// A reference resolves against the note that carries it, not against the
// root, so a note in a subfolder reaches the shared pool with `../`. The
// escape rules do not loosen: every check runs on the resolved path.
describe("assetPathOf against the note that carries the reference", () => {
  test("a subfolder note reaches the root's shared assets with ../", () => {
    const from = join(ROOT, "trips", "japan.md");
    expect(assetPathOf(ROOT, "../.ledge-assets/x.png", from)).toBe(join(ASSETS, "x.png"));
    expect(assetPathOf(ROOT, "../../.ledge-assets/x.png", join(ROOT, "a", "b", "n.md"))).toBe(join(ASSETS, "x.png"));
  });

  test("a bare reference resolves beside the note, not at the root", () => {
    const from = join(ROOT, "trips", "japan.md");
    expect(assetPathOf(ROOT, "photo.png", from)).toBe(join(ROOT, "trips", "photo.png"));
    expect(assetPathOf(ROOT, "photo.png")).toBe(join(ROOT, "photo.png"));
  });

  test("climbing past the root is still refused, however deep the note is", () => {
    expect(() => assetPathOf(ROOT, "../x.png", join(ROOT, "n.md"))).toThrow(/outside the workspace root/);
    expect(() => assetPathOf(ROOT, "../../../x.png", join(ROOT, "a", "n.md"))).toThrow(/outside the workspace root/);
  });

  test("a dot-entry the ../ steps land on is still refused", () => {
    const from = join(ROOT, "trips", "japan.md");
    expect(() => assetPathOf(ROOT, "../.ledge-trash/x.png", from)).toThrow(/dot-entry/);
    expect(() => assetPathOf(ROOT, "../.ledge-assets/.tmp.png", from)).toThrow(/dot-entry/);
  });

  test("the base is guarded like the reference: a .md inside this root", () => {
    // notePath rides the same RPC as src and is the same untrusted string.
    expect(() => assetPathOf(ROOT, "x.png", "/etc/passwd")).toThrow(/not a note in this workspace/);
    expect(() => assetPathOf(ROOT, "x.png", join(ROOT, "..", "elsewhere", "n.md"))).toThrow(/not a note in this workspace/);
    expect(() => assetPathOf(ROOT, "x.png", join(ROOT, "notes"))).toThrow(/not a note in this workspace/);
  });
});

describe("assetRefFor", () => {
  test("writes the reference the carrying note needs", () => {
    expect(assetRefFor(ROOT, join(ASSETS, "x.png"))).toBe(".ledge-assets/x.png");
    expect(assetRefFor(ROOT, join(ASSETS, "x.png"), join(ROOT, "n.md"))).toBe(".ledge-assets/x.png");
    expect(assetRefFor(ROOT, join(ASSETS, "x.png"), join(ROOT, "trips", "japan.md"))).toBe("../.ledge-assets/x.png");
    expect(assetRefFor(ROOT, join(ASSETS, "x.png"), join(ROOT, "a", "b", "n.md"))).toBe("../../.ledge-assets/x.png");
  });

  test("round-trips through the guard it is written for", () => {
    const from = join(ROOT, "a", "b", "n.md");
    const ref = assetRefFor(ROOT, join(ASSETS, "x.png"), from);
    expect(assetPathOf(ROOT, ref, from)).toBe(join(ASSETS, "x.png"));
  });
});

// Narrow readAsset's union to the plain-bytes case these tests assert on.
// Sealed reads have their own describe below.
function asBytes(got: Awaited<ReturnType<typeof readAsset>>): { dataB64: string; mime: string } {
  if (got === null || "sealed" in got) throw new Error("expected plain bytes");
  return got;
}

describe("readAsset", () => {
  test("serves the bytes and mime of an existing asset", async () => {
    await writeFile(join(ASSETS, "x.png"), BYTES);
    const got = await readAsset(ROOT, ".ledge-assets/x.png");
    expect(got).not.toBeNull();
    expect(asBytes(got).mime).toBe("image/png");
    expect(new Uint8Array(Buffer.from(asBytes(got).dataB64, "base64"))).toEqual(BYTES);
  });

  test("the same reference in another workspace is that workspace's file, not this one's", async () => {
    // assetRead carries a root because `.ledge-assets/x.png` names a
    // different file in each workspace.
    const other = await createManaged("Other");
    await mkdir(assetsDirOf(other), { recursive: true });
    await writeFile(join(ASSETS, "x.png"), BYTES);
    await writeFile(join(assetsDirOf(other), "x.png"), new Uint8Array([9, 9]));
    const got = await readAsset(other, ".ledge-assets/x.png");
    expect(new Uint8Array(Buffer.from(asBytes(got).dataB64, "base64"))).toEqual(new Uint8Array([9, 9]));
  });

  test("a missing file is null, not an error — the widget shows a placeholder", async () => {
    expect(await readAsset(ROOT, ".ledge-assets/gone.png")).toBeNull();
  });

  test("a guarded path still throws — missing and forbidden are different answers", async () => {
    await expect(readAsset(ROOT, "../outside.png")).rejects.toThrow();
  });
});

describe("savePastedImage", () => {
  test("writes under the root's .ledge-assets/ and returns the markdown-relative reference", async () => {
    const src = await savePastedImage(ROOT, BYTES);
    expect(src).toMatch(/^\.ledge-assets\/pasted-\d{4}-\d{2}-\d{2}\.png$/);
    const got = await readAsset(ROOT, src);
    expect(new Uint8Array(Buffer.from(asBytes(got).dataB64, "base64"))).toEqual(BYTES);
  });

  test("a second paste the same day enumerates instead of clobbering", async () => {
    const a = await savePastedImage(ROOT, BYTES);
    const b = await savePastedImage(ROOT, new Uint8Array([9, 9]));
    expect(b).not.toBe(a);
    const got = await readAsset(ROOT, a);
    expect(new Uint8Array(Buffer.from(asBytes(got).dataB64, "base64"))).toEqual(BYTES);
  });

  test("a paste from a note in a folder lands in the ROOT's pool and reads back from there", async () => {
    // One pool per workspace root, whatever folder the note sits in. That is
    // what lets two notes share an image, and what the lock sweep assumes
    // (locking.md §5).
    const from = join(ROOT, "trips", "japan.md");
    const src = await savePastedImage(ROOT, BYTES, ".png", false, from);
    expect(src).toMatch(/^\.\.\/\.ledge-assets\/pasted-\d{4}-\d{2}-\d{2}\.png$/);
    expect(await readdir(ASSETS)).toHaveLength(1);
    const got = await readAsset(ROOT, src, from);
    expect(new Uint8Array(Buffer.from(asBytes(got).dataB64, "base64"))).toEqual(BYTES);
    // The same file, named from the root instead, reads back the same bytes.
    const flat = src.replace("../", "");
    expect(new Uint8Array(Buffer.from(asBytes(await readAsset(ROOT, flat)).dataB64, "base64"))).toEqual(BYTES);
  });

  test("leaves no temp droppings behind", async () => {
    await savePastedImage(ROOT, BYTES);
    const names = await readdir(ASSETS);
    expect(names.filter((n) => n.startsWith("."))).toEqual([]);
  });
});

// The extension has to follow the bytes. imageMimeOf reads the mime back off
// the extension, so a JPEG named .png is an image the browser has to sniff.
// This became load-bearing with the photo picker (ios.md §11). A phone's
// pictures are photographs, and forcing them through PNG was a tenfold size
// increase, measured on the first one ever inserted.
describe("the extension a paste is written under", () => {
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

  test("JPEG bytes are named .jpg, and read back as image/jpeg", async () => {
    const src = await writePastedImage(ROOT, JPEG);
    expect(src).toMatch(/\.jpg$/);
    expect(imageMimeOf(src!)).toBe("image/jpeg");
  });

  test("PNG bytes, and anything unrecognised, stay .png", async () => {
    expect(await writePastedImage(ROOT, PNG)).toMatch(/\.png$/);
    expect(await writePastedImage(ROOT, new Uint8Array([1, 2, 3, 4]))).toMatch(/\.png$/);
  });

  test("a truncated header is not read past its end", () => {
    // Reachable: assetWrite takes whatever bytes a client sent, and a client is
    // the least-trusted end (remote.md §2).
    expect(extensionFor(new Uint8Array([]))).toBe(".png");
    expect(extensionFor(new Uint8Array([0xff, 0xd8]))).toBe(".png");
  });
});

// --- sealed images (locking.md §5) --------------------------------------
import { createNote, lockNote, moveNote, readNote, removeLockNote } from "./notes";
import { createVault, isSealedAsset, lockVault, resetVaultForTests, unlockVault } from "./vault";

// One device, because nothing here is about the per-device vault (locking.md
// §3a): these tests are the seal, the placeholder and the unseal sweep.
const DEVICE = "device-under-test";
import { readFile as readRawFile, stat } from "node:fs/promises";

// A reference is relative to the note, so moving the note changes what each
// one names. moveNote rewrites them. Without that, filing a note with
// pictures into a folder breaks every picture in it.
describe("moving a note rebases its image references", () => {
  const textOf = async (path: string) => (await readNote(path))!.text;

  test("into a folder, and back out again", async () => {
    await writeFile(join(ASSETS, "chart.png"), BYTES);
    const note = await createNote(ROOT, "# Report\n\n![chart](.ledge-assets/chart.png)\n");
    const moved = await moveNote(note.path, "q1/finance");
    expect(await textOf(moved.path)).toContain("![chart](../../.ledge-assets/chart.png)");
    // The picture the note shows is still the same file.
    const got = await readAsset(ROOT, "../../.ledge-assets/chart.png", moved.path);
    expect(new Uint8Array(Buffer.from(asBytes(got).dataB64, "base64"))).toEqual(BYTES);

    const back = await moveNote(moved.path, null);
    expect(await textOf(back.path)).toContain("![chart](.ledge-assets/chart.png)");
  });

  test("a sibling image travels as a relative reference too", async () => {
    await mkdir(join(ROOT, "img"), { recursive: true });
    await writeFile(join(ROOT, "img", "logo.png"), BYTES);
    const note = await createNote(ROOT, "# Brand\n\n![logo](img/logo.png)\n");
    const moved = await moveNote(note.path, "press");
    expect(await textOf(moved.path)).toContain("![logo](../img/logo.png)");
  });

  test("what is not an in-root image is left exactly as written", async () => {
    const body = [
      "# Mixed",
      "",
      "![web](https://example.com/x.png)",
      "![gone](.ledge-assets/missing.png)",
      "![doc](notes.md)",
      "",
    ].join("\n");
    const note = await createNote(ROOT, body);
    const moved = await moveNote(note.path, "sub");
    const text = await textOf(moved.path);
    expect(text).toContain("![web](https://example.com/x.png)");
    expect(text).toContain("![doc](notes.md)");
    // A reference that resolves is rebased whether or not the file is there
    // yet: an image not pasted until later should still travel with the note.
    expect(text).toContain("![gone](../.ledge-assets/missing.png)");
  });

  test("a note with no images is renamed and not rewritten", async () => {
    const note = await createNote(ROOT, "# Plain\n\nno pictures here\n");
    const before = (await stat(note.path)).mtimeMs;
    const moved = await moveNote(note.path, "sub");
    // rename(2) preserves mtime, so an untouched mtime is proof no write ran.
    expect((await stat(moved.path)).mtimeMs).toBe(before);
  });
});

describe("sealed images", () => {
  beforeEach(async () => {
    resetVaultForTests();
    await createVault("asset-pass", DEVICE);
  });

  test("a paste into a locked note is sealed from the first byte, and round-trips", async () => {
    const src = await savePastedImage(ROOT, BYTES, ".png", true);
    const onDisk = await readRawFile(join(ROOT, src));
    expect(isSealedAsset(onDisk)).toBe(true);
    expect(onDisk.includes(Buffer.from(BYTES))).toBe(false); // no plaintext run survives
    const got = await readAsset(ROOT, src);
    expect(new Uint8Array(Buffer.from(asBytes(got).dataB64, "base64"))).toEqual(BYTES);
    // With the vault locked readAsset returns { sealed: true }, never the
    // bytes. The widget shows the locked placeholder rather than a broken
    // image.
    lockVault();
    expect(await readAsset(ROOT, src)).toEqual({ sealed: true });
  });

  test("locking a note sweeps its referenced images; Remove Lock reverses it", async () => {
    await mkdir(ASSETS, { recursive: true });
    await writeFile(join(ASSETS, "chart.png"), BYTES);
    const note = await createNote(ROOT, "# Report\n\n![chart](.ledge-assets/chart.png)\n");
    await lockNote(note.path);
    expect(isSealedAsset(await readRawFile(join(ASSETS, "chart.png")))).toBe(true);
    await removeLockNote(note.path);
    const back = await readRawFile(join(ASSETS, "chart.png"));
    expect(isSealedAsset(back)).toBe(false);
    expect(new Uint8Array(back)).toEqual(BYTES);
  });

  test("an image an unlocked note still shows is sealed AND surfaced, never refused", async () => {
    // Refusing would deadlock locking two notes that share an image: each
    // would block on the other. Sealing extends the lock's visibility rule to
    // the shared image, and sealedShared is what the UI reports.
    await mkdir(ASSETS, { recursive: true });
    await writeFile(join(ASSETS, "shared.png"), BYTES);
    await createNote(ROOT, "# Also Shows It\n\n![x](.ledge-assets/shared.png)\n");
    const note = await createNote(ROOT, "# Wants Lock\n\n![x](.ledge-assets/shared.png)\n");
    const res = await lockNote(note.path);
    expect(res.sealedShared).toEqual(['.ledge-assets/shared.png (also shown by "Also Shows It")']);
    expect(isSealedAsset(await readRawFile(join(ASSETS, "shared.png")))).toBe(true);
    // The sharing note stays unlocked, but readAsset returns { sealed: true }
    // for it while the vault is locked. The image reads the same way from
    // every note.
    lockVault();
    expect(await readAsset(ROOT, ".ledge-assets/shared.png")).toEqual({ sealed: true });
  });

  // Two notes in different folders write one image two ways:
  // `.ledge-assets/x.png` from the root, `../.ledge-assets/x.png` a folder
  // down. Both sweeps compare resolved paths, never reference strings. The old
  // `other.text.includes(ref)` (lockNote and removeLockNote in notes.ts) found
  // the sharer when the note being swept was the shallow one, and missed it
  // when the swept note was the deep one, so both directions get a test
  // (testing.md §3). A miss seals a shared image without reporting it, and
  // leaves one unsealed that a locked note still shows (locking.md §5).
  test("a sharing note at the ROOT is found when the locking note is in a folder", async () => {
    await writeFile(join(ASSETS, "team.png"), BYTES);
    await createNote(ROOT, "# Roster\n\n![x](.ledge-assets/team.png)\n");
    const note = await createNote(ROOT, "# Pay\n\n![x](../.ledge-assets/team.png)\n", "people");
    const res = await lockNote(note.path);
    expect(res.sealedShared).toEqual(['../.ledge-assets/team.png (also shown by "Roster")']);
  });

  test("a LOCKED note at the root keeps its claim when a folder note drops its lock", async () => {
    await writeFile(join(ASSETS, "plan.png"), BYTES);
    const flat = await createNote(ROOT, "# Flat\n\n![x](.ledge-assets/plan.png)\n");
    const deep = await createNote(ROOT, "# Deep\n\n![x](../../.ledge-assets/plan.png)\n", "q1/finance");
    await lockNote(flat.path);
    await lockNote(deep.path);
    await removeLockNote(deep.path);
    // `flat` is still locked and still shows the image, so it stays sealed.
    // Unsealing here is the leak the resolved-path comparison stops: it would
    // leave a locked note's image readable with the vault shut.
    expect(isSealedAsset(await readRawFile(join(ASSETS, "plan.png")))).toBe(true);
    await removeLockNote(flat.path);
    expect(isSealedAsset(await readRawFile(join(ASSETS, "plan.png")))).toBe(false);
  });

  test("a locked note moves when the vault is open, and refuses when it is shut", async () => {
    await writeFile(join(ASSETS, "secret.png"), BYTES);
    const note = await createNote(ROOT, "# Hush\n\n![x](.ledge-assets/secret.png)\n");
    await lockNote(note.path);
    const moved = await moveNote(note.path, "private");
    expect((await readNote(moved.path))!.text).toContain("![x](../.ledge-assets/secret.png)");
    expect((await readNote(moved.path))!.locked).toBe(true);

    // With the vault shut the body is unreadable, so the rewrite cannot run.
    // Moving anyway would land the note with its picture pointing at nothing.
    lockVault();
    expect(moveNote(moved.path, "elsewhere")).rejects.toThrow(/unlock first/);
    expect(await unlockVault("asset-pass", DEVICE)).toBe(true);
    const again = await moveNote(moved.path, "elsewhere");
    expect((await readNote(again.path))!.text).toContain("![x](../.ledge-assets/secret.png)");
  });

  test("an image another LOCKED note still shows stays sealed through Remove Lock", async () => {
    await mkdir(ASSETS, { recursive: true });
    await writeFile(join(ASSETS, "both.png"), BYTES);
    const a = await createNote(ROOT, "# First\n\n![x](.ledge-assets/both.png)\n");
    const b = await createNote(ROOT, "# Second\n\n![x](.ledge-assets/both.png)\n");
    await lockNote(a.path);
    await lockNote(b.path); // no conflict: the sweep skips an already-locked sharer
    await removeLockNote(a.path);
    // The second note is still locked and still shows the image, so its claim
    // keeps the image sealed through this Remove Lock.
    expect(isSealedAsset(await readRawFile(join(ASSETS, "both.png")))).toBe(true);
    await removeLockNote(b.path);
    expect(isSealedAsset(await readRawFile(join(ASSETS, "both.png")))).toBe(false);
  });
});
