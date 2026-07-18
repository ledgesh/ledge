// The "Make This Note a Template" verb's editing arm: add or remove the
// note's `template: true` frontmatter line in its LIVE editor. An ordinary
// CodeMirror transaction on purpose — undoable like any keystroke, picked up
// by autosave like any edit, and the saved file's watcher refresh is what
// carries the change into NoteMeta.template and so into the ⌥⌘N picker. The
// line surgery itself lives in shared/template.ts (setTemplateMarker), the
// same code instantiation strips with, so the two ends cannot disagree about
// what the marker line is.
import type { EditorView } from "@codemirror/view";
import { frontmatterEnd, parseFrontmatter } from "../../shared/frontmatter";
import { setTemplateMarker } from "../../shared/template";

// Enough of the note to hold its frontmatter block — glue.ts noteHead's
// constant and its accepted edge (a >4KB block is somebody's art project).
// Working on the head keeps this from serializing a note carrying a pasted
// blob just to touch its first lines; every change the marker makes lands
// inside (or creates) the block, so the tail is never involved.
const HEAD_BYTES = 4096;

export function toggleTemplateFlag(view: EditorView): void {
  const head = view.state.sliceDoc(0, Math.min(HEAD_BYTES, view.state.doc.length));
  const next = setTemplateMarker(head, !parseFrontmatter(head).params.template);
  if (next === head) return;
  // Replace only the frontmatter region — [0, old block end) becomes the new
  // text's block — so the caret and everything below map through the change
  // instead of the whole document being rewritten under them.
  view.dispatch({
    changes: { from: 0, to: frontmatterEnd(head), insert: next.slice(0, frontmatterEnd(next)) },
  });
}
