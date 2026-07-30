// Rich text pasted as Markdown: what ⌘V does when the pasteboard carries an
// HTML flavor beside its plain text.
//
// Every app that copies formatted text — a browser, Mail, Slack, Notion, Google
// Docs — puts two renditions on the pasteboard: `public.html` and a plain-text
// fallback that has already thrown the formatting away. Pasting the fallback
// into a Markdown note loses exactly the structure Markdown can hold: a
// bulleted list arrives as unmarked lines, a heading as a bare sentence, a link
// as its label with the URL gone. So the HTML is translated here instead, the
// way Obsidian and every other Markdown editor does it.
//
// **The plain text still wins whenever the HTML carries no formatting to
// translate.** That is not a fallback, it is the rule that makes this safe: a
// copy out of a terminal, VS Code, or DevTools also puts HTML on the
// pasteboard, but it is span-and-div soup holding nothing but colors — and a
// naive walk turns its one-div-per-line shape into double-spaced paragraphs,
// wrecking the most common paste in a developer's notebook. `hasFormatting` is
// that gate; `richPasteMarkdown` is the whole policy, and it also declines when
// the conversion would say what the plain text already said.
//
// Split per testing.md §2: everything above `--- The DOM wrapper` is the pure
// core over a plain node tree (`PasteNode`), tested with hand-built trees; the
// wrapper is DOMParser plus one call into it. The core deliberately does not
// parse HTML itself — DOMParser is right there and hardened, and a second
// parser with its own opinions about entities and implied end tags would be a
// liability, not a test convenience.
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { frontmatterRange } from "./frontmatter";

/**
 * The pasteboard HTML as the core sees it: elements with lower-cased tags and
 * attribute names, and text. Comments, CDATA and processing instructions never
 * arrive — the wrapper drops them.
 */
export type PasteNode =
  | { text: string }
  | { tag: string; attrs: Record<string, string>; children: PasteNode[] };

type El = Extract<PasteNode, { tag: string }>;

function isEl(node: PasteNode): node is El {
  return "tag" in node;
}

// Elements carrying no prose: their subtree is dropped whole. Media and
// controls are here because their text (a `<select>`'s options, a `<video>`'s
// fallback) is chrome, not content — and `<style>` text pasted as prose is the
// classic rich-paste bug.
const DROP = new Set([
  "script",
  "style",
  "head",
  "meta",
  "link",
  "title",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "object",
  "embed",
  "source",
  "track",
  "video",
  "audio",
  "select",
  "option",
  "optgroup",
  "textarea",
  "colgroup",
  "col",
]);

// Containers with no Markdown of their own: their children are laid out as
// blocks in place.
const TRANSPARENT_BLOCK = new Set([
  "html",
  "body",
  "div",
  "section",
  "article",
  "main",
  "header",
  "footer",
  "aside",
  "nav",
  "figure",
  "figcaption",
  "address",
  "details",
  "summary",
  "fieldset",
  "legend",
  "center",
  "hgroup",
  "dl",
  "dt",
  "dd",
  "caption",
  "form",
  "p",
]);

// A `<div>` is a line box, not a paragraph: browsers draw `<div>a</div>
// <div>b</div>` as two lines and `<p>a</p><p>b</p>` with space between them.
// Markdown can say both, so it says both — a div's inline content joins the
// next div's with ONE newline. This is what keeps a copied stack of lines
// (Slack's DOM, a diff, a terminal selection) from arriving double-spaced.
const LINE_BLOCK = new Set(["div"]);

const HEADING = /^h([1-6])$/;

// Everything that ends the paragraph being accumulated. `br` is absent on
// purpose: it is a line break inside one.
function isBlock(tag: string): boolean {
  return (
    TRANSPARENT_BLOCK.has(tag) ||
    HEADING.test(tag) ||
    tag === "ul" ||
    tag === "ol" ||
    tag === "li" ||
    tag === "blockquote" ||
    tag === "pre" ||
    tag === "hr" ||
    tag === "table" ||
    tag === "thead" ||
    tag === "tbody" ||
    tag === "tfoot" ||
    tag === "tr" ||
    tag === "th" ||
    tag === "td"
  );
}

// Elements that mean formatting Markdown can carry. HTML holding none of them
// is not rich text, whatever its styling says (see the header).
const FORMATTING = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "table",
  "tr",
  "th",
  "td",
  "blockquote",
  "pre",
  "code",
  "kbd",
  "samp",
  "tt",
  "strong",
  "b",
  "em",
  "i",
  "cite",
  "var",
  "del",
  "s",
  "strike",
  "hr",
  "img",
  "a",
]);

/** One converted block, and how it joins to the one before it. */
interface Block {
  text: string;
  // True for a `<div>`'s inline content: two adjacent ones are two LINES, not
  // two paragraphs. Only honoured between two tight blocks — a single newline
  // after a real paragraph would just be a lazy continuation of it.
  tight: boolean;
  // A list, which a list ITEM hugs with a single newline: `- outer` followed
  // straight by its indented sub-list is the tight nesting everyone writes by
  // hand, and a blank line there would make the whole outer list loose.
  list?: boolean;
}

type Mark = "strong" | "em" | "del";

const MARKS: Record<Mark, string> = { strong: "**", em: "*", del: "~~" };

interface Ctx {
  // Nodes already consumed out of order — a list item's leading checkbox is
  // read by the item and must not be converted again where it sits.
  skip: Set<PasteNode>;
  // Inline marks currently open, so `<b><strong>x` emits one `**` pair rather
  // than `****x****`, which is not bold at all. Nested identical marks are
  // routine in pasteboard HTML: the copying app wraps the selection in the
  // styles it inherited, on top of the tags that were already there.
  marks: Set<Mark>;
}

// --- Text -------------------------------------------------------------------

const NBSP = /\u00a0/g;
const INVISIBLE = /[\u200b-\u200d\ufeff]/g;

// HTML whitespace is not significant: any run of it is one space. The two
// classes of invisible are folded here too — a pasted non-breaking space looks
// like a space forever after but behaves like a letter (no wrap, no word
// boundary), and a zero-width character is one nobody can see, search for, or
// delete on purpose.
function collapse(text: string): string {
  return text.replace(NBSP, " ").replace(INVISIBLE, "").replace(/[\t\n\r ]+/g, " ");
}

// Characters that would turn pasted prose into markup. `_` is deliberately not
// escaped: GFM's intraword rule already refuses emphasis inside a word, so
// `snake_case` is safe, and escaping it would litter every pasted identifier
// and URL with backslashes for the rare `_word_` a copying app would have sent
// as `<em>` anyway. `<` is left alone for the same reason — Ledge renders no
// HTML, so a literal angle bracket is only ever text.
function escapeInline(text: string): string {
  return text.replace(/([\\`*[\]])/g, "\\$1");
}

// The block markers, which only bite at the start of a line. Threaded through
// the walk rather than applied to the finished paragraph because by then the
// emphasis marks we generated are indistinguishable from pasted asterisks, and
// escaping `**bold` would print the stars instead of the bold.
function escapeLineStart(text: string): string {
  return text
    .replace(/^(\s*)([-=_]{3,})(\s*)$/, "$1\\$2$3")
    .replace(/^(\s*)(#{1,6})(?=\s|$)/, "$1\\$2")
    .replace(/^(\s*)([-+])(?=\s|$)/, "$1\\$2")
    .replace(/^(\s*)(\d{1,9})([.)])(?=\s|$)/, "$1$2\\$3")
    .replace(/^(\s*)([>|])/, "$1\\$2");
}

// A code span's or fence's content: text as typed, no escaping (the backticks
// protect it) and, in a fence, no collapsing either. Block-level children emit
// a newline as they close, so a `<pre>` built out of one div or table row per
// line — GitHub's, and every syntax highlighter's — does not arrive as a single
// run of glued-together lines.
function verbatimText(nodes: PasteNode[], keepNewlines: boolean): string {
  let out = "";
  for (const node of nodes) {
    if (!isEl(node)) {
      out += keepNewlines ? node.text.replace(NBSP, " ") : collapse(node.text);
      continue;
    }
    if (DROP.has(node.tag)) continue;
    if (node.tag === "br") {
      out += "\n";
      continue;
    }
    out += verbatimText(node.children, keepNewlines);
    if (keepNewlines && isBlock(node.tag) && out !== "" && !out.endsWith("\n")) out += "\n";
  }
  return out;
}

// --- Inline -----------------------------------------------------------------

/**
 * The inline Markdown for `nodes`. `atLineStart` says whether what comes back
 * begins a line, which is the only place the block markers need escaping; it
 * travels down through wrappers that emit nothing and stops at any that emits a
 * mark of its own.
 */
function inlineOf(nodes: PasteNode[], ctx: Ctx, atLineStart: boolean): string {
  let out = "";
  const starting = () => (out === "" ? atLineStart : out.endsWith("\n"));
  for (const node of nodes) {
    if (ctx.skip.has(node)) continue;
    if (!isEl(node)) {
      const text = collapse(node.text);
      if (text === "") continue;
      const escaped = escapeInline(text);
      out += starting() ? escapeLineStart(escaped) : escaped;
      continue;
    }
    if (DROP.has(node.tag)) continue;
    out += elementInline(node, ctx, starting());
  }
  return out;
}

function elementInline(el: El, ctx: Ctx, atLineStart: boolean): string {
  switch (el.tag) {
    case "br":
      return "\n";
    case "img":
      return imageOf(el);
    case "a":
      return linkOf(el, ctx, atLineStart);
    case "code":
    case "kbd":
    case "samp":
    case "tt":
      return codeSpanOf(verbatimText(el.children, false));
  }
  const mark = markOf(el);
  if (mark) return wrapMark(el, ctx, mark);
  // Anything left is a wrapper with nothing to say — a span, a font, a label,
  // or a block element HTML allowed inside inline content. Its children carry
  // on in place.
  return inlineOf(el.children, ctx, atLineStart);
}

// The mark an element asks for, by tag or by the style a WYSIWYG editor uses
// instead of one. Google Docs and Apple Notes ship bold as
// `<span style="font-weight:700">` with no `<b>` anywhere, so reading the
// declaration is the difference between converting those pastes and dropping
// their formatting on the floor.
function markOf(el: El): Mark | null {
  switch (el.tag) {
    case "strong":
    case "b":
      return "strong";
    case "em":
    case "i":
    case "cite":
    case "var":
      return "em";
    case "del":
    case "s":
    case "strike":
      return "del";
  }
  const style = el.attrs.style;
  if (!style) return null;
  const weight = /font-weight\s*:\s*([a-z0-9]+)/i.exec(style)?.[1];
  if (weight && (weight === "bold" || weight === "bolder" || Number(weight) >= 600)) return "strong";
  if (/font-style\s*:\s*italic/i.test(style)) return "em";
  if (/text-decoration[^;]*\bline-through\b/i.test(style)) return "del";
  return null;
}

function wrapMark(el: El, ctx: Ctx, mark: Mark): string {
  if (ctx.marks.has(mark)) return inlineOf(el.children, ctx, false);
  ctx.marks.add(mark);
  const inner = inlineOf(el.children, ctx, false);
  ctx.marks.delete(mark);
  // A mark around nothing but space is the copying app's wrapper, not
  // emphasis — and `** **` would not be emphasis anyway. The space survives,
  // the marks do not.
  if (inner.trim() === "") return inner;
  // Emphasis cannot open or close against a space, so the padding moves outside
  // the marks: `<b> x </b>` is ` **x** `, never `** x **`.
  const lead = /^\s*/.exec(inner)![0];
  const tail = /\s*$/.exec(inner)![0];
  const body = inner.slice(lead.length, inner.length - tail.length);
  const m = MARKS[mark];
  return `${lead}${m}${body}${m}${tail}`;
}

// Backticks long enough to hold the content, padded when it starts or ends with
// one — the CommonMark rule, so a copied `` `x` `` survives.
function codeSpanOf(text: string): string {
  if (text === "") return "";
  const runs = [...text.matchAll(/`+/g)].map((m) => m[0].length);
  const ticks = "`".repeat(Math.max(0, ...runs) + 1);
  const pad = text.startsWith("`") || text.endsWith("`") || text.trim() === "" ? " " : "";
  return `${ticks}${pad}${text}${pad}${ticks}`;
}

// A destination is bracketed when it carries characters that would end it
// early. CommonMark allows spaces inside `<…>`, which is what a copied URL with
// one needs.
function destination(url: string): string {
  return /[\s()<>]/.test(url) ? `<${url.replace(/[<>]/g, "")}>` : url;
}

function linkOf(el: El, ctx: Ctx, atLineStart: boolean): string {
  const label = inlineOf(el.children, ctx, atLineStart);
  const href = (el.attrs.href ?? "").trim();
  // An in-page anchor and a scripted link mean nothing once the page is gone,
  // and an empty target is not a link at all: the label is the whole content.
  if (href === "" || href.startsWith("#") || /^javascript:/i.test(href)) return label;
  const bare = href.replace(/^mailto:/i, "");
  // A link whose label IS its target is how a browser copies a bare URL.
  // Round-tripping that as `[url](url)` is noise — Ledge renders the bare form
  // as a link either way (livePreview.ts).
  if (label === escapeInline(bare) || label === escapeInline(href)) return bare;
  if (label.trim() === "") return destination(href);
  return `[${label}](${destination(href)})`;
}

function imageOf(el: El): string {
  const src = (el.attrs.src ?? "").trim();
  const alt = collapse(el.attrs.alt ?? "").trim();
  // A 1×1 image is a tracking pixel or a spacer, never content.
  if (el.attrs.width === "1" || el.attrs.height === "1") return "";
  // Only sources a note can resolve become images (images.ts renders remote
  // URLs and workspace-relative assets). A `data:` URI would inline a base64
  // wall into the prose, and `file:`/`cid:` point somewhere this machine cannot
  // follow; those keep their alt text, the only part that still means anything.
  if (!/^https?:\/\//i.test(src)) return alt === "" ? "" : escapeInline(alt);
  return `![${escapeInline(alt)}](${destination(src)})`;
}

// --- Blocks -----------------------------------------------------------------

/** The Markdown blocks of `nodes`, each already whole; `joinBlocks` spaces
 * them. */
function blocksOf(nodes: PasteNode[], ctx: Ctx): Block[] {
  const blocks: Block[] = [];
  let pending: PasteNode[] = [];
  const flush = () => {
    if (pending.length === 0) return;
    const text = paragraphOf(inlineOf(pending, ctx, true));
    pending = [];
    if (text !== "") blocks.push({ text, tight: false });
  };
  for (const node of nodes) {
    if (ctx.skip.has(node)) continue;
    if (isEl(node) && DROP.has(node.tag)) continue;
    if (isEl(node) && isBlock(node.tag)) {
      flush();
      blocks.push(...blockOf(node, ctx));
      continue;
    }
    pending.push(node);
  }
  flush();
  return blocks;
}

function joinBlocks(blocks: Block[]): string {
  let out = "";
  blocks.forEach((block, i) => {
    if (i > 0) out += block.tight && blocks[i - 1]!.tight ? "\n" : "\n\n";
    out += block.text;
  });
  return out;
}

// A paragraph's lines: the `<br>` newlines are kept (a break the writer put
// there), the spaces around them are not, and a line that ends up empty was the
// whitespace between two elements, never a paragraph of its own.
function paragraphOf(inline: string): string {
  return inline
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("\n");
}

function blockOf(el: El, ctx: Ctx): Block[] {
  const heading = HEADING.exec(el.tag);
  if (heading) {
    const text = paragraphOf(inlineOf(el.children, ctx, false)).replace(/\n/g, " ");
    return text === "" ? [] : [{ text: `${"#".repeat(Number(heading[1]))} ${text}`, tight: false }];
  }
  switch (el.tag) {
    case "hr":
      return [{ text: "---", tight: false }];
    case "pre":
      return [{ text: fenceOf(el), tight: false }];
    case "blockquote":
      return [{ text: quoteOf(el, ctx), tight: false }];
    case "ul":
    case "ol":
      return [{ text: listOf(el, ctx), tight: false, list: true }];
    case "table":
      return tableOf(el, ctx);
  }
  // p and the transparent containers, plus a stray tr/td outside a table. A
  // line block holding only inline content is one line of a stack (LINE_BLOCK).
  const blocks = blocksOf(el.children, ctx);
  const inlineOnly = !el.children.some((child) => isEl(child) && isBlock(child.tag));
  if (LINE_BLOCK.has(el.tag) && inlineOnly && blocks.length === 1) {
    return [{ text: blocks[0]!.text, tight: true }];
  }
  return blocks;
}

// A fence, marked long enough to hold a body containing fences of its own, and
// labelled from the highlighter's own class when it left one: `language-ts` is
// the convention every renderer writes and reads.
function fenceOf(el: El): string {
  const body = verbatimText(el.children, true).replace(/^\n/, "").replace(/\s+$/, "");
  const runs = [...body.matchAll(/`{3,}/g)].map((m) => m[0].length);
  const marks = "`".repeat(runs.length === 0 ? 3 : Math.max(...runs) + 1);
  return `${marks}${langOf(el) ?? ""}\n${body}\n${marks}`;
}

const LANG_CLASS = /(?:^|\s)(?:language|lang|highlight-source|brush:)[-\s]([a-z0-9+#]+)/i;

function langOf(el: El): string | null {
  const from = (node: El): string | null => LANG_CLASS.exec(node.attrs.class ?? "")?.[1] ?? null;
  const own = from(el);
  if (own) return own;
  for (const child of el.children) {
    if (isEl(child) && (child.tag === "code" || child.tag === "div" || child.tag === "span")) {
      const nested = from(child);
      if (nested) return nested;
    }
  }
  return null;
}

// `> ` on every line, including the blank ones between a quote's own blocks: a
// bare newline there would end the quote and leave the rest as prose.
function quoteOf(el: El, ctx: Ctx): string {
  return joinBlocks(blocksOf(el.children, ctx))
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
}

function listOf(el: El, ctx: Ctx): string {
  const ordered = el.tag === "ol";
  const items: string[] = [];
  let loose = false;
  let n = ordered ? Math.max(1, Number(el.attrs.start ?? 1) || 1) : 1;
  for (const child of el.children) {
    if (!isEl(child)) continue;
    if (child.tag === "ul" || child.tag === "ol") {
      // A nested list hung straight off the parent, with no `<li>` around it,
      // is how several editors spell a deeper level. Indent it under the last
      // item rather than losing it.
      const nested = indentRest(listOf(child, ctx), "  ");
      if (items.length > 0) items[items.length - 1] += `\n  ${nested}`;
      else items.push(`  ${nested}`);
      continue;
    }
    if (child.tag !== "li") continue;
    const task = checkboxOf(child, ctx);
    const marker = ordered ? `${n}. ` : "- ";
    const box = task === null ? "" : task ? "[x] " : "[ ] ";
    const blocks = blocksOf(child.children, ctx);
    // A sub-list does not make its parent loose (it hugs the item's text), so
    // only the item's own prose blocks are counted.
    if (blocks.filter((block) => !block.list).length > 1) loose = true;
    // Continuation lines line up with the item's content column, which is past
    // the marker but NOT past a checkbox: the box is the item's content, the
    // same 1ch advance Ledge's own task lines use (interactions.md, lists.ts).
    const body = indentRest(joinItemBlocks(blocks), " ".repeat(marker.length));
    if (`${box}${body}`.trim() === "") continue;
    items.push(`${marker}${box}${body}`);
    n += 1;
  }
  // Ledge writes tight lists (interactions.md, `tightLists`), so items sit on
  // consecutive lines — unless an item holds more than one block, whose own
  // blank lines would break the list apart without matching ones between items.
  return items.join(loose ? "\n\n" : "\n");
}

// One list item's blocks: its sub-lists hug the line above, its prose blocks
// keep the blank line that separates paragraphs anywhere else.
function joinItemBlocks(blocks: Block[]): string {
  let out = "";
  blocks.forEach((block, i) => {
    if (i > 0) out += block.list ? "\n" : "\n\n";
    out += block.text;
  });
  return out;
}

// Every line but the first, which already sits after its marker.
function indentRest(text: string, pad: string): string {
  return text
    .split("\n")
    .map((line, i) => (i === 0 || line === "" ? line : pad + line))
    .join("\n");
}

// The checkbox a task item leads with, consumed so it is not converted again
// where it sits. Null for an ordinary item.
function checkboxOf(li: El, ctx: Ctx): boolean | null {
  const found = firstCheckbox(li.children);
  if (!found) return null;
  ctx.skip.add(found);
  return "checked" in found.attrs;
}

// Pre-order, but only down the leading edge: a checkbox further into the item
// is content the writer typed, not the item's own marker.
function firstCheckbox(nodes: PasteNode[]): El | null {
  for (const node of nodes) {
    if (!isEl(node)) {
      if (collapse(node.text).trim() !== "") return null;
      continue;
    }
    if (node.tag === "input") {
      return (node.attrs.type ?? "").toLowerCase() === "checkbox" ? node : null;
    }
    if (DROP.has(node.tag)) continue;
    const nested = firstCheckbox(node.children);
    if (nested) return nested;
    if (verbatimText(node.children, false).trim() !== "") return null;
  }
  return null;
}

// --- Tables -----------------------------------------------------------------

const ALIGN = /text-align\s*:\s*(left|center|right)/i;

function tableOf(el: El, ctx: Ctx): Block[] {
  const rows = rowsOf(el);
  if (rows.length === 0) return [];
  const width = Math.max(...rows.map((row) => row.length));
  // A one-column table is a layout wrapper, not data — mail and newsletters are
  // built out of them. Its cells are the content, laid out as ordinary blocks.
  if (width < 2) {
    return rows.flatMap((row) => row.flatMap((cell) => blocksOf(cell.children, ctx)));
  }
  const header = rows[0]!;
  const rule = header.map((cell) => {
    switch (alignOf(cell)) {
      case "left":
        return ":---";
      case "center":
        return ":---:";
      case "right":
        return "---:";
      default:
        return "---";
    }
  });
  while (rule.length < width) rule.push("---");
  // GFM has no headerless table, so the first row becomes the header whether or
  // not it was `<th>`: promoting a data row keeps every cell visible, where an
  // invented blank header row would read as a bug in the note. Column spans are
  // not represented — a spanned cell lands in its first column, since Markdown
  // has nowhere else to put it.
  const lines = [
    rowLine(header, width, ctx),
    `| ${rule.join(" | ")} |`,
    ...rows.slice(1).map((row) => rowLine(row, width, ctx)),
  ];
  return [{ text: lines.join("\n"), tight: false }];
}

// Rows, however the table nests them: `thead`/`tbody`/`tfoot` are transparent
// here, and a `<tr>` may also sit directly under `<table>`.
function rowsOf(el: El): El[][] {
  const rows: El[][] = [];
  const walk = (nodes: PasteNode[]) => {
    for (const node of nodes) {
      if (!isEl(node) || DROP.has(node.tag)) continue;
      if (node.tag === "tr") {
        rows.push(node.children.filter((c): c is El => isEl(c) && (c.tag === "td" || c.tag === "th")));
      } else if (node.tag === "thead" || node.tag === "tbody" || node.tag === "tfoot") {
        walk(node.children);
      }
    }
  };
  walk(el.children);
  return rows.filter((row) => row.length > 0);
}

function alignOf(cell: El): string | null {
  const attr = (cell.attrs.align ?? "").toLowerCase();
  if (attr === "left" || attr === "center" || attr === "right") return attr;
  return ALIGN.exec(cell.attrs.style ?? "")?.[1]?.toLowerCase() ?? null;
}

// A cell is single-line by construction: a pipe would end it early, and a
// newline would end the whole row.
function rowLine(row: El[], width: number, ctx: Ctx): string {
  const cells = Array.from({ length: width }, (_, i) => {
    const cell = row[i];
    if (!cell) return "";
    return inlineOf(cell.children, ctx, false)
      .replace(/\s*\n\s*/g, " ")
      .replace(/\|/g, "\\|")
      .trim();
  });
  return `| ${cells.join(" | ")} |`;
}

// --- The policy -------------------------------------------------------------

/** Every block of `root`, joined — the Markdown for a whole pasteboard HTML. */
export function markdownFromNode(root: PasteNode): string {
  const ctx: Ctx = { skip: new Set(), marks: new Set() };
  return joinBlocks(blocksOf([root], ctx)).replace(/[ \t]+$/gm, "");
}

/** Whether any element in the tree means formatting Markdown could carry. */
export function hasFormatting(root: PasteNode): boolean {
  if (!isEl(root) || DROP.has(root.tag)) return false;
  if (FORMATTING.has(root.tag) || markOf(root) !== null) return true;
  return root.children.some(hasFormatting);
}

/**
 * The Markdown to paste for a pasteboard holding both flavors, or null to paste
 * `text` unchanged. Null is the answer whenever the HTML holds no formatting
 * (the header's rule), when it converts to nothing, and when the conversion
 * says what the plain text already said — a paste that only rewrites whitespace
 * is a paste the user would have to undo.
 */
export function richPasteMarkdown(text: string, html: PasteNode | null): string | null {
  if (!html || !hasFormatting(html)) return null;
  const md = markdownFromNode(html);
  if (md.trim() === "") return null;
  if (md === text.replace(/\s+$/, "")) return null;
  return md;
}

/**
 * The insert for a converted paste at a caret whose line already reads
 * `lineBefore`: block Markdown is nudged onto a line of its own, since a list
 * or heading that starts mid-line is not one. imagePasteInsert's rule
 * (images.ts), for the same reason.
 */
export function blockPasteInsert(lineBefore: string, md: string): string {
  const block = md.includes("\n") || /^(#{1,6} |[-+*] |\d+[.)] |> |```|---)/.test(md);
  return block && lineBefore.trim() !== "" ? `\n${md}` : md;
}

// --- The DOM wrapper --------------------------------------------------------

/** DOMParser's tree as a `PasteNode`, keeping only elements and text — a
 * comment carries no prose and would otherwise arrive as some. */
export function nodeOf(el: Element): PasteNode {
  const attrs: Record<string, string> = {};
  for (const attr of el.attributes) attrs[attr.name.toLowerCase()] = attr.value;
  const children: PasteNode[] = [];
  for (const child of el.childNodes) {
    if (child.nodeType === 1) children.push(nodeOf(child as Element));
    else if (child.nodeType === 3) children.push({ text: child.nodeValue ?? "" });
  }
  return { tag: el.tagName.toLowerCase(), attrs, children };
}

/** The pasteboard's HTML flavor as a node tree, or null when it holds none. */
export function parsePasteHtml(html: string): PasteNode | null {
  if (html.trim() === "") return null;
  const body = new DOMParser().parseFromString(html, "text/html").body;
  return body ? nodeOf(body) : null;
}

/**
 * Whether the caret sits somewhere a paste must stay verbatim: inside a code
 * block or span, or in the frontmatter. Both are places where the bytes are the
 * point — a fence holds the command that will run, frontmatter holds the note's
 * params — and Markdown structure written into either is damage, not a
 * translation.
 */
export function verbatimPaste(state: EditorState, pos: number): boolean {
  const front = frontmatterRange(state);
  if (front !== null && pos >= front.from && pos <= front.to) return true;
  let inside = false;
  // ensureSyntaxTree, not the incremental tree: in a long note the parse can
  // stop short of the caret, and a fence the parser has not reached yet would
  // read as prose — the one wrong answer here that damages a block.
  const tree = ensureSyntaxTree(state, pos, 50) ?? syntaxTree(state);
  tree.iterate({
    from: pos,
    to: pos,
    enter(node) {
      if (node.name === "FencedCode" || node.name === "CodeBlock" || node.name === "InlineCode") {
        inside = true;
      }
    },
  });
  return inside;
}
