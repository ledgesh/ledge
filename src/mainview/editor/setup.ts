import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from "@codemirror/commands";
import { acceptCompletion } from "@codemirror/autocomplete";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { toNative } from "./bridge";
import { dispatchDocChanged } from "./docEvents";
import { ledgeBlocks } from "./blocks";
import { ledgeFrontmatter } from "./frontmatter";
import { livePreview } from "./livePreview";
import { tableRendering } from "./tables";
import { imageRendering } from "./images";
import { fenceClose } from "./fences";
import { quoteExit } from "./quotes";
import { listContinuation, tightLists } from "./lists";
import { nascentBullet } from "./setext";
import { appCompletion, wikiLinkExtension } from "./wikilinks";
import { hashtagExtension } from "./tags";
import { wrapping } from "./wrap";
import { formatting } from "./formatting";
import { findReplace } from "./find";
import { fromDisk, sessionIdFacet } from "./session";
import { noteChanged, saveNow } from "../notes/store";
import { copySelection, cutSelection, pasteHere, pastePlain } from "./clipboard";
import { settings } from "../lib/settings";
import { softKeyboard } from "../lib/shell";
import { keyOf } from "../commands/keys";

// Ledge styles raw Markdown, and — since livePreview() landed — conceals the
// markers where the caret is not (editor/livePreview.ts; editor.livePreview
// in settings is the way back to fully-raw). The invariant that survives both
// modes: the text you edit is the text on disk. Concealment is view-time
// decoration only, and code block CONTENT is never touched — a note's code
// has to be exact, so only the fence marks conceal. This HighlightStyle is
// therefore still the whole story for anything revealed or never concealed:
// markers go dim (tags.processingInstruction covers #, **, >, -, `, and the
// ``` fence marks); the content they mark gets the weight. Ported from the
// Swift build's MarkdownTheme. Colors come from CSS vars so the editor tracks
// the OS appearance without a second theme.
// Exported for the one other CodeMirror in the app — the settings editor
// dialog (components/SettingsEditor.tsx) — so its JSONC reads in the same
// palette as code in notes.
export const highlight = HighlightStyle.define([
  { tag: tags.heading1, fontSize: "1.5em", fontWeight: "700" },
  { tag: tags.heading2, fontSize: "1.3em", fontWeight: "700" },
  { tag: tags.heading3, fontSize: "1.15em", fontWeight: "700" },
  { tag: tags.heading4, fontSize: "1.05em", fontWeight: "600" },
  { tag: tags.heading5, fontWeight: "600" },
  { tag: tags.heading6, fontWeight: "600", color: "var(--ed-muted)" },
  { tag: tags.heading, fontWeight: "700" }, // Setext and any unlevelled heading.
  // The one entry styled from index.css instead of here, because it is the one
  // another rule has to be able to name: editor/setext.ts cancels heading
  // weight on a paragraph whose `-` underline is a list marker mid-birth, and
  // CodeMirror emits heading-and-strong as ONE flat span, so without a stable
  // class that cancellation takes real bold down with it.
  { tag: tags.strong, class: "ledge-strong" },
  { tag: tags.emphasis, fontStyle: "italic" },
  // Load-bearing under live preview: with the ~~ marks concealed, the strike
  // itself is the only thing left saying the text is struck.
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.link, color: "var(--link)" },
  { tag: tags.url, color: "var(--ed-muted)" },
  { tag: tags.quote, color: "var(--ed-muted)", fontStyle: "italic" },
  { tag: tags.labelName, color: "var(--ed-muted)" }, // Code-fence language, link labels.
  { tag: tags.contentSeparator, color: "var(--ed-muted)" }, // Thematic break (---).
  // The recessive markers: heading #, list/quote marks, emphasis/code/link marks.
  { tag: tags.processingInstruction, color: "var(--ed-muted)" },

  // Code-block syntax. Fenced blocks are parsed by their language (codeLanguages
  // below), so these colour the nested tokens. Colours are CSS vars (index.css)
  // for light/dark. Note markdown's inline markers above still win where they
  // apply; these only match tokens the code parsers emit.
  { tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword, tags.definitionKeyword, tags.moduleKeyword, tags.modifier], color: "var(--code-keyword)" },
  { tag: [tags.string, tags.special(tags.string), tags.docString, tags.character, tags.escape], color: "var(--code-string)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: "var(--code-comment)", fontStyle: "italic" },
  { tag: [tags.number, tags.integer, tags.float], color: "var(--code-number)" },
  { tag: [tags.bool, tags.null, tags.atom], color: "var(--code-atom)" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.standard(tags.variableName), tags.definition(tags.variableName)], color: "var(--code-function)" },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.tagName], color: "var(--code-type)" },
  { tag: [tags.propertyName, tags.attributeName, tags.special(tags.variableName)], color: "var(--code-property)" },
  { tag: [tags.operator, tags.derefOperator, tags.compareOperator, tags.arithmeticOperator, tags.logicOperator, tags.bitwiseOperator], color: "var(--code-operator)" },
  { tag: [tags.punctuation, tags.separator, tags.bracket, tags.paren, tags.brace, tags.squareBracket, tags.angleBracket], color: "var(--code-punct)" },
  { tag: [tags.meta, tags.annotation], color: "var(--code-meta)" },
  { tag: tags.regexp, color: "var(--code-regexp)" },
  { tag: tags.variableName, color: "var(--code-variable)" },
]);

// Every edit marks the note dirty and arms its autosave debounce (notes/store.ts
// does the throttling; this fires per keystroke). The load that pours a note's
// saved text in at open is annotated fromDisk and skipped, so opening a note is
// not itself an edit that saves it straight back.
const reporting = EditorView.updateListener.of((update) => {
  if (!update.docChanged) return;
  // Every doc change, INCLUDING fromDisk loads, broadcasts to derivers (the
  // Outline panel): a note's text arriving at open is exactly when its
  // headings appear. Only real edits fall through to noteChanged below.
  dispatchDocChanged(update.state.facet(sessionIdFacet));
  if (update.transactions.some((t) => t.annotation(fromDisk))) return;
  noteChanged(update.state.facet(sessionIdFacet), update.state.doc.toString());
});

// App-level shortcuts that bridge out, with key strings sourced from the
// command table (commands/keys.ts) so the editor can never drift from the
// advertised bindings. High precedence so they win over CodeMirror's own.
const appKeymap = Prec.highest(
  keymap.of([
    {
      key: keyOf("terminal.toggle")!,
      run: () => {
        toNative({ type: "toggleTerminal" });
        return true;
      },
    },
    {
      // Notes autosave, so Cmd+S only skips the debounce. It still binds: the
      // habit is universal, and an unhandled Cmd-key rings the AppKit alert.
      key: keyOf("editor.save")!,
      run: (view) => {
        void saveNow(view.state.facet(sessionIdFacet));
        return true;
      },
    },
  ]),
);

// Clipboard, routed through the native bridge (pbcopy/pbpaste). CodeMirror's
// built-in copy/cut/paste rely on the browser's clipboard events, which do not
// work in this non-secure views:// WebView, so we handle the shortcuts
// ourselves. The commands themselves live in editor/clipboard.ts, because the
// editor's context menu runs the same four (interactions.md §11); the keys
// come from the command table like every other advertised binding. High
// precedence so these win over the default copy/cut/paste bindings.
//
// ⌘A is absent deliberately: `editor.selectAll` exists for the menu, but the
// key it advertises is the one CodeMirror's own defaultKeymap already binds.
const clipboardKeymap = Prec.highest(
  keymap.of([
    { key: keyOf("editor.copy")!, run: copySelection },
    { key: keyOf("editor.cut")!, run: cutSelection },
    { key: keyOf("editor.paste")!, run: pasteHere },
    { key: keyOf("editor.pastePlain")!, run: pastePlain },
  ]),
);

// Tab indents, ⇧Tab outdents — the line the caret is on, or every line the
// selection touches. On a list item that is what nests it (the marker moves
// with the line); in prose it is the ordinary indent. Ledge binds it because
// the alternative is what WKWebView does with an unclaimed Tab: move focus out
// of the editor, which in a notebook you type Markdown into is never what the
// key meant.
//
// The cost is the standard one — Tab no longer walks focus out of the editor.
// It is affordable here because nothing in Ledge depends on Tab to move
// focus: every destination is a chord (⌥⌘B sidebar, ⌃` terminal, ⌘1…9,
// ⌃Tab tabs), which is also why the ⌃Tab tab-cycle above is untouched (§2:
// ⌃ is the intra-pane domain).
//
// acceptCompletion runs first so Tab keeps its other universal meaning while
// the `[[` / `#` / frontmatter picker is open: take the highlighted row. It
// returns false with no popup open, so indent is the fallthrough, not a
// special case.
const indentKeymap = keymap.of([
  { key: "Tab", run: acceptCompletion },
  { key: "Tab", run: indentMore, shift: indentLess },
]);

const theme = EditorView.theme({
  // The base font size is a setting, applied per editor in createEditor below
  // rather than here: this theme is module-level and would freeze the value
  // before boot configures the snapshot.
  "&": {
    height: "100%",
    backgroundColor: "transparent",
    color: "var(--fg)",
  },
  ".cm-content": {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    padding: "14px 12px",
    caretColor: "var(--cursor)",
  },
  ".cm-scroller": { lineHeight: "1.5" },
  "&.cm-focused": { outline: "none" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--gutter)",
    border: "none",
  },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--cursor)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "var(--selection)" },
  ".cm-activeLine": { backgroundColor: "transparent" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--fg)" },

  // Find / replace toolbar (our custom panel in editor/find.ts). Styled to the
  // app chrome: shadcn tokens for surfaces/borders, the editor's own vars for
  // hover/muted, so it reads as part of Ledge in light or dark.
  ".cm-panels": {
    backgroundColor: "hsl(var(--background))",
    color: "var(--fg)",
    borderBottom: "1px solid hsl(var(--border))",
  },
  ".ledge-search": {
    padding: "7px 8px",
    fontFamily: "-apple-system, system-ui, sans-serif",
  },
  ".ledge-search-row": { display: "flex", alignItems: "center", gap: "5px" },
  // An explicit display wins over the UA [hidden] rule, so restore it for the
  // collapsed replace row.
  ".ledge-search-row[hidden]": { display: "none" },
  ".ledge-search-row + .ledge-search-row:not([hidden])": { marginTop: "5px" },
  // Left gutter under the chevron that keeps the replace field aligned with find.
  ".ledge-search-gutter": { flex: "0 0 24px" },
  ".ledge-search-field": {
    flex: "0 0 220px",
    minWidth: "0",
    height: "26px",
    padding: "0 8px",
    borderRadius: "6px",
    border: "1px solid hsl(var(--input))",
    backgroundColor: "hsl(var(--background))",
    color: "var(--fg)",
    fontSize: "12px",
    outline: "none",
  },
  ".ledge-search-field:focus": { borderColor: "hsl(var(--ring))" },
  ".ledge-search-btn": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    height: "26px",
    minWidth: "26px",
    padding: "0 8px",
    borderRadius: "6px",
    border: "1px solid hsl(var(--border))",
    backgroundColor: "transparent",
    color: "var(--fg)",
    fontSize: "12px",
    lineHeight: "1",
    cursor: "pointer",
  },
  // Lit state for the "All" toggle (all matches currently selected).
  ".ledge-search-btn.active": {
    backgroundColor: "hsl(var(--primary))",
    color: "hsl(var(--primary-foreground))",
    borderColor: "transparent",
  },
  ".ledge-search-toggle": {
    flex: "0 0 24px",
    padding: "0",
    border: "none",
    color: "var(--ed-muted)",
    fontSize: "14px",
    transition: "transform 0.12s ease",
  },
  ".ledge-search-toggle.open": { transform: "rotate(90deg)" },
  // The middle of the find row, in two nested boxes: `steps` steps through
  // matches, `toggles` changes what counts as one, and `opts` holds both. All
  // three are invisible on a pointer client — the gaps inside them are the
  // row's own, so every control sits exactly where it did as a loose child —
  // and they are what the touch block below moves as units instead of leaving
  // six buttons to break wherever the arithmetic lands.
  ".ledge-search-opts": { display: "inline-flex", alignItems: "center", gap: "5px" },
  ".ledge-search-steps": { display: "inline-flex", alignItems: "center", gap: "5px" },
  ".ledge-search-toggles": { display: "inline-flex", alignItems: "center", gap: "3px", marginLeft: "2px" },
  ".ledge-search-check": {
    display: "inline-flex",
    alignItems: "center",
    gap: "3px",
    height: "26px",
    padding: "0 6px",
    borderRadius: "6px",
    fontSize: "11px",
    color: "var(--ed-muted)",
    cursor: "pointer",
    userSelect: "none",
  },
  ".ledge-search-check input": { margin: "0", cursor: "pointer" },
  ".ledge-search-close": {
    marginLeft: "auto",
    border: "none",
    color: "var(--ed-muted)",
    fontSize: "16px",
  },

  // Every hover in this panel, behind the feature that says a pointer can
  // hover. Tailwind's `hoverOnlyWhenSupported` does this for the rest of the
  // app and does not reach here (interactions.md §1a), and §1a calls the rule a
  // correctness one rather than a cosmetic one: iOS sends a synthetic mousemove
  // ahead of the click of every tap, and WebKit WITHHOLDS that click when the
  // mousemove changed the rendering, so an ungated hover spends the first tap
  // painting itself. A phone screenshot showed the chevron wearing its hover
  // background with nothing hovering it, which is the same defect the tab
  // strip's ✕ had.
  "@media (hover: hover)": {
    ".ledge-search-btn:hover": { backgroundColor: "var(--btn-hover)" },
    ".ledge-search-btn.active:hover": { backgroundColor: "hsl(var(--primary))" },
    ".ledge-search-check:hover": { backgroundColor: "var(--btn-hover)" },
    ".ledge-search-close:hover": { color: "var(--fg)" },
  },

  // The same toolbar for a finger (interactions.md §1a, ios.md §14).
  //
  // None of the app's `touch:` rules reach any of the above. This panel is
  // built by hand in editor/find.ts and themed here, in a JS style object, so
  // Tailwind never sees it — which is how it stayed a 26-point row at every
  // width while the rest of the chrome grew. At 390 points that row measured
  // 508 wide, and the × that closes it sat past the right edge of a container
  // that does not scroll. Escape closes the panel too (find.ts's keymap), and a
  // phone has no key to press. So Find could be opened here and not closed.
  //
  // The fix is the layout rather than a smaller ×, and it is two rows STATED
  // rather than two rows that happened. The find row is the field between the
  // chevron and the ×, and everything else is under it. Nothing here is a phone
  // layout: it is the same arrangement at 320 points and at 1024, because the
  // break is an element rather than a sum. The first version left it to the sum
  // and it was two tidy rows at 390 and, at 430, a × stranded mid-row between
  // the field and the arrows with the checkboxes orphaned below. Everything is
  // 44 (§1a).
  "@media (hover: none)": {
    ".ledge-search": { padding: "8px" },
    ".ledge-search-row": { flexWrap: "wrap", gap: "6px" },
    ".ledge-search-row + .ledge-search-row:not([hidden])": { marginTop: "6px" },
    // Basis 0 and grow: the field is whatever the row has left, which is the
    // whole width minus two 44s at any size.
    ".ledge-search-field": { flex: "1 1 0", height: "44px", fontSize: "16px" },
    ".ledge-search-btn": { height: "44px", minWidth: "44px" },
    ".ledge-search-toggle": { flex: "0 0 44px", fontSize: "20px" },
    ".ledge-search-close": { fontSize: "20px" },
    // The chevron, the × and the three checkboxes are borderless on a pointer
    // client because a hover is what finds them: their resting state is a
    // rectangle of nothing, and moving the mouse over it is how you learn where
    // it starts and stops. Nothing hovers here, so a resting state is the only
    // state there is, and without a box the second row read as three buttons
    // and three specks floating beside them. All six take the same box, which
    // is also what makes the exit above read as a button rather than a glyph.
    ".ledge-search-toggle, .ledge-search-close, .ledge-search-check": {
      border: "1px solid hsl(var(--border))",
    },
    // Under the chevron, so the replace field still starts where find does.
    ".ledge-search-gutter": { flex: "0 0 44px" },
    // The break. Full width puts the options on their own row wherever the row
    // above ends, and the order puts them after the ×, which is what keeps the
    // exit on the first row instead of trailing six buttons.
    ".ledge-search-opts": { order: "1", flexBasis: "100%", flexWrap: "wrap", gap: "6px" },
    ".ledge-search-steps": { gap: "6px" },
    ".ledge-search-toggles": { gap: "6px" },
    ".ledge-search-check": {
      height: "44px",
      minWidth: "44px",
      justifyContent: "center",
      fontSize: "13px",
    },
    // The box stays a box: the label around it is the 44, and the tick only has
    // to be legible at arm's length rather than hittable on its own.
    ".ledge-search-check input": { width: "16px", height: "16px" },
  },

  // The `[[` completion popup (editor/wikilinks.ts), styled to the app chrome
  // like the find panel above: shadcn surface tokens, the palette's row
  // rhythm, so the picker reads as Ledge and not as CodeMirror's default.
  ".cm-tooltip.cm-tooltip-autocomplete": {
    backgroundColor: "hsl(var(--card))",
    color: "hsl(var(--card-foreground))",
    border: "1px solid hsl(var(--border))",
    borderRadius: "8px",
    overflow: "hidden",
    boxShadow: "0 8px 24px rgb(0 0 0 / 0.18)",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    fontFamily: "-apple-system, system-ui, sans-serif",
    fontSize: "12px",
    maxHeight: "12em",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
    padding: "3px 10px",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "hsl(var(--accent))",
    color: "hsl(var(--accent-foreground))",
  },
});

// Build a fully-wired editor into `parent`, seeded with `doc`. `sessionId` is the
// note's docId; it rides in a facet so a block run can target this note's shell.
// `readOnly` is the docs-workspace editor (workspace/editorPool.ts decides, by
// the tab's folder kind): the SAME editor — caret, selection, ⌘C, find, live
// preview, and crucially runnable blocks all still work — with every
// doc-changing transaction that is not a disk load dropped at the filter.
// Dropping at the transaction layer rather than EditorView.editable is
// deliberate twice over: an uneditable DOM would also refuse focus, which
// would take ⌘↩ (and find, and copy) down with it; and our own programmatic
// edits (formatting chords, checkbox toggles, frontmatterEdit) do not consult
// the readOnly facet, so a filter is the only fence they cannot step over.
// With no edit ever landing, nothing marks the note dirty and nothing
// autosaves — the Bun-side write refusal (bun/workspaces.ts
// assertWritableRoot) stays the enforcement of record; this is what makes the
// refusal unreachable in normal use.
//
// The one client that gives the focus up is the one whose keyboard is on
// screen (lib/shell.ts softKeyboard). All three things focus was kept FOR are
// chords, and a phone can type none of them: a software keyboard has no ⌘ for
// ⌘↩, none for find and none for ⌘C, and iOS selects and copies uneditable text
// natively anyway. What is left is the cost — tapping
// the manual raises a keyboard over half of it, to type into a document that
// drops every edit — so there `editable` goes off and the contentDOM stops
// being a text field.
export function createEditor(parent: HTMLElement, doc: string, sessionId: string, readOnly = false): EditorView {
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        sessionIdFacet.of(sessionId),
        readOnly
          ? [
              EditorState.readOnly.of(true), // standard commands no-op cleanly
              EditorState.transactionFilter.of((tr) =>
                tr.docChanged && !tr.annotation(fromDisk) ? [] : tr,
              ),
              softKeyboard() ? EditorView.editable.of(false) : [],
            ]
          : [],
        history(),
        drawSelection(),
        lineNumbers(),
        wrapping(),
        // A lone `-` under a paragraph is a Setext underline, and also the
        // first keystroke of a bullet list — this withholds the heading
        // styling while the caret is still on it (editor/setext.ts). Not gated
        // by livePreview: raw markdown styles its headings too.
        nascentBullet(),
        findReplace(),
        appKeymap,
        clipboardKeymap,
        indentKeymap,
        // ⌘B/⌘I/⌘K (editor/formatting.ts). Editing behavior like quoteExit:
        // not gated by livePreview — raw markdown toggles the same markers.
        formatting(),
        ledgeBlocks(),
        ledgeFrontmatter(),
        // The settings knob is the escape hatch back to fully-raw markdown
        // (see the Settings comment in shared/settings.ts). Read at creation
        // like fontSize below: settings apply at launch, never live.
        // tableRendering and imageRendering are livePreview's block-level
        // halves (editor/tables.ts, editor/images.ts) — separate modules
        // because block widgets need a StateField, same knob because they are
        // the same feature.
        settings().editor.livePreview ? [livePreview(), tableRendering(), imageRendering()] : [],
        // Before markdown(): both bind Enter at Prec.high, and this one must
        // see an empty quote line first (editor/quotes.ts). Not gated by
        // livePreview — it is editing behavior, not rendering.
        quoteExit(),
        // Shift+Enter continues a list item under its text, and Enter clears
        // the indent-only line that leaves behind (editor/lists.ts). Same
        // Prec.high band as quoteExit, disjoint from it by line shape.
        listContinuation(),
        // Enter on an unterminated `---` (line 1) or ``` opener inserts the
        // closing fence (editor/fences.ts). Editing behavior like quoteExit,
        // so not gated by livePreview either.
        fenceClose(),
        // Behind fenceClose deliberately (a fence opener inside a list item is
        // the fence's Enter, not the list's), still ahead of markdown() whose
        // Enter binding this displaces: same command, loose-list branch off.
        tightLists(),
        // The `[[` note picker and the `#` tag picker (editor/wikilinks.ts +
        // editor/tags.ts, one autocompletion). Editing behavior like
        // quoteExit, so not gated by livePreview: a raw-markdown editor still
        // completes titles and tags — they just draw as text there.
        appCompletion(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        // wikiLinkExtension and hashtagExtension teach the parser `[[...]]`
        // and `#tag` so both are real tree nodes in both modes; livePreview
        // owns their styling.
        markdown({
          base: markdownLanguage,
          codeLanguages: languages,
          extensions: [wikiLinkExtension, hashtagExtension],
        }),
        syntaxHighlighting(highlight),
        theme,
        EditorView.theme({ "&": { fontSize: `${settings().editor.fontSize}px` } }),
        reporting,
      ],
    }),
  });
}
