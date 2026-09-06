// The Ledge server: everything the app does to the machine, with no UI. This
// module owns the filesystem, the vault, the watchers, and the shells.
//
// Shells are per note, so a `cd` in one note never leaks into another. Each
// tab (keyed by its stable docId, `sessionId` on the wire) gets its own, run
// in this Bun process via the bun:ffi PTY and spawned on first use. Inline-run
// shells slice output per block with OSC 133 markers, and inlinePool.ts keeps
// a persistent one per note plus ephemeral overflow shells so blocks can run
// concurrently. The terminal-drawer shell is raw and drives xterm.js.
//
// It imports nothing from electrobun (remote.md §1), so the same handlers
// serve a webview in this process today and a socket tomorrow. The native
// seams it needs arrive as NativeDeps below, supplied by the entry point that
// starts it (index.ts, the Mac shell).
import { watch } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { PtyProcess } from "./pty";
import { InlinePool, type InlineEvent } from "./inlinePool";
import { takePaste } from "./paste";
import { readProfile, writeProfile } from "./profiles";
import type { ClientMethod } from "../shared/wire";
import type { RequestHandlers, ServerPush } from "../shared/wire";
import { folderScopeOf } from "../shared/folders";
import {
  backlinksTo,
  changeVaultPassphrase,
  createNote,
  deleteFolder,
  deleteNote,
  deleteTrashed,
  emptyTrash,
  firstLockedHeader,
  isNoteLocked,
  listNotes,
  listTrash,
  lockNote,
  moveNote,
  notesTagged,
  purgeTrash,
  readNote,
  removeLockNote,
  renameFolder,
  restoreNote,
  retitleNote,
  searchNotes,
  stashNote,
  tagsIn,
  writeNote,
} from "./notes";
import { configureVault, createVault, loadVault, lockVault, unlockVault, vaultState } from "./vault";
import {
  APP_HOME,
  assertRegisteredRoot,
  attachExternal,
  availableRoots,
  createManaged,
  detachRoot,
  ensureDefault,
  kindOf,
  listWorkspaceRoots,
  loadWorkspaces,
  moveRoot,
  rootContaining,
  roots,
} from "./workspaces";
import { createFromTemplatePath, openDaily, resolveConfiguredWorkspace } from "./daily";
import { syncDocs } from "./docs";
import { readLayout, writeLayout } from "./layout";
import { revealLog, write as writeLog } from "./log";
import { installShim, tildify } from "./cliShim";
import { OPEN_REQUEST_PATH, takeOpenRequest } from "./openRequest";
import { syncWatchers } from "./watch";
import { readAsset, writePastedImage } from "./assets";
import { bundledBun, interpretersFor, runnerFor } from "./runner";
import { loadSettings, readSettingsFile, writeSettingsFile } from "./settings";
import {
  isExecutableFile,
  resolveShellArgs,
  resolveSpawn,
  shellRefusal,
  stampSessionFacts,
  type SessionFacts,
  type SpawnDeps,
} from "./spawnParams";
import { buildRemoteSpawn } from "./remoteSpawn";
import { readFileSync, statSync } from "node:fs";
import { isHostName, LOCAL_HOST, type NoteParams } from "../shared/frontmatter";

// The one native seam the server still has. The pasteboard and the menu bar
// moved to the client (remote.md §10, bun/clientSeams.ts). The folder dialog
// could not follow: the folder it picks has to exist on the machine that will
// hold the notes, and a picker on the client would return a path from the
// wrong filesystem.
//
// The field is optional, and absent is not the same as failed. A server with no
// dialog says so (NO_DIALOG below) instead of returning what a cancelled dialog
// returns, which would leave a button that does nothing.
export interface NativeDeps {
  // The native folder picker, behind workspaceAttach/workspaceMove. Returns
  // null when the user cancelled.
  pickFolder?(startingFolder: string): Promise<string | null>;
}

/**
 * Who a push is for (remote.md §7).
 *
 * A server serves several clients at once, so every push site below picks
 * `all` or `to`. There is no group, and a client id is the only address. A
 * drawer's bytes belong to whoever is watching that drawer, and a block's
 * output to whoever ran the block.
 *
 * Routing belongs to the caller. bun/daemon.ts fans out over the connections
 * it holds, and bun/index.ts over the local windows attached to this machine's
 * server. Neither picks the audience, which follows from a session or a run
 * that only this module knows.
 */
export interface Audience {
  /** Every client connected right now. */
  all: ServerPush;
  /** One client, by the id from its hello. The push is dropped when that client
   * is not connected, like any push with nobody attached. */
  to(client: string): ServerPush;
  /** Whether that client is connected right now.
   *
   * Only run output needs the answer. Every other push describes state the next
   * connection re-reads at boot, so dropping it costs nothing. Run output is a
   * sequence with nowhere to re-read it from, so `sendRunEvent` asks here
   * before it pushes and holds what it cannot deliver. */
  has(client: string): boolean;
}

/** One client's share of the run output it missed (`missed` in createServer).
 * `bytes` counts output events only, since those are what the cap trims. */
export interface HeldRuns {
  events: InlineEvent[];
  bytes: number;
}

/**
 * Add one event to a client's gap, trimming to `cap` (SB_CAP, the same cap the
 * drawer's scrollback gets).
 *
 * Over the cap the oldest output goes and the `began` and `ended` markers
 * stay, since a run whose ending was trimmed sits on "Running" forever. A gap
 * longer than the cap arrives with its middle missing and its ending intact.
 * The newest chunk is never dropped, even when it alone is over the cap: a pty
 * read is bounded by its own buffer, so the overshoot is at most one of those.
 *
 * The panel appends this gap to the output it already shows. The drawer's ring
 * is the one replayed over a reset screen, and only because the server holds
 * the whole scrollback for it.
 */
export function holdRunEvent(held: HeldRuns, ev: InlineEvent, cap: number): void {
  held.events.push(ev);
  if (ev.type !== "output") return;
  held.bytes += ev.data.length;
  let chunks = held.events.reduce((n, e) => n + (e.type === "output" ? 1 : 0), 0);
  while (held.bytes > cap && chunks > 1) {
    const i = held.events.findIndex((e) => e.type === "output");
    const oldest = held.events[i];
    if (!oldest || oldest.type !== "output") break;
    held.bytes -= oldest.data.length;
    held.events.splice(i, 1);
    chunks--;
  }
}

// What the interpreter value "bun" means for a block that runs on this
// machine: the app's own runtime under Electrobun, and "" on a server, whose
// binary is a compiled program rather than a bun (runner.ts). Resolved once at
// module load, since it is a fact about this process.
const BUNDLED_BUN = bundledBun(process.execPath);

// The CLI entry a `ledge` shim would exec, beside this module. The app's
// build.copy puts dist-cli/cli.js next to index.js for that
// (electrobun.config.ts, cliShim.ts). A compiled `ledge-server` has no
// neighbour to find: `bun build --compile` embeds one program and the CLI is
// not it, so on a server this names a path inside /$bunfs that never existed.
// Answered once at load, since a file that shipped beside the binary does not
// appear later. The boot handshake reports the answer (workspaceList below).
const CLI_ENTRY = resolve(import.meta.dir, "cli.js");
const CAN_INSTALL_CLI = statSync(CLI_ENTRY, { throwIfNoEntry: false })?.isFile() === true;

// What workspaceAttach and workspaceMove answer with when there is no dialog
// to show. Data, not an exception: the schema gives both calls an `error`
// string so a refusal can reach the user as a sentence.
const NO_DIALOG =
  "A headless server cannot open a folder dialog. Attaching a folder needs the app running on the machine that holds the notes.";

// The same refusal for cliInstall, and it exists for the reason NO_DIALOG does.
// The palette leaves the verb out (mainview/lib/shell.ts), and anything that
// asks anyway gets a sentence instead of the shim's own "the CLI entry is
// missing at /$bunfs/root/cli.js", which is true and unhelpful.
const NO_CLI =
  "A server has no CLI to install. `ledge` ships with the app, so installing it needs the app running on the machine that holds the notes.";

// The other half of bun/clientSeams.ts: the same names, refusing. Typed as the
// full Pick, so adding a name there without adding it here does not compile.
// The two lists cannot drift into a hole where a call reaches a server with no
// implementation and no refusal either.
function clientSeamRefusals(): Pick<RequestHandlers, ClientMethod> {
  const refuse = (name: ClientMethod) => (): never => {
    throw new Error(`${name} is the client's, not the server's (remote.md §10)`);
  };
  return {
    clipboardRead: refuse("clipboardRead"),
    clipboardWrite: refuse("clipboardWrite"),
    clipboardReadRich: refuse("clipboardReadRich"),
    assetPaste: refuse("assetPaste"),
    assetPick: refuse("assetPick"),
    linkOpen: refuse("linkOpen"),
    menuSet: refuse("menuSet"),
    windowNew: refuse("windowNew"),
    windowDocs: refuse("windowDocs"),
    windowRole: refuse("windowRole"),
    connectionList: refuse("connectionList"),
    connectionSelect: refuse("connectionSelect"),
    connectionReconnect: refuse("connectionReconnect"),
    connectionAdd: refuse("connectionAdd"),
    connectionUpdate: refuse("connectionUpdate"),
    connectionRemove: refuse("connectionRemove"),
    connectionProbe: refuse("connectionProbe"),
  };
}

export interface LedgeServer {
  /**
   * The protocol's handlers, as they answer for one client.
   *
   * Almost none of them differ, since a note is a note whoever asked for it.
   * The few that do are the ones where answering for the wrong client is
   * silent damage: which layout to load, which runs to collect, whose run this
   * is, whose drawer that is. The id comes from the connection's handshake and
   * is fixed for that connection's life (remote.md §5), so it is bound once
   * here rather than passed at each call. A caller holding one client's map
   * cannot ask it for another client's answer.
   */
  forClient(client: string): RequestHandlers;
  /** Whether anything is mid-job: a block running, or a drawer's shell inside
   * a command. The daemon asks when its last client goes away (remote.md §7).
   * A run keeps the process alive; an idle prompt does not. */
  running(): boolean;
  /** Whether any session exists to hold: a note's inline shell or a drawer's,
   * at a prompt or not. The daemon asks this one instead when the client that
   * left declared a session hold (remote.md §7). A client that is coming back
   * wants the shell's cwd and exported variables; a client that is not gains
   * nothing from them. */
  sessionsOpen(): boolean;
  // Tear down every shell. The caller owns the process-exit hook, because it
  // usually has its own last-moment work (the shell saves the window frame).
  shutdown(): void;
}

// The cap logAppend truncates the view's text to. The view's failures land in
// the same log file as Bun's, and the view chooses what is worth sending
// (mainview/lib/log.ts). A blank pane after a render error is the one crash a
// Bun-side log cannot see.
const LOG_TEXT_CAP = 8000;

// The nonce carried by the OSC 133 markers, fresh per process and never written
// into a note, so a block cannot forge its own end marker (markers.ts).
const NONCE = Math.random().toString(36).slice(2) + Date.now().toString(36);

// --- terminal-drawer shell state -------------------------------------------
// A separate, plain interactive session per note with no marker protocol. Its
// raw byte stream drives xterm.js in the view, and the view's keystrokes and
// resizes come back over the RPC. Spawned on the note's first terminalAttach.
//
// Scrollback: a note's terminal keeps printing (its prompt, background output)
// while the drawer is closed or showing another note, so each one keeps a
// capped rolling buffer of its raw output that terminalAttach replays. `owner`
// gates live streaming only. Bytes accumulate while nobody has the drawer.
// Attaching replays the full history, so a client that takes the drawer off
// another one still gets everything it missed.
const SB_CAP = 256 * 1024;
// zsh toggles bracketed-paste mode around every prompt cycle. It emits
// BP_ENABLE (CSI ? 2004 h) when its line editor is ready for input, and
// BP_DISABLE (2004 l) the moment a foreground command starts running. A
// bracketed paste is interpreted only while the mode is enabled. Sent at any
// other time (a cold shell, or mid command) the markers echo raw as `^[[200~`
// noise and the text runs out of order. So terminalPaste queues pastes, and the
// drain loop tracks the mode in `promptReady` from these two sequences and
// releases one paste per prompt.
const BP_ENABLE = "\x1b[?2004h";
const BP_DISABLE = "\x1b[?2004l";

// The drain loop's two cadences (the loop itself is below, in createServer).
// A pty is polled rather than waited on. Nothing wakes the event loop when a
// shell has bytes, so the tick is the read, and its period is the latency of
// everything a shell says. 8ms is a frame at 120Hz, well under the ~50ms at
// which an echoed keystroke starts to feel late, and the rate remote.md §3's
// output coalescing is written against.
const DRAIN_FAST_MS = 8;
// Where the cadence settles when nothing is happening. A tick fixed at
// DRAIN_FAST_MS runs for the life of the process whether or not a shell
// exists, asking idle shells whether they have said anything. On a desktop
// that is invisible. On a daemon running for weeks (remote.md §11) it costs
// about 1% of a core, measured in §3. Backing off delays output nobody
// asked for after a long silence, such as a background job's first line, and
// nothing else: a person's own keystroke wakes the loop first (`wake`). 100ms
// still reads as instant.
const DRAIN_IDLE_MS = 100;
// How long everything must stay quiet before backing off. Longer than the gap
// between keystrokes at any typing speed, so a pause to think mid-command does
// not drop the cadence and delay the next character's echo.
const DRAIN_SETTLE_MS = 2_000;
interface Term {
  term: PtyProcess;
  // The machine this shell lives on (LOCAL_HOST or an ssh destination), fixed
  // at spawn. Pastes build their runner lines for it, and the drawer's badge
  // shows it. Changing it takes a restart, the same contract as every other
  // spawn param.
  host: string;
  // Whose drawer this is, and null for nobody. A client id rather than the
  // boolean it was, because a server with several clients has to know which
  // one to push a shell's bytes at. Null rather than "", because the empty
  // string is a client id like any other (the anonymous bucket, wire.ts
  // `Hello.client`).
  //
  // The one owner decides three things: where the output goes, whose
  // keystrokes the shell accepts, and whose window sets its winsize. They are
  // one field because a client typing into a shell whose bytes land on another
  // screen is typing blind, and a second window sizing the pty reflows the
  // first one's screen. Any client takes ownership by attaching, and attaching
  // never fails. The client that loses it gets a `terminalDetached` push
  // rather than silence. Ownership outlives a connection, because a client id
  // does (remote.md §7), so a phone that re-dials still owns the drawer it had.
  owner: string | null;
  chunks: Uint8Array[];
  len: number;
  // Bracketed-paste sequencing. `promptReady` mirrors the shell's current mode,
  // true only at an idle prompt. Pastes wait in `pasteQueue` and go out one at
  // a time, each on a fresh prompt, so queued commands never stack up inside
  // one command's run. `scanTail` carries the last few output bytes across
  // drain ticks, so a toggle sequence split across a read boundary still
  // matches.
  promptReady: boolean;
  pasteQueue: string[];
  scanTail: string;
  // When the shell last said anything, and 0 while it has said nothing at all.
  // The fallback prompt signal for shells with no bracketed-paste mode
  // (bun/paste.ts `takePaste`, its second rule).
  lastOut: number;
  // Whether the shell has ever announced a prompt. `promptReady` is false for
  // two reasons: a job is running, or the shell has not printed its first
  // prompt yet. Only the first counts as busy, so the drawer's button stays
  // usable for the few ms a cold shell takes to come up.
  everReady: boolean;
  // Last busy state pushed to the view, so the drain loop only sends on a change.
  sentBusy: boolean;
}

// A shell is busy when it cannot take a block right now: something is running, or
// pastes are already waiting on the prompt behind it.
function isBusy(t: Term): boolean {
  return t.everReady && (!t.promptReady || t.pasteQueue.length > 0);
}

const toB64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const fromB64 = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));

/**
 * Load the machine's state and return the protocol's handlers.
 *
 * The awaits below are the boot order. The workspace registry loads first,
 * because every note path guard consults it. `ensureDefault` guarantees there
 * is always a folder to put a note in. `syncDocs` fills the docs root that
 * load registered, before the first noteList can arrive. `loadVault` lands the
 * salt, so vaultState answers "locked" vs "none" from the first call.
 */
export async function createServer(deps: { push: Audience; native: NativeDeps }): Promise<LedgeServer> {
  const { push, native } = deps;

  // loadSettings parses settings.jsonc once, and this value serves for the
  // life of the process. Everything below reads it: the shell, the block
  // interpreters, the daily workspace, the trash TTL at the bottom, and the
  // view's snapshot via settingsGet. Editing settings.jsonc takes effect at
  // the next launch (architecture.md §6).
  const settings = await loadSettings();

  await loadWorkspaces();
  await ensureDefault();
  await syncDocs();

  // The vault (note locking): salt and passphrase-check loaded so vaultState
  // answers "locked" vs "none" from boot; the master key only ever arrives
  // through vaultUnlock.
  await loadVault();

  const shellEnv = { ...process.env, TERM: "xterm-256color" } as Record<string, string>;

  // Per-session spawn parameters, as the view parsed them from each note's
  // frontmatter (sessionConfigure). Read at spawn, never applied to a running
  // shell: a shell keeps the cwd and env it started with, and an edited
  // frontmatter takes effect on the session's next shell. That is the same
  // restart-applies policy as settings above, and rpc-schema.ts
  // sessionConfigure states the contract. closeSession clears the entry, since
  // the params describe a live tab rather than a note file.
  const sessionParams = new Map<string, NoteParams>();

  // The session's validated location facts (spawnParams.ts stampSessionFacts).
  // Kept beside sessionParams rather than inside it: those params are what the
  // note said, these are what Bun has checked. sessionConfigure's notePath is
  // admitted here only once it proves to be a real .md inside a registered
  // root, the same re-validation the profile name gets in spawnParams.ts and
  // for the same reason (architecture.md §2).
  const sessionFacts = new Map<string, SessionFacts>();

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

  // The machine a spawn or run actually gets, from the view's request and the
  // hosts the note's frontmatter declared. The declared list is the allowlist:
  // the view is the least-trusted end (architecture.md §2) and its host picker
  // is only UI. An undeclared or malformed request warns and falls back to the
  // note's first host, never to another machine. With no request the
  // frontmatter decides: its single declared host, or local when it declares
  // none. So a note saying `host: prod` targets prod through every path,
  // whether or not the view says so.
  function resolveHost(sessionId: string, requested: string | null | undefined): string {
    const declared = sessionParams.get(sessionId)?.hosts ?? [];
    const fallback = declared[0] ?? LOCAL_HOST;
    if (requested == null) return fallback;
    const allowed =
      requested === LOCAL_HOST
        ? declared.length === 0 || declared.includes(LOCAL_HOST)
        : isHostName(requested) && declared.includes(requested);
    if (!allowed) {
      console.warn(`[session] host "${requested}" is not declared by this note; using "${fallback}"`);
      return fallback;
    }
    return requested;
  }

  // Every shell a session gets (persistent inline, overflow, terminal drawer)
  // spawns through here, so all of them read the note's params the same way.
  // The lookup happens at spawn: an overflow shell spawned after a frontmatter
  // edit gets the new params while the persistent shell keeps its old ones.
  // That is the restart-applies contract from another angle.
  //
  // `host` has already been through resolveHost, and it forks the spawn rather
  // than the pty. A remote shell is ssh as the pty's child
  // (bun/remoteSpawn.ts), spawned with the base env in $HOME. The note's cwd
  // and env travel inside the ssh command to the machine they describe, so the
  // local resolution (profile files, cwd stat) does not run.
  function spawnShell(sessionId: string, host: string, kind: "inline" | "terminal"): PtyProcess {
    if (host !== LOCAL_HOST) {
      const remote = buildRemoteSpawn(host, kind, sessionParams.get(sessionId), (msg) =>
        console.warn("[session]", msg),
      );
      return new PtyProcess({
        executable: remote.executable,
        args: remote.args,
        env: shellEnv,
        cwd: homedir(),
        // The pty's child is ssh, not the shell whose block is running (pty.ts).
        interruptViaChar: true,
      });
    }
    const { cwd, env } = resolveSpawn(sessionParams.get(sessionId), shellEnv, spawnDeps);
    // Local spawns only: on a remote host the note's local path names nothing.
    stampSessionFacts(env, sessionFacts.get(sessionId) ?? null);
    // Check the configured shell before the fork, because after it there is
    // nobody to tell. The trampoline execs in the child
    // (dist-native/ledge_pty.c), so a missing shell returns a healthy pid and
    // then `_exit(127)`, leaving the block with no output, no error and no
    // exit code. Throwing here reaches the client as an `err` frame the block
    // can show instead (bun/transport.ts dispatch). This refuses rather than
    // substituting another shell, unlike resolveSpawn, which falls back to
    // $HOME when the note's cwd is missing.
    const refusal = shellRefusal(settings.shell.path, isExecutableFile);
    if (refusal) throw new Error(refusal);
    return new PtyProcess({
      executable: settings.shell.path,
      // Not the configured args verbatim: a zsh spawns with comments enabled so
      // a block's `#` lines mean the same thing pasted into the drawer as they
      // do sourced inline (spawnParams.ts).
      args: resolveShellArgs(settings.shell.path, settings.shell.args),
      env,
      cwd,
    });
  }

  // --- per-note inline-run shells -------------------------------------------
  // Block bodies are sourced into shells with OSC 133 markers so output can be
  // sliced per block. inlinePool.ts owns the policy: a persistent shell per
  // note, spawned on its first runBlock, so cwd and env carry across blocks,
  // plus an ephemeral overflow shell for each additional concurrent run.
  const inlinePool = new InlinePool((sessionId, host) => spawnShell(sessionId, host, "inline"), NONCE);

  const terms = new Map<string, Term>();
  // Names the temp files behind interpreted blocks pasted to the terminal
  // (inline runs use the view's block id instead; see runBlock).
  let nextTermRunId = 1;
  // `requestedHost` matters only when this call is the one that spawns. A live
  // shell's host is fixed at spawn.
  function termFor(sessionId: string, requestedHost?: string | null): Term {
    let t = terms.get(sessionId);
    if (!t) {
      const host = resolveHost(sessionId, requestedHost);
      t = {
        term: spawnShell(sessionId, host, "terminal"),
        host,
        owner: null,
        chunks: [],
        len: 0,
        promptReady: false,
        pasteQueue: [],
        scanTail: "",
        lastOut: 0,
        everReady: false,
        sentBusy: false,
      };
      terms.set(sessionId, t);
      // The only place a drawer's shell is spawned, so the only place the
      // drain loop has to be woken for one. A cold shell's first prompt is
      // output nobody typed for, and the loop may have been idling.
      wake();
    }
    return t;
  }

  // Write whatever the paste policy says may go now (bun/paste.ts owns which of
  // the two formats, and when).
  function flushPaste(t: Term, now = Date.now()): void {
    const out = takePaste(t, now);
    if (out !== null) t.term.write(out);
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

  // Whether the note this session sits in is locked, read from disk on every
  // call. A lock that lands mid-session therefore refuses the very next run.
  // A session with no admitted note fact has no lock to enforce: it is not a
  // note's session, so it cannot be a locked note's.
  async function sessionNoteLocked(sessionId: string): Promise<boolean> {
    const fact = sessionFacts.get(sessionId);
    if (!fact) return false;
    try {
      return await isNoteLocked(fact.note);
    } catch {
      return false; // the note moved/vanished: nothing locked to protect
    }
  }

  // Tear down all of a note's shells when its tab closes.
  function closeSession(sessionId: string): void {
    inlinePool.closeSession(sessionId);
    terms.get(sessionId)?.term.close();
    terms.delete(sessionId);
    sessionParams.delete(sessionId);
    sessionFacts.delete(sessionId);
  }

  // Watch every available root for changes made outside the app (agents in the
  // drawer, git, plain shell edits) and push notesChanged, so the view can
  // re-read lists and reload clean open buffers. This trails the registry: the
  // workspace handlers below re-sync on every attach, create and detach, and
  // an unavailable root is not watched until a sync finds it again
  // (bun/watch.ts owns the skip-and-warn).
  function refreshWatchers(): void {
    // To everyone: a file that moved moved for every client, and a client that
    // is not told holds a stale note list until something else touches that
    // root.
    syncWatchers(availableRoots(), (root) => push.all.notesChanged({ root }));
  }

  // Watch the app home for the CLI's open request (`ledge <title>` with the
  // app already running; bun/openRequest.ts). Its own watcher rather than one
  // of syncWatchers': roots and the app home have different lifecycles, and
  // this one is non-recursive and filters to a single filename.
  // takeOpenRequest consumes the file and re-validates the path, so the
  // watcher decides nothing. A null take (invalid, stale, or this process's
  // own unlink echoing back) is silent. The watcher does not start at launch.
  // The view's first openRequestTake starts it, closing the boot race
  // described at that handler below. A failure here is not fatal: that boot
  // pull still serves the app-was-closed flow.
  let openRequestWatcherStarted = false;
  function startOpenRequestWatcher(): void {
    if (openRequestWatcherStarted) return;
    openRequestWatcherStarted = true;
    try {
      const requestName = basename(OPEN_REQUEST_PATH);
      watch(APP_HOME, (_event, filename) => {
        if (filename !== requestName) return;
        void takeOpenRequest().then((open) => {
          // To everyone, because the request names a note and not a screen. It
          // was typed at that machine's own shell, which knows nothing about
          // who is connected. Picking one client would be a guess, and a wrong
          // guess leaves `ledge notes` doing nothing visible. Opening it on
          // every client costs an extra tab instead.
          if (open !== null) push.all.openExternal(open);
        });
      });
    } catch (err) {
      console.warn("[cli] could not watch the app home for open requests:", err);
    }
  }

  /**
   * A run's output, kept for a client that was not connected to receive it
   * (remote.md §7).
   *
   * The one push worth holding rather than dropping. Every other push
   * describes a state the next connection re-reads at boot: the note list, the
   * presence list, the vault. Run output is a sequence with nowhere to re-read
   * it from, since the shell emitted it once, at a connection that had gone.
   *
   * Held per client, in one order across all of that client's runs, which is
   * the order the shell emitted them in. Two runs interleaving is a fact about
   * what happened, and a queue per run would replay them as two blocks.
   */
  const missed = new Map<string, HeldRuns>();

  function hold(ev: InlineEvent, client: string): void {
    let held = missed.get(client);
    if (!held) {
      held = { events: [], bytes: 0 };
      missed.set(client, held);
    }
    holdRunEvent(held, ev, SB_CAP);
  }

  /**
   * Send the held events, in order, to a client that is asking (inlineClaim).
   *
   * The entry is deleted before the sends, because sendRunEvent re-holds
   * anything it finds in `missed`. Leaving it in place would put these events
   * straight back, and the buffer would never empty.
   *
   * That also makes an interrupted release lossless. A wire that dies partway
   * through puts the remainder back, in order, under a fresh entry, and the
   * next claim picks up where this one stopped.
   */
  function release(client: string): void {
    const held = missed.get(client);
    missed.delete(client);
    if (!held) return;
    for (const ev of held.events) sendRunEvent(ev, client);
  }

  // One pool event becomes one runEvent message. Shared by the drain loop and
  // sessionRestart, which closes out open runs through the same path, so the
  // view cannot tell a restart-killed run from a shell that exited on its own.
  //
  // Sent to the client that started the run and to no other. A run event is
  // keyed by a run id, and only the panel that minted that id can act on it.
  // Elsewhere it describes a block that is not on screen.
  function sendRunEvent(ev: InlineEvent, client: string): void {
    // Held rather than dropped when the client is not connected, and still
    // held after it comes back until `inlineClaim` releases them (see
    // `missed`).
    if (!push.has(client) || missed.has(client)) {
      hold(ev, client);
      return;
    }
    const to = push.to(client);
    if (ev.type === "began") {
      to.runEvent({ id: ev.blockId, kind: "began" });
    } else if (ev.type === "output") {
      to.runEvent({ id: ev.blockId, kind: "output", dataB64: toB64(ev.data) });
    } else {
      to.runEvent({ id: ev.blockId, kind: "ended", exitCode: ev.exitCode });
    }
  }

  // Built per connection, so the client's id is in scope wherever a handler
  // needs it. The alternative, one shared map plus a small second one for the
  // handlers that differ, moves six handlers away from the neighbours that
  // explain them. It saves sixty closures per client on a path that runs once
  // per connection.
  const requestsFor = (client: string): RequestHandlers => ({
    // --- workspaces --------------------------------------------------------
    // The registry lives server-side (workspaces.ts): the view only ever
    // passes back roots it was handed. The one way an arbitrary folder gets
    // in is the native dialog below, never a view-supplied path.
    workspaceList: () => ({
      workspaces: listWorkspaceRoots(),
      dailyRoot: resolveConfiguredWorkspace(settings.daily.workspace, roots()),
      // The same condition the two verbs below check before refusing.
      // Reported once at boot so the view can leave them out of the palette,
      // rather than have the user run one and get NO_DIALOG back.
      folderDialog: !!native.pickFolder,
      // The same for Install Shell Command: a server can only ever refuse it
      // (CLI_ENTRY above).
      cliShim: CAN_INSTALL_CLI,
    }),
    workspaceCreate: async ({ name }) => {
      const root = await createManaged(name);
      refreshWatchers();
      return { root };
    },
    workspaceAttach: async () => {
      if (!native.pickFolder) return { root: null, kind: null, error: NO_DIALOG };
      const picked = await native.pickFolder(homedir());
      if (!picked) return { root: null, kind: null, error: null }; // cancelled
      const res = await attachExternal(picked);
      if ("error" in res) return { root: null, kind: null, error: res.error };
      refreshWatchers();
      // Never "docs": attachExternal refuses the docs folder before the
      // idempotent-attach answer, so the cast below is safe.
      return { root: res.root, kind: kindOf(res.root) as "managed" | "external", error: null };
    },
    workspaceDetach: async ({ root }) => {
      const ok = await detachRoot(root);
      refreshWatchers();
      return { ok };
    },
    workspaceMove: async ({ root, home }) => {
      const from = assertRegisteredRoot(root);
      // `home` moves the folder into APP_HOME with no dialog (the schema
      // comment says why). Otherwise the same dialog as workspaceAttach
      // above. The pick is the destination parent the folder moves into.
      let picked: string | null;
      if (home) picked = APP_HOME;
      else if (native.pickFolder) picked = await native.pickFolder(homedir());
      else return { root: null, kind: null, error: NO_DIALOG };
      if (!picked) return { root: null, kind: null, error: null }; // cancelled
      const res = await moveRoot(from, picked);
      if ("error" in res) return { root: null, kind: null, error: res.error };
      refreshWatchers();
      // Never "docs": moveRoot refuses the docs root outright, and no
      // destination can become it. The docs folder sits inside the app home,
      // and invalidRootReason bars anything there that is not managed.
      return { root: res.root, kind: kindOf(res.root) as "managed" | "external", error: null };
    },

    // --- note store --------------------------------------------------------
    // Every path these take is checked against the registered workspace
    // roots inside notes.ts, so a compromised or buggy client cannot read or
    // write outside the folders the user chose.
    noteList: async ({ root }) => ({ notes: await listNotes(root) }),
    noteRead: async ({ path }) => ({ note: await readNote(path) }),
    // The guard and the divergence-to-trash live in writeNote (notes.ts).
    // This only reports. A non-null divergedTo is logged server-side too,
    // because the view's console is invisible in the shipped app.
    noteWrite: async ({ path, text, baseMtimeMs }) => {
      const res = await writeNote(path, text, baseMtimeMs);
      if (res.divergedTo) console.warn("[notes] external edit preserved in trash:", res.divergedTo, "(save to", path, "won)");
      return res;
    },
    noteCreate: async ({ root, text, folder }) => ({ note: await createNote(root, text, folder) }),
    noteMove: async ({ path, folder }) => ({ note: await moveNote(path, folder) }),
    folderRename: ({ root, folder, name }) => renameFolder(root, folder, name),
    folderDelete: ({ root, folder }) => deleteFolder(root, folder),
    noteRetitle: async ({ path, text }) => ({ note: await retitleNote(path, text) }),
    // The daily.workspace setting outranks the view's selected workspace,
    // which is only the fallback. daily.folder says where inside it, and
    // matters only on the day the note is created: an existing one is found
    // by title wherever it sits, so changing the setting does not move notes
    // already filed. The response is shaped as an external open, so the
    // view's one workspace-select-then-open path handles it (schema comment).
    dailyOpen: async ({ root }) => {
      const target = resolveConfiguredWorkspace(settings.daily.workspace, roots()) ?? assertRegisteredRoot(root);
      const { meta, created } = await openDaily(target, settings.daily.folder || null);
      return { open: { ...meta, root: target }, created };
    },
    noteFromTemplate: async ({ root, templatePath, title }) => ({
      note: await createFromTemplatePath(root, templatePath, title),
    }),
    noteDelete: async ({ path }) => ({ trashed: await deleteNote(path) }),
    // Logged for the same reason as writeNote above: a stash means someone's
    // typing did not become the note, and the view's console is invisible in
    // the shipped app.
    noteStash: async ({ path, text }) => {
      const stashed = await stashNote(path, text);
      console.warn("[notes] unsaved edit preserved in trash:", stashed, "(the server's copy of", path, "won)");
      return { stashed };
    },
    // The scans return their lockedSkipped counts themselves (notes.ts
    // decides the skip; locking.md §4). These handlers are passthroughs.
    // `folder` narrows a scan to one folder; absent (and every older client)
    // means the whole workspace. folderScopeOf trims and normalizes only, and
    // guards nothing: a folder selects among listed notes, never a path.
    noteSearch: async ({ root, query, folder }) => searchNotes(root, query, folderScopeOf(folder)),
    // backlinksTo derives the root from the path and guards it itself
    // (assertNote), so the view sends only the path.
    noteBacklinks: async ({ path }) => backlinksTo(path),
    tagList: async ({ root, folder }) => tagsIn(root, folderScopeOf(folder)),
    tagNotes: async ({ root, tag }) => notesTagged(root, tag),

    // --- the vault (note locking) -----------------------------------------
    vaultState: () => ({ state: vaultState() }),
    vaultCreate: async ({ passphrase }) => {
      try {
        await createVault(passphrase);
      } catch (err) {
        console.warn("[vault] create refused:", err);
        return { ok: false };
      }
      push.all.vaultChanged({ state: vaultState() });
      return { ok: true };
    },
    vaultUnlock: async ({ passphrase }) => {
      // With no vault file but locked notes on disk (synced from another
      // machine), a locked note's own self-contained header is the check.
      const probe = vaultState() === "none" ? await firstLockedHeader(availableRoots()) : undefined;
      const ok = await unlockVault(passphrase, probe);
      if (ok) push.all.vaultChanged({ state: vaultState() });
      return { ok };
    },
    vaultLock: () => {
      // The view flushed dirty locked buffers before asking (⌘L's contract).
      // All the server drops here is keys.
      lockVault();
      push.all.vaultChanged({ state: vaultState() });
      return { ok: true };
    },
    noteLock: async ({ path }) => {
      const res = await lockNote(path);
      return { note: res.meta, sealedShared: res.sealedShared };
    },
    noteRemoveLock: async ({ path }) => ({ note: await removeLockNote(path) }),
    vaultChangePassphrase: async ({ passphrase }) => {
      try {
        const rewrapped = await changeVaultPassphrase(passphrase, availableRoots());
        return { ok: true, rewrapped };
      } catch (err) {
        console.warn("[vault] passphrase change refused:", err);
        return { ok: false, rewrapped: 0 };
      }
    },
    trashList: async ({ root }) => ({ items: await listTrash(root) }),
    trashRestore: async ({ path }) => ({ note: await restoreNote(path) }),
    trashDelete: async ({ path }) => ({ removed: await deleteTrashed(path) }),
    trashEmpty: async ({ root }) => ({ removed: await emptyTrash(root) }),

    runBlock: async ({ sessionId, id, code, language, host }) => {
      // A ```prompt fence pipes its body to the agent CLI, so in a locked
      // note it does not run: the send-direction half of the no-agents
      // invariant (locking.md §8). Re-validated here whatever the view asked,
      // because the view's disabled buttons are the UI and this is the guard.
      // Scoped to `prompt`: other fences are the user's own compute.
      if (language === "prompt" && (await sessionNoteLocked(sessionId))) {
        console.warn("[vault] refused a prompt-fence run in a locked note (session", sessionId + ")");
        return { accepted: false };
      }
      // The block body goes to a file instead of onto the command line. That
      // sidesteps quoting, heredocs, and line continuations. How the file runs
      // is the language's business (runner.ts). Shell blocks are sourced into
      // the note's persistent shell, so cwd and env changes carry across its
      // blocks. A run started while that shell is busy gets an overflow shell
      // instead, discarded when the run ends (inlinePool.ts). Other languages
      // exec their interpreter on the file. BUNDLED_BUN backs the "bun"
      // interpreter for TypeScript, and is "" on a server with no bun to
      // bundle.
      //
      // A remote run writes no local file: the file belongs on the target
      // machine, and the runner's command carries the body there in-band.
      const target = resolveHost(sessionId, host);
      // interpretersFor, not the bare map: the target machine may override
      // per-language commands (blocks.hostInterpreters).
      const spec = runnerFor(
        id,
        language,
        code,
        interpretersFor(target, settings.blocks),
        BUNDLED_BUN,
        target !== LOCAL_HOST,
      );
      if (!spec.remote) await Bun.write(spec.path, spec.contents);
      inlinePool.run(sessionId, id, spec.command, { client, host: target });
      wake();
      return { accepted: true };
    },
    cancelRun: ({ sessionId, id }) => {
      // SIGINT whatever the run's shell is executing, from outside the tty. A
      // signal rather than a 0x03 byte: 0x03 becomes SIGINT only while the tty
      // is in canonical mode, so a program in raw mode (a REPL, vim, claude)
      // reads the byte as input and keeps going. This path cancels those.
      //
      // The signal goes to the tty's foreground process group, which the
      // shell's job control gives the running job (PtyProcess.interrupt). zsh
      // is not in that group and ignores SIGINT, so the persistent shell keeps
      // its cwd and env for the note's next block. The run ends on the D marker
      // its precmd hook prints when the prompt returns.
      inlinePool.cancel(sessionId, id);
      wake();
      return { ok: true };
    },
    inlineResize: ({ sessionId, id, cols, rows }) => {
      // Resize the run's shell so block output renders at the grid the view
      // shows. A resize that arrives before its runBlock (the panel fits
      // itself the moment it renders) is stashed by the pool and applied when
      // the run picks its shell.
      inlinePool.resize(sessionId, id, cols, rows);
      wake();
      return { ok: true };
    },
    inlineInput: ({ sessionId, id, dataB64 }) => {
      // Feed keystrokes to the run's shell (only sent while the block's program
      // is the running foreground process).
      inlinePool.input(sessionId, id, fromB64(dataB64));
      wake();
      return { ok: true };
    },
    inlineClaim: ({ ids }) => {
      // Everything this client missed, ahead of the answer and in the order it
      // was produced (see `missed`). The held events go first because an
      // `ended` may be among them. A run that finished during the outage then
      // arrives with its real exit code and last output, instead of being
      // closed out blank by the reconciliation below.
      release(client);
      // The client's runs, reconciled with this server's (see rpc-schema).
      // Nothing here is per session: a reloaded page has no sessions yet, and
      // the orphans it asks about span every note it had open before. It is
      // per client, though: only this client's runs are in scope, since the
      // server may be carrying another client's (inlinePool.claim).
      const { running, orphaned } = inlinePool.claim(client, ids);
      if (orphaned.length > 0) {
        console.warn(`[run] interrupted ${orphaned.length} run(s) no client can show:`, orphaned.join(", "));
      }
      return { running, orphaned: orphaned.length };
    },
    // Keystrokes, from the client that owns the drawer and no other. A client
    // that lost the drawer shows a stale terminal until it renders the notice
    // it was pushed, and a focused window keeps producing keystrokes all the
    // while. Those must not reach a shell whose output the typist can no
    // longer see. Refused rather than queued: they were typed at a screen that
    // has since changed.
    //
    // Never spawns, unlike every other call that takes a sessionId: input for
    // a shell that does not exist has nothing to continue.
    terminalInput: ({ sessionId, dataB64 }) => {
      const t = terms.get(sessionId);
      if (!t || t.owner !== client) return { ok: false };
      t.term.write(fromB64(dataB64));
      wake();
      return { ok: true };
    },
    // Open to any client, unlike the input and resize around it. A paste says
    // "run this block in the note's shell", a fact about the note, and it is
    // the same shell every client's Run buttons already reach through
    // runBlock. It is also all but unobservable: the view opens the drawer
    // before it pastes, and opening the drawer makes that client the owner.
    terminalPaste: async ({ sessionId, text, language, host }) => {
      // The prompt-fence refusal again, in the drawer's direction (see
      // runBlock). A prompt block pasted to the drawer sends the same locked
      // body to the same agent CLI, one shell over.
      if (language === "prompt" && (await sessionNoteLocked(sessionId))) {
        console.warn("[vault] refused a prompt-fence paste in a locked note (session", sessionId + ")");
        return { ok: false };
      }
      const t = termFor(sessionId, host);
      // A block in an interpreted language cannot be pasted as-is: zsh would
      // run it as shell. Its runner line is pasted instead (same runner as
      // inline; the temp file is written here). Shell blocks still paste
      // their literal code: visible, editable, in shell history. The runner
      // is built for the drawer's host, not the request's, so a remote drawer
      // is never pasted a local temp path.
      let paste = text;
      if (language != null) {
        const spec = runnerFor(
          `term-${nextTermRunId++}`,
          language,
          text,
          interpretersFor(t.host, settings.blocks),
          BUNDLED_BUN,
          t.host !== LOCAL_HOST,
        );
        if (spec.kind === "interpreter") {
          if (!spec.remote) await Bun.write(spec.path, spec.contents);
          paste = spec.command;
        }
      }
      // Always queue, then try to release immediately. A shell idle at a
      // prompt takes the paste now; a cold or busy one takes it at the next
      // prompt, so pastes never echo raw or run out of order. Queued raw,
      // because whether it goes out bracketed depends on what the shell has
      // reported about itself, and that can change after the queue (paste.ts).
      t.pasteQueue.push(paste);
      flushPaste(t);
      wake();
      return { ok: true };
    },
    // The winsize follows the drawer's owner, like the bytes: one pty has one
    // grid, and a second client's fit would reflow the screen the owner is
    // reading. Owner-only, and never a spawn: the drawer's first resize used to
    // arrive ahead of its attach and spawn the shell itself, throwing away the
    // host the picker chose (resolveHost falls back to the note's first host).
    terminalResize: ({ sessionId, cols, rows }) => {
      const t = terms.get(sessionId);
      if (!t || t.owner !== client) return { ok: false };
      t.term.resize(cols, rows);
      wake();
      return { ok: true };
    },
    // Lazily spawns the note's terminal shell on first attach. Synchronous so
    // no drain tick can interleave between the snapshot and enabling live
    // streaming: the snapshot is everything up to now, live is everything
    // after, with no gap or overlap.
    terminalAttach: ({ sessionId, host }) => {
      const t = termFor(sessionId, host);
      // Attaching takes the drawer. It never fails and never asks: the whole
      // scrollback comes back with it, so the taker has the shell's history on
      // screen the moment it arrives. The client it was taken from is told, so
      // its drawer can say why it stopped printing (interactions.md §4-2).
      const lost = t.owner;
      t.owner = client;
      // `by` is this client's id. The client that lost the drawer turns it
      // into a name through the presence list it already holds (rpc-schema
      // `presence`). The server sends the id and not the label, because the
      // label is a fact about a device and belongs to the list of who is
      // connected.
      if (lost !== null && lost !== client) push.to(lost).terminalDetached({ sessionId, by: client });
      return { dataB64: toB64(sbSnapshot(t)), host: t.host };
    },
    terminalDetach: ({ sessionId }) => {
      const t = terms.get(sessionId);
      // Only this client's own drawer. Without the check, closing a drawer on
      // the phone would stop the bytes reaching the Mac that has the same note
      // open, and the Mac would have no way to know why its terminal went
      // quiet. Nobody is pushed anything: the owner left on its own, and no
      // other client is watching this drawer.
      if (t && t.owner === client) t.owner = null;
      return { ok: true };
    },
    terminalStatus: ({ sessionId }) => {
      const t = terms.get(sessionId);
      return { live: !!t, host: t?.host ?? null };
    },
    // What an already-open drawer missed while its client was unreachable
    // (rpc-schema terminalClaim). Not termFor: this spawns nothing, and a
    // session with no shell answers "gone" rather than becoming a reason to
    // make one.
    terminalClaim: ({ sessionId }) => {
      const t = terms.get(sessionId);
      if (!t) return { state: "gone" };
      // Another client attached while this one was away. Its
      // `terminalDetached` was pushed at a connection that had already gone,
      // so this answer is that push arriving late. Taking the shell back here
      // would pull it off a device somebody chose to move it to.
      if (t.owner !== null && t.owner !== client) return { state: "held", by: t.owner };
      // Still this client's, since owner is a client id and outlives the
      // connection it was set on. Null means nobody holds it, and a drawer
      // that is open and asking gets the same answer. Setting owner here is
      // what starts the bytes flowing to it again.
      t.owner = client;
      return { state: "attached", dataB64: toB64(sbSnapshot(t)), host: t.host };
    },
    // closeSession and sessionRestart are open to any client, not just the
    // drawer's owner. Both act on the note rather than on whose screen the
    // drawer is on. A phone closing a note it has open should not be refused
    // because the Mac holds that note's drawer, and Restart Note Shell applies
    // the frontmatter the person just edited.
    closeSession: ({ sessionId }) => {
      closeSession(sessionId);
      return { ok: true };
    },
    sessionConfigure: ({ sessionId, params, notePath }) => {
      // Stored, not applied: spawnShell reads this when the session's next
      // shell starts. Values go nowhere but that spawn (see rpc-schema).
      sessionParams.set(sessionId, params);
      const root = notePath !== null && /\.md$/i.test(notePath) ? rootContaining(notePath) : null;
      if (root) sessionFacts.set(sessionId, { note: resolve(notePath!), workspace: root });
      else sessionFacts.delete(sessionId);
      return { ok: true };
    },
    sessionRestart: ({ sessionId }) => {
      // The restart-applies escape hatch (see rpc-schema): kill the shells,
      // keep the params, and lazy respawn does the rest. The pool closes out
      // open runs through the same event path the drain loop uses.
      inlinePool.restartSession(sessionId, sendRunEvent);
      wake();
      const t = terms.get(sessionId);
      if (t) {
        // Mirror the shell-exited teardown below: the drawer closes, and a
        // busy flag the view still holds is cleared. A dead shell runs
        // nothing.
        if (t.owner !== null) push.to(t.owner).terminalExit({ sessionId });
        if (t.sentBusy) push.all.terminalBusy({ sessionId, busy: false });
        t.term.close();
        terms.delete(sessionId);
      }
      return { ok: true };
    },
    // Both assert the profile name inside bun/profiles.ts. Anything that is
    // not a plain name throws before it can become a path (architecture.md
    // §2).
    profileRead: async ({ name }) => ({ text: await readProfile(name) }),
    profileWrite: async ({ name, text }) => {
      await writeProfile(name, text);
      return { ok: true };
    },
    // Both guarded inside bun/assets.ts: the root must be registered, and the
    // src passes assertions (in-root, image extension, no dot-entries) before
    // it is read. assetWrite names the file itself, so the client supplies
    // nothing but bytes and handles it was given.
    assetRead: async ({ root, src, notePath }) => {
      const res = await readAsset(root, src, notePath);
      if (res !== null && "sealed" in res) return { image: null, sealed: true };
      return { image: res };
    },
    // The bytes arrive from whichever machine the pasteboard is on
    // (remote.md §10), and everything about the file is decided here. The note
    // decides two things and the sender neither: whether the paste is sealed
    // (the server asks the disk whether the note is locked) and which folder
    // the returned reference is relative to. A notePath outside the pasting
    // root is a client bug. It is dropped rather than trusted, which costs a
    // root-relative reference and the seal.
    assetWrite: async ({ root, notePath, dataB64 }) => {
      const from =
        typeof notePath === "string" && notePath !== "" && rootContaining(notePath) === assertRegisteredRoot(root)
          ? notePath
          : null;
      const seal = from !== null && (await isNoteLocked(from));
      return { src: await writePastedImage(root, fromB64(dataB64), seal, from) };
    },
    // This machine's half of the snapshot. A connected client merges its own
    // half over the top before the view sees it (remote.md §5). A server has
    // no screen and nothing to say about font sizes, so the sections it does
    // not own are the defaults here.
    settingsGet: () => ({ settings }),
    // Session layout, raw bytes both ways. The view owns the shape and the
    // self-healing; the server owns the file, the atomic write, and which
    // client's arrangement this is (bun/layout.ts). The client id comes from
    // the connection and never from the call, so the view never learns it is
    // one of several possible screens (remote.md §5).
    layoutGet: async () => ({ text: await readLayout(client) }),
    layoutSave: async ({ text }) => ({ ok: await writeLayout(client, text) }),
    // Raw settings.jsonc text for the ⌘, editor dialog. The write is atomic
    // and ungated (rpc-schema.ts settingsRead says why). Restart-applies still
    // holds: a save does not touch the running `settings` snapshot above.
    //
    // Only this machine's file. `home: "client"` is answered by the client
    // shell and never arrives here. A server reaching its own client home
    // would edit the wrong screen's font size, or on a headless one a file
    // nobody has ever seen.
    settingsRead: async ({ home }) => {
      if (home !== "server") throw new Error(`the ${home} settings file is not this server's (remote.md §5)`);
      return { text: await readSettingsFile() };
    },
    settingsWrite: async ({ home, text }) => {
      if (home !== "server") throw new Error(`the ${home} settings file is not this server's (remote.md §5)`);
      await writeSettingsFile(text);
      return { ok: true };
    },
    // The CLI installer, from the app side. The entry is cli.js beside this
    // module in the bundle (build.copy in electrobun.config.ts puts it there)
    // and execPath is the bundle's own bun: the exact pair the shim will exec
    // (bun/cliShim.ts). The message is composed here because the landing dir,
    // the PATH verdict, and any failure are server-side facts. A machine with
    // no such pair refuses with NO_CLI. The view already leaves the verb out
    // (workspaceList's `cliShim`), so a call arriving here asked anyway.
    cliInstall: async () => {
      if (!CAN_INSTALL_CLI) return { ok: false, message: NO_CLI };
      try {
        const res = await installShim({
          execPath: process.execPath,
          entryPath: CLI_ENTRY,
          pathVar: process.env["PATH"] ?? "",
        });
        return {
          ok: true,
          message: res.onPath
            ? `ledge installed: ${tildify(res.path)}`
            : `ledge installed: ${tildify(res.path)} — its folder is not on your PATH yet`,
        };
      } catch (err) {
        return { ok: false, message: `Install failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
    // The cold-start half of `ledge <title>`: the view pulls once at boot,
    // after its subscriber wiring is up. Consume-and-validate lives in
    // bun/openRequest.ts, shared with the app-home watcher. The watcher starts
    // only after this first pull (startOpenRequestWatcher above). Started at
    // launch it is alive seconds before the webview can hear a push, so it
    // would consume a request whose push then lands on nobody (the live probe
    // caught that). Deferring it leaves a mid-boot request in the file for
    // this pull to find.
    openRequestTake: async () => {
      const open = await takeOpenRequest();
      startOpenRequestWatcher();
      return { open };
    },
    // Bun stamps the source and level and caps the length. The view's text is
    // the only part it contributes (rpc-schema.ts logAppend).
    logAppend: async ({ level, text }) => {
      writeLog("view", level, [text.slice(0, LOG_TEXT_CAP)]);
      return { ok: true };
    },
    logReveal: async () => ({ ok: revealLog() }),
    // The pasteboard, the browser, the menu bar, and the list of servers this
    // app knows about all belong to whoever is looking at the screen. The
    // client shell serves them itself and they never reach a server
    // (bun/clientSeams.ts, remote.md §8 and §10). These entries exist because
    // the handler map is total, and they throw rather than answer: reaching
    // one means a client forgot its overlay, and an empty string back from a
    // clipboard read would look like an empty clipboard.
    //
    // Last in the object, because a spread wins over the keys above it. A
    // handler re-added up there then surfaces as a refusal someone has to
    // delete, rather than as a server that quietly answers.
    ...clientSeamRefusals(),
  });

  refreshWatchers();

  // Auto-relock (idle) pushes the same vaultChanged the explicit paths do. The
  // view cannot tell why the vault locked, only that it did, so it has one
  // eviction path instead of two.
  configureVault({ onAutoLock: () => push.all.vaultChanged({ state: vaultState() }) });

  // Drain every live shell on a short interval. (poll()-gated reads never
  // block; see pty.ts.) Inline shells are sliced into per-block events. Block
  // ids are globally unique, so the view routes each event to the editor that
  // owns it and this loop keeps no per-note bookkeeping. Terminal shells
  // stream raw to the client that owns that note's drawer. Inline lifecycle
  // lives in the pool: overflow teardown on a run's end, and closing out the
  // run of a shell that died mid-block.
  //
  // The cadence runs at DRAIN_FAST_MS while bytes are moving and backs off to
  // DRAIN_IDLE_MS once everything has been quiet for DRAIN_SETTLE_MS
  // (remote.md §3). Every path that writes to a shell or spawns one calls
  // `wake` below first. A missed wake site costs one late tick and nothing
  // else, since bytes turning up set `lastBusyAt` by themselves.
  //
  // The timer is only ever slowed, never cleared. It is what holds the event
  // loop open in this process, and vault.ts's housekeeping unrefs its own
  // timer and leans on this one (architecture.md §1). Whether a daemon with no
  // shells should still be alive is the idle exit's question rather than this
  // loop's (daemon.ts).
  let cadence = 0;
  let drain: ReturnType<typeof setInterval> | null = null;
  let lastBusyAt = 0;

  function pace(ms: number): void {
    if (ms === cadence) return;
    cadence = ms;
    if (drain) clearInterval(drain);
    drain = setInterval(drainTick, ms);
  }

  /** Something is about to happen on a shell: carry the fast cadence into it. */
  function wake(): void {
    lastBusyAt = Date.now();
    pace(DRAIN_FAST_MS);
  }

  function drainTick(): void {
    // Bytes moving, or waiting to move. A paste the tty has not taken yet
    // (pty.ts `pending`) and a paste still queued for a prompt are both work
    // in flight that no output would otherwise announce. An echo-less password
    // prompt is when that matters.
    let awake = inlinePool.drain(sendRunEvent) || inlinePool.pending();

    const now = Date.now();
    for (const [sessionId, t] of terms) {
      const termData = t.term.drain();
      if (t.term.pending || t.pasteQueue.length > 0) awake = true;
      if (termData) {
        awake = true;
        t.lastOut = now;
        sbPush(t, termData);
        if (t.owner !== null) push.to(t.owner).terminalOutput({ sessionId, dataB64: toB64(termData) });
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
        }
        t.scanTail = scan.slice(-(BP_ENABLE.length - 1));
      }
      // After the scan, and every tick rather than only on output. The prompt a
      // paste is waiting for arrives as bytes, but a shell that never announces
      // bracketed-paste mode is released by a quiet period instead (paste.ts).
      flushPaste(t, now);
      // Push busy on every tick, not just when bytes arrive: queueing a paste
      // changes it with no output at all, and the button has to gray out the
      // moment it does.
      //
      // To everyone, unlike the two pushes around it. Busy is a fact about the
      // note's shell rather than about the drawer, so it grays out the terminal
      // button on any client with that note open, watching the bytes or not. A
      // client that has never heard of the session files it under an id it does
      // not use (mainview/editor/bridge.ts).
      const busy = isBusy(t);
      if (busy !== t.sentBusy) {
        t.sentBusy = busy;
        push.all.terminalBusy({ sessionId, busy });
      }
      // The user typed `exit`: tear the shell down and tell the drawer to close.
      if (t.term.exited) {
        if (t.owner !== null) push.to(t.owner).terminalExit({ sessionId });
        // The shell is gone, so nothing is running on it. Without this the note's
        // terminal button would stay grayed out forever on a shell that died mid-job.
        if (busy) push.all.terminalBusy({ sessionId, busy: false });
        t.term.close();
        terms.delete(sessionId);
      }
    }

    if (awake) lastBusyAt = now;
    pace(now - lastBusyAt < DRAIN_SETTLE_MS ? DRAIN_FAST_MS : DRAIN_IDLE_MS);
  }

  wake();

  // Age old deletions out of every available workspace's trash, once per
  // launch. Not awaited: it is housekeeping, and the window should not wait on
  // folder scans to open. Once per launch rather than on a timer, so a trashed
  // note never vanishes from under a Trash section someone is looking at.
  // Unavailable roots are skipped: an unmounted volume keeps its trashed notes.
  void Promise.all(availableRoots().map((root) => purgeTrash(root, settings.trash.ttlDays * 24 * 60 * 60 * 1000)))
    .then((ns) => {
      const n = ns.reduce((a, b) => a + b, 0);
      if (n > 0) console.log(`[notes] purged ${n} trashed note(s) past the ${settings.trash.ttlDays}-day limit`);
    })
    .catch((err) => console.error("[notes] trash purge failed", err));

  return {
    forClient: requestsFor,
    // isBusy, not "a shell exists". A note's terminal drawer keeps its zsh
    // sitting at a prompt for as long as the tab is open, and that is not work
    // in progress.
    running: () => inlinePool.running() || [...terms.values()].some(isBusy),
    // Every shell, busy or not: a drawer's shell counts by existing rather
    // than by isBusy. A zsh sitting at a prompt is what a hold is for, and it
    // is what `running` above ignores.
    sessionsOpen: () => inlinePool.sessionsOpen() || terms.size > 0,
    shutdown() {
      if (drain) clearInterval(drain);
      inlinePool.closeAll();
      for (const t of terms.values()) t.term.close();
    },
  };
}
