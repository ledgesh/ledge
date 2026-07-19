// The note store against a real filesystem — the layer notes.test.ts leaves
// out. These exercise the rename choreography (retitle's self-rename, trash
// round-trips, restore-into-a-taken-name), the unlink paths, and — since the
// per-workspace split — the multi-root guards: which of two registered roots
// a path belongs to is now part of every operation's safety story.
//
// The app home is a per-run temp dir, set by src/test-preload.ts before any
// module loaded (see bunfig.toml). The guard below re-checks that: these tests
// wipe the app home in beforeEach, and wiping the wrong folder is the one
// mistake this file must be incapable of.
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile as readRaw, rm, stat, utimes, writeFile, writeFile as writeRaw } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { APP_HOME, attachExternal, createManaged, loadWorkspaces } from "./workspaces";
import {
  backlinksTo,
  createNote,
  deleteNote,
  deleteTrashed,
  emptyTrash,
  isNoteLocked,
  listNotes,
  listTrash,
  lockNote,
  notesTagged,
  purgeTrash,
  readNote,
  removeLockNote,
  restoreNote,
  retitleNote,
  searchNotes,
  tagsIn,
  trashDirOf,
  writeNote,
} from "./notes";
import { createVault, lockVault, resetVaultForTests } from "./vault";

if (!resolve(APP_HOME).startsWith(resolve(tmpdir()) + sep)) {
  throw new Error(`refusing to run filesystem tests against ${APP_HOME} — is the preload configured?`);
}

let ROOT = ""; // the default workspace root every test gets
let TRASH = ""; // its trash

// readNote returns {text, mtimeMs}; most assertions here only care about the
// bytes. null stays null so the gone-note cases read the same.
async function textAt(path: string): Promise<string | null> {
  return (await readNote(path))?.text ?? null;
}

// A second root, for the cross-workspace cases. Managed for convenience; the
// guards make no managed/external distinction beyond mkdir self-healing.
async function secondRoot(): Promise<string> {
  return createManaged("Other");
}

beforeEach(async () => {
  await rm(APP_HOME, { recursive: true, force: true });
  await mkdir(APP_HOME, { recursive: true });
  await loadWorkspaces();
  ROOT = await createManaged("Notes");
  TRASH = trashDirOf(ROOT);
});

describe("createNote / writeNote / readNote", () => {
  test("names the file from the note's H1 and round-trips its text", async () => {
    const note = await createNote(ROOT, "# Shipping Notes\n\nhello");
    expect(note.path).toBe(join(ROOT, "shipping-notes.md"));
    expect(note.title).toBe("Shipping Notes");
    expect(await textAt(note.path)).toBe("# Shipping Notes\n\nhello");
  });

  test("a second note with the same heading enumerates instead of clobbering", async () => {
    const a = await createNote(ROOT, "# Plan\n\none");
    const b = await createNote(ROOT, "# Plan\n\ntwo");
    expect(a.path).not.toBe(b.path);
    expect(b.path).toBe(join(ROOT, "plan-2.md"));
    expect(await textAt(a.path)).toBe("# Plan\n\none");
  });

  test("the same heading in two workspaces is two plain names — reservations are per folder", async () => {
    // A shared reservation set would enumerate one of these to plan-2.md for
    // no reason: the two files can never collide.
    const other = await secondRoot();
    const [a, b] = await Promise.all([createNote(ROOT, "# Plan\n"), createNote(other, "# Plan\n")]);
    expect(a.path).toBe(join(ROOT, "plan.md"));
    expect(b.path).toBe(join(other, "plan.md"));
  });

  test("a save leaves no temp file behind for listNotes to show", async () => {
    const note = await createNote(ROOT, "# One\n");
    await writeNote(note.path, "# One\n\nedited");
    expect(await readdir(ROOT)).toEqual(["one.md"]);
  });

  test("reading a note that is gone is null, not a throw", async () => {
    expect(await readNote(join(ROOT, "never-existed.md"))).toBeNull();
  });

  test("a path outside every registered root is refused", async () => {
    await expect(writeNote(join(ROOT, "..", "escape.md"), "x")).rejects.toThrow(/outside every workspace root/);
    await expect(writeNote("/etc/notes.md", "x")).rejects.toThrow(/outside every workspace root/);
  });

  test("a note in either of two registered roots is accepted; an unregistered sibling is not", async () => {
    const other = await secondRoot();
    await writeNote(join(ROOT, "a.md"), "# A\n");
    await writeNote(join(other, "b.md"), "# B\n");
    const stranger = join(APP_HOME, "unregistered");
    await mkdir(stranger);
    await expect(writeNote(join(stranger, "c.md"), "# C\n")).rejects.toThrow(/outside every workspace root/);
  });

  test("the app home's own files are unreachable: they are outside every root", async () => {
    // The escalation this blocks: settings.jsonc names the shell executable, so
    // a noteWrite that reached it would be command execution at next launch.
    const path = join(APP_HOME, "settings.jsonc");
    await expect(writeNote(path, '{"shell":{"path":"/tmp/evil"}}')).rejects.toThrow(/outside every workspace root/);
    await expect(readNote(path)).rejects.toThrow(/outside every workspace root/);
  });

  test("non-.md paths inside a root are refused: in-root is not enough", async () => {
    const path = join(ROOT, "config.json");
    await expect(writeNote(path, "{}")).rejects.toThrow(/not a note path/);
    await expect(readNote(path)).rejects.toThrow(/not a note path/);
    await expect(retitleNote(path, "# X\n")).rejects.toThrow(/not a note path/);
    await expect(deleteNote(path)).rejects.toThrow(/not a note path/);
  });

  test("a missing external root refuses writes rather than growing a shadow folder", async () => {
    // The unmounted-volume case: mkdir-ing the path would catch autosaves in a
    // folder on the boot disk that the remounted volume then hides.
    const dir = await mkdtemp(join(tmpdir(), "ledge-ext-"));
    await attachExternal(dir);
    const note = await createNote(dir, "# On the volume\n");
    await rm(dir, { recursive: true });
    await expect(writeNote(note.path, "# edited\n")).rejects.toThrow(/not on disk/);
    await expect(createNote(dir, "# Another\n")).rejects.toThrow(/not on disk/);
    expect(await stat(dir).catch(() => null)).toBeNull(); // nothing recreated it
  });
});

describe("writeNote's external-edit guard", () => {
  // An "agent edit": bytes replaced behind the app's back, with an mtime the
  // caller has never seen. utimes pins it, because two writes can land inside
  // one mtime granule and would make the test flaky about what it proves.
  async function externalEdit(path: string, text: string, at = 12_345_000): Promise<void> {
    await writeFile(path, text, "utf8");
    await utimes(path, new Date(at), new Date(at));
  }

  test("a save whose base matches the disk overwrites quietly and reports the new version", async () => {
    const note = await createNote(ROOT, "# Plain\n");
    const first = await writeNote(note.path, "# Plain\n\none", null);
    const second = await writeNote(note.path, "# Plain\n\ntwo", first.mtimeMs);
    expect(first.divergedTo).toBeNull();
    expect(second.divergedTo).toBeNull();
    expect(await textAt(note.path)).toBe("# Plain\n\ntwo");
    expect(second.mtimeMs).toBe((await stat(note.path)).mtimeMs); // the reported version IS the file's
  });

  test("an external edit under a dirty buffer is moved to the trash, and the save wins the live path", async () => {
    const note = await createNote(ROOT, "# Contested\n");
    const mine = await writeNote(note.path, "# Contested\n\nmine", null);
    await externalEdit(note.path, "# Contested\n\nan agent wrote this");
    const res = await writeNote(note.path, "# Contested\n\nmine, newer", mine.mtimeMs);
    expect(res.divergedTo).toBe(join(TRASH, "contested.md"));
    expect(await textAt(note.path)).toBe("# Contested\n\nmine, newer");
    expect(await textAt(res.divergedTo!)).toBe("# Contested\n\nan agent wrote this"); // preserved, not destroyed
    expect((await listTrash(ROOT)).map((t) => t.path)).toEqual([res.divergedTo!]);
  });

  test("an external edit with identical bytes adopts the disk version — no write, no trash noise", async () => {
    const note = await createNote(ROOT, "# Same\n");
    const mine = await writeNote(note.path, "# Same\n\nbody", null);
    await externalEdit(note.path, "# Same\n\nbody"); // the agent wrote exactly this text
    const res = await writeNote(note.path, "# Same\n\nbody", mine.mtimeMs);
    expect(res.mtimeMs).toBe(12_345_000);
    expect(res.divergedTo).toBeNull();
    expect(await listTrash(ROOT)).toEqual([]);
  });

  test("a null base writes blind: no expectation, no divergence — the pre-guard behavior", async () => {
    const note = await createNote(ROOT, "# Blind\n");
    await externalEdit(note.path, "# Blind\n\ntheirs");
    const res = await writeNote(note.path, "# Blind\n\nmine", null);
    expect(res.divergedTo).toBeNull();
    expect(await textAt(note.path)).toBe("# Blind\n\nmine");
    expect(await listTrash(ROOT)).toEqual([]);
  });

  test("a file deleted behind the app's back is not a conflict: the save recreates it", async () => {
    const note = await createNote(ROOT, "# Gone\n");
    const mine = await writeNote(note.path, "# Gone\n\nbody", null);
    await rm(note.path);
    const res = await writeNote(note.path, "# Gone\n\nbody, edited", mine.mtimeMs);
    expect(res.divergedTo).toBeNull();
    expect(await textAt(note.path)).toBe("# Gone\n\nbody, edited");
  });
});

describe("listNotes", () => {
  test("newest first, by mtime", async () => {
    const old = await createNote(ROOT, "# Old\n");
    await createNote(ROOT, "# New\n");
    // Backdate rather than sleep: utimes sets the mtime listNotes sorts by.
    await utimes(old.path, new Date(0), new Date(0));
    expect((await listNotes(ROOT)).map((n) => n.title)).toEqual(["New", "Old"]);
  });

  test("dot-entries stay invisible", async () => {
    await createNote(ROOT, "# Visible\n");
    await mkdir(TRASH, { recursive: true });
    await writeFile(join(TRASH, "deleted.md"), "# Deleted\n");
    await writeFile(join(ROOT, ".stray.md"), "# Stray\n");
    expect((await listNotes(ROOT)).map((n) => n.title)).toEqual(["Visible"]);
  });

  test("each workspace lists only its own notes", async () => {
    const other = await secondRoot();
    await createNote(ROOT, "# Mine\n");
    await createNote(other, "# Theirs\n");
    expect((await listNotes(ROOT)).map((n) => n.title)).toEqual(["Mine"]);
    expect((await listNotes(other)).map((n) => n.title)).toEqual(["Theirs"]);
  });

  test("an unregistered root is refused, not listed empty", async () => {
    await expect(listNotes(APP_HOME)).rejects.toThrow(/not a registered workspace root/);
  });

  test("a note declaring template: true is flagged; every other meta stays lean", async () => {
    await createNote(ROOT, "---\ntemplate: true\n---\n# Meeting\n");
    await createNote(ROOT, "# Plain\n");
    const byTitle = new Map((await listNotes(ROOT)).map((n) => [n.title, n]));
    expect(byTitle.get("Meeting")?.template).toBe(true);
    // Absent, not false: the flag is present-only-when-true (rpc-schema).
    expect("template" in byTitle.get("Plain")!).toBe(false);
  });

  test("vendor dirs are pruned: an attached project's node_modules is not notes", async () => {
    await createNote(ROOT, "# Real\n");
    await mkdir(join(ROOT, "node_modules", "some-pkg"), { recursive: true });
    await writeFile(join(ROOT, "node_modules", "some-pkg", "README.md"), "# some-pkg\n");
    await mkdir(join(ROOT, "packages", "app", "dist"), { recursive: true });
    await writeFile(join(ROOT, "packages", "app", "dist", "CHANGELOG.md"), "# Changes\n");
    expect((await listNotes(ROOT)).map((n) => n.title)).toEqual(["Real"]);
  });

  test(".ledgeignore adds skips and can win a default back", async () => {
    await createNote(ROOT, "# Kept\n");
    await mkdir(join(ROOT, "drafts"));
    await writeFile(join(ROOT, "drafts", "wip.md"), "# WIP\n");
    await writeFile(join(ROOT, "plan.wip.md"), "# Plan WIP\n");
    await mkdir(join(ROOT, "build"));
    await writeFile(join(ROOT, "build", "notes.md"), "# Build Notes\n");
    await writeFile(join(ROOT, ".ledgeignore"), "drafts/\n*.wip.md\n!build\n", "utf8");
    expect((await listNotes(ROOT)).map((n) => n.title).sort()).toEqual(["Build Notes", "Kept"]);
  });

  test("search inherits the skips — listed and searchable cannot disagree", async () => {
    await mkdir(join(ROOT, "node_modules"));
    await writeFile(join(ROOT, "node_modules", "README.md"), "# Pkg\n\nunmistakable needle\n");
    await createNote(ROOT, "# Mine\n\nunmistakable needle\n");
    const { hits } = await searchNotes(ROOT, "unmistakable needle");
    expect(hits.map((h) => h.title)).toEqual(["Mine"]);
  });
});

describe("searchNotes", () => {
  test("finds a match in any of the workspace's notes and says where it sits", async () => {
    await createNote(ROOT, "# Recipes\n\nbring the stock to a boil\n");
    await createNote(ROOT, "# Plans\n\nnothing to see\n");
    const { hits } = await searchNotes(ROOT, "STOCK");
    expect(hits).toEqual([
      {
        path: join(ROOT, "recipes.md"),
        title: "Recipes",
        mtimeMs: expect.any(Number),
        line: 3,
        snippet: "bring the stock to a boil",
        col: "bring the ".length,
      },
    ]);
  });

  test("hits arrive newest note first, the order listNotes shows", async () => {
    const old = await createNote(ROOT, "# Old\n\nshared term\n");
    await createNote(ROOT, "# New\n\nshared term\n");
    await utimes(old.path, new Date(0), new Date(0));
    expect((await searchNotes(ROOT, "shared term")).hits.map((h) => h.title)).toEqual(["New", "Old"]);
  });

  test("search is scoped like the listing: another workspace's notes are not hits", async () => {
    const other = await secondRoot();
    await createNote(other, "# Elsewhere\n\nsecret needle\n");
    expect((await searchNotes(ROOT, "secret needle")).hits).toEqual([]);
    expect((await searchNotes(other, "secret needle")).hits.map((h) => h.title)).toEqual(["Elsewhere"]);
  });

  test("what is invisible to listNotes is invisible to search: trash and dot-entries", async () => {
    await deleteNote((await createNote(ROOT, "# Deleted\n\nsecret needle\n")).path);
    await writeFile(join(ROOT, ".stray.md"), "secret needle\n");
    expect((await searchNotes(ROOT, "secret needle")).hits).toEqual([]);
  });

  test("an empty query matches nothing, not every line of every note", async () => {
    await createNote(ROOT, "# Something\n\nbody\n");
    expect((await searchNotes(ROOT, "")).hits).toEqual([]);
    expect((await searchNotes(ROOT, "   ")).hits).toEqual([]);
  });
});

describe("backlinksTo", () => {
  test("finds each occurrence with its line, context, and the match as written", async () => {
    const target = await createNote(ROOT, "# Target\n\nbody\n");
    await createNote(ROOT, "# Linker\n\nsee [[Target]] here\nplain\nand [[target#Notes]] again\n");
    const { backlinks: hits } = await backlinksTo(target.path);
    expect(hits).toEqual([
      {
        path: join(ROOT, "linker.md"),
        title: "Linker",
        mtimeMs: expect.any(Number),
        line: 3,
        context: "see [[Target]] here",
        raw: "[[Target]]",
      },
      {
        path: join(ROOT, "linker.md"),
        title: "Linker",
        mtimeMs: expect.any(Number),
        line: 5,
        context: "and [[target#Notes]] again",
        raw: "[[target#Notes]]",
      },
    ]);
  });

  test("a [[link]] inside a fence is pasted text, not a backlink", async () => {
    const target = await createNote(ROOT, "# Target\n\nbody\n");
    await createNote(ROOT, "# Logs\n\n```\n[[Target]]\n```\n");
    expect((await backlinksTo(target.path)).backlinks).toEqual([]);
  });

  test("a note is not linked from itself", async () => {
    const target = await createNote(ROOT, "# Target\n\nsee [[Target]]\n");
    expect((await backlinksTo(target.path)).backlinks).toEqual([]);
  });

  test("the scan is workspace-scoped, like the links themselves", async () => {
    const target = await createNote(ROOT, "# Target\n\nbody\n");
    // The other workspace's [[Target]] resolves within ITS root (where no
    // Target exists — dangling), never across into this one.
    await createNote(await secondRoot(), "# Far\n\nsee [[Target]]\n");
    expect((await backlinksTo(target.path)).backlinks).toEqual([]);
  });

  test("an ambiguous title backlinks the note a click would open: newest first", async () => {
    const older = await createNote(ROOT, "# Plan\n\none\n");
    const newer = await createNote(ROOT, "# Plan\n\ntwo\n");
    await createNote(ROOT, "# Linker\n\nsee [[Plan]]\n");
    await utimes(older.path, new Date(0), new Date(0));
    expect((await backlinksTo(newer.path)).backlinks.map((h) => h.title)).toEqual(["Linker"]);
    expect((await backlinksTo(older.path)).backlinks).toEqual([]);
  });

  test("a context line is one row, not a paragraph: long lines truncate", async () => {
    const target = await createNote(ROOT, "# Target\n\nbody\n");
    await createNote(ROOT, `# Linker\n\n[[Target]] ${"x".repeat(300)}\n`);
    const [hit] = (await backlinksTo(target.path)).backlinks;
    expect(hit!.context.length).toBe(201); // 200 + the ellipsis
    expect(hit!.context.endsWith("…")).toBe(true);
  });

  test("a path outside every registered root is refused before any scan", async () => {
    expect(backlinksTo("/etc/passwd.md")).rejects.toThrow(/outside every workspace root/);
  });
});

describe("tagsIn", () => {
  test("frontmatter and inline tags merge; counts are notes, not occurrences", async () => {
    await createNote(ROOT, "# Alpha\n\n#work stuff\nmore #work here\n");
    await createNote(ROOT, "---\ntags: work, home\n---\n# Beta\n\nbody\n");
    expect((await tagsIn(ROOT)).tags).toEqual([
      { tag: "home", count: 1 },
      { tag: "work", count: 2 },
    ]);
  });

  test("identity folds case; the display spelling is the most frequent one", async () => {
    await createNote(ROOT, "# One\n\n#Work\n#Work\n");
    await createNote(ROOT, "# Two\n\n#work\n");
    expect((await tagsIn(ROOT)).tags).toEqual([{ tag: "Work", count: 2 }]);
  });

  test("a #tag in a fence is pasted text; a tagless workspace is empty", async () => {
    await createNote(ROOT, "# Logs\n\n```\n#not-a-tag\n```\n");
    expect((await tagsIn(ROOT)).tags).toEqual([]);
  });

  test("the scan is workspace-scoped, and inherits listNotes' skips", async () => {
    await createNote(await secondRoot(), "# Far\n\n#elsewhere\n");
    await deleteNote((await createNote(ROOT, "# Deleted\n\n#gone\n")).path);
    await writeFile(join(ROOT, ".stray.md"), "#hidden\n");
    expect((await tagsIn(ROOT)).tags).toEqual([]);
  });

  test("an unregistered root is refused before any scan", async () => {
    expect(tagsIn("/nowhere")).rejects.toThrow();
  });
});

describe("notesTagged", () => {
  test("finds each occurrence with its line, context, and the tag as written", async () => {
    await createNote(ROOT, "---\ntags: #work\n---\n# Beta\n\nplain\nthen #Work again\n");
    const { hits } = await notesTagged(ROOT, "work");
    expect(hits).toEqual([
      {
        path: join(ROOT, "beta.md"),
        title: "Beta",
        mtimeMs: expect.any(Number),
        line: 2,
        context: "tags: #work",
        raw: "#work",
      },
      {
        path: join(ROOT, "beta.md"),
        title: "Beta",
        mtimeMs: expect.any(Number),
        line: 7,
        context: "then #Work again",
        raw: "#Work",
      },
    ]);
  });

  test("the query folds like the tags do, from either spelling", async () => {
    await createNote(ROOT, "# Alpha\n\n#Work\n");
    expect((await notesTagged(ROOT, "#wOrK")).hits.map((h) => h.raw)).toEqual(["#Work"]);
  });

  test("hits arrive newest note first, the order listNotes shows", async () => {
    const old = await createNote(ROOT, "# Old\n\n#shared\n");
    await createNote(ROOT, "# New\n\n#shared\n");
    await utimes(old.path, new Date(0), new Date(0));
    expect((await notesTagged(ROOT, "shared")).hits.map((h) => h.title)).toEqual(["New", "Old"]);
  });

  test("scoped to the given root: another workspace's tags are not hits", async () => {
    const other = await secondRoot();
    await createNote(other, "# Far\n\n#shared\n");
    expect((await notesTagged(ROOT, "shared")).hits).toEqual([]);
    expect((await notesTagged(other, "shared")).hits.map((h) => h.title)).toEqual(["Far"]);
  });
});

describe("retitleNote", () => {
  test("moves the file to match its heading", async () => {
    const note = await createNote(ROOT, "# Draft\n");
    const moved = await retitleNote(note.path, "# Final\n");
    expect(moved.path).toBe(join(ROOT, "final.md"));
    expect(await textAt(moved.path)).toBe("# Draft\n"); // retitle moves, it does not save
    expect(await readdir(ROOT)).toEqual(["final.md"]);
  });

  test("a note's own name is not an obstacle to itself: retitling to the same heading stays put", async () => {
    const note = await createNote(ROOT, "# Keep\n");
    const again = await retitleNote(note.path, "# Keep\n\nmore text");
    expect(again.path).toBe(note.path);
    expect(await readdir(ROOT)).toEqual(["keep.md"]);
  });

  test("retitling into another note's name enumerates instead of clobbering it", async () => {
    const other = await createNote(ROOT, "# Target\n\ntheirs");
    const note = await createNote(ROOT, "# Source\n\nmine");
    const moved = await retitleNote(note.path, "# Target\n\nmine");
    expect(moved.path).toBe(join(ROOT, "target-2.md"));
    expect(await textAt(other.path)).toBe("# Target\n\ntheirs");
  });

  test("a name taken in ANOTHER workspace is no obstacle: enumeration is per folder", async () => {
    const other = await secondRoot();
    await createNote(other, "# Target\n\ntheirs");
    const note = await createNote(ROOT, "# Source\n\nmine");
    const moved = await retitleNote(note.path, "# Target\n\nmine");
    expect(moved.path).toBe(join(ROOT, "target.md"));
  });
});

describe("trash round-trip", () => {
  test("delete moves the note into ITS OWN root's trash; the lists swap accordingly", async () => {
    const note = await createNote(ROOT, "# Doomed\n\nbody");
    const trashed = (await deleteNote(note.path))!;
    expect(trashed).toBe(join(TRASH, "doomed.md"));
    expect(await listNotes(ROOT)).toEqual([]);
    expect((await listTrash(ROOT)).map((t) => t.path)).toEqual([trashed]);
    expect(await textAt(trashed)).toBe("# Doomed\n\nbody"); // bytes intact, only moved
  });

  test("each workspace's trash is its own: a delete here never shows up there", async () => {
    const other = await secondRoot();
    await deleteNote((await createNote(ROOT, "# Mine\n")).path);
    expect(await listTrash(other)).toEqual([]);
    expect((await listTrash(ROOT)).map((t) => t.title)).toEqual(["Mine"]);
  });

  test("deleting what is already trashed (or already gone) is null, not a second move", async () => {
    const note = await createNote(ROOT, "# Once\n");
    const trashed = await deleteNote(note.path);
    expect(await deleteNote(trashed!)).toBeNull();
    expect(await deleteNote(note.path)).toBeNull(); // the original path is empty now
  });

  test("restore brings the note back to its own root; a taken name enumerates rather than clobbers", async () => {
    const note = await createNote(ROOT, "# Twice\n\noriginal");
    const trashed = await deleteNote(note.path);
    await createNote(ROOT, "# Twice\n\nusurper"); // takes twice.md while the original sits in the trash
    const restored = await restoreNote(trashed!);
    expect(restored.path).toBe(join(ROOT, "twice-2.md"));
    expect(await textAt(restored.path)).toBe("# Twice\n\noriginal");
    expect(await textAt(join(ROOT, "twice.md"))).toBe("# Twice\n\nusurper");
  });
});

describe("the unlink paths", () => {
  test("deleteTrashed removes the file for good; a second call reports it already gone", async () => {
    const trashed = (await deleteNote((await createNote(ROOT, "# Gone\n")).path))!;
    expect(await deleteTrashed(trashed)).toBe(true);
    await expect(stat(trashed)).rejects.toThrow();
    expect(await deleteTrashed(trashed)).toBe(false);
  });

  test("refuses anything that is not a .md directly inside a registered root's trash", async () => {
    // The guard is the whole safety story for permanent delete: it unlinks, so
    // "which paths does it accept" is the only thing standing between a Trash
    // row and an arbitrary file the view named.
    for (const path of [
      "/etc/passwd",
      join(ROOT, "live-note.md"), // a live note, not a trashed one
      join(TRASH, "sub", "nested.md"), // not directly inside
      join(TRASH, "notes.txt"), // not a note
      TRASH, // the folder itself
      join(TRASH, "..", "escape.md"),
      join(APP_HOME, ".ledge-trash", "old-world.md"), // the app home is not a root anymore
    ]) {
      expect(deleteTrashed(path)).rejects.toThrow(/not a trashed note/);
    }
  });

  test("emptyTrash removes exactly what listTrash showed, and nothing it did not", async () => {
    await deleteNote((await createNote(ROOT, "# A\n")).path);
    await deleteNote((await createNote(ROOT, "# B\n")).path);
    // Things that arrived in the trash folder by some route other than a
    // delete: a stray non-md file and a subdirectory. Both must survive.
    await writeFile(join(TRASH, "not-a-note.txt"), "keep me");
    await mkdir(join(TRASH, "subdir"), { recursive: true });
    expect(await emptyTrash(ROOT)).toBe(2);
    expect((await readdir(TRASH)).sort()).toEqual(["not-a-note.txt", "subdir"]);
  });

  test("emptyTrash empties one workspace's trash, not every workspace's", async () => {
    const other = await secondRoot();
    await deleteNote((await createNote(ROOT, "# A\n")).path);
    await deleteNote((await createNote(other, "# B\n")).path);
    expect(await emptyTrash(ROOT)).toBe(1);
    expect((await listTrash(other)).map((t) => t.title)).toEqual(["B"]);
  });

  test("purgeTrash evicts by age and keeps the young", async () => {
    await deleteNote((await createNote(ROOT, "# Fresh\n")).path);
    expect(await purgeTrash(ROOT, 60_000)).toBe(0); // a minute old it is not
    expect((await listTrash(ROOT)).length).toBe(1);
    // A negative TTL puts the cutoff in the future, so "older than the cutoff"
    // is true of a file trashed just now — age without waiting (ctime cannot
    // be backdated; that immutability is why listTrash trusts it).
    expect(await purgeTrash(ROOT, -60_000)).toBe(1);
    expect(await listTrash(ROOT)).toEqual([]);
  });
});

// --- note locking (docs/locking.md) -----------------------------------------
// The honesty tests: after a lock, the plaintext must be GONE from disk — in
// the note, in every save that follows, and in the divergence guard's trash
// copies — while titles, tags-in-head, and the agent-facing skips behave
// exactly as §4/§6 promise. The vault module's own crypto is vault.test.ts's;
// here it is the seams.
describe("note locking", () => {
  beforeEach(async () => {
    resetVaultForTests(); // module state outlives the wiped app home
    await createVault("test passphrase");
  });

  const NEEDLE = "plutonium shipment schedule";

  test("locking seals the body on disk; reading decrypts it back, flagged", async () => {
    const note = await createNote(ROOT, `# Secrets\n\n${NEEDLE}\n`);
    await lockNote(note.path);
    const raw = await readRaw(note.path, "utf8");
    expect(raw).not.toContain(NEEDLE);
    expect(raw).toContain("locked: v1.");
    expect(raw).toContain("# Secrets\n"); // the title stays plaintext, deliberately
    expect(await isNoteLocked(note.path)).toBe(true);
    const file = await readNote(note.path);
    expect(file?.locked).toBe(true);
    expect(file?.held).toBeUndefined();
    expect(file?.text).toContain(NEEDLE);
    const metas = await listNotes(ROOT);
    expect(metas[0]?.locked).toBe(true);
  });

  test("a save cannot drop the lock: a headerless buffer still encrypts", async () => {
    const note = await createNote(ROOT, `# Secrets\n\nold\n`);
    await lockNote(note.path);
    const { mtimeMs } = (await readNote(note.path))!;
    await writeNote(note.path, `# Secrets\n\n${NEEDLE}\n`, mtimeMs); // no locked: line at all
    const raw = await readRaw(note.path, "utf8");
    expect(raw).toContain("locked: v1.");
    expect(raw).not.toContain(NEEDLE);
    expect((await readNote(note.path))?.text).toContain(NEEDLE);
  });

  test("a save cannot mint a lock: a pasted locked: line is stripped", async () => {
    const note = await createNote(ROOT, "# Plain\n\nbody\n");
    await writeNote(note.path, "---\nlocked: v1.forged.forged.forged\n---\n# Plain\n\nbody\n");
    expect(await readRaw(note.path, "utf8")).toBe("# Plain\n\nbody\n");
    expect(await isNoteLocked(note.path)).toBe(false);
  });

  test("vault locked: the body is held, the save refused, the title still labels", async () => {
    const note = await createNote(ROOT, `# Secrets\n\n${NEEDLE}\n`);
    await lockNote(note.path);
    lockVault();
    const file = await readNote(note.path);
    expect(file?.locked).toBe(true);
    expect(file?.held).toBe(true);
    expect(file?.text).not.toContain(NEEDLE);
    expect((await listNotes(ROOT))[0]?.title).toBe("Secrets");
    expect(writeNote(note.path, "# Secrets\n\nedit\n", file!.mtimeMs)).rejects.toThrow(/vault is locked/);
  });

  test("external tamper surfaces as damage, not as gone and not as plaintext", async () => {
    const note = await createNote(ROOT, `# Secrets\n\n${NEEDLE}\n`);
    await lockNote(note.path);
    const raw = await readRaw(note.path, "utf8");
    // Corrupt one ciphertext character (the armored region after the head).
    const at = raw.indexOf("\n", raw.indexOf("# Secrets")) + 3;
    await writeRaw(note.path, raw.slice(0, at) + (raw[at] === "A" ? "B" : "A") + raw.slice(at + 1));
    const file = await readNote(note.path);
    expect(file?.held).toBe(true);
    expect(file?.damaged).toBe(true);
  });

  test("the divergence guard's trash copy is ciphertext, never plaintext", async () => {
    const note = await createNote(ROOT, `# Secrets\n\noriginal\n`);
    await lockNote(note.path);
    const base = (await readNote(note.path))!.mtimeMs;
    // A foreign writer scribbles on the file (mtime moves on).
    const cipher = await readRaw(note.path, "utf8");
    await writeRaw(note.path, cipher + "external-scribble\n");
    await new Promise((r) => setTimeout(r, 5)); // mtime granularity
    const res = await writeNote(note.path, `# Secrets\n\n${NEEDLE}\n`, base);
    expect(res.divergedTo).not.toBeNull();
    const trashed = await readRaw(res.divergedTo!, "utf8");
    expect(trashed).toContain("external-scribble");
    expect(trashed).not.toContain(NEEDLE);
    expect(trashed).not.toContain("original");
    expect(await readRaw(note.path, "utf8")).not.toContain(NEEDLE);
  });

  test("scans skip locked bodies — vault UNLOCKED — and count the skip", async () => {
    await createNote(ROOT, `# Alpha\n\n${NEEDLE} here\n`);
    const hush = await createNote(ROOT, `---\ntags: work\n---\n# Hush\n\n${NEEDLE} too, #hidden, see [[Alpha]]\n`);
    await lockNote(hush.path);

    const search = await searchNotes(ROOT, NEEDLE);
    expect(search.hits.map((h) => h.title)).toEqual(["Alpha"]);
    expect(search.lockedSkipped).toBe(1);

    const alpha = (await listNotes(ROOT)).find((m) => m.title === "Alpha")!;
    const back = await backlinksTo(alpha.path);
    expect(back.backlinks).toEqual([]);
    expect(back.lockedSkipped).toBe(1);

    // Frontmatter tags live in the plaintext head and stay visible; the body
    // #hidden does not. Both facts, one note.
    const tags = await tagsIn(ROOT);
    expect(tags.tags).toEqual([{ tag: "work", count: 1 }]);
    expect(tags.lockedSkipped).toBe(1);
    const tagged = await notesTagged(ROOT, "work");
    expect(tagged.hits.map((h) => h.title)).toEqual(["Hush"]);
    expect((await notesTagged(ROOT, "hidden")).hits).toEqual([]);
  });

  test("remove lock restores the exact original bytes (husk block dropped)", async () => {
    const original = "# Secrets\n\nround trip body\n";
    const note = await createNote(ROOT, original);
    await lockNote(note.path);
    await removeLockNote(note.path);
    expect(await readRaw(note.path, "utf8")).toBe(original);
    expect(await isNoteLocked(note.path)).toBe(false);
  });

  test("a template cannot be locked (marker exclusivity)", async () => {
    const t = await createNote(ROOT, "---\ntemplate: true\n---\n# Meeting\n\nagenda\n");
    expect(lockNote(t.path)).rejects.toThrow(/template/);
  });

  test("locking needs the vault open", async () => {
    lockVault();
    const note = await createNote(ROOT, "# Secrets\n\nbody\n");
    expect(lockNote(note.path)).rejects.toThrow(/vault is locked/);
  });
});

// Passphrase change: headers and asset wraps rewrite, bodies never — and the
// old passphrase stops opening anything.
import { changeVaultPassphrase } from "./notes";
import { loadVault, resetVaultForTests as resetVault2, unlockVault as unlockV, VAULT_PATH as VP } from "./vault";
import { rm as rmF } from "node:fs/promises";

describe("changeVaultPassphrase", () => {
  test("rewraps every locked note; only the new passphrase opens afterwards", async () => {
    resetVaultForTests();
    await rmF(VP, { force: true });
    await createVault("old pass");
    const a = await createNote(ROOT, "# One\n\nfirst secret body\n");
    const b = await createNote(ROOT, "# Two\n\nsecond secret body\n");
    await lockNote(a.path);
    await lockNote(b.path);
    const rewrapped = await changeVaultPassphrase("new pass", [ROOT]);
    expect(rewrapped).toBe(2);
    // Bodies still open in this session (data keys unchanged)…
    expect((await readNote(a.path))?.text).toContain("first secret body");
    // …and across a cold start only the NEW passphrase derives the key.
    resetVault2();
    await loadVault();
    expect(await unlockV("old pass")).toBe(false);
    expect(await unlockV("new pass")).toBe(true);
    expect((await readNote(b.path))?.text).toContain("second secret body");
  });
});
