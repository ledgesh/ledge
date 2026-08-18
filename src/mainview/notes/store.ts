// Autosave: the view-side half of note persistence.
//
// One entry per open note, keyed by docId (the editor pool's key, not the file
// path: a note has a docId from the moment its tab opens, but a path only from
// its first save). Edits land in `pending` and a debounce writes the latest text
// through to Bun. A note with no path yet gets one allocated on that first write,
// which is what makes "a tab you never type in leaves no file" true.
import { configureSession, createNote, retitleNote, writeNote, type NoteMeta } from "./channel";
import { workspaceDefaultCwd } from "../workspace/channel";
import { headingOf, labelOf, slugOf } from "../../shared/slug";
import { parseFrontmatter, type NoteParams } from "../../shared/frontmatter";

// Long enough that a burst of typing is one write, short enough that the window
// where a crash loses work is small. Matches PLAN P1-4.
const SAVE_DELAY_MS = 500;

// The one capability the save path needs from outside this module: the browser
// owns the notice strip (NoteBrowser's configureUi), and importing it here
// would drag React and the command layer into the store's unit tests. The
// configureX pattern of architecture.md §5; App does the wiring.
const ui: { notice?: (message: string) => void } = {};

export function configureStoreUi(fns: { notice?: (message: string) => void }): void {
  Object.assign(ui, fns);
}

// What a save that displaced another writer's version says. The note is NAMED
// because the strip is in the sidebar rather than over the editor, and because
// the diverged note is not always the one being looked at: a flushAll on window
// blur saves every dirty tab at once.
function divergedNotice(label: string): string {
  return `“${label}” also changed elsewhere while you were editing. Your version was saved; the other one is in the Trash.`;
}

// Its mirror image, for the outage case (workspace/editorPool.ts
// resolveStrandedNotes). Deliberately the same sentence shape, because it is
// the same event with the winner the other way round, and a user who has seen
// one should be able to read the other at a glance.
function strandedNotice(label: string): string {
  return `“${label}” changed on the server while you were disconnected. That version is now open; what you had typed is in the Trash.`;
}

interface Entry {
  docId: string;
  // The workspace folder this note belongs to, captured when its tab opened.
  // Stable for the docId's whole life: tabs never move across workspaces
  // (moveTab is scoped to the selected one), so the folder a tab was born in
  // is the folder its first save creates into. Also what the asset calls
  // resolve `.ledge-assets/x.png` against (folderOf below).
  folder: string;
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
  // The disk version this note last read or wrote — writeNote's baseMtimeMs,
  // which is what lets Bun catch an external edit under an autosave instead of
  // silently flattening it. null until the first read or write lands: a note
  // edited that early saves blind, exactly as every save did before the guard.
  mtimeMs: number | null;
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
  // The spawn params (frontmatter merged with the workspace default cwd) Bun
  // last got for this note, as a JSON key. Seeded to "no params" rather than
  // to "unknown" so a frontmatterless note in a defaultless (managed)
  // workspace — nearly every note — never sends a configure at all: for it,
  // Bun's defaults and empty params are the same thing. A note whose
  // workspace DOES carry a default cwd merges to something non-empty and so
  // sends its first configure at bindDoc.
  lastParamsKey: string;
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

// What "nothing yet" serializes to, so entries can start there (see
// Entry.lastParamsKey): no frontmatter, no file. A pathless bind in a
// defaultless workspace lands exactly here and sends nothing.
const EMPTY_PARAMS_KEY = JSON.stringify({ params: parseFrontmatter("").params, notePath: null });

// Send the note's spawn params to Bun if its frontmatter now parses to
// something different. Comparison is on the parsed params, not the block's
// text, so touching a comment (or reflowing whitespace) in the frontmatter
// re-sends nothing. Bun applies params at shell spawn, so an extra send is
// harmless but a missed one is a shell born with stale cwd/env.
//
// A note that names no `cwd:` of its own inherits its workspace's default
// (workspaceDefaultCwd: the folder itself for an external workspace, null for
// a managed one) — merged here, at the one point params leave the view, so
// every consumer Bun-side (persistent, overflow, and drawer shells) gets the
// same answer without knowing workspaces exist.
function syncParams(e: Entry, text: string): void {
  const { params } = parseFrontmatter(text);
  if (params.cwd === null) params.cwd = workspaceDefaultCwd(e.folder);
  // The note's path rides along as a FACT (rpc-schema: Bun stamps it into
  // spawn env as LEDGE_NOTE after validating it). Folding it into the change
  // key means a path change — first save, rename — re-sends on its own, so
  // the fact tracks the file without any parallel bookkeeping. This does cost
  // every on-disk note one send at bind (its location is never "empty"): an
  // extra send is harmless, a missed one is a shell born not knowing its note.
  const key = JSON.stringify({ params, notePath: e.path });
  if (key === e.lastParamsKey) return;
  e.lastParamsKey = key;
  try {
    configureSession(e.docId, params, e.path);
  } catch {
    // No bridge (a store driven in unit tests). Params are advisory — they
    // must never be what breaks seeding or saving.
  }
}

// Register an open note. `folder` is the tab's workspace folder (where a first
// save creates the file); `path` is null for a new note that has no file yet;
// `onFile` fires whenever one is allocated or moves, so the tab can bind to it
// and show its filename. Re-binding an already-open note only refreshes that
// callback: its dirty state, its allocated path, and its seeded slug must survive.
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
  // The workspace default cwd — and, for a note that already has a file, its
  // location fact — must reach Bun even for a note that is never edited or
  // even loaded (a fresh tab whose first act is a Run click), so send the
  // empty text's params now. A pathless bind in a defaultless workspace
  // still merges to exactly EMPTY_PARAMS_KEY and sends nothing. seedSlug
  // re-syncs with the real text once a load lands.
  syncParams(entry, "");
}

// The docId currently bound to a note's file, or null when no open tab holds
// it. Path → docId is one-to-one in practice (openNote focuses an existing tab
// rather than opening a second on the same path), so the first match is the
// match. Used by the editor pool to land a search reveal on an already-open
// note, whose editor no attach will revisit.
export function docIdAt(path: string): string | null {
  for (const e of docs.values()) if (e.path === path) return e.docId;
  return null;
}

// The workspace folder an open note belongs to, or null for a docId the store
// has never seen (an editor built outside the pool, e.g. a test). The asset
// call sites (editor ⌘V paste, image widgets) use this to scope `.ledge-assets/…`
// references to the note's own workspace.
export function folderOf(docId: string): string | null {
  return docs.get(docId)?.folder ?? null;
}

// The spawn params this note last SENT to Bun (lastParamsKey is their JSON —
// parsed back rather than stored twice, so this can never disagree with what
// Bun holds). App's terminal-drawer flow reads `hosts` from here: the drawer
// belongs to the note as a whole, not to an editor view, and this is the one
// view-side record of the note's params that exists outside the editor.
export function paramsOf(docId: string): NoteParams | null {
  const e = docs.get(docId);
  return e ? (JSON.parse(e.lastParamsKey) as { params: NoteParams }).params : null;
}

// Record the heading a note already has on disk, without renaming anything. Called
// as a note's saved text lands in its editor (editorPool.loadNote).
//
// This is the guard that makes naming-by-heading safe to turn on over notes that
// already exist: without it, the first flush of any note would see its slug change
// from "unknown" to whatever its H1 says and move a file the user never asked to
// move. Seeding means the rule only ever applies to headings edited from here on.
export function seedSlug(docId: string, text: string, mtimeMs: number | null = null): void {
  const e = docs.get(docId);
  if (!e || e.slugSeeded) return;
  e.lastSlug = slugOf(text);
  e.lastHeading = headingOf(text);
  e.slugSeeded = true;
  // The read that carried this text also carried the disk version; from here
  // on every save states its expectation (see Entry.mtimeMs).
  if (mtimeMs !== null) e.mtimeMs = mtimeMs;
  // Same moment, opposite direction: the slug is seeded so the file does NOT
  // move, but params already on disk must reach Bun now — the note's first
  // shell can spawn on a Run click long before any edit triggers a flush.
  syncParams(e, text);
}

// The editor's document changed. Schedules a save; called on every keystroke, so
// it does no work beyond stashing the text and arming the timer.
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
 * onTerminalBusyChange), and here for the same reason: a fact the store owns
 * that a component several levels away has to draw, with no route between them
 * through props.
 *
 * Worth drawing at all times and not only during an outage. Until now "saved"
 * and "not saved" looked identical in every state, which is tolerable while the
 * debounce is 500ms and always wins, and exactly wrong the moment a save can be
 * waiting on something (remote.md §7).
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
 * Recompute from the entries and tell the subscribers, if anything moved.
 *
 * Recomputed rather than maintained at each place `pending` is assigned: the
 * set is as big as the open tabs, so this costs nothing, and the alternative is
 * a second piece of bookkeeping that can silently disagree with the first.
 * Notifying only on a real change is what keeps the strip from re-rendering on
 * every keystroke.
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
 * Whether saving is suspended for EVERY note because the server cannot be
 * reached (remote.md §7).
 *
 * Not Entry.frozen, though it stops the flush loop the same way: frozen is one
 * note's rename, this is every note's server, and folding a global condition
 * into a per-entry flag would mean remembering which entries were already
 * frozen for their own reasons before the wire went.
 *
 * Set for a connection that is LOST, never one that is merely reconnecting: a
 * reconnecting client's requests wait on the ladder and land when it returns
 * (shared/transport.ts), so holding those would replace a save that works with
 * one that has to be re-armed. Against a lost connection the write would fail
 * its way back into `pending` anyway, so what the hold really buys is the
 * moment AFTER the wire returns: it keeps a debounce or a blur from landing a
 * stranded write before the reconciliation has decided whether that buffer is
 * still the note (workspace/editorPool.ts resolveStrandedNotes).
 */
let held = false;

export function holdSaves(): void {
  held = true;
}

/**
 * Whether saving is currently suspended, which is also the record of whether a
 * buffer could be STRANDED (workspace/editorPool.ts resolveStrandedNotes).
 *
 * The two questions have one answer because a buffer is stranded exactly when
 * saving was suspended under it. A wire that merely flapped never suspends
 * anything: those writes wait on the ladder and land, so a buffer dirty across
 * a reconnect is somebody mid-thought and the ordinary guard is its arbiter.
 * Reading `held` rather than a second flag is what keeps those two from ever
 * disagreeing about which kind of outage just ended.
 */
export function savesHeld(): boolean {
  return held;
}

/**
 * Let saving resume, and flush whatever accumulated while it could not.
 *
 * Called after the relink reconciliation has settled every stranded buffer and
 * never before it: the entire value of the hold is that nothing writes in
 * between, so a caller that releases early has bought nothing. Idempotent, so
 * the release can sit in a `finally` without caring whether the hold was on.
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
          // agent, git, vim — or, with more than one client on a server
          // (remote.md §7), this same user's other device. The buffer won the
          // live path (the user is the one typing) and the loser is
          // recoverable in the Trash section, whose count the watcher's
          // refresh updates.
          //
          // A notice, not a dialog: nothing was lost and there is nothing to
          // decide. But not a console line either, which is what this was while
          // the other writer could only be a program on this machine — when it
          // is your own phone, a silent trash-and-carry-on is the app losing
          // half of what you wrote as far as anyone can see. The log stays for
          // the exact trash path, which the strip has no room for.
          if (res.divergedTo) {
            console.warn("[notes] this note changed on disk mid-edit; that version is in the trash:", res.divergedTo);
            ui.notice?.(divergedNotice(labelOf(headingOf(text), e.path)));
          }
        } else {
          // createNote names the file from this same text's H1, so a note titled
          // before its first save is born correctly named rather than created as
          // untitled.md and renamed a beat later. It lands in the tab's own
          // workspace folder, captured at bindDoc.
          const note = await createNote(e.folder, text);
          e.path = note.path;
          e.mtimeMs = note.mtimeMs;
          e.handlers.onFile(note, null);
        }
        // Before syncTitle: a failed rename must not also cost Bun the params
        // update (syncParams is already idempotent for the retry that follows).
        syncParams(e, text);
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
    refreshDirty();
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
  // rename(2) preserves mtime, so this is normally a no-op — but the meta's
  // stat is the truth, and adopting it keeps the guard aligned with the file.
  e.mtimeMs = note.mtimeMs;
  if (note.path === prev) return; // already correctly named
  e.path = note.path;
  e.handlers.onFile(note, prev);
  // The file moved, so the session's location fact must follow: the note's
  // NEXT shell should be born knowing where the note is, not where it was.
  // (A shell already running keeps its stale LEDGE_NOTE — restart-applies,
  // like every spawn param; title addressing is the rename-proof spine.)
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
// a note Ledge has open. A CLEAN buffer simply adopts the disk text — the
// decision half lives here (which notes may reload, and what adopting means
// for the tracking state), the DOM half (pouring text into CodeMirror) in
// editorPool.reloadOpenNotes, per the pure-core/thin-wrapper split.
// A DIRTY buffer is deliberately not a candidate: the user is mid-thought,
// and their next save's baseMtimeMs guard arbitrates instead (the external
// version lands in the trash, nothing is lost).

export interface ReloadCandidate {
  docId: string;
  path: string;
  // The disk version the buffer currently reflects; a differing stat means
  // the file moved on and the buffer should follow.
  mtimeMs: number | null;
}

// Every open note whose buffer could safely be replaced right now: it has a
// file, its load has landed (slugSeeded — a reload racing the initial load
// would double-pour), and nothing is pending, in flight, or frozen.
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
 * What a buffer that never reached the server looks like to the caller that has
 * to settle it.
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
 * The exact complement of reloadCandidates: those are the buffers safe to
 * overwrite, these are the ones it deliberately skips, and after an outage they
 * are precisely the writing at risk (remote.md §7).
 *
 * `frozen` and `inFlight` disqualify here as they do there, for the same reason
 * in both cases: a rename has that entry's path in the air, and a write already
 * out is past recall. The save hold is NOT a disqualifier, because it is the
 * state this list exists to be read in.
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
 * The one place in this module that DISCARDS pending text, which everything
 * else exists to avoid. It is only defensible because the caller has already
 * put that text somewhere recoverable (channel stashNote), and it must not be
 * called by anything that has not: `stashed` is the text that was parked, and a
 * buffer that no longer matches it is refused.
 *
 * That check is the same one reseedDoc makes and is here for the same reason:
 * parking the text was a round trip, and a buffer typed into since is not
 * stranded any more — somebody is at the keyboard, so it keeps its own text and
 * the ordinary divergence guard arbitrates their next save.
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
  // exactly the tracking consequences adopting an external edit does, including
  // the rule that a heading changed on disk relabels the tab without renaming
  // the file. Its own dirty check now passes, the line above having cleared it.
  if (!reseedDoc(docId, path, text, mtimeMs)) return false;
  // Only when something was actually parked. Two clients that happened to type
  // the same words displace nothing and are worth saying nothing about.
  if (stashedTo !== null) ui.notice?.(strandedNotice(labelOf(headingOf(text), path)));
  return true;
}

// Adopt an external edit's text as the note's new baseline, re-checking that
// the entry is STILL clean and still aimed at `path` — the read was async, and
// a keystroke (or a delete, or a retitle) may have landed since the candidate
// list was drawn. False means "do not touch the editor"; the caller drops the
// reload and the normal save path takes it from there.
//
// Adopting re-seeds the slug/heading tracking rather than diffing it: a
// heading that CHANGED on disk must relabel the tab but must not rename the
// file — the rename rule stays "a heading you edit here", and a disk-side
// H1 edit is one you opened, not one you made (same stance as seedSlug).
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

// The same, awaited: ⌘L's flush-then-drop needs every dirty LOCKED buffer on
// disk (encrypted) before Bun forgets how to encrypt it, and fire-and-forget
// cannot promise that ordering. Flushes everything rather than just locked
// notes: the extra saves are no-ops for clean buffers, and filtering here
// would mean this module learning what locked means.
//
// Answers with how many notes are STILL unsaved when it settles, which is only
// ever non-zero when the writes could not land at all (remote.md §7). Callers
// that are about to make these entries unreachable — a connection switch, which
// reloads the page — have to know: past that point the text is in no file
// anywhere, and there is no trash to look in.
export function flushAllNow(): Promise<number> {
  // The hold is dropped rather than released, and the difference matters:
  // releaseSaves would start its own flushes, and saveNow's `inFlight` guard
  // returns immediately against one already running — so this would resolve
  // while writes were still out, which is the one promise this function makes.
  //
  // Dropped at all because every caller is a last chance. A connection switch
  // and a workspace move are both about to put these entries out of reach, so a
  // hold must never be the reason an edit was not even attempted (remote.md §7).
  held = false;
  return Promise.all([...docs.keys()].map((docId) => saveNow(docId))).then(
    () => [...docs.values()].filter((e) => e.pending !== null).length,
  );
}

// The file an open note is currently aimed at, or null (no file yet, or an
// unknown docId). The editor pool's vault eviction/rehydration reads this —
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
