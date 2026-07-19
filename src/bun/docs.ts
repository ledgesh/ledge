// The built-in documentation's disk half: sync the compiled-in corpus
// (docsContent.ts) into DOCS_ROOT at every launch, so the pages on disk always
// match the installed app. The folder is machine-written like .layout.json —
// an external edit to a page is overwritten at the next boot, deliberately:
// stale docs describing an older Ledge are worse than a lost annotation in a
// folder every surface labels read-only.
//
// Writes are the app's standard temp-plus-rename; a page whose bytes already
// match is left untouched (no mtime churn, no watcher noise). A page the
// manifest no longer carries is RETIRED, not unlinked — renamed into the
// dotted .retired/ subfolder, invisible to listNotes — keeping the docs sync
// off the unlink list entirely (architecture.md §3: rename is the primitive).
// Only top-level, non-dotted .md entries are considered at all; anything else
// in the folder arrived by some other route and is left strictly alone (the
// trash-listing stance).
import { basename, join, resolve } from "node:path";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { DOCS_ROOT, uniqueName } from "./workspaces";
import { DOC_PAGES, type DocPage } from "./docsContent";

const RETIRED_DIRNAME = ".retired";

let tmpCounter = 0;
async function writePage(path: string, text: string): Promise<void> {
  tmpCounter += 1;
  const tmp = join(resolve(DOCS_ROOT), `.${basename(path)}.tmp-${process.pid}-${tmpCounter}`);
  try {
    await writeFile(tmp, text, "utf8");
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

// `pages` is injectable for tests (a shrunk manifest is how the retire path
// is exercised); the app always syncs the real corpus.
export async function syncDocs(pages: readonly DocPage[] = DOC_PAGES): Promise<void> {
  const root = resolve(DOCS_ROOT);
  try {
    await mkdir(root, { recursive: true });
  } catch (err) {
    // An uncreatable app home already degraded every other boot write; the
    // docs cost themselves and nothing else (the root just lists empty).
    console.warn("[docs] cannot create the docs folder", root, err);
    return;
  }
  const wanted = new Map(pages.map((p) => [p.name, p.text]));
  let existing: string[];
  try {
    existing = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isFile() && !e.name.startsWith(".") && /\.md$/i.test(e.name))
      .map((e) => e.name);
  } catch (err) {
    console.warn("[docs] cannot list the docs folder", root, err);
    return;
  }
  // Retire what the manifest no longer names (an upgrade renamed or dropped a
  // page). uniqueName against the retired dir's own listing: rename(2)
  // clobbers silently, and even a machine-owned corner keeps the rule.
  for (const name of existing) {
    if (wanted.has(name)) continue;
    try {
      const retiredDir = join(root, RETIRED_DIRNAME);
      await mkdir(retiredDir, { recursive: true });
      const taken = new Set(await readdir(retiredDir));
      await rename(join(root, name), join(retiredDir, uniqueName(name.replace(/\.md$/i, ""), taken)));
    } catch (err) {
      console.warn("[docs] could not retire a stale doc page", name, err);
    }
  }
  // Write what differs; leave what matches byte-for-byte alone.
  for (const [name, text] of wanted) {
    const path = join(root, name);
    try {
      const current = await readFile(path, "utf8").catch(() => null);
      if (current === text) continue;
      await writePage(path, text);
    } catch (err) {
      console.warn("[docs] could not write a doc page", name, err);
    }
  }
}
