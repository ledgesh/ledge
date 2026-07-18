// The watcher against a real filesystem: does fs.watch(recursive) on this
// platform actually deliver the events the feature stands on? A unit test
// cannot answer that — this is the native seam, probed with real writes.
// Timings are generous: the point is delivery, not latency.
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeWatchers, syncWatchers } from "./watch";

// Resolve once onChange fires for the expected root, or fail loudly after 3s —
// a watcher that stays silent IS the finding.
function nextChange(register: (cb: (root: string) => void) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("watcher never fired")), 3000);
    register((root) => {
      clearTimeout(timer);
      resolve(root);
    });
  });
}

// The recursive watch registers PREEXISTING subdirectories asynchronously
// after watch() returns (the probe that established this lives in the module
// comment's history): a write racing that setup can be missed. The app never
// notices — roots are watched at boot, and the focus refresh is the belt —
// but a test writing microseconds after syncWatchers would flake, so give
// the scan a beat.
const settle = () => new Promise((r) => setTimeout(r, 150));

afterEach(() => closeWatchers());

test("a note written under a watched root fires one change for that root", async () => {
  const root = await mkdtemp(join(tmpdir(), "ledge-watch-"));
  const fired = nextChange((cb) => syncWatchers([root], cb));
  await settle();
  await writeFile(join(root, "note.md"), "# Hello\n");
  expect(await fired).toBe(root);
});

test("a temp-plus-rename save (how agents and Ledge itself write) fires via the rename", async () => {
  const root = await mkdtemp(join(tmpdir(), "ledge-watch-"));
  await writeFile(join(root, "note.md"), "# Old\n");
  const fired = nextChange((cb) => syncWatchers([root], cb));
  await settle();
  // The platform coalesces this pair into one event named for the TEMP file —
  // which is why relevantChange matches ".md" inside a name, not just at its end.
  await writeFile(join(root, ".note.md.tmp-1"), "# New\n");
  await rename(join(root, ".note.md.tmp-1"), join(root, "note.md"));
  expect(await fired).toBe(root);
});

test("a note in a subfolder fires too: the watch is recursive", async () => {
  const root = await mkdtemp(join(tmpdir(), "ledge-watch-"));
  await mkdir(join(root, "sub"));
  const fired = nextChange((cb) => syncWatchers([root], cb));
  await settle();
  await writeFile(join(root, "sub", "deep.md"), "# Deep\n");
  expect(await fired).toBe(root);
});

test("a burst of writes is debounced to one callback", async () => {
  const root = await mkdtemp(join(tmpdir(), "ledge-watch-"));
  let calls = 0;
  syncWatchers([root], () => {
    calls += 1;
  });
  await settle();
  for (let i = 0; i < 5; i += 1) await writeFile(join(root, `n${i}.md`), "# N\n");
  await new Promise((r) => setTimeout(r, 600)); // past the debounce, with slack
  expect(calls).toBe(1);
});

test("a dropped root stops firing after a re-sync", async () => {
  const root = await mkdtemp(join(tmpdir(), "ledge-watch-"));
  let calls = 0;
  syncWatchers([root], () => {
    calls += 1;
  });
  syncWatchers([], () => {
    calls += 1;
  });
  await writeFile(join(root, "note.md"), "# Hello\n");
  await new Promise((r) => setTimeout(r, 600));
  expect(calls).toBe(0);
});

test("an unwatchable root is skipped, not fatal: the others still watch", async () => {
  const root = await mkdtemp(join(tmpdir(), "ledge-watch-"));
  const fired = nextChange((cb) => syncWatchers([join(tmpdir(), "ledge-watch-never-exists"), root], cb));
  await settle();
  await writeFile(join(root, "note.md"), "# Hello\n");
  expect(await fired).toBe(root);
});
