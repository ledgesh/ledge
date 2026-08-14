// The Ledge server: everything the app does to the machine, with no UI.
//
// This module owns the filesystem, the vault, the watchers, and the shells.
// Shells are per note: each tab (keyed by its stable docId, `sessionId` on the
// wire) gets its own, run in this Bun process via the bun:ffi PTY and spawned
// lazily on first use. Inline-run shells (a persistent one per note, plus
// ephemeral overflow shells so blocks can run concurrently; inlinePool.ts)
// slice block output per block via OSC 133 markers; the terminal-drawer shell
// is raw, driving xterm.js. Keeping them per note means a `cd` in one note
// never leaks into another.
//
// It imports nothing from electrobun, which is the point (remote.md §1): the
// same handlers serve a webview in this process today and a socket tomorrow.
// The native seams it genuinely needs arrive as NativeDeps below, and the
// entry point that starts it (index.ts, the Mac shell) supplies them.
import { watch } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { PtyProcess } from "./pty";
import { InlinePool, type InlineEvent } from "./inlinePool";
import { takePaste } from "./paste";
import { readProfile, writeProfile } from "./profiles";
import type { ClientMethod } from "../shared/wire";
import type { RequestHandlers, ServerPush } from "../shared/wire";
import {
  backlinksTo,
  changeVaultPassphrase,
  createNote,
  deleteNote,
  deleteTrashed,
  emptyTrash,
  firstLockedHeader,
  isNoteLocked,
  listNotes,
  listTrash,
  lockNote,
  notesTagged,
  purgeTrash,
  readNote,
  removeLockNote,
  restoreNote,
  retitleNote,
  searchNotes,
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
import { resolveShellArgs, resolveSpawn, stampSessionFacts, type SessionFacts, type SpawnDeps } from "./spawnParams";
import { buildRemoteSpawn } from "./remoteSpawn";
import { readFileSync, statSync } from "node:fs";
import { isHostName, LOCAL_HOST, type NoteParams } from "../shared/frontmatter";

// The one native seam the server still has. The pasteboard and the menu bar
// left with remote.md §10 (bun/clientSeams.ts); the folder dialog could not
// follow them, because the folder it picks has to exist on the machine that
// will hold the notes — a picker on the client would return a path from the
// wrong filesystem.
//
// OPTIONAL, and absent is a different thing from failed: a server with no
// dialog says so (see NO_DIALOG below), rather than returning the answer a
// cancelled dialog gives and leaving a button that quietly does nothing.
export interface NativeDeps {
  // The native folder picker, behind workspaceAttach/workspaceMove. Returns
  // null when the user cancelled.
  pickFolder?(startingFolder: string): Promise<string | null>;
}

/**
 * Who a push is for (remote.md §7).
 *
 * A server serves several clients at once, so "send this" is no longer a
 * complete instruction: a drawer's bytes belong to whoever is watching that
 * drawer, and a block's output to whoever ran the block. Every push site below
 * therefore says which, and the two words are the whole vocabulary — there is
 * no group, and nothing is addressed by anything but a client id.
 *
 * The routing itself is the caller's: bun/daemon.ts fans out over the
 * connections it is holding, bun/index.ts hands both to the one window on this
 * Mac. Neither can decide WHO, because who is a fact about a session or a run
 * and this module is the only thing that knows it.
 */
export interface Audience {
  /** Every client connected right now. */
  all: ServerPush;
  /** One client, by the id from its hello. Dropped if it is not here, the same
   * as a push with nobody attached at all has always been. */
  to(client: string): ServerPush;
}

// What the interpreter value "bun" means for a block that runs on THIS
// machine: the app's own runtime under Electrobun, and nothing on a server,
// whose binary is a compiled program rather than a bun (runner.ts). Resolved
// once, at module load, because it is a fact about this process.
const BUNDLED_BUN = bundledBun(process.execPath);

// The CLI entry a `ledge` shim would exec, beside this module: the app's
// build.copy puts dist-cli/cli.js next to index.js for exactly that
// (electrobun.config.ts, cliShim.ts). A compiled `ledge-server` has no
// neighbour to find — `bun build --compile` embeds one program and the CLI is
// not it — so on a server this is a path inside /$bunfs that never existed.
// Answered once at load, because a file that shipped beside the binary does
// not appear later, and the boot handshake reports it (workspaceList below).
const CLI_ENTRY = resolve(import.meta.dir, "cli.js");
const CAN_INSTALL_CLI = statSync(CLI_ENTRY, { throwIfNoEntry: false })?.isFile() === true;

// What workspaceAttach and workspaceMove answer with when there is no dialog
// to show. Data, not an exception: the schema gives both calls an `error`
// string precisely so a refusal can reach the user as a sentence.
const NO_DIALOG =
  "A headless server cannot open a folder dialog. Attaching a folder needs the app running on the machine that holds the notes.";

// The same sentence-shaped refusal for cliInstall, and it exists for the same
// reason NO_DIALOG does: the palette leaves the verb out (mainview/lib/shell.ts),
// and anything that asks anyway gets a reason instead of the shim's own
// "the CLI entry is missing at /$bunfs/root/cli.js", which is true and useless.
const NO_CLI =
  "A server has no CLI to install. `ledge` ships with the app, so installing it needs the app running on the machine that holds the notes.";

// The other half of bun/clientSeams.ts: the same names, refusing. Typed as the
// full Pick, so adding a name there without adding it here does not compile —
// the two lists cannot drift into a hole where a call reaches a server that
// has no implementation and no refusal either.
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
    connectionList: refuse("connectionList"),
    connectionSelect: refuse("connectionSelect"),
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
   * Almost none of them differ — a note is a note whoever asked for it — but
   * the handful that do are the ones where answering for the wrong client is
   * silent damage: which layout to load, which runs to collect, whose run this
   * is, whose drawer that is. The id comes from the connection's handshake and
   * is fixed for its life (remote.md §5), so it is bound once here rather than
   * read at each call: a caller that has the wrong map cannot ask for the right
   * answer, which is the point.
   */
  forClient(client: string): RequestHandlers;
  /** Whether anything is mid-job: a block running, or a drawer's shell inside
   * a command. Asked by the daemon when its last client goes away (remote.md
   * §7) — a run keeps going, an idle prompt is not worth a process. */
  running(): boolean;
  /** Whether any session exists to hold: a note's inline shell or a drawer's,
   * at a prompt or not. The daemon asks this instead when the client that left
   * declared a session hold — an idle shell is worth nothing to a client that
   * is not coming back, and worth its cwd and its exported variables to one
   * that said it is (remote.md §7). */
  sessionsOpen(): boolean;
  // Tear down every shell. The caller owns the process-exit hook, because it
  // usually has its own last-moment work (the shell saves the window frame).
  shutdown(): void;
}

// The view's failures land in the same file, by its own choice of what is
// worth sending (mainview/lib/log.ts) — a blank pane after a render error is
// the one crash a Bun-side log cannot see.
const LOG_TEXT_CAP = 8000;

// Fresh per session, never written into a note, so a block cannot forge its own
// end marker (see markers.ts).
const NONCE = Math.random().toString(36).slice(2) + Date.now().toString(36);

// --- terminal-drawer shell state -------------------------------------------
// A separate, plain interactive session per note with no marker protocol. Its raw
// byte stream drives xterm.js in the view; the view's keystrokes and resizes come
// back over the RPC. Spawned on the note's first terminalAttach.
//
// Scrollback: a note's terminal keeps printing (its prompt, background output)
// while the drawer is closed or showing another note, so each keeps a capped
// rolling buffer of its raw output that terminalAttach replays. `owner` gates
// live streaming: bytes still accumulate while nobody has the drawer, so
// attaching replays the full history — which is also what makes taking a drawer
// off another client harmless (the taker gets everything it missed).
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
  // The machine this shell lives on (LOCAL_HOST or an ssh destination), fixed
  // at spawn: pastes build their runner lines for it, and the drawer's badge
  // shows it. Moving means a restart — same contract as every other spawn
  // param.
  host: string;
  // Whose drawer this is, and null for nobody. A client id rather than the
  // boolean it was, because a server with several clients has to know WHICH one
  // to push a shell's bytes at; null rather than "" because the empty string is
  // a client id like any other (the anonymous bucket, wire.ts `Hello.client`).
  //
  // ONE OWNER, and it decides three things at once: where the output goes, whose
  // keystrokes the shell accepts, and whose window sets its winsize. They are one
  // field because they are one question — a client typing into a shell whose
  // bytes land on another screen is typing blind, and a second window sizing the
  // pty reflows the first one's screen. Taking it is a client attaching, which is
  // allowed from anywhere and always succeeds; what the loser gets is a
  // `terminalDetached` push rather than silence (remote.md §7).
  //
  // It outlives connections, because a client id does: a phone that drops the
  // wire and re-dials still owns the drawer it had, which is what makes the
  // reconnect invisible rather than a fight over the shell.
  owner: string | null;
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
  // When the shell last said anything, and 0 while it has said nothing at all.
  // The fallback prompt signal for shells with no bracketed-paste mode; see
  // flushPasteQuiet.
  lastOut: number;
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

const toB64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const fromB64 = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));

/**
 * Load the machine's state and return the protocol's handlers.
 *
 * The awaits here are the boot order, and it is load-bearing: the workspace
 * registry is loaded before any request can be served (every note path guard
 * consults it), the default guarantees there is always a folder to put a note
 * in, the built-in docs sync after the load that registered their root and
 * before the first noteList can arrive, and the vault's salt lands so
 * vaultState answers "locked" vs "none" from the first call.
 */
export async function createServer(deps: { push: Audience; native: NativeDeps }): Promise<LedgeServer> {
  const { push, native } = deps;

  // Read once, applied for the life of the process: the shell below, the trash
  // TTL at the bottom, and the view's snapshot via settingsGet. Edits to
  // settings.jsonc take effect at the next launch (architecture.md, "Settings").
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
  // frontmatter (sessionConfigure). Read at shell SPAWN, never applied to a
  // running shell: a shell keeps the cwd/env it was born with, and an edited
  // frontmatter takes effect on the session's next shell (restart-applies —
  // same policy as settings, and the rpc-schema comment is the contract).
  // Cleared with the session in closeSession: the params describe a live tab,
  // not a note file, so they share its lifetime exactly.
  const sessionParams = new Map<string, NoteParams>();

  // The session's validated location facts (spawnParams.ts stampSessionFacts).
  // Kept beside sessionParams, not inside it: params are what the NOTE said,
  // this is what LEDGE knows — sessionConfigure's notePath is only admitted
  // here once it proves to be a real .md inside a registered root, the same
  // re-validation move as the profile name and for the same reason (the view's
  // path was honest when it sent it; this check is what makes it a fact).
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

  // The machine a spawn or run actually gets, from what the view asked for and
  // what the note's frontmatter DECLARED. The declared list is the allowlist
  // (architecture.md §2: the client is the least-trusted end, and the picker is
  // only its UI): an undeclared or malformed request falls back to the note's
  // own first host — never silently to some other machine — with a warning.
  // No request at all means the frontmatter decides: the single declared host,
  // or local for the note that declares none, so a note saying `host: prod`
  // targets prod through every path whether or not the view says so.
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

  // Every shell a session gets — persistent inline, overflow, terminal drawer —
  // spawns through here, so all of them read the note's params the same way.
  // The lookup happens AT spawn: an overflow shell spawned after a frontmatter
  // edit gets the new params while the persistent shell keeps its old ones,
  // which is just the restart-applies contract seen from another angle.
  //
  // `host` (already through resolveHost) forks the spawn, not the pty: a remote
  // shell is ssh as the pty's child (bun/remoteSpawn.ts), spawned with the BASE
  // env in $HOME — the note's cwd/env travel inside the ssh command to the
  // machine they are about, and the local resolution (profile files, cwd stat)
  // deliberately does not run.
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
  // sliced per block. The pool owns the whole policy — a persistent shell per note
  // (spawned on its first runBlock) so cwd/env carry across blocks, plus an
  // ephemeral overflow shell per additional concurrent run; see inlinePool.ts.
  const inlinePool = new InlinePool((sessionId, host) => spawnShell(sessionId, host, "inline"), NONCE);

  const terms = new Map<string, Term>();
  // Names the temp files behind interpreted blocks pasted to the terminal
  // (inline runs use the view's block id instead; see runBlock).
  let nextTermRunId = 1;
  // `requestedHost` matters only when this call is the one that spawns; a live
  // shell's host is fixed at its birth.
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

  // Whether the note this session sits in is locked, per the DISK (the head
  // read is live, so a lock landing mid-session refuses the very next run).
  // No admitted note fact means no lock to enforce: a session that is not a
  // note's cannot be a locked note's.
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

  // Watch every available root for changes made behind the app's back (agents in
  // the drawer, git, plain shell edits) and push notesChanged so the view can
  // re-read lists and reload clean open buffers. Trails the registry: the
  // workspace handlers below re-sync on every attach/create/detach, and an
  // unavailable root simply is not watched until a sync finds it back
  // (bun/watch.ts owns the skip-and-warn).
  function refreshWatchers(): void {
    // To everyone: a file that moved moved for every client, and a note list
    // nobody told about it is stale until something else happens to that root.
    syncWatchers(availableRoots(), (root) => push.all.notesChanged({ root }));
  }

  // Watch the app home for the CLI's open request (`ledge <title>` with the
  // app already running; bun/openRequest.ts). Non-recursive and its own
  // watcher, not one of syncWatchers': roots and the app home have different
  // lifecycles, and this one filters to a single filename. takeOpenRequest
  // consumes the file and re-validates the path, so the watcher itself decides
  // nothing; a null take (invalid, stale, or our own unlink echoing) is silent.
  // NOT started at launch: the view's first openRequestTake starts it (see the
  // handler below for the boot race this closes). Best-effort like every
  // watcher: on failure that boot pull still serves the app-was-closed flow.
  let openRequestWatcherStarted = false;
  function startOpenRequestWatcher(): void {
    if (openRequestWatcherStarted) return;
    openRequestWatcherStarted = true;
    try {
      const requestName = basename(OPEN_REQUEST_PATH);
      watch(APP_HOME, (_event, filename) => {
        if (filename !== requestName) return;
        void takeOpenRequest().then((open) => {
          // To everyone, because the request names a note and not a screen: it
          // was typed at that machine's own shell, which knows nothing about
          // who is connected. Picking one client would be guessing which device
          // the person is holding, and guessing wrong means `ledge notes` doing
          // nothing visible at all. Guessing is also unnecessary — the cost of
          // opening it everywhere is a tab on a device you are not looking at.
          if (open !== null) push.all.openExternal(open);
        });
      });
    } catch (err) {
      console.warn("[cli] could not watch the app home for open requests:", err);
    }
  }

  // One pool event -> one runEvent message. Shared by the drain loop and
  // sessionRestart, which closes out open runs through the same path so the
  // view cannot tell a restart-killed run from a shell that died on its own.
  //
  // To the client that started the run and to nobody else: a run event is keyed
  // by a run id, and the only thing that can do anything with that id is the
  // panel that minted it. Anywhere else it is an event about a block that is
  // not on screen.
  function sendRunEvent(ev: InlineEvent, client: string): void {
    const to = push.to(client);
    if (ev.type === "began") {
      to.runEvent({ id: ev.blockId, kind: "began" });
    } else if (ev.type === "output") {
      to.runEvent({ id: ev.blockId, kind: "output", dataB64: toB64(ev.data) });
    } else {
      to.runEvent({ id: ev.blockId, kind: "ended", exitCode: ev.exitCode });
    }
  }

  // Built per connection, so the client's id is simply in scope wherever a
  // handler needs it. The alternative — one shared map plus a small second one
  // for the handlers that differ — would move six handlers away from the
  // neighbours that explain them, to save sixty closures per client on a path
  // that runs once per connection.
  const requestsFor = (client: string): RequestHandlers => ({
    // --- workspaces --------------------------------------------------------
    // The registry lives server-side (workspaces.ts): the view only ever passes
    // back roots it was handed, and the one way an arbitrary folder gets in
    // is the native dialog below — never a view-supplied path.
    workspaceList: () => ({
      workspaces: listWorkspaceRoots(),
      dailyRoot: resolveConfiguredWorkspace(settings.daily.workspace, roots()),
      // The same condition the two verbs below check before refusing. Reported
      // once at boot so the view can leave them out of the palette instead:
      // NO_DIALOG is a good sentence to read and a bad one to discover by
      // running the only verb that looked like it would help.
      folderDialog: !!native.pickFolder,
      // And the same trade for Install Shell Command, whose refusal a server
      // could only ever answer with (CLI_ENTRY above).
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
      // idempotent-attach answer, so the narrowing is a fact, not a hope.
      return { root: res.root, kind: kindOf(res.root) as "managed" | "external", error: null };
    },
    workspaceDetach: async ({ root }) => {
      const ok = await detachRoot(root);
      refreshWatchers();
      return { ok };
    },
    workspaceMove: async ({ root, home }) => {
      const from = assertRegisteredRoot(root);
      // home: the destination is APP_HOME, no dialog (the schema comment
      // says why). Otherwise the same dialog as workspaceAttach above; the
      // pick is the destination PARENT the folder moves into.
      let picked: string | null;
      if (home) picked = APP_HOME;
      else if (native.pickFolder) picked = await native.pickFolder(homedir());
      else return { root: null, kind: null, error: NO_DIALOG };
      if (!picked) return { root: null, kind: null, error: null }; // cancelled
      const res = await moveRoot(from, picked);
      if ("error" in res) return { root: null, kind: null, error: res.error };
      refreshWatchers();
      // Never "docs": moveRoot refuses the docs root outright, and a move
      // destination cannot become it (its parent is the app home, which
      // invalidRootReason already bars).
      return { root: res.root, kind: kindOf(res.root) as "managed" | "external", error: null };
    },

    // --- note store --------------------------------------------------------
    // Every path these take is checked against the registered workspace
    // roots inside notes.ts, so a compromised or buggy client cannot read or
    // write outside the folders the user chose.
    noteList: async ({ root }) => ({ notes: await listNotes(root) }),
    noteRead: async ({ path }) => ({ note: await readNote(path) }),
    // The guard and the divergence-to-trash live in writeNote (notes.ts);
    // this only reports. divergedTo non-null is worth a log line server-side
    // too: the view's console is invisible in the shipped app.
    noteWrite: async ({ path, text, baseMtimeMs }) => {
      const res = await writeNote(path, text, baseMtimeMs);
      if (res.divergedTo) console.warn("[notes] external edit preserved in trash:", res.divergedTo, "(save to", path, "won)");
      return res;
    },
    noteCreate: async ({ root, text }) => ({ note: await createNote(root, text) }),
    noteRetitle: async ({ path, text }) => ({ note: await retitleNote(path, text) }),
    // The daily.workspace setting outranks the view's selected workspace
    // (that is the knob's whole job: pin where daily notes live); the
    // selected one is the deixis fallback. The response is shaped as an
    // external open so the view's one workspace-select-then-open path
    // handles it (see the schema comment).
    dailyOpen: async ({ root }) => {
      const target = resolveConfiguredWorkspace(settings.daily.workspace, roots()) ?? assertRegisteredRoot(root);
      const { meta, created } = await openDaily(target);
      return { open: { ...meta, root: target }, created };
    },
    noteFromTemplate: async ({ root, templatePath, title }) => ({
      note: await createFromTemplatePath(root, templatePath, title),
    }),
    noteDelete: async ({ path }) => ({ trashed: await deleteNote(path) }),
    // The scans return their lockedSkipped counts themselves (notes.ts
    // decides the skip; locking.md §4) — these are passthroughs.
    noteSearch: async ({ root, query }) => searchNotes(root, query),
    // backlinksTo derives and guards the root itself (assertNote), the
    // per-note-call stance: the view sends only the path.
    noteBacklinks: async ({ path }) => backlinksTo(path),
    tagList: async ({ root }) => tagsIn(root),
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
      // The view flushed dirty locked buffers before asking (⌘L's
      // contract); all the server drops here is keys.
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
      // A ```prompt fence's whole contract is "pipe this body to the agent
      // CLI", so in a locked note it does not run — the send-direction half
      // of the no-agents invariant (locking.md §8). Re-validated here
      // whatever the view asked (the two-ended move: its hidden buttons are
      // the UI, this is the guard). Scoped to the `prompt` language: other
      // fences are the user's own compute.
      if (language === "prompt" && (await sessionNoteLocked(sessionId))) {
        console.warn("[vault] refused a prompt-fence run in a locked note (session", sessionId + ")");
        return { accepted: false };
      }
      // The block body goes to a file, rather than being inlined into the
      // command line. That sidesteps quoting, heredocs, and line continuations.
      // What runs the file is the language's business (runner.ts): shell blocks
      // are sourced so cwd/env changes carry across blocks within the note (its
      // persistent shell is reused; a run started while it is busy gets an
      // overflow shell whose state dies with the run — inlinePool.ts), other
      // languages exec their interpreter on it. BUNDLED_BUN is what backs the
      // "bun" interpreter for TypeScript, and is "" on a server that has no
      // bun to bundle.
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
    inlineClaim: ({ ids }) => {
      // The client's runs, reconciled with this server's (see rpc-schema).
      // Nothing here is per session: a reloaded page has no sessions yet
      // either, and the orphans it is asking about are spread across every
      // note it had open before. It IS per client, though, and only this
      // client's runs are in scope — the server may be carrying somebody
      // else's (inlinePool.claim).
      const { running, orphaned } = inlinePool.claim(client, ids);
      if (orphaned.length > 0) {
        console.warn(`[run] interrupted ${orphaned.length} run(s) no client can show:`, orphaned.join(", "));
      }
      return { running, orphaned: orphaned.length };
    },
    // Keystrokes, from the client that owns the drawer and no other. A client
    // that lost the shell has a stale terminal on screen until it renders the
    // notice it was pushed, and a window with focus in it goes on producing
    // keystrokes the whole time; those must not reach a shell whose output the
    // typist can no longer see. Refused rather than queued: the keystrokes were
    // aimed at a screen that has moved on.
    //
    // Never spawns, unlike every other call that takes a sessionId: input for a
    // shell that does not exist has nothing to be the continuation of.
    terminalInput: ({ sessionId, dataB64 }) => {
      const t = terms.get(sessionId);
      if (!t || t.owner !== client) return { ok: false };
      t.term.write(fromB64(dataB64));
      return { ok: true };
    },
    // Open to any client, unlike the input and resize around it: a paste says
    // "run this block in the note's shell", which is a fact about the note, and
    // it is the same shell every client's Run buttons already reach through
    // runBlock. It is also all but unobservable — the view opens the drawer
    // before it pastes, and opening the drawer is what makes that client the
    // owner.
    terminalPaste: async ({ sessionId, text, language, host }) => {
      // The prompt-fence refusal, terminal direction (see runBlock): a
      // prompt block sent to the drawer is the same locked body reaching
      // the same agent CLI, one shell over.
      if (language === "prompt" && (await sessionNoteLocked(sessionId))) {
        console.warn("[vault] refused a prompt-fence paste in a locked note (session", sessionId + ")");
        return { ok: false };
      }
      const t = termFor(sessionId, host);
      // A fenced block in an interpreted language cannot be pasted as-is —
      // zsh would run it as shell. Its runner line is pasted instead (same
      // runner as inline; the temp file is written here). Shell blocks keep
      // pasting their literal code: visible, editable, in shell history.
      // Built for the host the drawer's shell is ON (not the request's):
      // a remote drawer must never be pasted a local temp path.
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
      // Always queue, then try to release immediately. If the shell is idle at a
      // prompt the paste goes out now; if it is cold or mid-command it waits for
      // the next prompt, so pastes never echo raw or run out of order.
      // Queued raw: whether it goes out bracketed depends on what the shell
      // has told us about itself, and that can still change after the queue.
      t.pasteQueue.push(paste);
      flushPaste(t);
      return { ok: true };
    },
    // The winsize follows the owner's window for the same reason the bytes do:
    // one pty has one grid, and a second client's fit would reflow the screen
    // the owner is reading. Owner-only, and never a spawn — the drawer's first
    // resize used to arrive just ahead of its attach and spawn the shell itself,
    // which quietly threw away the host the picker had chosen (resolveHost falls
    // back to the note's first declared one).
    terminalResize: ({ sessionId, cols, rows }) => {
      const t = terms.get(sessionId);
      if (!t || t.owner !== client) return { ok: false };
      t.term.resize(cols, rows);
      return { ok: true };
    },
    // Synchronous so no drain tick can interleave between the snapshot and
    // enabling live streaming: the snapshot is everything up to now, live is
    // everything after, with no gap or overlap. Lazily spawns the note's
    // terminal shell on first attach.
    terminalAttach: ({ sessionId, host }) => {
      const t = termFor(sessionId, host);
      // Attaching IS taking: it never fails and never asks, because the whole
      // scrollback comes back with it, so the client doing the taking has the
      // shell's history on screen the moment it arrives. The one obligation is
      // to tell whoever had it — a drawer that stopped printing with no
      // explanation is the failure this exists to prevent.
      const lost = t.owner;
      t.owner = client;
      // `by` is this client's id, which the loser turns into a name through the
      // presence list it already has (rpc-schema `presence`). The server sends
      // the id and not the label: the label is a fact about a DEVICE, and the
      // one place it belongs is the list of who is connected.
      if (lost !== null && lost !== client) push.to(lost).terminalDetached({ sessionId, by: client });
      return { dataB64: toB64(sbSnapshot(t)), host: t.host };
    },
    terminalDetach: ({ sessionId }) => {
      const t = terms.get(sessionId);
      // Only this client's own drawer. Without the check, closing a drawer on
      // the phone would stop the bytes reaching the Mac that has the same note
      // open, and the Mac would have no way to know why its terminal went
      // quiet. Nobody is told: the owner left of its own accord, and there is
      // no other client watching to tell.
      if (t && t.owner === client) t.owner = null;
      return { ok: true };
    },
    terminalStatus: ({ sessionId }) => {
      const t = terms.get(sessionId);
      return { live: !!t, host: t?.host ?? null };
    },
    // What an already-open drawer missed while its client was unreachable
    // (rpc-schema terminalClaim). Deliberately not termFor: this spawns
    // nothing, because a session with no shell is the answer rather than a
    // reason to make one.
    terminalClaim: ({ sessionId }) => {
      const t = terms.get(sessionId);
      if (!t) return { state: "gone" };
      // Another client attached while this one was away. Its `terminalDetached`
      // was pushed at a connection that had already gone, so this answer is
      // that push arriving late — and taking the shell back here instead would
      // pull it off a device somebody deliberately moved it to.
      if (t.owner !== null && t.owner !== client) return { state: "held", by: t.owner };
      // Still this client's, since owner is a client id and outlives the
      // connection it was set on. Null means nobody holds it, which for a
      // drawer that is open and asking is the same answer: it is yours, and
      // saying so without taking it would leave the bytes going nowhere.
      t.owner = client;
      return { state: "attached", dataB64: toB64(sbSnapshot(t)), host: t.host };
    },
    // Also open to any client, and for the same reason: closing the tab or
    // restarting the shells is about the NOTE, not about whose screen the
    // drawer is on. A phone that closes a note it has open should not be
    // refused because the Mac happens to hold that note's drawer, and Restart
    // Note Shell exists to apply the frontmatter the person just edited.
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
      const t = terms.get(sessionId);
      if (t) {
        // Mirror the shell-exited teardown below: the drawer closes, and a
        // busy flag the view still holds is cleared — a dead shell runs
        // nothing.
        if (t.owner !== null) push.to(t.owner).terminalExit({ sessionId });
        if (t.sentBusy) push.all.terminalBusy({ sessionId, busy: false });
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
    // Both guarded inside bun/assets.ts: the root must be registered, the
    // src passes assertions (in-root, image extension, no dot-entries)
    // before it is read, and assetWrite names the file itself — the client
    // supplies nothing but bytes and handles it was given.
    assetRead: async ({ root, src }) => {
      const res = await readAsset(root, src);
      if (res !== null && "sealed" in res) return { image: null, sealed: true };
      return { image: res };
    },
    // The bytes arrive from whichever machine the pasteboard is on
    // (remote.md §10); everything that decides the FILE is here. Whether the
    // paste is sealed at birth comes from the NOTE, not from the sender: the
    // server asks the disk if it is locked, the same two-ended stance as
    // every guard. A notePath outside the pasting root is a client bug and
    // pastes unsealed into nothing — the guard below throws before any write.
    assetWrite: async ({ root, notePath, dataB64 }) => {
      const seal =
        typeof notePath === "string" && notePath !== "" && rootContaining(notePath) === assertRegisteredRoot(root)
          ? await isNoteLocked(notePath)
          : false;
      return { src: await writePastedImage(root, fromB64(dataB64), seal) };
    },
    // This machine's half of the snapshot. A connected client merges its own
    // half over the top before the view sees it (remote.md §5); a server has
    // no screen and so has nothing to say about font sizes, which is why the
    // sections it does not own are simply the defaults here.
    settingsGet: () => ({ settings }),
    // Session layout: raw bytes both ways; the view owns the shape and the
    // self-healing, the server owns the file, the atomicity, and which client's
    // arrangement this is (bun/layout.ts). The id comes from the connection,
    // never from the call: the view has no idea it is one of several possible
    // screens, and should not have to.
    layoutGet: async () => ({ text: await readLayout(client) }),
    layoutSave: async ({ text }) => ({ ok: await writeLayout(client, text) }),
    // Raw settings.jsonc text for the ⌘, editor dialog; the write is atomic
    // and ungated (rpc-schema.ts says why). Restart-applies still holds:
    // the running `settings` snapshot above is not touched by a save.
    //
    // Only this machine's file. `home: "client"` is answered by the client
    // shell and never arrives here; a server that reached its own client home
    // would be editing the wrong screen's font size — and on a headless one,
    // a file no user has ever seen.
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
    // module in the bundle (build.copy in electrobun.config.ts put it
    // there), and execPath is the bundle's own bun — the exact pair the
    // shim will exec (bun/cliShim.ts). The message is composed here, not
    // in the view: the landing dir, the PATH verdict, and any failure are
    // server-side facts. A machine with no such pair refuses first, in its own
    // words: the view already knows (workspaceList's `cliShim`) and does not
    // offer the verb, so reaching here at all is a client that asked anyway.
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
    // bun/openRequest.ts, shared with the app-home watcher. The watcher
    // starts only AFTER this first pull (startOpenRequestWatcher above):
    // the server's watcher is alive seconds before the webview can hear a
    // push, and in that window it would consume a request whose push then
    // lands on nobody — the live probe caught exactly that. Deferring the
    // watcher leaves a mid-boot request in the file for this pull to find.
    openRequestTake: async () => {
      const open = await takeOpenRequest();
      startOpenRequestWatcher();
      return { open };
    },
    // Bun stamps the source and level and caps the length; the view's text
    // is the only part it contributes (rpc-schema.ts logAppend).
    logAppend: async ({ level, text }) => {
      writeLog("view", level, [text.slice(0, LOG_TEXT_CAP)]);
      return { ok: true };
    },
    logReveal: async () => ({ ok: revealLog() }),
    // The pasteboard, the browser, the menu bar, and the list of servers this
    // app knows about all belong to whoever is looking at the screen, so the
    // client shell serves them itself and they never reach a server
    // (bun/clientSeams.ts, remote.md §8 and §10). These
    // entries exist because the handler map is total, and they throw rather
    // than answer: reaching one means a client forgot its overlay, and an
    // empty string back from a clipboard read would look like an empty
    // clipboard for as long as it took anyone to find it.
    //
    // Last in the object deliberately. A spread wins over the keys above it,
    // so a handler re-added up there surfaces as a refusal someone has to come
    // and delete, rather than as a server that quietly answers.
    ...clientSeamRefusals(),
  });

  refreshWatchers();

  // Auto-relock (idle) pushes the same vaultChanged the explicit paths do —
  // the view cannot tell why the vault locked, only that it did, which is the
  // point: one eviction path.
  configureVault({ onAutoLock: () => push.all.vaultChanged({ state: vaultState() }) });

  // Drain every live shell on a short interval. (poll()-gated reads never block;
  // see pty.ts.) Inline shells are sliced into per-block events (block ids are
  // globally unique, so the view routes each event to the editor that owns it with
  // no per-note bookkeeping here); terminal shells stream raw to the client that
  // owns that note's drawer. Inline lifecycle — overflow teardown on a run's end,
  // closing out the run of a shell that died mid-block — lives in the pool.
  const drain = setInterval(() => {
    inlinePool.drain(sendRunEvent);

    const now = Date.now();
    for (const [sessionId, t] of terms) {
      const termData = t.term.drain();
      if (termData) {
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
      // After the scan, and every tick rather than only on output: the prompt a
      // paste is waiting for arrives as bytes, but a shell with no
      // bracketed-paste mode is released by the ABSENCE of them instead.
      flushPaste(t, now);
      // Push busy on every tick, not just when bytes arrive: queueing a paste changes
      // it with no output at all, and the button has to gray out the moment it does.
      //
      // To everyone, unlike the two pushes around it. Busy is a fact about the
      // NOTE's shell rather than about the drawer: it grays out the terminal
      // button on any client with that note open, whether or not that client is
      // the one watching the bytes. A client that has never heard of the session
      // files it under an id it does not use (mainview/editor/bridge.ts).
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
  }, 8);

  // Age old deletions out of every available workspace's trash, once per launch.
  // Deliberately not awaited: it is housekeeping, and the window should not wait
  // on folder scans to open. Doing it here rather than on a timer means a
  // trashed note never disappears out from under a Trash section the user is
  // looking at. Unavailable roots are skipped, not failed: an unmounted volume's
  // trash just keeps its notes until it is back.
  void Promise.all(availableRoots().map((root) => purgeTrash(root, settings.trash.ttlDays * 24 * 60 * 60 * 1000)))
    .then((ns) => {
      const n = ns.reduce((a, b) => a + b, 0);
      if (n > 0) console.log(`[notes] purged ${n} trashed note(s) past the ${settings.trash.ttlDays}-day limit`);
    })
    .catch((err) => console.error("[notes] trash purge failed", err));

  return {
    forClient: requestsFor,
    // isBusy, not "a shell exists": a note's terminal drawer keeps its zsh
    // sitting at a prompt for as long as the tab is open, and that is not work
    // in progress.
    running: () => inlinePool.running() || [...terms.values()].some(isBusy),
    // Every shell, busy or not, and the drawer's counted by existing rather
    // than by isBusy: a zsh sitting at a prompt is precisely what a hold is
    // for, and it is what `running` above is right to ignore.
    sessionsOpen: () => inlinePool.sessionsOpen() || terms.size > 0,
    shutdown() {
      clearInterval(drain);
      inlinePool.closeAll();
      for (const t of terms.values()) t.term.close();
    },
  };
}
