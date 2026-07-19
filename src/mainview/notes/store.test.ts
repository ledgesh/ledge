import { afterEach, describe, expect, test } from "bun:test";
import { configureNotes, type NoteMeta } from "./channel";
import { recordWorkspaceKinds, resetWorkspaceKinds } from "../workspace/channel";
import { slugOf } from "../../shared/slug";
import type { NoteParams } from "../../shared/frontmatter";
import {
  bindDoc,
  flushAll,
  forgetDoc,
  freezeDoc,
  noteChanged,
  releaseDoc,
  reloadCandidates,
  reseedDoc,
  resetDocs,
  retargetDoc,
  saveNow,
  seedSlug,
  type DocHandlers,
} from "./store";

// A stand-in for the Bun note store. Writes are recorded; each call's promise can
// be held open (`gate`) so the tests can drive what happens *during* a save, which
// is where the interesting races live.
// Every doc in these tests lives in one workspace folder; bind() below bakes
// it in so the cases read as before the per-workspace split.
const FOLDER = "/notes";
const bind = (docId: string, path: string | null, handlers: DocHandlers) =>
  bindDoc(docId, path, FOLDER, handlers);

function fakeBridge() {
  const writes: Array<{ path: string; text: string }> = [];
  // The baseMtimeMs each write stated — the external-edit guard's expectation.
  const writeBases: Array<number | null> = [];
  const creates: string[] = [];
  const createFolders: string[] = [];
  const retitles: Array<{ path: string; text: string }> = [];
  const configures: Array<{ sessionId: string; params: NoteParams; notePath: string | null }> = [];
  let created = 0;
  const state = {
    writes,
    writeBases,
    creates,
    createFolders,
    retitles,
    configures,
    failNextRetitle: false,
    // When set, every write parks on this promise until it is resolved.
    gate: null as { promise: Promise<void>; open: () => void } | null,
    failNextWrite: false,
    hold() {
      let open!: () => void;
      const promise = new Promise<void>((res) => {
        open = () => res();
      });
      state.gate = { promise, open };
      return () => {
        state.gate = null;
        open();
      };
    },
  };

  configureNotes({
    list: async () => [],
    read: async () => null,
    search: async () => ({ hits: [], lockedSkipped: 0 }),
    backlinks: async () => ({ backlinks: [], lockedSkipped: 0 }),
    tags: async () => ({ tags: [], lockedSkipped: 0 }),
    tagged: async () => ({ hits: [], lockedSkipped: 0 }),
    takeOpenRequest: async () => null,
    // The store never calls these (they are command-layer capabilities); the
    // stubs exist to satisfy the handler shape.
    openDaily: async () => {
      throw new Error("unused in store tests");
    },
    createFromTemplate: async () => {
      throw new Error("unused in store tests");
    },
    write: async (path, text, baseMtimeMs) => {
      if (state.gate) await state.gate.promise;
      if (state.failNextWrite) {
        state.failNextWrite = false;
        throw new Error("disk on fire");
      }
      writes.push({ path, text });
      writeBases.push(baseMtimeMs);
      // Successive writes get successive versions, like a real disk.
      return { mtimeMs: 1000 + writes.length, divergedTo: null };
    },
    create: async (folder, text): Promise<NoteMeta> => {
      if (state.gate) await state.gate.promise;
      createFolders.push(folder);
      creates.push(text);
      created += 1;
      // The real createNote names from the H1 too; keep the enumerated shape so
      // the existing tests still read straight.
      const path = `/notes/untitled-${created}.md`;
      return { path, title: `untitled-${created}`, mtimeMs: created };
    },
    // Stands in for Bun's retitleNote: derives the name from the text's H1, the
    // same rule the real one uses.
    retitle: async (path: string, text: string): Promise<NoteMeta> => {
      retitles.push({ path, text });
      if (state.failNextRetitle) {
        state.failNextRetitle = false;
        throw new Error("rename refused");
      }
      const slug = slugOf(text) ?? "untitled";
      return { path: `/notes/${slug}.md`, title: slug, mtimeMs: 0 };
    },
    // The trash half of the bridge: nothing in the save controller touches it,
    // but the shim is one interface and it has to be whole.
    remove: async () => null,
    trash: async () => [],
    restore: async (path: string) => ({ path, title: "", mtimeMs: 0 }),
    removeTrashed: async () => true,
    empty: async () => 0,
    configureSession: (sessionId, params, notePath) => {
      configures.push({ sessionId, params, notePath });
    },
  });

  return state;
}

// Handlers a test does not care about. Spread over to override just the one it does.
const noop = (): DocHandlers => ({ onFile: () => {}, onTitle: () => {} });

const tick = () => new Promise((r) => setTimeout(r, 0));
// Comfortably past the store's 500ms autosave debounce.
const pastDebounce = () => new Promise((r) => setTimeout(r, 600));

afterEach(() => {
  resetDocs();
  resetWorkspaceKinds();
});

describe("binding", () => {
  test("changes to an unregistered doc are ignored", async () => {
    const fs = fakeBridge();
    noteChanged("doc-nobody", "hello");
    await saveNow("doc-nobody");
    expect(fs.creates).toEqual([]);
    expect(fs.writes).toEqual([]);
  });

  test("a bound but untouched note writes nothing: opening a tab creates no file", async () => {
    const fs = fakeBridge();
    bind("doc-1", null, noop());
    await saveNow("doc-1");
    expect(fs.creates).toEqual([]);
    expect(fs.writes).toEqual([]);
  });

  test("re-binding an open note keeps its allocated path", async () => {
    const fs = fakeBridge();
    bind("doc-1", null, noop());
    noteChanged("doc-1", "one");
    await saveNow("doc-1");

    // A tab re-attach (pane switch) rebinds with the path the TAB knows, which is
    // still null if the reducer has not caught up. The store must not forget the
    // file it just allocated and create a second one.
    bind("doc-1", null, noop());
    noteChanged("doc-1", "two");
    await saveNow("doc-1");

    expect(fs.creates).toEqual(["one"]);
    expect(fs.writes).toEqual([{ path: "/notes/untitled-1.md", text: "two" }]);
  });
});

describe("first save allocates a file", () => {
  test("a pathless note is created once, then written to its new path", async () => {
    const fs = fakeBridge();
    const seen: NoteMeta[] = [];
    bind("doc-1", null, { ...noop(), onFile: (note) => seen.push(note) });

    noteChanged("doc-1", "first");
    await saveNow("doc-1");
    noteChanged("doc-1", "second");
    await saveNow("doc-1");

    expect(fs.creates).toEqual(["first"]);
    expect(fs.writes).toEqual([{ path: "/notes/untitled-1.md", text: "second" }]);
    expect(seen.map((n) => n.path)).toEqual(["/notes/untitled-1.md"]);
  });

  test("a note that already has a file never creates one", async () => {
    const fs = fakeBridge();
    bind("doc-1", "/notes/existing.md", noop());
    noteChanged("doc-1", "edited");
    await saveNow("doc-1");

    expect(fs.creates).toEqual([]);
    expect(fs.writes).toEqual([{ path: "/notes/existing.md", text: "edited" }]);
  });

  test("the file is created in the folder the doc was bound with — the tab's workspace", async () => {
    // The folder captured at bindDoc is what keeps a first save landing in the
    // note's own workspace, wherever the selection is by the time it fires.
    const fs = fakeBridge();
    bindDoc("doc-1", null, "/elsewhere", noop());
    noteChanged("doc-1", "first");
    await saveNow("doc-1");
    expect(fs.createFolders).toEqual(["/elsewhere"]);
  });
});

describe("in-flight edits", () => {
  test("edits during a save are coalesced into one follow-up write of the latest text", async () => {
    const fs = fakeBridge();
    bind("doc-1", "/notes/a.md", noop());
    const release = fs.hold();

    noteChanged("doc-1", "v1");
    const saving = saveNow("doc-1");
    await tick();

    // Two more edits land while the first write is still parked in Bun.
    noteChanged("doc-1", "v2");
    noteChanged("doc-1", "v3");
    release();
    await saving;
    await tick();

    // v2 is never written on its own: the running flush picks up only the newest.
    expect(fs.writes).toEqual([
      { path: "/notes/a.md", text: "v1" },
      { path: "/notes/a.md", text: "v3" },
    ]);
  });

  test("a second save during an in-flight create does not allocate a second file", async () => {
    const fs = fakeBridge();
    bind("doc-1", null, noop());
    const release = fs.hold();

    noteChanged("doc-1", "first");
    const saving = saveNow("doc-1");
    await tick();

    // A Cmd+S landing while the create is still in flight.
    noteChanged("doc-1", "second");
    const racing = saveNow("doc-1");
    release();
    await Promise.all([saving, racing]);
    await tick();

    expect(fs.creates).toEqual(["first"]);
    expect(fs.writes).toEqual([{ path: "/notes/untitled-1.md", text: "second" }]);
  });
});

describe("autosave debounce", () => {
  test("a burst of keystrokes writes once, with the final text", async () => {
    const fs = fakeBridge();
    bind("doc-1", "/notes/a.md", noop());
    noteChanged("doc-1", "h");
    noteChanged("doc-1", "he");
    noteChanged("doc-1", "hel");
    noteChanged("doc-1", "hello");
    expect(fs.writes).toEqual([]); // nothing yet: still inside the debounce

    await pastDebounce();
    expect(fs.writes).toEqual([{ path: "/notes/a.md", text: "hello" }]);
  });

  test("flushAll saves every dirty note now", async () => {
    const fs = fakeBridge();
    bind("doc-1", "/notes/a.md", noop());
    bind("doc-2", "/notes/b.md", noop());
    noteChanged("doc-1", "a-text");
    noteChanged("doc-2", "b-text");

    flushAll();
    await tick();

    expect(fs.writes).toContainEqual({ path: "/notes/a.md", text: "a-text" });
    expect(fs.writes).toContainEqual({ path: "/notes/b.md", text: "b-text" });
  });
});

describe("releaseDoc", () => {
  test("a pending edit still reaches disk when the tab closes", async () => {
    const fs = fakeBridge();
    bind("doc-1", "/notes/a.md", noop());
    noteChanged("doc-1", "unsaved");

    releaseDoc("doc-1"); // tab closed inside the debounce window
    await tick();

    expect(fs.writes).toEqual([{ path: "/notes/a.md", text: "unsaved" }]);
  });

  test("a closed note is deregistered: later changes are ignored", async () => {
    const fs = fakeBridge();
    bind("doc-1", "/notes/a.md", noop());
    releaseDoc("doc-1");
    await tick();

    noteChanged("doc-1", "zombie");
    await pastDebounce();
    expect(fs.writes).toEqual([]);
  });
});

describe("failure", () => {
  test("a failed write leaves the note dirty: the edit is retried, not dropped", async () => {
    const fs = fakeBridge();
    bind("doc-1", "/notes/a.md", noop());

    fs.failNextWrite = true;
    noteChanged("doc-1", "v1");
    await saveNow("doc-1");
    expect(fs.writes).toEqual([]); // the write threw

    // No further edit: the retry alone must still get v1 onto disk.
    await saveNow("doc-1");
    expect(fs.writes).toEqual([{ path: "/notes/a.md", text: "v1" }]);
  });

  test("an edit arriving after a failed write supersedes the text that failed", async () => {
    const fs = fakeBridge();
    bind("doc-1", "/notes/a.md", noop());

    fs.failNextWrite = true;
    noteChanged("doc-1", "v1");
    await saveNow("doc-1");

    noteChanged("doc-1", "v2");
    await saveNow("doc-1");
    expect(fs.writes).toEqual([{ path: "/notes/a.md", text: "v2" }]);
  });
});

// The rename/delete flows (notes/actions.ts) drive these three. What they are all
// guarding is the gap while Bun is moving a file: the note is still being typed
// into, and a save landing in that gap writes to a path that is about to be, or
// has just been, wrong.
describe("moving and losing a note's file", () => {
  test("a frozen note keeps collecting edits but writes none of them", async () => {
    const fs = fakeBridge();
    bind("doc-1", "/notes/a.md", noop());

    freezeDoc("doc-1");
    noteChanged("doc-1", "typed mid-rename");
    await saveNow("doc-1");
    expect(fs.writes).toEqual([]);
  });

  test("retargeting writes what piled up while frozen, to the NEW path", async () => {
    const fs = fakeBridge();
    bind("doc-1", "/notes/a.md", noop());

    freezeDoc("doc-1");
    noteChanged("doc-1", "typed mid-rename");
    retargetDoc("doc-1", "/notes/b.md");
    await tick();

    // The old path is never touched: this is the resurrected-duplicate bug.
    expect(fs.writes).toEqual([{ path: "/notes/b.md", text: "typed mid-rename" }]);
  });

  test("a clean note that is renamed writes nothing at all", async () => {
    const fs = fakeBridge();
    bind("doc-1", "/notes/a.md", noop());

    freezeDoc("doc-1");
    retargetDoc("doc-1", "/notes/b.md");
    await tick();
    expect(fs.writes).toEqual([]);
  });

  test("saves after a rename go to the new path", async () => {
    const fs = fakeBridge();
    bind("doc-1", "/notes/a.md", noop());
    freezeDoc("doc-1");
    retargetDoc("doc-1", "/notes/b.md");

    noteChanged("doc-1", "after");
    await saveNow("doc-1");
    expect(fs.writes).toEqual([{ path: "/notes/b.md", text: "after" }]);
  });

  test("a refused rename leaves the note saving to the path it still has", async () => {
    const fs = fakeBridge();
    bind("doc-1", "/notes/a.md", noop());

    // What actions.ts does when Bun rejects the name: retarget at the old path.
    freezeDoc("doc-1");
    retargetDoc("doc-1", "/notes/a.md");

    noteChanged("doc-1", "still works");
    await saveNow("doc-1");
    expect(fs.writes).toEqual([{ path: "/notes/a.md", text: "still works" }]);
  });

  test("a forgotten note drops its pending edit: a deleted note must not come back", async () => {
    const fs = fakeBridge();
    bind("doc-1", "/notes/a.md", noop());

    noteChanged("doc-1", "unsaved words");
    forgetDoc("doc-1");

    // Both the debounce and the teardown path have to come up empty. releaseDoc is
    // what the editor pool calls moments later as the tab closes; if forgetDoc had
    // merely deregistered the note, this is where the file would reappear.
    releaseDoc("doc-1");
    await pastDebounce();
    expect(fs.writes).toEqual([]);
    expect(fs.creates).toEqual([]);
  });

  test("forgetting stops a flush that is already running from starting another lap", async () => {
    const fs = fakeBridge();
    bind("doc-1", "/notes/a.md", noop());

    const release = fs.hold();
    noteChanged("doc-1", "v1");
    void saveNow("doc-1"); // parks inside the write

    // An edit lands while that write is in flight, then the note is deleted. The
    // in-flight write cannot be recalled, but v2 must never be written.
    noteChanged("doc-1", "v2");
    forgetDoc("doc-1");
    release();
    await pastDebounce();

    expect(fs.writes).toEqual([{ path: "/notes/a.md", text: "v1" }]);
  });

  test("freezing an unknown doc is a no-op, not a throw", () => {
    fakeBridge();
    expect(() => freezeDoc("nobody")).not.toThrow();
    expect(() => retargetDoc("nobody", "/notes/x.md")).not.toThrow();
    expect(() => forgetDoc("nobody")).not.toThrow();
  });
});

// A note's filename follows its first-line H1. The rule that makes that safe is
// that only a CHANGE to the heading moves the file, measured against the heading
// the note already had when it was opened.
describe("naming by heading", () => {
  const titled = (h: string, body = "body") => `# ${h}\n\n${body}\n`;

  test("editing the body of a titled note never moves its file", async () => {
    const fs = fakeBridge();
    bind("doc-1", "/notes/shipping-notes.md", noop());
    seedSlug("doc-1", titled("Shipping Notes"));

    noteChanged("doc-1", titled("Shipping Notes", "more words"));
    await saveNow("doc-1");

    expect(fs.writes).toHaveLength(1);
    expect(fs.retitles).toEqual([]);
  });

  // The migration guard, and the reason seedSlug exists at all. A note that
  // predates this rule (untitled-2.md holding "# test-123") must not be moved out
  // from under the user the first time they touch it.
  test("a note whose filename disagrees with its heading is left where it is", async () => {
    const fs = fakeBridge();
    bind("doc-1", "/notes/untitled-2.md", noop());
    seedSlug("doc-1", titled("test-123"));

    noteChanged("doc-1", titled("test-123", "editing away"));
    await saveNow("doc-1");

    expect(fs.retitles).toEqual([]);
  });

  test("editing the heading moves the file and tells the tab where it went", async () => {
    const fs = fakeBridge();
    const moves: Array<{ path: string; prev: string | null }> = [];
    bind("doc-1", "/notes/shipping-notes.md", {
      ...noop(),
      onFile: (note, prev) => moves.push({ path: note.path, prev }),
    });
    seedSlug("doc-1", titled("Shipping Notes"));

    noteChanged("doc-1", titled("Shipping Plans"));
    await saveNow("doc-1");

    expect(fs.retitles).toHaveLength(1);
    expect(moves).toEqual([{ path: "/notes/shipping-plans.md", prev: "/notes/shipping-notes.md" }]);
  });

  test("later saves go to the new path", async () => {
    const fs = fakeBridge();
    bind("doc-1", "/notes/shipping-notes.md", noop());
    seedSlug("doc-1", titled("Shipping Notes"));

    noteChanged("doc-1", titled("Shipping Plans"));
    await saveNow("doc-1");
    noteChanged("doc-1", titled("Shipping Plans", "after"));
    await saveNow("doc-1");

    expect(fs.writes.at(-1)).toEqual({ path: "/notes/shipping-plans.md", text: titled("Shipping Plans", "after") });
  });

  test("a heading edit that does not change the slug moves nothing", async () => {
    const fs = fakeBridge();
    bind("doc-1", "/notes/shipping-notes.md", noop());
    seedSlug("doc-1", titled("Shipping Notes"));

    // Punctuation and case wash out of the slug, so there is no rename to do.
    noteChanged("doc-1", titled("shipping notes!"));
    await saveNow("doc-1");

    expect(fs.retitles).toEqual([]);
  });

  test("removing the heading keeps the name the note already has", async () => {
    const fs = fakeBridge();
    bind("doc-1", "/notes/shipping-notes.md", noop());
    seedSlug("doc-1", titled("Shipping Notes"));

    // Renaming this back to untitled.md would be a nasty surprise, and would
    // collide with any real untitled.md besides.
    noteChanged("doc-1", "just prose now\n");
    await saveNow("doc-1");

    expect(fs.retitles).toEqual([]);
    expect(fs.writes.at(-1)!.path).toBe("/notes/shipping-notes.md");
  });

  test("giving an untitled note a heading names it", async () => {
    const fs = fakeBridge();
    bind("doc-1", "/notes/untitled.md", noop());
    seedSlug("doc-1", "no heading yet\n");

    noteChanged("doc-1", titled("Shipping Notes"));
    await saveNow("doc-1");

    expect(fs.retitles).toHaveLength(1);
  });

  test("a note created from titled text is not renamed straight after", async () => {
    // createNote already names from the H1, so the create IS the naming: a retitle
    // on top of it would be a pointless second trip to the disk.
    const fs = fakeBridge();
    bind("doc-1", null, noop());

    noteChanged("doc-1", titled("Shipping Notes"));
    await saveNow("doc-1");

    expect(fs.creates).toEqual([titled("Shipping Notes")]);
    expect(fs.retitles).toEqual([]);
  });

  test("an unseeded note records its heading rather than acting on it", async () => {
    // A note whose load never landed (deleted behind our back). First sight of its
    // text must not be read as "the heading just changed".
    const fs = fakeBridge();
    bind("doc-1", "/notes/whatever.md", noop());

    noteChanged("doc-1", titled("Shipping Notes"));
    await saveNow("doc-1");
    expect(fs.retitles).toEqual([]);

    // But a real change after that is honoured.
    noteChanged("doc-1", titled("Shipping Plans"));
    await saveNow("doc-1");
    expect(fs.retitles).toHaveLength(1);
  });

  test("a refused rename is retried, not silently forgotten", async () => {
    const fs = fakeBridge();
    bind("doc-1", "/notes/shipping-notes.md", noop());
    seedSlug("doc-1", titled("Shipping Notes"));

    fs.failNextRetitle = true;
    noteChanged("doc-1", titled("Shipping Plans"));
    await saveNow("doc-1");
    expect(fs.retitles).toHaveLength(1);

    // The heading has not been dealt with, so the next save must try again rather
    // than treat the new slug as already applied.
    await saveNow("doc-1");
    expect(fs.retitles).toHaveLength(2);
  });

  test("seeding an already-seeded note does not overwrite what it knows", async () => {
    const fs = fakeBridge();
    bind("doc-1", "/notes/shipping-notes.md", noop());
    seedSlug("doc-1", titled("Shipping Notes"));
    seedSlug("doc-1", titled("Something Else")); // a second load; must not stick

    noteChanged("doc-1", titled("Shipping Notes", "edited"));
    await saveNow("doc-1");
    expect(fs.retitles).toEqual([]);
  });
});

// The tab and browser show the note's heading, not its filename. That label moves
// on its own schedule: more often than the file does, and sometimes when the file
// does not move at all.
describe("labelling", () => {
  const titled = (h: string, body = "body") => `# ${h}\n\n${body}\n`;
  const labelsOf = (): { labels: string[]; handlers: DocHandlers } => {
    const labels: string[] = [];
    return { labels, handlers: { onFile: () => {}, onTitle: (l) => labels.push(l) } };
  };

  test("editing the heading relabels the note", async () => {
    const { labels, handlers } = labelsOf();
    fakeBridge();
    bind("doc-1", "/notes/shipping-notes.md", handlers);
    seedSlug("doc-1", titled("Shipping Notes"));

    noteChanged("doc-1", titled("Shipping Plans"));
    await saveNow("doc-1");
    expect(labels).toEqual(["Shipping Plans"]);
  });

  // The case that forced the label to be tracked separately from the slug.
  test("a heading edit that renames nothing still relabels", async () => {
    const fs = fakeBridge();
    const { labels, handlers } = labelsOf();
    bind("doc-1", "/notes/shipping-notes.md", handlers);
    seedSlug("doc-1", titled("Shipping Notes"));

    // Same slug ("shipping-notes"), so no file moves...
    noteChanged("doc-1", titled("shipping notes!"));
    await saveNow("doc-1");

    expect(fs.retitles).toEqual([]);
    expect(labels).toEqual(["shipping notes!"]); // ...but the label is not stale
  });

  test("editing the body never relabels", async () => {
    const { labels, handlers } = labelsOf();
    fakeBridge();
    bind("doc-1", "/notes/shipping-notes.md", handlers);
    seedSlug("doc-1", titled("Shipping Notes"));

    noteChanged("doc-1", titled("Shipping Notes", "more words"));
    await saveNow("doc-1");
    expect(labels).toEqual([]);
  });

  test("deleting the heading falls the label back to the filename", async () => {
    const { labels, handlers } = labelsOf();
    fakeBridge();
    bind("doc-1", "/notes/shipping-notes.md", handlers);
    seedSlug("doc-1", titled("Shipping Notes"));

    noteChanged("doc-1", "just prose now\n");
    await saveNow("doc-1");
    // Not "Untitled": the file is still shipping-notes.md, and it still says so.
    expect(labels).toEqual(["shipping-notes"]);
  });

  test("a new note with no heading is labelled by the file it just got", async () => {
    const { labels, handlers } = labelsOf();
    fakeBridge();
    bind("doc-1", null, handlers);
    seedSlug("doc-1", titled("Scratch"));

    // The save creates the file before the label is computed, so by then the note
    // HAS a name to fall back to. "Untitled" is only for a note with neither, which
    // means a note that has never saved, which never reaches this callback at all.
    noteChanged("doc-1", "no heading\n");
    await saveNow("doc-1");
    expect(labels).toEqual(["untitled-1"]);
  });

  test("a note loaded from disk is not relabelled just for being opened", async () => {
    const { labels, handlers } = labelsOf();
    fakeBridge();
    bind("doc-1", "/notes/shipping-notes.md", handlers);
    seedSlug("doc-1", titled("Shipping Notes"));

    noteChanged("doc-1", titled("Shipping Notes", "typing"));
    await saveNow("doc-1");
    expect(labels).toEqual([]);
  });
});

// Spawn params (frontmatter) reaching Bun: sent when a note's saved text lands
// (seedSlug) and when an edit changes what the frontmatter parses to — and at
// no other time, because nearly every note has no frontmatter and must cost
// nothing on this path. (The one addition: a workspace carrying a default cwd
// sends once at bindDoc — the block after this one.)
describe("params syncing", () => {
  const withFm = (inner: string, body = "# Note\n\nbody\n") => `---\n${inner}---\n${body}`;

  test("a loaded note's frontmatter reaches Bun before any edit", async () => {
    const fs = fakeBridge();
    bind("doc-1", "/notes/api-tests.md", noop());
    seedSlug("doc-1", withFm("cwd: /tmp/proj\nprofile: petstore\n"));

    // Two sends: the bind announces the note's location, the seed its params.
    expect(fs.configures).toHaveLength(2);
    expect(fs.configures[1].sessionId).toBe("doc-1");
    expect(fs.configures[1].params.cwd).toBe("/tmp/proj");
    expect(fs.configures[1].params.profile).toBe("petstore");
    expect(fs.configures[1].notePath).toBe("/notes/api-tests.md");
  });

  test("a note with no frontmatter announces its location once, then nothing", async () => {
    // The pre-facts economy was "no frontmatter, no send"; the location fact
    // deliberately amends it to one send per on-disk note — a shell must not
    // be born ignorant of LEDGE_NOTE just because the note has no params.
    const fs = fakeBridge();
    bind("doc-1", "/notes/plain.md", noop());
    seedSlug("doc-1", "# Plain\n\nbody\n");

    noteChanged("doc-1", "# Plain\n\nmore body\n");
    await saveNow("doc-1");
    expect(fs.configures).toHaveLength(1);
    expect(fs.configures[0].notePath).toBe("/notes/plain.md");
    expect(fs.configures[0].params.env).toEqual({});
  });

  test("a body edit does not re-send unchanged params", async () => {
    const fs = fakeBridge();
    bind("doc-1", "/notes/api-tests.md", noop());
    seedSlug("doc-1", withFm("cwd: /tmp/proj\n"));

    noteChanged("doc-1", withFm("cwd: /tmp/proj\n", "# Note\n\nedited body\n"));
    await saveNow("doc-1");
    expect(fs.configures).toHaveLength(2); // bind + seed, nothing since
  });

  test("editing the frontmatter sends the new params on save", async () => {
    const fs = fakeBridge();
    bind("doc-1", "/notes/api-tests.md", noop());
    seedSlug("doc-1", withFm("cwd: /tmp/old\n"));

    noteChanged("doc-1", withFm("cwd: /tmp/new\nenv:\n  A: 1\n"));
    await saveNow("doc-1");
    expect(fs.configures).toHaveLength(3);
    expect(fs.configures[2].params.cwd).toBe("/tmp/new");
    expect(fs.configures[2].params.env).toEqual({ A: "1" });
  });

  test("typing frontmatter into a new note sends params with its first save", async () => {
    const fs = fakeBridge();
    bind("doc-1", null, noop());

    noteChanged("doc-1", withFm("profile: petstore\n"));
    await saveNow("doc-1");
    expect(fs.configures).toHaveLength(1);
    expect(fs.configures[0].params.profile).toBe("petstore");
    // The first save allocated the file, and the fact rode the same send.
    expect(fs.configures[0].notePath).toBe("/notes/untitled-1.md");
  });

  test("an unsaved note sends no location: LEDGE_NOTE must not name a file that is not there", () => {
    const fs = fakeBridge();
    bind("doc-1", null, noop());
    expect(fs.configures).toEqual([]);
  });

  test("a rename re-sends the location fact: the next shell knows where the note IS", async () => {
    const fs = fakeBridge();
    bind("doc-1", "/notes/old-name.md", noop());
    seedSlug("doc-1", "# Old Name\n\nbody\n");

    noteChanged("doc-1", "# New Name\n\nbody\n");
    await saveNow("doc-1");
    const last = fs.configures[fs.configures.length - 1];
    expect(last.notePath).toBe("/notes/new-name.md");
  });

  test("deleting the frontmatter sends empty params: back to the defaults", async () => {
    const fs = fakeBridge();
    bind("doc-1", "/notes/api-tests.md", noop());
    seedSlug("doc-1", withFm("cwd: /tmp/proj\n"));

    noteChanged("doc-1", "# Note\n\nbody\n");
    await saveNow("doc-1");
    expect(fs.configures).toHaveLength(3);
    expect(fs.configures[2].params).toEqual({ cwd: null, profile: null, envFile: null, env: {}, hosts: [], tags: [], template: false, locked: null });
  });

  test("a comment-only frontmatter change re-sends nothing", async () => {
    // Comparison is on the PARSED params: annotating the block is not a change.
    const fs = fakeBridge();
    bind("doc-1", "/notes/api-tests.md", noop());
    seedSlug("doc-1", withFm("cwd: /tmp/proj\n"));

    noteChanged("doc-1", withFm("# the dev checkout\ncwd: /tmp/proj\n"));
    await saveNow("doc-1");
    expect(fs.configures).toHaveLength(2); // bind + seed
  });
});

// The per-workspace default cwd: a note with no `cwd:` of its own inherits
// its EXTERNAL workspace's folder (workspace/channel.ts workspaceDefaultCwd),
// merged into every params send. Managed workspaces have no default, which is
// what keeps the frontmatterless-note-sends-nothing economy above intact.
describe("workspace default cwd", () => {
  const withFm = (inner: string, body = "# Note\n\nbody\n") => `---\n${inner}---\n${body}`;
  const external = () => recordWorkspaceKinds([{ root: FOLDER, kind: "external", available: true }]);

  test("binding a note in an external workspace configures its folder as cwd at once", () => {
    const fs = fakeBridge();
    external();
    // No seedSlug, no edit: a fresh tab's first act may be a Run click, and
    // the shell it spawns must already be anchored to the workspace.
    bind("doc-1", null, noop());
    expect(fs.configures).toHaveLength(1);
    expect(fs.configures[0]).toEqual({
      sessionId: "doc-1",
      params: { cwd: FOLDER, profile: null, envFile: null, env: {}, hosts: [], tags: [], template: false, locked: null },
      notePath: null,
    });
  });

  test("a managed workspace's pathless note keeps the old economy: nothing sent", () => {
    // Only a PATHLESS note now: an on-disk note always announces its
    // location once (see "announces its location once" above).
    const fs = fakeBridge();
    recordWorkspaceKinds([{ root: FOLDER, kind: "managed", available: true }]);
    bind("doc-1", null, noop());
    expect(fs.configures).toEqual([]);
  });

  test("the note's own frontmatter cwd beats the workspace default", () => {
    const fs = fakeBridge();
    external();
    bind("doc-1", "/notes/api-tests.md", noop());
    seedSlug("doc-1", withFm("cwd: /tmp/proj\n"));
    expect(fs.configures).toHaveLength(2); // bind (folder), then the seed
    expect(fs.configures[1].params.cwd).toBe("/tmp/proj");
  });

  test("deleting the frontmatter cwd falls back to the workspace folder, not $HOME", async () => {
    const fs = fakeBridge();
    external();
    bind("doc-1", "/notes/api-tests.md", noop());
    seedSlug("doc-1", withFm("cwd: /tmp/proj\n"));
    noteChanged("doc-1", "# Note\n\nbody\n");
    await saveNow("doc-1");
    expect(fs.configures).toHaveLength(3);
    expect(fs.configures[2].params.cwd).toBe(FOLDER);
  });

  test("a plain note's load and edits re-send nothing past the bind", async () => {
    // The merged params are what lastParamsKey tracks, so the folder default
    // does not turn every body edit into a configure.
    const fs = fakeBridge();
    external();
    bind("doc-1", "/notes/plain.md", noop());
    seedSlug("doc-1", "# Plain\n\nbody\n");
    noteChanged("doc-1", "# Plain\n\nmore\n");
    await saveNow("doc-1");
    expect(fs.configures).toHaveLength(1); // the bind's, nothing since
  });
});

describe("external-edit safety: the save's expectation", () => {
  test("a loaded note's first save states the disk version its load carried", async () => {
    const fs = fakeBridge();
    bind("doc-1", "/notes/a.md", noop());
    seedSlug("doc-1", "# A\n\nbody\n", 777);
    noteChanged("doc-1", "# A\n\nedited\n");
    await saveNow("doc-1");
    expect(fs.writeBases).toEqual([777]);
  });

  test("each save's expectation is the previous save's reported version", async () => {
    const fs = fakeBridge();
    bind("doc-1", "/notes/a.md", noop());
    seedSlug("doc-1", "# A\n\nbody\n", 777);
    noteChanged("doc-1", "# A\n\none\n");
    await saveNow("doc-1");
    noteChanged("doc-1", "# A\n\ntwo\n");
    await saveNow("doc-1");
    expect(fs.writeBases).toEqual([777, 1001]); // the stub reported 1001 for the first write
  });

  test("a note created here states the create's version on its next save", async () => {
    const fs = fakeBridge();
    bind("doc-1", null, noop());
    noteChanged("doc-1", "# New\n");
    await saveNow("doc-1"); // allocates untitled-1.md, mtimeMs 1
    noteChanged("doc-1", "# New\n\nmore\n");
    await saveNow("doc-1");
    expect(fs.writeBases).toEqual([1]);
  });

  test("a note edited before its load landed saves blind — null expectation, the pre-guard behavior", async () => {
    const fs = fakeBridge();
    bind("doc-1", "/notes/a.md", noop());
    noteChanged("doc-1", "# A\n\ntyped before the read came back\n");
    await saveNow("doc-1");
    expect(fs.writeBases).toEqual([null]);
  });
});

describe("external-edit safety: reload", () => {
  test("only a clean, loaded note with a file is a reload candidate", () => {
    fakeBridge();
    bind("clean", "/notes/clean.md", noop());
    seedSlug("clean", "# Clean\n", 10);
    bind("dirty", "/notes/dirty.md", noop());
    seedSlug("dirty", "# Dirty\n", 20);
    noteChanged("dirty", "# Dirty\n\nmid-thought\n");
    bind("fileless", null, noop());
    bind("frozen", "/notes/frozen.md", noop());
    seedSlug("frozen", "# Frozen\n", 30);
    freezeDoc("frozen");
    bind("unloaded", "/notes/unloaded.md", noop()); // its read never landed: no seed
    expect(reloadCandidates()).toEqual([{ docId: "clean", path: "/notes/clean.md", mtimeMs: 10 }]);
  });

  test("adopting a disk edit relabels the tab and renames nothing — a disk H1 is a heading you opened, not one you edited", async () => {
    const fs = fakeBridge();
    const titles: string[] = [];
    bind("doc-1", "/notes/old-title.md", { onFile: () => {}, onTitle: (t) => titles.push(t) });
    seedSlug("doc-1", "# Old Title\n\nbody\n", 10);
    expect(reseedDoc("doc-1", "/notes/old-title.md", "# Agent Title\n\nrewritten\n", 20)).toBe(true);
    expect(titles).toEqual(["Agent Title"]);
    // A body edit after the adoption: the save's expectation is the adopted
    // version, and the unchanged (new) heading moves no file.
    noteChanged("doc-1", "# Agent Title\n\nrewritten, plus me\n");
    await saveNow("doc-1");
    expect(fs.retitles).toEqual([]);
    expect(fs.writeBases).toEqual([20]);
  });

  test("a heading the user edits AFTER an adoption still renames — the rename rule survives the reload", async () => {
    const fs = fakeBridge();
    bind("doc-1", "/notes/old-title.md", noop());
    seedSlug("doc-1", "# Old Title\n", 10);
    reseedDoc("doc-1", "/notes/old-title.md", "# Agent Title\n", 20);
    noteChanged("doc-1", "# My Title\n");
    await saveNow("doc-1");
    expect(fs.retitles).toHaveLength(1);
  });

  test("an entry that went dirty between the candidate list and the read is refused", () => {
    fakeBridge();
    const titles: string[] = [];
    bind("doc-1", "/notes/a.md", { onFile: () => {}, onTitle: (t) => titles.push(t) });
    seedSlug("doc-1", "# A\n", 10);
    noteChanged("doc-1", "# A\n\na keystroke landed\n");
    expect(reseedDoc("doc-1", "/notes/a.md", "# Agent\n", 20)).toBe(false);
    expect(titles).toEqual([]); // refused means untouched: no relabel, no adoption
  });

  test("an entry retargeted at another path since the candidate list is refused", () => {
    fakeBridge();
    bind("doc-1", "/notes/a.md", noop());
    seedSlug("doc-1", "# A\n", 10);
    expect(reseedDoc("doc-1", "/notes/elsewhere.md", "# B\n", 20)).toBe(false);
  });

  test("adopting a disk edit re-sends the frontmatter it carries", () => {
    const fs = fakeBridge();
    bind("doc-1", "/notes/a.md", noop());
    seedSlug("doc-1", "# A\n", 10);
    reseedDoc("doc-1", "/notes/a.md", "---\ncwd: /tmp/agent-proj\n---\n# A\n", 20);
    expect(fs.configures.at(-1)?.params.cwd).toBe("/tmp/agent-proj");
  });
});
