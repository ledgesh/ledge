// Styles a note's frontmatter block: visible but quiet.
//
// The block is real note text and stays editable in place — the file is the
// UI, same stance as settings.json — but it is machinery, not prose, so it
// renders dimmed and at one size. The markdown parser knows nothing about
// frontmatter (to it the opening fence is a thematic break and `# comment`
// lines are headings), so the line decorations here also neutralize whatever
// markdown styling lands inside the block: a comment rendered as a giant H1
// would make the quiet block the loudest thing on screen.
//
// Extent comes from shared/frontmatter.ts — the same `frontmatterEnd` the
// params parser and the title logic use, so what gets dimmed is exactly what
// gets parsed, never one line more or less.
import { StateField, type EditorState, type Extension, type Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin } from "@codemirror/view";
import { frontmatterEnd, isProfileName, parseFrontmatter, unquote } from "../../shared/frontmatter";
import { editProfile } from "./bridge";

// Enough of a note to find the block's end — the same cap as everywhere else
// that peeks at a head (bun/notes.ts HEAD_BYTES), with the same accepted edge:
// a block that outgrows it simply stops being recognized, here and in the
// parser alike.
const HEAD_BYTES = 4096;

/**
 * The block's 1-based line span [1, last] in `head` (the fences inclusive),
 * or null when the text does not open with frontmatter. Pure so the mapping
 * from text to lines is testable without an editor.
 */
export function frontmatterLineSpan(head: string): { first: 1; last: number } | null {
  const end = frontmatterEnd(head);
  if (end === 0) return null;
  // Lines are newline counts + 1; `end` sits just past the closing fence's
  // newline (or at text end when it has none), so counting up to end - 1
  // lands on the fence's own line either way.
  let last = 1;
  for (let i = 0; i < end - 1; i += 1) if (head.charCodeAt(i) === 10) last += 1;
  return { first: 1, last };
}

/**
 * The `profile:` value's character span within one block line, or null when
 * the line is not a usable top-level profile line (indented lines belong to
 * `env:`, and a name the parser would refuse is no link — clicking it could
 * only open a file that can never exist). The span covers the raw token,
 * quotes included; `name` is what the click should open. Pure, like
 * frontmatterLineSpan, so the mapping is testable without an editor.
 */
export function profileValueSpan(
  lineText: string,
): { from: number; to: number; name: string } | null {
  const m = /^(profile[ \t]*:[ \t]*)(\S.*?)[ \t]*$/.exec(lineText.replace(/\r$/, ""));
  if (!m) return null;
  const name = unquote(m[2]!);
  if (!isProfileName(name)) return null;
  return { from: m[1]!.length, to: m[1]!.length + m[2]!.length, name };
}

/**
 * The block's EFFECTIVE profile line in `head`: the last usable one, matching
 * the parser's duplicate-keys-last-wins, so the edit button (blocks.ts) always
 * opens the profile the shell would actually get.
 */
export function effectiveProfileLine(
  head: string,
): { lineNumber: number; from: number; to: number; name: string } | null {
  const span = frontmatterLineSpan(head);
  if (!span) return null;
  const lines = head.split("\n");
  let found: { lineNumber: number; from: number; to: number; name: string } | null = null;
  for (let n = span.first + 1; n < span.last; n += 1) {
    const p = profileValueSpan(lines[n - 1] ?? "");
    if (p) found = { lineNumber: n, ...p };
  }
  return found;
}

// Doc-based conveniences over the pure helpers, shared with the overlay layer
// in blocks.ts so its button and these decorations can never disagree about
// where the block is or which profile is live.
export function frontmatterRange(state: EditorState): { from: number; to: number } | null {
  const span = frontmatterLineSpan(state.sliceDoc(0, Math.min(HEAD_BYTES, state.doc.length)));
  return span ? { from: 0, to: state.doc.line(span.last).to } : null;
}

/** Where the edit button anchors: just past the profile value's last glyph. */
export function profileChipAnchor(state: EditorState): { pos: number; name: string } | null {
  const p = effectiveProfileLine(state.sliceDoc(0, Math.min(HEAD_BYTES, state.doc.length)));
  return p ? { pos: state.doc.line(p.lineNumber).from + p.to, name: p.name } : null;
}

/**
 * The hosts this note's `host:` line declares, from the LIVE document — the
 * picker must reflect what is on screen, not the store's debounced last send.
 * (Bun still validates the eventual choice against what it was last SENT,
 * so a pick made inside the autosave window degrades to a warning, never to
 * an undeclared machine.)
 */
export function declaredHosts(state: EditorState): string[] {
  return parseFrontmatter(state.sliceDoc(0, Math.min(HEAD_BYTES, state.doc.length))).params.hosts;
}

const FENCE = Decoration.line({ class: "ledge-fm ledge-fm-fence" });
const BODY = Decoration.line({ class: "ledge-fm" });
// The cursor stays an I-beam whatever this says — WebKit forces it inside the
// editing context (see the .ledge-overlay comment in index.css) — so the
// affordance is the link styling plus this tooltip.
const PROFILE = Decoration.mark({
  class: "ledge-fm-profile",
  attributes: { title: "⌘-click to edit profile" },
});

function build(state: EditorState): DecorationSet {
  const span = frontmatterLineSpan(state.sliceDoc(0, Math.min(HEAD_BYTES, state.doc.length)));
  if (!span) return Decoration.none;
  const ranges: Range<Decoration>[] = [];
  for (let n = span.first; n <= span.last; n += 1) {
    const line = state.doc.line(n);
    ranges.push((n === span.first || n === span.last ? FENCE : BODY).range(line.from));
    if (n !== span.first && n !== span.last) {
      const p = profileValueSpan(line.text);
      if (p) ranges.push(PROFILE.range(line.from + p.from, line.from + p.to));
    }
  }
  return Decoration.set(ranges, true);
}

const field = StateField.define<DecorationSet>({
  create: (state) => build(state),
  update: (deco, tr) => (tr.docChanged ? build(tr.state) : deco),
  provide: (f) => EditorView.decorations.from(f),
});

// ⌘-click on the profile name opens the editor dialog; a PLAIN click must
// stay a caret move (the name is editable text, and click is how you get at
// it). ⌘ is the raw-editor convention for "follow, don't edit" — and note
// CodeMirror's own ⌘-click (add a cursor) still works everywhere else,
// because this handler consumes the event only on the profile token itself.
// Position comes from coordinates and the document, not from the clicked DOM
// span: syntax highlighting can split the marked range into several spans,
// and a fragment's textContent would be a fragment of the name.
const clickToEdit = EditorView.domEventHandlers({
  mousedown: (event, view) => {
    if (!event.metaKey || event.button !== 0) return false;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null) return false;
    const span = frontmatterLineSpan(
      view.state.sliceDoc(0, Math.min(HEAD_BYTES, view.state.doc.length)),
    );
    if (!span) return false;
    const line = view.state.doc.lineAt(pos);
    if (line.number <= span.first || line.number >= span.last) return false;
    const p = profileValueSpan(line.text);
    if (!p || pos < line.from + p.from || pos > line.from + p.to) return false;
    editProfile(p.name);
    return true;
  },
});

// While ⌘ is held, the profile link switches to a solid underline in the
// link color at full strength (index.css .ledge-meta) — live feedback that a
// click right now FOLLOWS instead of edits, since the cursor cannot say so
// (WebKit pins the I-beam). window-level listeners because the editor only
// gets key events while focused, and the ⌘ press this reacts to usually
// starts elsewhere; blur clears the class so ⌘-Tabbing away does not leave
// the link lit.
const metaHeld = ViewPlugin.fromClass(
  class {
    private down = (e: KeyboardEvent) => {
      if (e.key === "Meta") this.view.dom.classList.add("ledge-meta");
    };
    private up = (e: KeyboardEvent) => {
      if (e.key === "Meta") this.view.dom.classList.remove("ledge-meta");
    };
    private clear = () => this.view.dom.classList.remove("ledge-meta");
    constructor(readonly view: EditorView) {
      window.addEventListener("keydown", this.down);
      window.addEventListener("keyup", this.up);
      window.addEventListener("blur", this.clear);
    }
    destroy() {
      window.removeEventListener("keydown", this.down);
      window.removeEventListener("keyup", this.up);
      window.removeEventListener("blur", this.clear);
    }
  },
);

export function ledgeFrontmatter(): Extension {
  return [field, clickToEdit, metaHeld];
}
