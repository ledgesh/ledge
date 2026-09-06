// Ledge on macOS: the native shell around the servers.
//
// A window loads the editor webview and is a client of exactly one server
// (remote.md §8a): its own connection, its own client id, its own row in
// presence. There can be several, pointed at several machines. This file owns
// the AppKit half: the windows and their geometry, the application menu, the
// updater, the native folder dialog, and the pasteboard's flavor list. It also
// owns the two things that belong to the process rather than to one window:
// the connection list, and the one local server every window on this Mac
// shares. The servers own the notes, the shells, and the watchers, and import
// none of this (remote.md §1), so the same handlers can be served over a
// socket to another machine without a second implementation.
import {
  ApplicationMenu,
  BrowserView,
  BrowserWindow,
  Screen,
  Updater,
  Utils,
  type ApplicationMenuItemConfig,
} from "electrobun/bun";
import { homedir } from "node:os";
import { join } from "node:path";
import { fitFrame, readWindows, writeWindows, type Rect, type WindowState } from "./windowFrame";
import { startLogging } from "./log";
import { EXTRACTION_DIRNAME, pruneExtractionDir } from "./updateCache";
import { APP_HOME } from "./workspaces";
import { createServer, type LedgeServer, type NativeDeps } from "./server";
import { audienceOf } from "./audience";
import type { RequestHandlers, ServerPush } from "../shared/wire";
import { clientOverlay, type ClientNative } from "./clientSeams";
import { imageFromFile } from "./clipboard";
import { clientIdFor, clientLabel, ephemeralClientId } from "./clientHome";
import { createConnectionManager, type Attached, type ConnectionManager } from "./connectionManager";
import { createConnectionStore } from "./connectionStore";
import { explainDial, KNOWN_HOSTS_PATH, LOCAL_ID, sshDial, userKnownHosts, type Connection } from "./connections";
import { ASKPASS_PATH, ensureAskpass, hasPassword } from "./secrets";
import { reconnectingClient, Refused, SESSION_HOLD_MS } from "../shared/transport";
import { spawnDuplex } from "./transport";
import { BUILD_VERSION } from "../shared/version";
import type { LedgeRPC } from "../shared/rpc-schema";

// Called before anything that can fail: from here every console line in this
// process is also on disk, Electrobun's own output included. Call sites keep
// using console, so nothing else in bun/ knows. Electrobun's
// `uncaughtException` and `unhandledRejection` handlers console.error and then
// force-exit, and those two lines are the whole crash report a shipped build
// produces. The appends are synchronous, so they reach the file.
startLogging();
const local = await Updater.getLocalInfo().catch(() => null);
console.log(
  `[bun] Ledge ${local?.version ?? "?"} (${local?.channel ?? "?"}, ${local?.hash?.slice(0, 8) ?? "?"}) on ${process.platform} ${process.arch}; bun ${Bun.version}`,
);

// Deletes the previous versions' extraction tars, at 80MB each
// (bun/updateCache.ts for what is kept and why). Not awaited and never fatal:
// it frees disk, and boot does not depend on the result. The extraction folder
// and the running hash are supplied here so updateCache.ts stays importable
// without booting the Electrobun runtime.
void (async () => {
  if (typeof local?.hash !== "string") return;
  const dir = join(await Updater.appDataFolder(), EXTRACTION_DIRNAME);
  const removed = await pruneExtractionDir(dir, local.hash);
  if (removed.length > 0) console.log(`[bun] pruned ${removed.length} stale update file(s): ${removed.join(", ")}`);
})().catch(() => {});

// In the dev channel, prefer a running Vite dev server (bun run dev:hmr) so the
// React view hot-reloads. Otherwise load the built view copied into the bundle.
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

// The folder dialog, the one native seam a local server still needs from this
// process (remote.md §5). A server across a connection has no dialog and says
// so.
const native: NativeDeps = {
  // openFileDialog splits its FFI result on ",", so a path containing a comma
  // comes back shredded. Re-joining it restores the path. The caller refuses a
  // path that does not exist rather than guessing where to split it.
  pickFolder: async (startingFolder) => {
    const picked = (
      await Utils.openFileDialog({
        startingFolder,
        canChooseFiles: false,
        canChooseDirectory: true,
        allowsMultipleSelection: false,
      })
    ).join(",");
    return picked || null;
  },
};

// The seams that stay on this side of every connection (remote.md §10): the
// pasteboard, the picture library, the browser, and the menu bar are this
// Mac's, local server or remote. AppKit supplies the native halves.
//
// The two here are the process's, one pasteboard and one picture library, so
// every window shares them. The two that are a window's, the menu bar and New
// Window, are added per window by `nativeFor` below.
const sharedNative: ClientNative = {
  clipboardFormats: () => {
    try {
      return Utils.clipboardAvailableFormats();
    } catch {
      // No format list on this platform; null makes clipboardReadRich ask the
      // pasteboard anyway.
      return null;
    }
  },
  // Insert Image…, on the machine with the screen. This one is the file
  // dialog; the phone's answer to the same verb is PHPicker (ios.md §11).
  // bun/clipboard.ts imageFromFile turns the picked file into bytes assetWrite
  // can store. A picked file that is not a picture comes back null, the same
  // answer as a cancelled dialog, which the view treats as nothing to insert.
  pickImage: async () => {
    // pickFolder's comma caveat, for the same FFI: re-join, and let the read
    // refuse a path that does not exist rather than guess where to split it.
    const picked = (
      await Utils.openFileDialog({
        startingFolder: homedir(),
        canChooseFiles: true,
        canChooseDirectory: false,
        allowsMultipleSelection: false,
      })
    ).join(",");
    return picked ? imageFromFile(picked) : null;
  },
};

// The handlers are enumerated rather than proxied, so a message added to the
// schema fails to compile here until it is wired.
function defineLedgeRPC(requests: RequestHandlers) {
  return BrowserView.defineRPC<LedgeRPC>({
    maxRequestTime: 10_000,
    handlers: { requests, messages: {} },
  });
}

// What this Mac calls itself on someone else's screen: its hostname
// (clientHome.ts clientLabel). Read once, so a rename takes effect at the next
// launch, which is when the hostname generally settles anyway.
const myLabel = clientLabel();

/** One window, which is one client. */
interface Win {
  /** Electrobun's window id, 0 until the window exists. */
  id: number;
  window: BrowserWindow | null;
  /** Pushes into this window's webview, forwarded once its RPC exists. */
  push: ServerPush;
  /** This window's own report about its own wire (wire.ts CLIENT_PUSHES). */
  say(p: { state: "live" | "reconnecting" | "lost"; detail: string }): void;
  /** Lands the manual on a page. The other client push, sent only to a window
   * whose `docs` is true. */
  show(p: { page: string }): void;
  /** Whether this window is the manual's (`windowDocs`). One window per app
   * has it. Its title, that it saves no layout, and that it is not in the
   * saved window list all follow from it. */
  docs: boolean;
  /** The page this window was opened to show, by title. "" is the landing
   * page. Read once, by the view's boot (`windowRole`). */
  page: string;
  manager: ConnectionManager | null;
  /** The connection this window is on, "" until its first attach lands.
   * `attachFor` sets it when the manager commits to a connection, so it cannot
   * drift from the manager's own answer. */
  connection: string;
  /** The id this window is known by on that connection. */
  client: string;
  /** What the title bar says: the name of the connection this window is on.
   * Kept here as well as on the window because the manager settles it before
   * there is a window to put it on. */
  title: string;
  /** Where the window was last seen while not fullscreen. A fullscreen frame
   * is the screen's geometry rather than a chosen size, and restoring it would
   * open a windowed app at exactly screen size. */
  frame: Rect;
  /** The latest frame the OS reported, fullscreen or not. */
  reported: Rect;
  /** The menu this window's view last pushed, applied while it is focused. */
  menu: unknown[] | null;
  /** The pending debounced frame write, if any. */
  save: ReturnType<typeof setTimeout> | null;
  /** Cached "not fullscreen", for the exit hook, where no FFI may be called. */
  windowed: boolean;
}

const windows: Win[] = [];

// The connection list, the pins, and the ids filed against them: one per
// process, however many windows (remote.md §8a). `inUse` reports the
// connections windows are holding, and the store refuses to remove one of
// those.
const store = await createConnectionStore({ inUse: () => windows.map((w) => w.connection).filter(Boolean) });

// --- the local server, once, under every window pointed at it ----------------
//
// A second createServer over the same notes root would give this machine two
// watchers, two vaults, two PTY maps, and two consumers of the open-request
// file. So the server is built on the first local attach and torn down when
// the last one goes. The last window switching away from this Mac still costs
// its shells. A second window on this Mac costs nothing.
const localClients = new Map<string, { push: ServerPush; label: string; token: number }>();
const localAudience = audienceOf(localClients, (held) => held.push);

let localServer: LedgeServer | null = null;
let localPending: Promise<LedgeServer> | null = null;
let localHolders = 0;
let attachToken = 0;

async function acquireLocal(): Promise<LedgeServer> {
  localHolders += 1;
  if (!localPending) localPending = createServer({ push: localAudience, native });
  try {
    return (localServer = await localPending);
  } catch (err) {
    localHolders -= 1;
    throw err;
  }
}

function releaseLocal(): void {
  localHolders -= 1;
  if (localHolders > 0) return;
  const server = localServer;
  localServer = null;
  localPending = null;
  server?.shutdown();
}

/**
 * Tells every window on this Mac who else is here (rpc-schema `presence`).
 *
 * bun/daemon.ts announcePresence does this for a server across a wire, and
 * this does it for the server in this process. Only the code holding the
 * connections knows who is connected. Two windows on this Mac need presence as
 * much as a Mac and a phone do: without it, a drawer taken by the other window
 * shows as taken by nobody in particular (interactions.md §4-2).
 */
function announceLocalPresence(): void {
  const everyone = [...localClients].map(([client, held]) => ({ client, label: held.label }));
  for (const [client, held] of localClients) {
    held.push.presence({ others: everyone.filter((p) => p.client !== client) });
  }
}

// --- opening a connection, for one window ------------------------------------

/**
 * Replaces `layoutGet` and `layoutSave` with no-ops, for a window that boots
 * blank. Two windows cannot both be the client a server files one layout
 * under, so the second one saves nothing rather than fighting over the file
 * (remote.md §8a). `attachFor` applies this to the manual's window too.
 */
function withoutLayout(base: RequestHandlers): RequestHandlers {
  return { ...base, layoutGet: async () => ({ text: null }), layoutSave: async () => ({ ok: true }) };
}

/**
 * Opens one connection for one window. The manager decides which connection
 * and when. This decides how, the only part that needs Electrobun's version
 * string and a child process.
 *
 * The client overlay goes on last in both branches, so the local case and the
 * remote case are the same code path with a different server underneath
 * (remote.md §1). The pasteboard is read here whether the notes are on this
 * disk or on a VPS.
 */
async function attachFor(win: Win, conn: Connection): Promise<Attached> {
  const build = local?.version ?? BUILD_VERSION;
  // Whether another window is already this server's client. Two things follow:
  // the id this window sends, and the name the other window displays for it.
  //
  // The manual's window changes neither of those. It never takes a
  // connection's id (`blank` below), so a window opened after it still gets
  // the layout that connection has on file. The count leaves it out, so an
  // ordinary window that shares a server with only the manual is still that
  // server's first client.
  const others = windows.filter((w) => w !== win && !w.docs && w.connection === conn.id).length;
  const blank = win.docs || others > 0;
  const client = blank ? ephemeralClientId() : await clientIdFor(conn.id);
  // The name other clients display for this window (remote.md §5: a server
  // displays what it is told). The second and later windows on one server are
  // numbered. The manual's window says "(manual)": it registers in presence
  // like any other client, and two rows both reading "MacBook" would name
  // nothing.
  const label = win.docs ? `${myLabel} (manual)` : others > 0 ? `${myLabel} (${others + 1})` : myLabel;
  const token = ++attachToken;
  const arrived = (): void => {
    win.connection = conn.id;
    win.client = client;
    // Which window is which client of which server. Every later log line that
    // names a client id names one of these.
    console.log(`[window] ${label} on ${conn.name} as ${client}${blank ? " (blank; the layout on file is another window's)" : ""}`);
  };

  if (conn.destination === "") {
    const server = await acquireLocal();
    const requests = await clientOverlay(server.forClient(client), nativeFor(win));
    localClients.set(client, { push: win.push, label, token });
    arrived();
    announceLocalPresence();
    return {
      requests: blank ? withoutLayout(requests) : requests,
      build,
      // Nothing to recheck: the server is in this process, so there is no wire
      // to hurry.
      recheck: () => {},
      shutdown: () => {
        // Removes the client only if this attach is still the one registered.
        // Re-selecting a local connection whose wire was declared lost
        // attaches again under the same id, and the old attach must not delete
        // the new one on its way out. bun/daemon.ts makes the same check.
        if (localClients.get(client)?.token === token) {
          localClients.delete(client);
          announceLocalPresence();
        }
        releaseLocal();
      },
    };
  }

  if (conn.auth === "password") {
    // Checked here rather than left to ssh. A missing keychain item reaches
    // the user as "Permission denied (password)", which sends them to check a
    // password that is right on a server that is fine. The fault is on this
    // Mac, and this is the only place that can say so.
    if (!(await hasPassword(conn.id))) {
      throw new Error(`no password is stored for ${conn.name} on this Mac. Edit the connection and enter it again`);
    }
    // Written here rather than at boot, because only a password connection
    // needs it. A Mac that never uses one never grows the file, and a
    // connection that starts using one gets a current script rather than one
    // an older version left behind.
    await ensureAskpass();
  }
  const { argv, env } = sshDial(conn, {
    knownHosts: KNOWN_HOSTS_PATH,
    userKnownHosts: userKnownHosts(),
    askpass: ASKPASS_PATH,
  });
  // What ssh said, kept because it is the only account of a failure that
  // happens before the protocol starts (connections.ts explainDial). Capped at
  // the last 4096 bytes: a login shell on the far end can be chatty, and this
  // is a diagnosis rather than a log.
  let said = "";
  const listen = (text: string): void => {
    // Logged as it arrives as well as kept. ssh's stderr also carries the
    // remote server's own log lines, which under an inherited stderr went
    // straight to a descriptor and never reached startLogging. They land in
    // the log file here, named by the machine they came from. console.log
    // rather than warn, because most of it is a server talking, not a failure.
    for (const line of text.split("\n")) if (line.trim()) console.log(`[ssh] ${conn.name}: ${line.trim()}`);
    said = (said + text).slice(-4096);
  };
  // A reconnecting client, because an ssh over a real network drops for
  // reasons that have nothing to do with either end: a laptop lid, a changed
  // network, an idle timeout on a middlebox. `dial` runs again on every
  // attempt, so each retry spawns a fresh ssh.
  //
  // reconnectingClient throws when the two ends disagree about the protocol,
  // with both versions named, and when the ssh child dies before saying
  // anything (a refused key, an unknown host, no route). The manager keeps the
  // connection that already works and reports this one (remote.md §8), so the
  // catch below only puts ssh's words in front of the transport's.
  const wire = await reconnectingClient({
    // `env` goes with every attempt, not just the first: a reconnect is a
    // fresh ssh, and it needs the same askpass helper the first one was
    // pointed at (bun/secrets.ts).
    dial: () => spawnDuplex(argv, { env, onStderr: listen }),
    push: win.push,
    build,
    client,
    label,
    // How long the far end keeps this session after the wire drops, the same
    // ask a phone makes (shared/transport.ts SESSION_HOLD_MS). A lid closed
    // for a meeting, a lift, or a walk between buildings should not cost the
    // shells on the other end. A Mac that asked for nothing would lose them to
    // the daemon's idle timer however briefly it had been away.
    hold: SESSION_HOLD_MS,
    onState: (state, detail) => {
      if (state !== "live") console.warn(`[connect] ${conn.name}: ${detail}`);
      // The ladder ran out, or the server said goodbye. The manager has to
      // know. Otherwise choosing this same connection again, the only recovery
      // the chrome offers, would be the no-op it is for a connection that is
      // already working (connectionManager.ts).
      if (state === "lost") win.manager?.lost(conn.id, detail);
      // The wire came back by itself, which it can now do: the ladder ends in
      // a retry beat rather than a stop (shared/transport.ts RETRY_EVERY_MS).
      // Without this the manager never hears about the recovery, and choosing
      // this same connection afterwards would rebuild a working session.
      if (state === "live") win.manager?.restored(conn.id);
      win.say({ state, detail });
    },
    // Only the first dial reaches the catch below: reconnectingClient resolves
    // once the wire is up, so every later failure is the ladder's business.
  }).catch((err: unknown) => {
    // A refused handshake keeps its own words (shared/transport.ts `Refused`).
    // ssh's stderr is the better account of any failure before the protocol
    // starts, which is what `explainDial` reads below. But once the two ends
    // have exchanged hellos, the last stderr line is the far end's `serve`
    // saying it attached, and quoting that would call an up server unreachable.
    if (err instanceof Refused) throw err;
    throw new Error(explainDial(said) ?? (err instanceof Error ? err.message : String(err)));
  });
  const peer = await wire.ready;
  arrived();
  console.log(`[connect] ${conn.name} (${conn.destination}): ledge-server ${peer.build}`);
  const requests = await clientOverlay(wire.requests, nativeFor(win));
  return {
    requests: blank ? withoutLayout(requests) : requests,
    build: peer.build,
    recheck: () => wire.recheck(),
    shutdown: () => wire.close(),
  };
}

// --- the menu bar, which no window owns --------------------------------------
//
// macOS gives an application one menu bar and the view owns its contents
// (interactions.md §10), so two views pushing into it are arbitrated rather
// than merged: the focused window fills the bar, and a click goes back to that
// window alone. This is the one place this process decides between windows
// instead of routing between them.
let focused: Win | null = null;

function applyMenu(win: Win): void {
  if (win.menu) ApplicationMenu.setApplicationMenu(win.menu as ApplicationMenuItemConfig[]);
}

/** This window's half of the client seams: the menu bar it fills while it is
 * focused, the verbs that open another window, and this window's own role. */
function nativeFor(win: Win): ClientNative {
  return {
    ...sharedNative,
    setMenu: (items) => {
      win.menu = items;
      // A push from an unfocused window is remembered, not applied: the bar
      // shows the focused window's menu, and the focus handler applies this
      // one when the window gains focus. While no window is focused, every
      // push goes straight to the bar.
      if (focused === win || focused === null) applyMenu(win);
    },
    newWindow: () => void openWindow(LOCAL_ID),
    docsWindow: (page) => showDocs(page),
    windowRole: () => ({ docs: win.docs, page: win.page }),
  };
}

// One manual window at a time, including while one is being built. A window
// joins `windows` inside buildWindow, which is queued behind whatever else is
// opening, so the list alone cannot answer "is there one already".
let docsOpening: Promise<void> | null = null;

/**
 * Shows the manual on `page`, in the one window that holds it (remote.md §8a).
 *
 * There is one manual window per app. The corpus is read-only and the same in
 * every copy, so a second window would be two views onto the same fixed pages,
 * scrolled differently. An app already showing the manual raises that window
 * and shows `page` there: Help > Third-Party Licenses has to land on the
 * licenses whether or not the manual was already up. An ask that arrives while
 * a manual window is still opening waits and then takes the raise path.
 * Dropping it would answer a named page with the front page.
 *
 * The window opens on the local connection whichever window asked for it. The
 * manual is this app's own, compiled into this build (bun/docsContent.ts) and
 * synced to the local docs root at launch. A remote server's copy would be
 * whatever version is installed over there.
 */
function showDocs(page: string): void {
  const open = windows.find((w) => w.docs);
  if (open) {
    open.page = page;
    open.window?.activate();
    open.show({ page });
    return;
  }
  if (docsOpening) {
    // The rejection handler does nothing: openWindow already logged the
    // failure, and a window that did not open has nothing to raise.
    void docsOpening.then(() => showDocs(page), () => {});
    return;
  }
  docsOpening = openWindow(LOCAL_ID, undefined, { page }).finally(() => {
    docsOpening = null;
  });
  docsOpening.catch(() => {});
}

// --- the windows themselves ---------------------------------------------------

// The displays' usable rectangles, primary first. fitFrame re-centers on
// workAreas[0] when a saved frame matches no attached display, so a window
// nobody can locate comes back in the middle of the main screen.
function workAreas(): Rect[] {
  try {
    const displays = Screen.getAllDisplays();
    return displays
      .filter((d) => d.workArea.width > 0 && d.workArea.height > 0)
      .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))
      .map((d) => d.workArea);
  } catch (err) {
    // fitFrame reads an empty list as "no evidence" and honors the saved
    // frame. The screens have not changed, only this process's ability to ask
    // about them.
    console.warn("[window] could not read the displays:", err);
    return [];
  }
}

// How far a window opened by hand sits from the one it was opened over. AppKit
// cascades new windows for the same reason: two windows at identical
// coordinates look like one window.
const CASCADE = 28;

// The manual window's title, whatever machine the window that opened it is on.
// The pages in it are this app's own.
const DOCS_TITLE = "Documentation";

/**
 * Title a window after the connection it is on (remote.md §8a).
 *
 * The app's name is not in the title. Two windows both saying "Ledge" is what
 * the title bar, the Window menu and the App Exposé grid all showed before
 * this, and what a person needs from them is which machine they are looking
 * at. The title follows the connection rather than the note in front of it. A
 * window is a client, and what changes underneath it is the machine. The notes
 * are named by their own tabs.
 *
 * The manual's window is the exception. It is a client of this Mac, but every
 * copy of the manual is the same, so its title says that it is the manual.
 */
function nameWindow(win: Win, name: string): void {
  win.title = win.docs ? DOCS_TITLE : name;
  // `win.window` is null before the window is built, which is where the first
  // report lands. buildWindow reads win.title back when it constructs one.
  win.window?.setTitle(win.title);
}

function snapshot(): WindowState[] {
  // The manual's window is left out, so a launch never reopens it. It holds
  // nothing a person put there and is one click away. A session that ended
  // with only the manual open would otherwise relaunch showing help and no
  // notes.
  return windows
    .filter((w) => !w.docs)
    .map((w) => ({ frame: w.frame, connection: w.connection || LOCAL_ID }));
}

function saveWindows(): void {
  // Never write the empty list. Closing the last window quits the app, and a
  // file saying "no windows" would make the next launch invent one anyway,
  // with the wrong connection and the wrong frame. Closing the last window
  // that is not the manual hits the same rule through snapshot's filter: the
  // list already on file stands.
  const state = snapshot();
  if (state.length === 0) return;
  writeWindows(state);
}

// How long the frame write waits after a move or resize. macOS emits both
// continuously through a drag, so an undebounced write would run at frame rate.
// noteFrame starts the timer on the first event of a burst and does not restart
// it, so a long drag costs one write per interval and the final position still
// lands one interval after the mouse stops.
const FRAME_SAVE_MS = 400;

function saveFrameNow(win: Win): void {
  if (win.save) clearTimeout(win.save);
  win.save = null;
  win.windowed = !win.window?.isFullScreen();
  if (!win.windowed) return;
  win.frame = win.reported;
  saveWindows();
}

function noteFrame(win: Win, next: Partial<Rect>): void {
  win.reported = { ...win.reported, ...next };
  if (!win.save) win.save = setTimeout(() => saveFrameNow(win), FRAME_SAVE_MS);
}

// Windows open one at a time. The id a window sends and the label it presents
// both depend on which connections the other windows are already on, so two
// opens interleaving would each answer that before the other arrived.
let opening: Promise<unknown> = Promise.resolve();

// `docs` opens the manual's window rather than an ordinary one, on the page it
// names. showDocs above owns the rule that there is only ever one.
function openWindow(want: string, frame?: Rect, docs?: { page: string }): Promise<void> {
  const next = opening.then(
    () => buildWindow(want, frame, docs),
    () => buildWindow(want, frame, docs),
  );
  opening = next;
  return next;
}

async function buildWindow(want: string, frame?: Rect, docs?: { page: string }): Promise<void> {
  // `rpc` is null until it is assigned below, in the same synchronous run as
  // the manager's await resolves, so no timer or fs event can observe the
  // null. The optional calls in `push` are the belt.
  let rpc: ReturnType<typeof defineLedgeRPC> | null = null;
  const start = fitFrame(frame ?? cascadedFrame(), workAreas());
  const win: Win = {
    id: 0,
    window: null,
    push: {
      runEvent: (p) => rpc?.send.runEvent(p),
      terminalOutput: (p) => rpc?.send.terminalOutput(p),
      terminalBusy: (p) => rpc?.send.terminalBusy(p),
      terminalExit: (p) => rpc?.send.terminalExit(p),
      terminalDetached: (p) => rpc?.send.terminalDetached(p),
      presence: (p) => rpc?.send.presence(p),
      notesChanged: (p) => rpc?.send.notesChanged(p),
      openExternal: (p) => rpc?.send.openExternal(p),
      vaultChanged: (p) => rpc?.send.vaultChanged(p),
      menuCommand: (p) => rpc?.send.menuCommand(p),
    },
    say: (p) => rpc?.send.connectionState(p),
    show: (p) => rpc?.send.docsShow(p),
    docs: docs !== undefined,
    page: docs?.page ?? "",
    manager: null,
    connection: "",
    client: "",
    // The manager's first report replaces this title before the window below
    // is built, and nameWindow answers for the manual's window. It stands only
    // if a window ever opens without a report.
    title: docs !== undefined ? DOCS_TITLE : "Ledge",
    frame: start,
    reported: start,
    menu: null,
    save: null,
    windowed: true,
  };
  windows.push(win);

  try {
    win.manager = await createConnectionManager({
      attach: (conn) => attachFor(win, conn),
      store,
      want,
      // onSelect saves the window list the moment the connection changes,
      // rather than at quit. The next launch reads this window's server from
      // that file, and a switch lost to a crash would reopen the old machine.
      onSelect: () => saveWindows(),
      onName: (name) => nameWindow(win, name),
    });
  } catch (err) {
    // Nothing to put a webview on. One window failing to open must not take
    // the others with it, so this drops it from the list and rethrows. Only
    // every window failing is fatal (the exit at the end of boot).
    windows.splice(windows.indexOf(win), 1);
    console.error("[window] could not open a window:", err);
    throw err;
  }

  rpc = defineLedgeRPC(win.manager.requests);
  const browser = new BrowserWindow({ title: win.title, url: await mainViewUrl(), rpc, frame: start });
  win.window = browser;
  win.id = browser.id;

  // Read the move and resize payloads, never getFrame(). They report the
  // content size, which is what the `frame:` option above sets; getFrame() adds
  // the 28px title bar, so saving one and restoring through the other shrinks
  // the window by a title bar every launch. Both report x/y from the top left
  // of the same space as Screen's work areas, which fitFrame's overlap test
  // needs (verified live: a window handed y=0 comes back at y=33, the menu
  // bar's height).
  browser.on("move", (event) => {
    const { x, y } = (event as { data: { x: number; y: number } }).data;
    noteFrame(win, { x, y });
  });
  browser.on("resize", (event) => {
    const { x, y, width, height } = (event as { data: Rect }).data;
    noteFrame(win, { x, y, width, height });
  });
  browser.on("focus", () => {
    focused = win;
    applyMenu(win);
  });
  // There is no blur handler: macOS blurs the window being left before it
  // focuses the one being arrived at, and a menu click that landed in between
  // would have nowhere to go. `focused` moves rather than clearing.
  browser.on("close", () => closeWindow(win));

  saveWindows();
}

// Where a window opened by hand starts: one step down and across from the
// focused window, rather than exactly on top of it. Null when there is no
// window to cascade from, which fitFrame turns into DEFAULT_FRAME. It is read
// before the new window joins `windows`, so the last entry is the newest
// existing one.
function cascadedFrame(): Rect | null {
  const from = focused ?? windows[windows.length - 1] ?? null;
  if (!from) return null;
  return { ...from.frame, x: from.frame.x + CASCADE, y: from.frame.y + CASCADE };
}

function closeWindow(win: Win): void {
  const at = windows.indexOf(win);
  if (at < 0) return;
  windows.splice(at, 1);
  if (win.save) clearTimeout(win.save);
  win.save = null;
  if (focused === win) focused = windows[0] ?? null;
  // The connection goes with the window: the ssh child is this window's, and
  // releaseLocal tears the local server down when its last holder leaves.
  win.manager?.shutdown();
  // After the shutdown, so the list saved is the windows that remain.
  saveWindows();
}

// --- boot ---------------------------------------------------------------------

// The windows that were open when this app last quit, each on the connection it
// was pointed at (remote.md §8a). One window on the stored selection when there
// is no list to read: a fresh install, or a client home that lost the file.
const restore = readWindows(store.launchSelection());
const wanted: WindowState[] = restore.length > 0 ? restore : [{ frame: fitFrame(null, workAreas()), connection: store.launchSelection() }];

// The menu bar's two edges: this fallback menu, which stands until the view's
// first push, and the click route back below. The view owns the real menu
// (commands/menu.ts, pushed through menuSet). Without an application menu there
// is no ⌘Q, so a view that fails to load would leave a window with no way out.
// Quit and the edit roles are the whole fallback; a push replaces it wholesale.
ApplicationMenu.setApplicationMenu([
  {
    label: "Ledge",
    submenu: [
      { role: "hide", label: "Hide Ledge", accelerator: "command+h" },
      { type: "divider" },
      { role: "quit", label: "Quit Ledge", accelerator: "command+q" },
    ],
  },
  {
    label: "Edit",
    submenu: [
      { role: "undo", label: "Undo", accelerator: "command+z" },
      { role: "redo", label: "Redo", accelerator: "command+shift+z" },
      { type: "divider" },
      { role: "cut", label: "Cut" },
      { role: "copy", label: "Copy" },
      { role: "paste", label: "Paste" },
      { role: "selectAll", label: "Select All" },
    ],
  },
]);

// A clicked item carries the command id the view put in its `action`. The shell
// forwards it, without knowing what it means, to the focused window alone: the
// bar it was clicked in is that window's. Role items never arrive here. AppKit
// runs those down the responder chain and the WebView answers.
ApplicationMenu.on("application-menu-clicked", (event) => {
  const action = (event as { data?: { action?: unknown } }).data?.action;
  if (typeof action === "string" && action.length > 0) (focused ?? windows[0])?.push.menuCommand({ action });
});

for (const [at, state] of wanted.entries()) {
  // Awaited one at a time, so each window knows which connections the ones
  // before it took. A window that cannot open costs only itself: the manager's
  // local fallback covers a server that will not answer, and this catch covers
  // the rest.
  await openWindow(state.connection, state.frame).catch((err) => {
    console.error(`[window] window ${at + 1} did not open:`, err);
  });
}

if (windows.length === 0) {
  console.error("[bun] no window opened; exiting");
  process.exit(1);
}

process.on("exit", () => {
  // Flushes the pending frame writes. A resize or drag in the last
  // FRAME_SAVE_MS before ⌘Q would otherwise be lost. No FFI is allowed here
  // (the windows may already be gone), so this reads the cached `windowed`
  // flag rather than asking again whether each window is fullscreen.
  for (const win of windows) if (win.save && win.windowed) win.frame = win.reported;
  saveWindows();
  for (const win of windows) win.manager?.shutdown();
});

console.log("[bun] Ledge started (per-note shells, spawned on first use); app home:", APP_HOME);
