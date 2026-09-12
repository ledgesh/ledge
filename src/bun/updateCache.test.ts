import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PREPARED_UPDATE_FILE, preparedHashOf, pruneExtractionDir, staleExtractionFiles } from "./updateCache";

const LIVE = "24d6c1x8bc1qp";
const NEXT = "9k2m4n6p8r0tx";

describe("staleExtractionFiles", () => {
  test("keeps the running version's tar", () => {
    expect(staleExtractionFiles([`${LIVE}.tar`], LIVE)).toEqual([]);
  });

  test("removes tars from versions that are no longer running", () => {
    const entries = [`${LIVE}.tar`, "aaaaaaaaaaaaa.tar", "bbbbbbbbbbbbb.tar"];
    expect(staleExtractionFiles(entries, LIVE)).toEqual(["aaaaaaaaaaaaa.tar", "bbbbbbbbbbbbb.tar"]);
  });

  test("removes a patch run's scratch files", () => {
    const entries = [`${LIVE}.tar`, `${LIVE}.patch`, `from-${LIVE}.tar`];
    expect(staleExtractionFiles(entries, LIVE)).toEqual([`${LIVE}.patch`, `from-${LIVE}.tar`]);
  });

  // The prune keeps the running version's tar instead of emptying the
  // folder. The updater bsdiffs from that tar, so deleting it turns the next
  // patch into a full download.
  test("never removes the baseline even when it is the only entry", () => {
    expect(staleExtractionFiles([`${LIVE}.tar`], LIVE)).not.toContain(`${LIVE}.tar`);
  });

  test("deletes nothing when the running hash is unknown", () => {
    expect(staleExtractionFiles(["aaaaaaaaaaaaa.tar", "b.patch"], null)).toEqual([]);
  });

  test("leaves entries it does not recognize alone", () => {
    const entries = [`${LIVE}.tar`, "Ledge.app", "notes.txt", "temp-abc"];
    expect(staleExtractionFiles(entries, LIVE)).toEqual([]);
  });

  test("an empty folder yields nothing to do", () => {
    expect(staleExtractionFiles([], LIVE)).toEqual([]);
  });

  // A downloaded update waits in this folder until Restart to Install Update.
  // Pruning its tar at the next launch would make the updater download it
  // again, and the update would stop being ready across a relaunch.
  test("keeps the tar of an update that is downloaded but not installed", () => {
    const entries = [`${LIVE}.tar`, `${NEXT}.tar`, "aaaaaaaaaaaaa.tar"];
    expect(staleExtractionFiles(entries, LIVE, NEXT)).toEqual(["aaaaaaaaaaaaa.tar"]);
  });
});

describe("preparedHashOf", () => {
  test("reads the hash out of the updater's record", () => {
    expect(preparedHashOf(JSON.stringify({ schema_version: 1, hash: NEXT, version: "0.1.1" }))).toBe(NEXT);
  });

  test("no record means no update is waiting", () => {
    expect(preparedHashOf(null)).toBeNull();
  });

  // The hash becomes part of a filename the prune compares against. A value
  // that is not the updater's hash shape keeps nothing extra, which is the
  // prune's rule before this record existed.
  test("a record it cannot read, or a hash of the wrong shape, names nothing", () => {
    expect(preparedHashOf("{not json")).toBeNull();
    expect(preparedHashOf(JSON.stringify({ hash: 42 }))).toBeNull();
    expect(preparedHashOf(JSON.stringify({ hash: "../../x" }))).toBeNull();
  });
});

describe("pruneExtractionDir", () => {
  function seeded(): string {
    const dir = mkdtempSync(join(tmpdir(), "ledge-extract-"));
    writeFileSync(join(dir, `${LIVE}.tar`), "current");
    writeFileSync(join(dir, "aaaaaaaaaaaaa.tar"), "an older version");
    writeFileSync(join(dir, `${LIVE}.patch`), "scratch");
    mkdirSync(join(dir, "Ledge.app"));
    return dir;
  }

  test("removes the stale entries and keeps the baseline", async () => {
    const dir = seeded();
    const removed = await pruneExtractionDir(dir, LIVE);
    expect(removed.sort()).toEqual([`${LIVE}.patch`, "aaaaaaaaaaaaa.tar"]);
    expect(readdirSync(dir).sort()).toEqual([`${LIVE}.tar`, "Ledge.app"]);
  });

  test("touches nothing when the running hash is unknown", async () => {
    const dir = seeded();
    const before = readdirSync(dir).sort();
    expect(await pruneExtractionDir(dir, null)).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual(before);
  });

  // Electrobun creates the self-extraction folder only for a packaged app,
  // so a dev build has none.
  test("a missing folder is not an error", async () => {
    expect(await pruneExtractionDir(join(tmpdir(), "ledge-no-such-dir-9d3f"), LIVE)).toEqual([]);
  });

  test("keeps the tar the prepared-update record names", async () => {
    const dir = seeded();
    writeFileSync(join(dir, `${NEXT}.tar`), "the downloaded update");
    writeFileSync(join(dir, PREPARED_UPDATE_FILE), JSON.stringify({ schema_version: 1, hash: NEXT }));
    await pruneExtractionDir(dir, LIVE);
    expect(readdirSync(dir).sort()).toEqual([PREPARED_UPDATE_FILE, `${LIVE}.tar`, `${NEXT}.tar`, "Ledge.app"].sort());
  });

  test("is idempotent", async () => {
    const dir = seeded();
    await pruneExtractionDir(dir, LIVE);
    expect(await pruneExtractionDir(dir, LIVE)).toEqual([]);
  });
});
