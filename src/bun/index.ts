// Ledge on macOS: the native shell around the server.
//
// One native window loads the editor webview, and every request it makes is
// served by bun/server.ts in this same process. This file owns only what is
// AppKit's: the window and its geometry, the application menu, the updater,
// the native folder dialog, and the pasteboard's flavor list. The server owns
// the notes, the shells, and the watchers, and imports none of it (remote.md
// §1) — which is what lets the same handlers be served over a socket to
// another machine without a second implementation.
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
import { fitFrame, readFrame, writeFrame, type Rect } from "./windowFrame";
import { startLogging } from "./log";
import { EXTRACTION_DIRNAME, pruneExtractionDir } from "./updateCache";
import { APP_HOME } from "./workspaces";
import { createServer, type Audience, type NativeDeps } from "./server";
import type { RequestHandlers, ServerPush } from "../shared/wire";
import { clientOverlay, type ClientNative } from "./clientSeams";
import { imageFromFile } from "./clipboard";
import { clientId } from "./clientHome";
import { createConnectionManager, type Attached, type ConnectionManager } from "./connectionManager";
import { KNOWN_HOSTS_PATH, sshCommand, userKnownHosts, type Connection } from "./connections";
import { reconnectingClient } from "../shared/transport";
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
const clientNative: ClientNative = {
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
  setMenu: (items) => ApplicationMenu.setApplicationMenu(items as ApplicationMenuItemConfig[]),
};

// The push side, forwarded to the RPC once it exists. `rpc` is assigned in the
// same synchronous run as the await below returns, so no timer or fs event can
// observe the null; the optional call is the belt.
//
// Enumerated rather than proxied on purpose: a message added to the schema
// fails to compile here until it is wired, which is the check worth having.
function defineLedgeRPC(requests: RequestHandlers) {
  return BrowserView.defineRPC<LedgeRPC>({
    maxRequestTime: 10_000,
    handlers: { requests, messages: {} },
  });
}

let rpc: ReturnType<typeof defineLedgeRPC> | null = null;
const push: ServerPush = {
  runEvent: (p) => rpc?.send.runEvent(p),
  terminalOutput: (p) => rpc?.send.terminalOutput(p),
  terminalBusy: (p) => rpc?.send.terminalBusy(p),
  terminalExit: (p) => rpc?.send.terminalExit(p),
  notesChanged: (p) => rpc?.send.notesChanged(p),
  openExternal: (p) => rpc?.send.openExternal(p),
  vaultChanged: (p) => rpc?.send.vaultChanged(p),
  menuCommand: (p) => rpc?.send.menuCommand(p),
};

// The same window, addressed both ways (bun/server.ts Audience). A local server
// has exactly one client and it is this one, so the only id that can reach `to`
// is `me`: the runs were filed under it and the drawers were attached by it.
// The routing that means something lives in the daemon, which is the only place
// there is more than one client to route between.
const audience: Audience = { all: push, to: () => push };

// This side's own push, not a server's (wire.ts CLIENT_PUSHES). Whether the
// wire is up is a fact the end holding it reports; the far end is by
// definition unreachable at the moment it matters.
const sayConnectionState = (p: { state: "live" | "reconnecting" | "lost"; detail: string }) => rpc?.send.connectionState(p);

// The same id whether the server is in this process or across a connection:
// the arrangement this Mac left behind is this Mac's either way (remote.md §5).
const me = await clientId();

// Null until the manager exists, and `attach` below closes over it: the FIRST
// connection is opened by createConnectionManager itself, so nothing can hand
// the manager to the thing that builds it. Only the drop report reads it, and
// a connection cannot be lost before it has been made.
let manager: ConnectionManager | null = null;

/**
 * Open one connection. The manager decides WHICH and when; this decides how,
 * because how is the only part that needs Electrobun's version string and a
 * child process.
 *
 * The client overlay goes on last in both branches, so the local case and the
 * remote case are the same code path with a different server underneath
 * (remote.md §1): the pasteboard is read here whether the notes are on this
 * disk or on a VPS, and nothing about it is exercised only when connected.
 */
async function attach(conn: Connection): Promise<Attached> {
  const build = local?.version ?? BUILD_VERSION;
  if (conn.destination === "") {
    const server = await createServer({ push: audience, native });
    return {
      requests: await clientOverlay(server.forClient(me), clientNative),
      build,
      shutdown: () => server.shutdown(),
    };
  }
  const argv = sshCommand(conn, KNOWN_HOSTS_PATH, userKnownHosts());
  // Reconnecting, because an ssh over a real network dies for reasons that
  // have nothing to do with either end: a laptop lid, a changed network, an
  // idle timeout on a middlebox. The dial is re-run each attempt, so a fresh
  // ssh is spawned every time rather than a dead one being poked.
  //
  // Throws when the two ends disagree about the protocol, with both versions
  // named, and when the ssh child dies before saying anything (a refused key,
  // an unknown host, no route). Either way the manager keeps the connection
  // that is already working and reports this one, so the throw is the whole
  // error handling: nothing here has to decide what to do about it.
  const wire = await reconnectingClient({
    dial: () => spawnDuplex(argv),
    push,
    build,
    client: me,
    onState: (state, detail) => {
      if (state !== "live") console.warn(`[connect] ${conn.name}: ${detail}`);
      // A ladder that ran out, or a server that said goodbye. The manager has
      // to know, or choosing this same connection again — the recovery the
      // chrome offers, and the only one there is — would be the no-op it is
      // for a connection that is already working (connectionManager.ts).
      if (state === "lost") manager?.lost(conn.id, detail);
      sayConnectionState({ state, detail });
    },
  });
  const peer = await wire.ready;
  console.log(`[connect] ${conn.name} (${conn.destination}): ledge-server ${peer.build}`);
  return {
    requests: await clientOverlay(wire.requests, clientNative),
    build: peer.build,
    shutdown: () => wire.close(),
  };
}

manager = await createConnectionManager({ attach });
const { requests, shutdown } = manager;

rpc = defineLedgeRPC(requests);

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
// shell forwards it without knowing what it means. Role items never arrive
// here — AppKit runs those down the responder chain and the WebView answers.
ApplicationMenu.on("application-menu-clicked", (event) => {
  const action = (event as { data?: { action?: unknown } }).data?.action;
  if (typeof action === "string" && action.length > 0) push.menuCommand({ action });
});

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

const startFrame = fitFrame(readFrame(), workAreas());

const mainWindow = new BrowserWindow({
  title: "Ledge",
  url: await mainViewUrl(),
  rpc,
  frame: startFrame,
});

// Remember where the window was left. Debounced because macOS emits move and
// resize continuously through a drag, and the file would otherwise be written
// at frame rate; the timer is started by the FIRST event of a burst, not
// restarted by each, so a long drag costs one write per interval and the final
// position still lands one interval after the mouse stops.
const FRAME_SAVE_MS = 400;
let frameSave: ReturnType<typeof setTimeout> | null = null;
let lastFrame = startFrame;
// Last known "not fullscreen". A fullscreen frame is the SCREEN's geometry,
// not a choice, and restoring it would open a windowed app at exactly screen
// size — so those frames are dropped and the previous windowed one stands.
let windowed = true;

function saveFrameNow(): void {
  if (frameSave) clearTimeout(frameSave);
  frameSave = null;
  windowed = !mainWindow.isFullScreen();
  if (windowed) writeFrame(lastFrame);
}

function noteFrame(next: Partial<Rect>): void {
  lastFrame = { ...lastFrame, ...next };
  if (!frameSave) frameSave = setTimeout(saveFrameNow, FRAME_SAVE_MS);
}

// The move/resize payloads, never getFrame(): the events report the CONTENT
// size — the same thing the `frame:` option above sets — while getFrame()
// returns the window including its 28px title bar. Saving one and restoring
// through the other would shrink the window by a title bar on every launch.
// (Both agree on x/y, and both are top-left-origin in the same global space
// as Screen's work areas, which is what makes fitFrame's overlap test mean
// anything. Verified live: a window handed y=0 comes back at y=33, the
// menu bar's height, which only happens if y counts down from the top.)
mainWindow.on("move", (event) => {
  const { x, y } = (event as { data: { x: number; y: number } }).data;
  noteFrame({ x, y });
});
mainWindow.on("resize", (event) => {
  const { x, y, width, height } = (event as { data: Rect }).data;
  noteFrame({ x, y, width, height });
});

process.on("exit", () => {
  // A resize or drag in the last FRAME_SAVE_MS before ⌘Q would otherwise be
  // lost. No FFI here — the window may already be gone — so this leans on the
  // cached fullscreen flag rather than asking again.
  if (frameSave && windowed) writeFrame(lastFrame);
  shutdown();
});

console.log("[bun] Ledge started (per-note shells, spawned on first use); app home:", APP_HOME);
void mainWindow;
