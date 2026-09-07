// Styles a note's frontmatter block. The block is dimmed and set at one
// size, and stays ordinary editable text (the file-is-the-UI stance
// settings.jsonc takes, architecture.md §6).
//
// The markdown parser knows nothing about frontmatter: it reads the opening
// fence as a thematic break and `# comment` lines as headings. The line
// decorations here override that styling, so a comment does not render as an
// H1 inside the quiet block.
//
// The extent comes from `frontmatterEnd` in shared/frontmatter.ts, the same
// function the params parser and the title logic use. What gets dimmed is
// what gets parsed, never one line more or less.
//
// The decorations below also draw what the parser refused: an unknown key, a
// name that could never reach a shell, a token that is not a tag. Each
// message is drawn beside the line it was refused on, and the report is
// advisory (architecture.md §6a): it blocks no keystroke, no save, and no
// spawn. A half-typed line is wrong until it is finished, so the message
// stays quiet enough to write through.
import { StateField, type EditorState, type Extension, type Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  WidgetType,
} from "@codemirror/view";
import {
  frontmatterEnd,
  isProfileName,
  isTagToken,
  parseFrontmatter,
  unbracket,
  unquote,
} from "../../shared/frontmatter";
import { editProfile, openTag } from "./bridge";
import { sessionIdFacet } from "./session";

// How much of a note to read to find the block's end. The same cap as
// everywhere else that peeks at a head (bun/notes.ts HEAD_BYTES), and the
// same accepted consequence: a block that outgrows it stops being
// recognized, here and in the parser alike.
const HEAD_BYTES = 4096;

/**
 * The block's 1-based line span [1, last] in `head` (the fences inclusive),
 * or null when the text does not open with frontmatter. Pure so the mapping
 * from text to lines is testable without an editor.
 */
export function frontmatterLineSpan(head: string): { first: 1; last: number } | null {
  const end = frontmatterEnd(head);
  if (end === 0) return null;
  // A line number is the newline count plus 1. `end` sits just past the
  // closing fence's newline, or at text end when it has none, so counting up
  // to end - 1 lands on the fence's own line either way.
  let last = 1;
  for (let i = 0; i < end - 1; i += 1) if (head.charCodeAt(i) === 10) last += 1;
  return { first: 1, last };
}

/**
 * The `profile:` value's character span within one block line, or null when
 * the line is not a usable top-level profile line: indented lines belong to
 * `env:`, and a name the parser would refuse is no link (clicking it could
 * only open a file that cannot exist). The span covers the raw token, quotes
 * included; `name` is what the click opens. Pure, like frontmatterLineSpan.
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
 * The `tags:` value's per-token character spans within one block line, the
 * multi-token sibling of profileValueSpan. Only tokens the parser would
 * accept get a span, and each carries the tag the click shows, with a leading
 * `#` stripped. Brackets come off by the parser's own rule (unbracket), so
 * the tokens in `tags: [a, b]` get spans too. A wholly quoted list
 * (`tags: "a b"`) yields no spans: the quotes stay on the outer tokens and
 * fail isTagToken. parseFrontmatter unquotes the value first, so those tags
 * still parse. Pure, like its sibling.
 */
export function tagsValueSpans(lineText: string): { from: number; to: number; tag: string }[] {
  const m = /^(tags[ \t]*:[ \t]*)(\S.*?)[ \t]*$/.exec(lineText.replace(/\r$/, ""));
  if (!m) return [];
  // The spans are the line's, not `inner`'s. When a "[" is stripped, every
  // token sits one column further right on the line than it does in `inner`,
  // so base adds that column back.
  const inner = unbracket(m[2]!);
  const base = m[1]!.length + (inner === m[2]! ? 0 : 1);
  const out: { from: number; to: number; tag: string }[] = [];
  for (const tok of inner.matchAll(/[^,\s]+/g)) {
    const raw = tok[0]!;
    const tag = raw.startsWith("#") ? raw.slice(1) : raw;
    if (!isTagToken(tag)) continue;
    out.push({ from: base + tok.index!, to: base + tok.index! + raw.length, tag });
  }
  return out;
}

/**
 * The block's effective profile line in `head`: the last usable one. That
 * matches the parser, where a repeated key's last value wins, so the edit
 * button (blocks.ts) opens the profile the shell would actually get.
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

// Document-based conveniences over the pure helpers, shared with the overlay
// layer in blocks.ts so its button and these decorations cannot disagree
// about where the block is or which profile is live.
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
 * The hosts this note's `host:` line declares, read from the live document.
 * The picker has to show what is on screen, not the store's debounced last
 * send. Bun still validates the eventual choice against the params it was
 * last sent (resolveHost in bun/server.ts), so a pick made inside the
 * autosave window falls back with a warning, never to an undeclared machine.
 */
export function declaredHosts(state: EditorState): string[] {
  return parseFrontmatter(state.sliceDoc(0, Math.min(HEAD_BYTES, state.doc.length))).params.hosts;
}

const FENCE = Decoration.line({ class: "ledge-fm ledge-fm-fence" });
const BODY = Decoration.line({ class: "ledge-fm" });
// The cursor stays an I-beam whatever this says: WebKit forces it inside the
// editing context (see the .ledge-overlay comment in index.css). The
// affordance is the link styling plus this tooltip.
const PROFILE = Decoration.mark({
  class: "ledge-fm-profile",
  attributes: { title: "⌘-click to edit profile" },
});
// A declared tag, ⌘-clickable like the profile name, under the same grammar:
// ⌘-click follows, a plain click edits. The click lands where every tag click
// lands, the Tags panel.
const FM_TAG = Decoration.mark({
  class: "ledge-fm-tag",
  attributes: { title: "⌘-click to show tagged notes" },
});
// The line the parser refused, accented down its left edge (index.css). On a
// narrow window the accent is what ties the message below to its own line.
const PROBLEM = Decoration.line({ class: "ledge-fm ledge-fm-bad" });

// What the parser could not read, drawn at the end of its own line. A widget
// rather than the `title` tooltip the two marks above use: a message found
// only by hovering is barely louder than the silence it replaces, and a touch
// client has no hover to find it with. `ignoreEvent` keeps clicks and
// selection out, so the block stays ordinary editable text with something
// written in the margin.
class ProblemWidget extends WidgetType {
  constructor(readonly message: string) {
    super();
  }
  eq(other: ProblemWidget) {
    return other.message === this.message;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "ledge-fm-problem";
    el.textContent = this.message;
    // Decorative. The line's own text carries the content, and a screen
    // reader walking the document should not read this annotation as though
    // the writer had typed it.
    el.setAttribute("aria-hidden", "true");
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

function build(state: EditorState): DecorationSet {
  const head = state.sliceDoc(0, Math.min(HEAD_BYTES, state.doc.length));
  const span = frontmatterLineSpan(head);
  if (!span) return Decoration.none;
  // Every problem on a line, in the parser's own order. One line can be wrong
  // more than once (`tags: 123 456` is two refusals), so the map keys by line
  // and the widget shows them all rather than only the first.
  const byLine = new Map<number, string[]>();
  for (const p of parseFrontmatter(head).problems) {
    const at = byLine.get(p.line);
    if (at) at.push(p.message);
    else byLine.set(p.line, [p.message]);
  }
  const ranges: Range<Decoration>[] = [];
  for (let n = span.first; n <= span.last; n += 1) {
    const line = state.doc.line(n);
    const bad = byLine.get(n);
    ranges.push(
      (n === span.first || n === span.last ? FENCE : bad ? PROBLEM : BODY).range(line.from),
    );
    if (n !== span.first && n !== span.last) {
      const p = profileValueSpan(line.text);
      if (p) ranges.push(PROFILE.range(line.from + p.from, line.from + p.to));
      for (const t of tagsValueSpans(line.text)) {
        ranges.push(FM_TAG.range(line.from + t.from, line.from + t.to));
      }
      // side: 1 pins the widget after everything else at the line's end, so
      // the caret at end-of-line still sits before it and typing continues
      // the line rather than appearing to start past the message.
      if (bad) {
        ranges.push(
          Decoration.widget({ widget: new ProblemWidget(bad.join(" · ")), side: 1 }).range(line.to),
        );
      }
    }
  }
  return Decoration.set(ranges, true);
}

const field = StateField.define<DecorationSet>({
  create: (state) => build(state),
  update: (deco, tr) => (tr.docChanged ? build(tr.state) : deco),
  provide: (f) => EditorView.decorations.from(f),
});

// ⌘-click on the profile name opens the editor dialog. A plain click stays a
// caret move: the name is editable text, and ⌘ is the raw-editor convention
// for following rather than editing. The handler consumes the event on the
// profile and tag tokens only, so CodeMirror's own ⌘-click (add a cursor)
// still works elsewhere. The position comes from the coordinates and the
// document, not from the clicked DOM span, which syntax highlighting can
// split into fragments of the name.
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
    if (p && pos >= line.from + p.from && pos <= line.from + p.to) {
      editProfile(p.name);
      return true;
    }
    // The tags: line's tokens follow the same grammar: ⌘-click follows (to
    // the Tags panel), plain click edits.
    for (const t of tagsValueSpans(line.text)) {
      if (pos >= line.from + t.from && pos <= line.from + t.to) {
        openTag(view.state.facet(sessionIdFacet), t.tag);
        return true;
      }
    }
    return false;
  },
});

// While ⌘ is held, the profile and tag links' underlines go solid (index.css
// .ledge-meta). That shows a click now would follow rather than edit. The
// cursor cannot show it: WebKit pins the I-beam. The listeners sit on window
// because the editor gets key events only while focused, and the ⌘ press
// usually starts elsewhere. Blur clears the class, so ⌘-Tabbing away does not
// leave the link lit.
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
