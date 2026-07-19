// The asset guard and the save/read choreography. assetPathOf is the whole
// safety story for assetRead — the one RPC that takes a view-supplied
// relative path — so its refusals get named tests the way assertTrashed's do
// (testing.md §3). Since the per-workspace split the reference resolves
// against a caller-named root, so "which root" is part of the guard too.
// The filesystem half runs against the scratch app home the preload set
// (see notes.fs.test.ts for why the guard re-checks it).
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { APP_HOME, createManaged, loadWorkspaces } from "./workspaces";
import {
  assetsDirOf,
  assetPathOf,
  imageMimeOf,
  readAsset,
  savePastedImage,
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

// Not a real image; readAsset serves bytes by extension, which is the point —
// the guard is about which files may be read, not what is in them.
const BYTES = new Uint8Array([1, 2, 3, 4]);

describe("assetPathOf", () => {
  test("a note-relative image path resolves inside its workspace root", () => {
    expect(assetPathOf(ROOT, ".ledge-assets/x.png")).toBe(join(ROOT, ".ledge-assets", "x.png"));
  });

  test("an image sitting outside .ledge-assets/ but inside the root is allowed", () => {
    // Hand-managed images are the user's business; the root is the boundary.
    // An attached project's own visible assets/ folder is just such a folder.
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
    // The app's own assets dir is the ONE exception, and only as the first
    // segment: in-flight .asset.tmp files (and anything else dotted) inside
    // it stay unservable, and it earns no pass deeper in the path.
    expect(() => assetPathOf(ROOT, ".ledge-assets/.hidden.png")).toThrow();
    expect(() => assetPathOf(ROOT, "sub/.ledge-assets/x.png")).toThrow();
  });

  test("a non-image extension is rejected — this call must not read notes or config", () => {
    expect(() => assetPathOf(ROOT, "config.json")).toThrow();
    expect(() => assetPathOf(ROOT, "note.md")).toThrow();
    expect(() => assetPathOf(ROOT, ".ledge-assets/archive.zip")).toThrow();
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


// Narrow readAsset's union for the plain-bytes cases these tests assert on
// (the sealed face has its own describe below).
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
    // The whole reason assetRead carries a root: `.ledge-assets/x.png` is meaningful
    // only relative to the note that references it.
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

  test("leaves no temp droppings behind", async () => {
    await savePastedImage(ROOT, BYTES);
    const names = await readdir(ASSETS);
    expect(names.filter((n) => n.startsWith("."))).toEqual([]);
  });
});

// --- sealed images (locking.md §5) --------------------------------------
import { createNote, lockNote, removeLockNote } from "./notes";
import { createVault, isSealedAsset, lockVault, resetVaultForTests } from "./vault";
import { readFile as readRawFile } from "node:fs/promises";

describe("sealed images", () => {
  beforeEach(async () => {
    resetVaultForTests();
    await createVault("asset-pass");
  });

  test("a paste into a locked note is sealed from the first byte, and round-trips", async () => {
    const src = await savePastedImage(ROOT, BYTES, ".png", true);
    const onDisk = await readRawFile(join(ROOT, src));
    expect(isSealedAsset(onDisk)).toBe(true);
    expect(onDisk.includes(Buffer.from(BYTES))).toBe(false); // no plaintext run survives
    const got = await readAsset(ROOT, src);
    expect(new Uint8Array(Buffer.from(asBytes(got).dataB64, "base64"))).toEqual(BYTES);
    // Vault locked: the read says sealed — the widget's locked face, not
    // broken, and never the bytes.
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
    // A refusal would deadlock locking two notes that share an image (each
    // blocks on the other); sealing extends the lock's visibility rule to
    // the shared image, and sealedShared is what the UI says out loud.
    await mkdir(ASSETS, { recursive: true });
    await writeFile(join(ASSETS, "shared.png"), BYTES);
    await createNote(ROOT, "# Also Shows It\n\n![x](.ledge-assets/shared.png)\n");
    const note = await createNote(ROOT, "# Wants Lock\n\n![x](.ledge-assets/shared.png)\n");
    const res = await lockNote(note.path);
    expect(res.sealedShared).toEqual(['.ledge-assets/shared.png (also shown by "Also Shows It")']);
    expect(isSealedAsset(await readRawFile(join(ASSETS, "shared.png")))).toBe(true);
    // The sharing (still unlocked) note's read serves it sealed while the
    // vault is locked — the same face everywhere, which is the point.
    lockVault();
    expect(await readAsset(ROOT, ".ledge-assets/shared.png")).toEqual({ sealed: true });
  });

  test("an image another LOCKED note still shows stays sealed through Remove Lock", async () => {
    await mkdir(ASSETS, { recursive: true });
    await writeFile(join(ASSETS, "both.png"), BYTES);
    const a = await createNote(ROOT, "# First\n\n![x](.ledge-assets/both.png)\n");
    const b = await createNote(ROOT, "# Second\n\n![x](.ledge-assets/both.png)\n");
    await lockNote(a.path);
    await lockNote(b.path); // no conflict: locked claims agree
    await removeLockNote(a.path);
    // Second still claims it: sealed it stays.
    expect(isSealedAsset(await readRawFile(join(ASSETS, "both.png")))).toBe(true);
    await removeLockNote(b.path);
    expect(isSealedAsset(await readRawFile(join(ASSETS, "both.png")))).toBe(false);
  });
});
