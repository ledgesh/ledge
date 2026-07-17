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
  WORKSPACES_PATH,
  assertRegisteredRoot,
  attachExternal,
  availableRoots,
  createManaged,
  detachRoot,
  ensureDefault,
  listWorkspaceRoots,
  loadWorkspaces,
  rootContaining,
  roots,
} from "./workspaces";

if (!resolve(APP_HOME).startsWith(resolve(tmpdir()) + sep)) {
  throw new Error(`refusing to run filesystem tests against ${APP_HOME} — is the preload configured?`);
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
    expect(roots()).toEqual([root]);
    expect(listWorkspaceRoots()).toEqual([{ root, kind: "managed", available: true }]);
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
    expect(listWorkspaceRoots()).toEqual([{ root: resolve(dir), kind: "external", available: true }]);
  });

  test("attaching an already-registered root returns it instead of erroring", async () => {
    const dir = await externalDir();
    await attachExternal(dir);
    expect(await attachExternal(dir)).toEqual({ root: resolve(dir) });
    expect(roots()).toHaveLength(1);
  });

  test("a missing path or a plain file is refused", async () => {
    const dir = await externalDir();
    expect(await attachExternal(join(dir, "never-existed"))).toHaveProperty("error");
    const file = join(dir, "a-file");
    await writeFile(file, "x", "utf8");
    expect(await attachExternal(file)).toHaveProperty("error");
  });

  test("the app home itself, and anything containing it, is refused", async () => {
    // settings.json lives in the app home and names the shell executable;
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
    expect(roots()).toEqual([resolve(weird)]);
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
    expect(listWorkspaceRoots()).toEqual([{ root, kind: "managed", available: true }]);
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
    expect(roots()).toEqual([]);
    expect(await readFile(join(dir, "note.md"), "utf8")).toBe("# Note\n");
    await loadWorkspaces(); // the removal persisted too
    expect(roots()).toEqual([]);
  });

  test("detaching an unknown root is false, not a throw", async () => {
    expect(await detachRoot("/nowhere/at/all")).toBe(false);
  });
});

describe("loadWorkspaces healing", () => {
  test("an unparseable registry is renamed aside and the run continues empty", async () => {
    await writeFile(WORKSPACES_PATH, "{ not json", "utf8");
    await loadWorkspaces();
    expect(roots()).toEqual([]);
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
    expect(roots()).toEqual([resolve(good)]);
  });

  test("a missing external root is kept, unavailable — an unmounted volume is not data loss", async () => {
    const dir = await externalDir();
    await attachExternal(dir);
    await rm(dir, { recursive: true });
    await loadWorkspaces();
    expect(listWorkspaceRoots()).toEqual([{ root: resolve(dir), kind: "external", available: false }]);
    expect(availableRoots()).toEqual([]);
    expect(roots()).toEqual([resolve(dir)]); // still registered: a remount heals at next boot
  });

  test("a missing managed folder is recreated — Bun made it, Bun may remake it", async () => {
    const root = await createManaged("Scratch");
    await rm(root, { recursive: true });
    await loadWorkspaces();
    expect(listWorkspaceRoots()).toEqual([{ root, kind: "managed", available: true }]);
    expect((await stat(root)).isDirectory()).toBe(true);
  });
});

describe("ensureDefault", () => {
  test("a first launch gets scratch", async () => {
    await ensureDefault();
    expect(roots()).toEqual([join(resolve(APP_HOME), "scratch")]);
  });

  test("an available root means no-op", async () => {
    const root = await createManaged("Mine");
    await ensureDefault();
    expect(roots()).toEqual([root]);
  });

  test("only-unavailable roots still get a fresh default — the view must have somewhere to put a note", async () => {
    const dir = await externalDir();
    await attachExternal(dir);
    await rm(dir, { recursive: true });
    await loadWorkspaces();
    await ensureDefault();
    expect(availableRoots()).toEqual([join(resolve(APP_HOME), "scratch")]);
  });
});

describe("rootContaining / assertRegisteredRoot", () => {
  test("finds the root of a path inside it, and only then", async () => {
    const root = await createManaged("Scratch");
    expect(rootContaining(join(root, "note.md"))).toBe(root);
    expect(rootContaining(join(root, "deep", "note.md"))).toBe(root);
    expect(rootContaining(join(APP_HOME, "settings.json"))).toBeNull();
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
