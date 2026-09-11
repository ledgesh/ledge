// Cut, Copy and the two Pastes, as editor commands, and the paste event.
//
// The Mac's view runs under the views:// scheme, which is not a secure context:
// navigator.clipboard is unavailable and WebKit's own cut/copy/paste events
// never carry data, so every one of these goes through the client
// (lib/clipboard.ts: pbcopy on a Mac, UIPasteboard on a phone). Two surfaces
// run them: the chords in setup.ts's keymap and the editor's context menu
// (interactions.md §11). Keeping them here rather than inline in the keymap
// makes a menu item and a chord one act with one undo entry, not two
// implementations that drift apart.
import { EditorView, type Command } from "@codemirror/view";
import { copyText, readClipboard, readRichClipboard } from "../lib/clipboard";
import { blockPasteInsert, parsePasteHtml, richPasteMarkdown, verbatimPaste } from "./htmlPaste";
import { embedImage } from "./images";
import { pasteImageAsset } from "../lib/assets";
import { toBase64 } from "../../shared/wire";

/** Every selected range, newline-joined: what ⌘C puts on the pasteboard. */
export function selectedText(view: EditorView): string {
  return view.state.selection.ranges.map((r) => view.state.sliceDoc(r.from, r.to)).join("\n");
}

/** Whether anything is selected. The context menu greys Cut and Copy when
 * this is false (commands/registry.ts). */
export function hasSelection(view: EditorView): boolean {
  return view.state.selection.ranges.some((r) => !r.empty);
}

/**
 * Paste the pasteboard's text, converted to Markdown when `html` carries
 * formatting the text has lost. `richPasteMarkdown` decides that and returns
 * null to decline (editor/htmlPaste.ts). On null, `text` goes in exactly as it
 * arrived. A paste into a fence, a code span, or the frontmatter skips the
 * conversion and stays verbatim.
 */
function pasteText(view: EditorView, text: string, html: string): void {
  const sel = view.state.selection.main;
  const md = verbatimPaste(view.state, sel.from)
    ? null
    : richPasteMarkdown(text, parsePasteHtml(html));
  if (md === null) {
    view.dispatch(view.state.replaceSelection(text));
    return;
  }
  const before = view.state.sliceDoc(view.state.doc.lineAt(sel.from).from, sel.from);
  view.dispatch({
    ...view.state.replaceSelection(blockPasteInsert(before, md)),
    userEvent: "input.paste",
  });
}

// Each returns true so the key event is consumed. That blocks the broken
// native path, and it keeps an unhandled ⌘-key from reaching AppKit, where it
// would ring the system alert. The menu path ignores the return value
// (commands/glue.ts).

export const copySelection: Command = (view) => {
  const text = selectedText(view);
  if (text) copyText(text);
  return true;
};

export const cutSelection: Command = (view) => {
  const text = selectedText(view);
  if (text) {
    copyText(text);
    view.dispatch(view.state.replaceSelection(""));
  }
  return true;
};

export const pasteHere: Command = (view) => {
  // Text first, image as the fallback. A pasteboard carrying text is a text
  // paste. A pasteboard with an image and no text (a screenshot, a copied
  // picture) embeds the image: Bun saves it under .ledge-assets/ and hands back
  // the reference to insert. The insert leaves the caret on the line below the
  // markdown, so the image renders the moment it lands (editor/images.ts).
  void readRichClipboard().then(async ({ text, html }) => {
    if (text) {
      pasteText(view, text, html);
      return;
    }
    // The pasted image belongs to this note's workspace: its reference
    // resolves against that folder. embedImage holds the rest (where the
    // caret ends up, what a null answer means). Insert Image… runs the same
    // function with pickImageAsset, so only the source of the bytes differs.
    await embedImage(view, pasteImageAsset);
  });
  return true;
};

// Paste the text flavor without the Markdown translation, on ⇧⌘V. Reading
// that flavor alone is the cheaper of the two clipboard calls. Formatted text
// converts by default, so the opt-out is the shifted chord: macOS gives it to
// "Paste and Match Style" and Obsidian to "paste as plain text".
export const pastePlain: Command = (view) => {
  void readClipboard().then((text) => {
    if (text) view.dispatch(view.state.replaceSelection(text));
  });
  return true;
};

/**
 * What a paste event carries, reduced to what the editor does with it: text
 * with its HTML flavor, a picture and no text, or nothing it can use. Text
 * wins, as it does for ⌘V. `fileTypes` are the MIME types of the event's file
 * items.
 */
export type EventPaste = { kind: "text"; text: string; html: string } | { kind: "image" } | null;

export function eventPaste(text: string, html: string, fileTypes: readonly string[]): EventPaste {
  if (text) return { kind: "text", text, html };
  return fileTypes.some((t) => t.startsWith("image/")) ? { kind: "image" } : null;
}

// The platform's own paste, which is how a phone's callout Paste arrives. On
// iOS the event carries the pasteboard (ios.md §11); on the Mac it carries
// nothing, this returns false, and CodeMirror's own handler runs as before.
// The picture is taken from the event while it dispatches: WebKit read it
// under the user's Paste, and a second read is one iOS guards.
export const pasteEvent = EditorView.domEventHandlers({
  paste(event, view) {
    const data = event.clipboardData;
    if (!data || view.state.readOnly) return false;
    const files = Array.from(data.items).filter((item) => item.kind === "file");
    const text = data.getData("text/plain") || data.getData("text/uri-list");
    const got = eventPaste(text, data.getData("text/html"), files.map((item) => item.type));
    if (!got) return false;
    if (got.kind === "text") {
      pasteText(view, got.text, got.html);
      return true;
    }
    const file = files.find((item) => item.type.startsWith("image/"))?.getAsFile() ?? null;
    void embedImage(view, async (folder, notePath) =>
      pasteImageAsset(folder, notePath, file ? toBase64(new Uint8Array(await file.arrayBuffer())) : undefined),
    );
    return true;
  },
});
