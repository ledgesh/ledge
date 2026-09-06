// The layout file against a real filesystem: the write choreography, the JSON
// gate, and the keying by client (remote.md §5). These tests check that the
// bytes land atomically in the right dotted file, that each client reads back
// its own arrangement, and that non-JSON is refused rather than written into
// the app home. The shape of the content belongs to the view, which owns it in
// workspace/persist.ts and tests it in workspace/persist.test.ts, so nothing
// here asserts on it.
//
// The app home is a per-run temp dir, set by src/test-preload.ts before any
// module loads, the same arrangement notes.fs.test.ts uses. The guard below
// re-checks that, because beforeEach wipes the app home and must never wipe
// the wrong folder.
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { APP_HOME, createManaged, loadWorkspaces } from "./workspaces";
import { listNotes, writeNote, createNote } from "./notes";
import { LAYOUT_PATH, readLayout, writeLayout } from "./layout";

if (!resolve(APP_HOME).startsWith(resolve(tmpdir()) + sep)) {
  throw new Error(`refusing to run filesystem tests against ${APP_HOME} — is the preload configured?`);
}

// Two clients of the same server: this Mac and, say, a phone.
const MAC = "11111111-2222-3333-4444-555555555555";
const PHONE = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

let ROOT = "";

beforeEach(async () => {
  await rm(APP_HOME, { recursive: true, force: true });
  await mkdir(APP_HOME, { recursive: true });
  await loadWorkspaces();
  ROOT = await createManaged("Notes");
});

describe("readLayout / writeLayout", () => {
  test("a saved layout reads back", async () => {
    const text = JSON.stringify({ version: 2, workspaces: [] });
    expect(await writeLayout(MAC, text)).toBe(true);
    expect(await readLayout(MAC)).toBe(text);
  });

  test("no layout file yet means null, not an error: a first launch boots fresh", async () => {
    expect(await readLayout(MAC)).toBeNull();
  });

  test("a save overwrites the previous layout, leaving no temp droppings behind", async () => {
    await writeLayout(MAC, JSON.stringify({ version: 2, n: 1 }));
    await writeLayout(MAC, JSON.stringify({ version: 2, n: 2 }));
    expect(await readLayout(MAC)).toBe(JSON.stringify({ version: 2, n: 2 }));
    const leftovers = (await readdir(APP_HOME)).filter((n) => n.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });

  test("non-JSON is refused and the existing layout is untouched", async () => {
    const good = JSON.stringify({ version: 2 });
    await writeLayout(MAC, good);
    const before = await readFile(LAYOUT_PATH, "utf8");
    expect(await writeLayout(MAC, "rm -rf ~; not json")).toBe(false);
    expect(await readFile(LAYOUT_PATH, "utf8")).toBe(before);
  });

  test("the layout file lives in the app home, where no listNotes can see it", async () => {
    await writeLayout(MAC, JSON.stringify({ version: 2 }));
    await createNote(ROOT, "# A note\n");
    const notes = await listNotes(ROOT);
    expect(notes.length).toBe(1);
    expect(notes[0]!.path.endsWith(".md")).toBe(true);
  });

  test("no noteWrite can clobber the layout file: the app home is outside every root", async () => {
    // This test re-checks the trust-boundary invariant the file leans on
    // (architecture.md §2): the app home is outside every workspace root, and
    // assertNote refuses a path outside one. The refusal reason changed with
    // the per-workspace split: the path used to fail the .md check, and now it
    // fails root membership first. Either way the write cannot happen.
    await expect(writeNote(LAYOUT_PATH, "clobber")).rejects.toThrow(/outside every workspace root/);
  });
});

// One server can be looked at from two screens, and keying by client gives
// each screen its own arrangement. It keeps a phone from opening a desktop's
// three-pane split, and keeps the desktop's own arrangement from being
// overwritten when the phone saves.
describe("two clients of one server", () => {
  test("each gets its own arrangement back", async () => {
    await writeLayout(MAC, JSON.stringify({ version: 2, panes: 3 }));
    await writeLayout(PHONE, JSON.stringify({ version: 2, panes: 1 }));
    expect(await readLayout(MAC)).toBe(JSON.stringify({ version: 2, panes: 3 }));
    expect(await readLayout(PHONE)).toBe(JSON.stringify({ version: 2, panes: 1 }));
  });

  test("a client that has never connected has no layout, and does not get someone else's", async () => {
    await writeLayout(MAC, JSON.stringify({ version: 2, panes: 3 }));
    expect(await readLayout(PHONE)).toBeNull();
  });

  test("a save by one does not disturb the other", async () => {
    await writeLayout(MAC, JSON.stringify({ version: 2, panes: 3 }));
    await writeLayout(PHONE, JSON.stringify({ version: 2, panes: 1 }));
    await writeLayout(PHONE, JSON.stringify({ version: 2, panes: 2 }));
    expect(await readLayout(MAC)).toBe(JSON.stringify({ version: 2, panes: 3 }));
  });

  // The id becomes a key in the layout file, so layout.ts validates it rather
  // than trusting it (architecture.md §2). Anything that is not a plain id
  // shares the anonymous bucket "_". A client with no usable id still finds
  // its tabs where it left them, and the cost is that two such clients share
  // one arrangement.
  test.each([["", "no id at all"], ["../../etc/passwd", "a path"], ["a b", "a space"]])(
    "%p (%s) shares the anonymous bucket rather than becoming a key",
    async (id) => {
      await writeLayout(id, JSON.stringify({ version: 2, panes: 9 }));
      expect(await readLayout(id)).toBe(JSON.stringify({ version: 2, panes: 9 }));
      const file = JSON.parse(await readFile(LAYOUT_PATH, "utf8")) as Record<string, unknown>;
      expect(Object.keys(file)).toEqual(["_"]);
    },
  );
});

// An install that predates the keying has one arrangement saved and one
// client asking for it. Adopting it keeps the upgrade from losing every tab
// and split.
describe("a layout saved before it was keyed by client", () => {
  const OLD = JSON.stringify({ version: 2, workspaces: [{ name: "Notes" }] });

  test("is adopted by the client that asks for it", async () => {
    await writeFile(LAYOUT_PATH, OLD);
    expect(await readLayout(MAC)).toBe(OLD);
  });

  test("is replaced by a keyed file at the first save, not kept alongside it", async () => {
    await writeFile(LAYOUT_PATH, OLD);
    await readLayout(MAC);
    await writeLayout(MAC, JSON.stringify({ version: 2, panes: 3 }));
    const file = JSON.parse(await readFile(LAYOUT_PATH, "utf8")) as Record<string, unknown>;
    expect(Object.keys(file)).toEqual([MAC]);
    // The second client to arrive boots fresh rather than adopting the first
    // client's tabs.
    expect(await readLayout(PHONE)).toBeNull();
  });
});
