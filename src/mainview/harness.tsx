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
import type { NoteMeta, TrashMeta, WorkspaceRootInfo } from "../shared/rpc-schema";
import { headingOf, labelOf, slugify, slugOf } from "../shared/slug";
import { collectHits, type SearchHit } from "../shared/search";
import { configureBridge } from "./editor/bridge";
import { configureTerminal } from "./terminal/channel";
import { configureNotes } from "./notes/channel";
import { configureWorkspaces, recordWorkspaceKinds } from "./workspace/channel";
import { configureClipboard } from "./lib/clipboard";
import { configureAssets } from "./lib/assets";
import { configureSettings } from "./lib/settings";
import { DEFAULT_SETTINGS } from "../shared/settings";
import { configureLayout, restoredState } from "./workspace/persist";
import "./index.css";
import App from "./App";

// Paths and roots are opaque handles the view passes back unmodified
// (architecture.md §2), so fake ones only need to be distinct and stable.
// SCRATCH is the attached-at-boot workspace folder; EXTERNAL starts seeded
// but UNATTACHED — the fake workspaceAttach returns it, which is what makes
// the whole attach flow spec-able without the native dialog.
const SCRATCH = "/harness/scratch";
const EXTERNAL = "/harness/external";

interface RootData {
  notes: Map<string, { text: string; mtimeMs: number }>;
  trash: Map<string, { text: string; deletedAt: number }>;
}

// bun/notes.ts + bun/workspaces.ts, condensed to Maps: same naming-by-heading,
// same enumeration on collision, same move-don't-unlink trash, same
// detach-keeps-the-folder registry. Behavior the specs assert on (which name
// a restore lands on, that a detached folder's notes survive) mirrors the
// real store; consult it before changing anything here.
class FakeStore {
  // Every folder that EXISTS (data survives detach); `attached` is the
  // registry — the subset the app may see.
  roots = new Map<string, RootData>();
  attached: string[] = [];
  private clock = 1_700_000_000_000;

  private tick(): number {
    return (this.clock += 60_000);
  }

  ensureRoot(root: string): RootData {
    let data = this.roots.get(root);
    if (!data) {
      data = { notes: new Map(), trash: new Map() };
      this.roots.set(root, data);
    }
    return data;
  }

  attach(root: string): void {
    this.ensureRoot(root);
    if (!this.attached.includes(root)) this.attached.push(root);
  }

  detach(root: string): boolean {
    const i = this.attached.indexOf(root);
    if (i < 0) return false;
    this.attached.splice(i, 1);
    return true; // the data stays: detach never deletes
  }

  workspaceList(): WorkspaceRootInfo[] {
    return this.attached.map((root) => ({
      root,
      kind: root.startsWith("/harness/") && !root.includes("external") ? "managed" : "external",
      available: true,
    }));
  }

  createManaged(name: string): string {
    const base = slugify(name) ?? "workspace";
    let root = `/harness/${base}`;
    for (let n = 2; this.roots.has(root); n += 1) root = `/harness/${base}-${n}`;
    this.attach(root);
    return root;
  }

  // The folder a path belongs to. Every path the view sends came from here,
  // so an unknown one is a spec bug worth throwing on.
  private rootOf(path: string): { root: string; data: RootData } {
    for (const [root, data] of this.roots) {
      if (path.startsWith(`${root}/`)) return { root, data };
    }
    throw new Error(`harness: path outside every root: ${path}`);
  }

  private allocate(text: string, taken: Iterable<string>): string {
    const base = slugOf(text) ?? "untitled";
    const names = new Set([...taken].map((p) => p.split("/").pop()!.toLowerCase()));
    let name = `${base}.md`;
    for (let n = 2; names.has(name.toLowerCase()); n += 1) name = `${base}-${n}.md`;
    return name;
  }

  seed(root: string, text: string): void {
    const data = this.ensureRoot(root);
    const path = `${root}/${this.allocate(text, data.notes.keys())}`;
    data.notes.set(path, { text, mtimeMs: this.tick() });
  }

  seedTrash(root: string, text: string): void {
    const data = this.ensureRoot(root);
    const path = `${root}/.ledge-trash/${this.allocate(text, data.trash.keys())}`;
    data.trash.set(path, { text, deletedAt: this.tick() });
  }

  private meta(data: RootData, path: string): NoteMeta {
    const n = data.notes.get(path)!;
    return { path, title: labelOf(headingOf(n.text), path), mtimeMs: n.mtimeMs };
  }

  list(root: string): NoteMeta[] {
    const data = this.ensureRoot(root);
    return [...data.notes.keys()].map((p) => this.meta(data, p)).sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  listTrash(root: string): TrashMeta[] {
    return [...this.ensureRoot(root).trash.entries()]
      .map(([path, t]) => ({ path, title: labelOf(headingOf(t.text), path), deletedAt: t.deletedAt }))
      .sort((a, b) => b.deletedAt - a.deletedAt);
  }

  readNote(path: string): string | null {
    return this.rootOf(path).data.notes.get(path)?.text ?? null;
  }

  create(root: string, text: string): NoteMeta {
    const data = this.ensureRoot(root);
    const path = `${root}/${this.allocate(text, data.notes.keys())}`;
    data.notes.set(path, { text, mtimeMs: this.tick() });
    return this.meta(data, path);
  }

  write(path: string, text: string): void {
    this.rootOf(path).data.notes.set(path, { text, mtimeMs: this.tick() });
  }

  retitle(path: string, text: string): NoteMeta {
    const { root, data } = this.rootOf(path);
    const current = data.notes.get(path)!;
    const others = [...data.notes.keys()].filter((p) => p !== path);
    const target = `${root}/${this.allocate(text, others)}`;
    data.notes.delete(path);
    data.notes.set(target, current);
    return this.meta(data, target);
  }

  remove(path: string): string | null {
    const { root, data } = this.rootOf(path);
    const n = data.notes.get(path);
    if (!n) return null;
    data.notes.delete(path);
    // Into the note's OWN root's trash, like the real deleteNote.
    const dest = `${root}/.ledge-trash/${this.allocate(n.text, data.trash.keys())}`;
    data.trash.set(dest, { text: n.text, deletedAt: this.tick() });
    return dest;
  }

  restore(path: string): NoteMeta {
    const { root, data } = this.rootOf(path);
    const t = data.trash.get(path)!;
    data.trash.delete(path);
    const dest = `${root}/${this.allocate(t.text, data.notes.keys())}`;
    data.notes.set(dest, { text: t.text, mtimeMs: this.tick() });
    return this.meta(data, dest);
  }

  removeTrashed(path: string): boolean {
    return this.rootOf(path).data.trash.delete(path);
  }

  // The real searchNotes is listNotes + the shared matcher; the fake composes
  // the same two pieces (scoped to one root), so the semantics cannot drift.
  search(root: string, query: string): Promise<SearchHit[]> {
    return collectHits(query, this.list(root), (p) => this.readNote(p));
  }

  empty(root: string): number {
    const data = this.ensureRoot(root);
    const n = data.trash.size;
    data.trash.clear();
    return n;
  }
}

const store = new FakeStore();
store.attach(SCRATCH);
store.seed(SCRATCH, "# Alpha\n\nalpha body\n");
store.seed(SCRATCH, "# Beta\n\nbeta body\n");
store.seed(SCRATCH, "# Gamma\n\ngamma body\n");
store.seedTrash(SCRATCH, "# Older\n\nonce deleted\n");
// Unattached, waiting for the fake workspaceAttach below.
store.seed(EXTERNAL, "# Delta\n\ndelta body, external needle\n");
store.seed(EXTERNAL, "# Epsilon\n\nepsilon body\n");

configureNotes({
  list: async (folder) => store.list(folder),
  read: async (path) => store.readNote(path),
  search: (folder, query) => store.search(folder, query),
  write: async (path, text) => store.write(path, text),
  create: async (folder, text) => store.create(folder, text),
  retitle: async (path, text) => store.retitle(path, text),
  remove: async (path) => store.remove(path),
  trash: async (folder) => store.listTrash(folder),
  restore: async (path) => store.restore(path),
  removeTrashed: async (path) => store.removeTrashed(path),
  empty: async (folder) => store.empty(folder),
  // No shells here (see configureBridge below), so params have nothing to
  // configure; the send is simply absorbed.
  configureSession: () => {},
});

// The registry fake: attach always offers EXTERNAL — the folder the "native
// dialog" picks — so the attach flow (and close → re-attach, proving nothing
// was deleted) runs in specs without any dialog. create mirrors
// createManaged's slug-and-enumerate.
configureWorkspaces({
  list: async () => store.workspaceList(),
  create: async (name) => store.createManaged(name),
  attach: async () => {
    store.attach(EXTERNAL);
    return { root: EXTERNAL, kind: "external", error: null };
  },
  detach: async (root) => store.detach(root),
});

// No PTYs here: runs and the terminal are inert. A spec that needs run
// behavior has outgrown the harness and belongs to the live probe.
// Link opens are recorded, not performed, like settings opens below:
// launching a browser is a native seam.
const linkOpens: string[] = [];
configureBridge({
  runInline: () => {},
  cancelRun: () => {},
  resizeInline: () => {},
  inputInline: () => {},
  openLink: (url) => {
    linkOpens.push(url);
  },
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

// In-memory layout file, like the clipboard below: saves are recorded, and a
// spec can read the latest serialization back via window.__harness. The boot
// below passes null (a harness run always starts from the seeded notes), so
// restore behavior itself is covered by persist.test.ts, not specs.
let layoutText: string | null = null;
configureLayout({
  save: (text) => {
    layoutText = text;
  },
});

// In-memory clipboard, readable by specs via window.__harness.
let clip = "";
configureClipboard({
  write: (text) => {
    clip = text;
  },
  read: async () => clip,
});

// In-memory image assets, mirroring bun/assets.ts semantics: read serves a
// seeded map (missing → null, the broken placeholder), pasteImage allocates a
// fresh name and returns the markdown reference like the real assetPaste.
// Keyed folder\0src like lib/assets' cache, so the per-workspace scoping is
// real: the seeded image belongs to SCRATCH and is a real 1×1 PNG so the
// rendered <img> actually loads.
const PIXEL_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const assets = new Map<string, { dataB64: string; mime: string }>([
  [`${SCRATCH}\0assets/dot.png`, { dataB64: PIXEL_B64, mime: "image/png" }],
]);
let pasteCount = 0;
configureAssets({
  read: async (folder, src) => assets.get(`${folder}\0${src}`) ?? null,
  pasteImage: async (folder) => {
    pasteCount += 1;
    const src = `.ledge-assets/pasted-${pasteCount}.png`;
    assets.set(`${folder}\0${src}`, { dataB64: PIXEL_B64, mime: "image/png" });
    return src;
  },
});

// A non-default editor font size, so a spec can tell "the setting reached the
// editor" apart from "the old hardcoded 14px is still there". openFile is
// recorded, not performed: launching an OS editor is a native seam.
let settingsOpens = 0;
const profiles = new Map<string, string>();
configureSettings(
  { ...DEFAULT_SETTINGS, editor: { ...DEFAULT_SETTINGS.editor, fontSize: 18 } },
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
    __harness: {
      clipboard: () => string;
      settingsOpens: () => number;
      linkOpens: () => string[];
      layout: () => string | null;
      store: FakeStore;
    };
  }
}
window.__harness = {
  clipboard: () => clip,
  settingsOpens: () => settingsOpens,
  linkOpens: () => [...linkOpens],
  layout: () => layoutText,
  store,
};

// Same boot shape as main.tsx: the registry first, then per-folder lists.
// null layout: a harness run always starts from the seeded notes; restore
// behavior itself is covered by persist.test.ts, not specs.
const bootRoots = store.workspaceList();
recordWorkspaceKinds(bootRoots);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App
      initial={restoredState(
        null,
        bootRoots,
        Object.fromEntries(bootRoots.map((r) => [r.root, store.list(r.root)])),
        Object.fromEntries(bootRoots.map((r) => [r.root, store.listTrash(r.root)])),
      )}
    />
  </StrictMode>,
);
