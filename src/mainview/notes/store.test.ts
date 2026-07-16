import { afterEach, describe, expect, test } from "bun:test";
import { configureNotes, type NoteMeta } from "./channel";
import { bindDoc, flushAll, noteChanged, releaseDoc, resetDocs, saveNow } from "./store";

// A stand-in for the Bun note store. Writes are recorded; each call's promise can
// be held open (`gate`) so the tests can drive what happens *during* a save, which
// is where the interesting races live.
function fakeBridge() {
  const writes: Array<{ path: string; text: string }> = [];
  const creates: string[] = [];
  let created = 0;
  const state = {
    writes,
    creates,
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
      const path = `/notes/untitled-${created}.md`;
      return { path, title: `untitled-${created}`, mtimeMs: created };
    },
  });

  return state;
}

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
    bindDoc("doc-1", null, () => {});
    await saveNow("doc-1");
    expect(fs.creates).toEqual([]);
    expect(fs.writes).toEqual([]);
  });

  test("re-binding an open note keeps its allocated path", async () => {
    const fs = fakeBridge();
    bindDoc("doc-1", null, () => {});
    noteChanged("doc-1", "one");
    await saveNow("doc-1");

    // A tab re-attach (pane switch) rebinds with the path the TAB knows, which is
    // still null if the reducer has not caught up. The store must not forget the
    // file it just allocated and create a second one.
    bindDoc("doc-1", null, () => {});
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
    bindDoc("doc-1", null, (note) => seen.push(note));

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
    bindDoc("doc-1", "/notes/existing.md", () => {});
    noteChanged("doc-1", "edited");
    await saveNow("doc-1");

    expect(fs.creates).toEqual([]);
    expect(fs.writes).toEqual([{ path: "/notes/existing.md", text: "edited" }]);
  });
});

describe("in-flight edits", () => {
  test("edits during a save are coalesced into one follow-up write of the latest text", async () => {
    const fs = fakeBridge();
    bindDoc("doc-1", "/notes/a.md", () => {});
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
    bindDoc("doc-1", null, () => {});
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
    bindDoc("doc-1", "/notes/a.md", () => {});
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
    bindDoc("doc-1", "/notes/a.md", () => {});
    bindDoc("doc-2", "/notes/b.md", () => {});
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
    bindDoc("doc-1", "/notes/a.md", () => {});
    noteChanged("doc-1", "unsaved");

    releaseDoc("doc-1"); // tab closed inside the debounce window
    await tick();

    expect(fs.writes).toEqual([{ path: "/notes/a.md", text: "unsaved" }]);
  });

  test("a closed note is deregistered: later changes are ignored", async () => {
    const fs = fakeBridge();
    bindDoc("doc-1", "/notes/a.md", () => {});
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
    bindDoc("doc-1", "/notes/a.md", () => {});

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
    bindDoc("doc-1", "/notes/a.md", () => {});

    fs.failNextWrite = true;
    noteChanged("doc-1", "v1");
    await saveNow("doc-1");

    noteChanged("doc-1", "v2");
    await saveNow("doc-1");
    expect(fs.writes).toEqual([{ path: "/notes/a.md", text: "v2" }]);
  });
});
