// The docs sync against a real filesystem: the corpus lands in DOCS_ROOT at
// boot, matches-in-place are left untouched, external edits are overwritten
// (the folder is machine-written, like .layout.json), and pages the manifest
// dropped are RETIRED by rename, never unlinked. The app home is the
// preload's scratch dir (bunfig.toml), same guard as workspaces.fs.test.ts.
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { APP_HOME, DOCS_ROOT, loadWorkspaces } from "./workspaces";
import { syncDocs } from "./docs";
import { DOC_PAGES } from "./docsContent";
import { createNote, deleteNote, listNotes, lockNote, readNote, retitleNote, writeNote } from "./notes";

if (!resolve(APP_HOME).startsWith(resolve(tmpdir()) + sep)) {
  throw new Error(`refusing to run filesystem tests against ${APP_HOME} — is the preload configured?`);
}

const PAGES = [
  { name: "getting-started.md", text: "# Getting Started\n\nhello\n" },
  { name: "shells.md", text: "# Shells\n\nrun things\n" },
];

beforeEach(async () => {
  await rm(APP_HOME, { recursive: true, force: true });
  await mkdir(APP_HOME, { recursive: true });
  await loadWorkspaces();
});

describe("syncDocs", () => {
  test("writes the manifest's pages into the docs root", async () => {
    await syncDocs(PAGES);
    for (const p of PAGES) {
      expect(await readFile(join(DOCS_ROOT, p.name), "utf8")).toBe(p.text);
    }
  });

  test("a matching page is left untouched — no mtime churn, no watcher noise", async () => {
    await syncDocs(PAGES);
    const before = (await stat(join(DOCS_ROOT, PAGES[0]!.name))).mtimeMs;
    await Bun.sleep(5);
    await syncDocs(PAGES);
    expect((await stat(join(DOCS_ROOT, PAGES[0]!.name))).mtimeMs).toBe(before);
  });

  test("an external edit is overwritten at the next sync — the folder is machine-written", async () => {
    await syncDocs(PAGES);
    await writeFile(join(DOCS_ROOT, PAGES[0]!.name), "# Vandalized\n", "utf8");
    await syncDocs(PAGES);
    expect(await readFile(join(DOCS_ROOT, PAGES[0]!.name), "utf8")).toBe(PAGES[0]!.text);
  });

  test("a page the manifest dropped is retired by rename, never unlinked", async () => {
    await syncDocs(PAGES);
    await syncDocs([PAGES[0]!]); // shells.md left the manifest (an upgrade)
    const listed = await readdir(DOCS_ROOT);
    expect(listed).not.toContain("shells.md");
    // The bytes survive under the dotted retired dir, invisible to listNotes.
    expect(await readFile(join(DOCS_ROOT, ".retired", "shells.md"), "utf8")).toBe(PAGES[1]!.text);
    expect((await listNotes(DOCS_ROOT)).map((n) => n.title)).toEqual(["Getting Started"]);
  });

  test("a foreign non-page entry in the folder is left strictly alone", async () => {
    await syncDocs(PAGES);
    await writeFile(join(DOCS_ROOT, "notes.txt"), "mine", "utf8");
    await syncDocs([PAGES[0]!]);
    expect(await readFile(join(DOCS_ROOT, "notes.txt"), "utf8")).toBe("mine");
  });

  test("every mutating store seam refuses the docs root", async () => {
    await syncDocs(PAGES);
    const page = join(DOCS_ROOT, PAGES[0]!.name);
    expect(writeNote(page, "# Edited\n")).rejects.toThrow(/read-only/);
    expect(createNote(DOCS_ROOT, "# Mine\n")).rejects.toThrow(/read-only/);
    expect(retitleNote(page, "# Renamed\n")).rejects.toThrow(/read-only/);
    expect(deleteNote(page)).rejects.toThrow(/read-only/);
    expect(lockNote(page)).rejects.toThrow(/read-only/);
    // Nothing moved or changed under any of them.
    expect(await readFile(page, "utf8")).toBe(PAGES[0]!.text);
    expect((await listNotes(DOCS_ROOT)).length).toBe(PAGES.length);
  });

  test("the real corpus ships a Getting Started page, readable through the ordinary store", async () => {
    await syncDocs(); // the compiled-in DOC_PAGES
    expect(DOC_PAGES.length).toBeGreaterThan(0);
    const metas = await listNotes(DOCS_ROOT);
    expect(metas.map((n) => n.title)).toContain("Getting Started");
    const page = metas.find((n) => n.title === "Getting Started")!;
    const file = await readNote(page.path);
    expect(file?.text).toContain("# Getting Started");
    // And the read-only gate holds against the very page the read served.
    expect(writeNote(page.path, "# Getting Started\n\nvandalized\n")).rejects.toThrow(/read-only/);
  });
});
