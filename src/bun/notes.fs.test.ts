// The note store against a real filesystem — the layer notes.test.ts leaves
// out. These exercise the rename choreography (retitle's self-rename, trash
// round-trips, restore-into-a-taken-name) and the unlink paths on actual
// files, because the pure tests can prove the name allocation right and still
// miss a rename pointed at the wrong place.
//
// The root is a per-run temp dir, set by src/test-preload.ts before any module
// loaded (see bunfig.toml). The guard below re-checks that: these tests wipe
// their root in beforeEach, and wiping the wrong root is the one mistake this
// file must be incapable of.
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  NOTES_ROOT,
  TRASH_DIR,
  createNote,
  deleteNote,
  deleteTrashed,
  emptyTrash,
  listNotes,
  listTrash,
  purgeTrash,
  readNote,
  restoreNote,
  retitleNote,
  searchNotes,
  writeNote,
} from "./notes";

if (!resolve(NOTES_ROOT).startsWith(resolve(tmpdir()) + sep)) {
  throw new Error(`refusing to run filesystem tests against ${NOTES_ROOT} — is the preload configured?`);
}

beforeEach(async () => {
  await rm(NOTES_ROOT, { recursive: true, force: true });
  await mkdir(NOTES_ROOT, { recursive: true });
});

describe("createNote / writeNote / readNote", () => {
  test("names the file from the note's H1 and round-trips its text", async () => {
    const note = await createNote("# Shipping Notes\n\nhello");
    expect(note.path).toBe(join(NOTES_ROOT, "shipping-notes.md"));
    expect(note.title).toBe("Shipping Notes");
    expect(await readNote(note.path)).toBe("# Shipping Notes\n\nhello");
  });

  test("a second note with the same heading enumerates instead of clobbering", async () => {
    const a = await createNote("# Plan\n\none");
    const b = await createNote("# Plan\n\ntwo");
    expect(a.path).not.toBe(b.path);
    expect(b.path).toBe(join(NOTES_ROOT, "plan-2.md"));
    expect(await readNote(a.path)).toBe("# Plan\n\none");
  });

  test("a save leaves no temp file behind for listNotes to show", async () => {
    const note = await createNote("# One\n");
    await writeNote(note.path, "# One\n\nedited");
    expect(await readdir(NOTES_ROOT)).toEqual(["one.md"]);
  });

  test("reading a note that is gone is null, not a throw", async () => {
    expect(await readNote(join(NOTES_ROOT, "never-existed.md"))).toBeNull();
  });

  test("writing outside the root is refused", async () => {
    await expect(writeNote(join(NOTES_ROOT, "..", "escape.md"), "x")).rejects.toThrow(/outside the notes root/);
  });

  test("non-.md paths in the root are refused: settings.json is not a note", async () => {
    // The escalation this blocks: settings.json names the shell executable, so
    // a noteWrite that reached it would be command execution at next launch.
    const path = join(NOTES_ROOT, "settings.json");
    await expect(writeNote(path, '{"shell":{"path":"/tmp/evil"}}')).rejects.toThrow(/not a note path/);
    await expect(readNote(path)).rejects.toThrow(/not a note path/);
    await expect(retitleNote(path, "# X\n")).rejects.toThrow(/not a note path/);
    await expect(deleteNote(path)).rejects.toThrow(/not a note path/);
  });
});

describe("listNotes", () => {
  test("newest first, by mtime", async () => {
    const old = await createNote("# Old\n");
    await createNote("# New\n");
    // Backdate rather than sleep: utimes sets the mtime listNotes sorts by.
    await utimes(old.path, new Date(0), new Date(0));
    expect((await listNotes()).map((n) => n.title)).toEqual(["New", "Old"]);
  });

  test("dot-entries stay invisible", async () => {
    await createNote("# Visible\n");
    await mkdir(TRASH_DIR, { recursive: true });
    await writeFile(join(TRASH_DIR, "deleted.md"), "# Deleted\n");
    await writeFile(join(NOTES_ROOT, ".stray.md"), "# Stray\n");
    expect((await listNotes()).map((n) => n.title)).toEqual(["Visible"]);
  });
});

describe("searchNotes", () => {
  test("finds a match in any note's body and says where it sits", async () => {
    await createNote("# Recipes\n\nbring the stock to a boil\n");
    await createNote("# Plans\n\nnothing to see\n");
    const hits = await searchNotes("STOCK");
    expect(hits).toEqual([
      {
        path: join(NOTES_ROOT, "recipes.md"),
        title: "Recipes",
        mtimeMs: expect.any(Number),
        line: 3,
        snippet: "bring the stock to a boil",
        col: "bring the ".length,
      },
    ]);
  });

  test("hits arrive newest note first, the order listNotes shows", async () => {
    const old = await createNote("# Old\n\nshared term\n");
    await createNote("# New\n\nshared term\n");
    await utimes(old.path, new Date(0), new Date(0));
    expect((await searchNotes("shared term")).map((h) => h.title)).toEqual(["New", "Old"]);
  });

  test("what is invisible to listNotes is invisible to search: trash and dot-entries", async () => {
    await deleteNote((await createNote("# Deleted\n\nsecret needle\n")).path);
    await writeFile(join(NOTES_ROOT, ".stray.md"), "secret needle\n");
    expect(await searchNotes("secret needle")).toEqual([]);
  });

  test("an empty query matches nothing, not every line of every note", async () => {
    await createNote("# Something\n\nbody\n");
    expect(await searchNotes("")).toEqual([]);
    expect(await searchNotes("   ")).toEqual([]);
  });
});

describe("retitleNote", () => {
  test("moves the file to match its heading", async () => {
    const note = await createNote("# Draft\n");
    const moved = await retitleNote(note.path, "# Final\n");
    expect(moved.path).toBe(join(NOTES_ROOT, "final.md"));
    expect(await readNote(moved.path)).toBe("# Draft\n"); // retitle moves, it does not save
    expect(await readdir(NOTES_ROOT)).toEqual(["final.md"]);
  });

  test("a note's own name is not an obstacle to itself: retitling to the same heading stays put", async () => {
    const note = await createNote("# Keep\n");
    const again = await retitleNote(note.path, "# Keep\n\nmore text");
    expect(again.path).toBe(note.path);
    expect(await readdir(NOTES_ROOT)).toEqual(["keep.md"]);
  });

  test("retitling into another note's name enumerates instead of clobbering it", async () => {
    const other = await createNote("# Target\n\ntheirs");
    const note = await createNote("# Source\n\nmine");
    const moved = await retitleNote(note.path, "# Target\n\nmine");
    expect(moved.path).toBe(join(NOTES_ROOT, "target-2.md"));
    expect(await readNote(other.path)).toBe("# Target\n\ntheirs");
  });
});

describe("trash round-trip", () => {
  test("delete moves the note into the trash; the lists swap accordingly", async () => {
    const note = await createNote("# Doomed\n\nbody");
    const trashed = (await deleteNote(note.path))!;
    expect(trashed).toBe(join(TRASH_DIR, "doomed.md"));
    expect(await listNotes()).toEqual([]);
    expect((await listTrash()).map((t) => t.path)).toEqual([trashed]);
    expect(await readNote(trashed)).toBe("# Doomed\n\nbody"); // bytes intact, only moved
  });

  test("deleting what is already trashed (or already gone) is null, not a second move", async () => {
    const note = await createNote("# Once\n");
    const trashed = await deleteNote(note.path);
    expect(await deleteNote(trashed!)).toBeNull();
    expect(await deleteNote(note.path)).toBeNull(); // the original path is empty now
  });

  test("restore brings the note back; a taken name enumerates rather than clobbers", async () => {
    const note = await createNote("# Twice\n\noriginal");
    const trashed = await deleteNote(note.path);
    await createNote("# Twice\n\nusurper"); // takes twice.md while the original sits in the trash
    const restored = await restoreNote(trashed!);
    expect(restored.path).toBe(join(NOTES_ROOT, "twice-2.md"));
    expect(await readNote(restored.path)).toBe("# Twice\n\noriginal");
    expect(await readNote(join(NOTES_ROOT, "twice.md"))).toBe("# Twice\n\nusurper");
  });
});

describe("the unlink paths", () => {
  test("deleteTrashed removes the file for good; a second call reports it already gone", async () => {
    const trashed = (await deleteNote((await createNote("# Gone\n")).path))!;
    expect(await deleteTrashed(trashed)).toBe(true);
    await expect(stat(trashed)).rejects.toThrow();
    expect(await deleteTrashed(trashed)).toBe(false);
  });

  test("emptyTrash removes exactly what listTrash showed, and nothing it did not", async () => {
    await deleteNote((await createNote("# A\n")).path);
    await deleteNote((await createNote("# B\n")).path);
    // Things that arrived in the trash folder by some route other than a
    // delete: a stray non-md file and a subdirectory. Both must survive.
    await writeFile(join(TRASH_DIR, "not-a-note.txt"), "keep me");
    await mkdir(join(TRASH_DIR, "subdir"), { recursive: true });
    expect(await emptyTrash()).toBe(2);
    expect((await readdir(TRASH_DIR)).sort()).toEqual(["not-a-note.txt", "subdir"]);
  });

  test("purgeTrash evicts by age and keeps the young", async () => {
    await deleteNote((await createNote("# Fresh\n")).path);
    expect(await purgeTrash(60_000)).toBe(0); // a minute old it is not
    expect((await listTrash()).length).toBe(1);
    // A negative TTL puts the cutoff in the future, so "older than the cutoff"
    // is true of a file trashed just now — age without waiting (ctime cannot
    // be backdated; that immutability is why listTrash trusts it).
    expect(await purgeTrash(-60_000)).toBe(1);
    expect(await listTrash()).toEqual([]);
  });
});
