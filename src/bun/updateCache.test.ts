import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneExtractionDir, staleExtractionFiles } from "./updateCache";

const LIVE = "24d6c1x8bc1qp";

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

  // The whole point of pruning instead of emptying: the updater bsdiffs from
  // this file, and deleting it turns the next patch into a full download.
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

  // The dev-build case: electrobun only makes this folder for a packaged app.
  test("a missing folder is not an error", async () => {
    expect(await pruneExtractionDir(join(tmpdir(), "ledge-no-such-dir-9d3f"), LIVE)).toEqual([]);
  });

  test("is idempotent", async () => {
    const dir = seeded();
    await pruneExtractionDir(dir, LIVE);
    expect(await pruneExtractionDir(dir, LIVE)).toEqual([]);
  });
});
