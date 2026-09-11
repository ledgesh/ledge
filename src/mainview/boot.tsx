// The view, bound to a server. Everything an entry point does except say which
// server and how to reach it: the seams, the boot prefetch, and the render.
// One view, three shells (ios.md §1). The Mac and the phone both bind the seams
// to a real server's handler map, and differ only in how a request becomes
// bytes, which is bootView's `requests` argument. The harness binds them to an
// in-memory fake instead. This file lived in main.tsx until phase 3 of ios.md.
// A second copy of it in an entry point would be the third version ios.md §1
// warns about: two halves of one client that can drift apart and mismatch.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { NoteMeta, TrashMeta, WorkspaceRootInfo } from "../shared/rpc-schema";
import type { RequestClient, ViewPush } from "../shared/wire";
import { configureBridge, dispatchRunEvent, dispatchRunLink, reconcileRuns, setTerminalBusy } from "./editor/bridge";
import {
  bytesToB64,
  configureTerminal,
  dispatchTerminalOutput,
  dispatchTerminalExit,
  dispatchTerminalDetached,
  dispatchTerminalRelink,
} from "./terminal/channel";
import { configureNotes, dispatchExternalOpen, dispatchNotesChanged, dispatchNotesRelink } from "./notes/channel";
import { configureVault, recordVaultState, refreshVaultState } from "./vault/channel";
import { configureWorkspaces, recordDailyRoot, recordWorkspaceKinds } from "./workspace/channel";
import { configureClipboard } from "./lib/clipboard";
import { configureMenu, dispatchNativeCommand } from "./lib/menu";
import { configureCli } from "./lib/cli";
import { configureWindows, dispatchDocsShow, recordWindowRole } from "./lib/windows";
import { captureFailures, configureLog } from "./lib/log";
import { hideBooting, showBooting } from "./lib/booting";
import { configureAssets } from "./lib/assets";
import { configureSettings } from "./lib/settings";
import { recordServerCaps } from "./lib/shell";
import { configureConnections, reconnectLink, recordLinkState, recordPresence, type ConnectionStatus } from "./lib/connections";
import { holdSaves } from "./notes/store";
import { resolveStrandedNotes } from "./workspace/editorPool";
import { applyAppearance } from "./lib/theme";
import { DEFAULT_SETTINGS, type Settings } from "../shared/settings";
import { configureLayout, restoredState } from "./workspace/persist";
import { docsState } from "./workspace/store";
// Imported here rather than in an entry point, because this is the file that
// renders. A shell that forgot the import would build fine and open an
// unstyled app.
import "./index.css";
import App from "./App";

/**
 * Every push, dispatched into the channel that owns it.
 *
 * Both shells use the same object: Electrobun's `messages` map, and the `push`
 * `clientConnection` delivers an arriving frame to. It is typed as ViewPush
 * rather than ServerPush because it also answers `connectionState`, which no
 * server may send and which each shell raises about its own wire (wire.ts
 * CLIENT_PUSHES). Enumerated rather than proxied, for bun/index.ts's reason in
 * the other direction: that file lists the requests coming in and this one the
 * pushes going out, so a push added to the schema fails to compile until it is
 * wired.
 */
export const viewPush: ViewPush = {
  runEvent: (ev) => dispatchRunEvent(ev),
  terminalOutput: ({ sessionId, dataB64 }) => dispatchTerminalOutput(sessionId, dataB64),
  terminalBusy: ({ sessionId, busy }) => setTerminalBusy(sessionId, busy),
  terminalExit: ({ sessionId }) => dispatchTerminalExit(sessionId),
  terminalDetached: ({ sessionId, by }) => dispatchTerminalDetached(sessionId, by),
  // Who else is on this server, for the connection bar and for naming the
  // device in the `terminalDetached` notice above (lib/connections.ts labelFor,
  // remote.md §7).
  presence: ({ others }) => recordPresence(others),
  notesChanged: ({ root }) => dispatchNotesChanged(root),
  openExternal: (open) => dispatchExternalOpen(open),
  // The vault moved without the view driving it (idle auto-relock), or this is
  // the echo of a transition it did drive. Either way the mirrored state
  // updates and every subscriber (placeholder faces, glyphs, palette faces)
  // re-renders from the one record.
  vaultChanged: ({ state }) => recordVaultState(state),
  menuCommand: ({ action }) => dispatchNativeCommand(action),
  // Sent by the shell, never by a server, and only to the manual's window:
  // somebody asked for a page while that window was already open (remote.md
  // §8a). The shell has raised the window, and this lands it on the page.
  docsShow: ({ page }) => dispatchDocsShow(page),
  // Raised by the shell holding this end of the wire, never by a server: the
  // end on the far side of a dropped wire cannot report it (remote.md §10).
  connectionState: ({ state, detail }) => {
    recordLinkState(state, detail);
    // "live" is only announced for a reconnection: the first connection is the
    // caller's boot, not a state change. It is the moment to ask what became of
    // everything whose pushes went to a dead wire. A restarted server is
    // reconnected to rather than refused, and announces itself as a loss and
    // then a connection so that both branches below run (shared/transport.ts).
    // That server may be a different process, so the calls below ask rather
    // than assume. It answers "never heard of that" to every question, and that
    // is a fine answer to get.
    if (state === "lost") {
      // A connection nothing is coming back from has nowhere to put a save, and
      // the writes would only fail their way back into the buffer. The hold
      // matters most in the instant after the wire returns: a debounce or a
      // window blur landing then would write text typed against a note the
      // server has moved past, and the save guard would let it win
      // (notes/store.ts holdSaves).
      holdSaves();
      // Every panel that was mid-run stops claiming to be (blocks.ts
      // setRunsLink). Here rather than at "reconnecting", to stay in step with
      // the hold above: mid-ladder a request waits and is expected to land, and
      // a run whose events are seconds late is still a run.
      dispatchRunLink(false);
    }
    if (state === "live") {
      // First, and the only one of these with somebody's writing at stake. It
      // decides what becomes of every buffer that never reached the server, and
      // it releases the hold above once it has (editorPool.ts).
      void resolveStrandedNotes();
      // The panels are reopened first, then asked about. reconcileRuns settles
      // them and is asynchronous, so leaving them on "Disconnected" until it
      // answers would keep a stale word on screen for a round trip on a wire
      // that has just come back.
      dispatchRunLink(true);
      void reconcileRuns();
      // A mounted drawer claims its shell again, since its pushes went to the
      // dead wire too (terminal/channel.ts).
      dispatchTerminalRelink();
      // This asks the vault again, since any `vaultChanged` pushed at the dead
      // wire was lost. The idle relock's clock counts note changes clients
      // asked for (bun/server.ts CHANGES_A_NOTE), so it fires behind a client
      // whose wire is down. A relock reaches decrypted buffers through the mirrored state,
      // which evicts them (workspace/editorPool.ts), so a client that never
      // asks keeps a locked note's plaintext on screen until the tab closes.
      // Asking costs nothing: the mirror notifies only on a change.
      void refreshVaultState().catch(() => {});
      // Every `notesChanged` for every root that moved meanwhile was dropped,
      // and no push names them afterwards, so re-read the lot (notes/channel.ts
      // onNotesRelink).
      dispatchNotesRelink();
    }
  },
};

/**
 * Wire every seam to `requests`, then boot and render.
 *
 * Call it as early as the shell can. The logging seam is configured on the
 * first line, so a failure while the rest is still wiring itself up is written
 * to the log.
 */
export function bootView(requests: RequestClient): Promise<void> {
  // First, and outside boot(): boot()'s own catch cannot report a throw that
  // happened before it ran.
  configureLog({
    append: (level, text) => {
      void requests.logAppend({ level, text });
    },
    reveal: () => {
      void requests.logReveal({});
    },
  });
  captureFailures();

  configureBridge({
    runInline: (sessionId, id, code, language, host) => {
      void requests.runBlock({ sessionId, id, code, language, host });
    },
    cancelRun: (sessionId, id) => {
      void requests.cancelRun({ sessionId, id });
    },
    claimRuns: (ids) => requests.inlineClaim({ ids }).then((r) => r.running),
    resizeInline: (sessionId, id, cols, rows) => {
      void requests.inlineResize({ sessionId, id, cols, rows });
    },
    inputInline: (sessionId, id, data) => {
      void requests.inlineInput({ sessionId, id, dataB64: bytesToB64(new TextEncoder().encode(data)) });
    },
    openLink: (url) => {
      void requests.linkOpen({ url });
    },
  });

  configureTerminal({
    sendInput: (sessionId, dataB64) => {
      void requests.terminalInput({ sessionId, dataB64 });
    },
    sendPaste: (sessionId, text, language, host) => {
      void requests.terminalPaste({ sessionId, text, language, host });
    },
    sendResize: (sessionId, cols, rows) => {
      void requests.terminalResize({ sessionId, cols, rows });
    },
    attach: (sessionId, host) => requests.terminalAttach({ sessionId, host }),
    detach: (sessionId) => {
      void requests.terminalDetach({ sessionId });
    },
    status: (sessionId) => requests.terminalStatus({ sessionId }),
    claim: (sessionId) => requests.terminalClaim({ sessionId }),
    closeSession: (sessionId) => {
      void requests.closeSession({ sessionId });
    },
    restartSession: (sessionId) => {
      void requests.sessionRestart({ sessionId });
    },
  });

  configureClipboard({
    write: (text) => {
      void requests.clipboardWrite({ text });
    },
    read: () => requests.clipboardRead({}).then((r) => r.text),
    readRich: () => requests.clipboardReadRich({}),
  });

  // The native menu bar. Fire-and-forget: a push that loses a race with another
  // push is simply the older menu, and the next state change re-pushes. A shell
  // with no menu bar answers it as a no-op (ios.md §11).
  configureMenu({
    set: (items) => {
      void requests.menuSet({ items });
    },
  });

  // Another window is another client (remote.md §8a). Fire-and-forget for the
  // menu's reason: the window either appears or the shell logged why, and
  // nothing here could act on the answer. Whether the verb is offered at all is
  // asked before the call, not learned from it (lib/shell.ts multiWindow).
  //
  // openDocs is the same seam with a page on it: the shell opens the manual's
  // window or raises the one already showing it, and this end never learns
  // which (lib/windows.ts).
  configureWindows({
    open: () => {
      void requests.windowNew({});
    },
    openDocs: (page) => {
      void requests.windowDocs({ page });
    },
  });

  // Note images: bytes for `![](.ledge-assets/…)` references, plus the two ways
  // an image is added (the image half of ⌘V, and Insert Image…).
  // References resolve against the asking note's own folder, inside its
  // workspace. The server guards all of it and names the added file.
  configureAssets({
    read: (folder, src, notePath) =>
      requests.assetRead({ root: folder, src, notePath }).then((r) => (r.sealed ? { sealed: true as const } : r.image)),
    pasteImage: (folder, notePath, dataB64) => requests.assetPaste({ root: folder, notePath, dataB64 }).then((r) => r.src),
    pickImage: (folder, notePath) => requests.assetPick({ root: folder, notePath }).then((r) => r.src),
  });

  // The server owns the workspace folders. The view only ever holds roots and
  // paths it got from there.
  configureWorkspaces({
    list: () => requests.workspaceList({}),
    create: (name) => requests.workspaceCreate({ name }).then((r) => r.root),
    attach: () => requests.workspaceAttach({}),
    detach: (root) => requests.workspaceDetach({ root }).then((r) => r.ok),
    move: (root, home) => requests.workspaceMove({ root, home }),
  });

  configureNotes({
    list: (folder) => requests.noteList({ root: folder }).then((r) => r.notes),
    read: (path) => requests.noteRead({ path }).then((r) => r.note),
    search: (folder, query, scope) => requests.noteSearch({ root: folder, query, folder: scope }),
    backlinks: (path) => requests.noteBacklinks({ path }),
    tags: (folder, scope) => requests.tagList({ root: folder, folder: scope }),
    tagged: (folder, tag) => requests.tagNotes({ root: folder, tag }),
    write: (path, text, baseMtimeMs) => requests.noteWrite({ path, text, baseMtimeMs }),
    stash: (path, text) => requests.noteStash({ path, text }).then((r) => r.stashed),
    create: (folder, text, subfolder) => requests.noteCreate({ root: folder, text, folder: subfolder }).then((r) => r.note),
    retitle: (path, text) => requests.noteRetitle({ path, text }).then((r) => r.note),
    move: (path, subfolder) => requests.noteMove({ path, folder: subfolder }).then((r) => r.note),
    favorite: (path, on) => requests.noteFavorite({ path, on }).then((r) => r.note),
    renameFolder: (folder, subfolder, name) => requests.folderRename({ root: folder, folder: subfolder, name }),
    deleteFolder: (folder, subfolder) => requests.folderDelete({ root: folder, folder: subfolder }),
    remove: (path) => requests.noteDelete({ path }).then((r) => r.trashed),
    trash: (folder) => requests.trashList({ root: folder }).then((r) => r.items),
    restore: (path) => requests.trashRestore({ path }).then((r) => r.note),
    removeTrashed: (path) => requests.trashDelete({ path }).then((r) => r.removed),
    empty: (folder) => requests.trashEmpty({ root: folder }).then((r) => r.removed),
    takeOpenRequest: () => requests.openRequestTake({}).then((r) => r.open),
    openDaily: (folder) => requests.dailyOpen({ root: folder }),
    createFromTemplate: (folder, templatePath, title) =>
      requests.noteFromTemplate({ root: folder, templatePath, title }).then((r) => r.note),
    configureSession: (sessionId, params, notePath) => {
      void requests.sessionConfigure({ sessionId, params, notePath });
    },
  });

  configureVault({
    state: () => requests.vaultState({}).then((r) => r.state),
    create: (passphrase) => requests.vaultCreate({ passphrase }).then((r) => r.ok),
    unlock: (passphrase) => requests.vaultUnlock({ passphrase }).then((r) => r.ok),
    lock: async () => {
      await requests.vaultLock({});
    },
    lockNote: (path) => requests.noteLock({ path }),
    removeLock: (path) => requests.noteRemoveLock({ path }).then((r) => r.note),
    changePassphrase: (passphrase) => requests.vaultChangePassphrase({ passphrase }),
  });

  return boot(requests);
}

// Read the workspace registry, every available workspace's notes, and the saved
// layout before the first render, so the app opens straight into last session's
// workspaces and tabs instead of flashing an empty tab and swapping it out. A
// failure here (the server unreachable) falls through to the empty state rather
// than a blank window, and restoredState turns that into a fresh unsaved tab.
async function boot(requests: RequestClient): Promise<void> {
  // Something on screen while the round trips below run, since until they land
  // `#root` is empty (lib/booting.ts). No destination, because the machine this
  // talks to comes back from `connectionList`, one of those round trips. No
  // cancel button either: the wire is open by the time a view boots, so the
  // only thing left to cancel is the prefetch, and cancelling it would open the
  // app with none of its workspaces. On a phone `ios.tsx` raises the panel
  // before the dial, where it can name the destination and offer the server
  // list as the way out. showBooting keeps that panel and ignores this call.
  showBooting({ destination: "" });
  let roots: WorkspaceRootInfo[] = [];
  const notesByFolder: Record<string, NoteMeta[]> = {};
  const trashByFolder: Record<string, TrashMeta[]> = {};
  let settings: Settings = DEFAULT_SETTINGS;
  let layout: string | null = null;
  // Which window this view is in (remote.md §8a). Asked with the registry
  // rather than after it, because the answer decides which folders are worth
  // listing at all: the manual's window lists one folder and uses no layout.
  let role = { docs: false, page: "" };
  // Which machine everything below belongs to (remote.md §8). Fetched before
  // the first paint, like settings and the layout: the connection bar names the
  // machine the notes and commands go to, and must not name the wrong one even
  // for one frame.
  let connections: ConnectionStatus | null = null;
  try {
    // The registry first, since it names the folders everything else is scoped
    // to. Then one round trip per folder, plus settings and layout, in
    // parallel. Trash counts are part of the first paint (a sidebar section),
    // so fetching them after mount would flash. Editors and terminals read
    // settings at creation and never again (lib/settings.ts), and the layout is
    // the first render's shape, so both must land before that render. Fetching
    // every folder eagerly is what makes the first paint complete. It is fine
    // at ordinary workspace counts, and can go lazy if a huge external folder
    // makes boot crawl. A folder that fails to list costs itself only.
    const [registry, asked] = await Promise.all([requests.workspaceList({}), requests.windowRole({})]);
    roots = registry.workspaces;
    role = asked;
    // Before the first render, like the settings snapshot: the chrome the
    // manual's window does without is decided in the first paint, not swapped
    // out of it (lib/windows.ts).
    recordWindowRole(role);
    // This fetch bypasses the channel wrapper, so record explicitly: kinds
    // for the per-workspace default cwd, the resolved daily root for the
    // Edit Daily Template faces (workspace/channel.ts).
    recordWorkspaceKinds(roots);
    recordDailyRoot(registry.dailyRoot);
    // What the machine holding the notes can do for itself: answer a folder
    // picker, and hand over a CLI to install (lib/shell.ts). Recorded here for
    // the same reason the two above are: this fetch bypasses the channel
    // wrapper, and it is the first round trip, so the answers are in place
    // before the first palette opens.
    recordServerCaps(registry);
    // The manual's window lists one folder, its own. It can show nothing else,
    // and listing a workspace over a big external folder would slow a window
    // that opened only to read the manual.
    const available = roots
      .filter((w) => w.available && (!role.docs || w.kind === "docs"))
      .map((w) => w.root);
    [settings, layout, connections] = await Promise.all([
      requests.settingsGet({}).then((r) => r.settings),
      requests.layoutGet({}).then((r) => r.text),
      requests.connectionList({}),
      ...available.map(async (folder) => {
        const [notes, trash] = await Promise.all([
          requests.noteList({ root: folder }).then((r) => r.notes),
          requests.trashList({ root: folder }).then((r) => r.items),
        ]).catch((err): [NoteMeta[], TrashMeta[]] => {
          console.error("[notes] could not list workspace folder", folder, err);
          return [[], []];
        });
        notesByFolder[folder] = notes;
        trashByFolder[folder] = trash;
      }),
    ]);
  } catch (err) {
    console.error("[notes] could not reach the note store", err);
  }
  // The save half of session persistence. The restore half is restoredState
  // below, which prunes anything the note listings no longer contain.
  configureLayout({
    save: (text) => {
      void requests.layoutSave({ text });
    },
  });
  // Before the first render, for the same reason settings are: the connection
  // bar is drawn in the first paint.
  if (connections) {
    configureConnections(connections, {
      list: () => requests.connectionList({}),
      select: (id) => requests.connectionSelect({ id }),
      reconnect: () => requests.connectionReconnect({}),
      add: (fields) => requests.connectionAdd(fields),
      update: (fields) => requests.connectionUpdate(fields),
      remove: (id) => requests.connectionRemove({ id }),
      probe: (destination, port) => requests.connectionProbe({ destination, port }),
    });
  }
  configureSettings(settings, {
    readSettingsFile: (home) => requests.settingsRead({ home }).then((r) => r.text),
    writeSettingsFile: async (home, text) => {
      await requests.settingsWrite({ home, text });
    },
    readProfile: (name) => requests.profileRead({ name }).then((r) => r.text),
    writeProfile: async (name, text) => {
      await requests.profileWrite({ name, text });
    },
  });
  // Straight after the settings snapshot lands and before the first render. A
  // theme setting can override what index.html stamped, and every editor and
  // terminal built below reads the resolved appearance (lib/theme.ts).
  applyAppearance();
  configureCli({
    install: () => requests.cliInstall({}),
  });
  // A fresh page claims nothing: whatever this server is still running was
  // started by the page this one replaced, and no id survived the reload, so
  // the server interrupts the rest (editor/bridge.ts reconcileRuns). Not
  // awaited, since the window should not wait on it, but sent early: until it
  // lands those runs execute with nothing on screen to show or stop them.
  void reconcileRuns();
  // Not awaited, so it does not gate the render below. The mirrored default
  // ("locked") already renders locked notes as placeholders, and "unlocked"
  // cannot survive a relaunch. The fetch only distinguishes a locked vault from
  // no vault, which is what the dialog's face needs (vault/channel.ts).
  void refreshVaultState().catch(() => {});
  // The operating system says an interface came back. That is a better moment
  // to dial than the retry beat's next tick: a connection failing for an hour
  // often works again the moment the machine joins a network, and the beat
  // cannot know that happened (remote.md §7). A live wire probes and a
  // reconnecting one dials (shared/transport.ts recheck), asking the client's
  // own shell rather than a server (lib/connections.ts reconnectLink).
  window.addEventListener("online", () => reconnectLink());
  // Everything the boot screen was waiting on has landed or failed by here, and
  // the render below replaces it.
  hideBooting();
  // The manual's window boots onto the manual and nothing else. Every other
  // window boots onto the layout it left (remote.md §8a). A missing docs root
  // (an app whose docs sync failed) falls back to the ordinary boot rather than
  // opening a window over no folder at all.
  const docsRoot = role.docs ? (roots.find((w) => w.kind === "docs" && w.available)?.root ?? "") : "";
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App
        initial={
          docsRoot
            ? docsState(docsRoot, notesByFolder[docsRoot] ?? [], role.page)
            : restoredState(layout, roots, notesByFolder, trashByFolder)
        }
      />
    </StrictMode>,
  );
}
