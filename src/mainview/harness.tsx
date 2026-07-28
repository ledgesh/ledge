// The e2e harness entrypoint: the whole app, with the Bun process replaced by
// an in-memory fake at the same seams main.tsx wires (testing.md §5).
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
import type { BacklinkHit, NoteMeta, TagHit, TrashMeta, WorkspaceRootInfo } from "../shared/rpc-schema";
import { headingOf, labelOf, slugify, slugOf } from "../shared/slug";
import { frontmatterEnd, parseFrontmatter } from "../shared/frontmatter";
import { instantiateTemplate, isoDateOf } from "../shared/template";
import { collectHits, type SearchHit } from "../shared/search";
import { resolveWikiTitle, wikiRefsOf } from "../shared/wikilinks";
import { normalizeTag, tagDirectoryOf, tagRefsOf, type TagInfo } from "../shared/tags";
import { configureBridge, dispatchRunEvent } from "./editor/bridge";
import { configureTerminal } from "./terminal/channel";
import { configureNotes, dispatchExternalOpen, dispatchNotesChanged, type ExternalOpenInfo, type NoteFile } from "./notes/channel";
import { configureVault, recordVaultState } from "./vault/channel";
import { configureWorkspaces, recordWorkspaceKinds } from "./workspace/channel";
import { configureClipboard } from "./lib/clipboard";
import { configureCli } from "./lib/cli";
import { configureAssets } from "./lib/assets";
import { configureSettings } from "./lib/settings";
import { DEFAULT_SETTINGS, SETTINGS_TEMPLATE, THEMES, type Theme } from "../shared/settings";
import { applyAppearance } from "./lib/theme";
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
// The built-in documentation root, attached at boot like the real one
// (bun/workspaces.ts registers it at every load): kind "docs", hidden from
// the strip, and every fake write below refuses it — the same read-only
// contract the real store enforces (assertWritableRoot).
const DOCS = "/harness/.ledge-docs";

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

  // The fake workspaceMove: rename(2) in Map form. The root key and every
  // path under it are rekeyed to the destination — data travels whole, and
  // the registry line is replaced in place, mirroring moveRoot's contract —
  // including the own-parent no-op (the real one answers the same root back,
  // and the view's leave-tabs-alone branch keys off exactly that).
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

  // The real store's read-only gate (assertWritableRoot), fake edition: every
  // mutating path below calls this, so a spec that reaches a docs write by
  // any route gets the same refusal the app would.
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

  // Seed under a stated filename rather than the H1's slug: the docs pages'
  // names are manifest artifacts (numbered for reading order, like the real
  // bun/docsContent.ts), not derived from their titles.
  seedAt(root: string, name: string, text: string): void {
    const data = this.ensureRoot(root);
    data.notes.set(`${root}/${name}`, { text, mtimeMs: this.tick() });
  }

  seedTrash(root: string, text: string): void {
    const data = this.ensureRoot(root);
    const path = `${root}/.ledge-trash/${this.allocate(text, data.trash.keys())}`;
    data.trash.set(path, { text, deletedAt: this.tick() });
  }

  private meta(data: RootData, path: string): NoteMeta {
    const n = data.notes.get(path)!;
    // The real metaFor's flags, from the same shared parser: `template:`
    // frontmatter is what puts a note in the ⌥⌘N picker (the `daily` role
    // rides the value), and a `locked:` value marks the note locked.
    const p = parseFrontmatter(n.text).params;
    return {
      path,
      title: labelOf(headingOf(n.text), path),
      mtimeMs: n.mtimeMs,
      ...(p.template ? { template: p.template } : {}),
      ...(p.locked !== null ? { locked: true as const } : {}),
    };
  }

  // --- the vault fake --------------------------------------------------------
  // bun/vault.ts condensed: state + a remembered passphrase; no crypto — the
  // fake stores plaintext and WITHHOLDS it while locked, which is the exact
  // behavior surface the specs assert on (placeholder faces, held reads,
  // skip counts). The `locked:` value is an inert marker string here.
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

  // The plaintext head, the real splitHead's answer: frontmatter block plus
  // the H1 line (with the blank run between, when a block precedes it).
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

  // The marker surgery, bun/vault.ts's stampLockedLine/stripLockedLine in
  // fake form (the value is inert here — "harness-v1" — but the LINE rules
  // are the real ones: Bun-owned, disk decides, an emptied block goes).
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

  // The Bun-owned-line rule (locking.md §2), fake edition: the marker is
  // decided by the DISK text, not the buffer — a save re-stamps or strips.
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

  // The read the channel handler serves: text plus disk version, like the real
  // readNote — the store echoes the mtime into write's baseMtimeMs. A locked
  // note reads whole only while the fake vault is unlocked; otherwise the
  // body is WITHHELD and `held` says so (the real seam's exact shape).
  readFile(path: string): NoteFile | null {
    const n = this.rootOf(path).data.notes.get(path);
    if (!n) return null;
    if (!this.lockedOf(n.text)) return { text: n.text, mtimeMs: n.mtimeMs };
    if (this.vault.state !== "unlocked") return { text: this.headOf(n.text), mtimeMs: n.mtimeMs, locked: true, held: true };
    return { text: n.text, mtimeMs: n.mtimeMs, locked: true };
  }

  // Test seam (window.__harness): an "agent" rewriting a note behind the app's
  // back — a fresh mtime, exactly what an external temp+rename write looks like.
  writeExternal(path: string, text: string): void {
    this.rootOf(path).data.notes.set(path, { text, mtimeMs: this.tick() });
  }

  create(root: string, text: string): NoteMeta {
    this.assertWritable(root);
    const data = this.ensureRoot(root);
    const path = `${root}/${this.allocate(text, data.notes.keys())}`;
    data.notes.set(path, { text, mtimeMs: this.tick() });
    return this.meta(data, path);
  }

  // Mirrors the real writeNote's guard (bun/notes.ts): a mismatched base with
  // genuinely different bytes moves the disk version into the trash and the
  // incoming text wins the live path; identical bytes just adopt the disk
  // mtime. The fake must carry the semantics or the harness specs would
  // green-light a view that never handles divergence.
  write(path: string, text: string, baseMtimeMs: number | null): { mtimeMs: number; divergedTo: string | null } {
    this.assertWritable(path);
    const { root, data } = this.rootOf(path);
    const cur = data.notes.get(path);
    // The disk decides the lock marker, never the buffer (the real
    // writeNote's rule); a locked save needs the vault open.
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

  remove(path: string): string | null {
    this.assertWritable(path);
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
  // the same two pieces (scoped to one root), so the semantics cannot drift —
  // including the locked skip: bodies of locked notes are never scanned,
  // vault state irrelevant, and the count rides back (locking.md §4).
  async search(root: string, query: string): Promise<{ hits: SearchHit[]; lockedSkipped: number }> {
    const metas = this.list(root);
    const open = metas.filter((m) => !m.locked);
    const hits = await collectHits(query, open, (p) => this.readNote(p));
    return { hits, lockedSkipped: metas.length - open.length };
  }

  // The real backlinksTo is listNotes + the shared wikilink scan; same
  // composition here, for the same cannot-drift reason as search above.
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

  // A locked note contributes its plaintext HEAD's tags only (the
  // frontmatter line stays visible; body hashtags are sealed) — the real
  // tagsIn's rule, from the same shared pieces.
  private tagSource(meta: NoteMeta): string | null {
    const text = this.readNote(meta.path);
    if (text === null) return null;
    return meta.locked ? this.headOf(text) : text;
  }

  tags(root: string): { tags: TagInfo[]; lockedSkipped: number } {
    let lockedSkipped = 0;
    const perNote = this.list(root).flatMap((meta) => {
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
  // note, so the fake takes its path too; a vanished template throws.
  // Instantiation is the SAME shared instantiateTemplate.
  createFromTemplatePath(root: string, templatePath: string, title: string | null): NoteMeta {
    const text = this.readNote(templatePath);
    if (text === null) throw new Error(`the template note is gone (${templatePath}); pick again`);
    return this.create(root, instantiateTemplate(text, title ?? "Untitled", new Date()));
  }

  // The real findDailyTemplate (bun/daily.ts): the note IN THIS ROOT marked
  // `template: daily` — strictly per-workspace, no borrowing from other
  // attached roots. The meta flag comes from the same shared parser, so
  // which note the role means cannot drift between harness and store.
  private findDailyTemplate(root: string): string | null {
    const local = this.list(root).find((n) => n.template === "daily");
    return local ? this.readNote(local.path) : null;
  }

  // Mirrors bun/daily.ts openDaily: local-date title, resolve-else-create,
  // instantiating the `template: daily` note when one exists — no settings.
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
// A locked note, sealed at boot: the vault exists and is LOCKED, passphrase
// "letmein" (e2e/locked-notes.spec.ts). Seeded with the marker in place —
// the fake's read withholds the body below the head while locked. The body
// carries a needle no search may surface and a prompt fence for the
// run-affordance spec. Titled to sort INSIDE the alpha…gamma fixture range
// (the sidebar is alphabetical, and list-verbs.spec.ts pins the edges) and
// deliberately tagless: tags-panel.spec.ts pins the workspace's tagless
// empty state, and the head-tags-stay-visible rule is notes.fs.test.ts's.
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
// The built-in docs, attached at boot like the real registry does. Four
// pages: Getting Started (with a runnable block — the read-only editor must
// still run it), a second page so the docs browser is a real list, a
// third whose TITLE sorts before the others while its numbered filename
// sorts last, so a spec can tell path order from title order, and the
// licenses page the Help command lands on by name. Filenames are
// numbered like the real manifest's (bun/docsContent.ts): the browser sorts
// the docs workspace by path. Seeded LAST so the older specs' per-workspace
// counts (scratch's rows, quick-open's scoped lists) see exactly what they
// always saw.
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
// The generated notices page, last in the manifest as in the real one. Its
// title is what docs.licenses lands on (registry.ts), so the spec for that
// command needs a page wearing exactly this H1.
store.seedAt(DOCS, "04-third-party-licenses.md", "# Third-Party Licenses\n\nMIT, and company\n");

configureNotes({
  list: async (folder) => store.list(folder),
  read: async (path) => store.readFile(path),
  search: (folder, query) => store.search(folder, query),
  backlinks: async (path) => store.backlinks(path),
  tags: async (folder) => store.tags(folder),
  tagged: async (folder, tag) => store.tagged(folder, tag),
  write: async (path, text, baseMtimeMs) => store.write(path, text, baseMtimeMs),
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
  // Nothing pending at harness boot; specs drive the live-push path instead,
  // through window.__harness.externalOpen below.
  takeOpenRequest: async () => null,
  openDaily: async (folder) => store.openDaily(folder),
  createFromTemplate: async (folder, templatePath, title) => store.createFromTemplatePath(folder, templatePath, title),
});

// The vault fake at the same seam main.tsx wires. State transitions echo
// through recordVaultState exactly as the real vaultChanged push would —
// the app's eviction/reload paths must not care which end drove the change.
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
    if (store.vault.state !== "unlocked") return { ok: false, rewrapped: 0 };
    store.vault.pass = pass;
    return { ok: true, rewrapped: 1 };
  },
});
recordVaultState(store.vault.state);

// The registry fake: attach always offers EXTERNAL — the folder the "native
// dialog" picks — so the attach flow (and close → re-attach, proving nothing
// was deleted) runs in specs without any dialog. create mirrors
// createManaged's slug-and-enumerate.
configureWorkspaces({
  list: async () => ({ workspaces: store.workspaceList(), dailyRoot: null }),
  create: async (name) => store.createManaged(name),
  attach: async () => {
    store.attach(EXTERNAL);
    return { root: EXTERNAL, kind: "external", error: null };
  },
  detach: async (root) => store.detach(root),
  // The "native destination picker" always picks /synced — the cloud-folder
  // stand-in — so the move flow (folder relocated, notes intact, kind flipped
  // external) runs in specs without a dialog, attach's move. The home face
  // targets /harness, the fake app home, and flips the kind back.
  move: async (root, home) => ({
    root: store.move(root, home ? "/harness" : "/synced"),
    kind: home ? "managed" : "external",
    error: null,
  }),
});

// No PTYs here: runs and the terminal are inert. A spec that needs run
// behavior has outgrown the harness and belongs to the live probe.
// Link opens are recorded, not performed, like settings opens below:
// launching a browser is a native seam.
const linkOpens: string[] = [];
// Runs are inert, but WHICH machine a run names is view-side policy (the
// host picker's always-ask rule), so the target rides the record for specs.
const inlineRuns: { sessionId: string; id: string; host: string | null }[] = [];
// Grids reported to the run's shell. Recorded because WHEN the first one goes
// out is view-side behavior with a real consequence on the other side: a shell
// that has not been told the panel's width runs the block believing the pty's
// default, and anything laying out to COLUMNS gets it wrong for that run.
const inlineResizes: { id: string; cols: number; rows: number }[] = [];
configureBridge({
  runInline: (sessionId, id, _code, _language, host) => {
    inlineRuns.push({ sessionId, id, host });
  },
  cancelRun: () => {},
  resizeInline: (_sessionId, id, cols, rows) => {
    inlineResizes.push({ id, cols, rows });
  },
  inputInline: () => {},
  openLink: (url) => {
    linkOpens.push(url);
  },
});
// The terminal stays inert (no PTY output), but WHICH note a paste or attach
// addresses is view-side routing — the drawer must show the same note's shell
// the block's run was sent to — so those sessionIds are recorded for specs.
const termAttaches: { sessionId: string; host: string | null }[] = [];
const termPastes: { sessionId: string; text: string; host: string | null }[] = [];
configureTerminal({
  sendInput: () => {},
  sendPaste: (sessionId, text, _language, host) => {
    termPastes.push({ sessionId, text, host: host ?? null });
  },
  sendResize: () => {},
  attach: async (sessionId, host) => {
    termAttaches.push({ sessionId, host: host ?? null });
    return { dataB64: "", host: host ?? "local" };
  },
  detach: () => {},
  status: async () => ({ live: false, host: null }),
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
  // notePath is accepted (the real handler seals pastes into locked notes);
  // the fake stores plaintext either way — sealed READS are the behavior
  // surface, and no harness spec pastes into a locked note (its editor is
  // only reachable unlocked, where pastes are plain until the next lock).
  pasteImage: async (folder, _notePath) => {
    pasteCount += 1;
    const src = `.ledge-assets/pasted-${pasteCount}.png`;
    assets.set(`${folder}\0${src}`, { dataB64: PIXEL_B64, mime: "image/png" });
    return src;
  },
});

// A non-default editor font size, so a spec can tell "the setting reached the
// editor" apart from "the old hardcoded 14px is still there".
// No template configuration: templates are notes carrying `template: true`
// frontmatter, seeded per spec (a boot-time seed would shift every
// list-count assertion in the older specs).
//
// `?theme=light|dark` overrides the appearance setting for one load. Settings
// apply at launch and there is no UI for this one (the file IS the UI), so a
// query param is the only way a spec can boot the harness with an override in
// place — the same seam a relaunch is for the real app.
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
// spec can assert what a save wrote.
let settingsText = SETTINGS_TEMPLATE;
const profiles = new Map<string, string>();
configureSettings(
  HARNESS_SETTINGS,
  {
    readSettingsFile: async () => settingsText,
    writeSettingsFile: async (text) => {
      settingsText = text;
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
// Stamps the resolved appearance on <html>, like main.tsx does after boot.
applyAppearance();

// The shim write is a native seam; the harness answers with a canned success
// so the palette command and its notice strip are drivable end to end.
configureCli({
  install: async () => ({ ok: true, message: "ledge installed: ~/.local/bin/ledge" }),
});

declare global {
  interface Window {
    __harness: {
      clipboard: () => string;
      settingsText: () => string;
      linkOpens: () => string[];
      layout: () => string | null;
      termAttaches: () => { sessionId: string; host: string | null }[];
      termPastes: () => { sessionId: string; text: string; host: string | null }[];
      inlineRuns: () => { sessionId: string; id: string; host: string | null }[];
      // Every grid reported to a run's shell, in order.
      inlineResizes: () => { id: string; cols: number; rows: number }[];
      // Push one output byte-string at a run, the way Bun's runEvent would.
      // Not the PTY coming back: the inert harness stays inert, and a spec that
      // wants real run behavior still belongs to the live probe. This drives
      // the ONE view-side seam a spec cannot otherwise reach — what the panel
      // does when a run first speaks (it takes the keyboard, blocks.ts).
      runOutput: (id: string, text: string) => void;
      // Simulate the CLI's openExternal push (a Bun-side watcher event has no
      // visible surface to drive it from).
      externalOpen: (open: ExternalOpenInfo) => void;
      // Simulate the watcher's notesChanged push for one root: how a spec
      // makes a store.seed visible to the app's lists — the same refresh a
      // real external write triggers.
      notesChanged: (root: string) => void;
      store: FakeStore;
    };
  }
}
window.__harness = {
  clipboard: () => clip,
  settingsText: () => settingsText,
  linkOpens: () => [...linkOpens],
  layout: () => layoutText,
  termAttaches: () => termAttaches.map((a) => ({ ...a })),
  termPastes: () => termPastes.map((p) => ({ ...p })),
  inlineRuns: () => inlineRuns.map((r) => ({ ...r })),
  inlineResizes: () => inlineResizes.map((r) => ({ ...r })),
  runOutput: (id, text) => dispatchRunEvent({ id, kind: "output", dataB64: btoa(text) }),
  externalOpen: (open) => dispatchExternalOpen(open),
  notesChanged: (root) => dispatchNotesChanged(root),
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
