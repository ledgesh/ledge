// The e2e harness entrypoint: the whole app, with the Bun process replaced by
// an in-memory fake at the same seams main.tsx wires (docs/testing.md §5).
//
// main.tsx binds configureNotes/configureTerminal/configureBridge/
// configureClipboard to the live Electrobun RPC; this binds them to a Map. The
// app cannot tell the difference — which is the point: everything above the
// seams (the command registry, focus behavior, the lists, the dialogs) runs
// for real in a real WebKit, driven headlessly by Playwright (e2e/*.spec.ts).
//
// Vite serves this at /harness.html in dev only; the production build's input
// is index.html, so none of this ships.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { NoteMeta, TrashMeta } from "../shared/rpc-schema";
import { headingOf, labelOf, slugOf } from "../shared/slug";
import { configureBridge } from "./editor/bridge";
import { configureTerminal } from "./terminal/channel";
import { configureNotes } from "./notes/channel";
import { configureClipboard } from "./lib/clipboard";
import { configureSettings } from "./lib/settings";
import { DEFAULT_SETTINGS } from "../shared/settings";
import { initialState } from "./workspace/store";
import "./index.css";
import App from "./App";

// Paths are opaque handles the view passes back unmodified (architecture.md
// §2), so fake ones only need to be distinct and stable.
const ROOT = "/harness/notes";

// bun/notes.ts, condensed to a Map: same naming-by-heading, same enumeration
// on collision, same move-don't-unlink trash. Behavior the specs assert on
// (which name a restore lands on, say) mirrors the real store; consult it
// before changing anything here.
class FakeStore {
  notes = new Map<string, { text: string; mtimeMs: number }>();
  trash = new Map<string, { text: string; deletedAt: number }>();
  private clock = 1_700_000_000_000;

  private tick(): number {
    return (this.clock += 60_000);
  }

  private allocate(text: string, taken: Iterable<string>): string {
    const base = slugOf(text) ?? "untitled";
    const names = new Set([...taken].map((p) => p.split("/").pop()!.toLowerCase()));
    let name = `${base}.md`;
    for (let n = 2; names.has(name.toLowerCase()); n += 1) name = `${base}-${n}.md`;
    return name;
  }

  seed(text: string): void {
    const path = `${ROOT}/${this.allocate(text, this.notes.keys())}`;
    this.notes.set(path, { text, mtimeMs: this.tick() });
  }

  seedTrash(text: string): void {
    const path = `${ROOT}/.trash/${this.allocate(text, this.trash.keys())}`;
    this.trash.set(path, { text, deletedAt: this.tick() });
  }

  private meta(path: string): NoteMeta {
    const n = this.notes.get(path)!;
    return { path, title: labelOf(headingOf(n.text), path), mtimeMs: n.mtimeMs };
  }

  list(): NoteMeta[] {
    return [...this.notes.keys()].map((p) => this.meta(p)).sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  listTrash(): TrashMeta[] {
    return [...this.trash.entries()]
      .map(([path, t]) => ({ path, title: labelOf(headingOf(t.text), path), deletedAt: t.deletedAt }))
      .sort((a, b) => b.deletedAt - a.deletedAt);
  }

  create(text: string): NoteMeta {
    const path = `${ROOT}/${this.allocate(text, this.notes.keys())}`;
    this.notes.set(path, { text, mtimeMs: this.tick() });
    return this.meta(path);
  }

  write(path: string, text: string): void {
    this.notes.set(path, { text, mtimeMs: this.tick() });
  }

  retitle(path: string, text: string): NoteMeta {
    const current = this.notes.get(path)!;
    const others = [...this.notes.keys()].filter((p) => p !== path);
    const target = `${ROOT}/${this.allocate(text, others)}`;
    this.notes.delete(path);
    this.notes.set(target, current);
    return this.meta(target);
  }

  remove(path: string): string | null {
    const n = this.notes.get(path);
    if (!n) return null;
    this.notes.delete(path);
    const dest = `${ROOT}/.trash/${this.allocate(n.text, this.trash.keys())}`;
    this.trash.set(dest, { text: n.text, deletedAt: this.tick() });
    return dest;
  }

  restore(path: string): NoteMeta {
    const t = this.trash.get(path)!;
    this.trash.delete(path);
    const dest = `${ROOT}/${this.allocate(t.text, this.notes.keys())}`;
    this.notes.set(dest, { text: t.text, mtimeMs: this.tick() });
    return this.meta(dest);
  }

  removeTrashed(path: string): boolean {
    return this.trash.delete(path);
  }

  empty(): number {
    const n = this.trash.size;
    this.trash.clear();
    return n;
  }
}

const store = new FakeStore();
store.seed("# Alpha\n\nalpha body\n");
store.seed("# Beta\n\nbeta body\n");
store.seed("# Gamma\n\ngamma body\n");
store.seedTrash("# Older\n\nonce deleted\n");

configureNotes({
  list: async () => store.list(),
  read: async (path) => store.notes.get(path)?.text ?? null,
  write: async (path, text) => store.write(path, text),
  create: async (text) => store.create(text),
  retitle: async (path, text) => store.retitle(path, text),
  remove: async (path) => store.remove(path),
  trash: async () => store.listTrash(),
  restore: async (path) => store.restore(path),
  removeTrashed: async (path) => store.removeTrashed(path),
  empty: async () => store.empty(),
  // No shells here (see configureBridge below), so params have nothing to
  // configure; the send is simply absorbed.
  configureSession: () => {},
});

// No PTYs here: runs and the terminal are inert. A spec that needs run
// behavior has outgrown the harness and belongs to the live probe.
configureBridge({
  runInline: () => {},
  cancelRun: () => {},
  resizeInline: () => {},
  inputInline: () => {},
});
configureTerminal({
  sendInput: () => {},
  sendPaste: () => {},
  sendResize: () => {},
  attach: async () => ({ dataB64: "" }),
  detach: () => {},
  closeSession: () => {},
  restartSession: () => {},
});

// In-memory clipboard, readable by specs via window.__harness.
let clip = "";
configureClipboard({
  write: (text) => {
    clip = text;
  },
  read: async () => clip,
});

// A non-default editor font size, so a spec can tell "the setting reached the
// editor" apart from "the old hardcoded 14px is still there". openFile is
// recorded, not performed: launching an OS editor is a native seam.
let settingsOpens = 0;
const profiles = new Map<string, string>();
configureSettings(
  { ...DEFAULT_SETTINGS, editor: { fontSize: 18 } },
  {
    openFile: () => {
      settingsOpens += 1;
    },
    // An in-memory profile store, seeded on first read like the real one, so
    // specs can drive the profile editor dialog end to end.
    readProfile: async (name) => {
      let text = profiles.get(name);
      if (text === undefined) {
        text = `# Ledge profile "${name}"\n`;
        profiles.set(name, text);
      }
      return text;
    },
    writeProfile: async (name, text) => {
      profiles.set(name, text);
    },
  },
);

declare global {
  interface Window {
    __harness: { clipboard: () => string; settingsOpens: () => number; store: FakeStore };
  }
}
window.__harness = { clipboard: () => clip, settingsOpens: () => settingsOpens, store };

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App initial={initialState(store.list(), store.listTrash())} />
  </StrictMode>,
);
