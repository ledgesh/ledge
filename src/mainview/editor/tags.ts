// The CodeMirror half of tags: the `#tag` parse node, the caret/click lookup,
// and the `#` completion. The grammar lives in shared/tags.ts, its
// letter-or-underscore rule in isTagToken (shared/frontmatter.ts). The parse
// node below repeats that rule. A tag the editor styles is exactly one the
// Bun-side scan counts: `#` at start of line or after whitespace, then tag
// characters, at least one letter or `_`.
// The tag is a parse node, not a decoration-time scan. It composes with the
// tested concealments core in livePreview.ts, and it is selection-aware.
// Inline parsers do not run inside code, so it never fires there. tagAt reads
// the node for the click and command paths, as wikiTargetAt reads a wikilink.
import type { MarkdownConfig } from "@lezer/markdown";
import type { SyntaxNode, Tree } from "@lezer/common";
import { syntaxTree } from "@codemirror/language";
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { isTagToken } from "../../shared/frontmatter";
import { workspaceTags } from "./bridge";
import { sessionIdFacet } from "./session";

export const HASHTAG_NODE = "HashTag";

const HASH = 35; // "#"

// The token, over the same charset as INLINE_TAG in shared/tags.ts. isTagToken
// applies the letter-or-underscore requirement afterwards, so the two grammars
// cannot drift.
const TAG_TOKEN = /^#([\p{L}\p{N}_/-]+)/u;

/**
 * The `#tag` inline syntax as a real markdown parse node. The boundary rule
 * is positional: the `#` starts the inline content or follows whitespace,
 * which excludes URL fragments and `##tag`. A heading's `#` never reaches
 * this parser at all, since @lezer/markdown takes it at block level, so
 * `# Title` stays a heading. No `style:` here: livePreview.ts emits the tag
 * span whether or not the selection touches it, conceals no tag, and marks
 * every span it emits, so a color set here would double up with that mark.
 */
export const hashtagExtension: MarkdownConfig = {
  defineNodes: [{ name: HASHTAG_NODE }],
  parseInline: [
    {
      name: HASHTAG_NODE,
      parse(cx, next, pos) {
        if (next !== HASH) return -1;
        if (pos > cx.offset) {
          const prev = cx.char(pos - 1);
          // A lone surrogate half is not whitespace, so an astral character
          // before the `#` blocks the tag like any other non-space character.
          if (!/\s/.test(String.fromCharCode(prev))) return -1;
        }
        const m = TAG_TOKEN.exec(cx.slice(pos, cx.end));
        if (!m || !isTagToken(m[1]!)) return -1;
        return cx.addElement(cx.elt(HASHTAG_NODE, pos, pos + m[0]!.length));
      },
    },
  ],
};

/**
 * The tag a gesture at `pos` addresses, or null. Returns the span and the tag
 * text without the leading `#`. Resolves from both sides, so a caret at
 * either edge of the tag counts, as wikiTargetAt does.
 */
export function tagAt(
  doc: { sliceString(from: number, to: number): string },
  tree: Tree,
  pos: number,
): { from: number; to: number; tag: string } | null {
  for (const side of [-1, 1] as const) {
    for (let n: SyntaxNode | null = tree.resolveInner(pos, side); n; n = n.parent) {
      if (n.name === HASHTAG_NODE) {
        return { from: n.from, to: n.to, tag: doc.sliceString(n.from + 1, n.to) };
      }
    }
  }
  return null;
}

/**
 * Completion source for `#`: the workspace's own tags, the same directory the
 * Tags panel lists, read through the bridge. A bare `#` returns null unless
 * completion was asked for explicitly. `#` also starts a heading, and the list
 * would otherwise pop on every heading typed. It returns null inside a node
 * whose name contains "Code" too, and when the character before the `#` is
 * neither whitespace nor the start of the document.
 */
export function tagCompletionSource(context: CompletionContext): CompletionResult | null {
  const m = context.matchBefore(/#[\p{L}\p{N}_/-]*/u);
  if (!m) return null;
  if (m.to - m.from === 1 && !context.explicit) return null;
  const prev = m.from > 0 ? context.state.sliceDoc(m.from - 1, m.from) : "";
  if (prev !== "" && !/\s/.test(prev)) return null;
  for (
    let n: SyntaxNode | null = syntaxTree(context.state).resolveInner(context.pos, -1);
    n;
    n = n.parent
  ) {
    if (n.name.includes("Code")) return null;
  }
  const infos = workspaceTags(context.state.facet(sessionIdFacet));
  if (infos.length === 0) return null;
  const options: Completion[] = infos.map((t) => ({
    label: `#${t.tag}`,
    detail: String(t.count),
  }));
  return { from: m.from, options, validFor: /^#[\p{L}\p{N}_/-]*$/u };
}
