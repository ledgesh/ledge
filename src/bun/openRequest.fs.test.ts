// The CLI → app open-request file, both halves against a real filesystem.
// The decisions worth pinning: a take CONSUMES (every failure costs exactly
// the request, never a retry loop), staleness has a cutoff (a request is
// "now", not a standing instruction), and the path is re-guarded on the app
// side (the file sits in user-writable ground).
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createNote } from "./notes";
import { APP_HOME, createManaged, loadWorkspaces } from "./workspaces";
import { OPEN_REQUEST_MAX_AGE_MS, OPEN_REQUEST_PATH, takeOpenRequest, writeOpenRequest } from "./openRequest";

if (!resolve(APP_HOME).startsWith(resolve(tmpdir()) + sep)) {
  throw new Error(`refusing to run filesystem tests against ${APP_HOME} — is the preload configured?`);
}

let ROOT = "";

beforeEach(async () => {
  await rm(APP_HOME, { recursive: true, force: true });
  await mkdir(APP_HOME, { recursive: true });
  await loadWorkspaces();
  ROOT = await createManaged("Notes");
});

describe("write → take", () => {
  test("round-trips to a full NoteMeta plus root, and consumes the file", async () => {
    const note = await createNote(ROOT, "# Target\n\nbody\n");
    await writeOpenRequest(note.path);
    const open = await takeOpenRequest();
    expect(open).toEqual({ root: ROOT, path: note.path, title: "Target", mtimeMs: note.mtimeMs });
    expect(await stat(OPEN_REQUEST_PATH).catch(() => null)).toBeNull();
    expect(await takeOpenRequest()).toBeNull(); // spent: a second take finds nothing
  });

  test("a stale request is consumed and ignored — Tuesday's launch must not replay Monday's wish", async () => {
    const note = await createNote(ROOT, "# Target\n");
    await writeOpenRequest(note.path);
    const later = Date.now() + OPEN_REQUEST_MAX_AGE_MS + 1;
    expect(await takeOpenRequest(later)).toBeNull();
    expect(await stat(OPEN_REQUEST_PATH).catch(() => null)).toBeNull();
  });

  test("a path outside every registered root is refused — the view-path guard applies here too", async () => {
    const outside = join(APP_HOME, "smuggled.md");
    await writeFile(outside, "# Smuggled\n");
    await writeOpenRequest(outside);
    expect(await takeOpenRequest()).toBeNull();
  });

  test("a note deleted between resolve and take costs the request, nothing else", async () => {
    const note = await createNote(ROOT, "# Gone\n");
    await writeOpenRequest(note.path);
    await rm(note.path);
    expect(await takeOpenRequest()).toBeNull();
  });

  test("no file, or junk in the file, is a quiet null", async () => {
    expect(await takeOpenRequest()).toBeNull();
    await writeFile(OPEN_REQUEST_PATH, "not json");
    expect(await takeOpenRequest()).toBeNull();
    await writeFile(OPEN_REQUEST_PATH, JSON.stringify({ version: 2, path: "/x.md", ts: Date.now() }));
    expect(await takeOpenRequest()).toBeNull();
  });
});
