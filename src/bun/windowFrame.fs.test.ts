// The window frame against a real filesystem. The geometry is proved in
// windowFrame.test.ts; this proves the bytes land in the CLIENT home's file
// (remote.md §5 — a window's position is a fact about this screen, not about
// the machine holding the notes), that a corrupt one degrades to "boot at the
// default" instead of throwing on the launch path, and that no listNotes can
// see it.
//
// Same preload-scratch-home arrangement and same guard as layout.fs.test.ts.
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { APP_HOME, createManaged, loadWorkspaces } from "./workspaces";
import { CLIENT_HOME, ensureClientHomeSync } from "./clientHome";
import { createNote, listNotes } from "./notes";
import { LEGACY_WINDOW_PATH, WINDOW_PATH, readFrame, writeFrame } from "./windowFrame";

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

describe("readFrame / writeFrame", () => {
  test("a saved frame reads back", () => {
    writeFrame({ x: 12, y: 34, width: 1024, height: 768 });
    expect(readFrame()).toEqual({ x: 12, y: 34, width: 1024, height: 768 });
  });

  test("no window file yet means null: a first launch takes the default", () => {
    expect(readFrame()).toBeNull();
  });

  test("a save overwrites the last one and leaves no temp droppings", async () => {
    writeFrame({ x: 1, y: 1, width: 900, height: 700 });
    writeFrame({ x: 2, y: 2, width: 901, height: 701 });
    expect(readFrame()).toEqual({ x: 2, y: 2, width: 901, height: 701 });
    expect((await readdir(CLIENT_HOME)).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });

  // This runs before the window exists, so a throw here is a launch that never
  // draws anything. It has to be a null, always.
  test("a corrupt file is a null, not a throw", async () => {
    ensureClientHomeSync();
    await writeFile(WINDOW_PATH, "{ half a wri", "utf8");
    expect(readFrame()).toBeNull();
  });

  // The move into the client home has to carry an existing install's window
  // position with it, and has to leave one file behind, not two: a copy would
  // mean the next save updates one of them and the launch after that could
  // read either.
  test("an app-home window file from before the client home is moved across", async () => {
    await writeFile(LEGACY_WINDOW_PATH, JSON.stringify({ x: 7, y: 8, width: 800, height: 600 }), "utf8");
    expect(readFrame()).toEqual({ x: 7, y: 8, width: 800, height: 600 });
    expect((await readdir(APP_HOME)).includes(".window.json")).toBe(false);
    expect((await readdir(CLIENT_HOME)).includes("window.json")).toBe(true);
  });

  test("the window file lives in the client home, where no listNotes can see it", async () => {
    writeFrame({ x: 1, y: 1, width: 900, height: 700 });
    await createNote(ROOT, "# A note\n");
    const notes = await listNotes(ROOT);
    expect(notes.length).toBe(1);
    expect(notes[0]!.path.endsWith(".md")).toBe(true);
  });
});
