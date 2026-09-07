// The note store against a real filesystem, the layer notes.test.ts leaves
// out: the renames (retitle's self-rename, trash round-trips, restore into a
// taken name), the unlink paths, and the multi-root guards. Since the
// per-workspace split, every operation asks which registered root a path
// belongs to.
//
// The app home is a per-run temp dir, set by src/test-preload.ts before any
// module loads (see bunfig.toml). The guard below re-checks that, because
// beforeEach wipes the app home and must never wipe the wrong folder.
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile as readRaw, rm, stat, utimes, writeFile, writeFile as writeRaw } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { APP_HOME, attachExternal, createManaged, loadWorkspaces } from "./workspaces";
import {
  backlinksTo,
  createNote,
  deleteNote,
  ensureFolder,
  folderOf,
  folderPathOf,
  deleteTrashed,
  emptyTrash,
  favoriteNote,
  isNoteLocked,
  listNotes,
  listTrash,
  lockNote,
  moveNote,
  deleteFolder,
  renameFolder,
  notesTagged,
  purgeTrash,
  readNote,
  removeLockNote,
  restoreNote,
  retitleNote,
  searchNotes,
  stashNote,
  tagsIn,
  trashDirOf,
  writeNote,
} from "./notes";
import { createVault, lockVault, resetVaultForTests, unlockVault } from "./vault";
import { MAX_HITS, MAX_HITS_PER_NOTE } from "../shared/search";

if (!resolve(APP_HOME).startsWith(resolve(tmpdir()) + sep)) {
  throw new Error(`refusing to run filesystem tests against ${APP_HOME} — is the preload configured?`);
}

let ROOT = ""; // the default workspace root every test gets
let TRASH = ""; // its trash

// Returns just a note's text. readNote returns {text, mtimeMs} and most
// assertions here only care about the text. null stays null, so the cases for
// a note that is gone read the same.
async function textAt(path: string): Promise<string | null> {
  return (await readNote(path))?.text ?? null;
}

// Creates a second root for the cross-workspace cases. It is managed for
// convenience. The guards treat managed and external roots alike, apart from
// the mkdir that self-heals a missing managed root (notes.ts rootReady).
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
    // Name reservations are kept per directory. One set shared across
    // workspaces would enumerate one of these to plan-2.md, though the two
    // files sit in different directories and cannot collide.
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
    // settings.jsonc names the shell executable, so a noteWrite that reached
    // it would run a command of the writer's choosing at the next launch.
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
    // A missing external root is what an unmounted volume looks like.
    // Recreating the path with mkdir would catch autosaves in a folder on the
    // boot disk. The volume hides that folder again when it remounts.
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
  // Writes an "agent edit": bytes replaced behind the app's back, with an
  // mtime the caller has never seen. utimes pins that mtime, because two
  // writes can land inside one mtime granule and make the test flaky.
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
    expect(second.mtimeMs).toBe((await stat(note.path)).mtimeMs); // the reported version matches the file's
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
    // The other workspace's [[Target]] resolves within that workspace's own
    // root, where no Target exists, so it dangles. It never reaches into this
    // root.
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

describe("stashNote", () => {
  beforeEach(async () => {
    resetVaultForTests(); // wiping the app home does not clear the module's key
    await createVault("test passphrase");
  });

  const STRANDED = "the paragraph nobody else has";

  test("parks text in the trash and leaves the note itself alone", async () => {
    const note = await createNote(ROOT, "# Plan\n\nwhat the server says\n");
    const dest = await stashNote(note.path, `# Plan\n\n${STRANDED}\n`);

    expect(dest.startsWith(TRASH + sep)).toBe(true);
    expect(await readRaw(dest, "utf8")).toContain(STRANDED);
    // The live note is untouched: a stash is not a save.
    expect(await textAt(note.path)).toBe("# Plan\n\nwhat the server says\n");
    expect((await listTrash(ROOT)).map((t) => t.path)).toEqual([dest]);
  });

  test("two stashes of one note do not overwrite each other", async () => {
    const note = await createNote(ROOT, "# Plan\n\nlive\n");
    const first = await stashNote(note.path, "# Plan\n\nfirst try\n");
    const second = await stashNote(note.path, "# Plan\n\nsecond try\n");

    expect(second).not.toBe(first);
    expect(await readRaw(first, "utf8")).toContain("first try");
    expect(await readRaw(second, "utf8")).toContain("second try");
  });

  // A stash goes to the trash because restoring one lands it beside the live
  // note. Both versions are then on screen, and the merge is made by hand.
  test("restoring a stash lands beside the live note, never over it", async () => {
    const note = await createNote(ROOT, "# Plan\n\nwhat the server says\n");
    const dest = await stashNote(note.path, `# Plan\n\n${STRANDED}\n`);

    const restored = await restoreNote(dest);
    expect(restored.path).not.toBe(note.path);
    expect(await textAt(note.path)).toContain("what the server says");
    expect(await textAt(restored.path)).toContain(STRANDED);
  });

  test("a locked note's stash is sealed, not plaintext in the trash", async () => {
    const note = await createNote(ROOT, "# Secrets\n\nold\n");
    await lockNote(note.path);
    const dest = await stashNote(note.path, `# Secrets\n\n${STRANDED}\n`);

    const raw = await readRaw(dest, "utf8");
    expect(raw).not.toContain(STRANDED);
    expect(raw).toContain("locked: v1.");
    expect(raw).toContain("# Secrets\n"); // the title stays plaintext, as everywhere
    // The vault opens it again, so a sealed stash is still recoverable.
    const restored = await restoreNote(dest);
    expect((await readNote(restored.path))?.text).toContain(STRANDED);
  });

  test("a locked note's stash fails with the vault locked, so the caller keeps the buffer", async () => {
    const note = await createNote(ROOT, "# Secrets\n\nold\n");
    await lockNote(note.path);
    lockVault();

    await expect(stashNote(note.path, `# Secrets\n\n${STRANDED}\n`)).rejects.toThrow();
    expect(await readdir(TRASH).catch(() => [])).toEqual([]);
  });
});

describe("folders", () => {
  test("a note is created in the folder asked for, and at the root when none is", async () => {
    const top = await createNote(ROOT, "# Top\n");
    const nested = await createNote(ROOT, "# Nested\n", "projects/api");
    expect(relative(ROOT, top.path)).toBe("top.md");
    expect(relative(ROOT, nested.path)).toBe(join("projects", "api", "nested.md"));
    // A folder is placement only: listNotes returns both notes the same way.
    expect((await listNotes(ROOT)).map((n) => n.title).sort()).toEqual(["Nested", "Top"]);
  });

  test("a note's meta says which folder it is in, and says nothing at the top level", async () => {
    // The flat listings (quick-open, search, backlinks, the agents' lists) use
    // the folder to tell two same-titled notes apart. metaAt derives it from
    // the path rather than storing it, and omits it at the top level.
    const top = await createNote(ROOT, "# Top\n");
    const nested = await createNote(ROOT, "# Nested\n", "projects/api");
    expect(top.folder).toBeUndefined();
    expect(nested.folder).toBe("projects/api");
    // listNotes carries the folder too, and that listing is the copy the view
    // holds.
    const listed = await listNotes(ROOT);
    expect(listed.find((n) => n.title === "Nested")?.folder).toBe("projects/api");
    expect(listed.find((n) => n.title === "Top")?.folder).toBeUndefined();
  });

  test("names enumerate per folder, so the same title in two folders is two files", async () => {
    const a = await createNote(ROOT, "# Notes\n", "a");
    const b = await createNote(ROOT, "# Notes\n", "b");
    expect(relative(ROOT, a.path)).toBe(join("a", "notes.md"));
    expect(relative(ROOT, b.path)).toBe(join("b", "notes.md")); // not notes-2.md
    const same = await createNote(ROOT, "# Notes\n", "a");
    expect(relative(ROOT, same.path)).toBe(join("a", "notes-2.md"));
  });

  test("a folder scope narrows the scan before the hit cap can be spent", async () => {
    // collectHits stops at MAX_HITS, so searchNotes narrows the note list by
    // folder before the scan reads a byte. Filtering the hits afterwards would
    // let the excluded notes spend the whole budget. The folder's own matches
    // would go unread, and the search would report nothing about a folder full
    // of the word. No other test covers this narrowing.
    const wanted = await createNote(ROOT, "# Wanted\n\nneedle\n", "projects");
    // MAX_HITS / MAX_HITS_PER_NOTE noisy notes, each newer than the one above,
    // is exactly enough to fill the budget on its own.
    for (let i = 0; i < MAX_HITS / MAX_HITS_PER_NOTE; i++) {
      await createNote(ROOT, `# Noise ${i}\n\n${"needle\n".repeat(MAX_HITS_PER_NOTE)}`);
    }
    const wide = await searchNotes(ROOT, "needle");
    expect(wide.hits).toHaveLength(MAX_HITS);
    expect(wide.hits.some((h) => h.path === wanted.path)).toBe(false); // the budget is gone
    const scoped = await searchNotes(ROOT, "needle", "projects");
    expect(scoped.hits.map((h) => h.path)).toEqual([wanted.path]);
  });

  test("folderPathOf refuses every way of naming somewhere else", () => {
    for (const folder of [
      "/etc",
      " /etc", // leading whitespace must not let an absolute path through
      "/",
      "..",
      "../escape",
      "projects/../../escape",
      "a/./b",
      "a//b",
      ".ledge-trash",
      ".ledge-assets",
      "projects/.git",
      ".hidden",
      "a\\b",
    ]) {
      expect(() => folderPathOf(ROOT, folder)).toThrow();
    }
  });

  test("folderPathOf accepts the ordinary shapes and normalizes the harmless ones", () => {
    expect(folderPathOf(ROOT, null)).toBe(ROOT);
    expect(folderPathOf(ROOT, "")).toBe(ROOT);
    expect(folderPathOf(ROOT, "projects")).toBe(join(ROOT, "projects"));
    expect(folderPathOf(ROOT, "projects/api")).toBe(join(ROOT, "projects", "api"));
    expect(folderPathOf(ROOT, "projects/")).toBe(join(ROOT, "projects")); // the trailing slash is dropped
    expect(folderPathOf(ROOT, " projects ")).toBe(join(ROOT, "projects"));
  });

  test("folderOf reads a note's placement back off its path", async () => {
    const nested = await createNote(ROOT, "# Nested\n", "projects/api");
    expect(folderOf(ROOT, nested.path)).toBe("projects/api");
    expect(folderOf(ROOT, (await createNote(ROOT, "# Top\n")).path)).toBe("");
  });

  test("an ignored folder is refused, naming why — a note there would never be listed", async () => {
    await expect(ensureFolder(ROOT, "node_modules")).rejects.toThrow(/ignored/);
    // Every ancestor is checked, not just the leaf: listNotes prunes an ignored
    // directory whole and never sees the child.
    await expect(ensureFolder(ROOT, "node_modules/mine")).rejects.toThrow(/ignored/);
    await writeFile(join(ROOT, ".ledgeignore"), "drafts/\n");
    await expect(ensureFolder(ROOT, "drafts")).rejects.toThrow(/ignored/);
    await rm(join(ROOT, ".ledgeignore"));
  });

  test("moveNote renames within the root and keeps the note's name", async () => {
    const note = await createNote(ROOT, "# Shipping\n");
    const moved = await moveNote(note.path, "projects");
    expect(relative(ROOT, moved.path)).toBe(join("projects", "shipping.md"));
    expect(moved.title).toBe("Shipping");
    await expect(stat(note.path)).rejects.toThrow(); // moved, not copied
    // Back out again. The root is spelled "", as it is for createNote.
    expect(relative(ROOT, (await moveNote(moved.path, "")).path)).toBe("shipping.md");
  });

  test("moveNote never clobbers, and moving where it already is costs nothing", async () => {
    const a = await createNote(ROOT, "# Notes\n", "a");
    await createNote(ROOT, "# Notes\n", "b");
    const moved = await moveNote(a.path, "b");
    expect(relative(ROOT, moved.path)).toBe(join("b", "notes-2.md"));
    expect(await moveNote(moved.path, "b")).toMatchObject({ path: moved.path });
  });

  test("moveNote refuses a trashed note: restore is the way out of the trash", async () => {
    const trashed = (await deleteNote((await createNote(ROOT, "# Gone\n")).path))!;
    await expect(moveNote(trashed, "projects")).rejects.toThrow(/in the trash/);
  });

  test("a folder's deletes and restores round-trip through the mirrored trash", async () => {
    const note = await createNote(ROOT, "# Runbook\n", "projects/api");
    const trashed = (await deleteNote(note.path))!;
    // The trash mirrors the workspace's folders, so the path records where the
    // note came from.
    expect(relative(TRASH, trashed)).toBe(join("projects", "api", "runbook.md"));
    expect((await listTrash(ROOT)).map((t) => t.title)).toEqual(["Runbook"]);
    const back = await restoreNote(trashed);
    expect(relative(ROOT, back.path)).toBe(join("projects", "api", "runbook.md"));
  });

  test("a restore recreates the folder emptied since the delete", async () => {
    const note = await createNote(ROOT, "# Runbook\n", "projects");
    const trashed = (await deleteNote(note.path))!;
    await rm(join(ROOT, "projects"), { recursive: true });
    expect(relative(ROOT, (await restoreNote(trashed)).path)).toBe(join("projects", "runbook.md"));
  });

  test("same-named notes in different folders survive a delete of both", async () => {
    // A flat trash could not hold this: two readme.md files, one bin, one name.
    const a = await createNote(ROOT, "# Readme\n", "a");
    const b = await createNote(ROOT, "# Readme\n", "b");
    const ta = (await deleteNote(a.path))!;
    const tb = (await deleteNote(b.path))!;
    expect(relative(TRASH, ta)).toBe(join("a", "readme.md"));
    expect(relative(TRASH, tb)).toBe(join("b", "readme.md")); // its own folder, its own name
    expect((await listTrash(ROOT)).length).toBe(2);
    expect(relative(ROOT, (await restoreNote(ta)).path)).toBe(join("a", "readme.md"));
    expect(relative(ROOT, (await restoreNote(tb)).path)).toBe(join("b", "readme.md"));
  });

  test("retitling a nested note renames it in place", async () => {
    const note = await createNote(ROOT, "# Draft\n", "projects");
    const renamed = await retitleNote(note.path, "# Shipping Notes\n");
    expect(relative(ROOT, renamed.path)).toBe(join("projects", "shipping-notes.md"));
  });

  test("concurrent moves into one folder do not collide", async () => {
    // moveNote reserves the name it allocates. The readdir before it is an
    // await, so without the reservation both moves read the same snapshot and
    // rename onto the same name, and rename(2) clobbers silently.
    const a = await createNote(ROOT, "# Notes\n", "a");
    const b = await createNote(ROOT, "# Notes\n", "b");
    const moved = await Promise.all([moveNote(a.path, "dest"), moveNote(b.path, "dest")]);
    expect(new Set(moved.map((m) => m.path)).size).toBe(2);
    expect((await readdir(join(ROOT, "dest"))).sort()).toEqual(["notes-2.md", "notes.md"]);
  });

  test("emptyTrash reaches into the mirrored folders", async () => {
    await deleteNote((await createNote(ROOT, "# A\n", "x/y")).path);
    await deleteNote((await createNote(ROOT, "# B\n")).path);
    expect(await emptyTrash(ROOT)).toBe(2);
    expect(await listTrash(ROOT)).toEqual([]);
  });
});

describe("renameFolder", () => {
  test("one rename carries every note under the folder, however deep", async () => {
    const top = await createNote(ROOT, "# Plan\n", "projcts");
    const deep = await createNote(ROOT, "# Api\n", "projcts/api/v2");
    const outside = await createNote(ROOT, "# Elsewhere\n", "admin");
    const { folder, moved } = await renameFolder(ROOT, "projcts", "projects");
    expect(folder).toBe("projects");
    expect(moved.map((m) => m.from).sort()).toEqual([deep.path, top.path].sort());
    expect(moved.find((m) => m.from === deep.path)?.note.folder).toBe("projects/api/v2");
    const listed = await listNotes(ROOT);
    expect(listed.map((n) => n.folder ?? "").sort()).toEqual(["admin", "projects", "projects/api/v2"]);
    expect(listed.find((n) => n.title === "Elsewhere")?.path).toBe(outside.path); // untouched
    await expect(stat(join(ROOT, "projcts"))).rejects.toThrow(); // the old name is gone
  });

  test("a sibling whose name starts the same is not swept up", async () => {
    // Renaming `a` must not report `ab` as moved. renameFolder does one
    // rename(2) of the folder and takes the notes it reports from
    // folderContains (shared/folders.ts), which compares against `a/`. A
    // prefix test without the separator would list the sibling's note as
    // moved, at a path the rename never touched.
    const inside = await createNote(ROOT, "# In\n", "a");
    const sibling = await createNote(ROOT, "# Beside\n", "ab");
    const { moved } = await renameFolder(ROOT, "a", "c");
    expect(moved.map((m) => m.from)).toEqual([inside.path]);
    expect((await listNotes(ROOT)).find((n) => n.title === "Beside")?.path).toBe(sibling.path);
  });

  test("the meta comes back with the old title, tags and mtime, only the path new", async () => {
    // rename(2) moves a directory entry and touches no file inside it, so
    // renameFolder builds its result from the listing it already took instead
    // of re-reading every note. This test fails if that stops holding.
    const note = await createNote(ROOT, "# Plan\n\n#roadmap\n", "old");
    const before = (await listNotes(ROOT))[0]!;
    const { moved } = await renameFolder(ROOT, "old", "new");
    const after = moved[0]!.note;
    expect(after.title).toBe(before.title);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.path).toBe(join(ROOT, "new", "plan.md"));
    // The file is byte-identical: nothing read it and nothing rewrote it.
    expect(await readRaw(after.path, "utf8")).toBe("# Plan\n\n#roadmap\n");
    expect(note.path).toBe(join(ROOT, "old", "plan.md"));
  });

  test("a locked note travels with the vault shut, where moving one is refused", async () => {
    // A rename is one call rather than N moves. moveNote reads a locked body to
    // rebase its image references, and refuses when the vault is shut. A rename
    // changes no note's depth, so those references still resolve and nothing
    // reads inside.
    resetVaultForTests();
    await createVault("test passphrase");
    const note = await createNote(ROOT, "# Secrets\n\nplutonium\n", "old");
    await lockNote(note.path);
    const sealed = await readRaw(note.path, "utf8");
    lockVault();
    await expect(moveNote(note.path, "elsewhere")).rejects.toThrow(/unlock first/);
    const { moved } = await renameFolder(ROOT, "old", "new");
    expect(moved).toHaveLength(1);
    expect(await readRaw(join(ROOT, "new", "secrets.md"), "utf8")).toBe(sealed);
    expect(await isNoteLocked(join(ROOT, "new", "secrets.md"))).toBe(true);
  });

  test("a name is one segment: a path is refused rather than reparenting the folder", async () => {
    await createNote(ROOT, "# A\n", "old");
    await expect(renameFolder(ROOT, "old", "deep/new")).rejects.toThrow(/does not move it/);
    await expect(renameFolder(ROOT, "old", "..")).rejects.toThrow(/not a folder name/);
    await expect(renameFolder(ROOT, "old", ".hidden")).rejects.toThrow(/dot-folders/);
    await expect(renameFolder(ROOT, "old", "  ")).rejects.toThrow(/needs a name/);
    expect(await listNotes(ROOT)).toHaveLength(1);
    expect((await listNotes(ROOT))[0]?.folder).toBe("old");
  });

  test("a name another folder already answers to is refused, not merged", async () => {
    await createNote(ROOT, "# A\n", "old");
    await createNote(ROOT, "# B\n", "new");
    await expect(renameFolder(ROOT, "old", "new")).rejects.toThrow(/already a folder called/);
    // An empty folder too. The browser does not draw one, but rename(2) onto
    // an empty directory succeeds and swallows it.
    await mkdir(join(ROOT, "empty"));
    await expect(renameFolder(ROOT, "old", "empty")).rejects.toThrow(/already a folder called/);
  });

  test("changing only the case of a name is a rename, not a collision", async () => {
    // On APFS `old` and `Old` are the same directory, so the destination
    // already exists. renameFolder asks sameEntry whether that destination is
    // the source, and renames rather than refusing when it is. Without that
    // exception, fixing the case of a name would be refused as a collision.
    await createNote(ROOT, "# A\n", "old");
    const { folder } = await renameFolder(ROOT, "old", "Old");
    expect(folder).toBe("Old");
    expect((await listNotes(ROOT))[0]?.folder).toBe("Old");
  });

  test("the same name is the outcome asked for, not an error", async () => {
    await createNote(ROOT, "# A\n", "keep");
    expect(await renameFolder(ROOT, "keep", "keep")).toEqual({ folder: "keep", moved: [] });
  });

  test("the workspace's own folder has no name to change here", async () => {
    await expect(renameFolder(ROOT, "", "anything")).rejects.toThrow(/workspace strip/);
  });

  test("a folder nothing is in is refused by name", async () => {
    await expect(renameFolder(ROOT, "ghost", "other")).rejects.toThrow(/no "ghost" folder/);
  });

  test("renaming into an ignored name is refused, since the notes would leave the list", async () => {
    await writeRaw(join(ROOT, ".ledgeignore"), "hidden\n");
    await createNote(ROOT, "# A\n", "shown");
    await expect(renameFolder(ROOT, "shown", "hidden")).rejects.toThrow(/is ignored in this workspace/);
    expect(await listNotes(ROOT)).toHaveLength(1);
  });

  test("the trash mirror follows, so an Undo lands where the folder now is", async () => {
    // The trash mirrors the workspace's folders (architecture.md §3), so it
    // follows the rename. Without this, deleting a note out of `old`, renaming
    // the folder and pressing Undo would restore the note into a recreated
    // `old` beside the `new` it came from.
    const gone = await createNote(ROOT, "# Gone\n", "old");
    const stays = await createNote(ROOT, "# Stays\n", "old");
    const trashed = (await deleteNote(gone.path))!;
    expect(relative(TRASH, trashed)).toBe(join("old", "gone.md"));
    await renameFolder(ROOT, "old", "new");
    expect(stays.path).toContain(join("old", "stays.md"));
    const listed = await listTrash(ROOT);
    expect(listed).toHaveLength(1);
    expect(relative(ROOT, (await restoreNote(listed[0]!.path)).path)).toBe(join("new", "gone.md"));
  });

  test("the root has to be a registered workspace, like every other mutating call", async () => {
    const stranger = join(APP_HOME, "unregistered");
    await mkdir(join(stranger, "old"), { recursive: true });
    await expect(renameFolder(stranger, "old", "new")).rejects.toThrow(/not a registered workspace root/);
  });
});

describe("deleteFolder", () => {
  test("every note under the folder goes to the trash, however deep, and the folder goes with them", async () => {
    const top = await createNote(ROOT, "# Plan\n", "projects");
    const deep = await createNote(ROOT, "# Api\n", "projects/api/v2");
    const outside = await createNote(ROOT, "# Elsewhere\n", "admin");
    const { trashed } = await deleteFolder(ROOT, "projects");
    expect(trashed.map((t) => t.from).sort()).toEqual([deep.path, top.path].sort());
    expect((await listNotes(ROOT)).map((n) => n.folder ?? "")).toEqual(["admin"]);
    expect((await listNotes(ROOT))[0]?.path).toBe(outside.path); // untouched
    // deleteFolder removes the directory and the subdirectory under it.
    // listNotes hides an emptied folder either way, but one left on disk would
    // make a later rename onto its name fail.
    await expect(stat(join(ROOT, "projects"))).rejects.toThrow();
  });

  test("each note lands in its own mirrored folder, so a restore rebuilds the folder around it", async () => {
    // deleteFolder renames each note into the trash rather than renaming the
    // directory. The trash mirrors the workspace's folders (architecture.md
    // §3), so each trashed note keeps its own origin and gets its own Trash
    // row. Undoing the folder delete is then N restores rather than a second
    // mechanism.
    await createNote(ROOT, "# Plan\n", "projects");
    await createNote(ROOT, "# Api\n", "projects/api");
    const { trashed } = await deleteFolder(ROOT, "projects");
    expect(trashed.map((t) => relative(TRASH, t.to)).sort()).toEqual(
      [join("projects", "plan.md"), join("projects", "api", "api.md")].sort(),
    );
    expect((await listTrash(ROOT)).length).toBe(2);
    for (const { to } of trashed) await restoreNote(to);
    expect((await listNotes(ROOT)).map((n) => n.folder ?? "").sort()).toEqual(["projects", "projects/api"]);
  });

  test("a sibling whose name starts the same is not swept up", async () => {
    // The prefix test in folderContains (shared/folders.ts), on the delete
    // side: `a` must not take its sibling `ab` with it.
    await createNote(ROOT, "# In\n", "a");
    const sibling = await createNote(ROOT, "# Beside\n", "ab");
    const { trashed } = await deleteFolder(ROOT, "a");
    expect(trashed).toHaveLength(1);
    expect((await listNotes(ROOT)).map((n) => n.path)).toEqual([sibling.path]);
  });

  test("a file the note list never showed is left alone, and keeps its folder", async () => {
    // deleteFolder deletes the notes one by one rather than renaming the
    // directory into the trash. The Trash section lists .md files only, so a
    // non-note moved there would be unreachable from the app. The directory
    // then stays: rmdir refuses a directory with anything left in it, and that
    // refusal is the guard.
    await createNote(ROOT, "# Plan\n", "projects");
    await writeRaw(join(ROOT, "projects", "diagram.png"), "PNG", "utf8");
    const { trashed } = await deleteFolder(ROOT, "projects");
    expect(trashed).toHaveLength(1);
    expect(await readRaw(join(ROOT, "projects", "diagram.png"), "utf8")).toBe("PNG");
    expect(await listNotes(ROOT)).toEqual([]); // the folder is gone from the list all the same
  });

  test("an ignored subtree keeps its notes and its folder", async () => {
    // The same rule, with real notes this time. .ledgeignore is why the
    // listNotes walk never saw them. A directory move would have taken them
    // into the trash, where nothing lists them.
    await writeRaw(join(ROOT, ".ledgeignore"), "projects/drafts\n");
    await mkdir(join(ROOT, "projects", "drafts"), { recursive: true });
    await writeRaw(join(ROOT, "projects", "drafts", "wip.md"), "# Wip\n", "utf8");
    await createNote(ROOT, "# Plan\n", "projects");
    const { trashed } = await deleteFolder(ROOT, "projects");
    expect(trashed).toHaveLength(1);
    expect(await readRaw(join(ROOT, "projects", "drafts", "wip.md"), "utf8")).toBe("# Wip\n");
  });

  test("a locked note goes with the vault shut, like a folder rename", async () => {
    // Deleting reads no body either. It renames the file, so the sealed bytes
    // are unchanged and the note is still locked in the trash.
    resetVaultForTests();
    await createVault("test passphrase");
    const note = await createNote(ROOT, "# Secrets\n\nplutonium\n", "old");
    await lockNote(note.path);
    const sealed = await readRaw(note.path, "utf8");
    lockVault();
    const { trashed } = await deleteFolder(ROOT, "old");
    expect(trashed).toHaveLength(1);
    expect(await readRaw(trashed[0]!.to, "utf8")).toBe(sealed);
    expect(await isNoteLocked(trashed[0]!.to)).toBe(true);
  });

  test("the workspace's own folder is not a folder row, and is refused", async () => {
    await createNote(ROOT, "# A\n");
    await expect(deleteFolder(ROOT, "")).rejects.toThrow(/workspace strip/);
    expect(await listNotes(ROOT)).toHaveLength(1);
  });

  test("a folder that is not there is refused, which is also what a second delete gets", async () => {
    await createNote(ROOT, "# A\n", "old");
    await deleteFolder(ROOT, "old");
    await expect(deleteFolder(ROOT, "old")).rejects.toThrow(/no "old" folder/);
  });

  test("the root has to be a registered workspace, like every other mutating call", async () => {
    const stranger = join(APP_HOME, "unregistered");
    await mkdir(join(stranger, "old"), { recursive: true });
    await writeRaw(join(stranger, "old", "a.md"), "# A\n", "utf8");
    await expect(deleteFolder(stranger, "old")).rejects.toThrow(/not a registered workspace root/);
  });
});

describe("the unlink paths", () => {
  test("deleteTrashed removes the file for good; a second call reports it already gone", async () => {
    const trashed = (await deleteNote((await createNote(ROOT, "# Gone\n")).path))!;
    expect(await deleteTrashed(trashed)).toBe(true);
    await expect(stat(trashed)).rejects.toThrow();
    expect(await deleteTrashed(trashed)).toBe(false);
  });

  test("refuses anything that is not a .md visibly inside a registered root's trash", async () => {
    // assertTrashed is the only check on a permanent delete. deleteTrashed
    // unlinks, so which paths that guard accepts is what separates a Trash row
    // from an arbitrary file the view named.
    for (const path of [
      "/etc/passwd",
      join(ROOT, "live-note.md"), // a live note, not a trashed one
      join(TRASH, "notes.txt"), // not a note
      TRASH, // the folder itself
      join(TRASH, "..", "escape.md"),
      join(TRASH, ".hidden", "buried.md"), // a dot-segment: no listing ever showed it
      join(APP_HOME, ".ledge-trash", "old-world.md"), // the app home is not a root anymore
    ]) {
      expect(deleteTrashed(path)).rejects.toThrow(/not a trashed note/);
    }
  });

  test("accepts a .md nested in the trash, because that is where a folder's deletes land", async () => {
    // Why assertTrashed accepts a nested path rather than "directly inside"
    // (testing.md §3): the trash mirrors the workspace's folders, so refusing
    // depth would refuse to empty the notes the mirroring is for.
    const note = await createNote(ROOT, "# Nested\n", "projects/api");
    const trashed = (await deleteNote(note.path))!;
    expect(relative(TRASH, trashed)).toBe(join("projects", "api", "nested.md"));
    expect(await deleteTrashed(trashed)).toBe(true);
  });

  test("emptyTrash removes exactly what listTrash showed, and nothing it did not", async () => {
    await deleteNote((await createNote(ROOT, "# A\n")).path);
    await deleteNote((await createNote(ROOT, "# B\n")).path);
    // Two things that reached the trash folder by some route other than a
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
    expect(await purgeTrash(ROOT, 60_000)).toBe(0); // not a minute old
    expect((await listTrash(ROOT)).length).toBe(1);
    // A negative TTL puts the cutoff in the future, so a file trashed just now
    // counts as older than it. That ages a note without waiting. ctime cannot
    // be set, and listTrash reads it as the deleted-at time.
    expect(await purgeTrash(ROOT, -60_000)).toBe(1);
    expect(await listTrash(ROOT)).toEqual([]);
  });
});

// --- favorites -----------------------------------------------------------
// The marker is ordinary frontmatter that a command happens to write, so these
// check the two things that makes true: the rest of the note is untouched, and
// a locked note takes the marker without its body being read.
describe("favoriteNote", () => {
  test("marking adds the line and lists the note as a favorite", async () => {
    const note = await createNote(ROOT, "# Runbook\n\nsteps\n");
    const meta = await favoriteNote(note.path, true);
    expect(meta.favorite).toBe(true);
    expect(await readRaw(note.path, "utf8")).toBe("---\nfavorite: true\n---\n# Runbook\n\nsteps\n");
    expect((await listNotes(ROOT))[0]?.favorite).toBe(true);
  });

  test("unmarking restores the exact original bytes", async () => {
    const original = "# Runbook\n\nsteps\n";
    const note = await createNote(ROOT, original);
    await favoriteNote(note.path, true);
    const meta = await favoriteNote(note.path, false);
    expect(meta.favorite).toBeUndefined();
    expect(await readRaw(note.path, "utf8")).toBe(original);
  });

  test("the frontmatter around the marker survives both directions", async () => {
    const note = await createNote(ROOT, "---\ncwd: /tmp\ntags: work\n---\n# Runbook\n\nsteps\n");
    await favoriteNote(note.path, true);
    expect(await readRaw(note.path, "utf8")).toContain("cwd: /tmp");
    await favoriteNote(note.path, false);
    expect(await readRaw(note.path, "utf8")).toBe("---\ncwd: /tmp\ntags: work\n---\n# Runbook\n\nsteps\n");
  });

  test("marking a note that is already marked writes nothing", async () => {
    // The listing a command fires from can be a beat stale, so the second call
    // has to be a no-op rather than a rewrite: an untouched mtime is what
    // keeps an open buffer from being reloaded for nothing.
    const note = await createNote(ROOT, "# Runbook\n\nsteps\n");
    await favoriteNote(note.path, true);
    const before = (await stat(note.path)).mtimeMs;
    await favoriteNote(note.path, true);
    expect((await stat(note.path)).mtimeMs).toBe(before);
  });

  test("a locked note takes the marker with the vault shut, and stays sealed", async () => {
    resetVaultForTests();
    await createVault("test passphrase");
    const note = await createNote(ROOT, "# Secrets\n\nplutonium shipment schedule\n");
    await lockNote(note.path);
    lockVault();
    const meta = await favoriteNote(note.path, true);
    expect(meta.favorite).toBe(true);
    expect(meta.locked).toBe(true);
    const raw = await readRaw(note.path, "utf8");
    expect(raw).toContain("favorite: true");
    expect(raw).toContain("locked: v1.");
    expect(raw).not.toContain("plutonium shipment schedule");
    // And the body still opens: the marker went into the head, which is not
    // what the seal authenticates.
    await unlockVault("test passphrase");
    expect((await readNote(note.path))?.text).toContain("plutonium shipment schedule");
  });

  test("a note that is gone is an error, not a new file", async () => {
    expect(favoriteNote(join(ROOT, "nothing-here.md"), true)).rejects.toThrow(/no note/);
  });
});

// --- note locking (locking.md) -----------------------------------------
// These tests check that a lock leaves no plaintext on disk: not in the note,
// not in a later save, not in the divergence guard's trash copies. Titles,
// frontmatter tags and the agent-facing skips behave as locking.md §4 and §6
// describe. vault.test.ts covers the crypto; this covers the seams.
describe("note locking", () => {
  beforeEach(async () => {
    resetVaultForTests(); // wiping the app home does not clear the module's key
    await createVault("test passphrase");
  });

  const NEEDLE = "plutonium shipment schedule";

  test("locking seals the body on disk; reading decrypts it back, flagged", async () => {
    const note = await createNote(ROOT, `# Secrets\n\n${NEEDLE}\n`);
    await lockNote(note.path);
    const raw = await readRaw(note.path, "utf8");
    expect(raw).not.toContain(NEEDLE);
    expect(raw).toContain("locked: v1.");
    expect(raw).toContain("# Secrets\n"); // the title stays plaintext (locking.md §6)
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

  test("a save keeps the empty block the frontmatter editor just opened", async () => {
    const note = await createNote(ROOT, "# Plain\n\nbody\n");
    await writeNote(note.path, "---\n\n---\n# Plain\n\nbody\n");
    expect(await readRaw(note.path, "utf8")).toBe("---\n\n---\n# Plain\n\nbody\n");
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
    // The sleep goes before the foreign write, not after it. The guard
    // compares the file's mtime against `base`, so that write needs a later
    // timestamp than the read `base` came from. On a filesystem with
    // whole-millisecond timestamps, the lock, the read and the write would
    // otherwise land in one millisecond and the guard would see no divergence.
    await new Promise((r) => setTimeout(r, 5)); // mtime granularity
    const cipher = await readRaw(note.path, "utf8");
    await writeRaw(note.path, cipher + "external-scribble\n");
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

    // One note carries both: a frontmatter tag and an inline #hidden.
    // Frontmatter tags live in the plaintext head, so they stay visible
    // (locking.md §6). The inline tag is inside the sealed body, so the scans
    // do not see it.
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

// Passphrase change: the headers and asset wraps are rewritten, the bodies are
// not, and the old passphrase stops opening anything.
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
    // The bodies still open in this session: the data keys are unchanged.
    expect((await readNote(a.path))?.text).toContain("first secret body");
    // Across a cold start, only the new passphrase derives the key.
    resetVault2();
    await loadVault();
    expect(await unlockV("old pass")).toBe(false);
    expect(await unlockV("new pass")).toBe(true);
    expect((await readNote(b.path))?.text).toContain("second secret body");
  });
});
