// The registry against a real filesystem: create/attach/detach round trips,
// load-time healing, and the availability snapshot. The registry is the trust
// artifact every path guard consults, so the load-time validation cases here
// are guard tests, not bookkeeping tests: a root that survives loading is a
// folder the view can write .md files into.
//
// The app home is a per-run temp dir, set by src/test-preload.ts before any
// module loaded (see bunfig.toml). The guard below re-checks that: these tests
// wipe the app home in beforeEach, and wiping the wrong folder is the one
// mistake this file must be incapable of.
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  APP_HOME,
  DOCS_ROOT,
  WORKSPACES_PATH,
  assertRegisteredRoot,
  assertWritableRoot,
  attachExternal,
  createManaged,
  detachRoot,
  ensureDefault,
  listWorkspaceRoots,
  loadWorkspaces,
  moveRoot,
  rootContaining,
  roots,
  writableRoots,
} from "./workspaces";

if (!resolve(APP_HOME).startsWith(resolve(tmpdir()) + sep)) {
  throw new Error(`refusing to run filesystem tests against ${APP_HOME} — is the preload configured?`);
}

// The registry as the USER's roots: every load also registers the built-in
// docs root in memory (its own describe block below pins that), and these
// filtered views keep the user-root assertions saying what they always said.
function userRoots(): string[] {
  return roots().filter((r) => r !== resolve(DOCS_ROOT));
}
function userList() {
  return listWorkspaceRoots().filter((w) => w.kind !== "docs");
}

// A scratch dir OUTSIDE the app home, for external-root cases. A sibling of
// the app home's own temp dir, so the two can never nest.
async function externalDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ledge-ext-"));
}

beforeEach(async () => {
  await rm(APP_HOME, { recursive: true, force: true });
  await mkdir(APP_HOME, { recursive: true });
  await loadWorkspaces(); // no file: resets the registry to empty
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
    // settings.jsonc lives in the app home and names the shell executable;
    // "every .md in ~/.ledge is a note" was exactly the blast radius the
    // per-workspace split removed. tmpdir() contains the app home here.
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
    // The native dialog's FFI return is comma-JOINED and re-split; index.ts
    // re-joins it back into one path. This guards the registry half: a comma
    // path is an ordinary path here.
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

  test("a detached managed folder re-attaches, with its notes intact", async () => {
    const root = await createManaged("Scratch");
    await writeFile(join(root, "kept.md"), "# Kept\n", "utf8");
    await detachRoot(root);
    expect(rootContaining(join(root, "kept.md"))).toBeNull(); // truly out
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

describe("moveRoot", () => {
  test("relocates the folder — notes, trash, assets and all — and persists the new registration", async () => {
    const root = await createManaged("Scratch");
    await writeFile(join(root, "kept.md"), "# Kept\n", "utf8");
    await mkdir(join(root, ".ledge-trash"));
    await writeFile(join(root, ".ledge-trash", "gone.md"), "# Gone\n", "utf8");
    const dest = await externalDir();
    const res = await moveRoot(root, dest);
    expect(res).toEqual({ root: join(resolve(dest), "scratch") });
    const next = (res as { root: string }).root;
    // Everything travelled; nothing remains under the old name.
    expect(await readFile(join(next, "kept.md"), "utf8")).toBe("# Kept\n");
    expect(await readFile(join(next, ".ledge-trash", "gone.md"), "utf8")).toBe("# Gone\n");
    expect(await stat(root).catch(() => null)).toBeNull();
    // The registry followed, kind re-derived from the new location, and it
    // survived a reload from disk.
    expect(userList()).toEqual([{ root: next, kind: "external", available: true }]);
    await loadWorkspaces();
    expect(userRoots()).toEqual([next]);
  });

  test("moving into the app home makes the root managed", async () => {
    const dir = await externalDir();
    await attachExternal(dir);
    const res = await moveRoot(dir, APP_HOME);
    const next = (res as { root: string }).root;
    expect(next).toBe(join(resolve(APP_HOME), dir.split(sep).pop()!));
    expect(userList()).toEqual([{ root: next, kind: "managed", available: true }]);
  });

  test("a taken name at the destination enumerates instead of clobbering", async () => {
    const root = await createManaged("Scratch");
    const dest = await externalDir();
    await mkdir(join(dest, "scratch"));
    await writeFile(join(dest, "scratch", "theirs.md"), "# Theirs\n", "utf8");
    const res = await moveRoot(root, dest);
    expect(res).toEqual({ root: join(resolve(dest), "scratch-2") });
    // The squatter kept its bytes.
    expect(await readFile(join(dest, "scratch", "theirs.md"), "utf8")).toBe("# Theirs\n");
  });

  test("its own parent is a no-op, not a rename to a -2 twin", async () => {
    const root = await createManaged("Scratch");
    expect(await moveRoot(root, APP_HOME)).toEqual({ root });
    expect((await stat(root)).isDirectory()).toBe(true);
    expect(userRoots()).toEqual([root]);
  });

  test("registration order is preserved — a move is a relocation, not a re-registration", async () => {
    const a = await createManaged("Alpha");
    const b = await createManaged("Beta");
    const c = await createManaged("Gamma");
    const dest = await externalDir();
    const next = ((await moveRoot(b, dest)) as { root: string }).root;
    expect(userRoots()).toEqual([a, next, c]);
  });

  test("refusals: unregistered, into itself, into another root, deeper into the app home", async () => {
    const root = await createManaged("Scratch");
    const other = await externalDir();
    await attachExternal(other);
    expect(await moveRoot("/nowhere/at/all", other)).toHaveProperty("error");
    expect(await moveRoot(root, root)).toHaveProperty("error"); // into itself
    expect(await moveRoot(root, other)).toHaveProperty("error"); // nested with a registered root
    const deep = join(APP_HOME, "scratch-2", "deeper"); // not a direct child of the app home
    await mkdir(deep, { recursive: true });
    expect(await moveRoot(root, deep)).toHaveProperty("error");
    // Every refusal left the folder and the registry untouched.
    expect((await stat(root)).isDirectory()).toBe(true);
    expect(userRoots()).toEqual([root, resolve(other)]);
  });

  test("a missing destination, or a plain file, is refused", async () => {
    const root = await createManaged("Scratch");
    const dir = await externalDir();
    expect(await moveRoot(root, join(dir, "never-existed"))).toHaveProperty("error");
    const file = join(dir, "a-file");
    await writeFile(file, "x", "utf8");
    expect(await moveRoot(root, file)).toHaveProperty("error");
  });

  test("an unavailable root refuses — there is no folder here to move", async () => {
    const dir = await externalDir();
    await attachExternal(dir);
    await rm(dir, { recursive: true });
    await loadWorkspaces();
    const dest = await externalDir();
    expect(await moveRoot(dir, dest)).toHaveProperty("error");
  });
});

describe("loadWorkspaces healing", () => {
  test("an unparseable registry is renamed aside and the run continues empty", async () => {
    await writeFile(WORKSPACES_PATH, "{ not json", "utf8");
    await loadWorkspaces();
    expect(userRoots()).toEqual([]);
    // The bytes survive for forensics; no note file was touched.
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
  // The built-in documentation folder: registered IN MEMORY at every load so
  // the read paths serve doc pages through the ordinary guards, but never a
  // user root — not persisted, not attachable, not movable, not writable.
  const docs = resolve(DOCS_ROOT);

  test("every load registers it, kind docs, self-healed like a managed folder", async () => {
    expect(roots()).toContain(docs);
    expect(listWorkspaceRoots()).toContainEqual({ root: docs, kind: "docs", available: true });
    expect((await stat(docs)).isDirectory()).toBe(true);
    // And the guards agree it is a root: a page path resolves to it.
    expect(rootContaining(join(docs, "getting-started.md"))).toBe(docs);
    expect(assertRegisteredRoot(docs)).toBe(docs);
  });

  test("it never reaches .workspaces.json", async () => {
    await createManaged("Scratch"); // triggers a save
    const file = JSON.parse(await readFile(WORKSPACES_PATH, "utf8")) as { roots: string[] };
    expect(file.roots).not.toContain(docs);
  });

  test("detach, move, and attach all refuse it", async () => {
    expect(await detachRoot(docs)).toBe(false);
    expect(roots()).toContain(docs); // still registered
    const dest = await externalDir();
    expect(await moveRoot(docs, dest)).toHaveProperty("error");
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
