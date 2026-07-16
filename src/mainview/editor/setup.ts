import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { toNative } from "./bridge";
import { ledgeBlocks } from "./blocks";
import { wrapping } from "./wrap";
import { findReplace } from "./find";
import { copyText, readClipboard } from "../lib/clipboard";

// Ledge shows raw Markdown and styles it, rather than hiding the syntax the way
// a live-preview editor does: the text you edit is the text on disk, which
// matters when a note's code blocks have to be exact. So the markers stay
// visible and go dim (tags.processingInstruction covers #, **, >, -, `, and the
// ``` fence marks); the content they mark gets the weight. Ported from the Swift
// build's MarkdownTheme. Colors come from CSS vars so the editor tracks the OS
// appearance without a second theme.
const highlight = HighlightStyle.define([
  { tag: tags.heading1, fontSize: "1.5em", fontWeight: "700" },
  { tag: tags.heading2, fontSize: "1.3em", fontWeight: "700" },
  { tag: tags.heading3, fontSize: "1.15em", fontWeight: "700" },
  { tag: tags.heading4, fontSize: "1.05em", fontWeight: "600" },
  { tag: tags.heading5, fontWeight: "600" },
  { tag: tags.heading6, fontWeight: "600", color: "var(--ed-muted)" },
  { tag: tags.heading, fontWeight: "700" }, // Setext and any unlevelled heading.
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
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

// Report focus and every document change up to the bridge. `updateListener`
// fires for any transaction; we only care about doc edits and focus changes.
// (Both are no-ops in this build until note persistence lands; wiring them now
// keeps the editor code identical to the note-backed version.)
const reporting = EditorView.updateListener.of((update) => {
  if (update.docChanged) {
    toNative({ type: "textChanged", text: update.state.doc.toString() });
  }
  if (update.focusChanged && update.view.hasFocus) {
    toNative({ type: "focus" });
  }
});

// App-level shortcuts that bridge out. High precedence so they win over
// CodeMirror's own bindings.
const appKeymap = Prec.highest(
  keymap.of([
    {
      key: "Ctrl-`",
      run: () => {
        toNative({ type: "toggleTerminal" });
        return true;
      },
    },
  ]),
);

// Clipboard, routed through the native bridge (pbcopy/pbpaste). CodeMirror's
// built-in copy/cut/paste rely on the browser's clipboard events, which do not
// work in this non-secure views:// WebView, so we handle the shortcuts ourselves.
// Each command returns true so CodeMirror consumes the key event: that both
// blocks the broken native path and stops the unhandled Cmd-key from reaching
// AppKit, which would otherwise ring the system alert. High precedence so these
// win over the default copy/cut/paste bindings.
function selectedText(view: EditorView): string {
  return view.state.selection.ranges.map((r) => view.state.sliceDoc(r.from, r.to)).join("\n");
}

const clipboardKeymap = Prec.highest(
  keymap.of([
    {
      key: "Mod-c",
      run: (view) => {
        const text = selectedText(view);
        if (text) copyText(text);
        return true;
      },
    },
    {
      key: "Mod-x",
      run: (view) => {
        const text = selectedText(view);
        if (text) {
          copyText(text);
          view.dispatch(view.state.replaceSelection(""));
        }
        return true;
      },
    },
    {
      key: "Mod-v",
      run: (view) => {
        void readClipboard().then((text) => {
          if (text) view.dispatch(view.state.replaceSelection(text));
        });
        return true;
      },
    },
  ]),
);

const theme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "transparent",
    color: "var(--fg)",
    fontSize: "14px",
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
  ".ledge-search-btn:hover": { backgroundColor: "var(--btn-hover)" },
  // Lit state for the "All" toggle (all matches currently selected).
  ".ledge-search-btn.active": {
    backgroundColor: "hsl(var(--primary))",
    color: "hsl(var(--primary-foreground))",
    borderColor: "transparent",
  },
  ".ledge-search-btn.active:hover": { backgroundColor: "hsl(var(--primary))" },
  ".ledge-search-toggle": {
    flex: "0 0 24px",
    padding: "0",
    border: "none",
    color: "var(--ed-muted)",
    fontSize: "14px",
    transition: "transform 0.12s ease",
  },
  ".ledge-search-toggle.open": { transform: "rotate(90deg)" },
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
  ".ledge-search-check:hover": { backgroundColor: "var(--btn-hover)" },
  ".ledge-search-check input": { margin: "0", cursor: "pointer" },
  ".ledge-search-close": {
    marginLeft: "auto",
    border: "none",
    color: "var(--ed-muted)",
    fontSize: "16px",
  },
  ".ledge-search-close:hover": { color: "var(--fg)" },
});

// Build a fully-wired editor into `parent`, seeded with `doc`.
export function createEditor(parent: HTMLElement, doc: string): EditorView {
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        history(),
        drawSelection(),
        lineNumbers(),
        wrapping(),
        findReplace(),
        appKeymap,
        clipboardKeymap,
        ledgeBlocks(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        syntaxHighlighting(highlight),
        theme,
        reporting,
      ],
    }),
  });
}
