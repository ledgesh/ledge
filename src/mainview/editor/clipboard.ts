// Cut, Copy and the two Pastes, as editor commands.
//
// The view runs under the views:// scheme, which is not a secure context:
// navigator.clipboard is unavailable and WebKit's own cut/copy/paste events
// never carry data, so every one of these goes through the Bun process
// (lib/clipboard.ts, pbcopy/pbpaste). They live here rather than inline in
// setup.ts's keymap because two surfaces run them now — the chords, and the
// editor's context menu (interactions.md §11) — and a menu item and a chord
// have to be one act with one undo entry, not two implementations that agree
// today.
import type { Command, EditorView } from "@codemirror/view";
import { copyText, readClipboard, readRichClipboard } from "../lib/clipboard";
import { blockPasteInsert, parsePasteHtml, richPasteMarkdown, verbatimPaste } from "./htmlPaste";
import { embedImage } from "./images";
import { pasteImageAsset } from "../lib/assets";

/** Every selected range, newline-joined — what ⌘C puts on the pasteboard. */
export function selectedText(view: EditorView): string {
  return view.state.selection.ranges.map((r) => view.state.sliceDoc(r.from, r.to)).join("\n");
}

/** Whether anything is selected, which is what greys Cut and Copy in the menu. */
export function hasSelection(view: EditorView): boolean {
  return view.state.selection.ranges.some((r) => !r.empty);
}

/**
 * Paste the pasteboard's text, as Markdown when it also carried formatted HTML
 * that says more than the text does — editor/htmlPaste.ts owns that whole
 * decision, including declining it, so what lands here is either the
 * translation or the text exactly as it arrived.
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

// Each returns true so the key event is consumed: that both blocks the broken
// native path and stops an unhandled ⌘-key from reaching AppKit, which would
// otherwise ring the system alert. From the menu the return value is ignored.

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
  // Text first, image as the fallback: a pasteboard carrying text is a text
  // paste, and a pasteboard with an image but no text — a screenshot, a copied
  // picture — embeds the image: Bun saves it under .ledge-assets/ and hands
  // back the reference to insert. The insert parks the caret on the line below
  // the markdown, so the image renders the moment it lands (editor/images.ts).
  void readRichClipboard().then(async ({ text, html }) => {
    if (text) {
      pasteText(view, text, html);
      return;
    }
    // The pasted image belongs to this note's workspace: its reference will
    // resolve against that folder. The rest — where the caret ends up, what a
    // null answer means — is shared with Insert Image…, which differs from
    // this only in where the bytes come from.
    await embedImage(view, pasteImageAsset);
  });
  return true;
};

// Paste without the translation. Formatted text converts by default (that is
// what a Markdown editor is for), so the escape hatch is the shifted chord —
// the same key macOS gives "Paste and Match Style" and Obsidian gives "paste
// as plain text", for the same act. This reads the text flavor alone, which is
// also the cheaper of the two calls.
export const pastePlain: Command = (view) => {
  void readClipboard().then((text) => {
    if (text) view.dispatch(view.state.replaceSelection(text));
  });
  return true;
};
