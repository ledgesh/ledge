// The session log: `logs/ledge.log` in the app home, with the previous
// session's copy beside it. Electrobun's launcher forwards the main
// process's stdout only on the dev channel, so a shipped build has nowhere
// else to put a stack trace. "It just closed" is the whole bug report, and
// the crashed run cannot be repeated, so the log has to be written before
// anyone asks for it. Location and rotation: architecture.md §3.
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { APP_HOME } from "./workspaces";

// The app home rather than `~/Library/Logs/Ledge`: every probe and test in
// this repo redirects the app home with `LEDGE_NOTES_ROOT` and would
// otherwise write to the real log. The Help menu's "Reveal Log in Finder"
// opens this folder, so the rotated file is named `ledge.previous.log`
// rather than `ledge.log.1`. The name says what the file is.
export const LOG_DIR = join(APP_HOME, "logs");
export const LOG_PATH = join(LOG_DIR, "ledge.log");
export const PREV_LOG_PATH = join(LOG_DIR, "ledge.previous.log");

// The size that triggers rotation, and rotation keeps one previous file, so
// `logs/` holds two of roughly this size. The check in `append` counts the
// characters that process has appended since its last rotation rather than
// measuring the file, and it runs before the write, so one entry can leave a
// file past this. Rotating rather than truncating keeps the recent end, the
// half a crash is in.
export const MAX_LOG_BYTES = 4 * 1024 * 1024;

export type LogSource = "bun" | "view";
export type LogLevel = "info" | "warn" | "error";

// --- pure core (unit-tested in log.test.ts) ----------------------------------

// One console argument as text. An Error becomes its stack: `String(err)`
// drops the stack, and the stack is the part worth keeping in a file nobody
// is watching live.
export function formatArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
  if (arg === undefined) return "undefined";
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    // JSON.stringify throws on a cyclic value, or on a getter that throws.
    // `String(arg)` is the fallback for both. It sits outside the try, so a
    // value whose own `toString` throws still takes the entry down.
    return String(arg);
  }
}

// One log line: timestamp, source, level, then the formatted arguments.
// Newlines inside an argument are kept, because a stack trace across ten
// lines is the payload. Nothing parses this file; a person reads it.
export function formatLine(at: Date, source: LogSource, level: LogLevel, args: unknown[]): string {
  const stamp = at.toISOString();
  const body = args.map(formatArg).join(" ");
  return `${stamp} [${source}/${level}] ${body}\n`;
}

// --- the files ---------------------------------------------------------------

// Logging is best-effort, because a logging call that throws turns a
// diagnostic into a second failure. `sizeOf`, `rotate`, `append` and
// `revealLog` swallow what the filesystem throws at them, and `sizeOf`
// reports 0 for a file it cannot stat. None of them may call back into the
// patched console (startLogging below), or the first disk error recurses
// forever.
function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

// Which file this process logs to. The app and a server daemon can both be
// running on one machine (remote.md §1). Two processes appending to one file
// interleave their lines and race each other's rotation, so each names its
// own and `logs/` holds them side by side.
let logPath = LOG_PATH;
let prevPath = PREV_LOG_PATH;

export function logToFile(basename: string): void {
  logPath = join(LOG_DIR, `${basename}.log`);
  prevPath = join(LOG_DIR, `${basename}.previous.log`);
}

// Moves the current log aside. `startLogging` calls this at launch rather
// than rotating by day: the first thing anyone does after a crash is
// relaunch, and the log of the session that died has to survive that.
// `append` calls it again at the size cap.
export function rotate(): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    if (sizeOf(logPath) > 0) renameSync(logPath, prevPath);
  } catch {
    // A failed rotation is not fatal: the session appends to the existing log.
  }
}

let written = 0;

export function append(text: string): void {
  if (written > MAX_LOG_BYTES) {
    rotate();
    written = 0;
  }
  try {
    appendFileSync(logPath, text);
  } catch {
    // The log folder can vanish under a running app: someone tidying
    // ~/.ledge, a scratch home wiped between tests. One mkdir and one retry
    // recover that, and the session keeps logging. `append` gives up
    // silently on every other cause (read-only home, full disk, revoked
    // permission), because warning would recurse through the patched
    // console back into this function.
    try {
      mkdirSync(LOG_DIR, { recursive: true });
      appendFileSync(logPath, text);
    } catch {
      return;
    }
  }
  written += text.length;
}

// One entry, appended synchronously, so a process that dies mid-tick still
// has its last line on disk. These writes are short and rare (a boot banner,
// a warning, an error), not a hot path.
export function write(source: LogSource, level: LogLevel, args: unknown[]): void {
  append(formatLine(new Date(), source, level, args));
}

// `startLogging` tees the console into the log file, rather than routing
// every call site through a logger module. The ~40 existing `console.warn`
// calls in bun/, and every future one, keep working unchanged. Electrobun's
// own output lands in the log too, so a bug in the shell or the window is
// recorded as well as one in Ledge's own code.
let patched = false;

export function startLogging(basename?: string): void {
  if (patched) return;
  patched = true;
  if (basename) logToFile(basename);
  rotate();
  const levels: Array<["log" | "info" | "warn" | "error", LogLevel]> = [
    ["log", "info"],
    ["info", "info"],
    ["warn", "warn"],
    ["error", "error"],
  ];
  const target = console as unknown as Record<string, (...args: unknown[]) => void>;
  for (const [method, level] of levels) {
    const original = target[method]!;
    target[method] = (...args: unknown[]) => {
      write("bun", level, args);
      original.apply(console, args);
    };
  }
}

// Opens the log folder rather than revealing one file. The previous session's
// log sits beside the current one, and after a crash that is the one the user
// needs. `open -R` on a directory selects it in its parent, one level too
// high, so plain `open` on the directory is used.
export function revealLog(): boolean {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    Bun.spawn(["open", LOG_DIR]);
    return true;
  } catch {
    return false;
  }
}
