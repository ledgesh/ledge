// How `ledge` inside WSL opens the Windows app: the launcher the app recorded
// on its last start, run through WSL's interop, unless that app is still
// running.
//
// The server in WSL cannot find the app by itself: it is installed under the
// Windows user's AppData, which WSL sees only as a /mnt path. So every start
// of the Windows app writes WINDOWS_APP_FILE into the WSL account's app home
// (bun/wslServer.ts recordWindowsApp). While that app runs, the CLI's job ended
// when it wrote the request file, as on Linux (bun/linuxApp.ts): the daemon's
// watcher hands the note to every window.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The record's name in the app home. */
export const WINDOWS_APP_FILE = ".windows-app.json";

/** The Windows app's last start: its launcher, as a Windows path, and the pid
 * of the bun.exe that runs it. */
export interface WindowsApp {
  launcher: string;
  pid: number;
}

/** Whether this process is inside WSL with interop on, so it can run .exe
 * files. */
export function inWsl(env: Record<string, string | undefined> = process.env): boolean {
  return process.platform === "linux" && !!env["WSL_DISTRO_NAME"] && !!env["WSL_INTEROP"];
}

/** The record in `appHome`, or null where there is none or it is not one. */
export function readWindowsApp(appHome: string): WindowsApp | null {
  try {
    const v = JSON.parse(readFileSync(join(appHome, WINDOWS_APP_FILE), "utf8")) as Partial<WindowsApp>;
    if (typeof v.launcher !== "string" || !/^[A-Za-z]:\\/.test(v.launcher)) return null;
    if (typeof v.pid !== "number" || !Number.isInteger(v.pid) || v.pid <= 0) return null;
    return { launcher: v.launcher, pid: v.pid };
  } catch {
    return null;
  }
}

/** Whether tasklist's CSV answer lists a bun.exe. For a pid nobody holds it
 * prints an INFO line instead. */
export function tasklistShowsBun(out: string): boolean {
  return /^"bun\.exe","\d+"/im.test(out);
}

async function output(cmd: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn({ cmd, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  return { code: await proc.exited, out };
}

/**
 * Launch the Windows app, or leave a running one to take the request. False
 * when this WSL account has no record of the app, or its launcher is gone.
 * Detached with no stdio, like the Linux launch, so the app outlives the shell
 * that typed `ledge`.
 */
export async function openWindowsApp(appHome: string): Promise<boolean> {
  const app = readWindowsApp(appHome);
  if (!app) return false;
  try {
    const running = await output(["tasklist.exe", "/FI", `PID eq ${app.pid}`, "/FI", "IMAGENAME eq bun.exe", "/FO", "CSV", "/NH"]);
    if (tasklistShowsBun(running.out)) return true;
    const path = await output(["wslpath", "-u", app.launcher]);
    const launcher = path.out.trim();
    if (path.code !== 0 || !launcher) return false;
    // Started in its own folder, so Windows gets a drive path for the working
    // directory rather than a \\wsl.localhost one.
    Bun.spawn({ cmd: [launcher], cwd: dirname(launcher), detached: true, stdio: ["ignore", "ignore", "ignore"] }).unref();
    return true;
  } catch {
    return false;
  }
}
