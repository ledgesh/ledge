// The "Make This Note a Template" verb's editing arm: add or remove the note's
// `template: true` frontmatter line in the live editor. The line surgery is
// setTemplateMarker (shared/template.ts). Turning the flag off runs the same
// strip instantiation runs, so both agree on which line is the marker. The
// edit is a CodeMirror transaction: undo takes it back, autosave writes it.
import type { EditorView } from "@codemirror/view";
import { frontmatterEnd, parseFrontmatter } from "../../shared/frontmatter";
import { setTemplateMarker } from "../../shared/template";

// Enough of the note to hold its frontmatter block. glue.ts noteHead slices
// the same 4096. Both truncate a block past 4KB, an accepted edge: no real
// note has one that big. Slicing the head avoids serializing a note carrying
// a pasted blob to touch its first lines. Every change the marker makes lands
// inside the block, or creates one, so the tail is never involved.
const HEAD_BYTES = 4096;

export function toggleTemplateFlag(view: EditorView): void {
  const head = view.state.sliceDoc(0, Math.min(HEAD_BYTES, view.state.doc.length));
  const next = setTemplateMarker(head, !parseFrontmatter(head).params.template);
  if (next === head) return;
  // Replace only the frontmatter region: [0, old block end) becomes the new
  // text's block. The caret and everything below it map through that change
  // instead of through a whole-document rewrite.
  view.dispatch({
    changes: { from: 0, to: frontmatterEnd(head), insert: next.slice(0, frontmatterEnd(next)) },
  });
}
