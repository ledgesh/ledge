import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Electrobun, { Electroview } from "electrobun/view";
import type { LedgeRPC, NoteMeta, TrashMeta, WorkspaceRootInfo } from "../shared/rpc-schema";
import { configureBridge, dispatchRunEvent, setTerminalBusy } from "./editor/bridge";
import { bytesToB64, configureTerminal, dispatchTerminalOutput, dispatchTerminalExit } from "./terminal/channel";
import { configureNotes, dispatchExternalOpen, dispatchNotesChanged } from "./notes/channel";
import { configureVault, recordVaultState, refreshVaultState } from "./vault/channel";
import { configureWorkspaces, recordDailyRoot, recordWorkspaceKinds } from "./workspace/channel";
import { configureClipboard } from "./lib/clipboard";
import { configureMenu, dispatchMenuCommand } from "./lib/menu";
import { configureCli } from "./lib/cli";
import { captureFailures, configureLog } from "./lib/log";
import { configureAssets } from "./lib/assets";
import { configureSettings } from "./lib/settings";
import { configureConnections, type ConnectionStatus } from "./lib/connections";
import { applyAppearance } from "./lib/theme";
import { DEFAULT_SETTINGS, type Settings } from "../shared/settings";
import { configureLayout, restoredState } from "./workspace/persist";
import "./index.css";
import App from "./App";

// The webview end of the typed RPC. Bun pushes `runEvent` and `terminalOutput`
// messages here; the editor and terminal send requests the other way.
const rpc = Electroview.defineRPC<LedgeRPC>({
  maxRequestTime: 30_000,
  handlers: {
    requests: {},
    messages: {
      runEvent: (ev) => dispatchRunEvent(ev),
      terminalOutput: ({ sessionId, dataB64 }) => dispatchTerminalOutput(sessionId, dataB64),
      terminalBusy: ({ sessionId, busy }) => setTerminalBusy(sessionId, busy),
      terminalExit: ({ sessionId }) => dispatchTerminalExit(sessionId),
      notesChanged: ({ root }) => dispatchNotesChanged(root),
      openExternal: (open) => dispatchExternalOpen(open),
      // The vault moved without the view driving it (idle auto-relock), or
      // this is the echo of a transition it did drive — either way the
      // mirrored state updates and every subscriber (placeholder faces,
      // glyphs, palette faces) re-renders from the one record.
      vaultChanged: ({ state }) => recordVaultState(state),
      menuCommand: ({ action }) => dispatchMenuCommand(action),
    },
  },
});

const electrobun = new Electrobun.Electroview({ rpc });

// First, and outside boot(): a failure while the rest of this file is still
// wiring itself up is exactly the one worth having in the log, and boot()'s
// own catch cannot report a throw that happened before it ran.
configureLog({
  append: (level, text) => {
    void electrobun.rpc!.request.logAppend({ level, text });
  },
  reveal: () => {
    void electrobun.rpc!.request.logReveal({});
  },
});
captureFailures();

configureBridge({
  runInline: (sessionId, id, code, language, host) => {
    void electrobun.rpc!.request.runBlock({ sessionId, id, code, language, host });
  },
  cancelRun: (sessionId, id) => {
    void electrobun.rpc!.request.cancelRun({ sessionId, id });
  },
  resizeInline: (sessionId, id, cols, rows) => {
    void electrobun.rpc!.request.inlineResize({ sessionId, id, cols, rows });
  },
  inputInline: (sessionId, id, data) => {
    void electrobun.rpc!.request.inlineInput({ sessionId, id, dataB64: bytesToB64(new TextEncoder().encode(data)) });
  },
  openLink: (url) => {
    void electrobun.rpc!.request.linkOpen({ url });
  },
});

configureTerminal({
  sendInput: (sessionId, dataB64) => {
    void electrobun.rpc!.request.terminalInput({ sessionId, dataB64 });
  },
  sendPaste: (sessionId, text, language, host) => {
    void electrobun.rpc!.request.terminalPaste({ sessionId, text, language, host });
  },
  sendResize: (sessionId, cols, rows) => {
    void electrobun.rpc!.request.terminalResize({ sessionId, cols, rows });
  },
  attach: (sessionId, host) => electrobun.rpc!.request.terminalAttach({ sessionId, host }),
  detach: (sessionId) => {
    void electrobun.rpc!.request.terminalDetach({ sessionId });
  },
  status: (sessionId) => electrobun.rpc!.request.terminalStatus({ sessionId }),
  closeSession: (sessionId) => {
    void electrobun.rpc!.request.closeSession({ sessionId });
  },
  restartSession: (sessionId) => {
    void electrobun.rpc!.request.sessionRestart({ sessionId });
  },
});

configureClipboard({
  write: (text) => {
    void electrobun.rpc!.request.clipboardWrite({ text });
  },
  read: () => electrobun.rpc!.request.clipboardRead({}).then((r) => r.text),
  readRich: () => electrobun.rpc!.request.clipboardReadRich({}),
});

// The native menu bar. Fire-and-forget: a push that loses a race with another
// push is simply the older menu, and the next state change re-pushes.
configureMenu({
  set: (items) => {
    void electrobun.rpc!.request.menuSet({ items });
  },
});

// Note images: bytes for `![](.ledge-assets/…)` references, and the pasteboard-image
// half of ⌘V. References resolve against the asking note's workspace folder;
// Bun guards both and names the pasted file.
configureAssets({
  read: (folder, src) =>
    electrobun.rpc!.request.assetRead({ root: folder, src }).then((r) => (r.sealed ? { sealed: true as const } : r.image)),
  pasteImage: (folder, notePath) => electrobun.rpc!.request.assetPaste({ root: folder, notePath }).then((r) => r.src),
});

// Bun owns the workspace folders; the view only ever holds roots and paths it
// got from here.
configureWorkspaces({
  list: () => electrobun.rpc!.request.workspaceList({}),
  create: (name) => electrobun.rpc!.request.workspaceCreate({ name }).then((r) => r.root),
  attach: () => electrobun.rpc!.request.workspaceAttach({}),
  detach: (root) => electrobun.rpc!.request.workspaceDetach({ root }).then((r) => r.ok),
  move: (root, home) => electrobun.rpc!.request.workspaceMove({ root, home }),
});

configureNotes({
  list: (folder) => electrobun.rpc!.request.noteList({ root: folder }).then((r) => r.notes),
  read: (path) => electrobun.rpc!.request.noteRead({ path }).then((r) => r.note),
  search: (folder, query) => electrobun.rpc!.request.noteSearch({ root: folder, query }),
  backlinks: (path) => electrobun.rpc!.request.noteBacklinks({ path }),
  tags: (folder) => electrobun.rpc!.request.tagList({ root: folder }),
  tagged: (folder, tag) => electrobun.rpc!.request.tagNotes({ root: folder, tag }),
  write: (path, text, baseMtimeMs) => electrobun.rpc!.request.noteWrite({ path, text, baseMtimeMs }),
  create: (folder, text) => electrobun.rpc!.request.noteCreate({ root: folder, text }).then((r) => r.note),
  retitle: (path, text) => electrobun.rpc!.request.noteRetitle({ path, text }).then((r) => r.note),
  remove: (path) => electrobun.rpc!.request.noteDelete({ path }).then((r) => r.trashed),
  trash: (folder) => electrobun.rpc!.request.trashList({ root: folder }).then((r) => r.items),
  restore: (path) => electrobun.rpc!.request.trashRestore({ path }).then((r) => r.note),
  removeTrashed: (path) => electrobun.rpc!.request.trashDelete({ path }).then((r) => r.removed),
  empty: (folder) => electrobun.rpc!.request.trashEmpty({ root: folder }).then((r) => r.removed),
  takeOpenRequest: () => electrobun.rpc!.request.openRequestTake({}).then((r) => r.open),
  openDaily: (folder) => electrobun.rpc!.request.dailyOpen({ root: folder }),
  createFromTemplate: (folder, templatePath, title) =>
    electrobun.rpc!.request.noteFromTemplate({ root: folder, templatePath, title }).then((r) => r.note),
  configureSession: (sessionId, params, notePath) => {
    void electrobun.rpc!.request.sessionConfigure({ sessionId, params, notePath });
  },
});

configureVault({
  state: () => electrobun.rpc!.request.vaultState({}).then((r) => r.state),
  create: (passphrase) => electrobun.rpc!.request.vaultCreate({ passphrase }).then((r) => r.ok),
  unlock: (passphrase) => electrobun.rpc!.request.vaultUnlock({ passphrase }).then((r) => r.ok),
  lock: async () => {
    await electrobun.rpc!.request.vaultLock({});
  },
  lockNote: (path) => electrobun.rpc!.request.noteLock({ path }),
  removeLock: (path) => electrobun.rpc!.request.noteRemoveLock({ path }).then((r) => r.note),
  changePassphrase: (passphrase) => electrobun.rpc!.request.vaultChangePassphrase({ passphrase }),
});

// Read the workspace registry, every available workspace's notes, and the
// saved layout before the first render, so the app opens straight into last
// session's workspaces and tabs instead of flashing an empty tab and swapping
// it out. A failure here (Bun unreachable) must not leave a blank window:
// fall through to the empty state, which restoredState turns into a fresh
// unsaved note.
async function boot(): Promise<void> {
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
    const registry = await electrobun.rpc!.request.workspaceList({});
    roots = registry.workspaces;
    // This fetch bypasses the channel wrapper, so record explicitly: kinds
    // for the per-workspace default cwd, the resolved daily root for the
    // Edit Daily Template faces (workspace/channel.ts).
    recordWorkspaceKinds(roots);
    recordDailyRoot(registry.dailyRoot);
    const available = roots.filter((w) => w.available).map((w) => w.root);
    [settings, layout, connections] = await Promise.all([
      electrobun.rpc!.request.settingsGet({}).then((r) => r.settings),
      electrobun.rpc!.request.layoutGet({}).then((r) => r.text),
      electrobun.rpc!.request.connectionList({}),
      ...available.map(async (folder) => {
        const [notes, trash] = await Promise.all([
          electrobun.rpc!.request.noteList({ root: folder }).then((r) => r.notes),
          electrobun.rpc!.request.trashList({ root: folder }).then((r) => r.items),
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
      void electrobun.rpc!.request.layoutSave({ text });
    },
  });
  // Before the first render, for the same reason settings are: the connection
  // bar is drawn in the first paint.
  if (connections) {
    configureConnections(connections, {
      list: () => electrobun.rpc!.request.connectionList({}),
      select: (id) => electrobun.rpc!.request.connectionSelect({ id }),
      add: (fields) => electrobun.rpc!.request.connectionAdd(fields),
      remove: (id) => electrobun.rpc!.request.connectionRemove({ id }),
      probe: (destination) => electrobun.rpc!.request.connectionProbe({ destination }),
    });
  }
  configureSettings(settings, {
    readSettingsFile: (home) => electrobun.rpc!.request.settingsRead({ home }).then((r) => r.text),
    writeSettingsFile: async (home, text) => {
      await electrobun.rpc!.request.settingsWrite({ home, text });
    },
    readProfile: (name) => electrobun.rpc!.request.profileRead({ name }).then((r) => r.text),
    writeProfile: async (name, text) => {
      await electrobun.rpc!.request.profileWrite({ name, text });
    },
  });
  // Straight after the snapshot lands and before the first render: the palette
  // is a settings override away from what index.html stamped, and every editor
  // and terminal built below reads the resolved answer (lib/theme.ts).
  applyAppearance();
  configureCli({
    install: () => electrobun.rpc!.request.cliInstall({}),
  });
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

void boot();
