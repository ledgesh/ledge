// The watcher against a real filesystem. The question these tests ask is
// whether fs.watch(recursive) on this platform delivers the events the
// feature stands on. A unit test cannot answer that, so the tests make real
// writes and wait for real events. Timings are generous: the point is
// delivery, not latency.
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeWatchers, syncWatchers } from "./watch";

// nextChange resolves with the root that the first change callback reports.
// If no callback arrives within three seconds it rejects, and the test fails.
function nextChange(register: (cb: (root: string) => void) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("watcher never fired")), 3000);
    register((root) => {
      clearTimeout(timer);
      resolve(root);
    });
  });
}

// A recursive watch registers preexisting subdirectories asynchronously,
// after watch() returns. A write that races that setup can go unseen by the
// watcher. A probe established this, and the writeup is in the module
// comment's history. The app never notices, because roots are watched at
// boot and the window-focus refresh re-reads a root whose events were
// missed. A test writing microseconds after syncWatchers would flake, so
// settle sleeps 150 ms: a guess with slack, not a signal from the scan.
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
  // The platform coalesces this pair into one event named for the temp file.
  // That is why relevantChange matches ".md" inside a name, not just at the end.
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
