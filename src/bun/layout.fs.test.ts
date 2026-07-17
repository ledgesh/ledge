// The layout file against a real filesystem: the write choreography and the
// JSON gate. The shape of the content is the view's business (workspace/
// persist.test.ts); these prove the bytes land atomically in the right dotted
// file and that garbage is refused rather than written into the notes root.
//
// Same preload-scratch-root arrangement as notes.fs.test.ts, same guard: these
// tests wipe their root in beforeEach, and wiping the wrong root is the one
// mistake this file must be incapable of.
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { NOTES_ROOT, listNotes, writeNote, createNote } from "./notes";
import { LAYOUT_PATH, readLayout, writeLayout } from "./layout";

if (!resolve(NOTES_ROOT).startsWith(resolve(tmpdir()) + sep)) {
  throw new Error(`refusing to run filesystem tests against ${NOTES_ROOT} — is the preload configured?`);
}

beforeEach(async () => {
  await rm(NOTES_ROOT, { recursive: true, force: true });
  await mkdir(NOTES_ROOT, { recursive: true });
});

describe("readLayout / writeLayout", () => {
  test("a saved layout reads back byte-for-byte", async () => {
    const text = JSON.stringify({ version: 1, workspaces: [] });
    expect(await writeLayout(text)).toBe(true);
    expect(await readLayout()).toBe(text);
  });

  test("no layout file yet means null, not an error: a first launch boots fresh", async () => {
    expect(await readLayout()).toBeNull();
  });

  test("a save overwrites the previous layout, leaving no temp droppings behind", async () => {
    await writeLayout(JSON.stringify({ version: 1, n: 1 }));
    await writeLayout(JSON.stringify({ version: 1, n: 2 }));
    expect(await readLayout()).toBe(JSON.stringify({ version: 1, n: 2 }));
    const leftovers = (await readdir(NOTES_ROOT)).filter((n) => n.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });

  test("non-JSON is refused and the existing layout is untouched", async () => {
    const good = JSON.stringify({ version: 1 });
    await writeLayout(good);
    expect(await writeLayout("rm -rf ~; not json")).toBe(false);
    expect(await readFile(LAYOUT_PATH, "utf8")).toBe(good);
  });

  test("the layout file is a dot-entry: listNotes never shows it", async () => {
    await writeLayout(JSON.stringify({ version: 1 }));
    await createNote("# A note\n");
    const notes = await listNotes();
    expect(notes.length).toBe(1);
    expect(notes[0].path.endsWith(".md")).toBe(true);
  });

  test("a note named like the layout file cannot exist: assertNote requires .md", async () => {
    // Belt and braces on the §3 invariant this file leans on: no noteWrite can
    // ever clobber .layout.json, because the path fails the note guard.
    await expect(writeNote(LAYOUT_PATH, "clobber")).rejects.toThrow(/not a note path/);
  });
});
