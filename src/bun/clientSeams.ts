// The handlers the client keeps for itself.
//
// Most of the protocol is a question about the notes, and the answer is on the
// machine that holds them. A few are the opposite: the pasteboard you copied
// from, the browser that should open a link, and the menu bar at the top of
// the screen all belong to the device in front of the user, and answering them
// on the server would reach the wrong machine — a VPS's empty pasteboard, a
// link opened in a browser nobody is looking at, a menu bar that does not
// exist and takes ⌘Q with it (remote.md §10). So does the list of servers this
// app can connect to, which is nobody's business but this app's (§8).
//
// So the client shell serves them itself, whether it is talking to a server in
// its own process or to one across an ssh connection, and they never become
// frames. bun/server.ts implements the same names as refusals: the handler map
// is total by construction, and a call that reaches the server's copy is a
// wiring bug that should say so rather than quietly return an empty string.
//
// This module imports no Electrobun. The two genuinely native bits arrive as
// optional dependencies, exactly as bun/server.ts takes its folder dialog.
import { readClipboardHtml, readClipboardImage, readClipboardText, writeClipboard } from "./clipboard";
import { loadClientSettings, readClientSettingsFile, writeClientSettingsFile } from "./clientSettings";
import { mergeSettings, type Settings } from "../shared/settings";
import { openableUrl } from "../shared/links";
import { NATIVE_METHODS, type NativeMethod, type RequestHandlers } from "../shared/wire";

export interface ClientNative {
  // The pasteboard's available flavors, or null where they cannot be read.
  // Null means "ask the pasteboard anyway" (clipboardReadRich fails open).
  clipboardFormats?(): string[] | null;
  // Hand the view's menu description to the platform. A no-op off macOS.
  setMenu?(items: unknown[]): void;
  // The pasteboard's image, as PNG bytes. Defaults to the osascript route
  // (bun/clipboard.ts). Injectable for two reasons that point the same way: a
  // client that is not a Mac reads its pasteboard some other way, and a test
  // suite must never read the developer's own — which is why the paste seam
  // is the one that takes a dependency and the text ones do not.
  readImage?(): Promise<Uint8Array | null>;
  // A picture chosen from this device, as PNG bytes, or null where the user
  // cancelled. The macOS file dialog here and PHPicker on iOS (ios.md §11).
  // Optional for readImage's reasons and one more: a client with no picker is a
  // client where Insert Image… answers null, which is what a cancelled picker
  // answers too, so the seam degrades into the outcome the view already
  // handles.
  pickImage?(): Promise<Uint8Array | null>;
}

// NATIVE_METHODS, CONNECTION_METHODS and CLIENT_METHODS are shared/wire.ts's:
// this module is one shell's implementation of the first group, and iOS has
// another (ios.md §2). The list has to outlive both.

// Whether clipboardReadRich should pay for the osascript spawn. Fails open in
// both directions that mean "we do not know": a platform with no format list
// (null) and a list that came back empty both ask the pasteboard anyway, so a
// wrong answer costs ~100ms and never the paste.
export function wantsHtml(formats: string[] | null): boolean {
  return formats === null || formats.length === 0 || formats.includes("html");
}

/**
 * The whole map a client shell should serve: the server's handlers, with the
 * client's own answers laid over the top.
 *
 * Two kinds of overlay, and the difference is worth keeping straight. The names
 * in CLIENT_METHODS never reach the server at all. The three settings entries
 * WRAP it: a settings file has two homes (remote.md §5), the server owns one,
 * this owns the other, and the view is handed one merged snapshot that does
 * not mention there were two.
 *
 * Applied identically whether `base` came from a server in this process or
 * from one across an ssh connection, which is what stops the remote path from
 * being the only place any of this runs.
 */
export async function clientOverlay(base: RequestHandlers, native: ClientNative): Promise<RequestHandlers> {
  // Read once at boot, exactly like the server reads its own: settings apply
  // at launch, never live (architecture.md, "Settings"), so a snapshot taken
  // here is the snapshot for the process.
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
 * The six themselves. `server` is where the one of them that produces a FILE
 * sends its bytes: reading a pasteboard and naming a file in a workspace are
 * different machines' jobs, and this is the seam between them.
 */
export function clientSeams(
  native: ClientNative,
  server: Pick<RequestHandlers, "assetWrite"> = { assetWrite: async () => ({ src: null }) },
): Pick<RequestHandlers, NativeMethod> {
  return {
    // The webview cannot reach the pasteboard itself (a views:// page is not a
    // secure context, so navigator.clipboard is absent), which is why copy and
    // paste are an RPC at all rather than a browser API.
    clipboardWrite: async ({ text }) => {
      await writeClipboard(text);
      return { ok: true };
    },
    clipboardRead: async () => ({ text: await readClipboardText() }),
    // Text and the HTML flavor together, for the editor's ⌘V. The two reads
    // run concurrently because the HTML one is an osascript spawn: ~100ms
    // serialized onto every paste is a keystroke that feels stuck. AppKit is
    // asked first whether there is any HTML at all (wantsHtml above), which
    // skips that spawn for every copy made inside Ledge — pbcopy writes text
    // alone — and for a terminal selection.
    clipboardReadRich: async () => {
      const [text, html] = await Promise.all([
        readClipboardText(),
        wantsHtml(native.clipboardFormats?.() ?? null) ? readClipboardHtml() : Promise.resolve(""),
      ]);
      return { text, html };
    },
    // ⌘V of an image. The pasteboard is this device's (a VPS has none), the
    // file is the server's: the bytes go over as base64 the schema declares
    // and the wire sends as a binary frame, and the NAME comes back. The view
    // still never names a file, and neither does this — the authority the
    // move cost is exactly none (remote.md §5).
    //
    // No image on the pasteboard answers null without troubling the server,
    // which is the common case: ⌘V with text on the pasteboard reaches here
    // only after the editor has already declined to paste it as text.
    assetPaste: async ({ root, notePath }) => {
      const bytes = await (native.readImage ?? readClipboardImage)();
      if (!bytes || bytes.length === 0) return { src: null };
      return server.assetWrite({ root, notePath, dataB64: Buffer.from(bytes).toString("base64") });
    },
    // The same trip from a picker rather than a pasteboard. Identical below the
    // first line, deliberately: what differs between "paste an image" and
    // "insert an image" is where the bytes come from and nothing else, and the
    // half that names the file is the server's in both cases.
    assetPick: async ({ root, notePath }) => {
      const bytes = await native.pickImage?.();
      if (!bytes || bytes.length === 0) return { src: null };
      return server.assetWrite({ root, notePath, dataB64: Buffer.from(bytes).toString("base64") });
    },
    // The native menu bar, shaped entirely by the view (commands/menu.ts). The
    // shell hands it to the platform and nothing more: the `action` strings are
    // command ids it never interprets, which is what keeps the registry the one
    // place a command is defined.
    menuSet: async ({ items }) => {
      native.setMenu?.(items);
      return { ok: true };
    },
    // openableUrl is the guard here, not a convenience: `open` treats a
    // non-URL argument as a file path (and launches .app bundles), so only the
    // allowlisted schemes may pass. This is the boundary, and the view's own
    // check is styling (architecture.md §2) — the url arrives from a note,
    // which is to say from anywhere.
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
