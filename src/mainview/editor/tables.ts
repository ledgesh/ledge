// GFM tables, rendered: a pipe table draws as a real <table> whenever the
// selection starts outside it, and reverts to raw pipes the moment the caret
// lands on it — the block-level half of livePreview.ts's reveal rule.
// Clicking a rendered cell places the caret at that cell's text (which
// reveals the raw table right where you aimed); ⌘-clicking a link inside a
// cell opens it, same grammar as everywhere else.
//
// This lives in its own StateField, not livePreview's ViewPlugin, because a
// table spans line breaks and CodeMirror only accepts block replace
// decorations from a field. Only top-level tables render: a table inside a
// blockquote has QuoteMarks interleaved through its range, and swallowing
// those into a widget would hide quote structure the quote rules rely on —
// quoted (or listed) tables stay raw.
//
// Split per testing.md §2: `tableModels` is the pure core (doc + tree in,
// cell/segment model out — inline syntax inside cells is delegated to the
// already-tested concealments core); the widget and field below are the thin
// wrappers.
import type { SyntaxNode, Tree } from "@lezer/common";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import {
  type EditorState,
  type Extension,
  type Range,
  StateField,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { blockRevealed, concealments, type Conceal, type DocSlice, type Span } from "./livePreview";
import { frontmatterRange } from "./frontmatter";
import { openExternal } from "./bridge";

export type Align = "left" | "center" | "right" | null;
export type SegStyle = "em" | "strong" | "strike" | "code";

/** A run of cell text with uniform styling. `url` is openableUrl-approved;
 * `link` is true for link text even when the target is not openable. */
export interface Seg {
  text: string;
  styles: SegStyle[];
  url: string | null;
  link: boolean;
}

/** `pos` is where a click on the rendered cell should put the caret. */
export interface Cell {
  pos: number;
  segs: Seg[];
}

export interface TableModel {
  from: number;
  to: number;
  /** Raw source of the table — the widget's identity for redraw checks. */
  src: string;
  align: Align[];
  header: Cell[];
  rows: Cell[][];
}

const STYLE_NODES: Record<string, SegStyle> = {
  Emphasis: "em",
  StrongEmphasis: "strong",
  Strikethrough: "strike",
  InlineCode: "code",
};

/** Every top-level table in the document, as render-ready models. */
export function tableModels(doc: DocSlice, tree: Tree): TableModel[] {
  const tables: SyntaxNode[] = [];
  tree.iterate({
    enter(node) {
      if (node.name !== "Table") return;
      if (node.node.parent?.name === "Document") tables.push(node.node);
      return false; // never render nested tables; don't descend
    },
  });
  if (tables.length === 0) return [];

  // The inline syntax inside cells conceals exactly as it would in prose:
  // one doc-wide pass of the concealment core with nothing revealed, filtered
  // per cell below.
  const conceals = concealments(doc, tree, [], null);

  return tables.map((table) => {
    const header = table.getChild("TableHeader");
    const delim = table.getChild("TableDelimiter");
    return {
      from: table.from,
      to: table.to,
      src: doc.sliceString(table.from, table.to),
      align: delim ? parseAlign(doc.sliceString(delim.from, delim.to)) : [],
      header: header ? cellsOf(doc, header, conceals) : [],
      rows: table.getChildren("TableRow").map((row) => cellsOf(doc, row, conceals)),
    };
  });
}

// `| :--- | ---: |` → per-column alignment. Outer pipes are optional in GFM.
function parseAlign(delimRow: string): Align[] {
  return delimRow
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((col) => {
      const c = col.trim();
      if (c.startsWith(":") && c.endsWith(":") && c.length > 1) return "center";
      if (c.endsWith(":")) return "right";
      if (c.startsWith(":")) return "left";
      return null;
    });
}

function cellsOf(doc: DocSlice, row: SyntaxNode, conceals: Conceal[]): Cell[] {
  return row
    .getChildren("TableCell")
    .map((cell) => ({ pos: cell.from, segs: cellSegs(doc, cell, conceals) }));
}

// A cell's text, cut at every conceal and style boundary: hidden syntax
// drops, entities decode, links carry their URL, and emphasis/strong/strike/
// inline-code stack as styles. Same result as the editor's own inline
// rendering, minus the DOM.
function cellSegs(doc: DocSlice, cell: SyntaxNode, conceals: Conceal[]): Seg[] {
  const local = conceals.filter((c) => c.from < cell.to && c.to > cell.from);
  const styles: Array<Span & { style: SegStyle }> = [];
  for (const [name, style] of Object.entries(STYLE_NODES)) {
    for (let n = cell.firstChild; n; n = n.nextSibling) collectStyles(n, name, style, styles);
  }

  const cuts = new Set<number>([cell.from, cell.to]);
  for (const c of [...local, ...styles]) {
    cuts.add(Math.max(cell.from, c.from));
    cuts.add(Math.min(cell.to, c.to));
  }
  const bounds = [...cuts].sort((a, b) => a - b);

  const segs: Seg[] = [];
  for (let i = 0; i < bounds.length - 1; i += 1) {
    const from = bounds[i]!;
    const to = bounds[i + 1]!;
    if (local.some((c) => c.kind === "hide" && c.from <= from && c.to >= to)) continue;
    const entity = local.find(
      (c): c is Span & { kind: "entity"; text: string } =>
        c.kind === "entity" && c.from <= from && c.to >= to,
    );
    // An entity renders once, at its own start; later slices of it drop.
    if (entity && entity.from !== from) continue;
    const text = entity ? entity.text : doc.sliceString(from, to);
    if (!text) continue;
    const link = local.find(
      (c): c is Span & { kind: "link"; url: string | null } =>
        c.kind === "link" && c.from <= from && c.to >= to,
    );
    segs.push({
      text,
      styles: styles.filter((s) => s.from <= from && s.to >= to).map((s) => s.style),
      url: link?.url ?? null,
      link: link !== undefined,
    });
  }
  return segs;
}

// Style nodes nest (bold containing italic), so the walk descends everywhere.
function collectStyles(
  node: SyntaxNode,
  name: string,
  style: SegStyle,
  out: Array<Span & { style: SegStyle }>,
): void {
  if (node.name === name) out.push({ from: node.from, to: node.to, style });
  for (let child = node.firstChild; child; child = child.nextSibling) {
    collectStyles(child, name, style, out);
  }
}

// --- The view wrappers -------------------------------------------------------

class TableWidget extends WidgetType {
  constructor(readonly model: TableModel) {
    super();
  }
  eq(other: TableWidget) {
    return other.model.src === this.model.src && other.model.from === this.model.from;
  }
  toDOM(view: EditorView): HTMLElement {
    const m = this.model;
    const table = document.createElement("table");
    table.className = "ledge-mdtable";

    const addRow = (parent: HTMLElement, cells: Cell[], tag: "th" | "td") => {
      const tr = parent.appendChild(document.createElement("tr"));
      const count = Math.max(cells.length, m.header.length);
      for (let i = 0; i < count; i += 1) {
        const el = tr.appendChild(document.createElement(tag));
        const cell = cells[i];
        el.dataset.pos = String(cell ? cell.pos : m.from);
        const align = m.align[i];
        if (align) el.style.textAlign = align;
        for (const seg of cell?.segs ?? []) el.appendChild(renderSeg(seg));
      }
    };

    addRow(table.appendChild(document.createElement("thead")), m.header, "th");
    const tbody = table.appendChild(document.createElement("tbody"));
    for (const row of m.rows) addRow(tbody, row, "td");

    // A click on a link in a cell opens it — the whole rendered table is a
    // widget, not editable text, so plain click may act (livePreview.ts
    // clickToOpen has the full grammar). A click anywhere else in a cell is
    // a caret move to that cell's text, which reveals the raw table right
    // where the user aimed. ignoreEvent() keeps CodeMirror from also
    // treating this as a click into the (replaced) text.
    table.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const target = event.target instanceof HTMLElement ? event.target : null;
      const url = target?.closest<HTMLElement>("[data-url]")?.dataset.url;
      if (url) {
        openExternal(url);
        return;
      }
      const posText = target?.closest<HTMLElement>("[data-pos]")?.dataset.pos;
      const pos = posText === undefined ? m.from : Number(posText);
      view.dispatch({
        selection: { anchor: Math.min(pos, view.state.doc.length) },
        scrollIntoView: true,
      });
      view.focus();
    });
    return table;
  }
  ignoreEvent() {
    return true;
  }
}

function renderSeg(seg: Seg): HTMLElement {
  const el = document.createElement("span");
  el.textContent = seg.text;
  if (seg.styles.includes("em")) el.style.fontStyle = "italic";
  if (seg.styles.includes("strong")) el.style.fontWeight = "600";
  if (seg.styles.includes("strike")) el.style.textDecoration = "line-through";
  if (seg.styles.includes("code")) el.classList.add("ledge-mdtable-code");
  if (seg.link) el.classList.add("ledge-mdlink");
  if (seg.url) {
    el.dataset.url = seg.url;
    el.title = "Click to open link";
  }
  return el;
}

function buildTables(state: EditorState): DecorationSet {
  // ensureSyntaxTree, not syntaxTree, for the same reason as quotes.ts: this
  // rebuild runs right after an edit, and a stale incremental parse would
  // flicker the table back to pipes. Notes are small; the budget is a bound,
  // not a cost.
  const tree = ensureSyntaxTree(state, state.doc.length, 20) ?? syntaxTree(state);
  const models = tableModels(state.doc, tree);
  if (models.length === 0) return Decoration.none;

  const exclude = frontmatterRange(state);
  const ranges: Range<Decoration>[] = [];
  for (const m of models) {
    // A selection ANCHORED on the table (endpoints inclusive) shows the raw
    // pipes; one merely sweeping across leaves the table drawn, so dragging
    // past it cannot flap a widget this tall. blockRevealed has the why.
    if (exclude !== null && m.from <= exclude.to && m.to >= exclude.from) continue;
    if (blockRevealed(m, state.selection.ranges)) continue;
    // Block replace ranges must cover whole lines.
    const from = state.doc.lineAt(m.from).from;
    const to = state.doc.lineAt(m.to).to;
    ranges.push(Decoration.replace({ widget: new TableWidget(m), block: true }).range(from, to));
  }
  return Decoration.set(ranges);
}

const tableField = StateField.define<DecorationSet>({
  create: buildTables,
  update(deco, tr) {
    return tr.docChanged || tr.selection ? buildTables(tr.state) : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export function tableRendering(): Extension {
  return tableField;
}
