// The CodeMirror half of tags: the `#tag` parse node, the caret/click lookup,
// and the `#` completion. The grammar itself lives in shared/tags.ts (and
// isTagToken in shared/frontmatter.ts) — this module teaches the editor's
// markdown parser the same rule so a tag that styles here is exactly one the
// Bun-side scan would count: `#` at start-of-line or after whitespace, then
// tag characters, at least one letter or `_`. A real parse node rather than a
// decoration-time scan for the wikilink reasons: it composes with the tested
// concealments core, it is selection-aware, it never fires inside code
// (inline parsers do not run there), and it gives tagAt for the click and
// command paths — the wikiTargetAt seams exactly.
import type { MarkdownConfig } from "@lezer/markdown";
import type { SyntaxNode, Tree } from "@lezer/common";
import { syntaxTree } from "@codemirror/language";
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { isTagToken } from "../../shared/frontmatter";
import { workspaceTags } from "./bridge";
import { sessionIdFacet } from "./session";

export const HASHTAG_NODE = "HashTag";

const HASH = 35; // "#"

// The token, shared/tags.ts INLINE_TAG's charset — the letter-or-underscore
// requirement is isTagToken's, applied after, so the grammars cannot drift.
const TAG_TOKEN = /^#([\p{L}\p{N}_/-]+)/u;

/**
 * The `#tag` inline syntax as a real markdown parse node. The boundary rule
 * is positional (start of the inline content, or after whitespace), which is
 * what kills URL fragments and `##tag`; `# Title` never reaches here as a
 * tag because a space is not a tag character. No `style:` — the conceal
 * pipeline's mark is the one styling authority, and tags are emitted always
 * (nothing conceals), so a highlight color would just double up.
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
          // A surrogate half fails the test too, correctly: an astral glyph
          // before the # is a glued word, not a boundary.
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
 * The tag a gesture at `pos` addresses — its span and the tag text (no `#`)
 * — or null. Mirrors wikiTargetAt: resolved from both sides so a caret at
 * either edge counts.
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
 * Completion source for `#`: the workspace's own tags (the same directory
 * the Tags panel lists, via the bridge). Implicit only once a tag character
 * follows the `#` — a bare `#` is how headings start, and popping there
 * would harass every heading typed. Inactive inside code, and inactive off a
 * tag boundary, by the parse node's own rules.
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
