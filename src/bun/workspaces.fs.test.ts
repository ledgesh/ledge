// The registry against a real filesystem: create, attach and detach round
// trips, load-time healing, and the availability snapshot. The registry is the
// trust artifact every path guard consults. The load-time validation cases
// here are guard tests, not bookkeeping tests: an available user root that
// survives loading is a folder the view can write .md files into.
//
// The app home is a per-run temp dir, set by src/test-preload.ts before any
// module loads (see bunfig.toml). These tests wipe the app home in beforeEach,
// and wiping the real one would delete the user's managed notes and
// settings.jsonc. The guard below aborts the file unless the app home is under
// tmpdir.
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  APP_HOME,
  DOCS_ROOT,
  WORKSPACES_PATH,
  WORKSPACE_TRASH,
  assertRegisteredRoot,
  assertWritableRoot,
  attachExternal,
  createManaged,
  deleteTrashedWorkspace,
  detachRoot,
  ensureDefault,
  expandHome,
  listTrashedWorkspaces,
  listWorkspaceRoots,
  loadWorkspaces,
  purgeTrashedWorkspaces,
  restoreTrashedWorkspace,
  rootContaining,
  roots,
  trashEntryDir,
  trashRoot,
  writableRoots,
} from "./workspaces";

if (!resolve(APP_HOME).startsWith(resolve(tmpdir()) + sep)) {
  throw new Error(`refusing to run filesystem tests against ${APP_HOME} — is the preload configured?`);
}

// The user's roots, without the built-in docs root. Every load registers the
// docs root in memory; the docs root block below pins that. These two helpers
// keep it out of what the assertions everywhere else see.
function userRoots(): string[] {
  return roots().filter((r) => r !== resolve(DOCS_ROOT));
}
function userList() {
  return listWorkspaceRoots().filter((w) => w.kind !== "docs");
}

// A scratch dir outside the app home, for external-root cases. It is a
// sibling of the app home's own temp dir, so the two can never nest.
async function externalDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ledge-ext-"));
}

beforeEach(async () => {
  await rm(APP_HOME, { recursive: true, force: true });
  await mkdir(APP_HOME, { recursive: true });
  await loadWorkspaces(); // no registry file: only the docs root is registered
});

describe("createManaged", () => {
  test("slugs the display name into a folder under the app home and persists it", async () => {
    const root = await createManaged("Shipping Notes");
    expect(root).toBe(join(resolve(APP_HOME), "shipping-notes"));
    expect((await stat(root)).isDirectory()).toBe(true);
    await loadWorkspaces(); // reload from disk: the registration survived
    expect(userRoots()).toEqual([root]);
    expect(userList()).toEqual([{ root, kind: "managed", available: true }]);
  });

  test("the same name twice enumerates instead of sharing a folder", async () => {
    const a = await createManaged("Scratch");
    const b = await createManaged("Scratch");
    expect(a).not.toBe(b);
    expect(b).toBe(join(resolve(APP_HOME), "scratch-2"));
  });

  test("a file squatting on the slug pushes the folder to the next name", async () => {
    await writeFile(join(APP_HOME, "plan"), "not a folder", "utf8");
    const root = await createManaged("Plan");
    expect(root).toBe(join(resolve(APP_HOME), "plan-2"));
  });

  test("seeds a .gitignore that keeps the trash out of git and the images in", async () => {
    // A workspace folder is what people put in git (docs/user/19), so a fresh
    // one arrives ready for `git init`. Attached folders get no such file:
    // their .gitignore is the user's.
    const root = await createManaged("Shipping Notes");
    const text = await readFile(join(root, ".gitignore"), "utf8");
    const rules = text.split("\n").filter((l) => l.trim() !== "" && !l.startsWith("#"));
    expect(rules).toEqual([".ledge-trash/", ".*.md.tmp-*", ".DS_Store"]);
  });

  test("a name that slugs to nothing falls back rather than failing", async () => {
    const root = await createManaged("???");
    expect(root).toBe(join(resolve(APP_HOME), "workspace"));
  });
});

describe("attachExternal", () => {
  test("registers an existing directory and persists it as external", async () => {
    const dir = await externalDir();
    expect(await attachExternal(dir)).toEqual({ root: resolve(dir) });
    await loadWorkspaces();
    expect(userList()).toEqual([{ root: resolve(dir), kind: "external", available: true }]);
  });

  test("attaching an already-registered root returns it instead of erroring", async () => {
    const dir = await externalDir();
    await attachExternal(dir);
    expect(await attachExternal(dir)).toEqual({ root: resolve(dir) });
    expect(userRoots()).toHaveLength(1);
  });

  test("a missing path or a plain file is refused", async () => {
    const dir = await externalDir();
    expect(await attachExternal(join(dir, "never-existed"))).toHaveProperty("error");
    const file = join(dir, "a-file");
    await writeFile(file, "x", "utf8");
    expect(await attachExternal(file)).toHaveProperty("error");
  });

  test("the app home itself, and anything containing it, is refused", async () => {
    // settings.jsonc lives in the app home and names the shell executable.
    // The app home must never be a note root: "every .md in ~/.ledge is a
    // note" was the blast radius the per-workspace split removed. tmpdir()
    // contains the app home here, so the second expect covers a root that
    // contains the app home.
    expect(await attachExternal(APP_HOME)).toHaveProperty("error");
    expect(await attachExternal(tmpdir())).toHaveProperty("error");
  });

  test("no registered root may contain another, in either direction", async () => {
    const dir = await externalDir();
    await mkdir(join(dir, "sub"));
    await attachExternal(join(dir, "sub"));
    expect(await attachExternal(dir)).toHaveProperty("error"); // would contain sub
    await detachRoot(join(dir, "sub"));
    await attachExternal(dir);
    expect(await attachExternal(join(dir, "sub"))).toHaveProperty("error"); // inside dir
  });

  test("a directory with commas in its name attaches whole", async () => {
    // The Mac picker's FFI splits its result on commas, and index.ts
    // pickFolder joins it back into one path. This test covers the registry
    // half: a path with commas in it is an ordinary path here.
    const dir = await externalDir();
    const weird = join(dir, "notes, drafts, misc");
    await mkdir(weird);
    expect(await attachExternal(weird)).toEqual({ root: resolve(weird) });
    await loadWorkspaces();
    expect(userRoots()).toEqual([resolve(weird)]);
  });

  test("a sibling whose name merely starts with a root is fine", async () => {
    const dir = await externalDir();
    const sibling = `${dir}-suffix`;
    await mkdir(sibling);
    await attachExternal(dir);
    expect(await attachExternal(sibling)).toEqual({ root: resolve(sibling) });
  });

  // The path is typed now (rpc-schema.ts workspaceAttach), so the forms a
  // person types have to land: a home-relative one, and stray whitespace
  // from a paste. A relative path stays refused, since "notes" would resolve
  // against the daemon's cwd, which no one typed.
  test("a typed path: ~ means home, whitespace is trimmed, relative is refused", async () => {
    const dir = await externalDir();
    expect(await attachExternal(`  ${dir}\n`)).toEqual({ root: resolve(dir) });
    expect(await attachExternal("notes")).toEqual({ error: "not an absolute path: notes" });
    expect(await attachExternal("~nobody/notes")).toHaveProperty("error");
    expect(expandHome("~", "/Users/me")).toBe("/Users/me");
    expect(expandHome("~/notes", "/Users/me")).toBe("/Users/me/notes");
    expect(expandHome("~nobody/notes", "/Users/me")).toBe("~nobody/notes");
    expect(expandHome("/abs", "/Users/me")).toBe("/abs");
  });

  test("a detached managed folder re-attaches, with its notes intact", async () => {
    const root = await createManaged("Scratch");
    await writeFile(join(root, "kept.md"), "# Kept\n", "utf8");
    await detachRoot(root);
    expect(rootContaining(join(root, "kept.md"))).toBeNull(); // no longer registered
    expect(await attachExternal(root)).toEqual({ root });
    expect(userList()).toEqual([{ root, kind: "managed", available: true }]);
    expect(await readFile(join(root, "kept.md"), "utf8")).toBe("# Kept\n");
  });

  test("a deeper descendant of the app home is refused — only direct children are managed", async () => {
    const root = await createManaged("Scratch");
    await detachRoot(root);
    const deep = join(root, "sub");
    await mkdir(deep);
    expect(await attachExternal(deep)).toHaveProperty("error");
  });
});

describe("attachExternal and the user's own files", () => {
  test("writes no .gitignore: an attached folder's ignore file is the user's", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ledge-attach-"));
    const before = await readdir(dir);
    await attachExternal(dir);
    expect(await readdir(dir)).toEqual(before);
  });
});

describe("detachRoot", () => {
  test("removes the registration and not one byte of the folder", async () => {
    const dir = await externalDir();
    await writeFile(join(dir, "note.md"), "# Note\n", "utf8");
    await attachExternal(dir);
    expect(await detachRoot(dir)).toBe(true);
    expect(userRoots()).toEqual([]);
    expect(await readFile(join(dir, "note.md"), "utf8")).toBe("# Note\n");
    await loadWorkspaces(); // the removal persisted too
    expect(userRoots()).toEqual([]);
  });

  test("detaching an unknown root is false, not a throw", async () => {
    expect(await detachRoot("/nowhere/at/all")).toBe(false);
  });
});

describe("the workspace trash", () => {
  test("trashRoot moves the folder, notes and all, into the trash and deregisters it", async () => {
    const root = await createManaged("Research");
    await writeFile(join(root, "plan.md"), "# Plan\n", "utf8");
    await mkdir(join(root, "sub"));
    await writeFile(join(root, "sub", "deep.md"), "# Deep\n", "utf8");
    const res = await trashRoot(root, "Research", "flask");
    expect(res).toEqual({ id: "research" });
    expect(await stat(root).catch(() => null)).toBeNull();
    expect(await readFile(join(WORKSPACE_TRASH, "research", "research", "sub", "deep.md"), "utf8")).toBe("# Deep\n");
    expect(userRoots()).toEqual([]);
    await loadWorkspaces(); // not resurrected as an empty managed folder
    expect(userRoots()).toEqual([]);
    expect(await stat(root).catch(() => null)).toBeNull();
  });

  test("lists deleted workspaces newest first, with the name, icon and note count they had", async () => {
    const a = await createManaged("Alpha");
    await writeFile(join(a, "one.md"), "# One\n", "utf8");
    await trashRoot(a, "Alpha", "book");
    const b = await createManaged("Beta");
    await trashRoot(b, "Beta Notes", "flask");
    const items = await listTrashedWorkspaces();
    expect(items.map((i) => [i.id, i.name, i.symbol, i.notes])).toEqual([
      ["beta", "Beta Notes", "flask", 0],
      ["alpha", "Alpha", "book", 1],
    ]);
  });

  test("refuses attached folders, the docs root, and roots it does not know", async () => {
    const dir = await externalDir();
    await attachExternal(dir);
    expect(await trashRoot(dir, "Ext", "")).toHaveProperty("error");
    expect(userRoots()).toEqual([resolve(dir)]); // still registered, still there
    expect(await trashRoot(DOCS_ROOT, "Docs", "")).toHaveProperty("error");
    expect(await trashRoot(join(APP_HOME, "nope"), "Nope", "")).toHaveProperty("error");
    expect(await listTrashedWorkspaces()).toEqual([]);
  });

  test("the same folder name twice gets two entries", async () => {
    await trashRoot(await createManaged("Plan"), "Plan", "");
    await trashRoot(await createManaged("Plan"), "Plan again", "");
    expect((await listTrashedWorkspaces()).map((i) => i.id).sort()).toEqual(["plan", "plan-2"]);
  });

  test("restore moves the folder back into the app home, registered, and clears the entry", async () => {
    const root = await createManaged("Research");
    await writeFile(join(root, "plan.md"), "# Plan\n", "utf8");
    const { id } = (await trashRoot(root, "My Research", "flask")) as { id: string };
    expect(await restoreTrashedWorkspace(id)).toEqual({ root, name: "My Research", symbol: "flask" });
    expect(await readFile(join(root, "plan.md"), "utf8")).toBe("# Plan\n");
    expect(userList()).toEqual([{ root, kind: "managed", available: true }]);
    expect(await readdir(WORKSPACE_TRASH)).toEqual([]);
  });

  test("a restore whose folder name was taken meanwhile enumerates instead of clobbering", async () => {
    const root = await createManaged("Research");
    await writeFile(join(root, "old.md"), "# Old\n", "utf8");
    const { id } = (await trashRoot(root, "Research", "")) as { id: string };
    const taken = await createManaged("Research");
    await writeFile(join(taken, "new.md"), "# New\n", "utf8");
    const res = (await restoreTrashedWorkspace(id)) as { root: string };
    expect(res.root).toBe(join(resolve(APP_HOME), "research-2"));
    expect(await readFile(join(taken, "new.md"), "utf8")).toBe("# New\n");
    expect(await readFile(join(res.root, "old.md"), "utf8")).toBe("# Old\n");
  });

  test("delete permanently removes the entry and everything in it", async () => {
    const root = await createManaged("Gone");
    await writeFile(join(root, "x.md"), "# X\n", "utf8");
    const { id } = (await trashRoot(root, "Gone", "")) as { id: string };
    expect(await deleteTrashedWorkspace(id)).toBe(true);
    expect(await readdir(WORKSPACE_TRASH)).toEqual([]);
    expect(await deleteTrashedWorkspace(id)).toBe(false); // already gone
  });

  test("ids are one visible segment of the trash: nothing else can be named for deletion", async () => {
    for (const bad of ["", ".", "..", "../scratch", "a/b", "a\\b", ".hidden"]) {
      expect(trashEntryDir(bad)).toBeNull();
      await expect(deleteTrashedWorkspace(bad)).rejects.toThrow(/not a deleted workspace/);
      expect(await restoreTrashedWorkspace(bad)).toHaveProperty("error");
    }
    // A registered workspace next to the trash survives every one of those.
    const root = await createManaged("Scratch");
    await expect(deleteTrashedWorkspace("../scratch")).rejects.toThrow();
    expect((await stat(root)).isDirectory()).toBe(true);
  });

  test("purge drops entries past the TTL and keeps the rest", async () => {
    const old = await createManaged("Old");
    const { id } = (await trashRoot(old, "Old", "")) as { id: string };
    const meta = join(WORKSPACE_TRASH, id, "workspace.json");
    const json = JSON.parse(await readFile(meta, "utf8")) as { deletedAt: number };
    await writeFile(meta, JSON.stringify({ ...json, deletedAt: Date.now() - 40 * 86_400_000 }), "utf8");
    await trashRoot(await createManaged("Fresh"), "Fresh", "");
    expect(await purgeTrashedWorkspaces(30 * 86_400_000)).toBe(1);
    expect((await listTrashedWorkspaces()).map((i) => i.id)).toEqual(["fresh"]);
  });

  test("a damaged meta file costs the name, not the workspace", async () => {
    const root = await createManaged("Kept");
    await writeFile(join(root, "k.md"), "# K\n", "utf8");
    const { id } = (await trashRoot(root, "Kept Notes", "")) as { id: string };
    await writeFile(join(WORKSPACE_TRASH, id, "workspace.json"), "{not json", "utf8");
    expect((await listTrashedWorkspaces()).map((i) => [i.name, i.notes])).toEqual([["kept", 1]]);
    const res = (await restoreTrashedWorkspace(id)) as { root: string };
    expect(await readFile(join(res.root, "k.md"), "utf8")).toBe("# K\n");
  });
});

describe("loadWorkspaces healing", () => {
  test("an unparseable registry is renamed aside and the run continues empty", async () => {
    await writeFile(WORKSPACES_PATH, "{ not json", "utf8");
    await loadWorkspaces();
    expect(userRoots()).toEqual([]);
    // The bytes are kept for forensics, as .workspaces.json.bad-<timestamp>,
    // and no note file was touched.
    const aside = (await readdir(APP_HOME)).filter((n) => n.startsWith(".workspaces.json.bad-"));
    expect(aside).toHaveLength(1);
    expect(await readFile(join(APP_HOME, aside[0]), "utf8")).toBe("{ not json");
  });

  test("each malformed entry costs exactly itself", async () => {
    const good = await externalDir();
    const nested = join(good, "sub");
    await mkdir(nested);
    await writeFile(
      WORKSPACES_PATH,
      JSON.stringify({ version: 1, roots: [good, 42, "relative/path", APP_HOME, nested] }),
      "utf8",
    );
    await loadWorkspaces();
    expect(userRoots()).toEqual([resolve(good)]);
  });

  test("a missing external root is kept, unavailable — an unmounted volume is not data loss", async () => {
    const dir = await externalDir();
    await attachExternal(dir);
    await rm(dir, { recursive: true });
    await loadWorkspaces();
    expect(userList()).toEqual([{ root: resolve(dir), kind: "external", available: false }]);
    expect(writableRoots()).toEqual([]);
    expect(userRoots()).toEqual([resolve(dir)]); // still registered: a remount heals at next boot
  });

  test("a missing managed folder is recreated — Bun made it, Bun may remake it", async () => {
    const root = await createManaged("Scratch");
    await rm(root, { recursive: true });
    await loadWorkspaces();
    expect(userList()).toEqual([{ root, kind: "managed", available: true }]);
    expect((await stat(root)).isDirectory()).toBe(true);
  });
});

describe("ensureDefault", () => {
  test("a first launch gets scratch", async () => {
    await ensureDefault();
    expect(userRoots()).toEqual([join(resolve(APP_HOME), "scratch")]);
  });

  test("an available root means no-op", async () => {
    const root = await createManaged("Mine");
    await ensureDefault();
    expect(userRoots()).toEqual([root]);
  });

  test("only-unavailable roots still get a fresh default — the view must have somewhere to put a note", async () => {
    const dir = await externalDir();
    await attachExternal(dir);
    await rm(dir, { recursive: true });
    await loadWorkspaces();
    await ensureDefault();
    expect(writableRoots()).toEqual([join(resolve(APP_HOME), "scratch")]);
  });
});

describe("the docs root", () => {
  // The built-in documentation folder. Every load registers it in memory so
  // the read paths serve doc pages through the ordinary guards. It is never a
  // user root: not persisted, not attachable, not movable, not writable.
  const docs = resolve(DOCS_ROOT);

  test("every load registers it, kind docs, self-healed like a managed folder", async () => {
    expect(roots()).toContain(docs);
    expect(listWorkspaceRoots()).toContainEqual({ root: docs, kind: "docs", available: true });
    expect((await stat(docs)).isDirectory()).toBe(true);
    // The guards agree it is a root: a page path resolves to it.
    expect(rootContaining(join(docs, "getting-started.md"))).toBe(docs);
    expect(assertRegisteredRoot(docs)).toBe(docs);
  });

  test("it never reaches .workspaces.json", async () => {
    await createManaged("Scratch"); // triggers a save
    const file = JSON.parse(await readFile(WORKSPACES_PATH, "utf8")) as { roots: string[] };
    expect(file.roots).not.toContain(docs);
  });

  test("detach and attach both refuse it", async () => {
    expect(await detachRoot(docs)).toBe(false);
    expect(roots()).toContain(docs); // still registered
    expect(await attachExternal(docs)).toHaveProperty("error");
  });

  test("assertWritableRoot is the read-only gate, and writableRoots excludes it", async () => {
    expect(() => assertWritableRoot(docs)).toThrow(/read-only/);
    const mine = await createManaged("Mine");
    expect(assertWritableRoot(mine)).toBe(mine);
    expect(writableRoots()).toEqual([mine]);
  });

  test("ensureDefault does not count it — a docs-only registry still gets scratch", async () => {
    await ensureDefault();
    expect(userRoots()).toEqual([join(resolve(APP_HOME), "scratch")]);
  });
});

describe("rootContaining / assertRegisteredRoot", () => {
  test("finds the root of a path inside it, and only then", async () => {
    const root = await createManaged("Scratch");
    expect(rootContaining(join(root, "note.md"))).toBe(root);
    expect(rootContaining(join(root, "deep", "note.md"))).toBe(root);
    expect(rootContaining(join(APP_HOME, "settings.jsonc"))).toBeNull();
    expect(rootContaining(join(root, "..", "escape.md"))).toBeNull();
    expect(rootContaining("/etc/passwd")).toBeNull();
    expect(rootContaining(`${root}-evil/note.md`)).toBeNull(); // prefix sibling
  });

  test("assertRegisteredRoot takes exact roots only — a subfolder is not a root", async () => {
    const root = await createManaged("Scratch");
    expect(assertRegisteredRoot(root)).toBe(root);
    expect(() => assertRegisteredRoot(join(root, "sub"))).toThrow(/not a registered workspace root/);
    expect(() => assertRegisteredRoot(APP_HOME)).toThrow(/not a registered workspace root/);
  });
});
