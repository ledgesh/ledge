// Autosave: the view-side half of note persistence.
//
// One entry per open note, keyed by docId (the editor pool's key, not the file
// path: a note has a docId from the moment its tab opens, but a path only from
// its first save). Edits land in `pending` and a debounce writes the latest text
// through to Bun. A note with no path yet gets one allocated on that first write,
// which is what makes "a tab you never type in leaves no file" true.
import { createNote, writeNote, type NoteMeta } from "./channel";

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
  onCreated: (note: NoteMeta) => void;
}

const docs = new Map<string, Entry>();

// Register an open note. `path` is null for a new note that has no file yet;
// `onCreated` fires once one is allocated, so the tab can bind to it and show its
// filename. Re-binding an already-open note only refreshes that callback: its
// dirty state and its allocated path must survive.
export function bindDoc(docId: string, path: string | null, onCreated: (note: NoteMeta) => void): void {
  const existing = docs.get(docId);
  if (existing) {
    existing.onCreated = onCreated;
    return;
  }
  docs.set(docId, { docId, path, pending: null, timer: null, inFlight: false, onCreated });
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
  if (e.inFlight) return;
  e.inFlight = true;
  try {
    while (e.pending !== null) {
      const text = e.pending;
      e.pending = null;
      try {
        if (e.path) {
          await writeNote(e.path, text);
        } else {
          const note = await createNote(text);
          e.path = note.path;
          e.onCreated(note);
        }
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
