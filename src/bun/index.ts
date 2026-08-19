// Ledge on macOS: the native shell around the servers.
//
// A window loads the editor webview and is a CLIENT of exactly one server
// (remote.md §8a): its own connection, its own client id, its own row in
// presence. There can be several, pointed at several machines, and this file
// owns what AppKit's — the windows and their geometry, the application menu,
// the updater, the native folder dialog, and the pasteboard's flavor list —
// plus the two things that are a fact about the PROCESS rather than about any
// one window: the connection list, and the one local server every window on
// this Mac shares. The servers own the notes, the shells, and the watchers, and
// import none of it (remote.md §1) — which is what lets the same handlers be
// served over a socket to another machine without a second implementation.
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

// Before anything that can fail: from here every console line in this process
// is also on disk. Nothing else in bun/ knows this happened — call sites keep
// using console — and it deliberately covers Electrobun's own output too,
// including the `uncaughtException` and `unhandledRejection` handlers it
// installs, which console.error and then force-exit. Those two lines are the
// entire crash report a shipped build can produce, and they land because the
// appends are synchronous.
startLogging();
const local = await Updater.getLocalInfo().catch(() => null);
console.log(
  `[bun] Ledge ${local?.version ?? "?"} (${local?.channel ?? "?"}, ${local?.hash?.slice(0, 8) ?? "?"}) on ${process.platform} ${process.arch}; bun ${Bun.version}`,
);

// The previous versions' extraction tars, at 80MB each (bun/updateCache.ts
// for what is kept and why). Not awaited and never fatal: this is disk, not
// correctness, and boot has nothing to learn from it. The two Electrobun
// facts are supplied here so updateCache.ts stays importable without booting
// the Electrobun runtime.
void (async () => {
  if (typeof local?.hash !== "string") return;
  const dir = join(await Updater.appDataFolder(), EXTRACTION_DIRNAME);
  const removed = await pruneExtractionDir(dir, local.hash);
  if (removed.length > 0) console.log(`[bun] pruned ${removed.length} stale update file(s): ${removed.join(", ")}`);
})().catch(() => {});

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

// The folder dialog, the one native seam a local server still needs from us
// (remote.md §5). A server across a connection has no dialog and says so.
const native: NativeDeps = {
  // openFileDialog splits its FFI result on "," — a path containing a comma
  // comes back shredded, so re-join and let the caller's stat-validation
  // refuse what does not exist; a comma path that still does not stat is
  // refused, never guessed at.
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
// The three here are the process's — one pasteboard, one picture library, one
// `open` — so every window shares them. The two that are a window's, the menu
// bar and New Window, are added per window by `nativeFor` below.
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
  // Insert Image…, on the machine with the screen. The phone's answer to the
  // same verb is PHPicker (ios.md §11); this one is the file dialog, and the
  // conversion behind it is what turns "any file the user picked" into bytes
  // assetWrite can store (bun/clipboard.ts imageFromFile). A picked file that is
  // not a picture comes back null — the same answer as a cancelled dialog, which
  // the view already treats as "nothing to insert".
  pickImage: async () => {
    // pickFolder's comma caveat, for the same FFI: re-join and let the read
    // refuse a path that does not exist rather than guessing where to split.
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

// Enumerated rather than proxied on purpose: a message added to the schema
// fails to compile here until it is wired, which is the check worth having.
function defineLedgeRPC(requests: RequestHandlers) {
  return BrowserView.defineRPC<LedgeRPC>({
    maxRequestTime: 10_000,
    handlers: { requests, messages: {} },
  });
}

// What this Mac calls itself on someone else's screen. Read once: a rename
// takes effect at the next launch, which is when the hostname it is read from
// generally settles anyway.
const myLabel = clientLabel();

/** One window, which is to say one client. */
interface Win {
  /** Electrobun's window id, 0 until the window exists. */
  id: number;
  window: BrowserWindow | null;
  /** Pushes into this window's webview, forwarded once its RPC exists. */
  push: ServerPush;
  /** This window's own report about its own wire (wire.ts CLIENT_PUSHES). */
  say(p: { state: "live" | "reconnecting" | "lost"; detail: string }): void;
  /** Land the manual on a page. The other client push, and only ever sent to a
   * window whose `docs` is true. */
  show(p: { page: string }): void;
  /** Whether this window is the manual's (`windowDocs`). One window per app
   * wears it; everything else about it follows — its title, that it saves no
   * layout, that it is not in the saved window list. */
  docs: boolean;
  /** The page it was opened to show, by title; "" for the landing page. Read
   * once, by the view's boot (`windowRole`). */
  page: string;
  manager: ConnectionManager | null;
  /** The connection this window is on, "" until its first attach lands. Set by
   * `attachFor` at the moment the manager commits to a connection, which is why
   * it cannot drift from the manager's own answer. */
  connection: string;
  /** The id this window is known by on that connection. */
  client: string;
  /** What the title bar says: the name of the connection this window is on.
   * Kept here as well as on the window because the manager settles it before
   * there is a window to put it on. */
  title: string;
  /** Where the window was last seen NOT fullscreen: a fullscreen frame is the
   * screen's geometry rather than a choice, and restoring it would open a
   * windowed app at exactly screen size. */
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

// The list, the pins, and the ids filed against them: one per process, however
// many windows (remote.md §8a). `inUse` is what lets a connection another
// window is holding refuse to be removed.
const store = await createConnectionStore({ inUse: () => windows.map((w) => w.connection).filter(Boolean) });

// --- the local server, once, under every window pointed at it ----------------
//
// A second createServer over the same notes root would give this machine two
// watchers, two vaults, two PTY maps, and two consumers of the open-request
// file. So it is built on the first local attach and torn down when the last
// one goes: a window switching away from this Mac still costs its shells, which
// is what it has always cost, and a second window on this Mac now costs
// nothing.
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
 * Tell every window on this Mac who else is here (rpc-schema `presence`).
 *
 * The daemon's job for a server across a wire (bun/daemon.ts announcePresence),
 * and this file's for the one in this process, for the same reason: presence is
 * a fact about who is CONNECTED, and only the thing holding the connections
 * knows. Two windows on this Mac need it as much as a Mac and a phone do —
 * without it, a drawer taken by the other window is taken by nobody in
 * particular (interactions.md §4-2).
 */
function announceLocalPresence(): void {
  const everyone = [...localClients].map(([client, held]) => ({ client, label: held.label }));
  for (const [client, held] of localClients) {
    held.push.presence({ others: everyone.filter((p) => p.client !== client) });
  }
}

// --- opening a connection, for one window ------------------------------------

/**
 * The second window on a server cannot restore what the first one has: they
 * cannot both be the client that server files one layout under. So it boots
 * blank and saves nothing, rather than fighting over the file (remote.md §8a).
 */
function withoutLayout(base: RequestHandlers): RequestHandlers {
  return { ...base, layoutGet: async () => ({ text: null }), layoutSave: async () => ({ ok: true }) };
}

/**
 * Open one connection for one window. The manager decides WHICH and when; this
 * decides how, because how is the only part that needs Electrobun's version
 * string and a child process.
 *
 * The client overlay goes on last in both branches, so the local case and the
 * remote case are the same code path with a different server underneath
 * (remote.md §1): the pasteboard is read here whether the notes are on this
 * disk or on a VPS, and nothing about it is exercised only when connected.
 */
async function attachFor(win: Win, conn: Connection): Promise<Attached> {
  const build = local?.version ?? BUILD_VERSION;
  // Whether another window is already this server's client. Two things follow
  // from it, and they are the same fact twice: the id this window sends, and
  // the name the other one displays for it.
  //
  // The manual's window is not one of them, in either direction. It never takes
  // a connection's id (`blank` below), so a window that opens after it still
  // gets the layout that connection has on file; and it is not counted here, so
  // it cannot make an ordinary window the second client of a server it is the
  // only real client of.
  const others = windows.filter((w) => w !== win && !w.docs && w.connection === conn.id).length;
  const blank = win.docs || others > 0;
  const client = blank ? ephemeralClientId() : await clientIdFor(conn.id);
  // A server displays what it is told (remote.md §5), and "iPhone took this
  // shell" naming the Mac you are looking at would be worse than no name. The
  // manual's window is named for what it is: it shows up in presence like any
  // client — its demo blocks run real shells on this server — and "MacBook"
  // twice would be the row nobody can act on.
  const label = win.docs ? `${myLabel} (manual)` : others > 0 ? `${myLabel} (${others + 1})` : myLabel;
  const token = ++attachToken;
  const arrived = (): void => {
    win.connection = conn.id;
    win.client = client;
    // Which window is which client of which server, which is the one fact that
    // makes a two-window log readable at all: every line after this that names
    // a client id is naming one of these.
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
      // Nothing to ask: the server is in this process, and a link that cannot
      // drop cannot be hurried.
      recheck: () => {},
      shutdown: () => {
        // Only while it is still the registration this attach made: re-selecting
        // a local connection whose wire was declared lost attaches again under
        // the same id, and the old one must not delete the new one on its way
        // out. The daemon makes the same check for the same reason.
        if (localClients.get(client)?.token === token) {
          localClients.delete(client);
          announceLocalPresence();
        }
        releaseLocal();
      },
    };
  }

  if (conn.auth === "password") {
    // Asked here rather than left to ssh. A missing item reaches the user as
    // "Permission denied (password)", which sends them to check a password
    // that is right on a server that is fine — the fault is on this Mac, and
    // this is the only place that can say so.
    if (!(await hasPassword(conn.id))) {
      throw new Error(`no password is stored for ${conn.name} on this Mac. Edit the connection and enter it again`);
    }
    // Written here rather than at boot, because only a password connection
    // needs it: a Mac that never uses one never grows the file, and a
    // connection that starts using one cannot find a script an older version
    // left behind.
    await ensureAskpass();
  }
  const { argv, env } = sshDial(conn, {
    knownHosts: KNOWN_HOSTS_PATH,
    userKnownHosts: userKnownHosts(),
    askpass: ASKPASS_PATH,
  });
  // What ssh said on its way out, kept because it is the only account of a
  // failure that happens before the protocol starts (connections.ts
  // explainDial). Bounded: ssh is not chatty, but a login shell on the far end
  // can be, and this is a diagnosis rather than a log.
  let said = "";
  const listen = (text: string): void => {
    // Logged as it arrives as well as kept, and this is a second thing the
    // capture buys: ssh's stderr also carries the REMOTE server's own log
    // lines, which under an inherited stderr went straight to a descriptor and
    // never reached startLogging. They are in the log file now, named by the
    // machine they came from. console.log rather than warn because most of
    // what comes through is a server talking, not a failure.
    for (const line of text.split("\n")) if (line.trim()) console.log(`[ssh] ${conn.name}: ${line.trim()}`);
    said = (said + text).slice(-4096);
  };
  // Reconnecting, because an ssh over a real network dies for reasons that
  // have nothing to do with either end: a laptop lid, a changed network, an
  // idle timeout on a middlebox. The dial is re-run each attempt, so a fresh
  // ssh is spawned every time rather than a dead one being poked.
  //
  // Throws when the two ends disagree about the protocol, with both versions
  // named, and when the ssh child dies before saying anything (a refused key,
  // an unknown host, no route). Either way the manager keeps the connection
  // that is already working and reports this one, so the throw is the whole
  // error handling: nothing here has to decide what to do about it — except to
  // put ssh's words in front of the transport's, since the transport was never
  // there to see it.
  const wire = await reconnectingClient({
    // The environment goes with every rung of the ladder, not just the first:
    // a reconnect is a fresh ssh, and it needs the same helper the first one
    // was pointed at (bun/secrets.ts).
    dial: () => spawnDuplex(argv, { env, onStderr: listen }),
    push: win.push,
    build,
    client,
    label,
    // The same ask a phone makes, for the same reason (shared/transport.ts
    // SESSION_HOLD_MS): a lid that closes for the length of a meeting, a lift,
    // or a walk between buildings should not cost the shells on the other end,
    // and a Mac that asked for nothing lost them to the daemon's idle timer
    // however briefly it had been away.
    hold: SESSION_HOLD_MS,
    onState: (state, detail) => {
      if (state !== "live") console.warn(`[connect] ${conn.name}: ${detail}`);
      // A ladder that ran out, or a server that said goodbye. The manager has
      // to know, or choosing this same connection again — the recovery the
      // chrome offers, and the only one there is — would be the no-op it is
      // for a connection that is already working (connectionManager.ts).
      if (state === "lost") win.manager?.lost(conn.id, detail);
      // A wire that came back on its own, which it now does: the ladder ends in
      // a beat rather than a wall (shared/transport.ts). Without this the
      // recovery would be invisible to the manager, and choosing this same
      // connection afterwards would rebuild a session that was already working.
      if (state === "live") win.manager?.restored(conn.id);
      win.say({ state, detail });
    },
    // Only the first dial reaches this: reconnectingClient resolves once the
    // wire is up, so everything after that is the ladder's business.
  }).catch((err: unknown) => {
    // A refused handshake keeps its own words. ssh explains what happens
    // before the protocol starts, and it is the better account of all of it —
    // but once the two ends have exchanged hellos, the last thing on stderr is
    // the far end's `serve` announcing that it attached, and reporting THAT as
    // the reason a connection failed says a server is unreachable by quoting
    // the line where it says it is up (shared/transport.ts `Refused`).
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
// (interactions.md §10), so two views pushing into it have to be arbitrated
// rather than merged: the focused window fills it, and a click goes back to
// that window alone. It is the one place this process decides between windows
// instead of routing between them.
let focused: Win | null = null;

function applyMenu(win: Win): void {
  if (win.menu) ApplicationMenu.setApplicationMenu(win.menu as ApplicationMenuItemConfig[]);
}

/** This window's half of the client seams: the menu bar it fills while it is
 * focused, the verbs that open another window, and what this one is. */
function nativeFor(win: Win): ClientNative {
  return {
    ...sharedNative,
    setMenu: (items) => {
      win.menu = items;
      // A push from a window nobody is looking at is remembered, not applied:
      // the bar in front of the user describes the window in front of the user.
      if (focused === win || focused === null) applyMenu(win);
    },
    newWindow: () => void openWindow(LOCAL_ID),
    docsWindow: (page) => showDocs(page),
    windowRole: () => ({ docs: win.docs, page: win.page }),
  };
}

// One manual window at a time, including while one is being built: a window
// joins `windows` inside buildWindow, which is deferred behind whatever else is
// opening, so "is there one already" is not answerable from the list alone.
let docsOpening: Promise<void> | null = null;

/**
 * The manual, in the window that holds it (remote.md §8a).
 *
 * One window per app, because the corpus is read-only and identical in every
 * copy of it: a second one would be two windows onto the same fixed pages, both
 * of them scrolled somewhere different. So an app already showing the manual
 * raises that window instead, and the page asked for is shown there — the
 * licenses have to appear when the licenses are what was clicked, whether or
 * not the manual was already up.
 *
 * An ask that arrives while a manual window is still opening WAITS for it and
 * then takes the raise path, rather than being dropped: the second ask may name
 * a page, and dropping it would answer Help > Third-Party Licenses with the
 * front page.
 *
 * It opens on the LOCAL connection whatever window asked for it. The manual is
 * this app's own, compiled into this build (bun/docsContent.ts) and synced to
 * the local docs root at every launch; a remote server's copy would be whatever
 * version happens to be installed over there.
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
    // The failure branch does nothing: openWindow already logged it, and a
    // window that did not open has nothing to raise.
    void docsOpening.then(() => showDocs(page), () => {});
    return;
  }
  docsOpening = openWindow(LOCAL_ID, undefined, { page }).finally(() => {
    docsOpening = null;
  });
  docsOpening.catch(() => {});
}

// --- the windows themselves ---------------------------------------------------

// Primary first: fitFrame falls back to workAreas[0] when a saved frame
// matches no attached display, and "somewhere in the middle of the main
// screen" is the only sane place to put a window nobody can locate.
function workAreas(): Rect[] {
  try {
    const displays = Screen.getAllDisplays();
    return displays
      .filter((d) => d.workArea.width > 0 && d.workArea.height > 0)
      .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))
      .map((d) => d.workArea);
  } catch (err) {
    // fitFrame reads an empty list as "no evidence" and honors the saved
    // frame, which is the right answer: the screens have not changed, only
    // our ability to ask about them.
    console.warn("[window] could not read the displays:", err);
    return [];
  }
}

// How far a window opened by hand sits from the one it was opened over. AppKit
// cascades new windows for the same reason: two windows at identical
// coordinates look like one window.
const CASCADE = 28;

// What the manual's window is called, whichever machine the window it was
// opened from is on: the pages in it are this app's own.
const DOCS_TITLE = "Documentation";

/**
 * Title a window after the connection it is on (remote.md §8a).
 *
 * The app's name is not in it. Two windows both saying "Ledge" is what the
 * title bar, the Window menu and the App Exposé grid all showed before this,
 * and the one thing a person needs from them is which machine they are looking
 * at — the app they can see. It follows the connection rather than the note in
 * front of it because a window is a client: what changes underneath it is the
 * machine, and the notes are named by their own tabs.
 *
 * The manual's window is the exception the rule explains: it is a client of
 * this Mac, but what a person needs from its title is not which machine —
 * every copy of the manual is the same one — but that this is the manual.
 */
function nameWindow(win: Win, name: string): void {
  win.title = win.docs ? DOCS_TITLE : name;
  // Null before the window is built, which is where the first report lands;
  // `buildWindow` reads win.title back when it constructs one.
  win.window?.setTitle(win.title);
}

function snapshot(): WindowState[] {
  // The manual's window is not in the list, so a launch never reopens it. It is
  // one click away, it holds nothing a person put there, and a session that
  // ended with only the manual open would otherwise come back as an app with
  // its help up and no notes in sight.
  return windows
    .filter((w) => !w.docs)
    .map((w) => ({ frame: w.frame, connection: w.connection || LOCAL_ID }));
}

function saveWindows(): void {
  // Never the empty list. Closing the last window IS quitting, and a file
  // saying "no windows" would open the next launch onto a window it had to
  // invent anyway — with the wrong connection and the wrong frame. Closing the
  // last window that is not the manual reaches the same rule through the
  // filter above: the list that stands is the one from before it went.
  const state = snapshot();
  if (state.length === 0) return;
  writeWindows(state);
}

// Remember where a window was left. Debounced because macOS emits move and
// resize continuously through a drag, and the file would otherwise be written
// at frame rate; the timer is started by the FIRST event of a burst, not
// restarted by each, so a long drag costs one write per interval and the final
// position still lands one interval after the mouse stops.
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

// Opening is serialized: the id a window sends and the label it presents both
// depend on which connections the OTHER windows are already on, and two opens
// interleaving would each answer that question before the other had arrived.
let opening: Promise<unknown> = Promise.resolve();

// `docs` opens the manual's window rather than an ordinary one, on the page it
// names (showDocs above owns the rule that there is only ever one).
function openWindow(want: string, frame?: Rect, docs?: { page: string }): Promise<void> {
  const next = opening.then(
    () => buildWindow(want, frame, docs),
    () => buildWindow(want, frame, docs),
  );
  opening = next;
  return next;
}

async function buildWindow(want: string, frame?: Rect, docs?: { page: string }): Promise<void> {
  // Null until the RPC exists, which happens in the same synchronous run as
  // the manager below returns, so no timer or fs event can observe it; the
  // optional call is the belt.
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
    // Replaced by the manager's first report, which lands before the window
    // below is built (and by nameWindow's own answer for the manual's window).
    // It stands only if a window ever opens without one.
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
      // Where the next launch reads this window's server from, written the
      // moment it changes rather than at quit: a switch that a crash swallowed
      // would otherwise reopen the window on the machine it left.
      onSelect: () => saveWindows(),
      onName: (name) => nameWindow(win, name),
    });
  } catch (err) {
    // Nothing to put a webview on. One window failing to open must not take
    // the others with it, and the first one failing is the old fatal.
    windows.splice(windows.indexOf(win), 1);
    console.error("[window] could not open a window:", err);
    throw err;
  }

  rpc = defineLedgeRPC(win.manager.requests);
  const browser = new BrowserWindow({ title: win.title, url: await mainViewUrl(), rpc, frame: start });
  win.window = browser;
  win.id = browser.id;

  // The move/resize payloads, never getFrame(): the events report the CONTENT
  // size — the same thing the `frame:` option above sets — while getFrame()
  // returns the window including its 28px title bar. Saving one and restoring
  // through the other would shrink the window by a title bar on every launch.
  // (Both agree on x/y, and both are top-left-origin in the same global space
  // as Screen's work areas, which is what makes fitFrame's overlap test mean
  // anything. Verified live: a window handed y=0 comes back at y=33, the
  // menu bar's height, which only happens if y counts down from the top.)
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
  // Not on blur: macOS blurs the window you left before focusing the one you
  // arrived at, and a menu click that landed in between would have nowhere to
  // go. Focus moves; it is never handed back.
  browser.on("close", () => closeWindow(win));

  saveWindows();
}

// A new window opened by hand starts where the focused one is, one step down
// and across, rather than exactly on top of it. Null when there is no window to
// cascade from, which fitFrame turns into the shipped default. Read before the
// new window joins the list, so the last entry is the newest EXISTING one.
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
  // Its connection goes with it: the ssh child is this window's, and the local
  // server's last holder leaving is what tears that down (releaseLocal).
  win.manager?.shutdown();
  // After the shutdown, so the arrangement saved is the one that is left.
  saveWindows();
}

// --- boot ---------------------------------------------------------------------

// The windows that were open when this app last quit, each on the connection it
// was pointed at (remote.md §8a). One on the stored selection when there is no
// list to read — a fresh install, or a client home that lost the file.
const restore = readWindows(store.launchSelection());
const wanted: WindowState[] = restore.length > 0 ? restore : [{ frame: fitFrame(null, workAreas()), connection: store.launchSelection() }];

// The menu bar's two edges. The view owns the real menu (commands/menu.ts,
// pushed through menuSet) — this side is the fallback that exists before its
// first push, and the click route back.
//
// The fallback is not cosmetic: without an application menu there is no ⌘Q,
// so a view that fails to load would leave a window with no way out. Quit and
// the edit roles are the whole of it; the view's push replaces it wholesale.
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

// A clicked item carries the command id the view put in its `action`; the
// shell forwards it without knowing what it means, to the focused window and no
// other — the bar it was clicked in is that window's. Role items never arrive
// here: AppKit runs those down the responder chain and the WebView answers.
ApplicationMenu.on("application-menu-clicked", (event) => {
  const action = (event as { data?: { action?: unknown } }).data?.action;
  if (typeof action === "string" && action.length > 0) (focused ?? windows[0])?.push.menuCommand({ action });
});

for (const [at, state] of wanted.entries()) {
  // Sequential, so each window knows which connections the ones before it took.
  // A window that cannot open costs itself: the local fallback inside the
  // manager covers a server that will not answer, and this covers the rest.
  await openWindow(state.connection, state.frame).catch((err) => {
    console.error(`[window] window ${at + 1} did not open:`, err);
  });
}

if (windows.length === 0) {
  console.error("[bun] no window opened; exiting");
  process.exit(1);
}

process.on("exit", () => {
  // A resize or drag in the last FRAME_SAVE_MS before ⌘Q would otherwise be
  // lost. No FFI here — the windows may already be gone — so this leans on the
  // cached fullscreen flag rather than asking again.
  for (const win of windows) if (win.save && win.windowed) win.frame = win.reported;
  saveWindows();
  for (const win of windows) win.manager?.shutdown();
});

console.log("[bun] Ledge started (per-note shells, spawned on first use); app home:", APP_HOME);
