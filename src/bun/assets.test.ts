// The asset guard and the save/read choreography. assetPathOf is the whole
// safety story for assetRead — the one RPC that takes a view-supplied
// relative path — so its refusals get named tests the way assertTrashed's do
// (docs/testing.md §3). The filesystem half runs against the scratch root the
// preload set (see notes.fs.test.ts for why the guard re-checks it).
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { NOTES_ROOT } from "./notes";
import {
  ASSETS_DIR,
  assetPathOf,
  imageMimeOf,
  readAsset,
  savePastedImage,
} from "./assets";

if (!resolve(NOTES_ROOT).startsWith(resolve(tmpdir()) + sep)) {
  throw new Error(`refusing to run filesystem tests against ${NOTES_ROOT} — is the preload configured?`);
}

beforeEach(async () => {
  await rm(NOTES_ROOT, { recursive: true, force: true });
  await mkdir(ASSETS_DIR, { recursive: true });
});

// Not a real image; readAsset serves bytes by extension, which is the point —
// the guard is about which files may be read, not what is in them.
const BYTES = new Uint8Array([1, 2, 3, 4]);

describe("assetPathOf", () => {
  test("a note-relative image path resolves inside the root", () => {
    expect(assetPathOf("assets/x.png")).toBe(join(resolve(NOTES_ROOT), "assets", "x.png"));
  });

  test("an image sitting outside assets/ but inside the root is allowed", () => {
    // Hand-managed images are the user's business; the root is the boundary.
    expect(assetPathOf("pics/x.jpeg")).toBe(join(resolve(NOTES_ROOT), "pics", "x.jpeg"));
  });

  test("a traversal out of the root is rejected", () => {
    expect(() => assetPathOf("../outside.png")).toThrow();
    expect(() => assetPathOf("assets/../../outside.png")).toThrow();
  });

  test("an absolute path is rejected", () => {
    expect(() => assetPathOf("/etc/passwd.png")).toThrow();
  });

  test("a dot-entry anywhere in the path is rejected — invisible stays unservable", () => {
    expect(() => assetPathOf(".trash/x.png")).toThrow();
    expect(() => assetPathOf("assets/.hidden.png")).toThrow();
  });

  test("a non-image extension is rejected — this call must not read notes or settings", () => {
    expect(() => assetPathOf("settings.json")).toThrow();
    expect(() => assetPathOf("note.md")).toThrow();
    expect(() => assetPathOf("assets/archive.zip")).toThrow();
  });

  test("backslashes are rejected rather than interpreted", () => {
    expect(() => assetPathOf("assets\\x.png")).toThrow();
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

describe("readAsset", () => {
  test("serves the bytes and mime of an existing asset", async () => {
    await writeFile(join(ASSETS_DIR, "x.png"), BYTES);
    const got = await readAsset("assets/x.png");
    expect(got).not.toBeNull();
    expect(got!.mime).toBe("image/png");
    expect(new Uint8Array(Buffer.from(got!.dataB64, "base64"))).toEqual(BYTES);
  });

  test("a missing file is null, not an error — the widget shows a placeholder", async () => {
    expect(await readAsset("assets/gone.png")).toBeNull();
  });

  test("a guarded path still throws — missing and forbidden are different answers", async () => {
    await expect(readAsset("../outside.png")).rejects.toThrow();
  });
});

describe("savePastedImage", () => {
  test("writes under assets/ and returns the markdown-relative reference", async () => {
    const src = await savePastedImage(BYTES);
    expect(src).toMatch(/^assets\/pasted-\d{4}-\d{2}-\d{2}\.png$/);
    const got = await readAsset(src);
    expect(new Uint8Array(Buffer.from(got!.dataB64, "base64"))).toEqual(BYTES);
  });

  test("a second paste the same day enumerates instead of clobbering", async () => {
    const a = await savePastedImage(BYTES);
    const b = await savePastedImage(new Uint8Array([9, 9]));
    expect(b).not.toBe(a);
    const got = await readAsset(a);
    expect(new Uint8Array(Buffer.from(got!.dataB64, "base64"))).toEqual(BYTES);
  });

  test("leaves no temp droppings behind", async () => {
    await savePastedImage(BYTES);
    const names = await readdir(ASSETS_DIR);
    expect(names.filter((n) => n.startsWith("."))).toEqual([]);
  });
});
