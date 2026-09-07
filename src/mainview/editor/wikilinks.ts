// Wikilinks: `[[Note Title]]` and `[[Note Title#Heading]]` links between notes.
//
// A wikilink addresses a note by its title, not its path. The title is
// resolved live against the note's own workspace list every time the link is
// drawn or followed. Filenames follow the H1 (notes/store.ts syncTitle), so a
// stored path would go stale on every retitle. Keeping such paths current
// would put a grep-and-edit pass over other notes inside Bun's save path. A
// title that matches no note still parses as a link. livePreview.ts draws it
// as dangling, and it edits like plain text.
//
// Everything here stays view-side. Resolution runs against the NoteMeta lists
// the store already holds (from Bun's noteList). Following a link dispatches
// openNote with one of those known paths, so no new path shape crosses the
// RPC (architecture.md §2).
//
// This module holds the CodeMirror seams:
// - `wikiLinkExtension` teaches @lezer/markdown the `[[...]]` inline syntax.
//   It is a real parse node, so concealment, clicks, and reveal reuse the
//   same tree machinery as ordinary links in livePreview.ts.
// - `wikiTargetAt` reports the wikilink at a position, for livePreview.ts's
//   click and Open Link paths.
// - `wikiCompletionSource` is the `[[` picker (phase 2), reading the note
//   list through the editor bridge. `appCompletion` bundles it with the
//   editor's other completion sources.
// The pure decisions, `parseWikiTarget` and `resolveWikiTitle`, moved to
// shared/wikilinks.ts when the MCP server started resolving the same titles
// Bun-side. They are re-exported here so editor code keeps one import for
// wikilinks.
import type { SyntaxNode, Tree } from "@lezer/common";
import type { MarkdownConfig } from "@lezer/markdown";
import { tags } from "@lezer/highlight";
import { syntaxTree } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import type { NoteMeta } from "../../shared/rpc-schema";
import { parseWikiTarget, resolveWikiTitle } from "../../shared/wikilinks";
import { wikiNotes } from "./bridge";
import { frontmatterCompletionSource } from "./frontmatterComplete";
import { sessionIdFacet } from "./session";
import { tagCompletionSource } from "./tags";

export { parseWikiTarget, resolveWikiTitle };

export const WIKILINK_NODE = "WikiLink";

const BRACKET = 91; // [
const CLOSE = 93; // ]
const NEWLINE = 10;

/**
 * The `[[...]]` inline syntax, as a real markdown parse node. Runs before the
 * standard Link parser so the leading `[` is claimed here first. The match is
 * single-line and flat: a newline, a nested `[`, or a missing `]]` leaves the
 * text to the ordinary link machinery, so `[[a](url)` still parses as a
 * bracketed link rather than half a wikilink.
 */
export const wikiLinkExtension: MarkdownConfig = {
  defineNodes: [{ name: WIKILINK_NODE, style: tags.link }],
  parseInline: [
    {
      name: WIKILINK_NODE,
      before: "Link",
      parse(cx, next, pos) {
        if (next !== BRACKET || cx.char(pos + 1) !== BRACKET) return -1;
        for (let i = pos + 2; i < cx.end; i += 1) {
          const ch = cx.char(i);
          if (ch === NEWLINE || ch === BRACKET) return -1;
          if (ch === CLOSE) {
            // `[[]]` stays raw. An empty target names nothing, and a link
            // node here would conceal all four brackets (livePreview.ts), so
            // they would disappear from the note once the caret left them.
            if (cx.char(i + 1) !== CLOSE || i === pos + 2) return -1;
            return cx.addElement(cx.elt(WIKILINK_NODE, pos, i + 2));
          }
        }
        return -1;
      },
    },
  ],
};

// Whether the `[[...]]` grammar can express this title. A bracket would end
// or break the link, and a `#` would read as a heading anchor. A note whose
// title falls outside the grammar does not appear in the picker, and no
// wikilink can name it.
function linkableTitle(title: string): boolean {
  return title.trim() !== "" && !/[\[\]#]/.test(title);
}

/**
 * The wikilink a follow-the-link gesture at `pos` addresses, or null. Returns
 * its span (the reveal unit) and its inner target text. Mirrors livePreview.ts
 * `linkAt`: it resolves through the tree from both sides of `pos`, so a caret
 * at either edge of a link still counts as on it.
 */
export function wikiTargetAt(
  doc: { sliceString(from: number, to: number): string },
  tree: Tree,
  pos: number,
): { from: number; to: number; target: string } | null {
  for (const side of [-1, 1] as const) {
    for (let n: SyntaxNode | null = tree.resolveInner(pos, side); n; n = n.parent) {
      if (n.name === WIKILINK_NODE) {
        return { from: n.from, to: n.to, target: doc.sliceString(n.from + 2, n.to - 2) };
      }
    }
  }
  return null;
}

// --- The `[[` picker ---------------------------------------------------------

// Insert the picked title and close the brackets. When the `]]` is already in
// the document (a half-typed link being corrected), the insert is the title
// alone and the caret steps past those brackets. Either way the caret lands
// after the completed link.
function applyWiki(view: EditorView, completion: Completion, from: number, to: number): void {
  const closed = view.state.sliceDoc(to, to + 2) === "]]";
  view.dispatch({
    changes: { from, to, insert: completion.label + (closed ? "" : "]]") },
    selection: { anchor: from + completion.label.length + 2 },
    userEvent: "input.complete",
  });
}

/**
 * Completion source for `[[`: every linkable note title in this note's own
 * workspace, read through the bridge (the same list clicks resolve against).
 * Returns null inside a code node. The parser above makes no wikilink there
 * either.
 */
export function wikiCompletionSource(context: CompletionContext): CompletionResult | null {
  const m = context.matchBefore(/\[\[[^\[\]]*/);
  if (!m) return null;
  for (
    let n: SyntaxNode | null = syntaxTree(context.state).resolveInner(context.pos, -1);
    n;
    n = n.parent
  ) {
    if (n.name.includes("Code")) return null;
  }
  const notes = wikiNotes(context.state.facet(sessionIdFacet));
  const options: Completion[] = [];
  for (const n of notes) {
    if (linkableTitle(n.title)) options.push({ label: n.title, apply: applyWiki });
  }
  if (options.length === 0) return null;
  return { from: m.from + 2, options, validFor: /^[^\[\]]*$/ };
}

/** The app's completions as one editor extension: the `[[` note picker, the
 * `#` tag picker (editor/tags.ts), and the frontmatter block's keys and values
 * (editor/frontmatterComplete.ts). One `autocompletion()` holds every source
 * in its `override`. A second instance would race this one, and `override`
 * keeps language-provided completions from popping. A new source joins this
 * array rather than adding another autocompletion(). */
export function appCompletion(): Extension {
  return autocompletion({
    override: [frontmatterCompletionSource, wikiCompletionSource, tagCompletionSource],
    icons: false,
  });
}
