// The session log: `logs/ledge.log` in the app home, plus the previous
// session's copy beside it. It exists because a shipped build has nowhere
// else to put a stack trace — Electrobun's launcher only forwards the main
// process's stdout on the dev channel, so on a user's Mac every console line
// this app writes goes to /dev/null. "It just closed" is then the entire bug
// report, and there is no second attempt: the run that crashed is gone.
//
// Hence rotate-on-launch rather than rotate-by-day. After a crash the user
// relaunches — that is the first thing anyone does — and the session that
// died has to survive that relaunch to be worth anything. It is
// `ledge.previous.log`, spelled out, because the person opening this folder
// was sent here by a menu item and should not have to guess what `.1` means.
//
// In the app home (so `LEDGE_NOTES_ROOT` isolates it) rather than the Mac's
// `~/Library/Logs/Ledge`: every probe and test in this repo redirects the app
// home and would otherwise scribble on the real log, and the Help menu item
// makes the location discoverable without leaning on convention.
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { APP_HOME } from "./workspaces";

export const LOG_DIR = join(APP_HOME, "logs");
export const LOG_PATH = join(LOG_DIR, "ledge.log");
export const PREV_LOG_PATH = join(LOG_DIR, "ledge.previous.log");

// Two files of this, worst case. A log that can fill a disk is a bug of its
// own, and rotating rather than truncating keeps the RECENT end — the half a
// crash is in.
export const MAX_LOG_BYTES = 4 * 1024 * 1024;

export type LogSource = "bun" | "view";
export type LogLevel = "info" | "warn" | "error";

// --- pure core (unit-tested in log.test.ts) ----------------------------------

// One console argument as text. Errors are unwrapped to their stack — the
// default `String(err)` drops it, which is the one part of an error worth
// keeping in a file nobody is watching live.
export function formatArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
  if (arg === undefined) return "undefined";
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    // Cyclic, or a getter that throws. Both are worth a line saying so rather
    // than taking the whole log entry down with them.
    return String(arg);
  }
}

// Newlines are kept: a stack trace across ten lines is the payload, not noise,
// and nothing parses this file — it is read by a person who was handed it.
export function formatLine(at: Date, source: LogSource, level: LogLevel, args: unknown[]): string {
  const stamp = at.toISOString();
  const body = args.map(formatArg).join(" ");
  return `${stamp} [${source}/${level}] ${body}\n`;
}

// --- the files ---------------------------------------------------------------

// Best-effort throughout: logging that can throw turns a diagnostic into a
// second failure. Every entry point here swallows, and none of them may call
// back into the patched console (see below) or the first disk error becomes an
// infinite loop.
function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function rotate(): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    if (sizeOf(LOG_PATH) > 0) renameSync(LOG_PATH, PREV_LOG_PATH);
  } catch {
    // A log we cannot rotate is a log we append to. Still better than none.
  }
}

let written = 0;

export function append(text: string): void {
  if (written > MAX_LOG_BYTES) {
    rotate();
    written = 0;
  }
  try {
    appendFileSync(LOG_PATH, text);
  } catch {
    // The folder can vanish under a running app — someone tidying ~/.ledge,
    // a scratch home wiped between tests — and a log that gives up for the
    // rest of the session at that point is a log that is not there when it
    // matters. One mkdir, one retry, then silence: read-only home, full
    // disk, revoked permission all end here, and warning about any of them
    // would recurse through the patched console straight back into this
    // function.
    try {
      mkdirSync(LOG_DIR, { recursive: true });
      appendFileSync(LOG_PATH, text);
    } catch {
      return;
    }
  }
  written += text.length;
}

// Written synchronously, deliberately: a process that dies mid-tick still has
// its last line on disk, which is the only line that ever matters. These are
// short and rare — a boot banner, a warning, an error — not a hot path.
export function write(source: LogSource, level: LogLevel, args: unknown[]): void {
  append(formatLine(new Date(), source, level, args));
}

// Tee the console into the file instead of routing every call site through a
// logger module. Two reasons: the ~40 existing `console.warn`s in bun/ (and
// every future one) keep working unchanged, and Electrobun's own output lands
// in the log too — which is exactly what you want when the complaint is about
// the shell or the window rather than about Ledge's own code.
let patched = false;

export function startLogging(): void {
  if (patched) return;
  patched = true;
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

// Reveal the folder, not the file: the previous session's log is next to it,
// and after a crash that is the one the user actually needs. `open -R` on the
// directory selects it in its parent, which is the wrong level, so the folder
// is opened instead.
export function revealLog(): boolean {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    Bun.spawn(["open", LOG_DIR]);
    return true;
  } catch {
    return false;
  }
}
