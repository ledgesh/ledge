// Ledge main process.
//
// One native window loads the editor webview. Shells are per note: each tab
// (keyed by its stable docId, `sessionId` on the wire) gets its own pair of
// shells, run in this Bun process via the bun:ffi PTY (a port of the Swift
// SessionKit core) and spawned lazily on first use. The inline-run shell slices
// block output per block via OSC 133 markers; the terminal-drawer shell is raw,
// driving xterm.js. Keeping them per note means a `cd` in one note never leaks
// into another. Both talk to the view over typed RPC.
import { BrowserView, BrowserWindow, Updater } from "electrobun/bun";
import { PtyProcess } from "./pty";
import { MarkerParser, markerCommand } from "./markers";
import {
  createNote,
  deleteNote,
  deleteTrashed,
  emptyTrash,
  listNotes,
  listTrash,
  NOTES_ROOT,
  purgeTrash,
  readNote,
  restoreNote,
  retitleNote,
  writeNote,
} from "./notes";
import type { LedgeRPC } from "../shared/rpc-schema";

// In the dev channel, prefer a running Vite dev server (bun run dev:hmr) so the
// React view hot-reloads; otherwise load the built view copied into the bundle.
const VITE_URL = "http://localhost:5173";
async function mainViewUrl(): Promise<string> {
  if ((await Updater.localInfo.channel()) === "dev") {
    try {
      await fetch(VITE_URL, { method: "HEAD" });
      console.log("[bun] HMR: using Vite dev server at", VITE_URL);
      return VITE_URL;
    } catch {
      // Vite not running; fall through to the built view.
    }
  }
  return "views://mainview/index.html";
}

// Fresh per session, never written into a note, so a block cannot forge its own
// end marker (see markers.ts).
const NONCE = Math.random().toString(36).slice(2) + Date.now().toString(36);

const shellEnv = { ...process.env, TERM: "xterm-256color" } as Record<string, string>;

const toB64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const fromB64 = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));

function spawnShell(): PtyProcess {
  return new PtyProcess({ executable: "/bin/zsh", args: ["-i"], env: shellEnv, cwd: process.env["HOME"] });
}

// --- per-note inline-run shells --------------------------------------------
// Block bodies are sourced into a note's own shell with OSC 133 markers so output
// can be sliced per block. Each note keeps its own MarkerParser (the parser is a
// stateful stream slicer, one per shell). Spawned on the note's first runBlock.
interface Inline {
  shell: PtyProcess;
  parser: MarkerParser;
}
const inlines = new Map<string, Inline>();
function inlineFor(sessionId: string): Inline {
  let it = inlines.get(sessionId);
  if (!it) {
    it = { shell: spawnShell(), parser: new MarkerParser(NONCE) };
    inlines.set(sessionId, it);
  }
  return it;
}

// --- per-note terminal-drawer shells ---------------------------------------
// A separate, plain interactive session per note with no marker protocol. Its raw
// byte stream drives xterm.js in the view; the view's keystrokes and resizes come
// back over the RPC below. Spawned on the note's first terminalAttach.
//
// Scrollback: a note's terminal keeps printing (its prompt, background output)
// while the drawer is closed or showing another note, so each keeps a capped
// rolling buffer of its raw output that terminalAttach replays. `attached` gates
// live streaming: bytes still accumulate while detached, so re-attaching replays
// the full history.
const SB_CAP = 256 * 1024;
// zsh toggles bracketed-paste mode around every prompt cycle: it emits BP_ENABLE
// (CSI ? 2004 h) when its line editor is ready for input, and BP_DISABLE (2004 l)
// the moment a foreground command starts running. A bracketed paste is only
// interpreted while it is enabled; sent at any other time (cold shell, or mid
// command) the markers echo raw (the `^[[200~` noise) and the text runs out of
// order. So terminalPaste queues pastes and the drain loop releases them one per
// prompt, tracking this live `promptReady` state from the two sequences.
const BP_ENABLE = "\x1b[?2004h";
const BP_DISABLE = "\x1b[?2004l";
interface Term {
  term: PtyProcess;
  attached: boolean;
  chunks: Uint8Array[];
  len: number;
  // Bracketed-paste sequencing: `promptReady` mirrors the shell's current mode
  // (true only at an idle prompt). Pastes wait in `pasteQueue` and are released
  // one at a time, each on a fresh prompt, so multiple queued commands never
  // stack up inside one command's run. `scanTail` carries the last few output
  // bytes across drain ticks so a toggle sequence split across a read boundary is
  // still matched.
  promptReady: boolean;
  pasteQueue: string[];
  scanTail: string;
}
const terms = new Map<string, Term>();
function termFor(sessionId: string): Term {
  let t = terms.get(sessionId);
  if (!t) {
    t = { term: spawnShell(), attached: false, chunks: [], len: 0, promptReady: false, pasteQueue: [], scanTail: "" };
    terms.set(sessionId, t);
  }
  return t;
}

// Wrap a block as a bracketed paste + trailing Enter, exactly what a terminal
// emulator sends on paste. Trailing newlines are trimmed so they do not add blank
// buffer lines.
function bracketedPaste(text: string): string {
  return `\x1b[200~${text.replace(/\n+$/, "")}\x1b[201~\r`;
}
// Release the next queued paste if the shell is idle at a prompt. Sending it
// submits the command (the trailing \r), which drops the shell out of prompt
// mode, so we optimistically clear `promptReady`: the remaining queue then waits
// for the shell's next BP_ENABLE, giving exactly one command per prompt.
function flushPaste(t: Term): void {
  if (!t.promptReady || t.pasteQueue.length === 0) return;
  t.term.write(t.pasteQueue.shift()!);
  t.promptReady = false;
}
function sbPush(t: Term, d: Uint8Array): void {
  t.chunks.push(d);
  t.len += d.length;
  while (t.len > SB_CAP && t.chunks.length > 1) t.len -= t.chunks.shift()!.length;
}
function sbSnapshot(t: Term): Uint8Array {
  const out = new Uint8Array(t.len);
  let o = 0;
  for (const c of t.chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

// Tear down both of a note's shells when its tab closes.
function closeSession(sessionId: string): void {
  inlines.get(sessionId)?.shell.close();
  inlines.delete(sessionId);
  terms.get(sessionId)?.term.close();
  terms.delete(sessionId);
}

const rpc = BrowserView.defineRPC<LedgeRPC>({
  maxRequestTime: 10_000,
  handlers: {
    requests: {
      // --- note store ------------------------------------------------------
      // Every path these take is checked against the notes root inside notes.ts,
      // so a compromised or buggy view cannot read or write outside ~/.ledge.
      noteList: async () => ({ notes: await listNotes() }),
      noteRead: async ({ path }) => ({ text: await readNote(path) }),
      noteWrite: async ({ path, text }) => {
        await writeNote(path, text);
        return { ok: true };
      },
      noteCreate: async ({ text }) => ({ note: await createNote(text) }),
      noteRetitle: async ({ path, text }) => ({ note: await retitleNote(path, text) }),
      noteDelete: async ({ path }) => ({ trashed: await deleteNote(path) }),
      trashList: async () => ({ items: await listTrash() }),
      trashRestore: async ({ path }) => ({ note: await restoreNote(path) }),
      trashDelete: async ({ path }) => ({ removed: await deleteTrashed(path) }),
      trashEmpty: async () => ({ removed: await emptyTrash() }),

      runBlock: async ({ sessionId, id, code }) => {
        // The block body goes to a file that we source, rather than being inlined
        // into the command line. That sidesteps quoting, heredocs, and line
        // continuations, and sourcing keeps cwd/env changes across blocks within
        // the note (its shell is reused; a fresh note gets a fresh shell).
        const path = `/tmp/ledge-spike-${id}.sh`;
        await Bun.write(path, code);
        inlineFor(sessionId).shell.write(markerCommand(`source ${path}`, NONCE, id));
        return { accepted: true };
      },
      cancelRun: ({ sessionId }) => {
        // SIGINT the note's inline shell's process group, interrupting whatever
        // block is running in the foreground. killpg rather than writing a 0x03
        // byte: the tty only turns Ctrl-C into a signal in canonical mode, so a
        // program that put the terminal in raw mode (a REPL, vim, claude) would
        // just read the byte as input and keep running. .get, not inlineFor, so a
        // note with no shell never spawns one just to be cancelled.
        //
        // The foreground job shares the shell's process group here (job control is
        // off on this pty), so killpg reaches it; interactive zsh ignores SIGINT,
        // so the shell survives with its cwd/env intact for the note's next block.
        // The wrapped `source` then returns and the run ends on its D marker.
        inlines.get(sessionId)?.shell.interrupt();
        return { ok: true };
      },
      inlineResize: ({ sessionId, cols, rows }) => {
        // Resize the note's inline shell so block output renders at the grid the
        // view shows. inlineFor (not .get) so a resize that arrives just before the
        // run still targets the same shell the run will reuse.
        inlineFor(sessionId).shell.resize(cols, rows);
        return { ok: true };
      },
      inlineInput: ({ sessionId, dataB64 }) => {
        // Feed keystrokes to the note's inline shell (only sent while a block's
        // program is the running foreground process). .get, not inlineFor: never
        // spawn a shell just to receive input for a note that has none.
        inlines.get(sessionId)?.shell.write(fromB64(dataB64));
        return { ok: true };
      },
      terminalInput: ({ sessionId, dataB64 }) => {
        termFor(sessionId).term.write(fromB64(dataB64));
        return { ok: true };
      },
      terminalPaste: ({ sessionId, text }) => {
        const t = termFor(sessionId);
        // Always queue, then try to release immediately. If the shell is idle at a
        // prompt the paste goes out now; if it is cold or mid-command it waits for
        // the next prompt, so pastes never echo raw or run out of order.
        t.pasteQueue.push(bracketedPaste(text));
        flushPaste(t);
        return { ok: true };
      },
      terminalResize: ({ sessionId, cols, rows }) => {
        termFor(sessionId).term.resize(cols, rows);
        return { ok: true };
      },
      // Synchronous so no drain tick can interleave between the snapshot and
      // enabling live streaming: the snapshot is everything up to now, live is
      // everything after, with no gap or overlap. Lazily spawns the note's
      // terminal shell on first attach.
      terminalAttach: ({ sessionId }) => {
        const t = termFor(sessionId);
        t.attached = true;
        return { dataB64: toB64(sbSnapshot(t)) };
      },
      terminalDetach: ({ sessionId }) => {
        const t = terms.get(sessionId);
        if (t) t.attached = false;
        return { ok: true };
      },
      closeSession: ({ sessionId }) => {
        closeSession(sessionId);
        return { ok: true };
      },
      // System clipboard via macOS pbcopy/pbpaste. The webview cannot reach the
      // clipboard itself (non-secure views:// context), so the terminal and the
      // inline output panel proxy copy/paste through here.
      clipboardWrite: async ({ text }) => {
        try {
          const p = Bun.spawn(["pbcopy"], { stdin: "pipe" });
          p.stdin.write(text);
          await p.stdin.end();
          await p.exited;
        } catch {
          // No pbcopy (non-macOS or PATH issue); drop silently.
        }
        return { ok: true };
      },
      clipboardRead: async () => {
        try {
          const p = Bun.spawn(["pbpaste"], { stdout: "pipe" });
          const text = await new Response(p.stdout).text();
          await p.exited;
          return { text };
        } catch {
          return { text: "" };
        }
      },
    },
    messages: {},
  },
});

// Drain every live shell on a short interval. (poll()-gated reads never block;
// see pty.ts.) Inline shells are sliced into per-block events (block ids are
// globally unique, so the view routes each event to the editor that owns it with
// no per-note bookkeeping here); terminal shells stream raw to whichever drawer
// is attached to that note.
setInterval(() => {
  for (const [sessionId, it] of inlines) {
    const data = it.shell.drain();
    if (data) {
      for (const ev of it.parser.feed(data)) {
        if (ev.type === "began") {
          rpc.send.runEvent({ id: ev.blockId, kind: "began" });
        } else if (ev.type === "output") {
          rpc.send.runEvent({ id: ev.blockId, kind: "output", dataB64: toB64(ev.data) });
        } else if (ev.type === "ended") {
          rpc.send.runEvent({ id: ev.blockId, kind: "ended", exitCode: ev.exitCode });
        }
      }
    }
    // A block that quit the shell (e.g. `exit`) leaves it dead; drop it so the
    // note's next run spawns a fresh one.
    if (it.shell.exited) {
      it.shell.close();
      inlines.delete(sessionId);
    }
  }

  for (const [sessionId, t] of terms) {
    const termData = t.term.drain();
    if (termData) {
      sbPush(t, termData);
      if (t.attached) rpc.send.terminalOutput({ sessionId, dataB64: toB64(termData) });
      // Track the shell's bracketed-paste mode from its enable/disable sequences
      // and release a queued paste whenever a fresh prompt appears. The last
      // occurrence in the chunk wins (a chunk can carry a full prompt cycle). Carry
      // one char less than a full sequence so a completed toggle at the boundary is
      // not re-matched next tick, while a genuinely split sequence still is.
      const scan = t.scanTail + Buffer.from(termData).toString("latin1");
      const iEnable = scan.lastIndexOf(BP_ENABLE);
      const iDisable = scan.lastIndexOf(BP_DISABLE);
      if (iEnable !== -1 || iDisable !== -1) {
        t.promptReady = iEnable > iDisable;
        flushPaste(t);
      }
      t.scanTail = scan.slice(-(BP_ENABLE.length - 1));
    }
    // The user typed `exit`: tear the shell down and tell the drawer to close.
    if (t.term.exited) {
      if (t.attached) rpc.send.terminalExit({ sessionId });
      t.term.close();
      terms.delete(sessionId);
    }
  }
}, 8);

// Age old deletions out of the trash, once per launch. Deliberately not awaited:
// it is housekeeping, and the window should not wait on a folder scan to open.
// Doing it here rather than on a timer means a trashed note never disappears
// out from under a Trash section the user is looking at.
void purgeTrash()
  .then((n) => n > 0 && console.log(`[notes] purged ${n} trashed note(s) past the 30-day limit`))
  .catch((err) => console.error("[notes] trash purge failed", err));

const mainWindow = new BrowserWindow({
  title: "Ledge",
  url: await mainViewUrl(),
  rpc,
  frame: { width: 940, height: 700, x: 200, y: 120 },
});

process.on("exit", () => {
  for (const it of inlines.values()) it.shell.close();
  for (const t of terms.values()) t.term.close();
});

console.log("[bun] Ledge started (per-note shells, spawned on first use); notes root:", NOTES_ROOT);
void mainWindow;

