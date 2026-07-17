// The typed contract between the Bun main process and the editor webview.
// This replaces the hand-rolled window.webkit.messageHandlers bridge from the
// Swift build: the webview requests a block run, Bun streams run events back.

import type { Settings } from "./settings";
import type { NoteParams } from "./frontmatter";

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
}

/**
 * One deleted note, sitting in ~/.ledge/.trash. `path` is where it is now, which
 * is the handle restore and undo are given. `deletedAt` is when it was trashed
 * (see listTrash in bun/notes.ts for where that number comes from).
 */
export interface TrashMeta {
  path: string;
  title: string;
  deletedAt: number;
}

export type LedgeRPC = {
  bun: {
    requests: {
      // The note store (notes.ts). Bun owns every path: the view holds paths only
      // as opaque handles it got from here, and Bun rejects any that fall outside
      // the notes root. Notes are plain .md files; `path` identifies the file,
      // while `sessionId` (the docId) identifies the live editor and its shells.
      noteList: { params: {}; response: { notes: NoteMeta[] } };
      // null when the note is gone (deleted behind the app's back).
      noteRead: { params: { path: string }; response: { text: string | null } };
      // Atomic overwrite (temp file plus rename), so a crash mid-save can never
      // truncate a note. Sent on a debounce as you type and on Cmd+S.
      noteWrite: { params: { path: string; text: string }; response: { ok: boolean } };
      // Allocate a file for a note that has none and write its first content,
      // returning the note the view then saves to (and titles its tab from). Sent
      // on a note's first edit, so a tab opened and never typed in creates nothing.
      noteCreate: { params: { text: string }; response: { note: NoteMeta } };
      // Move a note's file to match its first-line H1, returning where it now
      // lives (possibly unmoved). The view sends the note's TEXT, not a name: Bun
      // slugs the heading itself, so the name is safe by construction and there is
      // nothing for a buggy view to smuggle through. Sent only when a note's slug
      // actually changes, never on an ordinary edit. The docId is untouched, so
      // the note's editor and shell live through it.
      noteRetitle: { params: { path: string; text: string }; response: { note: NoteMeta } };
      // Delete a note by moving it to ~/.ledge/.trash. Not an unlink: a misclick
      // should cost a trip to the Trash section, not the note. It is an
      // app-private folder, not the system trash (see TRASH_DIR in notes.ts).
      // Responds with where the note landed, which is the handle Undo restores
      // from, or null if there was nothing there to delete.
      noteDelete: { params: { path: string }; response: { trashed: string | null } };
      // The deleted notes still recoverable, newest first. Read at boot and at
      // every folder refresh, alongside noteList: the count is on screen whether
      // or not the section is expanded, so the trash cannot quietly fill up.
      trashList: { params: {}; response: { items: TrashMeta[] } };
      // Move a trashed note back to the notes root, returning where it landed
      // (its old name may be taken by now). Backs both Undo and the Restore
      // button, which are the same operation: Undo is just the shortcut to the
      // one that stays available in the Trash section.
      trashRestore: { params: { path: string }; response: { note: NoteMeta } };
      // Unlink ONE trashed note, for good. Like trashEmpty this destroys a note
      // outright, so the view confirms first; unlike it, the note named is the
      // only one that can go. Responds false if it was already gone.
      trashDelete: { params: { path: string }; response: { removed: boolean } };
      // Unlink every trashed note. Destroys notes outright, hence the
      // confirmation in front of it.
      trashEmpty: { params: {}; response: { removed: number } };
      // Shells are per note: `sessionId` is the tab's stable docId. The Bun side
      // lazily spawns that note's persistent inline-run shell on first runBlock and
      // closes it on closeSession, so a `cd` in one note never leaks into another.
      // A block run while that shell is mid-block gets an ephemeral overflow shell
      // of its own (concurrent inline runs; see bun/inlinePool.ts), torn down when
      // the run ends.
      // `language` is the fence's info string ("python", "node", ...): Bun picks
      // the runner from it — source into the shell, or exec an interpreter on the
      // temp file (bun/runner.ts). The view never decides how code runs.
      runBlock: {
        params: { sessionId: string; id: string; code: string; language: string | null };
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
      terminalPaste: { params: { sessionId: string; text: string; language?: string | null }; response: { ok: boolean } };
      terminalResize: { params: { sessionId: string; cols: number; rows: number }; response: { ok: boolean } };
      // Attach lazily spawns the note's terminal shell (if needed), returns the
      // scrollback so far (so a freshly opened drawer shows the existing prompt and
      // history) and turns on live streaming; detach turns it off while the drawer
      // is closed or shows another note. Scrollback keeps accumulating either way.
      terminalAttach: { params: { sessionId: string }; response: { dataB64: string } };
      terminalDetach: { params: { sessionId: string }; response: { ok: boolean } };
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
      sessionConfigure: { params: { sessionId: string; params: NoteParams }; response: { ok: boolean } };
      // Kill all of a note's shells so the next run / terminal attach spawns
      // fresh ones — the escape hatch for restart-applies params: edit the
      // frontmatter, restart, and the new cwd/env are live. Unlike
      // closeSession the tab stays open, so Bun closes out every open run
      // (runEvent ended) and tells an attached drawer the shell is gone
      // (terminalExit); the session's params survive — applying them is the
      // point. Sent by the "Restart Note Shell" command.
      sessionRestart: { params: { sessionId: string }; response: { ok: boolean } };
      // Read one profile's env file, creating it (seeded, 0600) first if it
      // does not exist. Unlike settings.json, profiles do NOT open in the OS
      // editor — macOS binds no application to ".env" (LSApplicationNotFound),
      // so `open` dead-ends — Ledge's own profile editor is the UI, and this
      // pair is its load/save. `name` is re-validated Bun-side
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
      // The validated settings snapshot (shared/settings.ts), fetched once at
      // boot. Bun owns the file, the parsing, and the fallbacks; the view only
      // ever sees a complete, valid Settings. Applies at launch — there is no
      // settingsChanged message, deliberately (architecture.md, "Settings").
      settingsGet: { params: {}; response: { settings: Settings } };
      // Open settings.json in the OS default editor (the ⌘, command). The view
      // cannot name the file — Bun knows where it lives.
      settingsOpen: { params: {}; response: { ok: boolean } };
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
    };
  };
};
