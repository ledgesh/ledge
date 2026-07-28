// View failures, forwarded to the session log — the configureX pattern
// (architecture.md §5): main.tsx binds `append` to the logAppend RPC, the
// harness binds nothing and the calls no-op.
//
// It exists because the webview's console is unreachable in a shipped build:
// WKWebView writes to the Web Inspector, which a user does not have open and
// on a signed build cannot open at all. An uncaught render error therefore
// leaves a blank pane and no trace anywhere — the one crash the Bun-side log
// is blind to, and the most likely one in an app whose UI is most of it.
//
// Only failures ride this. Ordinary logging stays local: a log worth reading
// after a crash is one that is mostly not there.
export interface LogHandlers {
  append(level: "warn" | "error", text: string): void;
  // Show the user where the log is (the Help menu's Reveal Log). Same bridge
  // because it is the same file; no path crosses the RPC.
  reveal(): void;
}

let handlers: LogHandlers | null = null;

// One session's budget. An erroring render loop can call console.error at
// frame rate, and a diagnostic that fills a disk is worse than the bug it was
// recording; the first failures are also the ones worth having, so a cap that
// keeps the head is the right end to keep.
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

// What an ErrorEvent / PromiseRejectionEvent is worth writing down. The stack
// is the payload — `String(err)` drops it, and without it a forwarded line
// says only that something somewhere threw.
export function describeError(value: unknown, fallback: string): string {
  if (value instanceof Error) {
    // The message is prepended, not assumed to be in the stack: this runs in
    // JavaScriptCore, whose `stack` is bare frames — no `Error: message`
    // header the way V8 writes one. Taking the stack as-is here cost the
    // message entirely, and a forwarded line reading only
    // `@views://…/index-BhqPzFdB.js:565:10428` says nothing at all.
    const head = `${value.name}: ${value.message}`;
    const stack = value.stack ?? "";
    return stack.startsWith(head) ? stack : `${head}\n${stack}`.trimEnd();
  }
  // A blank string is the same as nothing thrown, and must not survive as a
  // quoted `"   "` from the JSON branch below.
  if (typeof value === "string") return value.trim() ? value : fallback;
  if (value === undefined || value === null) return fallback;
  try {
    return JSON.stringify(value) ?? fallback;
  } catch {
    return String(value);
  }
}

// Install the capture. Called once from main.tsx, after configureLog.
//
// console.error is patched as well as the two window events: React reports a
// failed render through console.error and then re-throws, and the component
// stack it prints there is the part that names the broken component — the
// rethrow alone says only that something in the tree threw.
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
