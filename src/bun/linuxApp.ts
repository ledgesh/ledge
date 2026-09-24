// How `ledge` opens the app on a Linux desktop: the launcher beside its own
// bun, started detached, unless one is already running.
//
// A Mac has `open -b`, which launches the app or activates the running one.
// Linux has no verb that knows an app by name, and running the launcher twice
// opens a second instance rather than raising the first (checked on Ubuntu
// 24.04). So this looks for a running launcher first, and while one runs the
// CLI's job ended when it wrote the request file: the daemon's watcher hands
// the note to every window (bun/server.ts startOpenRequestWatcher), and
// whether that window comes forward is the desktop's to decide.
//
// The launcher path comes from process.execPath, the way the shim finds
// serve.js: the `ledge` on PATH is the app's own bun (bun/cliShim.ts), and the
// installer keeps launcher and bun side by side in `bin/`. A checkout's bun has
// no launcher beside it, so `bun run cli` cannot open the app, as the Mac
// checkout cannot open a bundle nobody built.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The launcher beside `execPath`, or null where there is none. */
export function launcherBeside(execPath: string): string | null {
  const launcher = join(dirname(execPath), "launcher");
  return existsSync(launcher) ? launcher : null;
}

/**
 * Whether a process is running `launcher`, read from `procDir`'s cmdline
 * files. The launcher stays alive for the app's whole run, as the parent of
 * the bun that runs the app, and its argv[0] is the path it was started by.
 * Unreadable entries are skipped: a process of another user answers EACCES,
 * and one that exited between readdir and read answers ENOENT.
 */
export function launcherRunning(launcher: string, procDir: string = "/proc"): boolean {
  let entries: string[];
  try {
    entries = readdirSync(procDir);
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let cmdline: string;
    try {
      cmdline = readFileSync(join(procDir, entry, "cmdline"), "utf8");
    } catch {
      continue;
    }
    if (cmdline.split("\0")[0] === launcher) return true;
  }
  return false;
}

/**
 * Launch the app, or leave a running one to take the request. False when
 * there is no launcher to run.
 *
 * Detached, in its own session with no stdio, so the app outlives the shell
 * that typed `ledge` and never holds that shell's terminal open.
 */
export function openLinuxApp(execPath: string = process.execPath): boolean {
  const launcher = launcherBeside(execPath);
  if (!launcher) return false;
  if (launcherRunning(launcher)) return true;
  try {
    Bun.spawn({ cmd: [launcher], detached: true, stdio: ["ignore", "ignore", "ignore"] }).unref();
  } catch {
    return false;
  }
  return true;
}
