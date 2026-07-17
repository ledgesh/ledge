// Live preview: markdown syntax conceals where it is noise and reveals where
// the caret is. The document is untouched — every conceal is a view-time
// Decoration.replace over marker characters, so the text you edit is still
// the text on disk; what changes is only whether the markers are drawn. The
// reveal rule is Obsidian's: an element shows its raw syntax whenever any
// selection range touches it (endpoints inclusive), which also means the
// caret can never sit invisibly inside a hidden range — the moment it
// arrives, the range is no longer hidden. No atomicRanges needed.
//
// What conceals: emphasis/strong/strikethrough marks, inline-code backticks,
// ATX heading #s (with their separator space), link/image/autolink syntax
// (the text stays, styled as a link), code-fence ``` marks, the `- ` bullet
// on task lines (the checkbox is the bullet), escape backslashes, backslash
// hard breaks, decodable HTML entities (drawn as their character), and
// `---` thematic breaks (drawn as a rule). Tables and images are the
// block-level halves of the same idea and live in tables.ts / images.ts (an
// image alone on its line draws as the image; inline in prose it stays the
// concealed-link treatment below). What deliberately does not
// conceal: fence CONTENT (byte-exact code is the app's promise; only the
// fence marks go), the language label on the opening fence (restyled small,
// kept as the block's caption), setext underlines and blockquote/list marks
// (already dimmed; concealing them buys little and the list marks are
// load-bearing for wrap.ts's column math — the task bullet is the one
// exception because the checkbox replaces its meaning entirely), ordered
// task numbers (the number carries information a checkbox doesn't),
// HTML blocks/tags and link-reference definitions (rendering HTML is a
// non-goal; raw is honest), undecodable entities, and everything inside the
// frontmatter block — the markdown parser misreads that block wholesale
// (frontmatter.ts), so concealment there would hide fences that are not
// fences.
//
// Split per testing.md §2: `concealments` and `linkTargetAt` are the pure
// core (values in, spans out — tested against @lezer/markdown with no DOM);
// the plugin and click handler below are the thin wrappers.
import type { SyntaxNode, Tree } from "@lezer/common";
import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension, Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { openableUrl } from "../../shared/links";
import { tooltip } from "../commands/format";
import { frontmatterRange } from "./frontmatter";
import { openExternal } from "./bridge";

export interface Span {
  from: number;
  to: number;
}

/** One concealment decision. `link` and `done` mark visible text (never
 * remove it); `link`'s `url` is openableUrl-approved, or null when the link
 * has no openable target (reference links, relative paths) and should be
 * styled only. `task` replaces a `[ ]`/`[x]` marker with a real checkbox,
 * `rule` a `---` line with a drawn rule, `entity` an HTML entity with its
 * decoded character. */
export type Conceal =
  | (Span & { kind: "hide" })
  | (Span & { kind: "link"; url: string | null })
  | (Span & { kind: "fenceInfo" })
  | (Span & { kind: "task"; checked: boolean })
  | (Span & { kind: "done" })
  | (Span & { kind: "rule" })
  | (Span & { kind: "entity"; text: string });

// The slice of a document the core needs: CodeMirror's Text satisfies it, and
// tests wrap a plain string.
export interface DocSlice {
  sliceString(from: number, to: number): string;
}

// Inline marks concealed by the same rule: hide unless the element that owns
// them is touched. Maps mark node name -> accepted parent names (a CodeMark
// under FencedCode is fence syntax, handled separately below).
const INLINE_MARK_PARENTS: Record<string, string[]> = {
  EmphasisMark: ["Emphasis", "StrongEmphasis"],
  CodeMark: ["InlineCode"],
  StrikethroughMark: ["Strikethrough"],
};

const ATX = /^ATXHeading[1-6]$/;
const LINKISH = new Set(["Link", "Image", "Autolink"]);

function touches(span: Span, ranges: readonly Span[]): boolean {
  return ranges.some((r) => r.from <= span.to && r.to >= span.from);
}

/**
 * Every concealment for `doc` under `selection`, sorted by position. `tree`
 * is the markdown parse (syntaxTree in the editor, @lezer/markdown in tests);
 * `exclude` is a region left raw wholesale — the frontmatter block.
 */
export function concealments(
  doc: DocSlice,
  tree: Tree,
  selection: readonly Span[],
  exclude: Span | null,
): Conceal[] {
  const out: Conceal[] = [];
  // Whether the element owning [span] shows raw right now.
  const revealed = (span: Span) =>
    (exclude !== null && span.from <= exclude.to && span.to >= exclude.from) ||
    touches(span, selection);

  tree.iterate({
    enter(node) {
      const name = node.name;

      const inlineParents = INLINE_MARK_PARENTS[name];
      if (inlineParents) {
        const parent = node.node.parent;
        if (parent && inlineParents.includes(parent.name) && !revealed(parent)) {
          out.push({ kind: "hide", from: node.from, to: node.to });
        }
        // A CodeMark under FencedCode: the fence marks go, the info string
        // (language label) stays as the block's caption.
        if (name === "CodeMark" && parent?.name === "FencedCode" && !revealed(parent)) {
          out.push({ kind: "hide", from: node.from, to: node.to });
        }
        return;
      }

      if (name === "CodeInfo") {
        const parent = node.node.parent;
        if (parent?.name === "FencedCode" && !revealed(parent)) {
          out.push({ kind: "fenceInfo", from: node.from, to: node.to });
        }
        return;
      }

      if (name === "HeaderMark") {
        const parent = node.node.parent;
        // Setext underlines stay: concealing a whole `===` line leaves a
        // confusing blank, and the dimmed underline reads fine.
        if (!parent || !ATX.test(parent.name) || revealed(parent)) return;
        if (node.from === parent.from) {
          // Leading marks swallow their separator space so the heading text
          // does not sit one column indented from the left edge.
          const pad = doc.sliceString(node.to, node.to + 1) === " " ? 1 : 0;
          out.push({ kind: "hide", from: node.from, to: node.to + pad });
        } else {
          // Trailing closing marks (`## Hi ##`) swallow the space before them.
          const pad = doc.sliceString(node.from - 1, node.from) === " " ? 1 : 0;
          out.push({ kind: "hide", from: node.from - pad, to: node.to });
        }
        return;
      }

      if (LINKISH.has(name)) {
        const el = node.node;
        if (revealed(el)) return;
        // Everything around the visible text is syntax — hidden as two spans
        // rather than child by child, so the whitespace BETWEEN syntax
        // children (`](url "title")`) goes with them.
        const text = visibleTextSpan(el, name === "Autolink");
        if (!text) {
          out.push({ kind: "hide", from: el.from, to: el.to });
          return;
        }
        if (text.from > el.from) out.push({ kind: "hide", from: el.from, to: text.from });
        if (text.to < el.to) out.push({ kind: "hide", from: text.to, to: el.to });
        out.push({ kind: "link", ...text, url: urlOf(doc, el) });
        return;
      }

      // A task's `[ ]`/`[x]` renders as a real checkbox unless the caret is
      // on the marker itself (caret in the task's TEXT keeps the checkbox —
      // editing the label should not flicker the marker open). The `- `
      // bullet before it hides too: the checkbox IS the bullet, so drawing
      // both is noise (an ordered task's number stays — it carries order).
      // A checked task's label is styled done whether or not the marker is
      // concealed, like the link styling on a bare URL.
      if (name === "TaskMarker") {
        const parent = node.node.parent;
        if (parent?.name !== "Task") return;
        const item = parent.parent;
        const bullet =
          item?.name === "ListItem" && item.parent?.name === "BulletList"
            ? item.getChild("ListMark")
            : null;
        const checked = /x/i.test(doc.sliceString(node.from, node.to));
        // Bullet and marker reveal as one unit — a caret between them (or at
        // line start, via endpoint-inclusive touch) shows the whole raw
        // prefix rather than a checkbox floating next to a bare `-`.
        if (!revealed({ from: bullet ? bullet.from : node.from, to: node.to })) {
          if (bullet) out.push({ kind: "hide", from: bullet.from, to: node.from });
          out.push({ kind: "task", from: node.from, to: node.to, checked });
        }
        if (
          checked &&
          parent.to > node.to &&
          !(exclude !== null && node.from <= exclude.to && node.to >= exclude.from)
        ) {
          out.push({ kind: "done", from: node.to, to: parent.to });
        }
        return;
      }

      // A thematic break draws as an actual rule. The node is the whole
      // `---`/`***` line, so the reveal unit is the line — caret onto it
      // shows the raw dashes.
      if (name === "HorizontalRule") {
        if (!revealed(node)) out.push({ kind: "rule", from: node.from, to: node.to });
        return;
      }

      // An escape's backslash is syntax; the escaped character is content.
      if (name === "Escape") {
        if (!revealed(node)) out.push({ kind: "hide", from: node.from, to: node.from + 1 });
        return;
      }

      // A backslash hard break: the `\` hides (the break it makes stays a
      // real newline). The two-trailing-spaces form is already invisible —
      // concealing whitespace buys nothing, so it is left alone.
      if (name === "HardBreak") {
        if (doc.sliceString(node.from, node.from + 1) !== "\\") return;
        if (!revealed(node)) out.push({ kind: "hide", from: node.from, to: node.from + 1 });
        return;
      }

      // An HTML entity draws as the character it names, when we can decode
      // it. Unknown names stay raw — showing `&whatever;` is honest; showing
      // a wrong character is not.
      if (name === "Entity") {
        const decoded = decodeEntity(doc.sliceString(node.from, node.to));
        if (decoded !== null && !revealed(node)) {
          out.push({ kind: "entity", from: node.from, to: node.to, text: decoded });
        }
        return;
      }

      // A bare GFM autolink (https://… loose in prose): nothing to hide,
      // but it is a link and should say so. Skipped inside Link/Autolink,
      // whose handler above owns it.
      if (name === "URL") {
        const parent = node.node.parent;
        if (parent && LINKISH.has(parent.name)) return;
        if (exclude !== null && node.from <= exclude.to && node.to >= exclude.from) return;
        out.push({
          kind: "link",
          from: node.from,
          to: node.to,
          url: openableUrl(doc.sliceString(node.from, node.to)),
        });
      }
    },
  });

  return out.sort((a, b) => a.from - b.from || a.to - b.to);
}

// The characters entities decode to, without a DOM (the core is DOM-free and
// so are its tests). Numeric forms decode by code point; named forms come
// from this table — the ones that plausibly appear in notes, not all 2000+
// of HTML's. Anything else returns null and stays raw.
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  copy: "©", reg: "®", trade: "™", deg: "°", middot: "·", bull: "•",
  hellip: "…", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", sect: "§",
  para: "¶", dagger: "†", times: "×", divide: "÷", plusmn: "±", ne: "≠",
  le: "≤", ge: "≥", larr: "←", rarr: "→", uarr: "↑", darr: "↓", harr: "↔",
  euro: "€", pound: "£", yen: "¥", cent: "¢", micro: "µ", infin: "∞",
};

/** `&amp;` → `&`, `&#96;`/`&#x60;` → `` ` ``; null when undecodable. */
export function decodeEntity(raw: string): string | null {
  const m = /^&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));$/.exec(raw);
  if (!m) return null;
  if (m[3] !== undefined) return NAMED_ENTITIES[m[3]] ?? null;
  const code = m[1] !== undefined ? parseInt(m[1], 10) : parseInt(m[2]!, 16);
  if (!Number.isFinite(code) || code === 0 || code > 0x10ffff) return null;
  if (code >= 0xd800 && code <= 0xdfff) return null; // lone surrogate
  return String.fromCodePoint(code);
}

// The openable target of a Link/Image/Autolink element, or null.
function urlOf(doc: DocSlice, el: SyntaxNode): string | null {
  const u = el.getChild("URL");
  return u ? openableUrl(doc.sliceString(u.from, u.to)) : null;
}

// The span of what stays on screen when `el` conceals: an autolink shows its
// URL; a link/image shows the text between its first two marks (`[`/`![` and
// `]`). Null when there is none to show (`![](x.png)`).
function visibleTextSpan(el: SyntaxNode, autolink: boolean): Span | null {
  if (autolink) {
    const u = el.getChild("URL");
    return u ? { from: u.from, to: u.to } : null;
  }
  const marks = el.getChildren("LinkMark");
  const open = marks[0];
  const close = marks[1];
  if (!open || !close || close.from <= open.to) return null;
  return { from: open.to, to: close.from };
}

/**
 * The link element a follow-the-link gesture at `pos` addresses: its span
 * (the reveal unit — what a selection must touch for the link to be showing
 * raw) and its openable URL, or null. Resolves through the tree from both
 * sides of the position so a caret at either edge of a link still counts as
 * "on" it.
 */
export function linkAt(
  doc: DocSlice,
  tree: Tree,
  pos: number,
): (Span & { url: string | null }) | null {
  for (const side of [-1, 1] as const) {
    for (let n: SyntaxNode | null = tree.resolveInner(pos, side); n; n = n.parent) {
      if (LINKISH.has(n.name)) return { from: n.from, to: n.to, url: urlOf(doc, n) };
      if (n.name === "URL" && !(n.parent && LINKISH.has(n.parent.name))) {
        return { from: n.from, to: n.to, url: openableUrl(doc.sliceString(n.from, n.to)) };
      }
    }
  }
  return null;
}

/** The URL a follow-the-link gesture at `pos` should open, or null. */
export function linkTargetAt(doc: DocSlice, tree: Tree, pos: number): string | null {
  return linkAt(doc, tree, pos)?.url ?? null;
}

// --- The view wrappers -------------------------------------------------------

const HIDE = Decoration.replace({});
const FENCE_INFO = Decoration.mark({ class: "ledge-fence-lang" });
// Two openable variants because the gesture differs by reveal state (see
// clickToOpen): a rendered link opens on plain click and gets its hand
// cursor from an overlay hotspot (hotspotPlugin below — in-editor `cursor`
// is unreliable in the WKWebView, the same story as the block buttons); a
// revealed one is raw text under the I-beam that needs ⌘. The data-url on
// the live mark is what the hotspot layer looks for.
const liveLinkMarks = new Map<string, Decoration>();
function liveLink(url: string): Decoration {
  let mark = liveLinkMarks.get(url);
  if (!mark) {
    if (liveLinkMarks.size > 200) liveLinkMarks.clear();
    mark = Decoration.mark({
      class: "ledge-mdlink ledge-mdlink-live",
      attributes: { title: "Click to open link", "data-url": url },
    });
    liveLinkMarks.set(url, mark);
  }
  return mark;
}
const LINK_OPENABLE = Decoration.mark({
  class: "ledge-mdlink",
  attributes: { title: "⌘-click to open link" },
});
const LINK_PLAIN = Decoration.mark({ class: "ledge-mdlink" });
const DONE = Decoration.mark({ class: "ledge-task-done" });

// A concealed task marker, as a real checkbox. The input handles its own
// mousedown (ignoreEvent keeps CodeMirror from treating it as a click into
// the text) and toggles the `[ ]`/`[x]` in the DOCUMENT — the widget never
// owns state, it re-renders from the text like everything else.
class TaskWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  eq(other: TaskWidget) {
    return other.checked === this.checked;
  }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "ledge-task";
    box.checked = this.checked;
    box.title = tooltip("task.toggle");
    box.addEventListener("mousedown", (e) => {
      e.preventDefault();
      toggleTaskAt(view, view.posAtDOM(box));
    });
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

// A `---` line, drawn as a rule. Spans only the line's text (never the line
// break), so it is safe from a ViewPlugin.
class RuleWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "ledge-hrule";
    return el;
  }
}

// An entity, drawn as its decoded character.
class EntityWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(other: EntityWidget) {
    return other.text === this.text;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.textContent = this.text;
    return el;
  }
}

/**
 * Toggle the task marker on `pos`'s line between `[ ]` and `[x]`. False when
 * the line has none. Serves the widget click, and the "Toggle Checkbox"
 * command at the caret.
 */
export function toggleTaskAt(view: EditorView, pos: number): boolean {
  const line = view.state.doc.lineAt(pos);
  let marker: Span | null = null;
  syntaxTree(view.state).iterate({
    from: line.from,
    to: line.to,
    enter(n) {
      if (n.name === "TaskMarker") marker = { from: n.from, to: n.to };
    },
  });
  if (!marker) return false;
  const m: Span = marker;
  const done = /x/i.test(view.state.sliceDoc(m.from, m.to));
  view.dispatch({
    changes: { from: m.from, to: m.to, insert: done ? "[ ]" : "[x]" },
    userEvent: "input",
  });
  return true;
}

function buildDecorations(state: EditorState): DecorationSet {
  const spans = concealments(
    state.doc,
    syntaxTree(state),
    state.selection.ranges,
    frontmatterRange(state),
  );
  const ranges: Range<Decoration>[] = [];
  for (const s of spans) {
    if (s.to <= s.from) continue;
    if (s.kind === "hide") ranges.push(HIDE.range(s.from, s.to));
    else if (s.kind === "fenceInfo") ranges.push(FENCE_INFO.range(s.from, s.to));
    else if (s.kind === "task")
      ranges.push(Decoration.replace({ widget: new TaskWidget(s.checked) }).range(s.from, s.to));
    else if (s.kind === "done") ranges.push(DONE.range(s.from, s.to));
    else if (s.kind === "rule")
      ranges.push(Decoration.replace({ widget: new RuleWidget() }).range(s.from, s.to));
    else if (s.kind === "entity")
      ranges.push(Decoration.replace({ widget: new EntityWidget(s.text) }).range(s.from, s.to));
    else {
      // A link mark whose element the selection is not touching is rendered
      // (concealed links are only ever emitted untouched; bare URLs are
      // emitted always) — plain click opens it, and the tooltip says so.
      const live = s.url !== null && !touches(s, state.selection.ranges);
      ranges.push((s.url ? (live ? liveLink(s.url) : LINK_OPENABLE) : LINK_PLAIN).range(s.from, s.to));
    }
  }
  return Decoration.set(ranges, true);
}

// Rebuilt on selection moves as well as edits — the reveal follows the caret.
// Full-doc like blocks.ts's decoration pass, and cheap for the same reason:
// notes are small, and the parse is already paid for.
const concealPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view.state);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet) this.decorations = buildDecorations(u.state);
    }
  },
  { decorations: (v) => v.decorations },
);

// A RENDERED link opens on plain click — while its syntax conceals it acts
// like a widget, same reasoning as the checkbox: the caret-move grammar
// protects editable text, and what you see isn't the text. A REVEALED link
// (selection touching it — raw syntax showing) is exactly that text being
// edited, so a plain click there stays a caret move and ⌘-click is the
// opener, same grammar as the frontmatter profile name. Mouse-editing a
// rendered link: click anything adjacent (or arrow in), which reveals it.
// Consumes the event only when it actually opens something, so CodeMirror's
// own ⌘-click (add a cursor) survives everywhere else.
const clickToOpen = EditorView.domEventHandlers({
  mousedown: (event, view) => {
    if (event.button !== 0) return false;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null) return false;
    const link = linkAt(view.state.doc, syntaxTree(view.state), pos);
    if (!link?.url) return false;
    if (!event.metaKey && touches(link, view.state.selection.ranges)) return false;
    // Stop the native contenteditable click too: without this the browser
    // still moves the DOM selection, CodeMirror syncs it back, and the
    // caret lands in the link — revealing what the user just followed.
    event.preventDefault();
    openExternal(link.url);
    return true;
  },
});

// --- Cursor hotspots ---------------------------------------------------------
// The hand cursor over rendered links and checkboxes, WKWebView-proof. The
// WebView does not reliably honour `cursor` on anything inside the
// `.cm-editor` editing context (the block buttons hit this first — see the
// overlay comment in blocks.ts); elements OUTSIDE that subtree behave. So a
// body-parented layer pins over the editor and floats one invisible
// `cursor: pointer` div over every rendered link and task checkbox. The
// hotspot also owns the click: open for links, toggle for checkboxes — the
// same actions the in-editor handlers implement, which stay for the engines
// and paths (keyboard, ⌘-click on revealed text) the hotspots do not cover.
interface Hotspot {
  left: number;
  top: number;
  width: number;
  height: number;
  title: string;
  act: () => void;
}

interface HotspotMeasure {
  rect: { top: number; left: number; width: number; height: number };
  spots: Hotspot[];
}

const hotspotPlugin = ViewPlugin.fromClass(
  class {
    layer: HTMLDivElement;
    onScroll: () => void;

    constructor(readonly view: EditorView) {
      this.layer = document.createElement("div");
      this.layer.className = "ledge-linklayer";
      document.body.appendChild(this.layer);
      this.onScroll = () => this.schedule();
      view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
      this.schedule();
    }

    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.geometryChanged || u.selectionSet) {
        this.schedule();
      }
    }

    schedule() {
      this.view.requestMeasure<HotspotMeasure>({
        key: this,
        read: () => this.read(),
        write: (m) => this.write(m),
      });
    }

    read(): HotspotMeasure {
      const view = this.view;
      // A pooled editor for an inactive tab is detached (editorPool.ts):
      // collapse the layer rather than strand hotspots on screen.
      if (!view.dom.isConnected) {
        return { rect: { top: 0, left: 0, width: 0, height: 0 }, spots: [] };
      }
      const base = view.dom.getBoundingClientRect();
      const spots: Hotspot[] = [];
      // Rendered links, inline and in table cells alike, all carry data-url.
      // getClientRects, not getBoundingClientRect: a wrapped link is several
      // boxes, and one big box would blanket the text between them.
      for (const el of view.contentDOM.querySelectorAll<HTMLElement>("[data-url]")) {
        const url = el.dataset.url;
        if (!url) continue;
        for (const r of el.getClientRects()) {
          spots.push({
            left: r.left - base.left,
            top: r.top - base.top,
            width: r.width,
            height: r.height,
            title: "Click to open link",
            act: () => openExternal(url),
          });
        }
      }
      for (const el of view.contentDOM.querySelectorAll<HTMLInputElement>("input.ledge-task")) {
        const r = el.getBoundingClientRect();
        spots.push({
          left: r.left - base.left,
          top: r.top - base.top,
          width: r.width,
          height: r.height,
          title: tooltip("task.toggle"),
          act: () => toggleTaskAt(view, view.posAtDOM(el)),
        });
      }
      return { rect: { top: base.top, left: base.left, width: base.width, height: base.height }, spots };
    }

    write(m: HotspotMeasure) {
      const s = this.layer.style;
      s.top = `${m.rect.top}px`;
      s.left = `${m.rect.left}px`;
      s.width = `${m.rect.width}px`;
      s.height = `${m.rect.height}px`;
      this.layer.textContent = "";
      for (const spot of m.spots) {
        const el = document.createElement("div");
        el.className = "ledge-hotspot";
        el.style.left = `${spot.left}px`;
        el.style.top = `${spot.top}px`;
        el.style.width = `${spot.width}px`;
        el.style.height = `${spot.height}px`;
        el.title = spot.title;
        el.addEventListener("mousedown", (e) => {
          if (e.button !== 0) return;
          // Keep the editor's focus and caret where they are — the hotspot
          // acts, it does not edit.
          e.preventDefault();
          spot.act();
        });
        this.layer.appendChild(el);
      }
    }

    destroy() {
      this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
      this.layer.remove();
    }
  },
);

/** The keyboard/palette path to ⌘-click (the "Open Link" command). */
export function openLinkAtCursor(view: EditorView): boolean {
  const url = linkTargetAt(view.state.doc, syntaxTree(view.state), view.state.selection.main.head);
  if (!url) return false;
  openExternal(url);
  return true;
}

export function livePreview(): Extension {
  return [concealPlugin, clickToOpen, hotspotPlugin];
}
