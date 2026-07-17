// Ledge main process.
//
// One native window loads the editor webview. Shells are per note: each tab
// (keyed by its stable docId, `sessionId` on the wire) gets its own shells, run
// in this Bun process via the bun:ffi PTY (a port of the Swift SessionKit core)
// and spawned lazily on first use. Inline-run shells (a persistent one per note,
// plus ephemeral overflow shells so blocks can run concurrently; inlinePool.ts)
// slice block output per block via OSC 133 markers; the terminal-drawer shell is
// raw, driving xterm.js. Keeping them per note means a `cd` in one note never
// leaks into another. All of them talk to the view over typed RPC.
import { BrowserView, BrowserWindow, Updater } from "electrobun/bun";
import { PtyProcess } from "./pty";
import { InlinePool, type InlineEvent } from "./inlinePool";
import { readProfile, writeProfile } from "./profiles";
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
import { readLayout, writeLayout } from "./layout";
import { pasteImageAsset, readAsset } from "./assets";
import { runnerFor } from "./runner";
import { loadSettings, openSettingsFile } from "./settings";
import { openableUrl } from "../shared/links";
import { resolveSpawn, type SpawnDeps } from "./spawnParams";
import { readFileSync, statSync } from "node:fs";
import type { LedgeRPC } from "../shared/rpc-schema";
import type { NoteParams } from "../shared/frontmatter";

// Read once, applied for the life of the process: the shell below, the trash
// TTL at the bottom, and the view's snapshot via settingsGet. Edits to
// settings.json take effect at the next launch (architecture.md, "Settings").
const settings = await loadSettings();

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

// Per-session spawn parameters, as the view parsed them from each note's
// frontmatter (sessionConfigure). Read at shell SPAWN, never applied to a
// running shell: a shell keeps the cwd/env it was born with, and an edited
// frontmatter takes effect on the session's next shell (restart-applies —
// same policy as settings, and the rpc-schema comment is the contract).
// Cleared with the session in closeSession: the params describe a live tab,
// not a note file, so they share its lifetime exactly.
const sessionParams = new Map<string, NoteParams>();

// The real filesystem behind resolveSpawn (its tests inject a fake one).
const spawnDeps: SpawnDeps = {
  readFile: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  isDir: (path) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
  warn: (msg) => console.warn("[session]", msg),
};

const toB64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const fromB64 = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));

// Every shell a session gets — persistent inline, overflow, terminal drawer —
// spawns through here, so all of them read the note's params the same way.
// The lookup happens AT spawn: an overflow shell spawned after a frontmatter
// edit gets the new params while the persistent shell keeps its old ones,
// which is just the restart-applies contract seen from another angle.
function spawnShell(sessionId: string): PtyProcess {
  const { cwd, env } = resolveSpawn(sessionParams.get(sessionId), shellEnv, spawnDeps);
  return new PtyProcess({
    executable: settings.shell.path,
    args: settings.shell.args,
    env,
    cwd,
  });
}

// --- per-note inline-run shells --------------------------------------------
// Block bodies are sourced into shells with OSC 133 markers so output can be
// sliced per block. The pool owns the whole policy — a persistent shell per note
// (spawned on its first runBlock) so cwd/env carry across blocks, plus an
// ephemeral overflow shell per additional concurrent run; see inlinePool.ts.
const inlinePool = new InlinePool(spawnShell, NONCE);

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
  // `promptReady` is false for two very different reasons: a job is running, or the
  // shell has not printed its first prompt yet. Only the first means busy, so the
  // drawer's button is not dead for the ~ms a cold shell takes to come up.
  everReady: boolean;
  // Last busy state pushed to the view, so the drain loop only sends on a change.
  sentBusy: boolean;
}

// A shell is busy when it cannot take a block right now: something is running, or
// pastes are already waiting on the prompt behind it.
function isBusy(t: Term): boolean {
  return t.everReady && (!t.promptReady || t.pasteQueue.length > 0);
}
const terms = new Map<string, Term>();
// Names the temp files behind interpreted blocks pasted to the terminal
// (inline runs use the view's block id instead; see runBlock).
let nextTermRunId = 1;
function termFor(sessionId: string): Term {
  let t = terms.get(sessionId);
  if (!t) {
    t = {
      term: spawnShell(sessionId),
      attached: false,
      chunks: [],
      len: 0,
      promptReady: false,
      pasteQueue: [],
      scanTail: "",
      everReady: false,
      sentBusy: false,
    };
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

// Tear down all of a note's shells when its tab closes.
function closeSession(sessionId: string): void {
  inlinePool.closeSession(sessionId);
  terms.get(sessionId)?.term.close();
  terms.delete(sessionId);
  sessionParams.delete(sessionId);
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

      runBlock: async ({ sessionId, id, code, language }) => {
        // The block body goes to a file, rather than being inlined into the
        // command line. That sidesteps quoting, heredocs, and line continuations.
        // What runs the file is the language's business (runner.ts): shell blocks
        // are sourced so cwd/env changes carry across blocks within the note (its
        // persistent shell is reused; a run started while it is busy gets an
        // overflow shell whose state dies with the run — inlinePool.ts), other
        // languages exec their interpreter on it. process.execPath is the app's
        // bundled bun, backing the "bun" interpreter for TypeScript.
        const spec = runnerFor(id, language, code, settings.blocks.interpreters, process.execPath);
        await Bun.write(spec.path, spec.contents);
        inlinePool.run(sessionId, id, spec.command);
        return { accepted: true };
      },
      cancelRun: ({ sessionId, id }) => {
        // SIGINT whatever the run's shell is executing, from outside the tty.
        // A signal rather than a 0x03 byte: 0x03 only becomes SIGINT if the tty is
        // in canonical mode, so a program that put it in raw mode (a REPL, vim,
        // claude) would just read the byte as input and keep going. This path is
        // used to force-cancel exactly those.
        //
        // The signal goes to the tty's foreground process group, which the shell's
        // job control gives the running job (see PtyProcess.interrupt). zsh is not
        // in that group and ignores SIGINT anyway, so a persistent shell survives
        // with its cwd/env intact for the note's next block, and the run ends on
        // the D marker its precmd hook prints when the prompt comes back.
        inlinePool.cancel(sessionId, id);
        return { ok: true };
      },
      inlineResize: ({ sessionId, id, cols, rows }) => {
        // Resize the run's shell so block output renders at the grid the view
        // shows. The pool stashes a resize that beats its runBlock across the RPC
        // (the panel fits itself the moment it renders) and applies it when the
        // run picks its shell.
        inlinePool.resize(sessionId, id, cols, rows);
        return { ok: true };
      },
      inlineInput: ({ sessionId, id, dataB64 }) => {
        // Feed keystrokes to the run's shell (only sent while the block's program
        // is the running foreground process).
        inlinePool.input(sessionId, id, fromB64(dataB64));
        return { ok: true };
      },
      terminalInput: ({ sessionId, dataB64 }) => {
        termFor(sessionId).term.write(fromB64(dataB64));
        return { ok: true };
      },
      terminalPaste: async ({ sessionId, text, language }) => {
        const t = termFor(sessionId);
        // A fenced block in an interpreted language cannot be pasted as-is —
        // zsh would run it as shell. Its runner line is pasted instead (same
        // runner as inline; the temp file is written here). Shell blocks keep
        // pasting their literal code: visible, editable, in shell history.
        let paste = text;
        if (language != null) {
          const spec = runnerFor(`term-${nextTermRunId++}`, language, text, settings.blocks.interpreters, process.execPath);
          if (spec.kind === "interpreter") {
            await Bun.write(spec.path, spec.contents);
            paste = spec.command;
          }
        }
        // Always queue, then try to release immediately. If the shell is idle at a
        // prompt the paste goes out now; if it is cold or mid-command it waits for
        // the next prompt, so pastes never echo raw or run out of order.
        t.pasteQueue.push(bracketedPaste(paste));
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
      sessionConfigure: ({ sessionId, params }) => {
        // Stored, not applied: spawnShell reads this when the session's next
        // shell starts. Values go nowhere but that spawn (see rpc-schema).
        sessionParams.set(sessionId, params);
        return { ok: true };
      },
      sessionRestart: ({ sessionId }) => {
        // The restart-applies escape hatch (see rpc-schema): kill the shells,
        // keep the params, and lazy respawn does the rest. The pool closes out
        // open runs through the same event path the drain loop uses.
        inlinePool.restartSession(sessionId, sendRunEvent);
        const t = terms.get(sessionId);
        if (t) {
          // Mirror the shell-exited teardown below: the drawer closes, and a
          // busy flag the view still holds is cleared — a dead shell runs
          // nothing.
          if (t.attached) rpc.send.terminalExit({ sessionId });
          if (t.sentBusy) rpc.send.terminalBusy({ sessionId, busy: false });
          t.term.close();
          terms.delete(sessionId);
        }
        return { ok: true };
      },
      // Both assert the profile name inside — anything that is not a plain
      // name throws before it can become a path (architecture.md §2).
      profileRead: async ({ name }) => ({ text: await readProfile(name) }),
      profileWrite: async ({ name, text }) => {
        await writeProfile(name, text);
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
      // Both guarded inside bun/assets.ts: assetRead's src passes assertions
      // (in-root, image extension, no dot-entries) before it is read, and
      // assetPaste names the file itself — the view supplies nothing.
      assetRead: async ({ src }) => ({ image: await readAsset(src) }),
      assetPaste: async () => ({ src: await pasteImageAsset() }),
      settingsGet: () => ({ settings }),
      // Session layout: raw bytes both ways; the view owns the shape and the
      // self-healing, Bun owns the file and the atomicity (bun/layout.ts).
      layoutGet: async () => ({ text: await readLayout() }),
      layoutSave: async ({ text }) => ({ ok: await writeLayout(text) }),
      settingsOpen: async () => {
        await openSettingsFile();
        return { ok: true };
      },
      // openableUrl is the guard here, not a convenience: `open` treats a
      // non-URL argument as a file path (and launches .app bundles), so only
      // the allowlisted schemes may pass. Re-checked on this side because the
      // view's check is styling and this one is the boundary — the same move
      // as assertProfileName above (architecture.md §2).
      linkOpen: async ({ url }) => {
        const target = openableUrl(url);
        if (!target) return { ok: false };
        try {
          Bun.spawn(["open", target]);
        } catch (err) {
          console.warn("[links] could not open", target, err);
          return { ok: false };
        }
        return { ok: true };
      },
    },
    messages: {},
  },
});

// Drain every live shell on a short interval. (poll()-gated reads never block;
// see pty.ts.) Inline shells are sliced into per-block events (block ids are
// globally unique, so the view routes each event to the editor that owns it with
// no per-note bookkeeping here); terminal shells stream raw to whichever drawer
// is attached to that note. Inline lifecycle — overflow teardown on a run's end,
// closing out the run of a shell that died mid-block — lives in the pool.
// One pool event -> one runEvent message. Shared by the drain loop and
// sessionRestart, which closes out open runs through the same path so the
// view cannot tell a restart-killed run from a shell that died on its own.
function sendRunEvent(ev: InlineEvent): void {
  if (ev.type === "began") {
    rpc.send.runEvent({ id: ev.blockId, kind: "began" });
  } else if (ev.type === "output") {
    rpc.send.runEvent({ id: ev.blockId, kind: "output", dataB64: toB64(ev.data) });
  } else {
    rpc.send.runEvent({ id: ev.blockId, kind: "ended", exitCode: ev.exitCode });
  }
}

setInterval(() => {
  inlinePool.drain(sendRunEvent);

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
        if (t.promptReady) t.everReady = true;
        flushPaste(t);
      }
      t.scanTail = scan.slice(-(BP_ENABLE.length - 1));
    }
    // Push busy on every tick, not just when bytes arrive: queueing a paste changes
    // it with no output at all, and the button has to gray out the moment it does.
    const busy = isBusy(t);
    if (busy !== t.sentBusy) {
      t.sentBusy = busy;
      rpc.send.terminalBusy({ sessionId, busy });
    }
    // The user typed `exit`: tear the shell down and tell the drawer to close.
    if (t.term.exited) {
      if (t.attached) rpc.send.terminalExit({ sessionId });
      // The shell is gone, so nothing is running on it. Without this the note's
      // terminal button would stay grayed out forever on a shell that died mid-job.
      if (busy) rpc.send.terminalBusy({ sessionId, busy: false });
      t.term.close();
      terms.delete(sessionId);
    }
  }
}, 8);

// Age old deletions out of the trash, once per launch. Deliberately not awaited:
// it is housekeeping, and the window should not wait on a folder scan to open.
// Doing it here rather than on a timer means a trashed note never disappears
// out from under a Trash section the user is looking at.
void purgeTrash(settings.trash.ttlDays * 24 * 60 * 60 * 1000)
  .then((n) => n > 0 && console.log(`[notes] purged ${n} trashed note(s) past the ${settings.trash.ttlDays}-day limit`))
  .catch((err) => console.error("[notes] trash purge failed", err));

const mainWindow = new BrowserWindow({
  title: "Ledge",
  url: await mainViewUrl(),
  rpc,
  frame: { width: 940, height: 700, x: 200, y: 120 },
});

process.on("exit", () => {
  inlinePool.closeAll();
  for (const t of terms.values()) t.term.close();
});

console.log("[bun] Ledge started (per-note shells, spawned on first use); notes root:", NOTES_ROOT);
void mainWindow;

