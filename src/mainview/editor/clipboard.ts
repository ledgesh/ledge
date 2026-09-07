// Cut, Copy and the two Pastes, as editor commands.
//
// The view runs under the views:// scheme, which is not a secure context:
// navigator.clipboard is unavailable and WebKit's own cut/copy/paste events
// never carry data, so every one of these goes through the Bun process
// (lib/clipboard.ts, pbcopy/pbpaste). Two surfaces run them: the chords in
// setup.ts's keymap and the editor's context menu (interactions.md §11).
// Keeping them here rather than inline in the keymap makes a menu item and a
// chord one act with one undo entry, not two implementations that drift apart.
import type { Command, EditorView } from "@codemirror/view";
import { copyText, readClipboard, readRichClipboard } from "../lib/clipboard";
import { blockPasteInsert, parsePasteHtml, richPasteMarkdown, verbatimPaste } from "./htmlPaste";
import { embedImage } from "./images";
import { pasteImageAsset } from "../lib/assets";

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
