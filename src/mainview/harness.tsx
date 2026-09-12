// The e2e harness entry point: the whole app, with the Bun process replaced by
// an in-memory fake at the same seams (testing.md §5). boot.tsx binds
// configureNotes, configureTerminal, configureBridge and configureClipboard to
// the live Electrobun RPC. This file binds them to a Map, and the app cannot
// tell the difference. Everything above the seams runs for real in a real
// WebKit, driven headlessly by Playwright (e2e/*.spec.ts): the command
// registry, focus behavior, the lists, the dialogs.
//
// Vite serves this at /harness.html in dev only. The production build's input
// is index.html, so none of this ships.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { BacklinkHit, NoteMeta, TagHit, TerminalClaim, TrashMeta, UpdateState, VaultState, WorkspaceRootInfo } from "../shared/rpc-schema";
import { headingOf, labelOf, slugify, slugOf } from "../shared/slug";
import { frontmatterEnd, parseFrontmatter, setFavoriteLine } from "../shared/frontmatter";
import { instantiateTemplate, isoDateOf } from "../shared/template";
import { collectHits, type SearchHit } from "../shared/search";
import { folderContains, folderLeafProblem, folderScopeOf, notesUnder } from "../shared/folders";
import { resolveWikiTitle, wikiRefsOf } from "../shared/wikilinks";
import { normalizeTag, tagDirectoryOf, tagRefsOf, type TagInfo } from "../shared/tags";
import { knownHostsHost, validatePassword } from "../shared/connections";
import type { ConnectionInfo } from "../shared/rpc-schema";
import { configureBridge, dispatchRunEvent, dispatchRunLink, reconcileRuns } from "./editor/bridge";
import { sendRunKey } from "./editor/inlineTerm";
import { barFaceOf, type BarFace } from "./lib/nativeBridge";
import { configureTerminal, dispatchTerminalDetached, dispatchTerminalRelink } from "./terminal/channel";
import { configureNotes, dispatchExternalOpen, dispatchNotesChanged, dispatchNotesRelink, type ExternalOpenInfo, type FolderDeleted, type FolderRenamed, type NoteFile } from "./notes/channel";
import { configureVault, recordVaultState, refreshVaultState } from "./vault/channel";
import { configureWorkspaces, recordWorkspaceKinds } from "./workspace/channel";
import { configureClipboard } from "./lib/clipboard";
import { configureCli } from "./lib/cli";
import { configureUpdates, loadUpdateState, recordUpdateState } from "./lib/updates";
import { configureWindows, dispatchDocsShow, recordWindowRole } from "./lib/windows";
import { configureAssets } from "./lib/assets";
import { configureSettings } from "./lib/settings";
import { configureConnections, recordLinkState, recordPresence } from "./lib/connections";
import { hideBooting, showBooting } from "./lib/booting";
import {
  clientSettingsTemplate,
  DEFAULT_SETTINGS,
  settingsTemplate,
  THEMES,
  type SettingsHome,
  type Theme,
} from "../shared/settings";
import { applyAppearance } from "./lib/theme";
import { configureShell, recordServerCaps } from "./lib/shell";
import { configureLayout, restoredState } from "./workspace/persist";
import { holdSaves } from "./notes/store";
import { resolveStrandedNotes } from "./workspace/editorPool";
import { docsState } from "./workspace/store";

// Which shell to be. Two clients bind these seams for real: Electrobun on the
// Mac and Swift on iOS (ios.md §1). They differ in what the device can do, not
// in what the notes are. `?shell=ios` is how a spec asks for the phone.
// Anything else is the desktop app, and every spec written before this one
// still gets that.
//
// Not derived from the viewport. A Mac window dragged to 390 points is still a
// Mac and keeps its terminal: width decides the chrome's arrangement alone
// (ios.md §9).
//
// One phone shell, not two. `?shell=ios-runs` sat beside this one while the
// second step of §8's cut was ahead of the client (ios.md §14). ios.tsx now
// says `runsBlocks: true`, so that middle configuration is what a phone is and
// nothing is left to tell the pair apart. A phone still has no terminal
// drawer, which is what `hasTerminal` below sets.
const SHELL = new URLSearchParams(window.location.search).get("shell") ?? "";
const FAKING_IOS = SHELL === "ios";
configureShell({
  // `runsBlocks` is absent from this list because it is true of every shell the
  // harness can be. A phone runs a note's blocks inline as a Mac does, and the
  // two differ over the drawer alone (lib/shell.ts).
  hasTerminal: !FAKING_IOS,
  // The whole set ios.tsx sets, because two of them decide what a spec can see.
  // `deviceKey` decides whether the connection form asks for a key file or
  // shows the line this client already has (components/ConnectionPicker.tsx).
  // `softKeyboard` decides whether the read-only editor is a text field the
  // software keyboard would rise over (editor/setup.ts).
  deviceKey: FAKING_IOS ? 'restrict,command="ledge-server serve" ecdsa-sha2-nistp256 AAAAharness ledge-iphone-abc123' : "",
  // The sheet is UIKit's and there is none here, so the fake records the ask on
  // the window instead. A spec can then see that the button is offered and that
  // it hands over the line. The view's half of this seam is all this can show.
  shareSheet: FAKING_IOS
    ? (text: string) => {
        (window as unknown as { harnessShared: string[] }).harnessShared = [
          ...((window as unknown as { harnessShared?: string[] }).harnessShared ?? []),
          text,
        ];
      }
    : null,
  softKeyboard: FAKING_IOS,
  // A phone shows one app at a time, so a window and a client are the same
  // thing there. On the Mac they stopped being the same (remote.md §8a).
  multiWindow: !FAKING_IOS,
});
// Which window this page stands in for. A shell with windows gives the manual
// one of its own (remote.md §8a), and that window is another webview running
// this same view. A spec reaches it the way the shell does, by loading the page
// as that window rather than by clicking the button that opens it. The ordinary
// harness page is an ordinary window, where the button is the ask (`docsOpens`
// below).
const DOCS_WINDOW = new URLSearchParams(window.location.search).get("docs") === "1";
recordWindowRole({ docs: DOCS_WINDOW });
// The server's half of the same picture: what the machine holding the notes can
// do for itself. Set here rather than arriving with workspaceList, because this
// harness renders without boot.tsx's bootView(), which is where the real shells
// record it. Both answers follow the faked shell. The ios one stands in for a
// phone against a headless server, which has no dialog to open and no CLI to
// hand over.
recordServerCaps({ folderDialog: !FAKING_IOS, cliShim: !FAKING_IOS });
import "./index.css";
import App from "./App";

// Paths and roots are opaque handles the view passes back unmodified
// (architecture.md §2), so fake ones only need to be distinct and stable.
// SCRATCH is the attached-at-boot workspace folder. EXTERNAL starts seeded but
// unattached, and the fake workspaceAttach returns it. That is what makes the
// whole attach flow spec-able without the native dialog.
const SCRATCH = "/harness/scratch";
const EXTERNAL = "/harness/external";
// The built-in documentation root, attached at boot like the real one
// (bun/workspaces.ts registers it at every load): kind "docs", hidden from the
// strip. Every fake write below refuses it, the same read-only contract the
// real store enforces (bun/workspaces.ts assertWritableRoot).
const DOCS = "/harness/.ledge-docs";

interface RootData {
  notes: Map<string, { text: string; mtimeMs: number }>;
  trash: Map<string, { text: string; deletedAt: number }>;
}

// bun/notes.ts and bun/workspaces.ts, condensed to Maps: same naming by
// heading, same enumeration on collision, same move-don't-unlink trash, same
// detach-keeps-the-folder registry. Behavior the specs assert on mirrors the
// real store, down to which name a restore lands on and that a detached
// folder's notes survive. Read the real store before changing anything here.
class FakeStore {
  // `roots` holds every folder that exists, since the data survives a detach.
  // `attached` is the registry: the subset the app may see.
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

  // The fake workspaceMove: rename(2) in Map form. The root key and every path
  // under it are rekeyed to the destination, so the data travels whole, and the
  // registry line is replaced in place. That mirrors moveRoot's contract
  // (bun/workspaces.ts), including the own-parent no-op: the real one answers
  // the same root back, and the view's leave-tabs-alone branch keys off that.
  move(root: string, destParent: string): string {
    const data = this.roots.get(root);
    if (!data) throw new Error(`harness: move of unknown root ${root}`);
    if (root.slice(0, root.lastIndexOf("/")) === destParent) return root;
    const base = root.split("/").pop()!;
    let next = `${destParent}/${base}`;
    for (let n = 2; this.roots.has(next); n += 1) next = `${destParent}/${base}-${n}`;
    const rekey = (p: string) => next + p.slice(root.length);
    const notes = new Map([...data.notes].map(([p, v]) => [rekey(p), v] as const));
    const trash = new Map([...data.trash].map(([p, v]) => [rekey(p), v] as const));
    this.roots.delete(root);
    this.roots.set(next, { notes, trash });
    this.attached = this.attached.map((r) => (r === root ? next : r));
    return next;
  }

  workspaceList(): WorkspaceRootInfo[] {
    return this.attached.map((root) => ({
      root,
      kind:
        root === DOCS
          ? "docs"
          : root.startsWith("/harness/") && !root.includes("external")
            ? "managed"
            : "external",
      available: true,
    }));
  }

  // The real store's read-only gate (assertWritableRoot) in fake form. Every
  // mutating path below calls this, so a spec that reaches a docs write by any
  // route gets the same refusal the app would.
  private assertWritable(rootOrPath: string): void {
    if (rootOrPath === DOCS || rootOrPath.startsWith(`${DOCS}/`)) {
      throw new Error("the built-in documentation is read-only");
    }
  }

  createManaged(name: string): string {
    const base = slugify(name) ?? "workspace";
    let root = `/harness/${base}`;
    for (let n = 2; this.roots.has(root); n += 1) root = `/harness/${base}-${n}`;
    this.attach(root);
    return root;
  }

  // The folder a path belongs to. Every path the view sends came from here, so
  // an unknown one is a spec bug and throws.
  private rootOf(path: string): { root: string; data: RootData } {
    for (const [root, data] of this.roots) {
      if (path.startsWith(`${root}/`)) return { root, data };
    }
    throw new Error(`harness: path outside every root: ${path}`);
  }

  // The names of one directory's own files. The real allocator reads the same
  // thing, a readdir of the destination rather than a walk, so a note in
  // `projects` does not make its name taken at the top level.
  private namesIn(data: RootData, dir: string): Set<string> {
    const names = new Set<string>();
    for (const path of data.notes.keys()) {
      if (path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes("/")) {
        names.add(path.slice(dir.length + 1).toLowerCase());
      }
    }
    return names;
  }

  private allocate(text: string, taken: Iterable<string>): string {
    const base = slugOf(text) ?? "untitled";
    const names = new Set([...taken].map((p) => p.split("/").pop()!.toLowerCase()));
    let name = `${base}.md`;
    for (let n = 2; names.has(name.toLowerCase()); n += 1) name = `${base}-${n}.md`;
    return name;
  }

  // `folder` places the note in a subfolder of the root, root-relative and ""
  // for the top level. It is the only way a spec gets a tree to look at.
  seed(root: string, text: string, folder = ""): void {
    const data = this.ensureRoot(root);
    const dir = folder ? `${root}/${folder}` : root;
    const path = `${dir}/${this.allocate(text, this.namesIn(data, dir))}`;
    data.notes.set(path, { text, mtimeMs: this.tick() });
  }

  // Seed under a stated filename rather than the H1's slug. The docs pages'
  // names are manifest artifacts, numbered for reading order as in the real
  // bun/docsContent.ts, rather than derived from their titles.
  seedAt(root: string, name: string, text: string): void {
    const data = this.ensureRoot(root);
    data.notes.set(`${root}/${name}`, { text, mtimeMs: this.tick() });
  }

  // Empties a root's notes, leaving its trash alone. `?fresh` (below) uses it
  // to stand in for a first launch.
  wipe(root: string): void {
    this.ensureRoot(root).notes.clear();
  }

  seedTrash(root: string, text: string): void {
    const data = this.ensureRoot(root);
    const path = `${root}/.ledge-trash/${this.allocate(text, data.trash.keys())}`;
    data.trash.set(path, { text, deletedAt: this.tick() });
  }

  private meta(data: RootData, path: string): NoteMeta {
    const n = data.notes.get(path)!;
    // The real metaFor's flags, from the same shared parser. A `template:`
    // frontmatter line puts a note in the ⌥⌘N picker, and the `daily` role
    // rides its value. A `locked:` value marks the note locked.
    const p = parseFrontmatter(n.text).params;
    // The real metaAt's folder: root-relative, absent at the top level. The
    // fake derives it from the path the same way, which keeps a harness tree
    // and a real one the same shape.
    const folder = this.folderOf(path);
    return {
      path,
      title: labelOf(headingOf(n.text), path),
      mtimeMs: n.mtimeMs,
      ...(folder === "" ? {} : { folder }),
      ...(p.template ? { template: p.template } : {}),
      ...(p.favorite ? { favorite: true as const } : {}),
      ...(p.locked !== null ? { locked: true as const } : {}),
    };
  }

  // Where inside its root a path sits, forward-slashed, "" at the top level.
  private folderOf(path: string): string {
    const { root } = this.rootOf(path);
    const rel = path.slice(root.length + 1);
    const cut = rel.lastIndexOf("/");
    return cut < 0 ? "" : rel.slice(0, cut);
  }

  // --- the vault fake --------------------------------------------------------
  // bun/vault.ts condensed to a state and a remembered passphrase, with no
  // crypto. The fake stores plaintext and withholds it while locked, which is
  // the behavior surface the specs assert on: placeholder faces, held reads,
  // skip counts. The `locked:` value is an inert marker string here.
  vault: { state: "none" | "locked" | "unlocked"; pass: string | null } = { state: "none", pass: null };

  vaultCreate(pass: string): boolean {
    if (this.vault.state !== "none") return false;
    this.vault = { state: "unlocked", pass };
    return true;
  }

  vaultUnlock(pass: string): boolean {
    if (this.vault.state === "unlocked") return true;
    if (this.vault.pass === null || pass !== this.vault.pass) return false;
    this.vault.state = "unlocked";
    return true;
  }

  vaultLock(): void {
    if (this.vault.state === "unlocked") this.vault.state = "locked";
  }

  // The plaintext head, the answer the real splitHead gives (bun/vault.ts):
  // the frontmatter block plus the H1 line, and the blank run between them
  // when a block precedes it.
  private headOf(text: string): string {
    const end = frontmatterEnd(text);
    let pos = end;
    if (end > 0) pos += /^(?:[ \t]*\r?\n)+/.exec(text.slice(pos))?.[0]?.length ?? 0;
    const nl = text.indexOf("\n", pos);
    const firstLine = nl === -1 ? text.slice(pos) : text.slice(pos, nl);
    if (/^#[ \t]+\S/.test(firstLine)) return text.slice(0, nl === -1 ? text.length : nl + 1);
    return text.slice(0, end);
  }

  private lockedOf(text: string): boolean {
    return parseFrontmatter(text).params.locked !== null;
  }

  // The marker surgery: bun/vault.ts's stampLockedLine and stripLockedLine in
  // fake form. The value is inert here ("harness-v1"), but the line rules are
  // the real ones: the line is Bun-owned and the disk text decides it
  // (locking.md §2). stripMarker also drops a frontmatter block once nothing
  // but blank lines is left in it.
  private stripMarker(text: string): string {
    const end = frontmatterEnd(text);
    if (end === 0) return text;
    const block = text.slice(0, end).split("\n");
    const close = block.lastIndexOf("---");
    const content = block.slice(1, close).filter((l) => !/^locked\s*:/.test(l));
    if (content.every((l) => l.trim() === "")) return text.slice(end);
    return [block[0]!, ...content, ...block.slice(close)].join("\n") + text.slice(end);
  }

  private stampMarker(text: string): string {
    const stripped = this.stripMarker(text);
    const line = "locked: harness-v1";
    return stripped.startsWith("---\n")
      ? stripped.replace("---\n", `---\n${line}\n`)
      : `---\n${line}\n---\n${stripped}`;
  }

  // The disk text decides the marker, not the buffer: a save re-stamps it or
  // strips it. That is the Bun-owned-line rule (locking.md §2) in fake form.
  private stampLike(diskText: string, incoming: string): string {
    return this.lockedOf(diskText) ? this.stampMarker(incoming) : this.stripMarker(incoming);
  }

  lockNote(path: string): NoteMeta {
    this.assertWritable(path);
    if (this.vault.state !== "unlocked") throw new Error("the vault is locked");
    const { data } = this.rootOf(path);
    const n = data.notes.get(path)!;
    if (parseFrontmatter(n.text).params.template) throw new Error("a template cannot be locked");
    if (!this.lockedOf(n.text)) data.notes.set(path, { text: this.stampMarker(n.text), mtimeMs: this.tick() });
    return this.meta(data, path);
  }

  removeLock(path: string): NoteMeta {
    if (this.vault.state !== "unlocked") throw new Error("unlock first");
    const { data } = this.rootOf(path);
    const n = data.notes.get(path)!;
    data.notes.set(path, { text: this.stripMarker(n.text), mtimeMs: this.tick() });
    return this.meta(data, path);
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

  // The read the channel handler serves: text plus disk mtime, like the real
  // readNote. The store echoes that mtime back into write's baseMtimeMs. A
  // locked note reads whole only while the fake vault is unlocked. Otherwise
  // the body is withheld and `held` says so, the shape of the real seam.
  readFile(path: string): NoteFile | null {
    const n = this.rootOf(path).data.notes.get(path);
    if (!n) return null;
    if (!this.lockedOf(n.text)) return { text: n.text, mtimeMs: n.mtimeMs };
    if (this.vault.state !== "unlocked") return { text: this.headOf(n.text), mtimeMs: n.mtimeMs, locked: true, held: true };
    return { text: n.text, mtimeMs: n.mtimeMs, locked: true };
  }

  // Test seam (window.__harness): an agent rewriting a note behind the app's
  // back. The fresh mtime is what an external temp-plus-rename write leaves.
  writeExternal(path: string, text: string): void {
    this.rootOf(path).data.notes.set(path, { text, mtimeMs: this.tick() });
  }

  create(root: string, text: string, folder?: string | null): NoteMeta {
    this.assertWritable(root);
    const data = this.ensureRoot(root);
    const dir = folder ? `${root}/${folder}` : root;
    const path = `${dir}/${this.allocate(text, this.namesIn(data, dir))}`;
    data.notes.set(path, { text, mtimeMs: this.tick() });
    return this.meta(data, path);
  }

  // The real moveNote in Map form: rekey the entry under the destination
  // folder, keeping its name unless that name is taken there. The note's mtime
  // survives, the way rename(2) preserves it.
  moveNote(path: string, folder: string | null): NoteMeta {
    this.assertWritable(path);
    const { root, data } = this.rootOf(path);
    const note = data.notes.get(path);
    if (!note) throw new Error(`harness: no note at ${path}`);
    if (this.lockedOf(note.text) && this.vault.state !== "unlocked") {
      throw new Error("unlock first — moving a locked note rewrites the image references in its body");
    }
    const dir = folder ? `${root}/${folder}` : root;
    if (path.slice(0, path.lastIndexOf("/")) === dir) return this.meta(data, path);
    const base = path.split("/").pop()!.replace(/\.md$/i, "");
    let name = `${base}.md`;
    const taken = this.namesIn(data, dir);
    for (let n = 2; taken.has(name.toLowerCase()); n += 1) name = `${base}-${n}.md`;
    const target = `${dir}/${name}`;
    data.notes.delete(path);
    data.notes.set(target, note);
    return this.meta(data, target);
  }

  // The real renameFolder in Map form: rekey every note whose path sits under
  // the folder, leaving its name, its text and its mtime alone. No lock check
  // and no body read, like the real one: a rename changes no note's depth, so
  // nothing inside a body becomes wrong.
  renameFolder(root: string, folder: string, name: string): FolderRenamed {
    this.assertWritable(root);
    const data = this.ensureRoot(root);
    const problem = folderLeafProblem(name);
    if (problem !== null) throw new Error(`not a folder name: ${name} (${problem})`);
    const scope = folderScopeOf(folder);
    const next = [...scope.split("/").slice(0, -1), name.trim()].join("/");
    if (next === scope) return { folder: scope, moved: [] };
    const held = [...data.notes.keys()].filter((p) => this.folderOf(p) === next);
    if (held.length > 0) throw new Error(`there is already a folder called "${name.trim()}" here`);
    const moved: FolderRenamed["moved"] = [];
    for (const path of [...data.notes.keys()]) {
      if (!folderContains(scope, this.folderOf(path))) continue;
      const target = `${root}/${next}${path.slice(`${root}/${scope}`.length)}`;
      const note = data.notes.get(path)!;
      data.notes.delete(path);
      data.notes.set(target, note);
      moved.push({ from: path, note: this.meta(data, target) });
    }
    return { folder: next, moved };
  }

  // The real deleteFolder in Map form: every note under the folder, each
  // through the same `remove` a single delete goes through, so the fake gets
  // the trash entries and the undo handles for free. Nothing prunes empty
  // directories here, since the fake holds paths and no directories. The real
  // one prunes them (bun/notes.ts pruneEmptyDirs).
  deleteFolder(root: string, folder: string): FolderDeleted {
    this.assertWritable(root);
    const data = this.ensureRoot(root);
    const scope = folderScopeOf(folder);
    // The real one's refusal, carried because the specs drive the harness:
    // folderContains("") is true of every note, so without this the workspace's
    // own row would empty it.
    if (scope === "") throw new Error("a workspace is closed from the workspace strip, not deleted here");
    const trashed: FolderDeleted["trashed"] = [];
    for (const path of [...data.notes.keys()]) {
      if (!folderContains(scope, this.folderOf(path))) continue;
      const to = this.remove(path);
      if (to !== null) trashed.push({ from: path, to });
    }
    return { trashed };
  }

  // Mirrors the real writeNote's guard (bun/notes.ts). A mismatched base with
  // different bytes moves the disk version into the trash, and the incoming
  // text wins the live path. Identical bytes adopt the disk mtime instead. The
  // fake must carry those semantics: simplify them away and the harness specs
  // would green-light a view that never handles divergence.
  write(path: string, text: string, baseMtimeMs: number | null): { mtimeMs: number; divergedTo: string | null } {
    this.assertWritable(path);
    const { root, data } = this.rootOf(path);
    const cur = data.notes.get(path);
    // The disk decides the lock marker, never the buffer (the real
    // writeNote's rule). A locked save needs the vault open.
    if (cur) {
      if (this.lockedOf(cur.text) && this.vault.state !== "unlocked") throw new Error("the vault is locked");
      text = this.stampLike(cur.text, text);
    } else {
      text = this.stripMarker(text);
    }
    let divergedTo: string | null = null;
    if (cur && baseMtimeMs !== null && cur.mtimeMs !== baseMtimeMs) {
      if (cur.text === text) return { mtimeMs: cur.mtimeMs, divergedTo: null };
      divergedTo = `${root}/.ledge-trash/${this.allocate(cur.text, data.trash.keys())}`;
      data.trash.set(divergedTo, { text: cur.text, deletedAt: this.tick() });
    }
    const mtimeMs = this.tick();
    data.notes.set(path, { text, mtimeMs });
    return { mtimeMs, divergedTo };
  }

  // Mirrors favoriteNote (bun/notes.ts): the frontmatter marker goes on or
  // off, the rest of the note is untouched, and the file's mtime moves only
  // when the line actually changed. A locked note takes it with the vault
  // shut, as it does there: the marker is head text, not body.
  favorite(path: string, on: boolean): NoteMeta {
    this.assertWritable(path);
    const { data } = this.rootOf(path);
    const cur = data.notes.get(path);
    if (!cur) throw new Error(`no note at ${path}`);
    const text = setFavoriteLine(cur.text, on);
    if (text !== cur.text) data.notes.set(path, { text, mtimeMs: this.tick() });
    return this.meta(data, path);
  }

  retitle(path: string, text: string): NoteMeta {
    this.assertWritable(path);
    const { root, data } = this.rootOf(path);
    const current = data.notes.get(path)!;
    const others = [...data.notes.keys()].filter((p) => p !== path);
    const target = `${root}/${this.allocate(text, others)}`;
    data.notes.delete(path);
    data.notes.set(target, current);
    return this.meta(data, target);
  }

  // Mirrors stashNote (bun/notes.ts): text into the note's own trash under the
  // note's name, the note itself untouched. A locked note's stash needs the
  // vault open for the same reason its save does.
  stash(path: string, text: string): string {
    this.assertWritable(path);
    const { root, data } = this.rootOf(path);
    const cur = data.notes.get(path);
    if (cur && this.lockedOf(cur.text) && this.vault.state !== "unlocked") throw new Error("the vault is locked");
    const dest = `${root}/.ledge-trash/${this.allocate(text, data.trash.keys())}`;
    data.trash.set(dest, { text, deletedAt: this.tick() });
    return dest;
  }

  remove(path: string): string | null {
    this.assertWritable(path);
    const { root, data } = this.rootOf(path);
    const n = data.notes.get(path);
    if (!n) return null;
    data.notes.delete(path);
    // Into the note's own root's trash, like the real deleteNote.
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

  // The real searchNotes is listNotes plus the shared matcher. The fake
  // composes the same two pieces, scoped to one root, so the semantics cannot
  // drift. That includes the locked skip: a locked note's body is never
  // scanned whatever the vault state, and the count rides back (locking.md §4).
  async search(root: string, query: string, scope = ""): Promise<{ hits: SearchHit[]; lockedSkipped: number }> {
    const metas = notesUnder(this.list(root), scope);
    const open = metas.filter((m) => !m.locked);
    const hits = await collectHits(query, open, (p) => this.readNote(p));
    return { hits, lockedSkipped: metas.length - open.length };
  }

  // The real backlinksTo is listNotes plus the shared wikilink scan. The fake
  // composes the same pieces, for the same cannot-drift reason as search above.
  backlinks(path: string): { backlinks: BacklinkHit[]; lockedSkipped: number } {
    const { root } = this.rootOf(path);
    const metas = this.list(root);
    const out: BacklinkHit[] = [];
    let lockedSkipped = 0;
    for (const meta of metas) {
      if (meta.path === path) continue;
      if (meta.locked) {
        lockedSkipped += 1;
        continue;
      }
      const text = this.readNote(meta.path);
      if (text === null) continue;
      const lines = text.split("\n");
      for (const ref of wikiRefsOf(text)) {
        if (resolveWikiTitle(ref.title, metas)?.path !== path) continue;
        out.push({ ...meta, line: ref.line, context: (lines[ref.line - 1] ?? "").trim(), raw: ref.raw });
      }
    }
    return { backlinks: out, lockedSkipped };
  }

  // A locked note contributes the tags in its plaintext head only: the
  // frontmatter line stays visible and body hashtags are sealed. That is the
  // real tagSourceOf's rule (bun/notes.ts), from the same shared pieces.
  private tagSource(meta: NoteMeta): string | null {
    const text = this.readNote(meta.path);
    if (text === null) return null;
    return meta.locked ? this.headOf(text) : text;
  }

  tags(root: string, scope = ""): { tags: TagInfo[]; lockedSkipped: number } {
    let lockedSkipped = 0;
    const perNote = notesUnder(this.list(root), scope).flatMap((meta) => {
      if (meta.locked) lockedSkipped += 1;
      const text = this.tagSource(meta);
      return text === null ? [] : [{ path: meta.path, refs: tagRefsOf(text) }];
    });
    return { tags: tagDirectoryOf(perNote), lockedSkipped };
  }

  tagged(root: string, tag: string): { hits: TagHit[]; lockedSkipped: number } {
    const want = normalizeTag(tag);
    const out: TagHit[] = [];
    let lockedSkipped = 0;
    for (const meta of this.list(root)) {
      if (meta.locked) lockedSkipped += 1;
      const text = this.tagSource(meta);
      if (text === null) continue;
      const lines = text.split("\n");
      for (const ref of tagRefsOf(text)) {
        if (normalizeTag(ref.tag) !== want) continue;
        out.push({ ...meta, line: ref.line, context: (lines[ref.line - 1] ?? "").trim(), raw: ref.raw });
      }
    }
    return { hits: out, lockedSkipped };
  }

  empty(root: string): number {
    const data = this.ensureRoot(root);
    const n = data.trash.size;
    data.trash.clear();
    return n;
  }

  // Mirrors bun/daily.ts createFromTemplatePath: the picker picked a concrete
  // note, so the fake takes its path too, and a vanished template throws.
  // Instantiation goes through the same shared instantiateTemplate.
  createFromTemplatePath(root: string, templatePath: string, title: string | null): NoteMeta {
    const text = this.readNote(templatePath);
    if (text === null) throw new Error(`the template note is gone (${templatePath}); pick again`);
    return this.create(root, instantiateTemplate(text, title ?? "Untitled", new Date()));
  }

  // The real findDailyTemplate (bun/daily.ts): the note in this root marked
  // `template: daily`. Resolution is strictly per-workspace, with no borrowing
  // from other attached roots. The meta flag comes from the same shared
  // parser, so which note holds the role cannot drift from the store.
  private findDailyTemplate(root: string): string | null {
    const local = this.list(root).find((n) => n.template === "daily");
    return local ? this.readNote(local.path) : null;
  }

  // Mirrors bun/daily.ts openDaily: local-date title, resolve else create,
  // instantiating the `template: daily` note when one exists. No settings are
  // read.
  openDaily(root: string): { open: ExternalOpenInfo; created: boolean } {
    const title = isoDateOf(new Date());
    const existing = resolveWikiTitle(title, this.list(root));
    if (existing) return { open: { ...existing, root }, created: false };
    const tpl = this.findDailyTemplate(root);
    const text = tpl !== null ? instantiateTemplate(tpl, title, new Date()) : `# ${title}\n`;
    return { open: { ...this.create(root, text), root }, created: true };
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
// A locked note, sealed at boot: the vault exists, is locked, and its
// passphrase is "letmein" (e2e/locked-notes.spec.ts). The marker is seeded in
// place, so the fake's read withholds everything below the head. The body
// carries a needle no search may surface, and a prompt fence for the
// run-affordance spec. The title sorts inside the alpha to gamma fixture
// range, because the sidebar is alphabetical and list-verbs.spec.ts pins the
// edges. The note contributes no tags, since its one hashtag sits in the
// sealed body: tags-panel.spec.ts pins the workspace's tagless empty state,
// and notes.fs.test.ts covers head tags staying visible.
store.seed(
  SCRATCH,
  [
    "---",
    "locked: harness-v1",
    "---",
    "# Codebook",
    "",
    "vaulted needle body, #hidden and [[Alpha]]",
    "",
    "```prompt",
    "summarize this note",
    "```",
    "",
    "```sh",
    "echo still mine",
    "```",
    "",
  ].join("\n"),
);
store.vault = { state: "locked", pass: "letmein" };
// The built-in docs, attached at boot the way the real registry attaches them.
// Four pages:
// - Getting Started, whose runnable block is unmarked unlike the real corpus.
//   docs.spec.ts checks that the read-only editor does not withhold a run,
//   `norun` does.
// - A second page, so the docs browser is a real list.
// - A third whose title sorts before every other page while its numbered
//   filename does not, so a spec can tell path order from title order.
// - The licenses page the Help command lands on by name.
// The filenames are numbered like the real manifest's (bun/docsContent.ts)
// because the browser sorts the docs workspace by path. Seeded last, so the
// older specs' per-workspace counts (scratch's rows, quick-open's scoped
// lists) see what they always saw.
store.attach(DOCS);
store.seedAt(
  DOCS,
  "01-getting-started.md",
  [
    "# Getting Started",
    "",
    "Welcome to Ledge. docs needle body.",
    "",
    "```sh",
    "echo hello from the docs",
    "```",
    "",
  ].join("\n"),
);
store.seedAt(DOCS, "02-workspaces-guide.md", "# Workspaces Guide\n\nfolders all the way down\n");
store.seedAt(DOCS, "03-about-panes.md", "# About Panes\n\nsplits and tabs\n");
// The generated notices page, last in the manifest as in the real one. The
// docs.licenses command opens a page by title (commands/registry.ts), so the
// spec for that command needs a page with exactly this H1.
store.seedAt(DOCS, "04-third-party-licenses.md", "# Third-Party Licenses\n\nMIT, and company\n");

configureNotes({
  list: async (folder) => store.list(folder),
  read: async (path) => store.readFile(path),
  search: (folder, query, scope) => store.search(folder, query, scope),
  backlinks: async (path) => store.backlinks(path),
  tags: async (folder, scope) => store.tags(folder, scope),
  tagged: async (folder, tag) => store.tagged(folder, tag),
  write: async (path, text, baseMtimeMs) => store.write(path, text, baseMtimeMs),
  stash: async (path, text) => store.stash(path, text),
  create: async (folder, text, subfolder) => store.create(folder, text, subfolder),
  retitle: async (path, text) => store.retitle(path, text),
  move: async (path, subfolder) => store.moveNote(path, subfolder),
  favorite: async (path, on) => store.favorite(path, on),
  renameFolder: async (folder, subfolder, name) => store.renameFolder(folder, subfolder, name),
    deleteFolder: async (folder, subfolder) => store.deleteFolder(folder, subfolder),
  remove: async (path) => store.remove(path),
  trash: async (folder) => store.listTrash(folder),
  restore: async (path) => store.restore(path),
  removeTrashed: async (path) => store.removeTrashed(path),
  empty: async (folder) => store.empty(folder),
  // No shells here (see configureBridge below), so there is nothing for a
  // note's spawn params to configure. The call does nothing.
  configureSession: () => {},
  // No open request is pending at harness boot. Specs drive the live-push
  // path instead, through window.__harness.externalOpen below.
  takeOpenRequest: async () => null,
  openDaily: async (folder) => store.openDaily(folder),
  createFromTemplate: async (folder, templatePath, title) => store.createFromTemplatePath(folder, templatePath, title),
});

// The vault fake, at the same seam the app wires (boot.tsx). State changes echo
// through recordVaultState the way the real vaultChanged push does. The app's
// eviction and reload paths must not care which end drove the change.
configureVault({
  state: async () => store.vault.state,
  create: async (pass) => {
    const ok = store.vaultCreate(pass);
    if (ok) recordVaultState("unlocked");
    return ok;
  },
  unlock: async (pass) => {
    const ok = store.vaultUnlock(pass);
    if (ok) recordVaultState("unlocked");
    return ok;
  },
  lock: async () => {
    store.vaultLock();
    recordVaultState(store.vault.state);
  },
  lockNote: async (path) => ({ note: store.lockNote(path), sealedShared: [] }),
  removeLock: async (path) => store.removeLock(path),
  changePassphrase: async (pass) => {
    if (store.vault.state !== "unlocked") return { ok: false, rewrapped: 0, error: "the vault is locked" };
    store.vault.pass = pass;
    return { ok: true, rewrapped: 1, error: null };
  },
});
recordVaultState(store.vault.state);

// The registry fake. attach always offers EXTERNAL, the folder the "native
// dialog" picks, so the attach flow runs in specs with no dialog, including
// close then re-attach, which proves nothing was deleted. create mirrors
// createManaged's slug-and-enumerate.
configureWorkspaces({
  // folderDialog and cliShim follow the faked shell. The harness's "native
  // dialog" is a function that always picks /external, the way a Mac with
  // somebody at it answers, and its CLI is the app's. The ios shell is the
  // headless case: both report false, and specs see the refusals the real one
  // gives.
  list: async () => ({
    workspaces: store.workspaceList(),
    dailyRoot: null,
    folderDialog: !FAKING_IOS,
    cliShim: !FAKING_IOS,
  }),
  create: async (name) => store.createManaged(name),
  attach: async () => {
    store.attach(EXTERNAL);
    return { root: EXTERNAL, kind: "external", error: null };
  },
  detach: async (root) => store.detach(root),
  // The "native destination picker" always picks /synced, the cloud-folder
  // stand-in, so the move flow runs in specs with no dialog, the same trick
  // attach uses above: the folder relocates, the notes stay, and the kind
  // flips to external. The home face targets /harness, the fake app home, and
  // flips the kind back.
  move: async (root, home) => ({
    root: store.move(root, home ? "/harness" : "/synced"),
    kind: home ? "managed" : "external",
    error: null,
  }),
});

// No PTYs here: runs and the terminal are inert. A spec that needs real run
// behavior belongs to the live probe instead (testing.md §6).
// Link opens are recorded rather than performed, like the settings opens
// below: launching a browser is a native seam.
const linkOpens: string[] = [];
// Runs are inert, but which machine a run names is view-side policy (the host
// picker's always-ask rule), so the record carries the target for specs.
const inlineRuns: { sessionId: string; id: string; host: string | null }[] = [];
// Grid sizes reported to the run's shell. Recorded because when the first one
// goes out is view-side behavior, and it has a consequence on the other side:
// a shell not yet told the panel's width runs the block at the pty's default,
// so anything laying out to COLUMNS is wrong for that run.
const inlineResizes: { id: string; cols: number; rows: number }[] = [];
// Everything typed at a run, in order. Recorded because the run's own keyboard
// is a native accessory bar on the one client that has it (ios.md §7): all a
// spec can see of Ctrl-C is the byte that left for the shell.
const inlineInputs: { id: string; data: string }[] = [];
// The reconnect reconciliation (editor/bridge.ts reconcileRuns): what the
// client claimed, and what this fake server says is still running. Nothing by
// default, which is what a server answers about a page that reloaded. That
// answer has a visible consequence: the run panels close out.
const runClaims: string[][] = [];
let runsStillRunning: string[] = [];
configureBridge({
  runInline: (sessionId, id, _code, _language, host) => {
    inlineRuns.push({ sessionId, id, host });
  },
  cancelRun: () => {},
  claimRuns: (ids) => {
    runClaims.push([...ids]);
    return Promise.resolve(ids.filter((id) => runsStillRunning.includes(id)));
  },
  resizeInline: (_sessionId, id, cols, rows) => {
    inlineResizes.push({ id, cols, rows });
  },
  inputInline: (_sessionId, id, data) => {
    inlineInputs.push({ id, data });
  },
  openLink: (url) => {
    linkOpens.push(url);
  },
});
// The terminal stays inert (no PTY output), but which note a paste or attach
// addresses is view-side routing: the drawer must show the shell of the same
// note the block's run was sent to. Those sessionIds are recorded for specs.
const termAttaches: { sessionId: string; host: string | null }[] = [];
const termPastes: { sessionId: string; text: string; host: string | null }[] = [];
const termInputs: { sessionId: string; dataB64: string }[] = [];
// `afterAttach` records how many attaches had gone out when this resize did.
// It is the only part of a resize a spec can check, since the pty is inert:
// whether the drawer sized a shell it does not yet own is view-side ordering.
const termResizes: { sessionId: string; cols: number; rows: number; afterAttach: number }[] = [];
// Claims sent, and what the fake server answers them with. The default is the
// ordinary reconnect: the shell is still this client's, with an empty
// scrollback, the inert terminal's stand-in for "nothing was missed". A spec
// that wants one of the other two answers sets it before dropping the wire
// (window.__harness.shellClaim).
const termClaims: string[] = [];
let claimAnswer: TerminalClaim = { state: "attached", dataB64: "", host: "local" };
configureTerminal({
  sendInput: (sessionId, dataB64) => {
    termInputs.push({ sessionId, dataB64 });
  },
  sendPaste: (sessionId, text, _language, host) => {
    termPastes.push({ sessionId, text, host: host ?? null });
  },
  sendResize: (sessionId, cols, rows) => {
    termResizes.push({ sessionId, cols, rows, afterAttach: termAttaches.length });
  },
  attach: async (sessionId, host) => {
    termAttaches.push({ sessionId, host: host ?? null });
    return { dataB64: "", host: host ?? "local" };
  },
  detach: () => {},
  status: async () => ({ live: false, host: null }),
  claim: async (sessionId) => {
    termClaims.push(sessionId);
    return claimAnswer;
  },
  closeSession: () => {},
  restartSession: () => {},
});

// In-memory layout file, like the clipboard below: saves are recorded, and a
// spec reads the latest serialization back through window.__harness. The boot
// below passes null, so a harness run always starts from the seeded notes.
// Restore behavior is covered by workspace/persist.test.ts instead.
let layoutText: string | null = null;
configureLayout({
  save: (text) => {
    layoutText = text;
  },
});

// In-memory clipboard, readable by specs through window.__harness. The HTML
// flavor has no in-app writer: only another application puts one on the
// pasteboard. Specs seed it through setClipboardHtml, and a copy made in the
// app clears it, the way pbcopy does.
let clip = "";
let clipHtml = "";
configureClipboard({
  write: (text) => {
    clip = text;
    clipHtml = "";
  },
  read: async () => clip,
  readRich: async () => ({ text: clip, html: clipHtml }),
});

// In-memory image assets, mirroring bun/assets.ts: read serves a seeded map
// (a missing entry gives null, which draws the broken placeholder), and
// pasteImage allocates a fresh name and returns a markdown reference like the
// real assetPaste. Keyed folder\0src like lib/assets' cache, so per-workspace
// scoping is real. The seeded image is SCRATCH's, and a 1x1 PNG that loads.
const PIXEL_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const assets = new Map<string, { dataB64: string; mime: string }>([
  [`${SCRATCH}\0assets/dot.png`, { dataB64: PIXEL_B64, mime: "image/png" }],
]);
let pasteCount = 0;
let pastedB64: string | null = null;
// `?pick=cancel` boots with a picker that answers null every time. That is the
// dialog's other outcome, and the one a "nothing is inserted" spec needs.
const PICK_CANCELS = new URLSearchParams(window.location.search).get("pick") === "cancel";
configureAssets({
  // notePath is accepted and ignored: every harness note sits at its root, so
  // the reference is the key. Bun's resolution against the note's folder is
  // filesystem behavior, covered where the filesystem is (bun/assets.test.ts).
  read: async (folder, src, _notePath) => assets.get(`${folder}\0${src}`) ?? null,
  // notePath is accepted because the real handler seals pastes into locked
  // notes. The fake stores plaintext either way: sealed reads are the behavior
  // surface, and no harness spec pastes into a locked note. A locked note's
  // editor is reachable only unlocked, where pastes stay plain until the next
  // lock.
  // The bytes a paste event carried are kept for a spec to read back
  // (window.__harness.pastedBytes), since they are the event's whole point.
  pasteImage: async (folder, _notePath, dataB64) => {
    pastedB64 = dataB64 ?? null;
    pasteCount += 1;
    const src = `.ledge-assets/pasted-${pasteCount}.png`;
    assets.set(`${folder}\0${src}`, { dataB64: PIXEL_B64, mime: "image/png" });
    return src;
  },
  // The "picker" always picks, so Insert Image… runs end to end in a spec with
  // no dialog, the same trick attach uses, and it writes the same fake file a
  // paste does. Cancelling is the other outcome and needs a fake of its own,
  // since a picker that never cancels cannot show that null inserts nothing.
  // The `?pick=cancel` boot above is that fake.
  pickImage: async (folder, _notePath) => {
    if (PICK_CANCELS) return null;
    pasteCount += 1;
    const src = `.ledge-assets/picked-${pasteCount}.png`;
    assets.set(`${folder}\0${src}`, { dataB64: PIXEL_B64, mime: "image/png" });
    return src;
  },
});

// A non-default editor font size, so a spec can tell "the setting reached the
// editor" apart from "the old hardcoded 14px is still there".
// No template configuration: templates are notes carrying `template: true`
// frontmatter, seeded per spec. A boot-time seed would shift every list-count
// assertion in the older specs.
//
// `?theme=light|dark` overrides the appearance setting for one load. Settings
// apply at launch and this one has no control of its own (the settings file is
// where it is edited), so a query param is the only way a spec can boot the
// harness with an override in place. It stands in for the real app's relaunch.
const themeParam = new URLSearchParams(window.location.search).get("theme");
const HARNESS_SETTINGS = {
  ...DEFAULT_SETTINGS,
  editor: { ...DEFAULT_SETTINGS.editor, fontSize: 18 },
  appearance: {
    theme: THEMES.includes(themeParam as Theme) ? (themeParam as Theme) : DEFAULT_SETTINGS.appearance.theme,
  },
};
// The settings file as an in-memory string, seeded like a real first launch
// (the commented template), so the ⌘, dialog is drivable end to end and a
// spec can assert what a save wrote. Two of them, because settings have two
// homes (remote.md §5) and the dialog has a tab per home: with one file, a
// bridge that ignored the home argument would still pass.
const settingsFiles: Record<SettingsHome, string> = {
  server: settingsTemplate(DEFAULT_SETTINGS.shell.path),
  client: clientSettingsTemplate(HARNESS_SETTINGS),
};
const profiles = new Map<string, string>();
configureSettings(
  HARNESS_SETTINGS,
  {
    readSettingsFile: async (home) => settingsFiles[home],
    writeSettingsFile: async (home, text) => {
      settingsFiles[home] = text;
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
// The connection list, in memory. Two entries so the picker has something to
// switch between, and on the Mac one of them refuses to open: falling back to
// this Mac with the reason showing is a state the chrome has to render, and a
// fake with only a happy path would never reach it.
//
// A phone's list has no local row and cannot have one, since there is no
// server in that process to fall back to (remote.md §8). That absence is why
// its remove rule differs, so the fake carries it too.
let connections: ConnectionInfo[] = FAKING_IOS
  ? [
      { id: "vps-1", name: "VPS", destination: "ledge@vps", port: 0, keyPath: "", auth: "key", pinned: true, lastReached: 0 },
      {
        id: "pi-1",
        name: "Pi",
        destination: "dev@pi.local",
        port: 0,
        keyPath: "",
        // One row already on the password door, so a spec can drive the edit
        // case where the field may be left blank
        // (components/ConnectionPicker.tsx).
        auth: "password",
        pinned: true,
        lastReached: 0,
      },
    ]
  : [
      { id: "local", name: "This Mac", destination: "", port: 0, keyPath: "", auth: "key", pinned: false, lastReached: 0 },
      {
        id: "vps-1",
        name: "VPS",
        destination: "ledge@vps",
        port: 0,
        keyPath: "",
        auth: "key",
        pinned: true,
        lastReached: 1_700_000_000_000,
      },
    ];
// What the fake keychain was told, so a spec can assert that a password reached
// the shell and that a rename did not send one (remote.md §4).
const passwords = new Map<string, string>();
let activeConn = FAKING_IOS ? "vps-1" : "local";
// Destinations the fake server refuses, so a spec can drive the refusal path.
const unreachable = FAKING_IOS ? new Set<string>() : new Set(["ledge@vps"]);
// A destination whose RPC rejects rather than refusing. That is a different
// failure: Bun taking longer than the view's maxRequestTime, or dying
// mid-request (mainview/main.tsx). A refusal comes back as a sentence and a
// rejection comes back as a thrown error, and the dialog has to survive both.
// The `busy` flag it sets before either one gates every control in it.
// Two sentinels, because the dialog reaches this hazard two ways: the form's
// Continue button, which probes, and a row in the list, which selects. The
// message is electrobun's own, verbatim, since it is the one a user gets when
// this happens.
const WEDGED_PROBE = "ledge@wedged";
const WEDGED_SELECT = "ledge@wedged-later";
const RPC_GAVE_UP = "RPC request timed out.";
// How many times this client has been asked to dial now rather than wait for
// its next retry beat (rpc-schema connectionReconnect). The fake only counts:
// there is no wire here to redial, and a spec is asking only whether the verb
// reached the shell.
let reconnects = 0;
configureConnections(
  { connections, active: activeConn, wanted: activeConn, error: "", build: "0.1.0-harness" },
  {
    list: async () => ({ connections, active: activeConn, wanted: activeConn, error: "", build: "0.1.0-harness" }),
    reconnect: async () => {
      reconnects += 1;
      return { ok: true };
    },
    select: async (id) => {
      const conn = connections.find((c) => c.id === id);
      if (!conn) return { ok: false, error: "There is no such connection." };
      if (conn.destination === WEDGED_SELECT) throw new Error(RPC_GAVE_UP);
      if (unreachable.has(conn.destination)) return { ok: false, error: `Could not reach ${conn.name}: host is down` };
      activeConn = id;
      return { ok: true, error: "" };
    },
    add: async ({ name, destination, port, auth, password, hostKey }) => {
      const refusal = auth === "password" ? validatePassword(password) : null;
      if (refusal) return { id: "", error: refusal };
      const id = `conn-${connections.length}`;
      if (auth === "password") passwords.set(id, password);
      connections = [
        ...connections,
        { id, name, destination, port, keyPath: "", auth, pinned: hostKey !== "", lastReached: 0 },
      ];
      return { id, error: "" };
    },
    update: async ({ id, name, destination, port, keyPath, auth, password, hostKey }) => {
      const before = connections.find((c) => c.id === id);
      if (!before) return { ok: false, error: "There is no such connection." };
      if (id === "local") return { ok: false, error: "This Mac is not a connection you can edit." };
      if (auth === "password" && password === null && before.auth !== "password") {
        return { ok: false, error: "That connection has no password stored. Enter one." };
      }
      if (auth === "password" && password !== null) {
        const refusal = validatePassword(password);
        if (refusal) return { ok: false, error: refusal };
      }
      if (unreachable.has(destination) && id === activeConn) {
        return { ok: false, error: `Could not reach ${name}: host is down` };
      }
      if (auth === "key") passwords.delete(id);
      else if (password !== null) passwords.set(id, password);
      connections = connections.map((c) =>
        c.id === id
          ? { ...c, name, destination, port, keyPath, auth, pinned: hostKey === null ? c.pinned : hostKey !== "" }
          : c,
      );
      return { ok: true, error: "" };
    },
    remove: async (id) => {
      if (id === "local") return { ok: false, error: "This Mac is always here; it cannot be removed." };
      // A phone can remove its last connection. It has no local server to fall
      // back to, so refusing would leave a server it could never forget
      // (lib/nativeBridge.ts connectionRemove).
      if (id === activeConn && (!FAKING_IOS || connections.length > 1)) {
        return { ok: false, error: FAKING_IOS ? "Switch to another server before removing this one." : "Switch somewhere else before removing this connection." };
      }
      connections = connections.filter((c) => c.id !== id);
      passwords.delete(id);
      return { ok: true, error: "" };
    },
    // The pinned line carries the port the way keyscan's does, so a spec can
    // see that a non-default port becomes part of what is pinned
    // (shared/connections.ts knownHostsHost).
    probe: async (destination, port) =>
      destination === WEDGED_PROBE
        ? Promise.reject(new Error(RPC_GAVE_UP))
        : destination.includes("nowhere")
        ? { hostKey: "", fingerprint: "", keyType: "", error: `No answer from ${destination}.` }
        : {
            hostKey: `${knownHostsHost(destination, port)} ssh-ed25519 AAAA`,
            fingerprint: "SHA256:harness+fake+key",
            keyType: "ED25519",
            error: "",
          },
  },
);

// Stamps the resolved appearance on <html>, like main.tsx does after boot.
applyAppearance();

// The shim write is a native seam. The harness answers with a canned success,
// so the palette command and its notice strip are drivable end to end.
configureCli({
  install: async () => ({ ok: true, message: "ledge installed: ~/.local/bin/ledge" }),
});

// The app's update is the shell's, and this fake plays the shell: it holds the
// state, pushes every change the way bun/updates.ts does (the push before the
// answer), and finishes a check with whatever a spec set as its result.
let updateShell: UpdateState = { phase: "current", version: "0.1.0", detail: "" };
let updateCheckResult: UpdateState = { phase: "current", version: "0.1.0", detail: "" };
let updateChecks = 0;
let updateInstalls = 0;
function pushUpdate(next: UpdateState): void {
  updateShell = next;
  recordUpdateState(next);
}
configureUpdates({
  state: async () => updateShell,
  check: async () => {
    updateChecks += 1;
    if (updateShell.phase === "ready" || updateShell.phase === "downloading") return updateShell;
    pushUpdate({ phase: "checking", version: "", detail: "" });
    setTimeout(() => pushUpdate(updateCheckResult), 50);
    return updateShell;
  },
  install: async () => {
    updateInstalls += 1;
    return updateShell.phase === "ready";
  },
});
void loadUpdateState();

// New Window is a native seam with no in-page consequence: the second window is
// another client of another server, in another webview (remote.md §8a). A spec
// can see only that the ask left, and how many times. The manual's window is the
// same seam. A spec in the ordinary harness window sees which page was asked
// for; loading the harness with `?docs=1` renders that window itself.
const windowOpens: number[] = [];
const docsOpens: string[] = [];
configureWindows({
  open: () => {
    windowOpens.push(windowOpens.length + 1);
  },
  openDocs: (page) => {
    docsOpens.push(page);
  },
});

declare global {
  interface Window {
    __harness: {
      clipboard: () => string;
      // Put both pasteboard flavors up, the way another app's copy does: the
      // rich-paste path has no in-app writer to drive it from.
      setClipboard: (text: string, html: string) => void;
      // The bytes the last image paste carried, or null when it read the
      // pasteboard instead (editor/clipboard.ts pasteEvent).
      pastedBytes: () => string | null;
      // Keyed by home: the dialog has a tab per settings file.
      settingsText: (home: SettingsHome) => string;
      linkOpens: () => string[];
      // How many windows New Window asked the shell for.
      windowOpens: () => number;
      // Every page the manual's window was asked for, in order ("" is the
      // landing page). The window itself is another webview, which a spec
      // reaches by loading the harness with `?docs=1`.
      docsOpens: () => string[];
      // Simulate the shell's docsShow push: somebody asked for a page while
      // the manual's window was already open. Only meaningful under `?docs=1`.
      showDocs: (page: string) => void;
      // Simulate the shell's updateChanged push, for the states no page action
      // reaches: a background download finishing, a build that does not update.
      setUpdate: (state: UpdateState) => void;
      // What the next Check for Updates… finds.
      setUpdateCheckResult: (state: UpdateState) => void;
      updateChecks: () => number;
      updateInstalls: () => number;
      layout: () => string | null;
      termAttaches: () => { sessionId: string; host: string | null }[];
      termPastes: () => { sessionId: string; text: string; host: string | null }[];
      // Every keystroke the drawer sent at its shell, in order. Specs use it to
      // assert that the keystrokes stop: a drawer another client has taken must
      // not type into a shell it can no longer see.
      termInputs: () => { sessionId: string; dataB64: string }[];
      // Every grid the drawer reported for its shell, with how many attaches
      // preceded it.
      termResizes: () => { sessionId: string; cols: number; rows: number; afterAttach: number }[];
      // Simulate Bun's terminalDetached push: another client attached to this
      // note's shell, so this one no longer has it. No user action can cause it
      // here, since the other client is the one acting. externalOpen is on this
      // object for the same reason. `by` is that client's id, which the notice
      // turns into a name through the presence list below.
      terminalTaken: (sessionId: string, by?: string) => void;
      // Simulate the presence push: who else is connected to this server
      // (remote.md §7). Here for the same reason as the one above. The event is
      // another device arriving or leaving, which nothing in this page can do.
      presence: (others: { client: string; label: string }[]) => void;
      inlineRuns: () => { sessionId: string; id: string; host: string | null }[];
      // Every grid reported to a run's shell, in order.
      inlineResizes: () => { id: string; cols: number; rows: number }[];
      // Everything that reached a run's shell as input, in order.
      inlineInputs: () => { id: string; data: string }[];
      // A key on the run's accessory bar, pressed (ios.md §7). The bar is
      // native and its taps arrive over the Swift bridge, so this stands in for
      // Swift the way runOutput stands in for Bun. The rules live on the page
      // side: which panel the key lands in, and what bytes it becomes.
      runKey: (name: string) => boolean;
      // Which face the bar would wear for whatever has focus right now
      // (lib/nativeBridge.ts barFaceOf). It looks for the run panel first,
      // because a run's panel sits inside the editor.
      barFace: () => BarFace;
      // Every set of run ids this client has claimed, in order (one per boot
      // and per reconnect; editor/bridge.ts reconcileRuns).
      runClaims: () => string[][];
      // Which runs the fake server admits to still running when claimed. Set
      // before driving linkState("live") to choose which half of the
      // reconciliation a spec is testing.
      holdRuns: (ids: string[]) => void;
      // Push one output byte-string at a run, the way Bun's runEvent would. Not
      // the PTY coming back: the harness stays inert, and real run behavior
      // belongs to the live probe. It drives the one view-side seam a spec
      // cannot otherwise reach, what the panel does when a run first speaks: on
      // a Mac it takes the keyboard (blocks.ts), on a phone it asks to be tapped.
      runOutput: (id: string, text: string) => void;
      // The run ending, the other half of that seam: the panel freezes, gives
      // the keyboard back if it had it, and drops the controls that only a live
      // run has.
      runEnd: (id: string, exitCode: number | null) => void;
      // Simulate the CLI's openExternal push (a Bun-side watcher event has no
      // visible surface to drive it from).
      externalOpen: (open: ExternalOpenInfo) => void;
      // Simulate the watcher's notesChanged push for one root. This is how a
      // spec makes a store.seed visible to the app's lists, and it is the same
      // refresh a real external write triggers.
      notesChanged: (root: string) => void;
      // The wire dropping (remote.md §7). This app's own Bun side pushes it in
      // the real thing, so there is no user action a spec could take to cause
      // it. Same reason externalOpen is here.
      linkState: (state: "live" | "reconnecting" | "lost", detail: string) => void;
      // How many times the shell has been asked to dial now (see `reconnects`).
      reconnects: () => number;
      // Every session a drawer has claimed, in order (one per reconnect;
      // rpc-schema terminalClaim).
      shellClaims: () => string[];
      // What the fake server says became of a claimed shell. Set before driving
      // linkState("live") to choose which of the three answers a spec is
      // testing. An "attached" one carries the scrollback to replay.
      shellClaim: (claim: TerminalClaim) => void;
      // The vault moving on the server with nobody listening: its idle relock
      // firing, or another device unlocking it. The state changes and no
      // vaultChanged reaches the app, the way a push at a dropped wire is lost
      // (bun/daemon.ts). Not the store's vaultLock paired with recordVaultState,
      // which is the connected path: this is the app never being told.
      vaultMoved: (state: VaultState) => void;
      store: FakeStore;
    };
  }
}
window.__harness = {
  clipboard: () => clip,
  setClipboard: (text, html) => {
    clip = text;
    clipHtml = html;
  },
  pastedBytes: () => pastedB64,
  settingsText: (home) => settingsFiles[home],
  linkOpens: () => [...linkOpens],
  windowOpens: () => windowOpens.length,
  docsOpens: () => [...docsOpens],
  showDocs: (page) => dispatchDocsShow(page),
  setUpdate: (state) => pushUpdate(state),
  setUpdateCheckResult: (state) => {
    updateCheckResult = state;
  },
  updateChecks: () => updateChecks,
  updateInstalls: () => updateInstalls,
  layout: () => layoutText,
  termAttaches: () => termAttaches.map((a) => ({ ...a })),
  termPastes: () => termPastes.map((p) => ({ ...p })),
  termInputs: () => termInputs.map((i) => ({ ...i })),
  termResizes: () => termResizes.map((r) => ({ ...r })),
  terminalTaken: (sessionId, by = "") => dispatchTerminalDetached(sessionId, by),
  presence: (others) => recordPresence(others),
  inlineRuns: () => inlineRuns.map((r) => ({ ...r })),
  inlineResizes: () => inlineResizes.map((r) => ({ ...r })),
  inlineInputs: () => inlineInputs.map((i) => ({ ...i })),
  runKey: (name) => sendRunKey(name),
  barFace: () => barFaceOf(document.activeElement),
  runOutput: (id, text) => dispatchRunEvent({ id, kind: "output", dataB64: btoa(text) }),
  runEnd: (id, exitCode) => dispatchRunEvent({ id, kind: "ended", exitCode }),
  externalOpen: (open) => dispatchExternalOpen(open),
  notesChanged: (root) => dispatchNotesChanged(root),
  runClaims: () => runClaims.map((ids) => [...ids]),
  holdRuns: (ids) => {
    runsStillRunning = [...ids];
  },
  shellClaims: () => [...termClaims],
  shellClaim: (claim) => {
    claimAnswer = claim;
  },
  vaultMoved: (state) => {
    store.vault.state = state;
  },
  // linkState below does the same things boot.tsx's connectionState push does,
  // because a reconnect that did not reconcile is not the reconnect the app
  // performs. It also holds saves on the way down, because the stranded-buffer
  // path is only reachable through that hold.
  reconnects: () => reconnects,
  linkState: (state, detail) => {
    recordLinkState(state, detail);
    if (state === "lost") {
      holdSaves();
      dispatchRunLink(false);
    }
    if (state === "live") {
      void resolveStrandedNotes();
      dispatchRunLink(true);
      void reconcileRuns();
      dispatchTerminalRelink();
      void refreshVaultState().catch(() => {});
      dispatchNotesRelink();
    }
  },
  store,
};

// `?fresh`: the scratch folder boots empty. That is what a first launch on a
// Mac and a first connection to a server with no notes both are, and the one
// boot that opens the welcome note (workspace/seeds.ts) rather than a file. The
// wipe runs after the seeding rather than the seeds being skipped, so the
// fixtures above stay one list and the other specs see what they always saw.
if (new URLSearchParams(window.location.search).has("fresh")) store.wipe(SCRATCH);

// `?folders`: the scratch workspace with its notes filed into folders, for the
// browser tree's specs. Opt-in rather than part of the fixtures above, because
// folder rows sort before note rows and the flat-list specs pin the first and
// last row of that list (e2e/list-verbs.spec.ts). One note stays at the top
// level, so a spec can drag between the two levels in both directions.
if (new URLSearchParams(window.location.search).has("folders")) {
  store.wipe(SCRATCH);
  store.seed(SCRATCH, "# Alpha\n\nalpha body\n");
  store.seed(SCRATCH, "# Beta\n\nbeta body\n", "projects");
  store.seed(SCRATCH, "# Gamma\n\ngamma body\n", "projects/api");
  store.seed(SCRATCH, "# Delta\n\ndelta body\n", "admin");
}

// Same boot shape as main.tsx: the registry first, then per-folder lists. The
// layout passed below is null, because a harness run always starts from the
// seeded notes and persist.test.ts covers restore instead. Same fork at the end
// too: the manual's window boots onto the page it was opened for (`?page=`, the
// harness's stand-in for the title the shell passes through windowRole).
const bootRoots = store.workspaceList();
recordWorkspaceKinds(bootRoots);
const bootPage = new URLSearchParams(window.location.search).get("page") ?? "";

const render = (): void =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App
        initial={
          DOCS_WINDOW
            ? docsState(DOCS, store.list(DOCS), bootPage)
            : restoredState(
                null,
                bootRoots,
                Object.fromEntries(bootRoots.map((r) => [r.root, store.list(r.root)])),
                Object.fromEntries(bootRoots.map((r) => [r.root, store.listTrash(r.root)])),
              )
        }
      />
    </StrictMode>,
  );

// The screen a boot shows while it is still waiting on a server (lib/booting.ts).
//
// A harness boot waits on a Map and is never slow, so the wait is a knob.
// `?booting=<ms>` holds the screen up for that long before rendering, in the
// shape both real shells raise it (up before the waits, down before the
// render). A spec then looks at the real element with the real stylesheet, in
// the shipping engine. `?bootingTo=` is the destination, which on a phone is
// what `@hello` answers with.
//
// Without the knob the render stays synchronous, so no other spec's first paint
// moves.
const bootingFor = Number(new URLSearchParams(window.location.search).get("booting") ?? 0);
if (bootingFor > 0) {
  showBooting({
    destination: new URLSearchParams(window.location.search).get("bootingTo") ?? "",
    // The harness's stand-in for `servers.choose` (ios.tsx): the real one hands
    // the window back to Swift, which tears this page down. There is no shell
    // here to hand it to, so the press is recorded and the screen stays. A spec
    // can see that the button did something, and nothing more.
    onCancel: () => {
      document.body.dataset["bootingCancelled"] = "1";
    },
  });
  setTimeout(() => {
    hideBooting();
    render();
  }, bootingFor);
} else {
  render();
}
