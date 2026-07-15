import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { toNative } from "./bridge";
import { ledgeBlocks } from "./blocks";

// Syntax colors that read as "styled plain text", using the OS label colors so
// the editor tracks light/dark without us shipping two themes.
const highlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: "600" },
  { tag: tags.strong, fontWeight: "600" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: [tags.monospace], fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
  { tag: [tags.link, tags.url], color: "var(--link)" },
  { tag: tags.quote, color: "var(--ed-muted)" },
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
        appKeymap,
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
