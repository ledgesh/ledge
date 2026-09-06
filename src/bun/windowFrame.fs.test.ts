// The window list against a real filesystem. windowFrame.test.ts covers the
// geometry; the tests here check that the bytes land in the client home's
// file, that a corrupt file boots at the default frame instead of throwing on
// the launch path, and that listNotes never sees it.
//
// The file is client-side because a window's position is a fact about this
// screen, not about the server holding the notes (remote.md §5). Same preload
// scratch home and same guard as layout.fs.test.ts.
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { APP_HOME, createManaged, loadWorkspaces } from "./workspaces";
import { CLIENT_HOME, ensureClientHomeSync } from "./clientHome";
import { LOCAL_ID } from "./connections";
import { createNote, listNotes } from "./notes";
import { LEGACY_WINDOW_PATH, WINDOW_PATH, readWindows, writeWindows, type WindowState } from "./windowFrame";

if (!resolve(APP_HOME).startsWith(resolve(tmpdir()) + sep)) {
  throw new Error(`refusing to run filesystem tests against ${APP_HOME} — is the preload configured?`);
}

let ROOT = "";

const one = (x: number, connection = LOCAL_ID): WindowState => ({
  frame: { x, y: x, width: 900, height: 700 },
  connection,
});

beforeEach(async () => {
  await rm(APP_HOME, { recursive: true, force: true });
  await mkdir(APP_HOME, { recursive: true });
  await loadWorkspaces();
  ROOT = await createManaged("Notes");
});

describe("readWindows / writeWindows", () => {
  test("a saved window reads back, connection included", () => {
    writeWindows([{ frame: { x: 12, y: 34, width: 1024, height: 768 }, connection: "vps-1" }]);
    expect(readWindows(LOCAL_ID)).toEqual([{ frame: { x: 12, y: 34, width: 1024, height: 768 }, connection: "vps-1" }]);
  });

  // Windows read back in the order they were written, each keeping the
  // connection it was saved with. A window is a client, so the file holds one
  // entry per window (remote.md §8a).
  test("several windows keep their order and their servers", () => {
    writeWindows([one(1, LOCAL_ID), one(2, "vps-1"), one(3, "laptop-1")]);
    expect(readWindows(LOCAL_ID).map((w) => w.connection)).toEqual([LOCAL_ID, "vps-1", "laptop-1"]);
  });

  test("no window file yet means no windows: a first launch takes the default", () => {
    expect(readWindows(LOCAL_ID)).toEqual([]);
  });

  test("a save overwrites the last one and leaves no temp droppings", async () => {
    writeWindows([one(1)]);
    writeWindows([one(2)]);
    expect(readWindows(LOCAL_ID)).toEqual([one(2)]);
    expect((await readdir(CLIENT_HOME)).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });

  // readWindows runs before any window exists (index.ts), so a throw here is a
  // launch that draws nothing. Unreadable bytes read back as an empty list.
  // index.ts turns that into one window at the default frame.
  test("a corrupt file is an empty list, not a throw", async () => {
    ensureClientHomeSync();
    await writeFile(WINDOW_PATH, "{ half a wri", "utf8");
    expect(readWindows(LOCAL_ID)).toEqual([]);
  });

  // An entry with no connection string is still a window. Its connection
  // becomes the fallback argument readWindows was called with. index.ts
  // passes the stored launch selection there.
  test("an entry with no connection falls back to the launch selection", async () => {
    ensureClientHomeSync();
    await writeFile(WINDOW_PATH, JSON.stringify({ version: 2, windows: [{ x: 1, y: 1, width: 900, height: 700 }] }), "utf8");
    expect(readWindows("vps-1")).toEqual([{ frame: { x: 1, y: 1, width: 900, height: 700 }, connection: "vps-1" }]);
  });

  // Before there could be more than one window, the file held one bare frame
  // and no connection. The stored selection is the only record of where that
  // window pointed (connectionStore.ts launchSelection).
  test("the single frame an older install saved becomes one window on the stored selection", async () => {
    ensureClientHomeSync();
    await writeFile(WINDOW_PATH, JSON.stringify({ x: 7, y: 8, width: 800, height: 600 }), "utf8");
    expect(readWindows("vps-1")).toEqual([{ frame: { x: 7, y: 8, width: 800, height: 600 }, connection: "vps-1" }]);
  });

  // A read that finds nothing at WINDOW_PATH renames the app-home file into
  // the client home, so an existing install keeps its window position. It
  // renames rather than copies, leaving one file with that position. Two
  // files would let the next save update one of them, and the launch after
  // that could read either.
  test("an app-home window file from before the client home is moved across", async () => {
    await writeFile(LEGACY_WINDOW_PATH, JSON.stringify({ x: 7, y: 8, width: 800, height: 600 }), "utf8");
    expect(readWindows(LOCAL_ID)).toEqual([{ frame: { x: 7, y: 8, width: 800, height: 600 }, connection: LOCAL_ID }]);
    expect((await readdir(APP_HOME)).includes(".window.json")).toBe(false);
    expect((await readdir(CLIENT_HOME)).includes("window.json")).toBe(true);
  });

  test("the window file lives in the client home, where no listNotes can see it", async () => {
    writeWindows([one(1)]);
    await createNote(ROOT, "# A note\n");
    const notes = await listNotes(ROOT);
    expect(notes.length).toBe(1);
    expect(notes[0]!.path.endsWith(".md")).toBe(true);
  });
});
