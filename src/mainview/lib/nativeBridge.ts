// The Swift shell, from the page's side (ios.md §2).
//
// WKWebView gives a page exactly two one-way channels: a message handler it
// posts JSON into, and `evaluateJavaScript` coming back. Everything the iOS
// client does across that boundary is the small protocol below — a byte
// stream in both directions, and a request/response channel for the handful
// of things only the device can answer.
//
// Two rules decide what goes where, and both are ios.md §2's.
//
// **Frames are bytes and stay bytes.** The page runs the whole protocol stack
// (`shared/transport.ts`): the handshake, the op ids, the reconnect ladder,
// the held requests. Swift owns the socket and nothing above it, so a frame
// crosses this bridge as an opaque base64 string that no Swift code parses.
// Base64 costs a third of a memcpy inside one device, which is the trade
// `WKScriptMessage.body` forces (it carries JSON-compatible types only, so a
// Uint8Array does not survive the trip).
//
// **The native calls are their own vocabulary, not the schema's.** They are
// named `clipboard.read`, not `clipboardRead`, because they are not the
// schema's methods and pretending otherwise would invite Swift to grow a
// second, partial implementation of it. `clipboard.image` is the sharpest
// case: the schema's `assetPaste` reads a pasteboard AND names a file in a
// workspace, which are two machines' jobs (remote.md §5). Swift answers the
// first half; the overlay below sends the bytes to the server for the second,
// so the client still never names a file.
//
// Nothing in this file touches WebKit. `attachShell` at the bottom is the
// three lines that do, and everything above it is testable in Bun.
import { fedDuplex, type Duplex } from "../../shared/transport";
import {
  CLIENT_METHODS,
  fromBase64,
  toBase64,
  type ClientMethod,
  type RequestClient,
} from "../../shared/wire";

/** What Swift implements: twelve strings and a flat switch. */
export const SHELL_CALLS = [
  // The bridge's own verbs, `@`-prefixed because no schema method can ever
  // collide with them. `@hello` is asked once, before any socket exists: the
  // client id keys the saved layout (remote.md §5) and so is needed before the
  // first dial, and it is a fact about the DEVICE rather than about a
  // connection to it.
  "@hello",
  "@open",
  "@close",
  // A line on the shell's own console. The webview's console goes nowhere by
  // default, and the window this matters most in is the one before a server is
  // reachable, when nothing can be written to its log either.
  "@log",
  // Whether what the keyboard is over is the editor. One private content view
  // is the first responder for every field in the page, so the shell cannot
  // tell a note from a search box by itself, and the accessory bar it hangs off
  // that responder would otherwise offer Bold over a passphrase prompt
  // (ios.md §7).
  "@editing",
  // The device's five answers. `menu.set` is a no-op on a phone (ios.md §11)
  // and is here anyway, because a shell that silently lacked a method would
  // be a hang rather than an error.
  "clipboard.read",
  "clipboard.write",
  "clipboard.readRich",
  "clipboard.image",
  // The photo library, as PNG bytes (ios.md §11). Slow by the standards of
  // everything else here — it puts a whole system picker on the screen and
  // waits for a person — and answers "" for a cancel, which is the common case.
  "photos.pick",
  "link.open",
  "menu.set",
] as const;

export type ShellCall = (typeof SHELL_CALLS)[number];

/** Page to shell. */
export type ToShell = { t: "frame"; b: string } | { t: "call"; id: number; m: ShellCall; p: unknown };

/**
 * Shell to page.
 *
 * `gen` numbers the socket a message belongs to. A reconnect opens a new one
 * while the old one's close is still in flight, and without this the new
 * connection would be torn down by the previous connection's obituary.
 */
export type ToPage =
  | { t: "frame"; gen: number; b: string }
  | { t: "closed"; gen: number }
  | { t: "reply"; id: number; r: unknown }
  | { t: "fail"; id: number; e: string }
  // The app came back to the foreground. Not a socket event: iOS runs no
  // timers in a suspended process, so the ladder cannot be what notices a
  // wire that died while the app was away (ios.md §5).
  | { t: "resumed" }
  // A button on the keyboard accessory bar (ios.md §7). The payload is a
  // command id and nothing else: the bar is a native surface naming a verb,
  // exactly as the Mac's menu bar is, and the registry is the one place that
  // knows what any of them mean. Swift holds six strings and no behavior, so
  // a command that is renamed or withdrawn cannot leave a button that does
  // something subtly different — it leaves one that does nothing, and says so
  // in the console.
  | { t: "verb"; id: string };

/** What `@hello` answers: who this client is (remote.md §5), and what to call
 * the machine it is pointed at (§8 wants the indicator to name one). */
export interface ShellHello {
  client: string;
  destination: string;
}

export interface Shell {
  /** One native call. Rejects with the shell's own words when it refuses. */
  call(m: ShellCall, p: unknown): Promise<unknown>;
  /** Ask who we are and where we are pointed. Once, before the first dial. */
  hello(): Promise<ShellHello>;
  /** Open a socket and take the byte stream over it. What `reconnectingClient`
   * dials; a new one supersedes whatever was open. */
  dial(): Promise<Duplex>;
  /** What `@hello` said, for the connection chrome. */
  destination(): string;
  /** A line on the shell's console, for the window where nothing else can
   * carry one. Never rejects: a log line is not worth a failure. */
  log(text: string): void;
  /** Say whether the editor is what has focus, so the shell knows whether the
   * keyboard it is about to show is over a note. Idempotent and cheap: only
   * transitions are sent. */
  editing(on: boolean): void;
  /** Told when the app comes back to the foreground. */
  onResume(fn: () => void): void;
  /** Told when a bar button was tapped, by command id. */
  onVerb(fn: (id: string) => void): void;
  /** One message from Swift. */
  deliver(msg: ToPage): void;
}

/**
 * The page's end of the bridge, over a `post` that reaches Swift.
 *
 * Pure: `post` is the only way out and `deliver` the only way in, which is
 * what lets the whole thing be driven from a test with two functions.
 */
export function nativeShell(post: (msg: ToShell) => void): Shell {
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let nextId = 1;
  let live: { gen: number; io: ReturnType<typeof fedDuplex> } | null = null;
  let where = "";
  let resumed: () => void = () => {};
  let verb: (id: string) => void = () => {};

  function call(m: ShellCall, p: unknown): Promise<unknown> {
    const id = nextId++;
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        post({ t: "call", id, m, p });
      } catch (err) {
        pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  return {
    call,
    destination: () => where,

    log(text) {
      void call("@log", { text }).catch(() => {});
    },

    editing(on) {
      void call("@editing", { on }).catch(() => {});
    },

    onResume(fn) {
      resumed = fn;
    },

    onVerb(fn) {
      verb = fn;
    },

    async hello() {
      const said = (await call("@hello", {})) as ShellHello;
      where = said.destination;
      return said;
    },

    async dial() {
      const { gen } = (await call("@open", {})) as { gen: number };
      const io = fedDuplex({
        write: (bytes) => post({ t: "frame", b: toBase64(bytes) }),
        // Fire and forget: the shell closing a socket it has already closed is
        // a no-op, and there is nothing this end could do with a refusal.
        close: () => void call("@close", { gen }).catch(() => {}),
      });
      live = { gen, io };
      return io;
    },

    deliver(msg) {
      switch (msg.t) {
        case "frame":
          // A frame from a superseded socket is bytes from a conversation this
          // client has already stopped having. Feeding them to the current
          // connection would put another server's answers in its decoder.
          if (live && msg.gen === live.gen) live.io.feed(fromBase64(msg.b));
          return;
        case "closed":
          if (live && msg.gen === live.gen) live.io.finish();
          return;
        case "reply": {
          const waiting = pending.get(msg.id);
          pending.delete(msg.id);
          waiting?.resolve(msg.r);
          return;
        }
        case "fail": {
          const waiting = pending.get(msg.id);
          pending.delete(msg.id);
          waiting?.reject(new Error(msg.e));
          return;
        }
        case "resumed":
          resumed();
          return;
        case "verb":
          verb(msg.id);
          return;
      }
    },
  };
}

/**
 * The transition filter in front of `@editing`: pass it what has focus now, it
 * calls `tell` only when the answer changed.
 *
 * Pure, and separate from the listener that feeds it, because the listener is
 * three lines of DOM and this is the part with state. Focus events arrive in
 * pairs — a focusout and a focusin per move — and the editor keeps focus across
 * most of them, so an unfiltered reporter would cross the bridge on every
 * caret move inside one note.
 */
export function focusReporter(tell: (on: boolean) => void): (editorFocused: boolean) => void {
  // Not `false`: the shell's own default is false, and starting in step with it
  // means the first report is sent only if it says something.
  let last = false;
  return (editorFocused) => {
    if (editorFocused === last) return;
    last = editorFocused;
    tell(editorFocused);
  };
}

/**
 * The server's handlers with the client's own laid over the top: the same
 * overlay bun/clientSeams.ts applies on a Mac, for a shell whose natives are
 * Swift's.
 *
 * `build` is the server's, from its handshake, because the connection chrome
 * shows what it is connected TO (remote.md §11).
 */
export function nativeOverlay(
  requests: RequestClient,
  shell: Pick<Shell, "call" | "destination">,
  build: string,
  again: () => void,
): RequestClient {
  return { ...requests, ...clientSeams(requests, shell, build, again) };
}

/** One server, chosen by the shell, and no way to change it from in here. */
const ONE_SERVER = "This build talks to one server.";
const SHELL_ID = "shell";

/**
 * The eleven a client shell answers itself (wire.ts CLIENT_METHODS), for iOS.
 *
 * Typed as the whole list rather than as a partial map, so a name added to
 * CLIENT_METHODS fails to compile here until this shell answers it too. The
 * alternative is a method that quietly reaches the wire and is refused by the
 * server, which is remote.md §10's exact failure with an extra round trip
 * attached.
 */
function clientSeams(
  requests: RequestClient,
  shell: Pick<Shell, "call" | "destination">,
  build: string,
  again: () => void,
): Pick<RequestClient, ClientMethod> {
  return {
    clipboardWrite: async ({ text }) => {
      await shell.call("clipboard.write", { text });
      return { ok: true };
    },
    clipboardRead: async () => ({ text: (await shell.call("clipboard.read", {})) as string }),
    clipboardReadRich: async () => (await shell.call("clipboard.readRich", {})) as { text: string; html: string },
    // The pasteboard is this device's; the file is the server's. Swift answers
    // with the image's bytes or "" for no image, and the NAME comes back from
    // the machine that holds the notes — so the view still never names a file
    // and neither does the shell (remote.md §2).
    assetPaste: async ({ root, notePath }) => {
      const dataB64 = (await shell.call("clipboard.image", {})) as string;
      if (!dataB64) return { src: null };
      return requests.assetWrite({ root, notePath, dataB64 });
    },
    // The one above with a photo library where the pasteboard was, which is
    // §11's sentence made literal. It is also the only one of the two that
    // matters here: a phone has a pasteboard, but nothing on it got there by
    // being copied out of a browser, and the picture worth inserting is the one
    // the camera took.
    assetPick: async ({ root, notePath }) => {
      const dataB64 = (await shell.call("photos.pick", {})) as string;
      if (!dataB64) return { src: null };
      return requests.assetWrite({ root, notePath, dataB64 });
    },
    linkOpen: async ({ url }) => (await shell.call("link.open", { url })) as { ok: boolean },
    // There is no menu bar on a phone (ios.md §11). The view builds one anyway
    // — the registry is the menu's source and knows nothing about shells — and
    // this is where it stops.
    menuSet: async () => ({ ok: true }),

    // A phone has exactly one server: the one it was paired with. The list is a
    // single truthful row rather than an empty one, because the indicator's job
    // is to name the machine, and the four verbs that would change it refuse in
    // a sentence — the screen that adds and pins a server is native (§4), for
    // the same reason it has to exist before any of this can run.
    //
    // `pinned` is true and `keyPath` is empty, and both are facts rather than
    // placeholders: the connection has a pinned host key, and its client key
    // has no path because it is in the Secure Enclave and cannot be read out of
    // it at all.
    connectionList: async () => ({
      connections: [
        {
          id: SHELL_ID,
          name: shell.destination(),
          destination: shell.destination(),
          keyPath: "",
          pinned: true,
          lastReached: 0,
        },
      ],
      active: SHELL_ID,
      wanted: SHELL_ID,
      error: "",
      build,
    }),
    // Choosing the one server again is how a phone recovers, and it is the
    // Mac's answer too: `connectionManager.ts` re-attaches when the connection
    // it is asked for is the active one AND that one is in error, because
    // nothing below can re-establish a session's state by itself
    // (shared/transport.ts). The reconnect ladder stops for good when the
    // server restarts under it — a new instance cannot honour a replay — and
    // this is the row the chrome offers after that. On a phone, rebuilding
    // from boot is reloading the page, which is §5's sentence again.
    connectionSelect: async ({ id }) => {
      if (id !== SHELL_ID) return { ok: false, error: ONE_SERVER };
      again();
      return { ok: true, error: "" };
    },
    connectionAdd: async () => ({ id: "", error: ONE_SERVER }),
    connectionRemove: async () => ({ ok: false, error: ONE_SERVER }),
    connectionProbe: async () => ({ hostKey: "", fingerprint: "", keyType: "", error: ONE_SERVER }),
  };
}

/** What the overlay answers, for the test that holds it to CLIENT_METHODS. */
export const iosClientMethods = (): string[] =>
  Object.keys(clientSeams({} as RequestClient, { call: async () => null, destination: () => "" }, "", () => {}));

declare global {
  interface Window {
    /** Swift's way in. Assigned by attachShell; called from
     * `evaluateJavaScript`. */
    __ledge?: { deliver(msg: ToPage): void };
    webkit?: { messageHandlers?: Record<string, { postMessage(body: unknown): void }> };
  }
}

/** The name the page posts to, and the property Swift evaluates into. Both
 * halves are here so the Swift side has one place to be checked against. */
export const SHELL_HANDLER = "ledge";

/**
 * Bind a shell to the real WKWebView bridge.
 *
 * The only WebKit in this file. Throws where there is no bridge at all, which
 * is the honest answer: the iOS entry point has nothing to fall back to, and
 * a page that silently ran with no server would look like a hung app.
 */
export function attachShell(): Shell {
  const handler = window.webkit?.messageHandlers?.[SHELL_HANDLER];
  if (!handler) throw new Error(`this page is not inside the Ledge shell (no ${SHELL_HANDLER} message handler)`);
  const shell = nativeShell((msg) => handler.postMessage(msg));
  window.__ledge = { deliver: (msg) => shell.deliver(msg) };
  return shell;
}
