import { afterEach, describe, expect, test } from "bun:test";
import { configureNotes, type NoteMeta } from "./channel";
import { slugOf } from "../../shared/slug";
import {
  bindDoc,
  flushAll,
  forgetDoc,
  freezeDoc,
  noteChanged,
  releaseDoc,
  resetDocs,
  retargetDoc,
  saveNow,
  seedSlug,
  type DocHandlers,
} from "./store";

// A stand-in for the Bun note store. Writes are recorded; each call's promise can
// be held open (`gate`) so the tests can drive what happens *during* a save, which
// is where the interesting races live.
function fakeBridge() {
  const writes: Array<{ path: string; text: string }> = [];
  const creates: string[] = [];
  const retitles: Array<{ path: string; text: string }> = [];
  let created = 0;
  const state = {
    writes,
    creates,
    retitles,
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
    write: async (path, text) => {
      if (state.gate) await state.gate.promise;
      if (state.failNextWrite) {
        state.failNextWrite = false;
        throw new Error("disk on fire");
      }
      writes.push({ path, text });
    },
    create: async (text): Promise<NoteMeta> => {
      if (state.gate) await state.gate.promise;
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
    empty: async () => 0,
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
    bindDoc("doc-1", null, noop());
    await saveNow("doc-1");
    expect(fs.creates).toEqual([]);
    expect(fs.writes).toEqual([]);
  });

  test("re-binding an open note keeps its allocated path", async () => {
    const fs = fakeBridge();
    bindDoc("doc-1", null, noop());
    noteChanged("doc-1", "one");
    await saveNow("doc-1");

    // A tab re-attach (pane switch) rebinds with the path the TAB knows, which is
    // still null if the reducer has not caught up. The store must not forget the
    // file it just allocated and create a second one.
    bindDoc("doc-1", null, noop());
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
    bindDoc("doc-1", null, { ...noop(), onFile: (note) => seen.push(note) });

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
    bindDoc("doc-1", "/notes/existing.md", noop());
    noteChanged("doc-1", "edited");
    await saveNow("doc-1");

    expect(fs.creates).toEqual([]);
    expect(fs.writes).toEqual([{ path: "/notes/existing.md", text: "edited" }]);
  });
});

describe("in-flight edits", () => {
  test("edits during a save are coalesced into one follow-up write of the latest text", async () => {
    const fs = fakeBridge();
    bindDoc("doc-1", "/notes/a.md", noop());
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
    bindDoc("doc-1", null, noop());
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
    bindDoc("doc-1", "/notes/a.md", noop());
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
    bindDoc("doc-1", "/notes/a.md", noop());
    bindDoc("doc-2", "/notes/b.md", noop());
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
    bindDoc("doc-1", "/notes/a.md", noop());
    noteChanged("doc-1", "unsaved");

    releaseDoc("doc-1"); // tab closed inside the debounce window
    await tick();

    expect(fs.writes).toEqual([{ path: "/notes/a.md", text: "unsaved" }]);
  });

  test("a closed note is deregistered: later changes are ignored", async () => {
    const fs = fakeBridge();
    bindDoc("doc-1", "/notes/a.md", noop());
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
    bindDoc("doc-1", "/notes/a.md", noop());

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
    bindDoc("doc-1", "/notes/a.md", noop());

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
    bindDoc("doc-1", "/notes/a.md", noop());

    freezeDoc("doc-1");
    noteChanged("doc-1", "typed mid-rename");
    await saveNow("doc-1");
    expect(fs.writes).toEqual([]);
  });

  test("retargeting writes what piled up while frozen, to the NEW path", async () => {
    const fs = fakeBridge();
    bindDoc("doc-1", "/notes/a.md", noop());

    freezeDoc("doc-1");
    noteChanged("doc-1", "typed mid-rename");
    retargetDoc("doc-1", "/notes/b.md");
    await tick();

    // The old path is never touched: this is the resurrected-duplicate bug.
    expect(fs.writes).toEqual([{ path: "/notes/b.md", text: "typed mid-rename" }]);
  });

  test("a clean note that is renamed writes nothing at all", async () => {
    const fs = fakeBridge();
    bindDoc("doc-1", "/notes/a.md", noop());

    freezeDoc("doc-1");
    retargetDoc("doc-1", "/notes/b.md");
    await tick();
    expect(fs.writes).toEqual([]);
  });

  test("saves after a rename go to the new path", async () => {
    const fs = fakeBridge();
    bindDoc("doc-1", "/notes/a.md", noop());
    freezeDoc("doc-1");
    retargetDoc("doc-1", "/notes/b.md");

    noteChanged("doc-1", "after");
    await saveNow("doc-1");
    expect(fs.writes).toEqual([{ path: "/notes/b.md", text: "after" }]);
  });

  test("a refused rename leaves the note saving to the path it still has", async () => {
    const fs = fakeBridge();
    bindDoc("doc-1", "/notes/a.md", noop());

    // What actions.ts does when Bun rejects the name: retarget at the old path.
    freezeDoc("doc-1");
    retargetDoc("doc-1", "/notes/a.md");

    noteChanged("doc-1", "still works");
    await saveNow("doc-1");
    expect(fs.writes).toEqual([{ path: "/notes/a.md", text: "still works" }]);
  });

  test("a forgotten note drops its pending edit: a deleted note must not come back", async () => {
    const fs = fakeBridge();
    bindDoc("doc-1", "/notes/a.md", noop());

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
    bindDoc("doc-1", "/notes/a.md", noop());

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
    bindDoc("doc-1", "/notes/shipping-notes.md", noop());
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
    bindDoc("doc-1", "/notes/untitled-2.md", noop());
    seedSlug("doc-1", titled("test-123"));

    noteChanged("doc-1", titled("test-123", "editing away"));
    await saveNow("doc-1");

    expect(fs.retitles).toEqual([]);
  });

  test("editing the heading moves the file and tells the tab where it went", async () => {
    const fs = fakeBridge();
    const moves: Array<{ path: string; prev: string | null }> = [];
    bindDoc("doc-1", "/notes/shipping-notes.md", {
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
    bindDoc("doc-1", "/notes/shipping-notes.md", noop());
    seedSlug("doc-1", titled("Shipping Notes"));

    noteChanged("doc-1", titled("Shipping Plans"));
    await saveNow("doc-1");
    noteChanged("doc-1", titled("Shipping Plans", "after"));
    await saveNow("doc-1");

    expect(fs.writes.at(-1)).toEqual({ path: "/notes/shipping-plans.md", text: titled("Shipping Plans", "after") });
  });

  test("a heading edit that does not change the slug moves nothing", async () => {
    const fs = fakeBridge();
    bindDoc("doc-1", "/notes/shipping-notes.md", noop());
    seedSlug("doc-1", titled("Shipping Notes"));

    // Punctuation and case wash out of the slug, so there is no rename to do.
    noteChanged("doc-1", titled("shipping notes!"));
    await saveNow("doc-1");

    expect(fs.retitles).toEqual([]);
  });

  test("removing the heading keeps the name the note already has", async () => {
    const fs = fakeBridge();
    bindDoc("doc-1", "/notes/shipping-notes.md", noop());
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
    bindDoc("doc-1", "/notes/untitled.md", noop());
    seedSlug("doc-1", "no heading yet\n");

    noteChanged("doc-1", titled("Shipping Notes"));
    await saveNow("doc-1");

    expect(fs.retitles).toHaveLength(1);
  });

  test("a note created from titled text is not renamed straight after", async () => {
    // createNote already names from the H1, so the create IS the naming: a retitle
    // on top of it would be a pointless second trip to the disk.
    const fs = fakeBridge();
    bindDoc("doc-1", null, noop());

    noteChanged("doc-1", titled("Shipping Notes"));
    await saveNow("doc-1");

    expect(fs.creates).toEqual([titled("Shipping Notes")]);
    expect(fs.retitles).toEqual([]);
  });

  test("an unseeded note records its heading rather than acting on it", async () => {
    // A note whose load never landed (deleted behind our back). First sight of its
    // text must not be read as "the heading just changed".
    const fs = fakeBridge();
    bindDoc("doc-1", "/notes/whatever.md", noop());

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
    bindDoc("doc-1", "/notes/shipping-notes.md", noop());
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
    bindDoc("doc-1", "/notes/shipping-notes.md", noop());
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
    bindDoc("doc-1", "/notes/shipping-notes.md", handlers);
    seedSlug("doc-1", titled("Shipping Notes"));

    noteChanged("doc-1", titled("Shipping Plans"));
    await saveNow("doc-1");
    expect(labels).toEqual(["Shipping Plans"]);
  });

  // The case that forced the label to be tracked separately from the slug.
  test("a heading edit that renames nothing still relabels", async () => {
    const fs = fakeBridge();
    const { labels, handlers } = labelsOf();
    bindDoc("doc-1", "/notes/shipping-notes.md", handlers);
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
    bindDoc("doc-1", "/notes/shipping-notes.md", handlers);
    seedSlug("doc-1", titled("Shipping Notes"));

    noteChanged("doc-1", titled("Shipping Notes", "more words"));
    await saveNow("doc-1");
    expect(labels).toEqual([]);
  });

  test("deleting the heading falls the label back to the filename", async () => {
    const { labels, handlers } = labelsOf();
    fakeBridge();
    bindDoc("doc-1", "/notes/shipping-notes.md", handlers);
    seedSlug("doc-1", titled("Shipping Notes"));

    noteChanged("doc-1", "just prose now\n");
    await saveNow("doc-1");
    // Not "Untitled": the file is still shipping-notes.md, and it still says so.
    expect(labels).toEqual(["shipping-notes"]);
  });

  test("a new note with no heading is labelled by the file it just got", async () => {
    const { labels, handlers } = labelsOf();
    fakeBridge();
    bindDoc("doc-1", null, handlers);
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
    bindDoc("doc-1", "/notes/shipping-notes.md", handlers);
    seedSlug("doc-1", titled("Shipping Notes"));

    noteChanged("doc-1", titled("Shipping Notes", "typing"));
    await saveNow("doc-1");
    expect(labels).toEqual([]);
  });
});
