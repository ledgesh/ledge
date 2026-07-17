// The layout file against a real filesystem: the write choreography and the
// JSON gate. The shape of the content is the view's business (workspace/
// persist.test.ts); these prove the bytes land atomically in the right dotted
// file and that garbage is refused rather than written into the app home.
//
// Same preload-scratch-home arrangement as notes.fs.test.ts, same guard: these
// tests wipe the app home in beforeEach, and wiping the wrong folder is the
// one mistake this file must be incapable of.
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { APP_HOME, createManaged, loadWorkspaces } from "./workspaces";
import { listNotes, writeNote, createNote } from "./notes";
import { LAYOUT_PATH, readLayout, writeLayout } from "./layout";

if (!resolve(APP_HOME).startsWith(resolve(tmpdir()) + sep)) {
  throw new Error(`refusing to run filesystem tests against ${APP_HOME} — is the preload configured?`);
}

let ROOT = "";

beforeEach(async () => {
  await rm(APP_HOME, { recursive: true, force: true });
  await mkdir(APP_HOME, { recursive: true });
  await loadWorkspaces();
  ROOT = await createManaged("Notes");
});

describe("readLayout / writeLayout", () => {
  test("a saved layout reads back byte-for-byte", async () => {
    const text = JSON.stringify({ version: 2, workspaces: [] });
    expect(await writeLayout(text)).toBe(true);
    expect(await readLayout()).toBe(text);
  });

  test("no layout file yet means null, not an error: a first launch boots fresh", async () => {
    expect(await readLayout()).toBeNull();
  });

  test("a save overwrites the previous layout, leaving no temp droppings behind", async () => {
    await writeLayout(JSON.stringify({ version: 2, n: 1 }));
    await writeLayout(JSON.stringify({ version: 2, n: 2 }));
    expect(await readLayout()).toBe(JSON.stringify({ version: 2, n: 2 }));
    const leftovers = (await readdir(APP_HOME)).filter((n) => n.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });

  test("non-JSON is refused and the existing layout is untouched", async () => {
    const good = JSON.stringify({ version: 2 });
    await writeLayout(good);
    expect(await writeLayout("rm -rf ~; not json")).toBe(false);
    expect(await readFile(LAYOUT_PATH, "utf8")).toBe(good);
  });

  test("the layout file lives in the app home, where no listNotes can see it", async () => {
    await writeLayout(JSON.stringify({ version: 2 }));
    await createNote(ROOT, "# A note\n");
    const notes = await listNotes(ROOT);
    expect(notes.length).toBe(1);
    expect(notes[0].path.endsWith(".md")).toBe(true);
  });

  test("no noteWrite can clobber the layout file: the app home is outside every root", async () => {
    // Belt and braces on the §3 invariant this file leans on. The refusal
    // reason changed with the per-workspace split (the path used to fail the
    // .md check; now it fails root membership first), but the invariant is
    // the same: this write cannot happen.
    await expect(writeNote(LAYOUT_PATH, "clobber")).rejects.toThrow(/outside every workspace root/);
  });
});
