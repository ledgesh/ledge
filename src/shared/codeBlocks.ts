// Every fenced code block in a note's text, read with the same Lezer markdown
// parser the editor uses, so `ledge run` and the app's run buttons agree on
// where each block starts and ends (interactions.md §9). The view reads its
// blocks off its own syntax tree (editor/blocks.ts); this is the same reading
// for a caller with only the text.
import { GFM, parser } from "@lezer/markdown";
import { fenceCloser, fenceOpener, parseFenceInfo } from "./fenceInfo";

/** One fenced block, located by the 1-based line of its opening fence. */
export interface CodeBlock {
  line: number;
  lang: string | null;
  attrs: Map<string, string>;
  code: string;
  // Whether a closing fence ends the block. An unclosed block never runs
  // (interactions.md §4c).
  closed: boolean;
}

const markdown = parser.configure(GFM);

/** The fenced blocks in `text`, in document order. */
export function codeBlocksOf(text: string): CodeBlock[] {
  const doc = text.replace(/\r\n?/g, "\n");
  const lines = doc.split("\n");
  const starts: number[] = [];
  let at = 0;
  for (const l of lines) {
    starts.push(at);
    at += l.length + 1;
  }
  // The 0-based line holding offset `pos`.
  const lineOf = (pos: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  const out: CodeBlock[] = [];
  markdown.parse(doc).iterate({
    enter(node) {
      if (node.name !== "FencedCode") return;
      const open = lineOf(node.from);
      const end = lineOf(Math.min(node.to, doc.length));
      // The same closed test and body slice as editor/blocks.ts readBlock:
      // Lezer ends an unclosed block on its last body line, so the closer is
      // read off the text.
      const f = fenceOpener(lines[open]!);
      const closed = end > open && !!f && fenceCloser(lines[end]!, f.marker);
      const lastBody = closed ? end - 1 : end;
      const info = parseFenceInfo(lines[open]!);
      out.push({
        line: open + 1,
        lang: info.lang,
        attrs: info.attrs,
        code: lastBody > open ? lines.slice(open + 1, lastBody + 1).join("\n") : "",
        closed,
      });
      return false;
    },
  });
  return out;
}
