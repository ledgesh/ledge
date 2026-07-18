// Wikilinks: `[[Note Title]]` / `[[Note Title#Heading]]` links BETWEEN notes.
//
// Internal links address a note by its TITLE, not its path, resolved live
// against the note's own workspace list every time they are drawn or
// followed. That is a deliberate answer to rename churn: filenames follow the
// H1 (notes/store.ts syncTitle), so a stored path would rot on every retitle,
// and rewriting other notes' bytes to compensate would put a grep-and-edit
// pass inside Bun's save path. A title resolves or it doesn't, visibly — a
// dangling link is styled as such and edits like plain text.
//
// Everything here stays view-side: resolution runs against NoteMeta lists the
// store already holds (handed out by Bun's noteList), and following a link
// dispatches openNote with one of those known paths. No new path shape ever
// crosses the RPC (architecture.md §2).
//
// This module is the CodeMirror seams:
// - `wikiLinkExtension` teaches @lezer/markdown the `[[...]]` inline syntax
//   (a real parse node, so concealment/click/reveal reuse the same tree
//   machinery as ordinary links in livePreview.ts);
// - `wikiCompletionSource` is the `[[` picker (phase 2), reading the note
//   list through the editor bridge.
// The pure decisions — `parseWikiTarget` / `resolveWikiTitle` — moved to
// shared/wikilinks.ts when the MCP server started resolving the same titles
// Bun-side; re-exported here so editor code keeps one import for wikilinks.
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
import { sessionIdFacet } from "./session";

export { parseWikiTarget, resolveWikiTitle };

export const WIKILINK_NODE = "WikiLink";

const BRACKET = 91; // [
const CLOSE = 93; // ]
const NEWLINE = 10;

/**
 * The `[[...]]` inline syntax, as a real markdown parse node. Runs before the
 * standard Link parser so the leading `[` is claimed here first. Single-line
 * and flat by design: a newline, a nested `[`, or a missing `]]` leaves the
 * text to the ordinary link machinery (`[[a](url)` must still parse as a
 * bracketed link, not half a wikilink).
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
            // `[[]]` stays raw: an empty target names nothing, and eating it
            // would make typing `[[` feel like the editor swallowed a key.
            if (cx.char(i + 1) !== CLOSE || i === pos + 2) return -1;
            return cx.addElement(cx.elt(WIKILINK_NODE, pos, i + 2));
          }
        }
        return -1;
      },
    },
  ],
};

// A title the `[[...]]` grammar can actually express: brackets would end (or
// break) the link, `#` would read as an anchor. Notes named outside the
// grammar simply don't appear in the picker — linking them is what the
// grammar cannot say.
function linkableTitle(title: string): boolean {
  return title.trim() !== "" && !/[\[\]#]/.test(title);
}

/**
 * The wikilink a follow-the-link gesture at `pos` addresses — its span (the
 * reveal unit) and inner target text — or null. Mirrors livePreview.ts
 * `linkAt`: resolved from both sides so a caret at either edge counts.
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

// Insert the picked title and close the brackets — unless the user already
// typed the `]]` (half-typed link being corrected), in which case just step
// past them. Either way the caret lands after the completed link.
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
 * workspace (the same list clicks resolve against, via the bridge). Inactive
 * inside code — a `[[` in a fence is code, and the parser above will not make
 * a link of it either.
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

/** The `[[` picker as an editor extension. `override` because this is the
 * app's only completion source: nothing language-provided should ever pop. */
export function wikiCompletion(): Extension {
  return autocompletion({ override: [wikiCompletionSource], icons: false });
}
