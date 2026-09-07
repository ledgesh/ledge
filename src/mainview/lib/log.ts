// View failures, forwarded to the session log (architecture.md §3). The
// configureX pattern (§5): boot.tsx binds `append` to the logAppend RPC, the
// e2e harness binds nothing and the calls no-op. Ordinary logging stays in the
// webview's console, which a user cannot open on a signed build. The Bun-side
// log cannot see a view crash, the likeliest crash in an app that is mostly UI.
export interface LogHandlers {
  append(level: "warn" | "error", text: string): void;
  // Opens the log folder for the user (the Help menu's Reveal Log in Finder).
  // Same handlers object because `append` writes a file in that folder. No
  // path crosses the RPC.
  reveal(): void;
}

let handlers: LogHandlers | null = null;

// The cap on lines forwarded in one session. Without a bound, an erroring
// render loop calling console.error at frame rate would keep appending until
// the log filled the disk. The cap keeps the first lines rather than the last.
const MAX_LINES = 200;
let sent = 0;

export function configureLog(h: LogHandlers): void {
  handlers = h;
}

export function revealLog(): void {
  handlers?.reveal();
}

export function logFailure(level: "warn" | "error", text: string): void {
  if (!handlers || sent > MAX_LINES) return;
  sent += 1;
  if (sent > MAX_LINES) {
    handlers.append("warn", `[log] further view messages suppressed after ${MAX_LINES} this session`);
    return;
  }
  handlers.append(level, text);
}

// Turns a value into the text to forward: an ErrorEvent's `error`, a
// PromiseRejectionEvent's `reason`, or a console.error argument. The stack is
// the payload. `String(err)` drops it and leaves a line saying only that
// something threw. `fallback` is returned for a blank string, for null or
// undefined, and for anything JSON.stringify does not turn into a string.
export function describeError(value: unknown, fallback: string): string {
  if (value instanceof Error) {
    // Prepend the message rather than assume the stack carries it. This runs
    // in JavaScriptCore, whose `stack` is bare frames with no `Error: message`
    // header of the kind V8 writes. Using the stack alone dropped the message
    // and forwarded a line reading only
    // `@views://…/index-BhqPzFdB.js:565:10428`.
    const head = `${value.name}: ${value.message}`;
    const stack = value.stack ?? "";
    return stack.startsWith(head) ? stack : `${head}\n${stack}`.trimEnd();
  }
  // A blank string returns `fallback`, the same as the null and undefined on
  // the line below. Without this branch the JSON call would forward it as a
  // quoted `"   "`.
  if (typeof value === "string") return value.trim() ? value : fallback;
  if (value === undefined || value === null) return fallback;
  try {
    return JSON.stringify(value) ?? fallback;
  } catch {
    return String(value);
  }
}

// Installs the capture: the `error` and `unhandledrejection` window events,
// plus a patch over console.error. Called once from boot.tsx, after
// configureLog. React reports a failed render through console.error, then
// re-throws. Only that report carries the component stack naming the broken
// component.
export function captureFailures(): void {
  window.addEventListener("error", (e) => {
    logFailure("error", describeError(e.error, `${e.message} (${e.filename}:${e.lineno})`));
  });
  window.addEventListener("unhandledrejection", (e) => {
    logFailure("error", `unhandled rejection: ${describeError(e.reason, "(no reason)")}`);
  });
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    logFailure("error", args.map((a) => describeError(a, String(a))).join(" "));
    original(...args);
  };
}
