import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { toNative } from "./bridge";
import { ledgeBlocks, handleRunEvent, failAllRuns, clearRunsEffect } from "./blocks";

declare global {
  interface Window {
    ledge: {
      setText(text: string): void;
      focus(): void;
      runEvent(id: string, kind: string, payload: unknown): void;
      sessionEnded(): void;
    };
  }
}

// Syntax colors that read as "styled plain text", using the OS label colors so
// the editor tracks light/dark without us shipping two themes.
const highlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: "600" },
  { tag: tags.strong, fontWeight: "600" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: [tags.monospace], fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
  { tag: [tags.link, tags.url], color: "var(--link)" },
  { tag: tags.quote, color: "var(--muted)" },
]);

// Report focus and every document change up to the native side. `updateListener`
// fires for any transaction; we only care about doc edits and focus changes.
let suppressChange = false;
const reporting = EditorView.updateListener.of((update) => {
  if (update.docChanged && !suppressChange) {
    toNative({ type: "textChanged", text: update.state.doc.toString() });
  }
  if (update.focusChanged && update.view.hasFocus) {
    toNative({ type: "focus" });
  }
});

// App-level shortcuts that bridge to native. High precedence so they win over
// CodeMirror's own bindings. Run shortcuts arrive in Phase 2 with block parsing.
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

const view = new EditorView({
  parent: document.getElementById("editor")!,
  state: EditorState.create({
    doc: "",
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

// Native -> web API.
window.ledge = {
  setText(text: string) {
    if (text === view.state.doc.toString()) return;
    // Replace the whole document without echoing it straight back to native.
    suppressChange = true;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      effects: clearRunsEffect.of(null),
    });
    suppressChange = false;
  },
  focus() {
    view.focus();
  },
  runEvent(id: string, kind: string, payload: unknown) {
    handleRunEvent(view, id, kind, payload);
  },
  sessionEnded() {
    failAllRuns(view);
  },
};

// Tell native the editor is mounted and ready for its initial content.
toNative({ type: "ready" });
