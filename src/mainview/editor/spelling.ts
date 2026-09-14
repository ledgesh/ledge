// Spell checking in a note (interactions.md §12).
//
// WebKit does the checking: the window turns on continuous spell checking
// (bun/index.ts) and the editor's content carries `spellcheck="true"`. WebKit
// honours `spellcheck="false"` on any element inside the editable region, so
// this module marks the text that is not prose: code, URLs, HTML, the
// frontmatter block, and the names wikilinks and tags refer to. Nothing here
// decides whether a word is spelled right: the right-click menu asks this
// device's dictionary through configureSpelling below.
import type { EditorState, Extension, Range } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { Tree } from "@lezer/common";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { frontmatterEnd } from "../../shared/frontmatter";
import { HASHTAG_NODE } from "./tags";
import { WIKILINK_NODE } from "./wikilinks";

// Nodes whose text is never prose. The block ones take whole lines, so a
// fence's marks and language are covered along with its body.
const BLOCK_NODES = new Set(["FencedCode", "CodeBlock", "HTMLBlock", "CommentBlock", "ProcessingInstructionBlock"]);
const INLINE_NODES = new Set([
  "InlineCode",
  "URL",
  "Autolink",
  "HTMLTag",
  "Comment",
  "ProcessingInstruction",
  "LinkLabel",
  WIKILINK_NODE,
  HASHTAG_NODE,
]);

/** A range spell checking skips. `block` spans are whole lines. */
export interface Unchecked {
  from: number;
  to: number;
  block: boolean;
}

// How much of a note to read for its frontmatter: frontmatter.ts HEAD_BYTES.
export const HEAD_CHARS = 4096;

/**
 * The ranges spell checking skips between `from` and `to`, in document order.
 * `head` is the note's opening text (HEAD_CHARS of it is enough). The
 * frontmatter block comes from `frontmatterEnd`, the parser's own measure,
 * because the markdown tree reads it as a rule and headings. Pure over the
 * text and its tree, so it is testable without a DOM.
 */
export function uncheckedRanges(head: string, tree: Tree, from: number, to: number): Unchecked[] {
  const out: Unchecked[] = [];
  const fmEnd = frontmatterEnd(head);
  if (fmEnd > 0 && from < fmEnd) out.push({ from: 0, to: fmEnd, block: true });
  tree.iterate({
    from,
    to,
    enter: (node) => {
      if (node.to <= fmEnd) return false;
      if (BLOCK_NODES.has(node.name)) {
        out.push({ from: node.from, to: node.to, block: true });
        return false;
      }
      if (INLINE_NODES.has(node.name)) {
        out.push({ from: node.from, to: node.to, block: false });
        return false;
      }
      return undefined;
    },
  });
  return out;
}

/** Whether `pos` sits in text spell checking skips. The right-click asks this
 * before it looks a word up, so a menu opened in a fence offers no spelling. */
export function isUnchecked(head: string, tree: Tree, pos: number): boolean {
  return uncheckedRanges(head, tree, pos, pos).some((r) => pos >= r.from && pos <= r.to);
}

// A word, with apostrophes and hyphens inside it ("don't", "e-mail"). The
// same shape bun/spelling.ts accepts.
const WORD = /\p{L}+(?:['’-]\p{L}+)*/gu;

/** The word in `text` that `offset` touches, its end included, so a click just
 * past the last letter still names the word. Null off a word. */
export function wordAround(text: string, offset: number): { from: number; to: number; word: string } | null {
  for (const m of text.matchAll(WORD)) {
    const from = m.index;
    const to = from + m[0].length;
    if (offset >= from && offset <= to) return { from, to, word: m[0] };
    if (from > offset) break;
  }
  return null;
}

/** A word the right-click menu may look up: document positions, the word,
 * and its line as the context the dictionary reads a language from. */
export interface SpellableWord {
  from: number;
  to: number;
  word: string;
  context: string;
}

/** The word at `pos` when it sits in checked text, else null. */
export function spellableWordAt(state: EditorState, pos: number): SpellableWord | null {
  if (isUnchecked(state.sliceDoc(0, HEAD_CHARS), syntaxTree(state), pos)) return null;
  const line = state.doc.lineAt(pos);
  const hit = wordAround(line.text, pos - line.from);
  if (!hit) return null;
  return { from: line.from + hit.from, to: line.from + hit.to, word: hit.word, context: line.text };
}

/** A misspelled word and what the dictionary would put in its place. */
export interface Misspelling extends SpellableWord {
  guesses: string[];
}

interface SpellingSeam {
  check(word: string, context: string): Promise<{ misspelled: boolean; guesses: string[] }>;
  learn(word: string): Promise<boolean>;
}

let seam: SpellingSeam | null = null;

/** Binds the dictionary to this client's shell (boot.tsx). */
export function configureSpelling(fns: SpellingSeam): void {
  seam = fns;
}

// How long the menu waits for the dictionary before it opens without it. A
// warm lookup takes about 70ms and a cold one about 200ms (bun/spelling.ts).
const LOOKUP_MS = 400;

/** The misspelling at `word`, or null when it is spelled right, when there is
 * no dictionary, and when the lookup is slower than LOOKUP_MS. */
export async function lookUpWord(word: SpellableWord): Promise<Misspelling | null> {
  if (!seam) return null;
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), LOOKUP_MS));
  const answer = seam.check(word.word, word.context).then(
    (r) => (r.misspelled ? { ...word, guesses: r.guesses } : null),
    () => null,
  );
  return Promise.race([answer, timeout]);
}

/**
 * Replaces the misspelled word with `guess`, when the text there is still that
 * word. The menu stays open over a live document, so an autosave's reload or a
 * second pane's edit can move the word before the item is chosen.
 */
export function replaceWord(view: EditorView, from: number, to: number, word: string, guess: string): boolean {
  if (view.state.sliceDoc(from, to) !== word) return false;
  view.dispatch({ changes: { from, to, insert: guess }, selection: { anchor: from + guess.length }, userEvent: "input.spelling" });
  return true;
}

/**
 * Adds the word to the dictionary. WebKit keeps a squiggle it has drawn until
 * it checks that text again, so the editor's content is switched out of spell
 * checking and back, which has it check again.
 */
export async function learnWord(view: EditorView, word: string): Promise<void> {
  if (!seam || !(await seam.learn(word))) return;
  view.contentDOM.spellcheck = false;
  requestAnimationFrame(() => {
    view.contentDOM.spellcheck = true;
  });
}

const skipLine = Decoration.line({ attributes: { spellcheck: "false" } });
const skipMark = Decoration.mark({ attributes: { spellcheck: "false" } });

function decorations(view: EditorView): DecorationSet {
  const { state } = view;
  const head = state.sliceDoc(0, HEAD_CHARS);
  const tree = syntaxTree(state);
  const ranges: Range<Decoration>[] = [];
  for (const vis of view.visibleRanges) {
    for (const r of uncheckedRanges(head, tree, vis.from, vis.to)) {
      if (!r.block) {
        if (r.to > r.from) ranges.push(skipMark.range(r.from, r.to));
        continue;
      }
      // A block span's last position can be the start of the next line (the
      // frontmatter's end sits past its closing newline), and that line is prose.
      const last = state.doc.lineAt(Math.max(r.from, r.to - 1));
      for (let pos = Math.max(r.from, vis.from); pos <= Math.min(last.from, vis.to); ) {
        const line = state.doc.lineAt(pos);
        ranges.push(skipLine.range(line.from));
        pos = line.to + 1;
      }
    }
  }
  return Decoration.set(ranges, true);
}

/** The editor's half of spell checking. Absent on a read-only page, where
 * nobody can fix a word, on a phone (ios.md §7), and with the
 * editor.spellCheck setting off. */
export function spelling(): Extension {
  return [
    EditorView.contentAttributes.of({ spellcheck: "true", autocorrect: "off", autocapitalize: "off" }),
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
          this.decorations = decorations(view);
        }
        update(u: ViewUpdate) {
          if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
            this.decorations = decorations(u.view);
          }
        }
      },
      { decorations: (v) => v.decorations },
    ),
  ];
}
