// The typed contract between the Bun main process and the editor webview.
// This replaces the hand-rolled window.webkit.messageHandlers bridge from the
// Swift build: the webview requests a block run, Bun streams run events back.

import type { Settings, SettingsHome } from "./settings";
import type { NoteParams } from "./frontmatter";
import type { SearchHit } from "./search";
import type { TagInfo } from "./tags";

/** A streamed update about one running block, pushed Bun -> webview. */
export type RunEvent =
  | { id: string; kind: "began" }
  // Output bytes, base64-encoded because RPC payloads are JSON.
  | { id: string; kind: "output"; dataB64: string }
  // `exitCode: null` means the shell died with the block still running (the block
  // ran `exit`, or the shell was killed): there is no status to report, only the
  // fact that it is over. Without this the panel would sit on "Running" forever,
  // and with it the block's run button, which is disabled while its run is going.
  | { id: string; kind: "ended"; exitCode: number | null };

/**
 * One note on disk. `path` is the note's identity; `title` is what to call it on
 * screen (its first-line H1, or its filename if it has none).
 */
export interface NoteMeta {
  path: string;
  title: string;
  mtimeMs: number;
  // Present when the note's frontmatter marks it a template
  // (shared/frontmatter.ts): `true` for an ordinary one (it belongs in the
  // "New Note from Template…" picker), `"daily"` for the one ⌘J
  // instantiates each day — the role rides the marker's own value. On the
  // meta rather than behind its own query because listNotes already reads
  // each note's head for the title — the flag rides the same read, and the
  // view's per-folder lists (with their existing watcher-driven refresh)
  // become the live template registry for free. Optional so the many
  // fixtures and metas that are not templates say nothing at all.
  template?: true | "daily";
  // Present when the note is locked (its frontmatter carries the crypto
  // header, locking.md): the sidebar/⌘P lock glyph, the scans' skip,
  // and the agent listings' flag all read this. Rides the same head read
  // the title does — the plaintext head is designed to answer it.
  locked?: true;
}

/** The vault's current state (bun/vault.ts): "none" until the first lock
 * ever creates it, then locked/unlocked as the master key comes and goes. */
export type VaultState = "none" | "locked" | "unlocked";

/** A CLI open request after Bun resolved and guarded it (bun/openRequest.ts):
 * the note as a full NoteMeta — the store's openNote takes nothing less —
 * plus the workspace root holding it, so the view can select that workspace
 * without a lookup. Rides both directions of `ledge <title>`: the
 * openRequestTake pull (cold start) and the openExternal push (app already
 * running). */
export interface ExternalOpenInfo extends NoteMeta {
  root: string;
}

/**
 * The directory pasted images land in, under each workspace root. Part of the
 * cross-boundary contract, not just a Bun detail: assetPaste returns
 * references shaped `${ASSETS_DIRNAME}/x.png` into note text, and the view's
 * image classifier (editor/images.ts imageSrcOf) must accept exactly this one
 * dot-entry — two literals here would drift. App-prefixed and dotted like the
 * trash, so Ledge's writes never mingle with an attached project's own
 * `assets/` folder.
 */
export const ASSETS_DIRNAME = ".ledge-assets";

/**
 * One deleted note, sitting in its workspace root's .ledge-trash. `path` is where it
 * is now, which is the handle restore and undo are given. `deletedAt` is when
 * it was trashed (see listTrash in bun/notes.ts for where that number comes
 * from).
 */
export interface TrashMeta {
  path: string;
  title: string;
  deletedAt: number;
}

/**
 * One incoming wikilink, as the Backlinks panel shows it: the linking note's
 * meta (a full NoteMeta, so opening the hit is an ordinary openNote), the
 * 1-based line the link sits on, that line's trimmed text for the row
 * (`context`, capped Bun-side), and the `[[...]]` match exactly as written
 * (`raw`) — the reveal query, re-found on the line so a file that has moved
 * on still lands on the link (workspace/reveal.ts).
 */
export interface BacklinkHit extends NoteMeta {
  line: number;
  context: string;
  raw: string;
}

/**
 * One tag occurrence, as the Tags panel's drill-in lists it. Deliberately
 * BacklinkHit's shape: the bearing note's meta (opening the hit is an
 * ordinary openNote), the 1-based line the tag sits on (a body `#tag` line,
 * or the frontmatter `tags:` line), that line's trimmed text for the row, and
 * the tag exactly as written there (`raw`) — the reveal query, re-found on
 * the line like a backlink's.
 */
export interface TagHit extends NoteMeta {
  line: number;
  context: string;
  raw: string;
}

/**
 * One registered workspace root (bun/workspaces.ts). `root` is the folder's
 * absolute path — the opaque handle the view passes back on every scoped call.
 * `kind` says who created it: "managed" folders live directly in ~/.ledge and
 * Bun may recreate them; "external" folders were picked by the user in the
 * native dialog and Bun never mkdirs them; "docs" is the ONE built-in
 * documentation folder Bun syncs at launch — registered for the read paths,
 * refused by every write seam, and rendered by the view as the hidden
 * read-only Documentation workspace (never a strip row). `available: false`
 * means the folder is registered but missing on disk right now (an unmounted
 * volume): the view keeps its saved layout dormant rather than pruning it.
 */
export interface WorkspaceRootInfo {
  root: string;
  kind: "managed" | "external" | "docs";
  available: boolean;
}

/**
 * One configured server (remote.md §8), as the view sees it. The stored record
 * carries more (bun/connections.ts): the pinned known_hosts line is a hundred
 * characters of base64 that only ssh reads, so what travels is whether there
 * IS one. `destination` is "" for the server in this process, which is the one
 * connection that always exists and cannot be removed.
 */
export interface ConnectionInfo {
  id: string;
  name: string;
  destination: string;
  keyPath: string;
  pinned: boolean;
  /** ms epoch, 0 for never reached. */
  lastReached: number;
}

/**
 * One item of the native menu bar. The view owns the shape — it derives the
 * whole menu from the command registry (commands/menu.ts) — and Bun owns the
 * native call, exactly as it owns the bytes of a layout the view shapes.
 *
 * `action` is a command id, opaque to Bun: it comes back verbatim in the
 * `menuCommand` message and the view execs it through the same dispatcher the
 * palette uses. `role` is a native AppKit selector (undo, copy, quit) handled
 * by the responder chain instead, which never reaches the view at all.
 */
export type AppMenuItem =
  | { type: "divider" }
  | {
      label: string;
      action?: string;
      role?: string;
      // Electron-style ("command+shift+p"). Claiming one takes the chord from
      // the WebView: AppKit's key-equivalent pass runs first (interactions.md
      // §10), which is why most items carry none.
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
      // the daily.workspace setting resolved to one of these roots (null when
      // unset or stale) — where ⌘J will act, which the Edit Daily Template
      // faces must point at. Boot-time like the setting itself (restart-applies).
      // `folderDialog` rides along for the same reason: it is a fact about the
      // machine this registry lives on — whether anybody is sitting at it to
      // answer a native folder picker — and it is false on every headless
      // server, which is what lets the view leave Attach Folder and Move
      // Workspace Folder OUT of the palette rather than offering two verbs that
      // can only answer with an error strip (ios.md §8, mainview/lib/shell.ts).
      workspaceList: {
        params: {};
        response: { workspaces: WorkspaceRootInfo[]; dailyRoot: string | null; folderDialog: boolean };
      };
      // Create a managed workspace folder from a display name. Bun slugs the
      // name into a folder itself (the view never names a path — the same
      // trust move as noteCreate) and registers it. Sent by "New Workspace".
      workspaceCreate: { params: { name: string }; response: { root: string } };
      // Open the NATIVE folder picker and register the chosen directory as a
      // workspace root. The path never rides the RPC: the dialog runs Bun-side,
      // which is what keeps arbitrary external roots compatible with the trust
      // boundary. root null + error null means the user cancelled; an error
      // string means the choice was refused (not a directory, nested with
      // another root). Picking an already-registered folder returns it, and
      // the view focuses the existing workspace instead of adding a twin.
      workspaceAttach: { params: {}; response: { root: string | null; kind: "managed" | "external" | null; error: string | null } };
      // Remove a root from the registry. NEVER deletes files: the folder and
      // every note in it stay on disk, re-attachable later. Sent when a
      // workspace is closed (unless it is the last one, which the view refuses).
      workspaceDetach: { params: { root: string }; response: { ok: boolean } };
      // Relocate a registered root's folder on disk (Move Workspace Folder…):
      // the NATIVE folder picker chooses the destination parent Bun-side — the
      // destination never rides the RPC, workspaceAttach's trust move — and Bun
      // renames the folder into it (same volume only; everything inside
      // travels). root null + error null means cancelled; a returned root is
      // the workspace's new handle, with `kind` recomputed since moving into or
      // out of the app home flips managed/external. Returning the OLD root
      // unchanged means the chosen destination was already its parent.
      // `home: true` (Move Workspace Folder Home) skips the picker and targets
      // Bun's own APP_HOME — the return path for an external workspace, which
      // needs no dialog precisely because ~/.ledge is hidden and navigating a
      // picker there is not a reasonable ask. Still no view-named path.
      workspaceMove: { params: { root: string; home?: boolean }; response: { root: string | null; kind: "managed" | "external" | null; error: string | null } };
      // The note store (notes.ts). Bun owns every path: the view holds paths only
      // as opaque handles it got from here, and Bun rejects any that fall outside
      // the REGISTERED WORKSPACE ROOTS (workspaces.ts): scoped calls name their
      // root explicitly (checked for exact registry membership), per-note calls
      // send just the path (its root is derived — a path determines its root).
      // Notes are plain .md files; `path` identifies the file, while `sessionId`
      // (the docId) identifies the live editor and its shells.
      noteList: { params: { root: string }; response: { notes: NoteMeta[] } };
      // null when the note is gone (deleted behind the app's back). `mtimeMs`
      // rides along because it is the note's disk VERSION: the view holds it
      // per open note and hands it back on every noteWrite, which is how a
      // save can tell "my own last state" from "someone else wrote here".
      // A LOCKED note carries `locked: true`; `held: true` means the body was
      // withheld (vault locked — `text` is only the plaintext head, and the
      // view shows the locked placeholder, not an editor), and `damaged`
      // rides on held when the ciphertext fails authentication (modified
      // outside Ledge) — the placeholder says restore-from-backup instead of
      // prompting for a passphrase that cannot help.
      noteRead: {
        params: { path: string };
        response: { note: { text: string; mtimeMs: number; locked?: true; held?: true; damaged?: true } | null };
      };
      // Atomic overwrite (temp file plus rename), so a crash mid-save can never
      // truncate a note. Sent on a debounce as you type and on Cmd+S.
      // `baseMtimeMs` is the disk version the view last saw (from noteRead,
      // this call's own response, or NoteMeta); null means no expectation
      // (a note edited before its first read landed) and writes blind, as
      // every write did before the guard existed. On a mismatch with genuinely
      // different bytes — an agent or terminal edit landing while the note was
      // being edited here — the buffer still wins the live path (the user is
      // the one typing), but the disk version is first moved into the root's
      // .ledge-trash, never overwritten in place: `divergedTo` says where, and
      // the Trash section is where the losing version stays recoverable.
      // A mismatch whose bytes are identical just adopts the disk mtime.
      noteWrite: {
        params: { path: string; text: string; baseMtimeMs: number | null };
        response: { mtimeMs: number; divergedTo: string | null };
      };
      // Allocate a file in the given workspace root for a note that has none
      // and write its first content, returning the note the view then saves to
      // (and titles its tab from). Sent on a note's first edit, so a tab opened
      // and never typed in creates nothing. The root is the tab's workspace at
      // the moment of creation (tabs never move across workspaces).
      noteCreate: { params: { root: string; text: string }; response: { note: NoteMeta } };
      // Move a note's file to match its first-line H1, returning where it now
      // lives (possibly unmoved). The view sends the note's TEXT, not a name: Bun
      // slugs the heading itself, so the name is safe by construction and there is
      // nothing for a buggy view to smuggle through. Sent only when a note's slug
      // actually changes, never on an ordinary edit. The docId is untouched, so
      // the note's editor and shell live through it.
      noteRetitle: { params: { path: string; text: string }; response: { note: NoteMeta } };
      // Create-or-open today's daily note (bun/daily.ts openDaily). Bun
      // computes the LOCAL YYYY-MM-DD title, resolves it by title in the
      // daily workspace — the daily.workspace setting when it names a
      // registered root, else `root`, the view's selected workspace — and
      // creates the note when missing, from the note marked
      // `template: daily` when one exists (none degrades to a bare
      // "# <date>"). The response is ExternalOpenInfo on purpose: the view
      // feeds it to the same subscriber a CLI open rides
      // (notes/channel.ts dispatchExternalOpen), so select-workspace-then-
      // open has ONE definition. Sent by the ⌘J command.
      dailyOpen: { params: { root: string }; response: { open: ExternalOpenInfo; created: boolean } };
      // Instantiate a template note into a new note in `root`: marker strip,
      // {{token}} substitution, H1 forcing (shared/template.ts), then the
      // same store path as noteCreate, so H1-slug naming and uniqueName
      // still hold and nothing can clobber. `templatePath` is a PATH, unlike
      // the title-addressed MCP/CLI surfaces: the ⌥⌘N picker's rows come
      // from the live note lists, so the view picked a concrete note —
      // re-resolving its title here could land on a different note with the
      // same name in another workspace. The path passes the same guards
      // every view-sent path does (readNote's assertNote). `title` null
      // means "Untitled": the H1 is the rename UI.
      noteFromTemplate: { params: { root: string; templatePath: string; title: string | null }; response: { note: NoteMeta } };
      // Delete a note by moving it into ITS OWN root's .ledge-trash. Not an unlink: a
      // misclick should cost a trip to the Trash section, not the note. It is an
      // app-private folder, not the system trash (see trashDirOf in notes.ts),
      // and per root so the move never crosses a filesystem. Responds with where
      // the note landed, which is the handle Undo restores from, or null if
      // there was nothing there to delete.
      noteDelete: { params: { path: string }; response: { trashed: string | null } };
      // Full-text search over ONE workspace's note bodies: the query as one
      // case-insensitive substring (shared/search.ts owns the grammar and the
      // caps). Sent, debounced, as the search overlay's query changes, scoped
      // to the selected workspace like the browser and quick-open. Bun owns
      // the scan because the files are its to read — shipping every body
      // across the RPC to search view-side would scale the payload with the
      // notes folder instead of the result list. Hits arrive newest note
      // first, each carrying the note plus the matched line, so the view can
      // list, open, and reveal without a second request.
      // `lockedSkipped` counts the workspace's locked notes, whose bodies the
      // scan deliberately never reads (vault state irrelevant —
      // locking.md §4); the overlay renders it as a muted footer so the
      // skip is visible where the answer would have been. The same count
      // rides every body scan below.
      noteSearch: { params: { root: string; query: string }; response: { hits: SearchHit[]; lockedSkipped: number } };
      // The notes whose [[wikilinks]] point at this note, for the Backlinks
      // panel. Sent when the panel is open and the shown note (or its folder's
      // files, via the notesChanged push) changes. Bun owns the scan for
      // noteSearch's reason — the view never holds note bodies — and it is the
      // SAME scan the MCP backlinks tool runs (bun/notes.ts backlinksTo):
      // links resolve by title within the note's own workspace, exactly as the
      // linking notes' editors resolve them. Only the path crosses the RPC;
      // its root is derived Bun-side like every per-note call.
      noteBacklinks: { params: { path: string }; response: { backlinks: BacklinkHit[]; lockedSkipped: number } };
      // One workspace's tag directory: every tag its notes carry (frontmatter
      // `tags:` and inline #hashtags, shared/tags.ts owns the grammar), with
      // per-NOTE counts, alphabetical. Sent when the Tags panel's directory is
      // showing and on the notesChanged push; also feeds the overlay's tag
      // rows and the editor's # completion vocabulary. Bun owns the scan for
      // noteSearch's reason — the view never holds note bodies — and it is
      // scoped to one root because tags are, like wikilinks: a tag names notes
      // within a workspace, not across them. Scan-on-demand, no index: the
      // backlinksTo cost class, accepted for the same reasons.
      // Locked notes still contribute their frontmatter `tags:` (the
      // plaintext head is where the user put them); lockedSkipped says their
      // BODY hashtags went unread.
      tagList: { params: { root: string }; response: { tags: TagInfo[]; lockedSkipped: number } };
      // The occurrences of one tag across a workspace, newest note first —
      // the Tags panel's drill-in. Same scan as tagList over the same scope,
      // filtered to one case-folded identity; each hit carries the note plus
      // the occurrence line, so the view can list, open, and reveal without a
      // second request (noteSearch's shape).
      tagNotes: { params: { root: string; tag: string }; response: { hits: TagHit[]; lockedSkipped: number } };
      // One workspace's deleted notes still recoverable, newest first. Read at
      // boot and at every folder refresh, alongside noteList: the count is on
      // screen whether or not the section is expanded, so the trash cannot
      // quietly fill up.
      trashList: { params: { root: string }; response: { items: TrashMeta[] } };
      // Move a trashed note back to the root it was deleted from, returning
      // where it landed (its old name may be taken by now). Backs both Undo and
      // the Restore button, which are the same operation: Undo is just the
      // shortcut to the one that stays available in the Trash section.
      trashRestore: { params: { path: string }; response: { note: NoteMeta } };
      // Unlink ONE trashed note, for good. Like trashEmpty this destroys a note
      // outright, so the view confirms first; unlike it, the note named is the
      // only one that can go. Responds false if it was already gone.
      trashDelete: { params: { path: string }; response: { removed: boolean } };
      // Unlink every trashed note in one workspace. Destroys notes outright,
      // hence the confirmation in front of it.
      trashEmpty: { params: { root: string }; response: { removed: number } };
      // Shells are per note: `sessionId` is the tab's stable docId. The Bun side
      // lazily spawns that note's persistent inline-run shell on first runBlock and
      // closes it on closeSession, so a `cd` in one note never leaks into another.
      // A block run while that shell is mid-block gets an ephemeral overflow shell
      // of its own (concurrent inline runs; see bun/inlinePool.ts), torn down when
      // the run ends.
      // `language` is the fence's info string ("python", "node", ...): Bun picks
      // the runner from it — source into the shell, or exec an interpreter on the
      // temp file (bun/runner.ts). The view never decides how code runs.
      // `host` is the machine the user picked for THIS run (the note's host
      // picker), or absent to let the note's frontmatter decide (its single
      // declared host, else local). Bun re-validates it against the note's
      // declared list (resolveHost in bun/index.ts): the frontmatter is the
      // allowlist, and the view's picker is only its UI.
      runBlock: {
        params: { sessionId: string; id: string; code: string; language: string | null; host?: string | null };
        response: { accepted: boolean };
      };
      // Interrupt one running block (SIGINT to its shell's foreground process
      // group). `id` names the run; Bun routes the signal to whichever shell is
      // executing it. Sent when a still-running block's output panel is dismissed:
      // with the panel gone there is nothing on screen to see or stop the program,
      // so it must not keep running invisibly. A persistent shell ignores SIGINT
      // itself and survives with its cwd/env.
      cancelRun: { params: { sessionId: string; id: string }; response: { ok: boolean } };
      // Match the winsize of the shell executing run `id` to the block's rendered
      // terminal grid, so size-aware programs (paging, full-screen redraws) lay out
      // correctly in the inline panel. May arrive before runBlock (the panel fits
      // itself as soon as it renders); Bun stashes it and applies it when the run
      // picks its shell.
      inlineResize: { params: { sessionId: string; id: string; cols: number; rows: number }; response: { ok: boolean } };
      // Keystrokes / pasted text from a block's inline terminal to the shell
      // executing run `id`, so an interactive program running inline (a REPL, vim,
      // claude) can be driven in place. Base64 like terminalInput. The view only
      // sends this while the block's command is the running foreground process.
      inlineInput: { params: { sessionId: string; id: string; dataB64: string }; response: { ok: boolean } };
      // Terminal drawer input and resize, targeting one note's terminal shell.
      // Keystrokes and pasted text go through terminalInput; the drawer's fit
      // computes cols/rows for terminalResize. This shell is separate from the
      // note's inline-run shell (the marker protocol stays isolated from raw xterm).
      terminalInput: { params: { sessionId: string; dataB64: string }; response: { ok: boolean } };
      // Run a (possibly multi-line) block in the terminal AS IF PASTED: the Bun
      // side wraps it in bracketed-paste markers and holds it until the shell has
      // enabled bracketed-paste mode, so zsh buffers every line into one command
      // (all echo together, then all output, under one prompt) instead of running
      // line-by-line, and the markers never leak as literal text on a cold shell.
      // `language` rides along when the paste is a fenced block sent to the
      // terminal: an interpreted language (see runBlock) pastes its runner line
      // (`python3 /tmp/...py`) instead of the raw code, which zsh could not run.
      // Shell blocks and the drawer's own Cmd+V (no language) paste text as-is.
      // `host` matters only if this call is what spawns the shell (a paste
      // into a note whose drawer was never opened); an already-live drawer
      // shell keeps the host it was born on, and the runner line for an
      // interpreted block is built for THAT host, so a remote drawer never
      // gets a local temp path it cannot read.
      terminalPaste: { params: { sessionId: string; text: string; language?: string | null; host?: string | null }; response: { ok: boolean } };
      terminalResize: { params: { sessionId: string; cols: number; rows: number }; response: { ok: boolean } };
      // Attach lazily spawns the note's terminal shell (if needed), returns the
      // scrollback so far (so a freshly opened drawer shows the existing prompt and
      // history) and turns on live streaming; detach turns it off while the drawer
      // is closed or shows another note. Scrollback keeps accumulating either way.
      // `host` is the machine picked for the spawn (ignored when the shell is
      // already live — its host is fixed at birth, restart to move it); the
      // response reports the host the shell is actually on, which is what the
      // drawer's badge shows. Validated like runBlock's (resolveHost).
      terminalAttach: { params: { sessionId: string; host?: string | null }; response: { dataB64: string; host: string } };
      terminalDetach: { params: { sessionId: string }; response: { ok: boolean } };
      // Whether the note's terminal shell is currently alive, and where. The
      // view asks before opening the drawer (or sending a block to it) on a
      // multi-host note: a live shell means no host picker — the paste can
      // only go where that shell already is — while a dead one means the
      // spawn is about to happen and the user must choose first.
      terminalStatus: { params: { sessionId: string }; response: { live: boolean; host: string | null } };
      // Tear down both of a note's shells; sent when its tab (or pane, or
      // workspace) closes and its docId drops out of the live set.
      closeSession: { params: { sessionId: string }; response: { ok: boolean } };
      // The note's spawn parameters, as the view parsed them from its
      // frontmatter (shared/frontmatter.ts). Sent when a note's saved text
      // first lands in its editor and again whenever an edit changes what the
      // frontmatter parses to; Bun keeps the latest per session and applies it
      // when that session's shells SPAWN — an already-running shell keeps the
      // params it was born with (restart-applies, like settings). These values
      // are deliberately not opaque handles (architecture.md §2): they flow
      // only into the user's own shell's spawn, which grants the view nothing
      // that runBlock — arbitrary code in that same shell — does not already.
      // `notePath` rides alongside the frontmatter params but is a FACT, not a
      // setting: the file this session's note lives at (null before its first
      // save), re-sent when the file moves. Bun re-validates it against the
      // registry and stamps it into local spawns as LEDGE_NOTE (plus the
      // containing root as LEDGE_WORKSPACE), pinned after every user env
      // layer — so an agent in the note's own shells can answer "the note I
      // am sitting in" (the MCP server's read_note defaults to it), and no
      // frontmatter can forge it.
      sessionConfigure: { params: { sessionId: string; params: NoteParams; notePath: string | null }; response: { ok: boolean } };
      // Kill all of a note's shells so the next run / terminal attach spawns
      // fresh ones — the escape hatch for restart-applies params: edit the
      // frontmatter, restart, and the new cwd/env are live. Unlike
      // closeSession the tab stays open, so Bun closes out every open run
      // (runEvent ended) and tells an attached drawer the shell is gone
      // (terminalExit); the session's params survive — applying them is the
      // point. Sent by the "Restart Note Shell" command.
      sessionRestart: { params: { sessionId: string }; response: { ok: boolean } };
      // Read one profile's env file, creating it (seeded, 0600) first if it
      // does not exist. Ledge's own profile editor is the UI — macOS binds no
      // application to ".env" (LSApplicationNotFound), so there was never an
      // OS-editor path — and this pair is its load/save; settingsRead/Write
      // below are the same shape for the same reason, one config file later.
      // `name` is re-validated Bun-side
      // (assertProfileName) before it becomes a filename in both calls: the
      // view is the least-trusted end. Fired by the "Edit Note Profile"
      // command with the profile the note's frontmatter names.
      profileRead: { params: { name: string }; response: { text: string } };
      // Write the profile's full new text (the editor serializes; comments
      // survive — shared/dotenv.ts). Atomic like a note save, kept 0600.
      profileWrite: { params: { name: string; text: string }; response: { ok: boolean } };
      // System clipboard, routed through the Bun process (pbcopy/pbpaste). The
      // webview runs under the views:// scheme, which is not a secure context, so
      // navigator.clipboard is unavailable and execCommand / native Cmd+V paste
      // are unreliable without a native Edit menu. Going through Bun sidesteps all
      // of that and behaves like a normal terminal's copy/paste.
      clipboardWrite: { params: { text: string }; response: { ok: boolean } };
      clipboardRead: { params: {}; response: { text: string } };
      // Both flavors at once, for the editor's ⌘V: `html` is the pasteboard's
      // `public.html` ("" when it carries none), which the editor translates to
      // Markdown so formatted text keeps its structure
      // (editor/htmlPaste.ts). Its own call because reading that flavor costs an
      // osascript spawn (bun/clipboard.ts) — the terminal and the settings
      // dialog want text and stay on clipboardRead, which is a pbpaste.
      clipboardReadRich: { params: {}; response: { text: string; html: string } };
      // Install the native menu bar. The view builds it from the command
      // registry and re-pushes whenever the state a `when` reads changes, so
      // enablement stays honest without Bun learning what a command means.
      // Bun sets a minimal fallback menu at boot (Quit and the edit roles),
      // which this replaces wholesale on the view's first push.
      menuSet: { params: { items: AppMenuItem[] }; response: { ok: boolean } };
      // The validated settings snapshot (shared/settings.ts), fetched once at
      // boot. Bun owns the files, the parsing, and the fallbacks; the view only
      // ever sees a complete, valid Settings and never learns there were two of
      // them — the client shell merges its own half in on the way past
      // (bun/clientSeams.ts, remote.md §5). Applies at launch — there is no
      // settingsChanged message, deliberately (architecture.md, "Settings").
      settingsGet: { params: {}; response: { settings: Settings } };
      // The settings editor's load/save (the ⌘, dialog), mirroring
      // profileRead/profileWrite: the view cannot name the file — Bun knows
      // where each settings.jsonc lives — and it carries raw JSONC text,
      // comments and all. Read seeds the commented template on a fresh
      // install, so the first ⌘, opens documented knobs; write is atomic like
      // a note save and deliberately not gated on parsing (a mid-edit save
      // must not be refused — launch-time validation already degrades per
      // field, and the dialog shows problems live). Saved changes still apply
      // at the NEXT launch, like every setting.
      //
      // `home` picks which of the two files (SETTINGS_HOMES): "server" is the
      // machine holding the notes, "client" is this app on this screen, and
      // the client shell answers the second one itself rather than forwarding
      // it. The dialog shows one tab per home; a client is a thing with a
      // screen, so both always exist.
      settingsRead: { params: { home: SettingsHome }; response: { text: string } };
      settingsWrite: { params: { home: SettingsHome; text: string }; response: { ok: boolean } };
      // Write the `ledge` CLI shim onto the PATH (the Install Shell Command
      // palette entry). Bun composes the whole outcome message: it alone
      // knows the shim's landing dir, the PATH answer, and the failure — the
      // view only surfaces the text (notice strip on ok, error strip
      // otherwise). Never throws across the RPC; failure is data here.
      cliInstall: { params: {}; response: { ok: boolean; message: string } };
      // Put a view-side failure in the session log (bun/log.ts). The webview
      // has no console anyone can read in a shipped build — WKWebView's goes
      // to the inspector, which a user does not have — so an uncaught render
      // error would otherwise leave nothing behind but a blank pane. Only
      // failures ride this: `window.onerror`, unhandled rejections, and
      // console.error, never ordinary logging, and the view caps how many it
      // will send in a session (lib/log.ts) so an erroring render loop cannot
      // turn the log into a disk-filler.
      //
      // Bun stamps the `[view/…]` prefix itself and truncates the text, which
      // is the whole guard: this is a fixed-name append of arbitrary view
      // bytes, and the only thing that keeps it from being byte storage in
      // the app home is that it is bounded and lands in a file the app treats
      // as disposable.
      logAppend: { params: { level: "warn" | "error"; text: string }; response: { ok: boolean } };
      // Open the log folder in Finder (the Help menu's "Reveal Log"). Takes
      // no path — Bun alone knows where the log lives, so the view cannot
      // aim `open` at anything.
      logReveal: { params: {}; response: { ok: boolean } };
      // Read one local image referenced by a note (`![](.ledge-assets/x.png)`) for the
      // editor's rendered preview. The webview cannot touch the filesystem, so
      // the bytes ride the RPC base64-encoded. `src` is the markdown-relative
      // reference exactly as the note carries it; `root` is the workspace the
      // referencing note lives in — the reference is only meaningful relative
      // to its own folder. Bun guards both hard (bun/assets.ts assetPathOf: a
      // registered root, inside it, an image-extension allowlist, no
      // dot-entries) — the view is the least-trusted end, and without the
      // extension check this call would read any note. null when missing.
      // `sealed: true` means the file exists but is a SEALED image
      // (locking.md §5) and the vault is locked: the widget shows the
      // locked-image placeholder, not a broken one. Sealed assets decrypt
      // Bun-side when the vault is open and ride back as ordinary bytes.
      assetRead: {
        params: { root: string; src: string };
        response: { image: { dataB64: string; mime: string } | null; sealed?: boolean };
      };
      // Save the pasteboard's image (if any) into the workspace root's .ledge-assets/
      // as a PNG and return the markdown-relative reference to embed
      // (`.ledge-assets/pasted-….png`), or null when the pasteboard holds no image.
      // Sent by the editor's ⌘V when the pasteboard has no text; `root` is the
      // pasting note's workspace.
      //
      // Answered by the CLIENT (remote.md §10): the pasteboard belongs to the
      // device the user is holding, and a VPS has none. It reads the image and
      // hands the bytes to assetWrite below, which is the half that names the
      // file — the view still never names one.
      // `notePath` is the PASTING note's file, when it has one: the server
      // derives from the note itself — never from a view flag — whether the
      // paste must be sealed at birth (the note is locked, locking.md §5).
      assetPaste: { params: { root: string; notePath?: string | null }; response: { src: string | null } };
      // The same trip, begun by asking the DEVICE for a picture instead of
      // reading its pasteboard: the macOS file dialog, and on iOS the photo
      // library (ios.md §11). Sent by Insert Image…, which is the only way in
      // on a phone — there is no ⌘V there, and the picture the user wants is
      // the one they took, not one they somehow copied.
      //
      // A client method for assetPaste's reason and answering in its shape: the
      // picker belongs to the machine with a person at it, the bytes ride
      // assetWrite, and the NAME still comes back from the machine that holds
      // the notes. null is a cancelled picker, which is the common outcome and
      // must not reach the server or the error strip.
      assetPick: { params: { root: string; notePath?: string | null }; response: { src: string | null } };
      // Image bytes in, markdown reference out. The client's half of a paste
      // calls this; nothing in the view does. `dataB64` rides a binary frame
      // over a connection (shared/wire.ts) and is the base64 the schema says
      // it is everywhere else, so a screenshot costs its own size and not a
      // third more.
      //
      // Everything that decides the file stays here: uniqueName against a
      // readdir snapshot, the .ledge-assets guard, the read-only-root refusal,
      // and the seal, which is read off the note on disk. The client supplies
      // bytes and handles it was given, which is exactly the authority §2
      // allows it.
      assetWrite: {
        params: { root: string; notePath?: string | null; dataB64: string };
        response: { src: string | null };
      };
      // Which server this client talks to (remote.md §8). All six are
      // answered by the client shell and never forwarded: a connection is
      // client-side configuration, and a server has no opinion about who
      // connects to it.
      //
      // `active` is the connection being served right now and `wanted` is the
      // one the user last chose. They differ only when a connection could not
      // be opened at boot, in which case `error` says why and the local server
      // is serving instead — an app that opens on the wrong machine and says
      // so beats an app that does not open.
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
      // Switch. Tears the session down and rebuilds it, so the caller reloads
      // itself on ok (remote.md §8) — everything workspace-scoped is scoped to
      // a server, and the view's boot is the rebuild. A connection that will
      // not open leaves the current one untouched and answers with the reason:
      // losing a working session to a typo would be the worse failure.
      connectionSelect: { params: { id: string }; response: { ok: boolean; error: string } };
      // Add one. `hostKey` is the known_hosts line the user was shown the
      // fingerprint of and accepted (connectionProbe below) — the client pins
      // only what a person confirmed, never what a host happened to answer.
      connectionAdd: {
        params: { name: string; destination: string; keyPath: string; hostKey: string };
        response: { id: string; error: string };
      };
      // Change one: its name, its address, or the key it offers.
      //
      // `hostKey` is null to keep whatever is pinned, a line to pin instead, or
      // "" to pin nothing and let the user's own ssh decide. Three states
      // because "" already means the third; and whichever it resolves to is
      // refused when it names a host the new address does not, since a pin is a
      // claim about one machine and reading the new one's fingerprint is the
      // step that moving a connection is supposed to cost (remote.md §4).
      //
      // Editing the connection being served re-opens it, which is why this can
      // answer with the same "could not reach" a switch does: the wire in front
      // of the user was built from the old address, and a row that says one
      // machine over a session talking to another is the lie the indicator
      // exists to prevent. The caller reloads on ok for exactly that case, as
      // it does for connectionSelect.
      connectionUpdate: {
        params: { id: string; name: string; destination: string; keyPath: string; hostKey: string | null };
        response: { ok: boolean; error: string };
      };
      // Remove one, and its pin with it. The local server and the connection
      // currently being served both refuse.
      connectionRemove: { params: { id: string }; response: { ok: boolean; error: string } };
      // Pairing: ask a host for its key and describe it, so the fingerprint
      // can be compared against what the server said before anything is
      // pinned. Failure is data — an unreachable host is the most ordinary
      // outcome of typing an address.
      connectionProbe: {
        params: { destination: string };
        response: { hostKey: string; fingerprint: string; keyType: string; error: string };
      };
      // The persisted session layout (.layout.json in the app home): which
      // workspaces exist, which folder each owns, their pane trees, and which
      // notes are open where. One global file — the workspace list itself is
      // what it records. Machine-written state, not settings (architecture.md
      // §6): Bun owns the file's bytes and atomicity, the VIEW owns the shape —
      // it serializes on layout changes and parses/self-heals at boot
      // (workspace/persist.ts), so the payload rides as raw text. null when no
      // layout has ever been saved. Which CLIENT's layout comes from the
      // connection's handshake, never from the call (remote.md §5).
      layoutGet: { params: {}; response: { text: string | null } };
      // Persist the serialized layout. Bun writes it to the fixed dotted file —
      // the view names nothing — atomically like a note save, and refuses text
      // that is not JSON: a write this free must not become arbitrary byte
      // storage in the app home. Sent debounced on every layout change and
      // flushed on blur/pagehide, like note autosave.
      layoutSave: { params: { text: string }; response: { ok: boolean } };
      // Take (consume) any pending CLI open request — the boot-time half of
      // `ledge <title>` (bun/openRequest.ts). The view calls this once, after
      // its subscriber wiring is up: a push at boot could fire before anyone
      // listens, so the cold-start path is a pull. `open` carries a full
      // NoteMeta plus its root so the view can select the workspace and open
      // the tab without a lookup; null means nothing (valid) was pending.
      openRequestTake: { params: {}; response: { open: ExternalOpenInfo | null } };
      // --- the vault (note locking, locking.md) ---------------------
      // Current state, fetched at boot and after any transition the view did
      // not drive itself. "none" = no vault exists yet (the first Lock This
      // Note runs creation instead of unlock).
      vaultState: { params: {}; response: { state: VaultState } };
      // First lock ever: create the vault from a chosen passphrase (scrypt →
      // master key; .vault.json holds the salt and a key-check, never a
      // key). Leaves the vault unlocked. Refused when one already exists.
      vaultCreate: { params: { passphrase: string }; response: { ok: boolean } };
      // Unlock with the passphrase. ok:false is a wrong passphrase (the
      // dialog shakes and stays), never an exception. The passphrase crosses
      // the RPC exactly once per unlock, is used for the KDF, and is
      // dropped; with no vault FILE but locked notes on disk (synced from
      // another machine), Bun probes a locked note's own self-contained
      // header and rebuilds the file on success.
      vaultUnlock: { params: { passphrase: string }; response: { ok: boolean } };
      // Relock now (⌘L, and quit). The view flushes dirty locked buffers
      // BEFORE calling — Bun cannot save what it cannot see — then evicts
      // its decrypted state on the vaultChanged push this triggers.
      vaultLock: { params: {}; response: { ok: boolean } };
      // Lock / unlock one note (the palette two-faces pair). Both require
      // the vault unlocked; noteLock refuses template-marked notes (the
      // marker exclusivity, checked Bun-side in notes.ts where the MCP
      // template path also cannot bypass it). Body and header transition on
      // disk; the response meta carries the new locked flag for the lists.
      // `sealedShared` names swept images OTHER unlocked notes also show
      // (locking.md §5) — the view surfaces it as a notice; sealing
      // proceeds either way, since a refusal would deadlock locking two
      // notes that share an image.
      noteLock: { params: { path: string }; response: { note: NoteMeta; sealedShared: string[] } };
      noteRemoveLock: { params: { path: string }; response: { note: NoteMeta } };
      // Change the passphrase: new salt + master key, every locked note's
      // header and sealed image's key wrap rewritten across all available
      // roots — headers and wraps only, bodies never (locking.md §3).
      // Unlocked only; `rewrapped` is the count for the notice.
      vaultChangePassphrase: { params: { passphrase: string }; response: { ok: boolean; rewrapped: number } };
      // Open a note link in the OS default handler (browser, mail client).
      // Sent by the editor's ⌘-click and the "Open Link" command. The URL is
      // re-validated Bun-side against the same scheme allowlist the view used
      // (shared/links.ts) — the view's check is styling, this one is the
      // guard: `open` treats a non-URL argument as a file path and launches
      // .app bundles, so an unvalidated string here would be command
      // execution (architecture.md §2). ok:false means refused or unopenable.
      linkOpen: { params: { url: string }; response: { ok: boolean } };
    };
    messages: {};
  };
  webview: {
    requests: {};
    messages: {
      runEvent: RunEvent;
      // Raw pty output for one note's terminal drawer, base64-encoded. `sessionId`
      // lets the mounted drawer ignore output from a note other than the one it
      // currently shows (e.g. brief overlap during a tab switch).
      terminalOutput: { sessionId: string; dataB64: string };
      // Whether a note's terminal shell is mid-job: false only when it is sitting
      // at an idle prompt with nothing queued behind it. Only Bun can know this (it
      // reads the shell's bracketed-paste mode; see BP_ENABLE in index.ts), and the
      // view needs it because a block sent to a busy shell is queued rather than
      // run: without this the queue is invisible and the button lies.
      terminalBusy: { sessionId: string; busy: boolean };
      // A note's terminal shell exited on its own (the user typed `exit`). The Bun
      // side has already torn the shell down; the view closes the drawer if it is
      // showing that note. Reopening the drawer spawns a fresh shell.
      terminalExit: { sessionId: string };
      // Something changed one workspace root's files behind the app's back — an
      // agent in the terminal drawer, git, a shell mv/rm. Pushed by the per-root
      // fs.watch (bun/watch.ts), debounced Bun-side, filtered to .md entries
      // outside dot-directories. The view re-reads that folder's note and trash
      // lists and reloads any open, UNEDITED note whose file moved on (an edited
      // one is left alone; its next save's baseMtimeMs guard arbitrates).
      // Ledge's own saves fire it too, deliberately unfiltered: the reload
      // compares mtimes and no-ops, and suppressing them here would mean the
      // watcher and the store had to agree on what "ours" means. The window's
      // focus refresh stays as the belt for a watcher that misses (an unmounted
      // volume's root is not watched until the next boot).
      notesChanged: { root: string };
      // A CLI open request arrived while the app is running (the app-home
      // watcher saw the request file; bun/openRequest.ts validated it). Same
      // payload as openRequestTake's answer; the view selects the workspace
      // showing `root` and opens the note's tab.
      openExternal: ExternalOpenInfo;
      // The vault's state changed on the Bun side — an unlock, a ⌘L, or the
      // 15-minute idle auto-relock. On "locked" the view swaps open locked
      // tabs to placeholders, drops their decrypted bodies, and evicts the
      // asset data-URL cache; on "unlocked" it re-reads open locked notes.
      vaultChanged: { state: VaultState };
      // A menu item carrying an `action` was clicked (role items never arrive
      // here — AppKit handles those). The payload is the command id the view
      // put there; it execs it with no target, the palette's invocation.
      menuCommand: { action: string };
      // Whether the connection to the server is up (remote.md §7). Pushed by
      // the CLIENT shell, never by a server — a server saying "reconnecting"
      // would be describing a wire it is on the far side of — so it is in
      // CLIENT_PUSHES and never becomes a frame.
      //
      // "reconnecting" is a link that dropped and is being re-dialed, with
      // requests held rather than failed; "lost" is the point where re-dialing
      // stopped and what was held has been refused. `detail` is the sentence to
      // show. The local server never leaves "live": there is no wire to drop.
      connectionState: { state: "live" | "reconnecting" | "lost"; detail: string };
    };
  };
};
