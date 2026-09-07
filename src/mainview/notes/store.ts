// Autosave: the view-side half of note persistence.
//
// One entry per open note, keyed by docId (the editor pool's key, not the file
// path: a note has a docId from the moment its tab opens, but a path only from
// its first save). Edits land in `pending` and a debounce writes the latest
// text through to Bun. A note with no path gets a file allocated on that first
// write, so a tab that is never typed in leaves no file.
import { configureSession, createNote, retitleNote, writeNote, type NoteMeta } from "./channel";
import { workspaceDefaultCwd } from "../workspace/channel";
import { headingOf, labelOf, slugOf } from "../../shared/slug";
import { parseFrontmatter, type NoteParams } from "../../shared/frontmatter";

// How long an edit waits before it is written to disk. Long enough that a burst
// of typing is one write, short enough that a crash costs at most half a second
// of typing. Matches PLAN P1-4.
const SAVE_DELAY_MS = 500;

// The one capability the save path needs from outside this module. The browser
// owns the notice strip (NoteBrowser's configureUi), and importing it here
// would drag React and the command layer into the store's unit tests. This is
// the configureX pattern of architecture.md §5; App.tsx does the wiring.
const ui: { notice?: (message: string) => void } = {};

export function configureStoreUi(fns: { notice?: (message: string) => void }): void {
  Object.assign(ui, fns);
}

// The notice shown by a save that displaced another writer's version. It names
// the note, because the strip sits in the sidebar rather than over the editor
// and the diverged note is not always the one on screen: a flushAll on window
// blur saves every dirty tab at once.
function divergedNotice(label: string): string {
  return `“${label}” also changed elsewhere while you were editing. Your version was saved; the other one is in the Trash.`;
}

// The mirror image of divergedNotice, for the outage case
// (workspace/editorPool.ts resolveStrandedNotes). It reports the same event
// with the winner the other way round. The sentence shape matches so a user
// who has seen one can read the other at a glance.
function strandedNotice(label: string): string {
  return `“${label}” changed on the server while you were disconnected. That version is now open; what you had typed is in the Trash.`;
}

interface Entry {
  docId: string;
  // The workspace folder this note belongs to, captured when its tab opened.
  // Stable for the docId's whole life: tabs never move across workspaces
  // (moveTab is scoped to the selected one), so a tab's first save creates the
  // file in this folder. The asset calls also resolve `.ledge-assets/x.png`
  // against it (folderOf below).
  folder: string;
  // null until this note's first save allocates a file.
  path: string | null;
  // The newest unsaved text, or null when the note is clean. Always the whole
  // document: saves are atomic full-file writes, so there is nothing to
  // coalesce beyond keeping the last one.
  pending: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  // A save is awaiting Bun. Edits during that window queue in `pending` and
  // the running flush picks them up, rather than racing a second write to the
  // same file.
  inFlight: boolean;
  // Saving is suspended while the note's file is being renamed underneath it.
  // Edits keep accumulating in `pending`, but do not reach disk until the
  // entry has been retargeted at the new path (see freezeDoc / retargetDoc).
  frozen: boolean;
  // The disk version this note last read or wrote, passed as writeNote's
  // baseMtimeMs. It lets Bun catch an external edit made under an autosave
  // instead of flattening it. null until the first read or write lands: a note
  // edited before that saves blind, as every save did before the guard existed.
  mtimeMs: number | null;
  // The slug this note's heading last asked for, plus whether the store has
  // seen this note's text at all. The pair keeps naming-by-heading from moving
  // a file until its heading changes. A note loaded from disk is seeded with
  // the slug it arrives with, so notes.md with an H1 of "My Big Plan", and
  // untitled-2.md with an H1 of "test-123", keep their names through any number
  // of body edits. Only an H1 edit moves the file.
  lastSlug: string | null;
  slugSeeded: boolean;
  // The heading this note last showed. Tracked separately from the slug
  // because it changes more often: "Shipping Notes" -> "shipping notes!" is a
  // new label but the same slug, so the tab relabels while the file stays put.
  lastHeading: string | null;
  // The spawn params (frontmatter merged with the workspace default cwd) Bun
  // last got for this note, as a JSON key. Seeded to "no params" rather than to
  // "unknown", so a frontmatterless note in a defaultless (managed) workspace
  // sends no configure at all: for it, Bun's defaults and empty params are the
  // same thing. A workspace that carries a default cwd merges to something
  // non-empty, so its notes send a first configure at bindDoc.
  lastParamsKey: string;
  handlers: DocHandlers;
}

export interface DocHandlers {
  // The note's file changed identity: created (prevPath null) or renamed to
  // follow its heading. One callback covers both, because to a tab they are the
  // same event: this note's bytes now live over here, under this name. The
  // handler still branches on prevPath (workspace/PaneTree.tsx).
  onFile: (note: NoteMeta, prevPath: string | null) => void;
  // What the note should be called on screen changed: its heading, or its
  // filename once the heading is gone.
  onTitle: (label: string) => void;
}

const docs = new Map<string, Entry>();

// What "nothing yet" serializes to: no frontmatter, no file. New entries start
// here (see Entry.lastParamsKey), and a pathless bind in a defaultless
// workspace lands on exactly this key and sends nothing.
const EMPTY_PARAMS_KEY = JSON.stringify({ params: parseFrontmatter("").params, notePath: null });

// Send the note's spawn params to Bun if its frontmatter now parses to
// something different. Comparison is on the parsed params, not the block's
// text, so touching a comment or reflowing whitespace in the frontmatter
// re-sends nothing. Bun applies params at shell spawn: an extra send is
// harmless, a missed one leaves the next shell with a stale cwd or env.
//
// A note that names no `cwd:` of its own inherits its workspace's default
// (workspaceDefaultCwd: the folder itself for an external workspace, null for
// a managed one). The merge happens here, the one point params leave the view,
// so every consumer Bun-side (persistent, overflow, and drawer shells) gets the
// same answer without knowing workspaces exist.
function syncParams(e: Entry, text: string): void {
  const { params } = parseFrontmatter(text);
  if (params.cwd === null) params.cwd = workspaceDefaultCwd(e.folder);
  // The note's path rides along (rpc-schema sessionConfigure: Bun re-validates
  // it and stamps it into spawn env as LEDGE_NOTE). Folding it into the change
  // key makes a path change, a first save or a rename, re-send on its own with
  // no parallel bookkeeping. The cost is one send at bind for every on-disk
  // note, whose location is never empty. An extra send is harmless; a missed
  // one spawns a shell whose LEDGE_NOTE does not name the note.
  const key = JSON.stringify({ params, notePath: e.path });
  if (key === e.lastParamsKey) return;
  e.lastParamsKey = key;
  try {
    configureSession(e.docId, params, e.path);
  } catch {
    // No bridge (a store driven in unit tests). Params are advisory: failing
    // to send them must not break seeding or saving.
  }
}

// Register an open note. `folder` is the tab's workspace folder (where a first
// save creates the file); `path` is null for a new note that has no file yet;
// `onFile` fires whenever one is allocated or moves, so the tab can bind to it
// and show its filename. Re-binding an already-open note only refreshes those
// callbacks: its dirty state, allocated path, and seeded slug survive.
export function bindDoc(docId: string, path: string | null, folder: string, handlers: DocHandlers): void {
  const existing = docs.get(docId);
  if (existing) {
    existing.handlers = handlers;
    return;
  }
  const entry: Entry = {
    docId,
    folder,
    path,
    pending: null,
    timer: null,
    inFlight: false,
    frozen: false,
    mtimeMs: null,
    lastSlug: null,
    slugSeeded: false,
    lastHeading: null,
    lastParamsKey: EMPTY_PARAMS_KEY,
    handlers,
  };
  docs.set(docId, entry);
  // Send the empty text's params now. The workspace default cwd (and the
  // note's path, when it already has a file) must reach Bun even for a note
  // that is never edited or loaded, such as a fresh tab whose first act is a
  // Run click. A pathless bind in a defaultless workspace merges to exactly
  // EMPTY_PARAMS_KEY and sends nothing; seedSlug re-syncs once a load lands.
  syncParams(entry, "");
}

// The docId currently bound to a note's file, or null when no open tab holds
// it. Path to docId is one-to-one in practice (openNote focuses an existing
// tab rather than opening a second on the same path), so the first match is
// the right one. The editor pool uses this to land a search reveal on an
// already-open note, whose editor no attach revisits.
export function docIdAt(path: string): string | null {
  for (const e of docs.values()) if (e.path === path) return e.docId;
  return null;
}

// The workspace folder an open note belongs to, or null for a docId the store
// has never seen (an editor built outside the pool, e.g. a test). The asset
// call sites (editor ⌘V paste, image widgets) use this to scope
// `.ledge-assets/…` references to the note's own workspace.
export function folderOf(docId: string): string | null {
  return docs.get(docId)?.folder ?? null;
}

// The spawn params this note last sent to Bun. They are parsed back out of
// lastParamsKey rather than stored twice, so this cannot disagree with what
// Bun holds. App's terminal-drawer flow reads `hosts` from here: the drawer
// belongs to the note as a whole rather than to an editor view, and this is
// the only view-side record of the note's params outside the editor.
export function paramsOf(docId: string): NoteParams | null {
  const e = docs.get(docId);
  return e ? (JSON.parse(e.lastParamsKey) as { params: NoteParams }).params : null;
}

// Record the heading a note already has on disk, without renaming anything.
// Called as a note's saved text lands in its editor (editorPool.loadNote).
//
// This is what makes naming-by-heading safe over notes that already exist.
// Without it the first flush of any note would see its slug change from
// "unknown" to whatever its H1 says, and move a file nobody asked to move.
// Seeding limits the rule to headings edited from here on.
export function seedSlug(docId: string, text: string, mtimeMs: number | null = null): void {
  const e = docs.get(docId);
  if (!e || e.slugSeeded) return;
  e.lastSlug = slugOf(text);
  e.lastHeading = headingOf(text);
  e.slugSeeded = true;
  // The read that carried this text also carried the disk version; from here
  // on every save states its expectation (see Entry.mtimeMs).
  if (mtimeMs !== null) e.mtimeMs = mtimeMs;
  // The slug is seeded so the file does not move, but the params already on
  // disk have to reach Bun now. The note's first shell can spawn on a Run
  // click long before any edit triggers a flush.
  syncParams(e, text);
}

// The editor's document changed. Schedules a save. Called on every keystroke,
// so it does no work beyond stashing the text and arming the timer.
export function noteChanged(docId: string, text: string): void {
  const e = docs.get(docId);
  if (!e) return; // not a persisted note (an editor built outside the pool, e.g. a test)
  e.pending = text;
  refreshDirty();
  if (e.timer !== null) clearTimeout(e.timer);
  e.timer = setTimeout(() => {
    e.timer = null;
    void flush(e);
  }, SAVE_DELAY_MS);
}

// --- who is unsaved ----------------------------------------------------------

/**
 * Which open notes are holding text that is not on disk, for the tab strip.
 *
 * The same shape as the block chrome's busy state (editor/bridge.ts
 * onTerminalBusyChange): a fact the store owns that a component several levels
 * away has to draw, with no props route between them.
 *
 * Drawn at all times, not only during an outage. Until this indicator, saved
 * and not saved looked identical in every state. That was tolerable while the
 * debounce was 500ms and always won. It is wrong once a save can instead be
 * waiting on a server (remote.md §7).
 */
const dirty = new Set<string>();
const dirtySinks = new Set<() => void>();

export function onDirtyChange(sink: () => void): () => void {
  dirtySinks.add(sink);
  return () => {
    dirtySinks.delete(sink);
  };
}

export function isNoteDirty(docId: string): boolean {
  return dirty.has(docId);
}

/**
 * Recompute the dirty set from the entries, and notify subscribers if it moved.
 *
 * Recomputed rather than maintained at each assignment to `pending`: the set is
 * as big as the open tabs, so the scan costs nothing, and a second piece of
 * bookkeeping could disagree with the first. Notifying only on a real change
 * keeps the tab strip from re-rendering on every keystroke.
 */
function refreshDirty(): void {
  const seen = new Set<string>();
  for (const e of docs.values()) if (e.pending !== null) seen.add(e.docId);
  if (seen.size === dirty.size && [...seen].every((d) => dirty.has(d))) return;
  dirty.clear();
  for (const docId of seen) dirty.add(docId);
  for (const sink of dirtySinks) sink();
}

// --- the save hold -----------------------------------------------------------

/**
 * Whether saving is suspended for every note because the server cannot be
 * reached (remote.md §7). Set for a lost connection, never for one that is
 * merely reconnecting: a reconnecting client's requests wait on the ladder and
 * land when it returns (shared/transport.ts).
 *
 * Separate from Entry.frozen, though it stops the flush loop the same way:
 * frozen is one note's rename, this is every note's server. Folding a global
 * condition into the per-entry flag would mean remembering which entries were
 * already frozen for their own reasons before the wire went.
 *
 * A lost connection fails the write back into `pending` anyway. What the hold
 * adds is the moment after the wire returns: it keeps a debounce or a blur from
 * landing a stranded write before the reconciliation has decided whether that
 * buffer is still the note (workspace/editorPool.ts resolveStrandedNotes).
 */
let held = false;

export function holdSaves(): void {
  held = true;
}

// Callbacks that resolve savesSettled once the writes already in flight have
// finished, which after a lost connection means once they have all failed.
const settling = new Set<() => void>();

/**
 * Resolves once no note is mid-save.
 *
 * The one caller is workspace/editorPool.ts resolveStrandedNotes, which has to
 * see the true state of every buffer before deciding anything about them. A
 * save in flight when the wire died is failed by the transport, and `flush`
 * puts its text back in the buffer a few microtasks after the announcement
 * lands. A server that restarted announces `lost` and `live` in the same breath
 * (shared/transport.ts), so without this wait the resolution would see an entry
 * that still looks mid-save and looks clean, skip it, and leave that text dirty
 * with nothing left to retry it.
 *
 * The wait is bounded: the announcement that brings anyone here fails every
 * request in flight, and the hold keeps new ones from starting.
 */
export function savesSettled(): Promise<void> {
  if (![...docs.values()].some((e) => e.inFlight)) return Promise.resolve();
  return new Promise<void>((resolve) => settling.add(resolve));
}

function settled(): void {
  if ([...docs.values()].some((e) => e.inFlight)) return;
  for (const wake of settling) wake();
  settling.clear();
}

/**
 * Whether saving is currently suspended. This also answers whether a buffer
 * could be stranded (workspace/editorPool.ts resolveStrandedNotes).
 *
 * One flag answers both, because a buffer is stranded exactly when saving was
 * suspended under it. A wire that merely flapped suspends nothing: those
 * writes wait on the ladder and land, so a buffer left dirty across a
 * reconnect is an ordinary unsaved edit, arbitrated by the next save's mtime
 * guard. Reading `held` rather than a second flag keeps the two answers in
 * step.
 */
export function savesHeld(): boolean {
  return held;
}

/**
 * Let saving resume, and flush whatever accumulated while it could not.
 *
 * Called after the relink reconciliation has settled every stranded buffer,
 * never before it: the hold is only worth anything while nothing writes in
 * between. A second call is a no-op, so the release can sit in a `finally`
 * without checking whether the hold was on.
 */
export function releaseSaves(): void {
  if (!held) return;
  held = false;
  for (const e of docs.values()) if (e.pending !== null) void flush(e);
}

// Write `pending` through, then keep writing until nothing is pending: an edit
// that arrives while Bun is mid-write is picked up by this same loop instead of
// starting a second, racing write. `inFlight` makes concurrent callers (the
// debounce and a Cmd+S landing together) collapse into the one running flush.
async function flush(e: Entry): Promise<void> {
  if (e.inFlight || e.frozen || held) return;
  e.inFlight = true;
  try {
    while (e.pending !== null) {
      const text = e.pending;
      e.pending = null;
      try {
        if (e.path) {
          const res = await writeNote(e.path, text, e.mtimeMs);
          e.mtimeMs = res.mtimeMs;
          // The save displaced another writer's version into the trash: an
          // agent, git, vim, or another client on the same server (remote.md
          // §7). The buffer wins the live path, because the user is the one
          // typing, and the displaced version is recoverable from the Trash
          // section, whose count the watcher's refresh updates.
          //
          // A notice rather than a dialog: nothing was lost and there is
          // nothing to decide. Not a console line either, which is what this
          // was while the other writer could only be a program on this
          // machine. Once it can be the user's own phone, a silent
          // trash-and-carry-on reads as the app losing half of what was
          // typed. The log stays for the exact trash path, which the notice
          // has no room for.
          if (res.divergedTo) {
            console.warn("[notes] this note changed on disk mid-edit; that version is in the trash:", res.divergedTo);
            ui.notice?.(divergedNotice(labelOf(headingOf(text), e.path)));
          }
        } else {
          // createNote names the file from this same text's H1, so a note
          // titled before its first save gets the right name straight away
          // instead of being created as untitled.md and renamed a beat later.
          // It lands in the tab's own workspace folder, captured at bindDoc.
          const note = await createNote(e.folder, text);
          e.path = note.path;
          e.mtimeMs = note.mtimeMs;
          e.handlers.onFile(note, null);
        }
        // Before syncTitle: a failed rename must not also cost Bun the params
        // update (syncParams is already idempotent for the retry that follows).
        syncParams(e, text);
        // Called from inside the flush loop: the inFlight guard already
        // serialises this note's disk work, so a rename can never overlap a
        // write to the path it is moving. Nothing else has to be locked or
        // frozen.
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
    refreshDirty();
    settled();
  }
}

// Move the note's file to match its heading, if the heading changed since the
// store last recorded one (seedSlug, reseedDoc, or a previous flush). Only a
// change triggers this, never a mismatch between name and heading: renaming on
// mismatch would let an unrelated body edit move a file whose name the user
// chose (or that predates this rule), and would let deleting one note rename
// another on its next edit. Called only from flush.
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
  // name it has: deleting the first line would otherwise rename a titled note
  // back to untitled.md, or to an enumerated name when untitled.md is taken.
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
  // rename(2) preserves mtime, so this is normally a no-op. The meta's stat is
  // the truth, and adopting it keeps the guard aligned with the file.
  e.mtimeMs = note.mtimeMs;
  if (note.path === prev) return; // already correctly named
  e.path = note.path;
  e.handlers.onFile(note, prev);
  // The file moved, so the session's location fact must follow: the note's
  // next shell spawns knowing where the note is now. A shell already running
  // keeps its stale LEDGE_NOTE, since spawn params apply at the next spawn.
  // Agents address a note by its title, which a rename does not change.
  syncParams(e, text);
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

// --- external reload ---------------------------------------------------------
// The read direction of external-edit safety: an agent (or git, or vim) wrote
// a note Ledge has open. A clean buffer adopts the disk text. This module
// decides which notes may reload and what adopting means for the tracking
// state; editorPool.reloadOpenNotes pours the text into CodeMirror
// (testing.md §2, pure core and thin wrapper). A dirty buffer is not a
// candidate: the next save's baseMtimeMs guard arbitrates instead, sending the
// external version to the trash.

export interface ReloadCandidate {
  docId: string;
  path: string;
  // The disk version the buffer currently reflects; a differing stat means
  // the file moved on and the buffer should follow.
  mtimeMs: number | null;
}

// Every open note whose buffer could safely be replaced right now: it has a
// file, its load has landed (slugSeeded, so a reload cannot race the initial
// load and pour twice), and nothing is pending, in flight, or frozen.
export function reloadCandidates(): ReloadCandidate[] {
  const out: ReloadCandidate[] = [];
  for (const e of docs.values()) {
    if (!e.path || !e.slugSeeded) continue;
    if (e.pending !== null || e.timer !== null || e.inFlight || e.frozen) continue;
    out.push({ docId: e.docId, path: e.path, mtimeMs: e.mtimeMs });
  }
  return out;
}

/**
 * What strandedCandidates returns for each buffer that never reached the
 * server, for the caller that settles it (workspace/editorPool.ts
 * resolveStrandedNotes).
 */
export interface StrandedCandidate {
  docId: string;
  path: string;
  /** The text still waiting to be written. */
  text: string;
  /** The disk version it was typed against, or null if none was ever seen. */
  mtimeMs: number | null;
}

/**
 * Every open note holding text that never reached the server.
 *
 * The complement of reloadCandidates: those are the buffers safe to overwrite,
 * these are the ones it skips, and after an outage they hold the writing at
 * risk (remote.md §7). `frozen` and `inFlight` disqualify a note here as they
 * do there: a rename has that entry's path in the air, and a write already out
 * cannot be recalled. The save hold does not disqualify anything, since this
 * list is meant to be read while the hold is on.
 */
export function strandedCandidates(): StrandedCandidate[] {
  const out: StrandedCandidate[] = [];
  for (const e of docs.values()) {
    if (!e.path || !e.slugSeeded) continue;
    if (e.pending === null || e.inFlight || e.frozen) continue;
    out.push({ docId: e.docId, path: e.path, text: e.pending, mtimeMs: e.mtimeMs });
  }
  return out;
}

/**
 * Give up a stranded buffer and take the server's text as this note's content.
 *
 * The one place in this module that discards pending text, so the caller must
 * first have parked that text somewhere recoverable (channel stashNote).
 * `stashed` is the parked text, and a buffer that no longer matches it is
 * refused. reseedDoc makes that check too, for the same reason: parking was a
 * round trip, and a buffer typed into since is not stranded. It keeps its own
 * text, and the ordinary divergence guard arbitrates its next save.
 *
 * False means the editor must not be touched.
 */
export function adoptOverStranded(
  docId: string,
  path: string,
  text: string,
  mtimeMs: number,
  stashed: string,
  stashedTo: string | null,
): boolean {
  const e = docs.get(docId);
  if (!e || e.path !== path) return false;
  if (e.inFlight || e.frozen) return false;
  if (e.pending !== stashed) return false;
  if (e.timer !== null) {
    clearTimeout(e.timer);
    e.timer = null;
  }
  e.pending = null;
  refreshDirty();
  // Through reseedDoc rather than repeating it: adopting the server's text has
  // the same tracking consequences as adopting an external edit, including the
  // rule that a heading changed on disk relabels the tab without renaming the
  // file. Its dirty check passes because the line above cleared `pending`.
  if (!reseedDoc(docId, path, text, mtimeMs)) return false;
  // Only when something was actually parked. Two clients that typed the same
  // words displace nothing, so there is nothing to report.
  if (stashedTo !== null) ui.notice?.(strandedNotice(labelOf(headingOf(text), path)));
  return true;
}

// Adopt an external edit's text as the note's new baseline. Re-checks that the
// entry is still clean and still aimed at `path`: the read was async, so a
// keystroke, a delete, or a retitle may have landed since the candidate list
// was drawn. False means the editor must not be touched, and the caller drops
// the reload for the normal save path to handle.
//
// Adopting re-seeds the slug and heading tracking rather than diffing it. A
// heading that changed on disk relabels the tab without renaming the file:
// only a heading edited here renames it (the same stance as seedSlug).
export function reseedDoc(docId: string, path: string, text: string, mtimeMs: number): boolean {
  const e = docs.get(docId);
  if (!e || e.path !== path) return false;
  if (e.pending !== null || e.timer !== null || e.inFlight || e.frozen) return false;
  e.mtimeMs = mtimeMs;
  e.slugSeeded = true;
  e.lastSlug = slugOf(text);
  const heading = headingOf(text);
  if (heading !== e.lastHeading) {
    e.lastHeading = heading;
    e.handlers.onTitle(labelOf(heading, e.path));
  }
  // The disk edit may have rewritten the frontmatter too; the note's next
  // shell should spawn with what the file now says.
  syncParams(e, text);
  return true;
}

// Suspend saving for a note whose file is about to move. Without this, an edit
// landing mid-rename would write to the old path and recreate the note under
// its old name, leaving two files. Edits still accumulate; they wait for
// retargetDoc.
//
// Nothing here waits for an in-flight write. Freezing has to be synchronous, or
// an edit lands in the very gap it exists to close. Such a write goes to the old
// path, which the rename then moves, so the bytes end up in the right file.
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

// The note's file is gone. Drop the entry and its pending text: this is the one
// path where an unsaved edit must not reach disk, because writing it would
// recreate the file moments after the user deleted it. releaseDoc, which the
// editor teardown calls next, then finds nothing and flushes nothing.
export function forgetDoc(docId: string): void {
  const e = docs.get(docId);
  if (!e) return;
  if (e.timer !== null) clearTimeout(e.timer);
  e.pending = null;
  // An in-flight write is already past the point of recall. Freezing stops the
  // flush loop from starting another lap once it returns.
  e.frozen = true;
  docs.delete(docId);
  refreshDirty();
}

// The note's tab closed. Drop it from the map immediately (nothing may schedule
// another save for a closed note) but let any pending text finish writing: the
// entry itself is still referenced by the running flush.
export function releaseDoc(docId: string): void {
  const e = docs.get(docId);
  if (!e) return;
  if (e.timer !== null) clearTimeout(e.timer);
  docs.delete(docId);
  refreshDirty();
  void flush(e);
}

// Flush every dirty note. Wired to the window losing focus and to pagehide, so
// the debounce window is not the only thing standing between an edit and disk.
export function flushAll(): void {
  for (const docId of docs.keys()) void saveNow(docId);
}

// The same, awaited: ⌘L's flush-then-drop needs every dirty locked buffer on
// disk (encrypted) before Bun drops the key (locking.md §3), and
// fire-and-forget cannot promise that ordering. Flushes everything rather than
// just locked notes, since the extra saves are no-ops for clean buffers and
// filtering here would mean this module learning what locked means.
//
// Resolves with how many notes are still unsaved once it settles, which is
// non-zero only when the writes could not land at all (remote.md §7). A caller
// that is about to put these entries out of reach (a connection switch reloads
// the page) has to know: past that point the text is in no file anywhere, and
// there is no trash to look in.
export function flushAllNow(): Promise<number> {
  // Drops the hold rather than calling releaseSaves: releaseSaves starts its
  // own flushes, and flush returns immediately for an entry already inFlight,
  // so the saveNow calls below would resolve while writes were still out.
  //
  // Dropped at all because every caller is a last chance. A connection switch
  // and a workspace move both put these entries out of reach, so a hold must
  // never be the reason an edit was not attempted (remote.md §7).
  held = false;
  return Promise.all([...docs.keys()].map((docId) => saveNow(docId))).then(
    () => [...docs.values()].filter((e) => e.pending !== null).length,
  );
}

// The file an open note is currently aimed at, or null (no file yet, or an
// unknown docId). The editor pool's vault eviction and rehydration read this:
// the pool tracks views, the store tracks files, and the docId is the join.
export function pathOf(docId: string): string | null {
  return docs.get(docId)?.path ?? null;
}

// Test seam: forget every registered note.
export function resetDocs(): void {
  for (const e of docs.values()) if (e.timer !== null) clearTimeout(e.timer);
  docs.clear();
  refreshDirty();
}
