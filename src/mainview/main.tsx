import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Electrobun, { Electroview } from "electrobun/view";
import type { LedgeRPC, NoteMeta, TrashMeta } from "../shared/rpc-schema";
import { configureBridge, dispatchRunEvent, setTerminalBusy } from "./editor/bridge";
import { bytesToB64, configureTerminal, dispatchTerminalOutput, dispatchTerminalExit } from "./terminal/channel";
import { configureNotes } from "./notes/channel";
import { configureClipboard } from "./lib/clipboard";
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
    },
  },
});

const electrobun = new Electrobun.Electroview({ rpc });

configureBridge({
  runInline: (sessionId, id, code, language) => {
    void electrobun.rpc!.request.runBlock({ sessionId, id, code, language });
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
  sendPaste: (sessionId, text, language) => {
    void electrobun.rpc!.request.terminalPaste({ sessionId, text, language });
  },
  sendResize: (sessionId, cols, rows) => {
    void electrobun.rpc!.request.terminalResize({ sessionId, cols, rows });
  },
  attach: (sessionId) => electrobun.rpc!.request.terminalAttach({ sessionId }),
  detach: (sessionId) => {
    void electrobun.rpc!.request.terminalDetach({ sessionId });
  },
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

// Note images: bytes for `![](assets/…)` references, and the pasteboard-image
// half of ⌘V. Bun guards the reference and names the pasted file.
configureAssets({
  read: (src) => electrobun.rpc!.request.assetRead({ src }).then((r) => r.image),
  pasteImage: () => electrobun.rpc!.request.assetPaste({}).then((r) => r.src),
});

// Bun owns the notes folder; the view only ever holds paths it got from here.
configureNotes({
  list: () => electrobun.rpc!.request.noteList({}).then((r) => r.notes),
  read: (path) => electrobun.rpc!.request.noteRead({ path }).then((r) => r.text),
  search: (query) => electrobun.rpc!.request.noteSearch({ query }).then((r) => r.hits),
  write: async (path, text) => {
    await electrobun.rpc!.request.noteWrite({ path, text });
  },
  create: (text) => electrobun.rpc!.request.noteCreate({ text }).then((r) => r.note),
  retitle: (path, text) => electrobun.rpc!.request.noteRetitle({ path, text }).then((r) => r.note),
  remove: (path) => electrobun.rpc!.request.noteDelete({ path }).then((r) => r.trashed),
  trash: () => electrobun.rpc!.request.trashList({}).then((r) => r.items),
  restore: (path) => electrobun.rpc!.request.trashRestore({ path }).then((r) => r.note),
  removeTrashed: (path) => electrobun.rpc!.request.trashDelete({ path }).then((r) => r.removed),
  empty: () => electrobun.rpc!.request.trashEmpty({}).then((r) => r.removed),
  configureSession: (sessionId, params) => {
    void electrobun.rpc!.request.sessionConfigure({ sessionId, params });
  },
});

// Read the notes folder and the saved layout before the first render, so the
// app opens straight into last session's workspaces and tabs instead of
// flashing an empty tab and swapping it out. A failure here (Bun unreachable)
// must not leave a blank window: fall through to the no-notes state, which is
// a fresh unsaved note.
async function boot(): Promise<void> {
  let notes: NoteMeta[] = [];
  let trash: TrashMeta[] = [];
  let settings: Settings = DEFAULT_SETTINGS;
  let layout: string | null = null;
  try {
    // One round trip each, in parallel: the trash count is part of the first
    // paint (it is a sidebar section), so fetching it after mount would flash;
    // settings must beat the first render because editors and terminals read
    // them at creation and never again (lib/settings.ts); the layout must beat
    // it because it IS the first render's shape.
    [notes, trash, settings, layout] = await Promise.all([
      electrobun.rpc!.request.noteList({}).then((r) => r.notes),
      electrobun.rpc!.request.trashList({}).then((r) => r.items),
      electrobun.rpc!.request.settingsGet({}).then((r) => r.settings),
      electrobun.rpc!.request.layoutGet({}).then((r) => r.text),
    ]);
  } catch (err) {
    console.error("[notes] could not list the notes folder", err);
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
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App initial={restoredState(layout, notes, trash)} />
    </StrictMode>,
  );
}

void boot();

