// Autosave: the view-side half of note persistence.
//
// One entry per open note, keyed by docId (the editor pool's key, not the file
// path: a note has a docId from the moment its tab opens, but a path only from
// its first save). Edits land in `pending` and a debounce writes the latest text
// through to Bun. A note with no path yet gets one allocated on that first write,
// which is what makes "a tab you never type in leaves no file" true.
import { createNote, retitleNote, writeNote, type NoteMeta } from "./channel";
import { headingOf, labelOf, slugOf } from "../../shared/slug";

// Long enough that a burst of typing is one write, short enough that the window
// where a crash loses work is small. Matches PLAN P1-4.
const SAVE_DELAY_MS = 500;

interface Entry {
  docId: string;
  // null until this note's first save allocates a file.
  path: string | null;
  // The newest unsaved text, or null when the note is clean. Only ever the whole
  // document: saves are atomic full-file writes, so there is nothing to coalesce
  // beyond keeping the last one.
  pending: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  // A save is awaiting Bun. Edits during that window queue in `pending` and the
  // running flush picks them up rather than racing a second write to the same file.
  inFlight: boolean;
  // Saving is suspended while the note's file is being renamed out from under it.
  // Edits keep accumulating in `pending`; they just do not reach disk until the
  // entry has been retargeted at the new path (see freezeDoc / retargetDoc).
  frozen: boolean;
  // The slug this note's heading last asked for, and whether we have ever seen
  // this note's text at all. The pair is what keeps naming-by-heading from
  // touching a file until its heading actually changes: a note loaded from disk
  // is seeded with the slug it arrives with, so a note named notes.md whose H1
  // says "My Big Plan" (or untitled-2.md whose H1 says "test-123") is left alone
  // no matter how much you edit its body. Only editing the H1 moves the file.
  lastSlug: string | null;
  slugSeeded: boolean;
  // The heading this note last showed. Tracked separately from the slug because it
  // changes more often: "Shipping Notes" -> "shipping notes!" is a new label but
  // the same slug, so the tab must relabel while the file stays put.
  lastHeading: string | null;
  handlers: DocHandlers;
}

export interface DocHandlers {
  // The note's file changed identity: created (prevPath null) or renamed to follow
  // its heading. One callback for both, because to a tab they are the same event:
  // "this note's bytes now live over here, under this name".
  onFile: (note: NoteMeta, prevPath: string | null) => void;
  // What the note should be called on screen changed: its heading, or its filename
  // once the heading is gone.
  onTitle: (label: string) => void;
}

const docs = new Map<string, Entry>();

// Register an open note. `path` is null for a new note that has no file yet;
// `onFile` fires whenever one is allocated or moves, so the tab can bind to it
// and show its filename. Re-binding an already-open note only refreshes that
// callback: its dirty state, its allocated path, and its seeded slug must survive.
export function bindDoc(docId: string, path: string | null, handlers: DocHandlers): void {
  const existing = docs.get(docId);
  if (existing) {
    existing.handlers = handlers;
    return;
  }
  docs.set(docId, {
    docId,
    path,
    pending: null,
    timer: null,
    inFlight: false,
    frozen: false,
    lastSlug: null,
    slugSeeded: false,
    lastHeading: null,
    handlers,
  });
}

// Record the heading a note already has on disk, without renaming anything. Called
// as a note's saved text lands in its editor (editorPool.loadNote).
//
// This is the guard that makes naming-by-heading safe to turn on over notes that
// already exist: without it, the first flush of any note would see its slug change
// from "unknown" to whatever its H1 says and move a file the user never asked to
// move. Seeding means the rule only ever applies to headings edited from here on.
export function seedSlug(docId: string, text: string): void {
  const e = docs.get(docId);
  if (!e || e.slugSeeded) return;
  e.lastSlug = slugOf(text);
  e.lastHeading = headingOf(text);
  e.slugSeeded = true;
}

// The editor's document changed. Schedules a save; called on every keystroke, so
// it does no work beyond stashing the text and arming the timer.
export function noteChanged(docId: string, text: string): void {
  const e = docs.get(docId);
  if (!e) return; // not a persisted note (an editor built outside the pool, e.g. a test)
  e.pending = text;
  if (e.timer !== null) clearTimeout(e.timer);
  e.timer = setTimeout(() => {
    e.timer = null;
    void flush(e);
  }, SAVE_DELAY_MS);
}

// Write `pending` through, then keep writing until nothing is pending: an edit
// that arrives while Bun is mid-write is picked up by this same loop instead of
// starting a second, racing write. `inFlight` makes concurrent callers (the
// debounce and a Cmd+S landing together) collapse into the one running flush.
async function flush(e: Entry): Promise<void> {
  if (e.inFlight || e.frozen) return;
  e.inFlight = true;
  try {
    while (e.pending !== null) {
      const text = e.pending;
      e.pending = null;
      try {
        if (e.path) {
          await writeNote(e.path, text);
        } else {
          // createNote names the file from this same text's H1, so a note titled
          // before its first save is born correctly named rather than created as
          // untitled.md and renamed a beat later.
          const note = await createNote(text);
          e.path = note.path;
          e.handlers.onFile(note, null);
        }
        // Inside the flush loop on purpose: the inFlight guard already serialises
        // this note's disk work, so a rename can never overlap a write to the path
        // it is moving. Nothing else has to be locked or frozen.
        await syncTitle(e, text);
      } catch (err) {
        console.error("[notes] save failed", err);
        // Put the text back so the note stays dirty and the next save retries it
        // rather than silently dropping the edit, unless a newer edit already
        // superseded it. Then stop: retrying the same write in this loop would
        // just spin on the same failure.
        if (e.pending === null) e.pending = text;
        break;
      }
    }
  } finally {
    e.inFlight = false;
  }
}

// Move the note's file to match its heading, if its heading has changed since the
// last time we looked. Only a *change* triggers this, never simply a mismatch
// between name and heading: renaming on mismatch would mean an unrelated body edit
// silently moving a file whose name you had chosen (or that predates this rule),
// and would make deleting one note quietly rename another the next time you typed
// in it. Called only from inside flush.
async function syncTitle(e: Entry, text: string): Promise<void> {
  // Relabel first and unconditionally. The label follows the heading, which moves
  // more often than the filename does: a heading edit that slugs the same ("#
  // Shipping Notes" -> "# shipping notes!") renames nothing but must still show.
  const heading = headingOf(text);
  if (heading !== e.lastHeading) {
    e.lastHeading = heading;
    e.handlers.onTitle(labelOf(heading, e.path));
  }

  const slug = slugOf(text);
  if (!e.slugSeeded) {
    // First sight of this note's text (a note created here, or one whose load
    // never landed). Record where it stands; do not move it.
    e.slugSeeded = true;
    e.lastSlug = slug;
    return;
  }
  if (slug === e.lastSlug) return;
  // The heading was removed, or is not sluggable ("# ???"). The note keeps the
  // name it has: silently renaming a titled note back to untitled.md the moment
  // you delete its first line would be a nasty surprise, and enumerating a second
  // untitled.md over it would be worse.
  if (slug === null || !e.path) {
    e.lastSlug = slug;
    return;
  }
  const prev = e.path;
  // Bun is handed the text, not the slug: it derives the name itself, so the view
  // cannot ask for a path. It also owns the enumeration when the name is taken.
  const note = await retitleNote(prev, text);
  // Only after it lands: a throw leaves lastSlug alone, so the retry (the failed
  // text goes back into `pending`) tries the rename again rather than deciding the
  // heading is already dealt with.
  e.lastSlug = slug;
  if (note.path === prev) return; // already correctly named
  e.path = note.path;
  e.handlers.onFile(note, prev);
}

// Save now, skipping the debounce, and resolve once the note is on disk. Cmd+S
// and the flush-everything paths below go through here.
export async function saveNow(docId: string): Promise<void> {
  const e = docs.get(docId);
  if (!e) return;
  if (e.timer !== null) {
    clearTimeout(e.timer);
    e.timer = null;
  }
  await flush(e);
}

// Suspend saving for a note whose file is about to move. Without this, an edit
// landing mid-rename would write to the old path and resurrect the note under its
// old name, leaving two files. Edits still accumulate; they wait for retargetDoc.
//
// Nothing here waits for an in-flight write. It cannot: freezing has to be
// synchronous, or the very gap it exists to close reopens. An in-flight write is
// to the old path, which the rename then moves, carrying the bytes along. The
// text is not lost, and the file it lands in is the right one.
export function freezeDoc(docId: string): void {
  const e = docs.get(docId);
  if (!e) return;
  e.frozen = true;
}

// Point a note at its file's new path and resume saving, writing out anything
// that piled up while frozen. Called with the new path once a rename lands, and
// with the old one if it failed: either way the note ends up unfrozen and aimed
// at the file that actually exists.
export function retargetDoc(docId: string, path: string): void {
  const e = docs.get(docId);
  if (!e) return;
  e.path = path;
  e.frozen = false;
  if (e.pending !== null) void flush(e);
}

// The note's file is gone. Drop the entry AND its pending text: this is the one
// path where an unsaved edit must not reach disk, because writing it would create
// the file again moments after the user deleted it. releaseDoc, which the editor
// teardown calls next, then finds nothing and flushes nothing.
export function forgetDoc(docId: string): void {
  const e = docs.get(docId);
  if (!e) return;
  if (e.timer !== null) clearTimeout(e.timer);
  e.pending = null;
  // An in-flight write is already past the point of recall. Freezing stops the
  // flush loop from starting another lap once it returns.
  e.frozen = true;
  docs.delete(docId);
}

// The note's tab closed. Drop it from the map immediately (nothing may schedule
// another save for a closed note) but let any pending text finish writing: the
// entry itself is still referenced by the running flush.
export function releaseDoc(docId: string): void {
  const e = docs.get(docId);
  if (!e) return;
  if (e.timer !== null) clearTimeout(e.timer);
  docs.delete(docId);
  void flush(e);
}

// Flush every dirty note. Wired to the window losing focus and to pagehide, so
// the debounce window is not the only thing standing between an edit and disk.
export function flushAll(): void {
  for (const docId of docs.keys()) void saveNow(docId);
}

// Test seam: forget every registered note.
export function resetDocs(): void {
  for (const e of docs.values()) if (e.timer !== null) clearTimeout(e.timer);
  docs.clear();
}
