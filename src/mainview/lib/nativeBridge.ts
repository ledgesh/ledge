// The Swift shell, from the page's side (ios.md §2). WKWebView gives a page two
// one-way channels: a message handler it posts JSON into, and
// `evaluateJavaScript` coming back. This file carries a byte stream over both,
// plus a request/response channel for what only the device can answer. Only
// `attachShell` at the bottom touches WebKit; the rest is testable in Bun.
import { hostPart, validateConnection, validatePassword, type AuthMode } from "../../shared/connections";
import { fedDuplex, type ClientConnection, type Duplex } from "../../shared/transport";
import {
  CLIENT_METHODS,
  fromBase64,
  toBase64,
  type ClientMethod,
  type RequestClient,
} from "../../shared/wire";

/** What Swift implements: nineteen strings and a flat switch. The calls are
 * their own vocabulary, `clipboard.read` and not `clipboardRead`: they are not
 * the schema's methods, and naming them as if they were is the invitation to
 * implement half the schema in Swift (ios.md §2). `clipboard.image` is the case
 * that shows it, and `assetPaste` below is where the other half lands. */
export const SHELL_CALLS = [
  // The bridge's own verbs, `@`-prefixed so no schema method can collide with
  // them. `@hello` is asked once, before any socket exists: the client id keys
  // the saved layout (remote.md §5), so it is needed before the first dial. It
  // is a fact about the device rather than about a connection to it.
  "@hello",
  "@open",
  "@close",
  // A line on the shell's own console. The webview's console goes nowhere by
  // default, and the window this matters most in is the one before a server is
  // reachable, when nothing can be written to its log either.
  "@log",
  // Which surface the keyboard is over (ios.md §7). One private content view is
  // the first responder for every field in the page, so the shell cannot tell a
  // note from a search box. The accessory bar hangs off that responder, and
  // without this call it would offer Bold over a passphrase prompt. Three
  // answers, not two: a running block wants keys of its own (`barFaceOf` below).
  "@focus",
  // The device's four clipboard answers. `menu.set` below does nothing on a
  // phone (ios.md §11) and is on the list anyway: the page answers it without
  // asking, and Swift's case is there so a page that does ask gets a reply
  // (ios/Sources/WebHost.swift).
  "clipboard.read",
  "clipboard.write",
  "clipboard.readRich",
  "clipboard.image",
  // A paste event's picture, re-encoded the way a picked photo is (ios.md
  // §11). WebKit already read it during the user's Paste, so the page hands
  // it over rather than `clipboard.image` reading the pasteboard again.
  "image.encode",
  // A picture from the photo library, the camera or Files, as bytes the server
  // can store (ios.md §11). Slow by the standards of everything else here: it
  // puts a menu and then a system screen up and waits for a person. Answers ""
  // for a cancel, which is the common case.
  "image.pick",
  "link.open",
  // The device's own share sheet, for the one string a phone has to get onto
  // another machine: its `authorized_keys` line (ios.md §4). The clipboard ends
  // at the device holding it, so a copy button would leave that line to be
  // retyped. This call lets it leave by AirDrop instead.
  "share.text",
  "menu.set",
  // Which servers this phone knows (remote.md §8). Swift holds the bytes and
  // dials the selection. Every rule about what may be added, renamed or removed
  // is in `clientSeams` below, beside the Mac's in bun/connectionManager.ts, so
  // "can this be deleted" has one answer rather than one per language.
  "servers.list",
  "servers.save",
  // Store or forget one server's password (remote.md §4). Its own call rather
  // than a field on `servers.save`, which carries the whole list on every
  // rename: a secret crosses this bridge when it changes and never otherwise.
  // Nothing reads one back. The page has no call for it, and Swift has no reply
  // that carries one.
  "servers.password",
  // A dial as far as key exchange, which is where the host key is offered. The
  // job `ssh-keyscan` does on a Mac: a fingerprint, before this phone's key goes
  // on the wire and before the server has been asked to accept it (ios.md §3).
  "servers.probe",
  // Hand the window back to the shell's own server screens, with the reason to
  // show on them. The list above is managed from the connection dialog, which
  // is React and so needs a connection. The state it cannot cover is a boot
  // that never reached a server, and this is the page in that state asking for
  // the native list instead (mainview/ios.tsx, ios.md §4).
  "servers.choose",
] as const;

export type ShellCall = (typeof SHELL_CALLS)[number];

/**
 * What the keyboard is over, and therefore which face the accessory bar wears
 * (ios.md §7): the note's own Markdown verbs, the keys a running block needs
 * (editor/inlineTerm.ts RUN_KEYS), or no bar at all. "none" covers every other
 * field on the page, where the note's verbs would act on the note behind.
 */
export type BarFace = "none" | "note" | "run";

/** Page to shell. A frame crosses as an opaque base64 string that no Swift code
 * parses: the page runs the whole protocol stack (shared/transport.ts), and
 * Swift owns the socket and nothing above it (ios.md §2). `WKScriptMessage.body`
 * carries JSON-compatible types only, so a Uint8Array does not survive the trip,
 * and base64 costs a third of a memcpy inside one device. */
export type ToShell = { t: "frame"; b: string } | { t: "call"; id: number; m: ShellCall; p: unknown };

/**
 * Shell to page.
 *
 * `gen` numbers the socket a message belongs to. A reconnect opens a new socket
 * while the old one's close is still in flight. Without the number, the old
 * socket's close would tear down the new connection.
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
  // command id and nothing else: the bar names a verb the way the Mac's menu
  // bar does, and the command registry knows what any of them mean. Swift holds
  // the strings and no behavior, so a renamed or withdrawn command leaves a
  // button that does nothing and logs it (commands/CommandProvider.tsx).
  | { t: "verb"; id: string }
  // A button on the bar's other face, over a running block. The same shape and
  // the same rule one domain along: the payload is the name of a key, and the
  // page turns that name into bytes (editor/inlineTerm.ts RUN_KEYS). Swift
  // never learns that Ctrl-C is one byte.
  | { t: "key"; k: string };

/** What `@hello` answers: who this client is (remote.md §5), what to call the
 * machine it is pointed at (remote.md §8, so the indicator can name one), and
 * the `authorized_keys` line a server has to trust before this phone can reach
 * it (ios.md §4). All of them are facts about the device, asked once. */
export interface ShellHello {
  client: string;
  /** What this phone calls itself, for the other clients on the same server
   * (wire.ts `Hello.label`). Swift's answer, because the device name is UIKit's
   * to give. The page only forwards it into the handshake. */
  label: string;
  destination: string;
  key: string;
}

export interface Shell {
  /** One native call. Rejects with the shell's own words when it refuses. */
  call(m: ShellCall, p: unknown): Promise<unknown>;
  /** Ask who this client is and where it is pointed. Once, before the first
   * dial. */
  hello(): Promise<ShellHello>;
  /** Open a socket and take the byte stream over it. What `reconnectingClient`
   * dials; a new one supersedes whatever was open. */
  dial(): Promise<Duplex>;
  /** What `@hello` said, for the connection chrome. */
  destination(): string;
  /** A line on the shell's console, for the window where nothing else can
   * carry one. Never rejects: a log line is not worth a failure. */
  log(text: string): void;
  /** Say what has focus, so the shell knows which bar to put on the keyboard it
   * is about to show. Idempotent and cheap: only transitions are sent. */
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
 * Pure: `post` is the only way out and `deliver` the only way in, so a test can
 * drive the whole thing with two functions.
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
          // A frame from a superseded socket carries bytes from a connection
          // this client has already dropped. Feeding them to the current
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
 * The run is tested before the note because a run's output panel is a
 * CodeMirror block widget: it sits in `.cm-content` and answers the note's own
 * test. The other order is the phase 6 defect one layer in, a formatting bar
 * over a program waiting for a password, whose Bold acts on the note behind it.
 *
 * Pure, and by class rather than by anything either surface exports:
 * `.cm-content` and `.ledge-output` are what CodeMirror and
 * `editor/inlineTerm.ts` put in the DOM, and what every spec in `e2e/` reaches
 * for. Needs a document, so it is proved in e2e/phone.spec.ts rather than Bun.
 */
export function barFaceOf(el: Element | null): BarFace {
  if (el?.closest(".ledge-output")) return "run";
  return el?.closest(".cm-content") ? "note" : "none";
}

/**
 * The transition filter in front of `@focus`: pass it what has focus now, and
 * it calls `tell` only when the answer changed. Focus events arrive in pairs (a
 * focusout and a focusin per move) and the editor keeps focus across most of
 * them, so an unfiltered reporter would cross the bridge on every caret move
 * inside one note. Pure, and separate from the DOM listener that feeds it.
 */
export function focusReporter(tell: (over: BarFace) => void): (over: BarFace) => void {
  // Not the first report. The shell's own default is "none", so starting at
  // the same value means the first call is sent only when it says something.
  let last: BarFace = "none";
  return (over) => {
    if (over === last) return;
    last = over;
    tell(over);
  };
}

/**
 * The server's handlers with the client's own laid over the top: the overlay
 * bun/clientSeams.ts applies on a Mac, for a shell whose natives are Swift's.
 *
 * `build` is the server's, read off its handshake (remote.md §11), rather than
 * this client's own version: the connection chrome reports what it reached.
 */
export function nativeOverlay(
  wire: Pick<ClientConnection, "requests" | "recheck">,
  shell: Pick<Shell, "call" | "destination">,
  build: string,
): RequestClient {
  return { ...wire.requests, ...clientSeams(wire, shell, build) };
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
  /** Which door (shared/connections.ts). The password itself is not here and
   * never comes back over the bridge: it is in the phone's keychain under the
   * id, put there by `servers.password` (ios/Sources/ServerPassword.swift). */
  auth: AuthMode;
}

const NO_SUCH = "There is no such connection.";
// A pin is one machine's key, and this pin carries no hostname to check it
// against (`hostKey` above). An address that moved to another host has to be
// asked for a fingerprint again (remote.md §4). The dialog's own form sends
// one, so this is the backstop rather than the path.
const PIN_MOVED = "That pinned key belongs to another host. Check the new host's fingerprint first.";
const KEYCHAIN_REFUSED = "This device's keychain would not store that password.";

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
 * The seventeen a client shell answers itself (wire.ts CLIENT_METHODS), for
 * iOS. Typed as the whole list rather than as a partial map, so a name added to
 * CLIENT_METHODS fails to compile here until this shell answers it too. The
 * alternative is a method that quietly reaches the wire, where the server
 * refuses it (remote.md §10) and the refusal costs a round trip.
 */
function clientSeams(
  wire: Pick<ClientConnection, "requests" | "recheck">,
  shell: Pick<Shell, "call" | "destination">,
  build: string,
): Pick<RequestClient, ClientMethod> {
  const requests = wire.requests;
  const stored = (): Promise<{ servers: ShellServer[]; selected: string }> =>
    shell.call("servers.list", {}) as Promise<{ servers: ShellServer[]; selected: string }>;
  const store = async (servers: ShellServer[], selected: string): Promise<void> => {
    await shell.call("servers.save", { servers, selected });
  };
  // A string stores, null forgets. Swift sweeps the keychain on every save, so
  // a removal needs nothing here. This call exists for the two changes a list
  // cannot express: setting a password, and moving off the password door.
  const keepPassword = async (id: string, password: string | null): Promise<boolean> =>
    ((await shell.call("servers.password", { id, password })) as { ok: boolean }).ok;
  return {
    clipboardWrite: async ({ text }) => {
      await shell.call("clipboard.write", { text });
      return { ok: true };
    },
    clipboardRead: async () => ({ text: (await shell.call("clipboard.read", {})) as string }),
    clipboardReadRich: async () => (await shell.call("clipboard.readRich", {})) as { text: string; html: string },
    // The pasteboard is this device's and the file is the server's, which are
    // two machines' jobs the schema gives one method (remote.md §5). Swift
    // answers with the image's bytes or "" for no image, and the name comes
    // back from the machine that holds the notes. Neither the view nor the
    // shell ever names a file (remote.md §2).
    //
    // A paste event's picture is re-encoded rather than read again, which
    // would be the programmatic read iOS guards with Allow Paste (ios.md §11).
    assetPaste: async ({ root, notePath, dataB64: carried }) => {
      const dataB64 = (
        carried ? await shell.call("image.encode", { dataB64: carried }) : await shell.call("clipboard.image", {})
      ) as string;
      if (!dataB64) return { src: null };
      return requests.assetWrite({ root, notePath, dataB64 });
    },
    // The one above with the device's pickers where the pasteboard was (ios.md
    // §11).
    assetPick: async ({ root, notePath }) => {
      const dataB64 = (await shell.call("image.pick", {})) as string;
      if (!dataB64) return { src: null };
      return requests.assetWrite({ root, notePath, dataB64 });
    },
    linkOpen: async ({ url }) => (await shell.call("link.open", { url })) as { ok: boolean },
    // There is no menu bar on a phone (ios.md §11). The view builds one anyway.
    // The command registry is the menu's source and knows nothing about shells,
    // so this is where the menu stops.
    menuSet: async () => ({ ok: true }),
    // And no second window (ios.md §11): a phone shows one app at a time, so the
    // client and the window are the same thing here in a way they stopped being
    // on the Mac (remote.md §8a). False rather than a no-op, so the verb is
    // absent from the palette instead of present and silent.
    windowNew: async () => ({ ok: false }),
    // And so no window for the manual to have of its own: it opens in the one
    // window there is, which is what `multiWindow` already tells the view
    // before it asks (lib/shell.ts). False here answers anything that asks
    // anyway.
    windowDocs: async () => ({ ok: false }),
    // The one window a phone has is never the manual's. The manual is a
    // workspace inside it (mainview/workspace/actions.ts openDocs).
    windowRole: async () => ({ docs: false, page: "" }),

    // The phone's own list and not a server's, the same claim remote.md §8
    // makes about a Mac's. Swift holds the file; the rules are all in this
    // file (`servers.list` above).
    //
    // `active` is the selection and cannot be anything else. Swift dials
    // whatever is selected at launch, and a reload follows every change to the
    // selection (ios.md §5, "foregrounding is a boot"). Where the Mac reports
    // its local server as a boot-time fallback, a phone has none: one that
    // could not reach its server never renders this at all, and shows the
    // sentence in ios.tsx, whose way out is `servers.choose` and the native
    // list.
    //
    // `keyPath` is empty on every row, and that is a fact rather than a
    // placeholder to fill in later. This client's key is in the Secure Enclave
    // and cannot be read out of it, let alone named by a file (ios.md §4).
    connectionList: async () => {
      const { servers, selected } = await stored();
      return {
        connections: servers.map((s) => ({
          id: s.id,
          name: s.name,
          destination: s.destination,
          port: s.port,
          keyPath: "",
          auth: s.auth,
          pinned: s.hostKey !== "",
          lastReached: 0,
        })),
        active: selected,
        wanted: selected,
        error: "",
        build,
      };
    },

    // The phone's half of the same verb (rpc-schema.ts connectionReconnect). It
    // reaches the same `recheck` the Mac's does, because the transport under
    // both is the same module (ios.md §2). The case it was written for is a
    // phone that has just come back to the foreground on a different network.
    connectionReconnect: async () => {
      wire.recheck();
      return { ok: true };
    },

    // Switching is storing the selection. The reload that rebuilds the session
    // is the caller's, after it has flushed (lib/connections.ts). Choosing the
    // one already selected is not a no-op here and must not become one: it
    // reports ok and the caller reloads. That is the ordinary way a phone
    // reconnects after the ladder has given up (ios.md §5).
    connectionSelect: async ({ id }) => {
      const { servers, selected } = await stored();
      if (!servers.some((s) => s.id === id)) return { ok: false, error: NO_SUCH };
      if (id !== selected) await store(servers, id);
      return { ok: true, error: "" };
    },

    connectionAdd: async ({ name, destination, port, auth, password, hostKey }) => {
      const refusal = validateConnection({ name, destination, keyPath: "", port });
      if (refusal) return { id: "", error: refusal };
      if (auth === "password") {
        const unusable = validatePassword(password);
        if (unusable) return { id: "", error: unusable };
      }
      const { servers, selected } = await stored();
      const server: ShellServer = {
        id: newServerId(),
        name: name.trim(),
        destination: destination.trim(),
        port,
        hostKey: hostKey.trim(),
        auth,
      };
      // The secret before the record, so a saved list never names a password
      // door with nothing behind it. The Mac's order, for the Mac's reason
      // (bun/connectionStore.ts).
      if (auth === "password" && !(await keepPassword(server.id, password))) {
        return { id: "", error: KEYCHAIN_REFUSED };
      }
      await store([...servers, server], selected);
      return { id: server.id, error: "" };
    },

    connectionUpdate: async ({ id, name, destination, port, auth, password, hostKey }) => {
      const refusal = validateConnection({ name, destination, keyPath: "", port });
      if (refusal) return { ok: false, error: refusal };
      const { servers, selected } = await stored();
      const before = servers.find((s) => s.id === id);
      if (!before) return { ok: false, error: NO_SUCH };
      if (auth === "password") {
        // Null means keep the stored one, which is only an answer for a record
        // that was already on this door. No call reads a password back, so "is
        // there one" is answered by the record rather than by the keychain. The
        // two are written together, so the answer is the same.
        if (password === null && before.auth !== "password") {
          return { ok: false, error: "That connection has no password stored. Enter one." };
        }
        if (password !== null) {
          const unusable = validatePassword(password);
          if (unusable) return { ok: false, error: unusable };
        }
      }
      // Compared by the host half, because a host key does not belong to the
      // user half: `dev@box` to `ledge@box` is the same machine and the same
      // key. The port is part of it: two sshd instances on one machine can
      // offer different keys (shared/connections.ts).
      const moved = hostPart(destination.trim()) !== hostPart(before.destination) || port !== before.port;
      if (moved && hostKey === null) return { ok: false, error: PIN_MOVED };
      const after: ShellServer = {
        ...before,
        name: name.trim(),
        destination: destination.trim(),
        port,
        hostKey: hostKey === null ? before.hostKey : hostKey.trim(),
        auth,
      };
      // A new password, or a move off the password door that takes the stored
      // one with it. Neither is expressible in the list, which is why the
      // credential is its own call. A rename is neither of them, which is why
      // this call is not made on every edit.
      if (auth === "key") {
        if (before.auth === "password") await keepPassword(id, null);
      } else if (password !== null && !(await keepPassword(id, password))) {
        return { ok: false, error: KEYCHAIN_REFUSED };
      }
      await store(
        servers.map((s) => (s.id === id ? after : s)),
        selected,
      );
      return { ok: true, error: "" };
    },

    // The Mac refuses to remove the connection being served, because it always
    // has somewhere else to be: the server in its own process. A phone has no
    // such fallback, so the last one can go. That is how a phone forgets a
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
  Object.keys(
    clientSeams(
      { requests: {} as RequestClient, recheck: () => {} },
      { call: async () => null, destination: () => "" },
      "",
    ),
  );

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
 * The only WebKit in this file. Throws where there is no bridge at all: the iOS
 * entry point has nothing to fall back to, and a page that carried on with no
 * server would look like a hung app.
 */
export function attachShell(): Shell {
  const handler = window.webkit?.messageHandlers?.[SHELL_HANDLER];
  if (!handler) throw new Error(`this page is not inside the Ledge shell (no ${SHELL_HANDLER} message handler)`);
  const shell = nativeShell((msg) => handler.postMessage(msg));
  window.__ledge = { deliver: (msg) => shell.deliver(msg) };
  return shell;
}
