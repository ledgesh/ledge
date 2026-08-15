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
import { hostPart, validateConnection } from "../../shared/connections";
import { fedDuplex, type Duplex } from "../../shared/transport";
import {
  CLIENT_METHODS,
  fromBase64,
  toBase64,
  type ClientMethod,
  type RequestClient,
} from "../../shared/wire";

/** What Swift implements: fifteen strings and a flat switch. */
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
  // Which keyboard the keyboard is over. One private content view is the first
  // responder for every field in the page, so the shell cannot tell a note from
  // a search box by itself, and the accessory bar it hangs off that responder
  // would otherwise offer Bold over a passphrase prompt (ios.md §7).
  //
  // Three answers rather than two, because a note and a RUNNING BLOCK want
  // different keys and the panel a run draws lives inside the editor's own
  // content: Bold over a program waiting for a `[y/N]` is the same wrong answer
  // as Bold over a passphrase, one layer in.
  "@focus",
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
  // Which servers this phone knows (remote.md §8). Swift holds the bytes and
  // dials the selection; every rule about what may be added, renamed or removed
  // is `clientSeams` below, beside the Mac's in bun/connectionManager.ts —
  // there is one right answer to "can this be deleted" and it should not be
  // written twice in two languages.
  "servers.list",
  "servers.save",
  // A dial as far as key exchange, which is where the host key is offered. What
  // `ssh-keyscan` is on a Mac: a fingerprint, before this phone's key goes on
  // the wire and before the server has been asked to accept it (ios.md §3).
  "servers.probe",
] as const;

export type ShellCall = (typeof SHELL_CALLS)[number];

/**
 * What the keyboard is over, and therefore which face the accessory bar wears
 * (ios.md §7): the note's own Markdown verbs, the keys a running block needs
 * (editor/inlineTerm.ts RUN_KEYS), or no bar at all — which is every other
 * field on the page, where the note's verbs would act on the note behind.
 */
export type BarFace = "none" | "note" | "run";

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
  // knows what any of them mean. Swift holds the strings and no behavior, so
  // a command that is renamed or withdrawn cannot leave a button that does
  // something subtly different — it leaves one that does nothing, and says so
  // in the console.
  | { t: "verb"; id: string }
  // A button on the bar's OTHER face, over a running block. The same shape and
  // the same rule one domain along: the name of a key, and what a key means is
  // the page's (editor/inlineTerm.ts RUN_KEYS). Swift never learns that Ctrl-C
  // is one byte — which is the difference between a bar and a terminal
  // emulator, and this end is not the one holding the emulator.
  | { t: "key"; k: string };

/** What `@hello` answers: who this client is (remote.md §5), what to call the
 * machine it is pointed at (§8 wants the indicator to name one), and the
 * `authorized_keys` line a server has to trust before this phone can reach it
 * (ios.md §4) — a fact about the device, like the client id, asked once. */
export interface ShellHello {
  client: string;
  /** What this phone calls itself, for the other clients on the same server
   * (wire.ts `Hello.label`). Swift's, because the device name is UIKit's to
   * answer; the page only forwards it into the handshake. */
  label: string;
  destination: string;
  key: string;
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
  /** Say what has focus, so the shell knows which bar the keyboard it is about
   * to show should carry. Idempotent and cheap: only transitions are sent. */
  focus(over: BarFace): void;
  /** Told when the app comes back to the foreground. */
  onResume(fn: () => void): void;
  /** Told when a bar button was tapped, by command id. */
  onVerb(fn: (id: string) => void): void;
  /** Told when a key on the run's bar was tapped, by name. */
  onKey(fn: (name: string) => void): void;
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
  let key: (name: string) => void = () => {};

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

    focus(over) {
      void call("@focus", { over }).catch(() => {});
    },

    onResume(fn) {
      resumed = fn;
    },

    onVerb(fn) {
      verb = fn;
    },

    onKey(fn) {
      key = fn;
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
        case "key":
          key(msg.k);
          return;
      }
    },
  };
}

/**
 * Which face `el` having focus calls for (ios.md §7).
 *
 * The run is tested FIRST because it is inside the editor: a run's output panel
 * is a CodeMirror block widget, so it sits in `.cm-content` and answers the
 * note's own test. Asking in the other order is the phase 6 defect one layer in
 * — a formatting bar over a program waiting for a password, whose Bold would
 * act on the note behind it.
 *
 * Pure, and by class rather than by anything either surface exports: those two
 * classes are what CodeMirror and `editor/blocks.ts` put in the DOM, and what
 * every spec in `e2e/` already reaches for. Needs a document, so it is proved
 * in the harness (e2e/phone.spec.ts) rather than in Bun.
 */
export function barFaceOf(el: Element | null): BarFace {
  if (el?.closest(".ledge-output")) return "run";
  return el?.closest(".cm-content") ? "note" : "none";
}

/**
 * The transition filter in front of `@focus`: pass it what has focus now, it
 * calls `tell` only when the answer changed.
 *
 * Pure, and separate from the listener that feeds it, because the listener is
 * three lines of DOM and this is the part with state. Focus events arrive in
 * pairs — a focusout and a focusin per move — and the editor keeps focus across
 * most of them, so an unfiltered reporter would cross the bridge on every
 * caret move inside one note.
 */
export function focusReporter(tell: (over: BarFace) => void): (over: BarFace) => void {
  // Not the first report: the shell's own default is "none", and starting in
  // step with it means the first call is sent only if it says something.
  let last: BarFace = "none";
  return (over) => {
    if (over === last) return;
    last = over;
    tell(over);
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
): RequestClient {
  return { ...requests, ...clientSeams(requests, shell, build) };
}

/** One server this phone knows, as Swift stores it (ios/Sources/ShellConfig).
 * `keyPath` has no counterpart: the key is in the Secure Enclave and there is
 * no file to name (ios.md §4). */
interface ShellServer {
  id: string;
  name: string;
  destination: string;
  /** Where sshd listens, or 0 for the default. Its own field for the Mac's
   * reason (shared/connections.ts): a destination is not a `host:port`. */
  port: number;
  /** The pinned key's two fields, and no hostname: there is no known_hosts
   * file here for a hostname to index. "" for a record whose pin was dropped
   * because the server offered a different key. */
  hostKey: string;
}

const NO_SUCH = "There is no such connection.";
// A pin is the key of one machine, and this one carries no hostname to check
// it against — so an address that moved to another host has to be asked for a
// fingerprint again (remote.md §4). The dialog's own form sends one, so this
// is the backstop rather than the path.
const PIN_MOVED = "That pinned key belongs to another host. Check the new host's fingerprint first.";

/**
 * A fresh record's id.
 *
 * Not `crypto.randomUUID`, which is secure-context only and this page is served
 * from a custom scheme that is not one (lib/clipboard.ts says the same about
 * `navigator.clipboard`). `getRandomValues` has no such gate.
 */
function newServerId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The thirteen a client shell answers itself (wire.ts CLIENT_METHODS), for iOS.
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
): Pick<RequestClient, ClientMethod> {
  const stored = (): Promise<{ servers: ShellServer[]; selected: string }> =>
    shell.call("servers.list", {}) as Promise<{ servers: ShellServer[]; selected: string }>;
  const store = async (servers: ShellServer[], selected: string): Promise<void> => {
    await shell.call("servers.save", { servers, selected });
  };
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
    // And no second window (ios.md §4): a phone shows one app at a time, so the
    // client and the window are the same thing here in a way they stopped being
    // on the Mac (remote.md §8a). False rather than a no-op, so the verb is
    // absent from the palette instead of present and silent.
    windowNew: async () => ({ ok: false }),

    // The connection list, which is the phone's own and not a server's — the
    // same claim remote.md §8 makes about a Mac's. Swift holds the file; every
    // rule below is this file's, so that "can this be deleted" has one answer
    // rather than one per client.
    //
    // `active` is the selection and cannot be anything else: Swift dials
    // whatever is selected at launch, and every change to the selection is
    // followed by a reload (ios.md §5, "foregrounding is a boot"). A phone that
    // could not reach its server never renders this at all — it shows the
    // sentence in ios.tsx instead — so there is no boot-time fallback to report
    // the way the Mac's local server is.
    //
    // `keyPath` is empty on every row, and that is a fact rather than a
    // placeholder: this client's key is in the Secure Enclave and cannot be
    // read out of it, let alone named by a file (ios.md §4).
    connectionList: async () => {
      const { servers, selected } = await stored();
      return {
        connections: servers.map((s) => ({
          id: s.id,
          name: s.name,
          destination: s.destination,
          port: s.port,
          keyPath: "",
          pinned: s.hostKey !== "",
          lastReached: 0,
        })),
        active: selected,
        wanted: selected,
        error: "",
        build,
      };
    },

    // Switching is storing the selection; the reload that rebuilds the session
    // is the caller's, after it has flushed (lib/connections.ts). Choosing the
    // one already selected is not a no-op here and must not become one: it is
    // how a phone reconnects after the ladder has given up, which on a phone is
    // the ordinary path rather than the exception (ios.md §5).
    connectionSelect: async ({ id }) => {
      const { servers, selected } = await stored();
      if (!servers.some((s) => s.id === id)) return { ok: false, error: NO_SUCH };
      if (id !== selected) await store(servers, id);
      return { ok: true, error: "" };
    },

    connectionAdd: async ({ name, destination, port, hostKey }) => {
      const refusal = validateConnection({ name, destination, keyPath: "", port });
      if (refusal) return { id: "", error: refusal };
      const { servers, selected } = await stored();
      const server: ShellServer = {
        id: newServerId(),
        name: name.trim(),
        destination: destination.trim(),
        port,
        hostKey: hostKey.trim(),
      };
      await store([...servers, server], selected);
      return { id: server.id, error: "" };
    },

    connectionUpdate: async ({ id, name, destination, port, hostKey }) => {
      const refusal = validateConnection({ name, destination, keyPath: "", port });
      if (refusal) return { ok: false, error: refusal };
      const { servers, selected } = await stored();
      const before = servers.find((s) => s.id === id);
      if (!before) return { ok: false, error: NO_SUCH };
      // By the HOST half, because the user half is not what a host key belongs
      // to: `dev@box` to `ledge@box` is the same machine and the same key. The
      // PORT is part of it though: two sshd instances on one machine really can
      // offer different keys (shared/connections.ts).
      const moved = hostPart(destination.trim()) !== hostPart(before.destination) || port !== before.port;
      if (moved && hostKey === null) return { ok: false, error: PIN_MOVED };
      const after: ShellServer = {
        ...before,
        name: name.trim(),
        destination: destination.trim(),
        port,
        hostKey: hostKey === null ? before.hostKey : hostKey.trim(),
      };
      await store(
        servers.map((s) => (s.id === id ? after : s)),
        selected,
      );
      return { ok: true, error: "" };
    },

    // The Mac refuses to remove the connection being served because it always
    // has somewhere else to be — the server in its own process. A phone has
    // none, so the last one CAN go, and doing so is how a phone forgets a
    // server it typed wrong: Swift has nothing left to dial and shows the
    // pairing screen (ios/Sources/WebHost.swift).
    connectionRemove: async ({ id }) => {
      const { servers, selected } = await stored();
      if (!servers.some((s) => s.id === id)) return { ok: false, error: NO_SUCH };
      if (id === selected && servers.length > 1) {
        return { ok: false, error: "Switch to another server before removing this one." };
      }
      const left = servers.filter((s) => s.id !== id);
      await store(left, left.some((s) => s.id === selected) ? selected : "");
      return { ok: true, error: "" };
    },

    connectionProbe: async ({ destination, port }) =>
      (await shell.call("servers.probe", { destination, port })) as {
        hostKey: string;
        fingerprint: string;
        keyType: string;
        error: string;
      },
  };
}

/** What the overlay answers, for the test that holds it to CLIENT_METHODS. */
export const iosClientMethods = (): string[] =>
  Object.keys(clientSeams({} as RequestClient, { call: async () => null, destination: () => "" }, ""));

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
