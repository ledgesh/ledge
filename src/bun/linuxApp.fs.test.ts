import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launcherBeside, launcherRunning } from "./linuxApp";

// A fake /proc: one directory per pid, each with the NUL-separated cmdline
// the kernel writes, plus the non-numeric entries a real /proc has.
function fakeProc(cmdlines: Record<string, string[]>): string {
  const dir = mkdtempSync(join(tmpdir(), "ledge-proc-"));
  mkdirSync(join(dir, "self"));
  writeFileSync(join(dir, "version"), "Linux version 6.8.0\n");
  for (const [pid, argv] of Object.entries(cmdlines)) {
    mkdirSync(join(dir, pid));
    writeFileSync(join(dir, pid, "cmdline"), argv.join("\0") + "\0");
  }
  return dir;
}

describe("the launcher beside the app's bun", () => {
  test("is found in the same bin directory, and only there", () => {
    const bin = mkdtempSync(join(tmpdir(), "ledge-bin-"));
    writeFileSync(join(bin, "bun"), "");
    expect(launcherBeside(join(bin, "bun"))).toBeNull();
    writeFileSync(join(bin, "launcher"), "");
    expect(launcherBeside(join(bin, "bun"))).toBe(join(bin, "launcher"));
  });
});

describe("whether the app is running", () => {
  const launcher = "/home/u/.local/share/sh.ledge.app/stable/app/bin/launcher";

  test("is read from argv[0] of every process, exactly", () => {
    const proc = fakeProc({
      "1": ["/sbin/init"],
      // The bun the launcher spawned: the app, but not the launcher.
      "4302": ["/home/u/.local/share/sh.ledge.app/stable/app/bin/bun", "../Resources/main.js"],
      "4301": [launcher],
    });
    expect(launcherRunning(launcher, proc)).toBe(true);
    expect(launcherRunning(launcher + "-dev", proc)).toBe(false);
  });

  test("a launcher from another install is another app", () => {
    const proc = fakeProc({ "77": ["/opt/Ledge/bin/launcher"] });
    expect(launcherRunning(launcher, proc)).toBe(false);
  });

  test("an unreadable or missing proc answers not running", () => {
    expect(launcherRunning(launcher, join(tmpdir(), "no-such-proc"))).toBe(false);
  });
});
