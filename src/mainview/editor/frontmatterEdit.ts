// The "Add/Edit Frontmatter" verb's editing arm: put the caret inside the
// note's frontmatter block, creating the block when there is none. The block
// stays hand-edited text (the file is the UI — frontmatter.ts's stance); this
// command only spares the gesture that hurt: scroll to the top, type a fence
// that renders as an hr, type the closing fence, find your way back in. An
// ordinary CodeMirror transaction, templateFlag.ts's reasoning: undoable,
// autosaved, watcher-refreshed like any keystroke.
import { EditorView } from "@codemirror/view";
import { frontmatterEnd } from "../../shared/frontmatter";
import { frontmatterLineSpan } from "./frontmatter";

// Enough of the note to hold its frontmatter block — the HEAD_BYTES cap and
// its accepted edge, shared with every other head-peeker (bun/notes.ts).
const HEAD_BYTES = 4096;

/**
 * What the edit gesture does to a note starting with `head`: optionally an
 * insertion (creating the block, or giving an empty block a body line to
 * land on), and where the caret goes. Offsets are within `head`, which is a
 * prefix of the doc, so they are doc offsets too. Pure, so the three shapes
 * — no block, empty block, block with body — are testable without an editor.
 */
export function frontmatterEditPlan(
  head: string,
): { insert: { at: number; text: string } | null; caret: number } {
  const end = frontmatterEnd(head);
  // No block: open one at the top with an empty body line, caret on it. The
  // trailing newline keeps the note's first content line a line of its own.
  if (end === 0) return { insert: { at: 0, text: "---\n\n---\n" }, caret: 4 };

  const span = frontmatterLineSpan(head)!;
  // Offset where the closing fence's line starts: walk span.last - 1 newlines.
  let closeFrom = 0;
  for (let n = 1; n < span.last; n += 1) closeFrom = head.indexOf("\n", closeFrom) + 1;
  // An empty block (`---` / `---`) has no line to land on: give it one.
  if (span.last === span.first + 1) {
    return { insert: { at: closeFrom, text: "\n" }, caret: closeFrom };
  }
  // A block with a body: caret at the end of its last line, ready to extend.
  return { insert: null, caret: closeFrom - 1 };
}

export function editFrontmatter(view: EditorView): void {
  const head = view.state.sliceDoc(0, Math.min(HEAD_BYTES, view.state.doc.length));
  const plan = frontmatterEditPlan(head);
  view.dispatch({
    changes: plan.insert ? { from: plan.insert.at, insert: plan.insert.text } : [],
    selection: { anchor: plan.caret },
    effects: EditorView.scrollIntoView(plan.caret),
    userEvent: plan.insert ? "input" : "select",
  });
}
