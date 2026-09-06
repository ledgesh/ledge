// The built-in documentation's disk half. syncDocs copies the compiled-in
// corpus (docsContent.ts) into DOCS_ROOT at every launch, so the pages on
// disk match the installed app. The folder is machine-written like
// .layout.json: an external edit to a page is overwritten at the next boot
// (architecture.md §3b, which owns this sync's rules).
import { basename, join, resolve } from "node:path";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { DOCS_ROOT, uniqueName } from "./workspaces";
import { DOC_PAGES, type DocPage } from "./docsContent";

const RETIRED_DIRNAME = ".retired";

let tmpCounter = 0;
// Writes one page with the app's standard temp-plus-rename (architecture.md
// §3). The temp file is dotted, so no listing shows it, and a failed write
// removes it.
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

// `pages` is injectable for tests: docs.fs.test.ts passes a one-page manifest
// to drive the retire branch below. The app always syncs the real corpus.
export async function syncDocs(pages: readonly DocPage[] = DOC_PAGES): Promise<void> {
  const root = resolve(DOCS_ROOT);
  try {
    await mkdir(root, { recursive: true });
  } catch (err) {
    // If the app home cannot be created, every other boot write has already
    // failed too. Skipping the sync costs the docs and nothing else: the
    // docs root is kind "docs", so notes.ts rootReady stats it instead of
    // creating it, and listNotes throws "workspace root is not on disk"
    // rather than returning an empty list.
    console.warn("[docs] cannot create the docs folder", root, err);
    return;
  }
  const wanted = new Map(pages.map((p) => [p.name, p.text]));
  // Only top-level, non-dotted .md entries are considered. The .retired/
  // subfolder is dotted, so this filter and listNotes both skip it. Anything
  // else in the folder arrived by some other route and is left alone, the way
  // Empty Trash removes only what the trash listing showed (architecture.md
  // §3).
  let existing: string[];
  try {
    existing = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isFile() && !e.name.startsWith(".") && /\.md$/i.test(e.name))
      .map((e) => e.name);
  } catch (err) {
    console.warn("[docs] cannot list the docs folder", root, err);
    return;
  }
  // Retire what the manifest no longer names: an upgrade renamed or dropped
  // a page. The page is renamed into .retired/, not unlinked, so this sync
  // stays off architecture.md §3's unlink list. The new name comes from
  // uniqueName against the retired dir's own listing, because rename(2)
  // clobbers silently.
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
  // Write what differs; leave what matches byte-for-byte alone, so a launch
  // that changes nothing causes no mtime churn and no watcher noise. A page
  // missing on a first run reads as null and so differs.
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
