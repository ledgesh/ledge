// Rendered images: `![alt](src)` standing alone on a line draws as the actual
// image whenever the selection starts outside that line, and reverts to raw
// markdown the moment the caret lands on it — the same reveal rule as
// tables, and in the same shape: a StateField, because an image changes the
// line's height and CodeMirror only accepts layout-affecting decorations from
// a field. Clicking the rendered image places the caret at its markdown
// (revealing it), exactly like clicking a rendered table cell.
//
// Only images alone on their line render. An image inline in prose (or inside
// a list/quote, whose marker shares the line) keeps livePreview.ts's existing
// treatment — syntax concealed, alt text styled as a link — because replacing
// mid-paragraph text with an arbitrarily tall widget turns reading prose into
// dodging reflows.
//
// Two source kinds render: http(s) URLs load straight into the <img> (the
// webview may fetch the web; it may not touch the filesystem), and note-
// relative paths (`.ledge-assets/x.png`, or any image in the workspace
// folder) are fetched from Bun as base64 over
// assetRead (lib/assets.ts) — Bun re-validates the reference; the check here
// is styling, Bun's is the guard, same split as links.ts. Anything else
// (file:, absolute paths, traversals, non-image extensions) does not render.
//
// Split per testing.md §2: `imageModels`, `imageSrcOf`, and `imagePasteInsert`
// are the pure core; the widget and field below are the thin wrappers.
import type { SyntaxNode, Tree } from "@lezer/common";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import {
  type EditorState,
  type Extension,
  type Range,
  StateField,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { blockRevealed, type DocSlice, type Span } from "./livePreview";
import { frontmatterRange } from "./frontmatter";
import { sessionIdFacet } from "./session";
import { assetDataUrl } from "../lib/assets";
import { folderOf, pathOf } from "../notes/store";
import { ASSETS_DIRNAME } from "../../shared/rpc-schema";

/** A renderable image source. `remote` goes straight into the <img> src;
 * `asset` is a note-relative reference resolved through Bun (lib/assets.ts). */
export type ImageSrc =
  | { kind: "remote"; url: string }
  | { kind: "asset"; path: string };

// The slice-plus-lines view of a document the core needs: CodeMirror's Text
// satisfies it, and tests wrap a plain string.
export interface DocLines extends DocSlice {
  lineAt(pos: number): Span;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg)$/i;

/**
 * Classify an image target, or null when it is not one we render. Mirrors the
 * shape of links.ts's openableUrl: scheme first, then the schemeless forms.
 * The relative-path rules (no absolute, no dot-entries, image extension) are
 * re-checked Bun-side by assetPathOf — this copy only decides what to attempt.
 */
export function imageSrcOf(raw: string): ImageSrc | null {
  const text = raw.trim();
  if (!text || /\s/.test(text)) return null;
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(text);
  if (m) return /^https?$/i.test(m[1]!) ? { kind: "remote", url: text } : null;
  if (/^www\./i.test(text)) return { kind: "remote", url: `https://${text}` };
  if (text.startsWith("/") || text.includes("\\")) return null;
  // The app's own assets dir is the one accepted dot-entry, and only as the
  // first segment — the same exception assetPathOf carves out Bun-side, from
  // the same shared constant. Deeper dots (temp files, .ledge-trash) stay out.
  const parts = text.split("/");
  if (parts.slice(parts[0] === ASSETS_DIRNAME ? 1 : 0).some((part) => part.startsWith("."))) return null;
  if (!IMAGE_EXT.test(text)) return null;
  return { kind: "asset", path: text };
}

/** One image to render: its own span, the line it owns (the reveal unit and
 * the replaced range), its alt text, and its classified source. */
export interface ImageModel {
  from: number;
  to: number;
  lineFrom: number;
  lineTo: number;
  alt: string;
  src: ImageSrc;
}

/**
 * Every image standing alone on its line, as render-ready models. "Alone"
 * means the rest of the line is whitespace — which also keeps quoted and
 * listed images raw (their `>` / `-` marker shares the line), the same
 * top-level-only stance tables take.
 */
export function imageModels(doc: DocLines, tree: Tree): ImageModel[] {
  const out: ImageModel[] = [];
  tree.iterate({
    enter(node) {
      if (node.name !== "Image") return;
      const el = node.node;
      const line = doc.lineAt(el.from);
      if (el.to > line.to) return false; // spans lines: raw
      const outside =
        doc.sliceString(line.from, el.from) + doc.sliceString(el.to, line.to);
      if (outside.trim() !== "") return false;
      const urlNode = el.getChild("URL");
      if (!urlNode) return false; // reference-style: no target to draw
      const src = imageSrcOf(doc.sliceString(urlNode.from, urlNode.to));
      if (!src) return false;
      const marks = el.getChildren("LinkMark");
      const alt =
        marks.length >= 2 && marks[1]!.from > marks[0]!.to
          ? doc.sliceString(marks[0]!.to, marks[1]!.from)
          : "";
      out.push({ from: el.from, to: el.to, lineFrom: line.from, lineTo: line.to, alt, src });
      return false;
    },
  });
  return out;
}

/**
 * The edit that embeds a pasted image at `sel`: the markdown replaces the
 * selection, nudged onto its own line (a leading newline where the line
 * already has text) so it renders. The trailing newline is unconditional and
 * `cursor` (relative to `sel.from`) lands after it — the caret ends up BELOW
 * the image's line, off its reveal unit, so the paste shows the image
 * immediately rather than the raw markdown you'd have to arrow away from.
 */
export function imagePasteInsert(
  doc: DocLines,
  sel: Span,
  src: string,
): { insert: string; cursor: number } {
  const before = doc.sliceString(doc.lineAt(sel.from).from, sel.from);
  const md = `![](${src})`;
  const prefix = before.trim() === "" ? "" : "\n";
  const insert = `${prefix}${md}\n`;
  return { insert, cursor: insert.length };
}

/**
 * Get an image from somewhere and embed it: the whole of what ⌘V-with-a-picture
 * and Insert Image… have in common, which turns out to be everything except
 * `produce`.
 *
 * `produce` is handed the note's workspace folder and its file path, and
 * answers the markdown reference the server chose — `lib/assets.ts`'s two
 * seams, which differ only in whether the bytes came off a pasteboard or out of
 * a picker. Null is "nothing to insert" (an empty pasteboard, a cancelled
 * picker) and is silent: neither is a failure and neither earns an error strip.
 *
 * The selection is re-read after the await rather than captured before it,
 * because a picker is on screen for as long as a person takes to choose and the
 * caret can move under it.
 */
export async function embedImage(
  view: EditorView,
  produce: (folder: string, notePath: string | null) => Promise<string | null>,
): Promise<void> {
  // No folder means an editor outside the pool (a test): nowhere to save.
  const folder = folderOf(view.state.facet(sessionIdFacet));
  if (!folder) return;
  // The note's own path rides along: the server seals the write at birth when
  // that note is LOCKED (locking.md §5) — decided from the disk, the path is
  // only the address.
  const src = await produce(folder, pathOf(view.state.facet(sessionIdFacet)));
  if (!src) return;
  const sel = view.state.selection.main;
  const { insert, cursor } = imagePasteInsert(view.state.doc, sel, src);
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert },
    selection: { anchor: sel.from + cursor },
    userEvent: "input.paste",
  });
}

// --- The view wrappers -------------------------------------------------------

class ImageWidget extends WidgetType {
  /** `selected` is the view's business, not the model's: a selection sweeping
   * over the image leaves it drawn (blockRevealed), and an opaque image sits
   * ON TOP of CodeMirror's selection layer, so without a face of its own it
   * would be the one thing in a selection that looks untouched. */
  constructor(readonly model: ImageModel, readonly selected: boolean) {
    super();
  }
  /** What makes this the same picture: the bytes it points at and its alt. */
  private key(): string {
    const s = this.model.src;
    return `${s.kind}:${s.kind === "remote" ? s.url : s.path}\u0000${this.model.alt}`;
  }
  eq(other: ImageWidget) {
    return this.key() === other.key() && this.selected === other.selected;
  }
  /** Reached when only `selected` changed: repaint the face in place rather
   * than let CodeMirror redraw, because a redraw builds a new <img> and
   * re-runs the asset fetch — a blank frame mid-drag is the very flicker the
   * anchor rule exists to remove. A different picture returns false and gets
   * the redraw. */
  updateDOM(dom: HTMLElement): boolean {
    if (dom.dataset.key !== this.key()) return false;
    dom.classList.toggle("is-selected", this.selected);
    return true;
  }
  toDOM(view: EditorView): HTMLElement {
    const m = this.model;
    const box = document.createElement("div");
    box.className = "ledge-mdimage";
    if (this.selected) box.classList.add("is-selected");
    box.dataset.key = this.key();

    const broken = () => {
      box.textContent = "";
      const note = box.appendChild(document.createElement("span"));
      note.className = "ledge-mdimage-broken";
      note.textContent = `image unavailable: ${
        m.src.kind === "remote" ? m.src.url : m.src.path
      }`;
      view.requestMeasure();
    };

    // A sealed image (locking.md §5): the file is there, the vault is
    // locked. Not "broken" — the honest face is a lock, and unlocking is the
    // fix. The cache eviction on unlock plus the widget's next rebuild (any
    // doc/selection change) swaps in the bytes; locked NOTES re-pour wholesale
    // on unlock, which rebuilds their widgets immediately.
    const sealed = () => {
      box.textContent = "";
      const note = box.appendChild(document.createElement("span"));
      note.className = "ledge-mdimage-broken";
      note.dataset.testid = "sealed-image";
      note.textContent = "locked image (unlock to view)";
      view.requestMeasure();
    };

    // The frame shrink-wraps the image so the selected tint lands on the
    // picture and not on the empty row beside it; the box stays full width so
    // clicking anywhere on the line still reveals the markdown.
    const frame = box.appendChild(document.createElement("span"));
    frame.className = "ledge-mdimage-frame";
    const img = frame.appendChild(document.createElement("img"));
    if (m.alt) img.alt = m.alt;
    img.title = m.alt || "Click to edit image markdown";
    // The widget's height settles when the bytes arrive, in both branches;
    // tell CodeMirror each time so the lines below sit where they draw.
    img.addEventListener("load", () => view.requestMeasure());
    img.addEventListener("error", broken);
    if (m.src.kind === "remote") {
      img.src = m.src.url;
    } else {
      // The reference resolves against this note's own workspace folder; no
      // folder (an editor outside the pool, e.g. a test) renders as broken,
      // the same degradation as an unconfigured asset channel.
      const folder = folderOf(view.state.facet(sessionIdFacet));
      if (!folder) {
        broken();
      } else {
        void assetDataUrl(folder, m.src.path).then((url) => {
          if (url === "sealed") sealed();
          else if (url) img.src = url;
          else broken();
        });
      }
    }

    // A click is a caret move to the image's markdown, which reveals it right
    // where the user aimed — the table-cell grammar. ignoreEvent() keeps
    // CodeMirror from also treating this as a click into the replaced text.
    box.addEventListener("mousedown", (event) => {
      event.preventDefault();
      view.dispatch({
        selection: { anchor: Math.min(m.from, view.state.doc.length) },
        scrollIntoView: true,
      });
      view.focus();
    });
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

function buildImages(state: EditorState): DecorationSet {
  // ensureSyntaxTree for the same reason as tables.ts: this rebuild runs right
  // after an edit, and a stale incremental parse would flicker the image away.
  const tree = ensureSyntaxTree(state, state.doc.length, 20) ?? syntaxTree(state);
  const models = imageModels(state.doc, tree);
  if (models.length === 0) return Decoration.none;

  const exclude = frontmatterRange(state);
  const ranges: Range<Decoration>[] = [];
  for (const m of models) {
    if (exclude !== null && m.from <= exclude.to && m.to >= exclude.from) continue;
    // The reveal unit is the whole line (endpoints inclusive), like a table's
    // rows: a caret arriving anywhere on it shows the raw markdown. A
    // selection merely sweeping ACROSS the line leaves the image drawn —
    // blockRevealed reads the anchor, not the whole range, so dragging a
    // selection past an image cannot flap it (livePreview.ts).
    const unit = { from: m.lineFrom, to: m.lineTo };
    if (blockRevealed(unit, state.selection.ranges)) continue;
    // Still drawn, but inside the selection: wear the selected face.
    const selected = state.selection.ranges.some((r) => r.from <= unit.to && r.to >= unit.from);
    ranges.push(
      Decoration.replace({ widget: new ImageWidget(m, selected), block: true }).range(
        m.lineFrom,
        m.lineTo,
      ),
    );
  }
  return Decoration.set(ranges);
}

const imageField = StateField.define<DecorationSet>({
  create: buildImages,
  update(deco, tr) {
    return tr.docChanged || tr.selection ? buildImages(tr.state) : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export function imageRendering(): Extension {
  return imageField;
}
