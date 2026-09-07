// The typed contract between the Bun main process and the editor webview.
// This replaces the hand-rolled window.webkit.messageHandlers bridge from the
// Swift build: the webview requests a block run, Bun streams run events back.

import type { AuthMode } from "./connections";
import type { Settings, SettingsHome } from "./settings";
import type { NoteParams } from "./frontmatter";
import type { SearchHit } from "./search";
import type { TagInfo } from "./tags";

/** A streamed update about one running block, pushed Bun -> webview. */
export type RunEvent =
  | { id: string; kind: "began" }
  // Output bytes, base64-encoded because RPC payloads are JSON.
  | { id: string; kind: "output"; dataB64: string }
  // `exitCode: null` means the shell exited with the block still running (the
  // block ran `exit`, or the shell was killed), so there is no status to
  // report. The event still has to arrive: it is what takes the panel off
  // "Running" and re-enables the block's run button, which stays disabled for
  // as long as the run is going.
  | { id: string; kind: "ended"; exitCode: number | null };

/**
 * What happened to a note's terminal shell while a client was unreachable
 * (`terminalClaim` below). Three states, one per push that was dropped: the
 * bytes the shell printed, the client that took it, or its exit.
 */
export type TerminalClaim =
  // Still this client's shell. `dataB64` is the whole scrollback to replay:
  // the bytes pushed at the dead wire sit in the ring like any others
  // (remote.md §7). `host` is what the badge shows, as terminalAttach
  // reports it.
  | { state: "attached"; dataB64: string; host: string }
  // Another client attached while this one was away, so the `terminalDetached`
  // push went nowhere. `by` names that client, resolved through the presence
  // list the same way the push's name is.
  | { state: "held"; by: string }
  // No shell under this session: it exited, or another client restarted it
  // (sessionRestart is open to any client). The `terminalExit` push that says
  // so was dropped too, so claiming is how that news arrives late.
  | { state: "gone" };

/**
 * One note on disk. `path` is the note's identity; `title` is what to call it on
 * screen (its first-line H1, or its filename if it has none).
 */
export interface NoteMeta {
  path: string;
  title: string;
  mtimeMs: number;
  // Present when the note's frontmatter marks it a template
  // (shared/frontmatter.ts), absent otherwise. The role rides the marker's own
  // value rather than a second field: `true` is an ordinary template, listed
  // in the "New Note from Template…" picker; `"daily"` is the one ⌘J
  // instantiates each day. It rides the meta instead of taking its own query.
  // listNotes already reads each note's head for the title. The view's
  // per-folder lists are therefore the live template registry, and the watcher
  // they already have refreshes it.
  template?: true | "daily";
  // Where inside its workspace the note sits: a root-relative path with
  // forward slashes ("projects/api"), absent at the top level. This is
  // placement, not identity: the note is still addressed by title, and `path`
  // is still the handle every call takes. Every flat list of notes
  // (quick-open, full-text search, backlinks, the sidebar tree's own
  // grouping, the agents' listings) needs it to say which of two same-titled
  // notes a row means. Derived from the path Bun-side, so it cannot go stale.
  // Optional, so a workspace with no folders sends nothing extra.
  folder?: string;
  // Present when the note's frontmatter declares `favorite: true`, absent
  // otherwise. The note browser draws its Favorites section from the per-folder
  // lists it already has, the way the ⌥⌘N picker draws itself from `template`,
  // so the marker needs no query and no registry. It rides the same head read
  // the title does.
  favorite?: true;
  // Present when the note is locked (its frontmatter carries the crypto
  // header, locking.md). The sidebar and ⌘P lock glyph, the scans' skip, and
  // the agent listings' flag all read this. It rides the same head read the
  // title does, since the plaintext head carries that header.
  locked?: true;
}

/** The vault's current state (bun/vault.ts): "none" until the first lock
 * creates it, then "locked" or "unlocked" depending on whether the master key
 * is loaded. */
export type VaultState = "none" | "locked" | "unlocked";

/** A CLI open request after Bun resolved and guarded it (bun/openRequest.ts).
 * It carries the note as a full NoteMeta, which is what the store's openNote
 * takes, plus the workspace root holding it, so the view can select that
 * workspace without a lookup. Both directions of `ledge <title>` use it:
 * openRequestTake (cold start) and the openExternal push (app already
 * running). */
export interface ExternalOpenInfo extends NoteMeta {
  root: string;
}

/**
 * The directory pasted images land in, under each workspace root. It is part
 * of the cross-boundary contract, not just a Bun detail: assetPaste returns
 * `${ASSETS_DIRNAME}/x.png` references into note text, and the view's image
 * classifier (editor/images.ts imageSrcOf) must accept exactly this one
 * dot-entry, so a second literal would drift from it. Dotted and
 * app-prefixed like the trash, so Ledge's writes never mingle with an
 * attached project's own `assets/` folder.
 */
export const ASSETS_DIRNAME = ".ledge-assets";

/**
 * One deleted note in its workspace root's .ledge-trash. `path` is where the
 * file sits now, and it is the handle restore and undo are given. `deletedAt`
 * is when the note was trashed (listTrash in bun/notes.ts is where that
 * number comes from).
 */
export interface TrashMeta {
  path: string;
  title: string;
  deletedAt: number;
}

/**
 * One incoming wikilink, as the Backlinks panel shows it. It carries the
 * linking note's meta (a full NoteMeta, so opening the hit is an ordinary
 * openNote), the 1-based line the link sits on, that line's trimmed text for
 * the row (`context`, capped Bun-side), and the `[[...]]` match exactly as
 * written (`raw`). `raw` is the reveal query, re-found on the line so a file
 * that has moved on still lands on the link (workspace/reveal.ts).
 */
export interface BacklinkHit extends NoteMeta {
  line: number;
  context: string;
  raw: string;
}

/**
 * One tag occurrence, as the Tags panel's drill-in lists it. It has
 * BacklinkHit's shape: the bearing note's meta (opening the hit is an
 * ordinary openNote), the 1-based line the tag sits on (a body `#tag` line,
 * or the frontmatter `tags:` line), that line's trimmed text for the row, and
 * the tag exactly as written there (`raw`). `raw` is the reveal query,
 * re-found on the line like a backlink's.
 */
export interface TagHit extends NoteMeta {
  line: number;
  context: string;
  raw: string;
}

/**
 * One registered workspace root (bun/workspaces.ts). `root` is the folder's
 * absolute path, the opaque handle the view passes back on every scoped call.
 * `kind` says who created it:
 *
 * - "managed": lives directly in ~/.ledge, and Bun may recreate it.
 * - "external": the user picked it in the native dialog, and Bun never mkdirs
 *   it.
 * - "docs": the single built-in documentation folder, which Bun syncs at
 *   launch. Bun registers it for the read paths and refuses it at every write
 *   seam. The view renders it as the hidden read-only Documentation
 *   workspace, never a strip row.
 *
 * `available: false` means the folder is registered but missing on disk right
 * now (an unmounted volume). The view then keeps its saved layout dormant
 * rather than pruning it.
 */
export interface WorkspaceRootInfo {
  root: string;
  kind: "managed" | "external" | "docs";
  available: boolean;
}

/**
 * One configured server (remote.md §8), as the view sees it. The stored
 * record carries more (bun/connections.ts): the pinned known_hosts line is a
 * hundred characters of base64 that only ssh reads, so this shape sends only
 * whether one exists. `destination` is "" for the server in this process, the
 * one connection that always exists and cannot be removed.
 */
export interface ConnectionInfo {
  id: string;
  name: string;
  destination: string;
  /** Where sshd listens, or 0 to let ssh decide, which is what keeps a
   * `~/.ssh/config` alias's own `Port` working (shared/connections.ts). */
  port: number;
  keyPath: string;
  /** How this connection authenticates (shared/connections.ts). The password
   * itself is never in this shape and never crosses this schema in this
   * direction: it goes to the keychain on the way in, and ssh's askpass
   * helper reads it from there, so nothing ever reads one back out. */
  auth: AuthMode;
  pinned: boolean;
  /** ms epoch, 0 for never reached. */
  lastReached: number;
}

/**
 * One other device connected to the same server (remote.md §7), as the view
 * sees it. These two fields are everything a client is told about another
 * client. What that client has open is not sent: a list of its open notes
 * would put a second device's screen on this one.
 */
export interface PeerInfo {
  /** The id from its handshake (wire.ts `Hello.client`). Opaque and never
   * shown. It is here so a push that names a client (`terminalDetached`) can
   * be turned into a name. */
  client: string;
  /** What that device calls itself (`Hello.label`). Empty when the device
   * gave no name, and the view renders that as "another device" rather than
   * as a gap. */
  label: string;
}

/**
 * One item of the native menu bar. The view owns the shape and derives the
 * whole menu from the command registry (commands/menu.ts). Bun owns the
 * native call, the way it owns the bytes of a layout the view shapes.
 *
 * `action` is a command id, opaque to Bun. It comes back verbatim in the
 * `menuCommand` message, and the view execs it through the same dispatcher
 * the palette uses. `role` is a native AppKit selector (undo, copy, quit)
 * that the responder chain handles instead, and it never reaches the view.
 */
export type AppMenuItem =
  | { type: "divider" }
  | {
      label: string;
      action?: string;
      role?: string;
      // Electron-style ("command+shift+p"). Setting one takes the chord away
      // from the WebView, since AppKit's key-equivalent pass runs first
      // (interactions.md §10), so most items carry none.
      accelerator?: string;
      enabled?: boolean;
      submenu?: AppMenuItem[];
    };

export type LedgeRPC = {
  bun: {
    requests: {
      // The workspace-roots registry (workspaces.ts). Fetched once at boot,
      // before the per-root note lists: the roots are the opaque handles every
      // scoped call below carries. Unavailable roots are reported, not hidden,
      // so the view can keep their saved layout dormant instead of pruning it.
      // `dailyRoot` rides along because it is derived from this same registry:
      // the daily.workspace setting resolved to one of these roots, or null
      // when it is unset or names a root that is gone. It says where ⌘J acts,
      // and the Edit Daily Template faces need that root to aim at. Read at
      // boot like the setting itself, so a change applies at the next launch.
      // `folderDialog` rides along for the same reason: it is a fact about the
      // machine this registry lives on, namely whether anybody is sitting at it
      // to answer a native folder picker. It is false on every headless server,
      // and the view then leaves Attach Folder and Move Workspace Folder out of
      // the palette rather than offering verbs that can only answer with an
      // error strip (ios.md §8, mainview/lib/shell.ts).
      // `cliShim` is the same shape of fact, for Install Shell Command: whether
      // this machine has a CLI to put on a PATH. The app carries one beside its
      // main module; a compiled `ledge-server` does not.
      workspaceList: {
        params: {};
        response: {
          workspaces: WorkspaceRootInfo[];
          dailyRoot: string | null;
          folderDialog: boolean;
          cliShim: boolean;
        };
      };
      // Create a managed workspace folder from a display name. Bun slugs the
      // name into a folder itself and registers it. The view never names a
      // path here, the same trust move as noteCreate. Sent by "New Workspace".
      workspaceCreate: { params: { name: string }; response: { root: string } };
      // Open the native folder picker and register the chosen directory as a
      // workspace root. The dialog runs Bun-side, so the path never rides the
      // RPC and an arbitrary external root stays inside the trust boundary
      // (architecture.md §2). root null with error null means the user
      // cancelled. An error string means the choice was refused (not a
      // directory, or nested with another root). Picking an already-registered
      // folder returns it, and the view focuses that workspace instead of
      // adding a twin.
      workspaceAttach: { params: {}; response: { root: string | null; kind: "managed" | "external" | null; error: string | null } };
      // Remove a root from the registry. Never deletes files: the folder and
      // every note in it stay on disk, re-attachable later. Sent when a
      // workspace is closed. The view refuses to close the last one.
      workspaceDetach: { params: { root: string }; response: { ok: boolean } };
      // Relocate a registered root's folder on disk (Move Workspace Folder…).
      // The native folder picker chooses the destination parent Bun-side, so
      // the destination never rides the RPC (workspaceAttach's trust move), and
      // Bun renames the folder into it. Same volume only, and everything inside
      // travels. root null with error null means cancelled. A returned root is
      // the workspace's new handle, with `kind` recomputed, since moving into
      // or out of the app home flips managed/external. Returning the old root
      // unchanged means the chosen destination was already its parent.
      // `home: true` (Move Workspace Folder Home) skips the picker and targets
      // Bun's own APP_HOME, the return path for an external workspace. It needs
      // no dialog because ~/.ledge is hidden and awkward to navigate to in a
      // picker. Still no view-named path.
      workspaceMove: { params: { root: string; home?: boolean }; response: { root: string | null; kind: "managed" | "external" | null; error: string | null } };
      // The note store (notes.ts). Bun owns every path: the view holds paths
      // only as opaque handles it got from here, and Bun rejects any that fall
      // outside the registered workspace roots (workspaces.ts). Scoped calls
      // name their root explicitly, checked for exact registry membership.
      // Per-note calls send just the path, and Bun derives its root, since a
      // path determines the root it is under. Notes are plain .md files.
      // `path` identifies the file; `sessionId` (the docId) identifies the live
      // editor and its shells (architecture.md §4).
      noteList: { params: { root: string }; response: { notes: NoteMeta[] } };
      // Read one note. null when the note is gone (deleted behind the app's
      // back). `mtimeMs` is the note's disk version: the view holds it per open
      // note and hands it back on every noteWrite, which is how a save tells
      // "my own last state" from "someone else wrote here".
      // A locked note carries `locked: true`. `held: true` means the body was
      // withheld because the vault is locked: `text` is only the plaintext
      // head, and the view shows the locked placeholder instead of an editor.
      // `damaged` rides on held when the ciphertext fails authentication
      // (modified outside Ledge), and the placeholder then says restore from
      // backup rather than prompting for a passphrase that cannot help.
      noteRead: {
        params: { path: string };
        response: { note: { text: string; mtimeMs: number; locked?: true; held?: true; damaged?: true } | null };
      };
      // Atomic overwrite (temp file plus rename), so a crash mid-save cannot
      // truncate a note. Sent on a debounce as the user types and on Cmd+S.
      // `baseMtimeMs` is the disk version the view last saw (from noteRead,
      // this call's own response, or NoteMeta). null means no expectation, for
      // a note edited before its first read landed, and writes blind, as every
      // write did before the guard existed.
      // On a mismatch whose bytes really differ (an agent or terminal edit, or
      // another client's save landing while the note was edited here, remote.md
      // §7) the buffer wins the live path, because the user is the one typing.
      // The disk version is moved into the root's .ledge-trash first, never
      // overwritten in place: `divergedTo` says where it landed, and it stays
      // recoverable in the Trash section. The view shows a non-null
      // `divergedTo` on the browser's notice strip (interactions.md §4-2).
      // With two clients on one server, the displaced writer is often the same
      // person's other device.
      // A mismatch whose bytes are identical just adopts the disk mtime.
      noteWrite: {
        params: { path: string; text: string; baseMtimeMs: number | null };
        response: { mtimeMs: number; divergedTo: string | null };
      };
      // Allocate a file in the given workspace root for a note that has none
      // and write its first content, returning the note the view then saves to
      // and titles its tab from. Sent on a note's first edit, so a tab opened
      // and never typed in creates nothing. The root is the tab's workspace at
      // the moment of creation, and tabs never move across workspaces.
      // `folder` places the new note inside the root ("projects/api",
      // root-relative, created if missing). Absent or empty is the root itself.
      // It is the only name the view chooses in this whole file (filenames are
      // slugged from the note's own H1), so bun/notes.ts folderPathOf guards it
      // the way assetPathOf guards an image reference.
      noteCreate: { params: { root: string; text: string; folder?: string | null }; response: { note: NoteMeta } };
      // Move a note into another folder of its own workspace, keeping the name
      // its heading gave it (suffixed only if the destination already holds
      // that name). A rename(2), so the note's docId, editor, undo history and
      // shell are unaffected. `folder` null or empty is the root. Bun rewrites
      // the note's image references for the new folder, and refuses a locked
      // note whose vault is shut, because those references sit inside the
      // encrypted body (bun/notes.ts moveNote).
      noteMove: { params: { path: string; folder: string | null }; response: { note: NoteMeta } };
      // Rename a folder of one workspace, keeping it where it sits. `name` is
      // one segment, never a path (shared/folders.ts folderLeafProblem). One
      // rename(2) of the directory, so it is atomic however many notes are
      // under it, and no note's bytes are read or written. A locked note
      // therefore travels with its vault shut, where noteMove has to refuse
      // one. No body needs rewriting: image references are relative to the
      // note, and the folder's depth does not change. `moved` is every note
      // that travelled, old path beside new meta, for the view to carry its
      // open tabs across (notes/actions.ts).
      folderRename: {
        params: { root: string; folder: string; name: string };
        response: { folder: string; moved: Array<{ from: string; note: NoteMeta }> };
      };
      // Delete a folder of one workspace by deleting the notes in it: every
      // one, at any depth, each moved into the trash exactly as `noteDelete`
      // moves one. Not a directory move, though the trash mirrors the
      // workspace's folders and one would land the notes in the same places.
      // A directory move also takes what the note list does not show
      // (dot-folders, ignored subtrees, images), and the Trash section lists
      // only notes, so such a move would bury that content rather than delete
      // it (bun/notes.ts deleteFolder). The emptied directories are then
      // removed, deepest first, and only while `rmdir` accepts them, so
      // anything left behind keeps its folder. `trashed` is every note that went, old path
      // beside where it landed, which is what Undo restores from
      // (notes/actions.ts).
      folderDelete: {
        params: { root: string; folder: string };
        response: { trashed: Array<{ from: string; to: string }> };
      };
      // Move a note's file to match its first-line H1, returning where it now
      // lives (possibly unmoved). The view sends the note's text, not a name:
      // Bun slugs the heading itself, so the name is safe by construction and a
      // buggy view has nothing to smuggle through. Sent only when a note's slug
      // actually changes, never on an ordinary edit. The docId is untouched, so
      // the note's editor and shell are unaffected.
      noteRetitle: { params: { path: string; text: string }; response: { note: NoteMeta } };
      // Add or remove the note's `favorite: true` frontmatter line, the marker
      // the browser's Favorites section reads. One line of the block changes
      // and every other byte is preserved, so this is a text edit Bun happens
      // to make: the same line typed by hand means the same thing. A locked
      // note takes it with the vault shut, since the marker sits in the
      // plaintext head beside its tags (locking.md §2) and the body is never
      // read. `on` false on a note that is not marked is a no-op, so the two
      // command faces cannot fight over a stale list.
      noteFavorite: { params: { path: string; on: boolean }; response: { note: NoteMeta } };
      // Create or open today's daily note (bun/daily.ts openDaily). Bun
      // computes the local YYYY-MM-DD title and resolves it by title in the
      // daily workspace: the daily.workspace setting when it names a registered
      // root, else `root`, the view's selected workspace. Bun creates the note
      // when it is missing, from the note marked `template: daily`. A workspace
      // with no such template gets a bare "# <date>" instead. The response is
      // ExternalOpenInfo so the view can feed it to the same subscriber a CLI
      // open rides (notes/channel.ts dispatchExternalOpen), keeping one
      // definition of select-workspace-then-open. Sent by the ⌘J command.
      dailyOpen: { params: { root: string }; response: { open: ExternalOpenInfo; created: boolean } };
      // Instantiate a template note into a new note in `root`: marker strip,
      // {{token}} substitution, H1 forcing (shared/template.ts), then the same
      // store path as noteCreate, so H1-slug naming and uniqueName still hold
      // and nothing can clobber an existing note. `templatePath` is a path,
      // unlike the title-addressed MCP and CLI surfaces. The ⌥⌘N picker's rows
      // come from the live note lists, so the view already picked a concrete
      // note, and re-resolving its title here could land on a different note
      // with the same name in another workspace. The path passes the same
      // guards every view-sent path does (readNote's assertNote). `title` null
      // means "Untitled", and the H1 is the rename UI.
      noteFromTemplate: { params: { root: string; templatePath: string; title: string | null }; response: { note: NoteMeta } };
      // Delete a note by moving it into its own root's .ledge-trash. Not an
      // unlink, so a misclick costs a trip to the Trash section rather than the
      // note. The trash is an app-private folder, not the system trash (see
      // trashDirOf in notes.ts), and one per root, so the move never crosses a
      // filesystem. Responds with where the note landed, the handle Undo
      // restores from, or null when there was nothing there to delete.
      noteDelete: { params: { path: string }; response: { trashed: string | null } };
      // Park a buffer's text in the note's own root trash, though that text was
      // never a file. Sent when a note was edited here while the server could
      // not be reached and the server's copy moved on meanwhile (remote.md §7):
      // the buffer is somebody's writing, it is no longer what the note says,
      // and the live path has nowhere to put it. noteDelete cannot carry it,
      // because that call moves an existing file. Responds with where it
      // landed, which the notice names. A locked note's stash is sealed exactly
      // as a save is, so this is never the path that writes a locked body in
      // the clear. It fails the same way a save does when the vault has
      // relocked, leaving the caller holding the buffer.
      noteStash: { params: { path: string; text: string }; response: { stashed: string } };
      // Full-text search over one workspace's note bodies, the query as one
      // case-insensitive substring (shared/search.ts owns the grammar and the
      // caps). Sent, debounced, as the search overlay's query changes, scoped
      // to the selected workspace like the browser and quick-open. Bun owns the
      // scan because the files are its to read: shipping every body across the
      // RPC would scale the payload with the notes folder instead of with the
      // result list. Hits arrive newest note first, each carrying the note plus
      // the matched line, so the view can list, open, and reveal without a
      // second request.
      // `lockedSkipped` counts the workspace's locked notes, whose bodies the
      // scan never reads (locking.md §4). The skip holds whether the vault is
      // open or shut. The overlay renders the count as a muted footer, so the
      // skip shows where the answer would have been. The same count rides every
      // body scan below.
      // `folder` narrows the scan to one folder of that workspace and the
      // folders inside it (shared/folders.ts notesUnder); empty or absent means
      // the whole workspace. It selects among notes already found rather than
      // naming a place to write, so it never becomes a path and needs no guard:
      // a folder nothing is in answers with nothing. The narrowing happens
      // before the scan reads a byte, because the hit cap stops the scan after
      // MAX_HITS, and filtering afterwards would let notes outside the folder
      // spend that budget.
      noteSearch: { params: { root: string; query: string; folder?: string }; response: { hits: SearchHit[]; lockedSkipped: number } };
      // The notes whose [[wikilinks]] point at this note, for the Backlinks
      // panel. Sent when the panel is open and the shown note changes, or its
      // folder's files do (the notesChanged push). Bun owns the scan for
      // noteSearch's reason: the view never holds note bodies. It is the same
      // scan the MCP backlinks tool runs (bun/notes.ts backlinksTo), so links
      // resolve by title within the note's own workspace, exactly as the
      // linking notes' editors resolve them. Only the path crosses the RPC, and
      // its root is derived Bun-side like every per-note call.
      noteBacklinks: { params: { path: string }; response: { backlinks: BacklinkHit[]; lockedSkipped: number } };
      // One workspace's tag directory: every tag its notes carry (frontmatter
      // `tags:` and inline #hashtags, shared/tags.ts owns the grammar), with
      // per-note counts, alphabetical. Sent when the Tags panel's directory is
      // showing and on the notesChanged push. It also feeds the overlay's tag
      // rows and the editor's # completion vocabulary. Bun owns the scan for
      // noteSearch's reason: the view never holds note bodies. The scan is
      // scoped to one root because a tag names notes within a workspace, not
      // across them, the same as a wikilink. Scan on demand, no index: the
      // backlinksTo cost class, accepted for the same reasons.
      // Locked notes still contribute their frontmatter `tags:`, which the user
      // put in the plaintext head. lockedSkipped says their body hashtags went
      // unread.
      // `folder` narrows it exactly as noteSearch's does, so an overlay scoped
      // to a folder offers that folder's tags rather than the workspace's.
      tagList: { params: { root: string; folder?: string }; response: { tags: TagInfo[]; lockedSkipped: number } };
      // The occurrences of one tag across a workspace, newest note first, for
      // the Tags panel's drill-in. The same scan as tagList over the same
      // scope, filtered to one case-folded identity. Each hit carries the note
      // plus the occurrence line, so the view can list, open, and reveal
      // without a second request (noteSearch's shape).
      tagNotes: { params: { root: string; tag: string }; response: { hits: TagHit[]; lockedSkipped: number } };
      // One workspace's deleted notes that are still recoverable, newest first.
      // Read at boot and at every folder refresh, alongside noteList, so the
      // count is on screen whether or not the Trash section is expanded.
      trashList: { params: { root: string }; response: { items: TrashMeta[] } };
      // Move a trashed note back to the root it was deleted from, returning
      // where it landed (its old name may be taken by now). Backs both Undo and
      // the Restore button, which are the same operation. Undo is the shortcut
      // to the one that stays available in the Trash section.
      trashRestore: { params: { path: string }; response: { note: NoteMeta } };
      // Unlink one trashed note, for good. Like trashEmpty it destroys a note
      // outright, so the view confirms first. Unlike trashEmpty, only the note
      // named can go. Responds false when it was already gone.
      trashDelete: { params: { path: string }; response: { removed: boolean } };
      // Unlink every trashed note in one workspace. Destroys notes outright, so
      // the view confirms first.
      trashEmpty: { params: { root: string }; response: { removed: number } };
      // Run one fenced block. Shells are per note: `sessionId` is the tab's
      // stable docId. Bun spawns that note's persistent inline-run shell on the
      // first runBlock and closes it on closeSession, so a `cd` in one note
      // never leaks into another. A block run while that shell is mid-block
      // gets a temporary overflow shell of its own for concurrent inline runs
      // (bun/inlinePool.ts), torn down when the run ends.
      // `language` is the fence's info string ("python", "node", ...). Bun
      // picks the runner from it: source into the shell, or exec an interpreter
      // on the temp file (bun/runner.ts). The view never decides how code runs.
      // `host` is the machine the user picked for this run in the note's host
      // picker, or absent to let the note's frontmatter decide (its single
      // declared host, else local). Bun re-validates it against the note's
      // declared list (resolveHost in bun/index.ts): the frontmatter is the
      // allowlist, and the view's picker is only its UI.
      runBlock: {
        params: { sessionId: string; id: string; code: string; language: string | null; host?: string | null };
        response: { accepted: boolean };
      };
      // Interrupt one running block: SIGINT to its shell's foreground process
      // group. `id` names the run, and Bun routes the signal to the shell
      // executing it. Sent when a still-running block's output panel is
      // dismissed, so the program does not keep running with nothing on screen
      // to stop it. The persistent shell ignores SIGINT and keeps its cwd/env.
      cancelRun: { params: { sessionId: string; id: string }; response: { ok: boolean } };
      // Match the winsize of the shell executing run `id` to the block's
      // rendered terminal grid, so size-aware programs (paging, full-screen
      // redraws) lay out correctly in the inline panel. This may arrive before
      // runBlock, since the panel fits itself as soon as it renders. Bun
      // stashes the size and applies it when the run picks its shell.
      inlineResize: { params: { sessionId: string; id: string; cols: number; rows: number }; response: { ok: boolean } };
      // Keystrokes and pasted text from a block's inline terminal to the shell
      // executing run `id`, so an interactive program running inline (a REPL,
      // vim, claude) can be driven in place. `dataB64` is base64, like
      // terminalInput's. The view sends this only while the block's command is
      // the running foreground process.
      inlineInput: { params: { sessionId: string; id: string; dataB64: string }; response: { ok: boolean } };
      // `ids` names the inline runs this client can still show. Every run the
      // server is executing that `ids` does not name is interrupted, exactly as
      // dismissing its panel would (cancelRun). Sent at boot and after every
      // reconnect, the two moments a client's idea of what is running can have
      // gone stale. A reloaded page names nothing, because a run event is a
      // push keyed by an id that page never learned. Without this call the run
      // would keep going, keep the server alive under it, and be both invisible
      // and unstoppable. The drawer's equivalent is terminalClaim below: a
      // reloaded page re-adopts its shell by mounting a drawer that attaches,
      // while a page whose wire dropped has its drawer already mounted and
      // attaches nothing.
      // Held output is released first, before the answer. Run output pushed at
      // an absent client is held rather than dropped, because it is a sequence
      // and nothing can re-read it (bun/server.ts `missed`). Releasing it here
      // lands the held bytes ahead of whatever the run has printed since. The
      // `ended` for a run that finished during the outage is among them, so
      // that panel takes its real exit code and its last output, and `running`
      // then has no stale panel left to close out. A client reads the answer
      // against what its panels show after the release, not before
      // (mainview/editor/bridge.ts).
      // `running` is which of `ids` the server is really running, so a client
      // that missed an `ended` while the wire was down closes those panels
      // instead of leaving them on "Running" for good. `orphaned` counts the
      // unclaimed runs that were interrupted, for the log.
      // Scoped to the calling client both ways (remote.md §7): it is told about
      // none of another client's runs and interrupts none of them. The server
      // knows who is asking from the connection's handshake. This call takes no
      // client parameter, because a client that filled one in could fill it in
      // with somebody else's.
      inlineClaim: { params: { ids: string[] }; response: { running: string[]; orphaned: number } };
      // Terminal drawer input and resize, targeting one note's terminal shell.
      // Keystrokes and pasted text go through terminalInput. The drawer's fit
      // computes cols/rows for terminalResize. This shell is separate from the
      // note's inline-run shell, which keeps the marker protocol isolated from
      // raw xterm.
      // Both calls belong to the client that owns the drawer (terminalAttach
      // below). ok:false means the caller no longer holds it: its keystrokes
      // would land in a shell it cannot see, and its window's grid would reflow
      // the screen the owner is reading. Neither call spawns a shell, and a
      // session with no shell also answers ok:false, so a resize cannot race a
      // drawer's attach into spawning on the wrong host.
      terminalInput: { params: { sessionId: string; dataB64: string }; response: { ok: boolean } };
      // Run a (possibly multi-line) block in the terminal as if it were pasted.
      // Bun wraps `text` in bracketed-paste markers and holds it until the
      // shell has enabled bracketed-paste mode. zsh then buffers every line
      // into one command (all echo together, then all output, under one prompt)
      // instead of running line by line, and the markers never leak as literal
      // text on a cold shell.
      // `language` rides along when the paste is a fenced block sent to the
      // terminal. An interpreted language (see runBlock) pastes its runner line
      // (`python3 /tmp/...py`) instead of the raw code, which zsh could not
      // run. Shell blocks and the drawer's own Cmd+V pass no language and paste
      // text as-is.
      // `host` matters only when this call is what spawns the shell (a paste
      // into a note whose drawer was never opened). An already-live drawer
      // shell keeps the host it was born on, and the runner line for an
      // interpreted block is built for that host, so a remote drawer never gets
      // a local temp path it cannot read.
      terminalPaste: { params: { sessionId: string; text: string; language?: string | null; host?: string | null }; response: { ok: boolean } };
      terminalResize: { params: { sessionId: string; cols: number; rows: number }; response: { ok: boolean } };
      // Attach lazily spawns the note's terminal shell if there is none,
      // returns the scrollback so far, and turns on live streaming. The
      // scrollback is what makes a freshly opened drawer show the existing
      // prompt and history. Detach turns streaming off while the drawer is
      // closed or showing another note. Scrollback keeps accumulating either
      // way.
      // `host` is the machine picked for the spawn, ignored when the shell is
      // already live: its host is fixed at birth, and restarting the shell is
      // how it moves. The response reports the host the shell is actually on,
      // which is what the drawer's badge shows. `host` is validated like
      // runBlock's (resolveHost).
      // Attaching also takes, since a server can be serving several clients
      // (remote.md §7). The client that attached owns the drawer, so the bytes,
      // the keystrokes and the winsize all follow it, and a second client
      // attaching takes all three. Taking never fails and never asks: the
      // scrollback comes back with it, so the taker sees the whole session it
      // just adopted, and the client it was taken from is pushed
      // terminalDetached. A detach clears only the caller's own ownership. The
      // client comes from the connection's handshake, so neither call has a
      // parameter for it.
      terminalAttach: { params: { sessionId: string; host?: string | null }; response: { dataB64: string; host: string } };
      terminalDetach: { params: { sessionId: string }; response: { ok: boolean } };
      // Whether the note's terminal shell is alive, and which host it is on.
      // The view asks before opening the drawer (or sending a block to it) on a
      // multi-host note. A live shell means no host picker, since the paste can
      // only go where that shell already is. A dead one means the spawn is
      // about to happen, so the user picks the host first.
      terminalStatus: { params: { sessionId: string }; response: { live: boolean; host: string | null } };
      // What became of an open drawer's shell while the wire was down, sent by
      // the drawer itself after every reconnect (mainview/boot.tsx). This is
      // the terminal half of inlineClaim above, and it exists for the same
      // reason: a push with nowhere to go is dropped rather than queued
      // (bun/daemon.ts), so everything the server said about this shell while
      // the client was unreachable is gone. The three answers are those three
      // lost pushes, delivered late (see TerminalClaim).
      // This is not terminalAttach, which is what a drawer opening sends.
      // Attaching takes the shell and spawns one if there is none, and both are
      // wrong here. A wire coming back is not a person opening a drawer, so it
      // must not pull the shell off a device somebody chose to take it on, and
      // it must not answer a shell that died with a new one whose scrollback is
      // empty: the history on screen is the only copy left of the old shell's.
      // So this call takes nothing it does not already hold and spawns nothing.
      // The client comes from the connection's handshake, as in terminalAttach.
      // "Still mine" is a question only the asker can ask about itself.
      terminalClaim: { params: { sessionId: string }; response: TerminalClaim };
      // Tear down both of a note's shells. Sent when its tab (or pane, or
      // workspace) closes and its docId drops out of the live set.
      closeSession: { params: { sessionId: string }; response: { ok: boolean } };
      // `params` is the note's spawn parameters, as the view parsed them from
      // its frontmatter (shared/frontmatter.ts). Sent when a note's saved text
      // first lands in its editor, and again whenever an edit changes what the
      // frontmatter parses to. Bun keeps the latest per session and applies it
      // when that session's shells spawn. An already-running shell keeps the
      // params it was born with (restart-applies, like settings). They are not
      // opaque handles (architecture.md §2): they flow only into the spawn of
      // the user's own shell, which grants the view nothing runBlock (arbitrary
      // code in that same shell) does not already grant.
      // `notePath` is a fact rather than a setting: the file this session's
      // note lives at, null before its first save, re-sent when the file moves.
      // Bun re-validates it against the registry and stamps it into local
      // spawns as LEDGE_NOTE, with the containing root as LEDGE_WORKSPACE, both
      // pinned after every user env layer. An agent in the note's own shells
      // can then answer "the note I am sitting in" (the MCP server's read_note
      // defaults to it), and no frontmatter can forge it.
      sessionConfigure: { params: { sessionId: string; params: NoteParams; notePath: string | null }; response: { ok: boolean } };
      // Kill all of a note's shells so the next run or terminal attach spawns
      // fresh ones. This is the escape hatch for restart-applies params: edit
      // the frontmatter, restart, and the new cwd and env are live. Unlike
      // closeSession the tab stays open, so Bun closes out every open run
      // (runEvent ended) and tells an attached drawer the shell is gone
      // (terminalExit). The session's params survive, and the fresh shells
      // spawn with them. Sent by the "Restart Note Shell" command.
      sessionRestart: { params: { sessionId: string }; response: { ok: boolean } };
      // Read one profile's env file, creating it first (seeded, 0600) if it
      // does not exist. Ledge's own profile editor is the UI, because macOS
      // binds no application to ".env" (LSApplicationNotFound), so there was
      // never an OS-editor path. This pair is that editor's load and save, and
      // settingsRead/Write below are the same shape for the same reason, one
      // config file later. `name` is re-validated Bun-side (assertProfileName)
      // in both calls before it becomes a filename: the view is the
      // least-trusted end. Fired by the "Edit Note Profile" command with the
      // profile the note's frontmatter names.
      profileRead: { params: { name: string }; response: { text: string } };
      // Write the profile's full new text. The profile editor serializes the
      // file, and the comments in it survive (shared/dotenv.ts). Atomic like a
      // note save, kept 0600.
      profileWrite: { params: { name: string; text: string }; response: { ok: boolean } };
      // System clipboard, routed through the Bun process (pbcopy/pbpaste). The
      // webview runs under the views:// scheme, which is not a secure context,
      // so navigator.clipboard is unavailable, and execCommand and native
      // Cmd+V paste are unreliable without a native Edit menu. Going through
      // Bun avoids all of that and copies and pastes the way a terminal does.
      clipboardWrite: { params: { text: string }; response: { ok: boolean } };
      clipboardRead: { params: {}; response: { text: string } };
      // Both pasteboard flavors at once, for the editor's ⌘V. `html` is the
      // pasteboard's `public.html`, "" when it carries none, which the editor
      // translates to Markdown so formatted text keeps its structure
      // (editor/htmlPaste.ts). It gets its own call because reading that flavor
      // costs an osascript spawn (bun/clipboard.ts). The terminal and the
      // settings dialog want only text and stay on clipboardRead, a pbpaste.
      clipboardReadRich: { params: {}; response: { text: string; html: string } };
      // Install the native menu bar. The view builds `items` from the command
      // registry and re-pushes whenever the state a `when` predicate reads
      // changes, so enablement stays correct without Bun learning what a
      // command means. Bun sets a minimal fallback menu at boot (Quit and the
      // edit roles), which the view's first push replaces wholesale.
      menuSet: { params: { items: AppMenuItem[] }; response: { ok: boolean } };
      // Open another window, which is another client: its own connection, its
      // own client id, its own row in presence (remote.md §8a). It opens on the
      // local server, the way a fresh launch does, and switching it somewhere
      // else is the ordinary connectionSelect.
      // `ok` is false where the shell has no second window to give: a phone has
      // exactly one (ios.md §4). Whether the verb is offered at all is decided
      // without calling this (mainview/lib/shell.ts), because a `when`
      // predicate cannot await and a probe would have to open a window to learn
      // the answer. `ok: false` is the reply to anything that calls anyway.
      windowNew: { params: {}; response: { ok: boolean } };
      // Open the manual in the window that holds it (remote.md §8a). There is
      // one such window per app: an app already showing the manual raises that
      // window instead of opening a second copy of a read-only corpus. That is
      // why this is a verb about the manual rather than windowNew with an
      // argument.
      // `page` names a page by title, for the menu items that mean one page
      // rather than the whole manual (Help > Third-Party Licenses); "" is the
      // landing page. It is honored whether the window is opened or only
      // raised, so "show me the licenses" shows them.
      // `ok` is false where the shell has no second window to give (a phone,
      // ios.md §4), and the caller then opens the manual in the window it
      // already has. Which of the two happens is decided without calling this
      // (mainview/lib/shell.ts multiWindow), for windowNew's reason: a `when`
      // predicate cannot await.
      windowDocs: { params: { page: string }; response: { ok: boolean } };
      // What this window is, asked once at boot, before the first render.
      // Every window runs the same view, and all of them but one boot onto the
      // saved layout. The manual's window boots onto the manual: `docs` is
      // true, and `page` is the title it was opened to show, "" for the landing
      // page. This asks the shell rather than the server, since which window a
      // view is in is not a fact about the notes, so it never becomes a frame.
      // A shell with one window answers false.
      windowRole: { params: {}; response: { docs: boolean; page: string } };
      // The validated settings snapshot (shared/settings.ts), fetched once at
      // boot. Bun owns the files, the parsing, and the fallbacks. The view sees
      // one complete, valid Settings and never learns there were two of them:
      // the client shell merges its own half in on the way past
      // (bun/clientSeams.ts, remote.md §5). Settings apply at launch, and there
      // is no settingsChanged message (architecture.md, "Settings").
      settingsGet: { params: {}; response: { settings: Settings } };
      // The settings editor's load and save (the ⌘, dialog), mirroring
      // profileRead/profileWrite. The view cannot name the file, since Bun
      // knows where each settings.jsonc lives, and the text that rides is raw
      // JSONC, comments and all. Read seeds the commented template on a fresh
      // install, so the first ⌘, opens documented knobs. Write is atomic like a
      // note save. It is not gated on parsing, so a mid-edit save is never
      // refused. Launch-time validation already degrades per field, and the
      // dialog shows problems live. Saved changes still apply at the next
      // launch, like every setting.
      // `home` picks which of the two files (SETTINGS_HOMES). "server" is the
      // machine holding the notes. "client" is this app on this screen, and the
      // client shell answers that one itself rather than forwarding it. The
      // dialog shows one tab per home, and both always exist, since a client is
      // a thing with a screen.
      settingsRead: { params: { home: SettingsHome }; response: { text: string } };
      settingsWrite: { params: { home: SettingsHome; text: string }; response: { ok: boolean } };
      // Write the `ledge` CLI shim onto the PATH (the Install Shell Command
      // palette entry). Bun composes the whole `message`, because it alone
      // knows the shim's landing dir, the PATH answer, and the failure. The
      // view only surfaces the text: a notice strip when `ok`, an error strip
      // otherwise. This never throws across the RPC, and failure is data.
      cliInstall: { params: {}; response: { ok: boolean; message: string } };
      // Put a view-side failure in the session log (bun/log.ts). The webview
      // has no console anyone can read in a shipped build, since WKWebView's
      // goes to the inspector, which a user does not have. An uncaught render
      // error would otherwise leave nothing behind but a blank pane. Only
      // failures ride this: `window.onerror`, unhandled rejections, and
      // console.error, never ordinary logging. The view also caps how many it
      // will send in a session (lib/log.ts), so an erroring render loop cannot
      // turn the log into a disk-filler.
      // Bun stamps the `[view/…]` prefix itself and truncates `text`. That is
      // the whole guard: this is a fixed-name append of arbitrary view bytes.
      // Two things keep it from being byte storage in the app home. Bun bounds
      // it, and it lands in a file the app treats as disposable.
      logAppend: { params: { level: "warn" | "error"; text: string }; response: { ok: boolean } };
      // Open the log folder in Finder (the Help menu's "Reveal Log"). It takes
      // no path: Bun alone knows where the log lives, so the view cannot aim
      // `open` at a path of its own choosing.
      logReveal: { params: {}; response: { ok: boolean } };
      // Read one local image a note references (`![](.ledge-assets/x.png)`) for
      // the editor's rendered preview. The webview cannot touch the filesystem,
      // so the bytes ride the RPC base64-encoded. `image` is null when the file
      // is missing.
      // `src` is the markdown-relative reference exactly as the note carries
      // it, `root` is the workspace the referencing note lives in, and
      // `notePath` is the note itself. The reference resolves against the
      // note's own folder, so a note one level down says
      // `../.ledge-assets/x.png` for the same file the root says
      // `.ledge-assets/x.png` for. Without `notePath` the root is the base,
      // which is right only for a note sitting in it.
      // Bun guards all three hard (bun/assets.ts assetPathOf: a registered
      // root, a `.md` base inside it, the resolved path inside it, an
      // image-extension allowlist, no dot-entries), because the view is the
      // least-trusted end. Without the extension check this call would read any
      // note.
      // `sealed: true` means the file exists but is a sealed image
      // (locking.md §5) and the vault is locked, so the widget shows the
      // locked-image placeholder rather than a broken one. Sealed assets
      // decrypt Bun-side when the vault is open and ride back as ordinary
      // bytes.
      assetRead: {
        params: { root: string; src: string; notePath?: string | null };
        response: { image: { dataB64: string; mime: string } | null; sealed?: boolean };
      };
      // Save the pasteboard's image into the workspace root's .ledge-assets/ as
      // a PNG and return the markdown-relative reference to embed
      // (`.ledge-assets/pasted-….png`), or null when the pasteboard holds no
      // image. Sent by the editor's ⌘V when the pasteboard has no text.
      // `root` is the pasting note's workspace. `notePath` is the pasting
      // note's file, when it has one: the server reads that note on disk, never
      // a view flag, to decide whether the paste is sealed at birth because the
      // note is locked (locking.md §5).
      // Answered by the client (remote.md §10): the pasteboard belongs to the
      // device the user is holding, and a VPS has none. The client reads the
      // image and hands the bytes to assetWrite below, which names the file.
      // The view never names one.
      assetPaste: { params: { root: string; notePath?: string | null }; response: { src: string | null } };
      // The same trip, but it asks the device for a picture instead of reading
      // its pasteboard: the macOS file dialog, and on iOS the photo library
      // (ios.md §11). Sent by Insert Image…, the only way in on a phone. There
      // is no ⌘V there, and the picture the user wants is the one they took,
      // not one they somehow copied.
      // A client method for assetPaste's reason, and answering in its shape:
      // the picker belongs to the machine with a person at it, the bytes ride
      // assetWrite, and the name still comes back from the machine that holds
      // the notes. null is a cancelled picker, the common outcome, and must not
      // reach the server or the error strip.
      assetPick: { params: { root: string; notePath?: string | null }; response: { src: string | null } };
      // Image bytes in, markdown reference out. The client's half of a paste
      // calls this; nothing in the view does. `dataB64` is the base64 the
      // schema says it is everywhere else, but it rides a binary frame over a
      // connection (shared/wire.ts), so a screenshot costs its own size and not
      // a third more.
      // Everything that decides the file stays here: uniqueName against a
      // readdir snapshot, the .ledge-assets guard, the read-only-root refusal,
      // and the seal, which is read off the note on disk. The client supplies
      // only bytes and the handles it was given, the authority remote.md §2
      // allows it.
      assetWrite: {
        params: { root: string; notePath?: string | null; dataB64: string };
        response: { src: string | null };
      };
      // Which server this client talks to (remote.md §8). All six connection
      // methods are answered by the client shell and never forwarded: a
      // connection is client-side configuration, and a server has no opinion
      // about who connects to it.
      // `active` is the connection being served right now. `wanted` is the one
      // the user last chose. They differ only when a connection could not be
      // opened at boot: `error` then says why, and the local server is serving
      // instead rather than the app failing to open.
      connectionList: {
        params: {};
        response: {
          connections: ConnectionInfo[];
          active: string;
          wanted: string;
          error: string;
          build: string;
        };
      };
      // Switch connections. Tears the session down and rebuilds it, so the
      // caller reloads itself on ok (remote.md §8): everything workspace-scoped
      // is scoped to a server, and the view's boot is the rebuild. A connection
      // that will not open leaves the current one untouched and answers with
      // the reason. Losing a working session to a typo would be the worse
      // failure.
      connectionSelect: { params: { id: string }; response: { ok: boolean; error: string } };
      // Dial now instead of waiting for the shell's own retry beat
      // (shared/transport.ts `recheck`). A connection that has stopped
      // answering is retried on a beat measured in tens of seconds. This call
      // is for the callers that know something the beat cannot: a machine that
      // just woke, an operating system saying the network is back, a person who
      // pressed the button because they can see it is.
      // The response reports nothing. This is a request to this client's own
      // shell to stop waiting, not a request to the server, since there may be
      // no server to ask. What came of it arrives on `connectionState`.
      connectionReconnect: { params: {}; response: { ok: boolean } };
      // Add a connection. `hostKey` is the known_hosts line whose fingerprint
      // the user was shown and accepted (connectionProbe below). The client
      // pins only what a person confirmed, never what a host happened to
      // answer.
      // `password` is the one credential that travels on this schema, and it
      // travels exactly once and in one direction: from the form to the
      // keychain (bun/secrets.ts). It is safe to carry here because these six
      // are CLIENT_METHODS (wire.ts): the client shell answers them and a
      // server refuses them, so a password cannot reach the machine it is for
      // by this route, let alone any other. Ignored unless `auth` is
      // "password".
      connectionAdd: {
        params: {
          name: string;
          destination: string;
          port: number;
          keyPath: string;
          auth: AuthMode;
          password: string;
          hostKey: string;
        };
        response: { id: string; error: string };
      };
      // Change a connection: its name, its address, or the key it offers.
      // `hostKey` is null to keep whatever is pinned, a line to pin instead, or
      // "" to pin nothing and let the user's own ssh decide. Three states,
      // because "" already means the third. Whichever it resolves to is refused
      // when it names a host the new address does not: a pin is a claim about
      // one machine, and reading the new one's fingerprint is the step that
      // moving a connection is supposed to cost (remote.md §4).
      // Editing the connection being served re-opens it, so this can answer
      // with the same "could not reach" a switch does. The wire in front of the
      // user was built from the old address, and a row that names one machine
      // over a session talking to another is the lie the indicator exists to
      // prevent. The caller reloads on ok for that case, as it does for
      // connectionSelect.
      // `password` is null to keep whatever is stored and a string to replace
      // it, the same shape `hostKey` has and for the same reason: an edit form
      // that asked for the password again to change a name would teach the user
      // to type their password into a dialog for no reason. Switching `auth` to
      // "key" forgets the stored one. Switching to "password" with null and
      // nothing stored is refused, because a connection that cannot answer its
      // own prompt fails at the next dial with ssh's words rather than ours.
      connectionUpdate: {
        params: {
          id: string;
          name: string;
          destination: string;
          port: number;
          keyPath: string;
          auth: AuthMode;
          password: string | null;
          hostKey: string | null;
        };
        response: { ok: boolean; error: string };
      };
      // Remove a connection, and its pin with it. The local server and the
      // connection currently being served both refuse.
      connectionRemove: { params: { id: string }; response: { ok: boolean; error: string } };
      // Pairing: ask a host for its key and describe it, so the fingerprint
      // can be compared against what the server said before anything is
      // pinned. Failure is data, since an unreachable host is the most
      // ordinary outcome of typing an address. The port travels because the
      // line that comes back is the line that gets pinned: known_hosts indexes
      // a non-default port as `[host]:port`, and a pin taken on the wrong
      // shape matches nothing at connect time.
      connectionProbe: {
        params: { destination: string; port: number };
        response: { hostKey: string; fingerprint: string; keyType: string; error: string };
      };
      // The persisted session layout (.layout.json in the app home): which
      // workspaces exist, which folder each owns, their pane trees, and which
      // notes are open where. One global file, since the workspace list itself
      // is what it records. Machine-written state, not settings
      // (architecture.md §6): Bun owns the file's bytes and atomicity, the view
      // owns the shape. The view serializes on layout changes and parses and
      // self-heals at boot (workspace/persist.ts), so the payload rides as raw
      // text. null when no layout has ever been saved. Which client's layout
      // this is comes from the connection's handshake, never from the call
      // (remote.md §5).
      layoutGet: { params: {}; response: { text: string | null } };
      // Persist the serialized layout. Bun writes it to the fixed dotted file,
      // atomically like a note save. The view names nothing. Text that is not
      // JSON is refused: a write this free must not become arbitrary byte
      // storage in the app home. Sent debounced on every layout change and
      // flushed on blur and pagehide, like note autosave.
      layoutSave: { params: { text: string }; response: { ok: boolean } };
      // Take (consume) any pending CLI open request, the boot-time half of
      // `ledge <title>` (bun/openRequest.ts). The view calls this once, after
      // its subscriber wiring is up: a push at boot could fire before anyone
      // listens, so the cold-start path is a pull. `open` carries a full
      // NoteMeta plus its root, so the view selects the workspace and opens the
      // tab without a lookup. null means nothing valid was pending.
      openRequestTake: { params: {}; response: { open: ExternalOpenInfo | null } };
      // --- the vault (note locking, locking.md) ---------------------
      // The vault's current state, fetched at boot and after any transition the
      // view did not drive itself. "none" means no vault exists yet: the first
      // Lock This Note runs creation instead of unlock.
      vaultState: { params: {}; response: { state: VaultState } };
      // Create the vault from a chosen passphrase, on the first lock ever
      // (scrypt → master key; .vault.json holds the salt and a key-check, never
      // a key). Leaves the vault unlocked. Refused when a vault already exists.
      vaultCreate: { params: { passphrase: string }; response: { ok: boolean } };
      // Unlock with the passphrase. ok:false is a wrong passphrase, never an
      // exception, and the dialog shakes and stays. The passphrase crosses the
      // RPC exactly once per unlock, feeds the KDF, and is dropped. With no
      // vault file but locked notes on disk (synced from another machine), Bun
      // probes a locked note's own self-contained header and rebuilds the file
      // on success.
      vaultUnlock: { params: { passphrase: string }; response: { ok: boolean } };
      // Relock now (⌘L, and quit). The view flushes dirty locked buffers before
      // calling, since Bun cannot save what it cannot see. It then evicts its
      // decrypted state on the vaultChanged push this triggers.
      vaultLock: { params: {}; response: { ok: boolean } };
      // Lock or unlock one note (the palette's two-faces pair). Both require
      // the vault unlocked. noteLock refuses template-marked notes: the marker
      // exclusivity is checked Bun-side in notes.ts, where the MCP template
      // path cannot bypass it either. Body and header transition on disk, and
      // the response meta carries the new locked flag for the lists.
      // `sealedShared` names swept images that other unlocked notes also show
      // (locking.md §5). The view surfaces it as a notice, and sealing proceeds
      // either way, since a refusal would deadlock locking two notes that share
      // an image.
      noteLock: { params: { path: string }; response: { note: NoteMeta; sealedShared: string[] } };
      noteRemoveLock: { params: { path: string }; response: { note: NoteMeta } };
      // Change the passphrase: a new salt and master key, with every locked
      // note's header and every sealed image's key wrap rewritten across all
      // available roots. Headers and wraps only, bodies never (locking.md §3).
      // Requires the vault unlocked. `rewrapped` is the count for the notice.
      vaultChangePassphrase: { params: { passphrase: string }; response: { ok: boolean; rewrapped: number } };
      // Open a note link in the OS default handler (browser, mail client).
      // Sent by the editor's ⌘-click and the "Open Link" command. The URL is
      // re-validated Bun-side against the same scheme allowlist the view used
      // (shared/links.ts): the view's check is styling, this one is the guard.
      // `open` treats a non-URL argument as a file path and launches .app
      // bundles, so an unvalidated string here would be command execution
      // (architecture.md §2). ok:false means refused or unopenable.
      linkOpen: { params: { url: string }; response: { ok: boolean } };
    };
    messages: {};
  };
  webview: {
    requests: {};
    messages: {
      // One streamed update about one running block, sent to the client that
      // started it (see RunEvent). The one push held rather than dropped when
      // its client is not there: every other push here describes a state the
      // next connection re-reads, and a run's output is a sequence with nothing
      // to re-read it from. `inlineClaim` above releases what was held, in the
      // order the shell said it, before it answers.
      runEvent: RunEvent;
      // Raw pty output for one note's terminal drawer, base64-encoded.
      // `sessionId` lets the mounted drawer ignore output from a note other
      // than the one it currently shows (e.g. brief overlap during a tab
      // switch).
      terminalOutput: { sessionId: string; dataB64: string };
      // Whether a note's terminal shell is mid-job. false only when it sits at
      // an idle prompt with nothing queued behind it. Only Bun can know this:
      // it reads the shell's bracketed-paste mode (see BP_ENABLE in index.ts).
      // The view needs it because a block sent to a busy shell is queued rather
      // than run, and without this the queue is invisible and the run button
      // shows the wrong state.
      terminalBusy: { sessionId: string; busy: boolean };
      // A note's terminal shell exited on its own (the user typed `exit`). The
      // Bun side has already torn the shell down, and the view closes the
      // drawer if it is showing that note. Reopening the drawer spawns a fresh
      // shell.
      terminalExit: { sessionId: string };
      // Another client took this note's drawer (terminalAttach above). Pushed
      // to the client that had it, and only to that one: everyone else either
      // never had this shell or is the one that just took it.
      // The message exists so a drawer that stops printing says why. Without it
      // the shell goes quiet mid-line and keeps taking keystrokes that the
      // server then refuses, which reads as a hung app rather than as a shell
      // that is somewhere else. The view swaps the terminal for a notice and a
      // Take This Shell button, which sends one more terminalAttach
      // (interactions.md §4-2).
      // `by` is the id of the client that took it. The label is looked up
      // through `presence` below rather than carried in this payload: the id is
      // what the server has, the label is what a person reads, and the list
      // that maps one to the other is already on the client for the connection
      // bar. A taker the list does not know (an unnamed device) shows as
      // "Another device", the wording this message carried before there were
      // labels at all.
      terminalDetached: { sessionId: string; by: string };
      // Who else is connected to this server, pushed whenever that changes: a
      // client arriving, leaving, or reconnecting (remote.md §7). Pushed rather
      // than asked for, because the answer changes without anyone asking, and
      // the arrival that changes it is the same event that would have to
      // answer.
      // Addressed, and never carrying the client it is sent to: "who else is
      // here" is a different list for each of them, and the alternative is
      // every client having to know its own id in order to subtract itself.
      // The whole list each time, not a delta: it is two or three entries, and
      // a delta stream that misses one stays wrong until the next reconnect.
      // The local server never sends it. One client cannot have company, and
      // the view's list starts empty, so the bar says nothing about a machine
      // nobody else is on.
      presence: { others: PeerInfo[] };
      // Something changed one workspace root's files behind the app's back: an
      // agent in the terminal drawer, git, a shell mv or rm. Pushed by the
      // per-root fs.watch (bun/watch.ts), debounced Bun-side, filtered to .md
      // entries outside dot-directories. The view re-reads that folder's note
      // and trash lists and reloads any open, unedited note whose file moved
      // on. An edited one is left alone, and its next save's baseMtimeMs guard
      // arbitrates.
      // Ledge's own saves fire it too, unfiltered: the reload compares mtimes
      // and no-ops, and suppressing them here would mean the watcher and the
      // store had to agree on what "ours" means. The window's focus refresh
      // stays as the belt for a watcher that misses, since an unmounted
      // volume's root is not watched until the next boot.
      notesChanged: { root: string };
      // A CLI open request arrived while the app is running: the app-home
      // watcher saw the request file, and bun/openRequest.ts validated it. Same
      // payload as openRequestTake's answer. The view selects the workspace
      // showing `root` and opens the note's tab. Pushed to every connected
      // client, because the request names a note rather than a screen, and
      // choosing one device would be guessing which one the person is holding
      // (remote.md §7).
      openExternal: ExternalOpenInfo;
      // The vault's state changed on the Bun side: an unlock, a ⌘L, or the
      // 15-minute idle auto-relock. On "locked" the view swaps open locked
      // tabs to placeholders, drops their decrypted bodies, and evicts the
      // asset data-URL cache. On "unlocked" it re-reads open locked notes.
      vaultChanged: { state: VaultState };
      // A menu item carrying an `action` was clicked. Role items never arrive
      // here, since AppKit handles those. The payload is the command id the
      // view put there, and the view execs it with no target, the palette's
      // invocation.
      menuCommand: { action: string };
      // Whether the connection to the server is up (remote.md §7). Pushed by
      // the client shell, never by a server: a server saying "reconnecting"
      // would be describing a wire it is on the far side of. It is in
      // CLIENT_PUSHES and never becomes a frame.
      // "reconnecting" is a link that dropped and is being re-dialed, with
      // requests held rather than failed. "lost" is the point where re-dialing
      // stopped and what was held has been refused. `detail` is the sentence to
      // show. The local server never leaves "live", since there is no wire to
      // drop.
      connectionState: { state: "live" | "reconnecting" | "lost"; detail: string };
      // Land the manual on a page, pushed to the window that holds it when
      // somebody asks for a page while it is already open (windowDocs above).
      // "" is the landing page. Also a client push: the shell holding the
      // windows is the only thing that knows one of them is showing the manual,
      // and a server has no windows at all.
      docsShow: { page: string };
    };
  };
};
