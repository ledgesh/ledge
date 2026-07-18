import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Electrobun, { Electroview } from "electrobun/view";
import type { LedgeRPC, NoteMeta, TrashMeta, WorkspaceRootInfo } from "../shared/rpc-schema";
import { configureBridge, dispatchRunEvent, setTerminalBusy } from "./editor/bridge";
import { bytesToB64, configureTerminal, dispatchTerminalOutput, dispatchTerminalExit } from "./terminal/channel";
import { configureNotes, dispatchExternalOpen, dispatchNotesChanged } from "./notes/channel";
import { configureWorkspaces, recordWorkspaceKinds } from "./workspace/channel";
import { configureClipboard } from "./lib/clipboard";
import { configureCli } from "./lib/cli";
import { configureAssets } from "./lib/assets";
import { configureSettings } from "./lib/settings";
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
    },
  },
});

const electrobun = new Electrobun.Electroview({ rpc });

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
});

// Note images: bytes for `![](.ledge-assets/…)` references, and the pasteboard-image
// half of ⌘V. References resolve against the asking note's workspace folder;
// Bun guards both and names the pasted file.
configureAssets({
  read: (folder, src) => electrobun.rpc!.request.assetRead({ root: folder, src }).then((r) => r.image),
  pasteImage: (folder) => electrobun.rpc!.request.assetPaste({ root: folder }).then((r) => r.src),
});

// Bun owns the workspace folders; the view only ever holds roots and paths it
// got from here.
configureWorkspaces({
  list: () => electrobun.rpc!.request.workspaceList({}).then((r) => r.workspaces),
  create: (name) => electrobun.rpc!.request.workspaceCreate({ name }).then((r) => r.root),
  attach: () => electrobun.rpc!.request.workspaceAttach({}),
  detach: (root) => electrobun.rpc!.request.workspaceDetach({ root }).then((r) => r.ok),
});

configureNotes({
  list: (folder) => electrobun.rpc!.request.noteList({ root: folder }).then((r) => r.notes),
  read: (path) => electrobun.rpc!.request.noteRead({ path }).then((r) => r.note),
  search: (folder, query) => electrobun.rpc!.request.noteSearch({ root: folder, query }).then((r) => r.hits),
  write: (path, text, baseMtimeMs) => electrobun.rpc!.request.noteWrite({ path, text, baseMtimeMs }),
  create: (folder, text) => electrobun.rpc!.request.noteCreate({ root: folder, text }).then((r) => r.note),
  retitle: (path, text) => electrobun.rpc!.request.noteRetitle({ path, text }).then((r) => r.note),
  remove: (path) => electrobun.rpc!.request.noteDelete({ path }).then((r) => r.trashed),
  trash: (folder) => electrobun.rpc!.request.trashList({ root: folder }).then((r) => r.items),
  restore: (path) => electrobun.rpc!.request.trashRestore({ path }).then((r) => r.note),
  removeTrashed: (path) => electrobun.rpc!.request.trashDelete({ path }).then((r) => r.removed),
  empty: (folder) => electrobun.rpc!.request.trashEmpty({ root: folder }).then((r) => r.removed),
  takeOpenRequest: () => electrobun.rpc!.request.openRequestTake({}).then((r) => r.open),
  configureSession: (sessionId, params, notePath) => {
    void electrobun.rpc!.request.sessionConfigure({ sessionId, params, notePath });
  },
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
    roots = await electrobun.rpc!.request.workspaceList({}).then((r) => r.workspaces);
    // This fetch bypasses the channel wrapper, so record kinds explicitly:
    // the per-workspace default cwd needs them (workspace/channel.ts).
    recordWorkspaceKinds(roots);
    const available = roots.filter((w) => w.available).map((w) => w.root);
    [settings, layout] = await Promise.all([
      electrobun.rpc!.request.settingsGet({}).then((r) => r.settings),
      electrobun.rpc!.request.layoutGet({}).then((r) => r.text),
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
  configureSettings(settings, {
    openFile: () => {
      void electrobun.rpc!.request.settingsOpen({});
    },
    readProfile: (name) => electrobun.rpc!.request.profileRead({ name }).then((r) => r.text),
    writeProfile: async (name, text) => {
      await electrobun.rpc!.request.profileWrite({ name, text });
    },
  });
  configureCli({
    install: () => electrobun.rpc!.request.cliInstall({}),
  });
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App initial={restoredState(layout, roots, notesByFolder, trashByFolder)} />
    </StrictMode>,
  );
}

void boot();

