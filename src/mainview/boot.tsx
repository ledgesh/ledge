// The view, bound to a server. Everything an entry point does except say which
// server and how to reach it.
//
// There is one view and three shells (ios.md §1): Electrobun on the Mac,
// Playwright's harness in the e2e suite, and Swift on iOS. The harness binds
// the `configureX` seams to an in-memory fake and so has nothing to share with
// the other two. The Mac and the phone both bind them to a real server's
// handler map, and the ONLY difference between them is how a request becomes
// bytes: `main.tsx` hands it to Electrobun's RPC, `ios.tsx` writes a frame
// down a socket Swift is holding. That difference is one argument to this
// function, and everything downstream of it — the prefetch, the render, which
// seam gets which method, which push updates which channel — is here once.
//
// It was in main.tsx until phase 3 of ios.md, where a second copy of it would
// have been the third version §1 warns about: two halves of one client that
// can drift apart and mismatch each other.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { NoteMeta, TrashMeta, WorkspaceRootInfo } from "../shared/rpc-schema";
import type { RequestClient, ViewPush } from "../shared/wire";
import { configureBridge, dispatchRunEvent, reconcileRuns, setTerminalBusy } from "./editor/bridge";
import {
  bytesToB64,
  configureTerminal,
  dispatchTerminalOutput,
  dispatchTerminalExit,
  dispatchTerminalDetached,
} from "./terminal/channel";
import { configureNotes, dispatchExternalOpen, dispatchNotesChanged } from "./notes/channel";
import { configureVault, recordVaultState, refreshVaultState } from "./vault/channel";
import { configureWorkspaces, recordDailyRoot, recordWorkspaceKinds } from "./workspace/channel";
import { configureClipboard } from "./lib/clipboard";
import { configureMenu, dispatchNativeCommand } from "./lib/menu";
import { configureCli } from "./lib/cli";
import { captureFailures, configureLog } from "./lib/log";
import { configureAssets } from "./lib/assets";
import { configureSettings } from "./lib/settings";
import { recordServerCaps } from "./lib/shell";
import { configureConnections, recordLinkState, type ConnectionStatus } from "./lib/connections";
import { applyAppearance } from "./lib/theme";
import { DEFAULT_SETTINGS, type Settings } from "../shared/settings";
import { configureLayout, restoredState } from "./workspace/persist";
// Here rather than in an entry point, because this is the file that renders:
// a shell that forgot the import would build fine and open an unstyled app.
import "./index.css";
import App from "./App";

/**
 * Every push, dispatched into the channel that owns it.
 *
 * The same object both shells use: Electrobun takes it as its `messages` map,
 * and `clientConnection` takes it as the `push` a frame arriving on the wire
 * is delivered to. Typed as ViewPush rather than ServerPush because it also
 * has to answer `connectionState`, which no server may send and which each
 * shell raises about its own wire (wire.ts CLIENT_PUSHES).
 *
 * Enumerated rather than proxied, for bun/index.ts's reason in the other
 * direction: a message added to the schema fails to compile here until
 * something does it.
 */
export const viewPush: ViewPush = {
  runEvent: (ev) => dispatchRunEvent(ev),
  terminalOutput: ({ sessionId, dataB64 }) => dispatchTerminalOutput(sessionId, dataB64),
  terminalBusy: ({ sessionId, busy }) => setTerminalBusy(sessionId, busy),
  terminalExit: ({ sessionId }) => dispatchTerminalExit(sessionId),
  terminalDetached: ({ sessionId }) => dispatchTerminalDetached(sessionId),
  notesChanged: ({ root }) => dispatchNotesChanged(root),
  openExternal: (open) => dispatchExternalOpen(open),
  // The vault moved without the view driving it (idle auto-relock), or this is
  // the echo of a transition it did drive — either way the mirrored state
  // updates and every subscriber (placeholder faces, glyphs, palette faces)
  // re-renders from the one record.
  vaultChanged: ({ state }) => recordVaultState(state),
  menuCommand: ({ action }) => dispatchNativeCommand(action),
  // From the shell holding this end of the wire, never from a server
  // (remote.md §7).
  connectionState: ({ state, detail }) => {
    recordLinkState(state, detail);
    // "live" is only ever announced for a RE-connection (the first one is the
    // caller's boot, not a state change), which makes it exactly the moment to
    // ask what became of the runs whose events were pushed at a dead wire.
    if (state === "live") void reconcileRuns();
  },
};

/**
 * Wire every seam to `requests`, then boot and render.
 *
 * Call it as early as the shell can: the logging seam is configured on the
 * first line, and a failure while the rest is still wiring itself up is
 * exactly the one worth having on disk.
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

  // Note images: bytes for `![](.ledge-assets/…)` references, and the pasteboard-image
  // half of ⌘V. References resolve against the asking note's workspace folder;
  // the server guards both and names the pasted file.
  configureAssets({
    read: (folder, src) => requests.assetRead({ root: folder, src }).then((r) => (r.sealed ? { sealed: true as const } : r.image)),
    pasteImage: (folder, notePath) => requests.assetPaste({ root: folder, notePath }).then((r) => r.src),
    pickImage: (folder, notePath) => requests.assetPick({ root: folder, notePath }).then((r) => r.src),
  });

  // The server owns the workspace folders; the view only ever holds roots and
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
    search: (folder, query) => requests.noteSearch({ root: folder, query }),
    backlinks: (path) => requests.noteBacklinks({ path }),
    tags: (folder) => requests.tagList({ root: folder }),
    tagged: (folder, tag) => requests.tagNotes({ root: folder, tag }),
    write: (path, text, baseMtimeMs) => requests.noteWrite({ path, text, baseMtimeMs }),
    create: (folder, text) => requests.noteCreate({ root: folder, text }).then((r) => r.note),
    retitle: (path, text) => requests.noteRetitle({ path, text }).then((r) => r.note),
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

// Read the workspace registry, every available workspace's notes, and the
// saved layout before the first render, so the app opens straight into last
// session's workspaces and tabs instead of flashing an empty tab and swapping
// it out. A failure here (the server unreachable) must not leave a blank
// window: fall through to the empty state, which restoredState turns into a
// fresh unsaved note.
async function boot(requests: RequestClient): Promise<void> {
  let roots: WorkspaceRootInfo[] = [];
  const notesByFolder: Record<string, NoteMeta[]> = {};
  const trashByFolder: Record<string, TrashMeta[]> = {};
  let settings: Settings = DEFAULT_SETTINGS;
  let layout: string | null = null;
  // Which machine everything below belongs to (remote.md §8). Fetched before
  // the first paint like settings and the layout: the indicator is chrome, and
  // chrome that names the wrong machine for one frame is the one frame where
  // somebody types a command into it.
  let connections: ConnectionStatus | null = null;
  try {
    // The registry first — it names the folders everything else is scoped to —
    // then one round trip per folder plus settings and layout, in parallel:
    // the trash counts are part of the first paint (a sidebar section), so
    // fetching them after mount would flash; settings must beat the first
    // render because editors and terminals read them at creation and never
    // again (lib/settings.ts); the layout must beat it because it IS the first
    // render's shape. Eager per-folder fetch keeps that first paint complete;
    // fine at human workspace counts (revisit lazily if a huge external folder
    // ever makes boot crawl). A folder that fails to list costs itself only.
    const registry = await requests.workspaceList({});
    roots = registry.workspaces;
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
    const available = roots.filter((w) => w.available).map((w) => w.root);
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
  // The save half of session persistence; the restore half is restoredState
  // below, which prunes anything the noteList no longer vouches for.
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
      add: (fields) => requests.connectionAdd(fields),
      update: (fields) => requests.connectionUpdate(fields),
      remove: (id) => requests.connectionRemove({ id }),
      probe: (destination) => requests.connectionProbe({ destination }),
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
  // Straight after the snapshot lands and before the first render: the palette
  // is a settings override away from what index.html stamped, and every editor
  // and terminal built below reads the resolved answer (lib/theme.ts).
  applyAppearance();
  configureCli({
    install: () => requests.cliInstall({}),
  });
  // A fresh page claims nothing, which is the point: whatever this server is
  // still running was started by the page this one replaced, and no id from it
  // survived the reload (editor/bridge.ts reconcileRuns). Not awaited — the
  // window should not wait on it — but sent early, because until it lands those
  // runs are executing with nothing on screen able to show or stop them.
  void reconcileRuns();
  // After render, not gating it: the mirrored default ("locked") renders
  // locked notes as placeholders either way, which is correct until — and
  // almost always after — this lands ("unlocked" cannot survive a relaunch;
  // the fetch only distinguishes locked from none for the dialog's face).
  void refreshVaultState().catch(() => {});
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App initial={restoredState(layout, roots, notesByFolder, trashByFolder)} />
    </StrictMode>,
  );
}
