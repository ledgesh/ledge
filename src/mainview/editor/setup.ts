import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from "@codemirror/commands";
import { acceptCompletion } from "@codemirror/autocomplete";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import type { MarkdownConfig } from "@lezer/markdown";
import { languages } from "@codemirror/language-data";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { styleTags, Tag, tags } from "@lezer/highlight";
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
import { copySelection, cutSelection, pasteEvent, pasteHere, pastePlain } from "./clipboard";
import { settings } from "../lib/settings";
import { softKeyboard } from "../lib/shell";
import { keyOf } from "../commands/keys";

// Inline code gets a tag nothing else uses. @lezer/markdown gives `InlineCode`
// and a fence's `CodeText` the same tags.monospace, so styling that tag would
// also paint inside every fence whose language the highlighter does not know
// (fences have their own card in index.css). The backtick CodeMark children
// keep processingInstruction, so the marks stay dim, and hidden under live
// preview, while the text between them takes the chip.
const inlineCodeTag = Tag.define();
const inlineCodeExtension: MarkdownConfig = {
  props: [styleTags({ InlineCode: inlineCodeTag })],
};

// The highlight theme for raw Markdown, and for everything live preview
// reveals or never conceals (editor/livePreview.ts; the editor.livePreview
// setting turns it off). Concealment is view-time decoration only: the
// document keeps every marker, so the text edited is the text on disk. A
// fence's marks conceal and its code never does, because a note's code has to
// be exact. Markers go dim (tags.processingInstruction covers #, **, >, -, `,
// and the ``` fence marks) and the content they mark gets the weight. Colors
// come from CSS vars, so the editor follows the OS appearance without a second
// theme. Ported from the Swift build's MarkdownTheme.
// Exported for the app's other CodeMirror, the settings editor dialog
// (components/SettingsEditor.tsx), so its JSONC reads in the same palette.
export const highlight = HighlightStyle.define([
  { tag: tags.heading1, fontSize: "1.5em", fontWeight: "700" },
  { tag: tags.heading2, fontSize: "1.3em", fontWeight: "700" },
  { tag: tags.heading3, fontSize: "1.15em", fontWeight: "700" },
  { tag: tags.heading4, fontSize: "1.05em", fontWeight: "600" },
  { tag: tags.heading5, fontWeight: "600" },
  { tag: tags.heading6, fontWeight: "600", color: "var(--ed-muted)" },
  { tag: tags.heading, fontWeight: "700" }, // Setext and any unlevelled heading.
  // Styled from index.css rather than here, so another rule can name the
  // class. editor/setext.ts cancels heading weight on a paragraph whose `-`
  // underline is the start of a list item, and CodeMirror emits a span that is
  // both heading and strong as one flat class list, so without a stable class
  // that cancellation would take real bold down with it.
  { tag: tags.strong, class: "ledge-strong" },
  { tag: tags.emphasis, fontStyle: "italic" },
  // With the backticks concealed, the chip is the only thing left marking the
  // text as code. Same reason as the strike below.
  { tag: inlineCodeTag, class: "ledge-inline-code" },
  // Under live preview the ~~ marks are concealed, so the strike itself is the
  // only thing left marking the text as struck.
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.link, color: "var(--link)" },
  { tag: tags.url, color: "var(--ed-muted)" },
  { tag: tags.quote, color: "var(--ed-muted)", fontStyle: "italic" },
  { tag: tags.labelName, color: "var(--ed-muted)" }, // Code-fence language, link labels.
  { tag: tags.contentSeparator, color: "var(--ed-muted)" }, // Thematic break (---).
  // The dim markers: heading #, list/quote marks, emphasis/code/link marks.
  { tag: tags.processingInstruction, color: "var(--ed-muted)" },

  // Code-block syntax. Fenced blocks are parsed by their language
  // (codeLanguages below), so these color the nested tokens. Colors are CSS
  // vars (index.css) for light and dark. The markdown inline markers above
  // still win where they apply; these only match tokens the code parsers emit.
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
// does the throttling; this fires per keystroke). The transaction that loads a
// note's saved text at open is annotated fromDisk and skipped, so opening a
// note is not itself an edit that saves it straight back.
const reporting = EditorView.updateListener.of((update) => {
  if (!update.docChanged) return;
  // Every doc change, fromDisk loads included, broadcasts to derivers (the
  // Outline panel): a note's headings appear when its text arrives at open.
  // Only real edits fall through to noteChanged below.
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
      // Notes autosave, so Cmd+S only skips the debounce. The binding stays
      // because the habit is universal, and an unhandled Cmd key rings the
      // AppKit alert.
      key: keyOf("editor.save")!,
      run: (view) => {
        void saveNow(view.state.facet(sessionIdFacet));
        return true;
      },
    },
  ]),
);

// Clipboard, routed through the native bridge (pbcopy/pbpaste). CodeMirror's
// built-ins rely on browser clipboard events, which do not work in this
// non-secure views:// WebView, so these bindings take the shortcuts instead.
// The commands live in editor/clipboard.ts because the editor's context menu
// runs the same four (interactions.md §11); the keys come from the command
// table. High precedence, so these win over the default copy/cut/paste
// bindings.
//
// ⌘A is absent: `editor.selectAll` exists for the menu, and the key it
// advertises is already bound by CodeMirror's own defaultKeymap.
const clipboardKeymap = Prec.highest(
  keymap.of([
    { key: keyOf("editor.copy")!, run: copySelection },
    { key: keyOf("editor.cut")!, run: cutSelection },
    { key: keyOf("editor.paste")!, run: pasteHere },
    { key: keyOf("editor.pastePlain")!, run: pastePlain },
  ]),
);

// Tab indents and ⇧Tab outdents: the line the caret is on, or every line the
// selection touches. On a list item, indenting nests it (the marker moves with
// the line); in prose it is the ordinary indent. Ledge binds the key because
// WKWebView's answer to an unclaimed Tab is to move focus out of the editor,
// which is not what the key means in a Markdown notebook.
//
// The cost is that Tab no longer walks focus out. Nothing in Ledge depends on
// it for that: every destination is a chord (⌥⌘B sidebar, ⌃` terminal, ⌘1…9,
// ⌃Tab tabs), which is also why the ⌃Tab tab cycle above is untouched
// (interactions.md §2: ⌃ is the intra-pane domain).
//
// acceptCompletion runs first, so Tab keeps its other meaning while the `[[`,
// `#`, or frontmatter picker is open: take the highlighted row. It returns
// false with no popup open, so indent is the fallthrough, not a special case.
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

  // Find and replace toolbar (the custom panel in editor/find.ts). Styled to
  // the app chrome: shadcn tokens for surfaces and borders, the editor's own
  // vars for hover and muted, so it matches Ledge in light or dark.
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
  // matches, `toggles` changes what counts as one, and `opts` holds both. On a
  // pointer client all three are invisible: their gaps are the row's own, so
  // every control sits where it did as a loose child. The touch block below
  // moves them as units rather than wrapping six loose buttons.
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

  // Every hover in this panel sits behind the pointer-can-hover query.
  // Tailwind's `hoverOnlyWhenSupported` does this for the rest of the app and
  // does not reach here. The rule is correctness, not cosmetics: an ungated
  // hover spends a phone's first tap painting itself (interactions.md §1a has
  // the WebKit mechanism). The chevron showed its hover background on a phone
  // with nothing hovering it, the same defect the tab strip's ✕ had.
  "@media (hover: hover)": {
    ".ledge-search-btn:hover": { backgroundColor: "var(--btn-hover)" },
    ".ledge-search-btn.active:hover": { backgroundColor: "hsl(var(--primary))" },
    ".ledge-search-check:hover": { backgroundColor: "var(--btn-hover)" },
    ".ledge-search-close:hover": { color: "var(--fg)" },
  },

  // The same toolbar for a finger (interactions.md §1a, ios.md §14).
  //
  // None of the app's `touch:` rules reach the styles above: this panel is
  // built by hand in editor/find.ts and themed here in a JS style object, so
  // Tailwind never sees it. It stayed a 26-point row at every width while the
  // rest of the chrome grew. At 390 points that row measured 508 wide, and the
  // × that closes it sat past the right edge of a container that does not
  // scroll. Escape closes the panel too (find.ts's keymap), and a phone has no
  // key to press. So Find could be opened here and not closed.
  //
  // The fix is the layout rather than a smaller ×. The `opts` rule below gives
  // that box the full width, so the row breaks at an element rather than at a
  // sum of widths: the find row is the field between the chevron and the ×,
  // and everything else goes under it. The arrangement is the same at 320
  // points and at 1024. Leaving the break to the widths gave two tidy rows at
  // 390 and, at 430, a × stranded mid-row between the field and the arrows
  // with the checkboxes orphaned below. Every target is 44 points (§1a).
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
    // client, where hovering them is what shows their bounds. Touch has no
    // hover, and without a box the second row read as three buttons and three
    // specks beside them. All five take the same box here, which also makes
    // the × read as a button rather than a glyph.
    ".ledge-search-toggle, .ledge-search-close, .ledge-search-check": {
      border: "1px solid hsl(var(--border))",
    },
    // Under the chevron, so the replace field still starts where find does.
    ".ledge-search-gutter": { flex: "0 0 44px" },
    // The break. Full width puts the options on their own row wherever the row
    // above ends, and the order puts them after the ×, which keeps the × on
    // the first row instead of trailing six buttons.
    ".ledge-search-opts": { order: "1", flexBasis: "100%", flexWrap: "wrap", gap: "6px" },
    ".ledge-search-steps": { gap: "6px" },
    ".ledge-search-toggles": { gap: "6px" },
    ".ledge-search-check": {
      height: "44px",
      minWidth: "44px",
      justifyContent: "center",
      fontSize: "13px",
    },
    // The box stays 16 points, inside a 44-point label: the label is the
    // target, so the tick only has to be legible, not hittable on its own.
    ".ledge-search-check input": { width: "16px", height: "16px" },
  },

  // The `[[` completion popup (editor/wikilinks.ts), styled to the app chrome
  // like the find panel above: shadcn surface tokens and the palette's row
  // spacing, so the picker matches Ledge rather than CodeMirror's default.
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

// Build a fully-wired editor into `parent`, seeded with `doc`. `sessionId` is
// the note's docId; it rides in a facet so a block run can target this note's
// shell. `readOnly` marks the docs-workspace editor (workspace/editorPool.ts
// passes it, from the tab's folder kind): the same editor, with caret,
// selection, ⌘C, find, live preview and runnable blocks all still working, and
// every doc-changing transaction that is not a disk load dropped at the filter.
//
// The drop is at the transaction layer rather than at EditorView.editable for
// two reasons. An uneditable DOM would also refuse focus, taking ⌘↩, find and
// copy with it. And Ledge's own programmatic edits (formatting chords,
// checkbox toggles, frontmatterEdit) do not consult the readOnly facet, so the
// filter is the only guard they cannot step over. No edit lands, so nothing
// marks the note dirty and nothing autosaves, which leaves the Bun-side write
// refusal (bun/workspaces.ts assertWritableRoot, the enforcement of record)
// unreachable in normal use.
//
// The one client that gives up the focus is the one whose keyboard is on
// screen: the focus costs half the page and buys only chords a phone cannot
// type (interactions.md §1a; lib/shell.ts softKeyboard). There `editable` goes
// off and the contentDOM stops being a text field.
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
        // first keystroke of a bullet list. This withholds the heading styling
        // while the caret is still on it (editor/setext.ts). Not gated by
        // livePreview: raw markdown styles its headings too.
        nascentBullet(),
        findReplace(),
        appKeymap,
        clipboardKeymap,
        // The platform's paste event, which a phone's callout Paste raises and
        // which carries nothing on a Mac (editor/clipboard.ts pasteEvent).
        pasteEvent,
        indentKeymap,
        // ⌘B/⌘I/⌘K (editor/formatting.ts). Editing behavior like quoteExit, so
        // not gated by livePreview: raw markdown toggles the same markers.
        formatting(),
        ledgeBlocks(),
        ledgeFrontmatter(),
        // The editor.livePreview setting is the way back to fully-raw markdown
        // (the Settings comment in shared/settings.ts). Read at creation like
        // fontSize below: settings apply at launch, never live. tableRendering
        // and imageRendering are livePreview's block-level halves
        // (editor/tables.ts, editor/images.ts), separate modules because block
        // widgets need a StateField, on one setting because they are one
        // feature.
        settings().editor.livePreview ? [livePreview(), tableRendering(), imageRendering()] : [],
        // Before markdown(): both bind Enter at Prec.high, and this one must
        // see an empty quote line first (editor/quotes.ts). Not gated by
        // livePreview: it is editing behavior, not rendering.
        quoteExit(),
        // Shift+Enter continues a list item under its text, and Enter clears
        // the indent-only line that leaves behind (editor/lists.ts). Same
        // Prec.high band as quoteExit, disjoint from it by line shape.
        listContinuation(),
        // Enter on an unterminated `---` (line 1) or ``` opener inserts the
        // closing fence (editor/fences.ts). Editing behavior like quoteExit,
        // so not gated by livePreview either.
        fenceClose(),
        // Behind fenceClose, so a fence opener inside a list item takes the
        // fence's Enter and not the list's. Still ahead of markdown(), whose
        // Enter binding this displaces: the same command with the loose-list
        // branch off.
        tightLists(),
        // The `[[` note picker and the `#` tag picker (editor/wikilinks.ts and
        // editor/tags.ts, one autocompletion). Editing behavior like quoteExit,
        // so not gated by livePreview: a raw-markdown editor still completes
        // titles and tags, and they draw as text there.
        appCompletion(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        // wikiLinkExtension and hashtagExtension teach the parser `[[...]]`
        // and `#tag`, so both are real tree nodes in either mode; livePreview
        // owns their styling. inlineCodeExtension adds no syntax: it re-tags a
        // node the base parser already produces (above).
        markdown({
          base: markdownLanguage,
          codeLanguages: languages,
          extensions: [wikiLinkExtension, hashtagExtension, inlineCodeExtension],
        }),
        syntaxHighlighting(highlight),
        theme,
        EditorView.theme({ "&": { fontSize: `${settings().editor.fontSize}px` } }),
        reporting,
      ],
    }),
  });
}
