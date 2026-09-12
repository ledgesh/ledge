// The handlers the client keeps for itself.
//
// Most of the protocol is a question about the notes, and the machine that
// holds them answers. A few belong to the device in front of the user: the
// pasteboard, the browser that opens a link, the menu bar. On a server those
// reach the wrong machine: an empty pasteboard, a browser nobody is looking
// at, a menu bar that does not exist and takes ⌘Q with it (remote.md §10).
//
// The list of servers this app can connect to is the app's own for a
// different reason. A server has no business knowing which servers this client
// can reach (§8).
//
// The client shell serves them all itself, local server or remote, so they
// never become frames. bun/server.ts implements the same names as refusals
// that throw, typed so the map cannot lose one. A call that reaches the
// server's copy reports the wiring bug instead of returning an empty answer.
//
// This module imports no Electrobun. The native pieces arrive as optional
// dependencies (ClientNative below), the way bun/server.ts takes its folder
// dialog.
import { readClipboardHtml, readClipboardImage, readClipboardText, writeClipboard } from "./clipboard";
import { loadClientSettings, readClientSettingsFile, writeClientSettingsFile } from "./clientSettings";
import { mergeSettings, type Settings } from "../shared/settings";
import type { UpdateState } from "../shared/rpc-schema";
import { openableUrl } from "../shared/links";
import { NATIVE_METHODS, type NativeMethod, type RequestHandlers } from "../shared/wire";

export interface ClientNative {
  // The pasteboard's available flavors, or null where they cannot be read.
  // Null means "ask the pasteboard anyway" (clipboardReadRich fails open).
  clipboardFormats?(): string[] | null;
  // Hands the view's menu description to the platform. A no-op off macOS.
  setMenu?(items: unknown[]): void;
  // Opens another window, which is another client of another server
  // (remote.md §8a). Absent on a shell that can only ever have one window. The
  // view then leaves the verb out rather than offering one that fails
  // (mainview/lib/shell.ts multiWindow).
  newWindow?(): void;
  // Opens the manual's window on `page` ("" for its landing page), or raises
  // it and shows that page where it is already open. Absent for newWindow's
  // reason, and the caller then opens the manual in the window it has.
  docsWindow?(page: string): void;
  // Whether this window is the manual's, and the page it was opened to show.
  // Absent on a shell whose one window is never the manual's.
  windowRole?(): { docs: boolean; page: string };
  // The pasteboard's image, as PNG bytes. Defaults to the osascript route
  // (bun/clipboard.ts). Optional for two reasons: a client that is not a Mac
  // reads its pasteboard some other way, and the tests must not read the
  // developer's own pasteboard (clientSeams.test.ts injects one). That is why
  // the two image seams take a dependency and the text ones are imported from
  // ./clipboard.
  readImage?(): Promise<Uint8Array | null>;
  // A picture chosen from this device, as PNG bytes, or null where the user
  // cancelled. The macOS file dialog here (bun/index.ts), PHPicker on iOS
  // (ios.md §11). Optional for readImage's reasons and one more. A shell with
  // no picker makes Insert Image… answer null. A cancelled picker answers null
  // too, and the view already handles that.
  pickImage?(): Promise<Uint8Array | null>;
  // This app's own update (bun/updates.ts). Absent on a shell that does not
  // update itself, which then answers phase "off" and the view leaves the
  // update verbs out.
  updates?: {
    state(): UpdateState;
    check(): UpdateState;
    install(): Promise<boolean>;
  };
}

const NO_UPDATES: UpdateState = { phase: "off", version: "", detail: "This app does not update itself." };

// NATIVE_METHODS, CONNECTION_METHODS and CLIENT_METHODS live in
// shared/wire.ts, not here. This module implements the first group for the Mac
// shell. mainview/lib/nativeBridge.ts implements it for iOS (ios.md §2). Every
// shell needs the lists, so the lists have to outlive any one shell.

// Whether clipboardReadRich should pay for the osascript spawn. Both answers
// that mean the flavors are unknown (a null list, an empty one) ask the
// pasteboard anyway, so a wrong answer costs about 100ms and never the paste.
export function wantsHtml(formats: string[] | null): boolean {
  return formats === null || formats.length === 0 || formats.includes("html");
}

/**
 * The whole map a client shell serves: the server's handlers, with the
 * client's own answers laid over the top.
 *
 * The overlay works two ways. The native names below replace the server's
 * copies, which never run. The three settings entries wrap the server's copy
 * instead. A settings file has two homes (remote.md §5): the server owns one
 * and this owns the other, and the view gets one merged snapshot that does not
 * mention there were two.
 *
 * `base` may be a server in this process or one across an ssh connection. The
 * overlay is the same either way, so the in-process server exercises it too
 * and the ssh path is not the only place it runs.
 */
export async function clientOverlay(base: RequestHandlers, native: ClientNative): Promise<RequestHandlers> {
  // The client's settings, read once here. Settings apply at launch and never
  // live (architecture.md §6), the rule the server's half follows too. One
  // snapshot therefore serves the whole process.
  const mine: Settings = await loadClientSettings();
  return {
    ...base,
    ...clientSeams(native, base),
    settingsGet: async () => {
      const { settings } = await base.settingsGet({});
      return { settings: mergeSettings(settings, mine) };
    },
    // The dialog's two tabs. "client" is answered here; anything else is the
    // server's file and goes to whichever server this client is talking to.
    settingsRead: async ({ home }) =>
      home === "client" ? { text: await readClientSettingsFile() } : base.settingsRead({ home }),
    settingsWrite: async ({ home, text }) => {
      if (home !== "client") return base.settingsWrite({ home, text });
      await writeClientSettingsFile(text);
      return { ok: true };
    },
  };
}

/**
 * The native handlers (shared/wire.ts NATIVE_METHODS). `server` is where
 * the two that produce a file, assetPaste and assetPick, send their bytes:
 * this device reads the pasteboard or the picker, and the machine holding the
 * notes names the file.
 */
export function clientSeams(
  native: ClientNative,
  server: Pick<RequestHandlers, "assetWrite"> = { assetWrite: async () => ({ src: null }) },
): Pick<RequestHandlers, NativeMethod> {
  return {
    // Copy and paste are an RPC rather than a browser API because the webview
    // cannot reach the pasteboard. A views:// page is not a secure context, so
    // navigator.clipboard is absent there (bun/clipboard.ts).
    clipboardWrite: async ({ text }) => {
      await writeClipboard(text);
      return { ok: true };
    },
    clipboardRead: async () => ({ text: await readClipboardText() }),
    // Text and the HTML flavor together, for the editor's ⌘V. The two reads
    // run concurrently because the HTML one is an osascript spawn, and
    // serializing about 100ms onto every paste is a visible delay.
    //
    // AppKit is asked first whether there is any HTML at all (clipboardFormats
    // above, which bun/index.ts answers with Utils.clipboardAvailableFormats).
    // That skips the spawn for a copy made inside Ledge (pbcopy writes text
    // alone) and for a terminal selection.
    clipboardReadRich: async () => {
      const [text, html] = await Promise.all([
        readClipboardText(),
        wantsHtml(native.clipboardFormats?.() ?? null) ? readClipboardHtml() : Promise.resolve(""),
      ]);
      return { text, html };
    },
    // ⌘V of an image. This device reads the pasteboard (a VPS has none) and
    // the server writes the file. The schema declares base64, and the wire
    // sends it as a binary frame. The name comes back. Neither the view nor
    // this end names a file (remote.md §5).
    //
    // No image on the pasteboard answers null without a round trip. That is
    // the common case here: ⌘V with text on the pasteboard reaches this
    // handler only after the editor has declined to paste it as text.
    assetPaste: async ({ root, notePath, dataB64 }) => {
      // Bytes a paste event already carried, which a Mac's never does
      // (editor/clipboard.ts pasteEvent). Passed on as they came.
      if (dataB64) return server.assetWrite({ root, notePath, dataB64 });
      const bytes = await (native.readImage ?? readClipboardImage)();
      if (!bytes || bytes.length === 0) return { src: null };
      return server.assetWrite({ root, notePath, dataB64: Buffer.from(bytes).toString("base64") });
    },
    // The same trip from a picker rather than a pasteboard. Only the first
    // line differs, which is where the bytes come from. The server names the
    // file for both.
    assetPick: async ({ root, notePath }) => {
      const bytes = await native.pickImage?.();
      if (!bytes || bytes.length === 0) return { src: null };
      return server.assetWrite({ root, notePath, dataB64: Buffer.from(bytes).toString("base64") });
    },
    // The native menu bar, shaped by the view (commands/menu.ts). The shell
    // passes `items` to the platform and interprets nothing in it: the
    // `action` strings are command ids, so the registry stays the one place a
    // command is defined.
    menuSet: async ({ items }) => {
      native.setMenu?.(items);
      return { ok: true };
    },
    // Another window, and so another client (remote.md §8a). The shell opens
    // it on the local connection the way a launch does (bun/index.ts
    // openWindow). Moving it to another machine is an ordinary
    // connectionSelect from inside it.
    //
    // `ok: false` where there is no second window to give. Whether the verb is
    // offered at all is decided without calling this (mainview/lib/shell.ts
    // multiWindow), and the New Window command ignores the answer
    // (mainview/lib/windows.ts).
    windowNew: async () => {
      if (!native.newWindow) return { ok: false };
      native.newWindow();
      return { ok: true };
    },
    // The manual's window: one per app, raised rather than duplicated. The
    // shell decides whether that means opening a window or activating the one
    // already showing the manual. The view is not told which happened.
    windowDocs: async ({ page }) => {
      if (!native.docsWindow) return { ok: false };
      native.docsWindow(page);
      return { ok: true };
    },
    // Which window this view is in, asked once at boot. A shell that has one
    // window answers for it: it is never the manual's.
    windowRole: async () => native.windowRole?.() ?? { docs: false, page: "" },
    // The app's update, which belongs to the process rather than to a window,
    // so every window's handlers reach the same one (bun/index.ts).
    updateState: async () => native.updates?.state() ?? NO_UPDATES,
    updateCheck: async () => native.updates?.check() ?? NO_UPDATES,
    updateInstall: async () => ({ ok: (await native.updates?.install()) ?? false }),
    // openableUrl is the guard, not a convenience. `open` treats a non-URL
    // argument as a file path and launches .app bundles, so only the
    // allowlisted schemes pass (shared/links.ts). The url arrives from a note,
    // so this is the boundary. The view's own check is styling
    // (architecture.md §2).
    linkOpen: async ({ url }) => {
      const target = openableUrl(url);
      if (!target) return { ok: false };
      try {
        Bun.spawn(["open", target]);
      } catch (err) {
        console.warn("[links] could not open", target, err);
        return { ok: false };
      }
      return { ok: true };
    },
  };
}
