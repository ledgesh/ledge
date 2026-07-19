// The settings editor: a modal CodeMirror over settings.jsonc, raw text.
//
// "The file is the UI" (architecture.md §6) used to mean ⌘, handed the file
// to the OS editor; now the file opens in Ledge itself — the same in-app-
// dialog move as ProfileEditor, but where profiles got structured KEY=value
// rows, settings keep the text. The file's comments ARE its documentation
// (SETTINGS_TEMPLATE), so the one job here is showing them well: JSONC
// highlighting in the note editor's own palette, and nothing between the user
// and the bytes. What is deliberately kept from the old path: the text saved
// is the text on disk, byte for byte, and a mid-edit save is never refused —
// validation ADVISES here (the problems strip below mirrors what launch would
// warn) but only launch-time parsing decides, per field, gently.
//
// Restart-applies still holds (architecture.md §6): Save writes the file and
// closes; nothing re-reads settings until the next launch, and the footer
// says so rather than pretending otherwise.
import { useEffect, useRef, useState } from "react";
import { EditorState, Prec } from "@codemirror/state";
import { drawSelection, EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { json } from "@codemirror/legacy-modes/mode/javascript";
import { Button } from "@/components/ui/button";
import { pushLayer } from "@/commands/layers";
import { copyText, readClipboard } from "@/lib/clipboard";
import { readSettingsFile, settings, writeSettingsFile } from "@/lib/settings";
import { highlight } from "@/editor/setup";
import { stripJsonc } from "../../shared/jsonc";
import { parseSettings } from "../../shared/settings";

// Clipboard, routed through the native bridge like the note editor's
// (editor/setup.ts says why: the views:// webview's clipboard events are
// broken, and returning true keeps the unhandled Cmd-key from ringing
// AppKit). Text-only — unlike a note, settings have no image-paste story.
const clipboardKeymap = Prec.highest(
  keymap.of([
    {
      key: "Mod-c",
      run: (view) => {
        const text = view.state.selection.ranges
          .map((r) => view.state.sliceDoc(r.from, r.to))
          .join("\n");
        if (text) copyText(text);
        return true;
      },
    },
    {
      key: "Mod-x",
      run: (view) => {
        const text = view.state.selection.ranges
          .map((r) => view.state.sliceDoc(r.from, r.to))
          .join("\n");
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

// The launch-time verdict on this text, previewed live: the exact problems
// loadSettings would warn about (same stripper, same validator), or the one
// whole-file message when it does not parse at all. Advisory only — Save
// never gates on it.
function problemsOf(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(text));
  } catch (err) {
    return [`Not valid JSONC — the app would run on defaults: ${err instanceof Error ? err.message : String(err)}`];
  }
  return parseSettings(parsed).problems;
}

export function SettingsEditor({ onClose }: { onClose: () => void }) {
  // null while the file loads; the dialog frame shows immediately so the
  // command feels instant even if the RPC round trip does not.
  const [text, setText] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    let alive = true;
    void readSettingsFile().then((t) => {
      if (!alive) return;
      setText(t);
      setProblems(problemsOf(t));
    });
    return () => {
      alive = false;
    };
  }, []);

  // Escape via the shared layer stack, like every modal (interactions.md §6).
  useEffect(() => pushLayer("dialog", onClose), [onClose]);

  const save = async () => {
    const view = viewRef.current;
    if (!view) return;
    await writeSettingsFile(view.state.doc.toString());
    onClose();
  };
  // The CM keymap closure is built once; reach the current save through a ref.
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    if (text === null || !hostRef.current) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: text,
        extensions: [
          history(),
          clipboardKeymap,
          // Like the note editor: drawSelection paints the caret and
          // selection itself (.cm-cursor below) — the native caret is styled
          // for light mode by CM's base theme and vanishes on the dark
          // dialog surface.
          drawSelection(),
          keymap.of([
            // ⌘S saves-and-closes: in a dialog whose whole content is one
            // file, the note editor's save chord should do the obvious thing.
            {
              key: "Mod-s",
              run: () => {
                void saveRef.current();
                return true;
              },
            },
            ...defaultKeymap,
            ...historyKeymap,
            indentWithTab,
          ]),
          // CM5's javascript-in-json mode, not lang-json: the lezer JSON
          // grammar predates comments and would paint them as errors, and
          // comments are the point of the file.
          StreamLanguage.define(json),
          syntaxHighlighting(highlight),
          EditorView.lineWrapping,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) setProblems(problemsOf(u.state.doc.toString()));
          }),
          EditorView.theme({
            "&": { fontSize: `${settings().editor.fontSize}px`, height: "100%" },
            ".cm-content": {
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              padding: "12px",
              caretColor: "var(--cursor)",
            },
            "&.cm-focused": { outline: "none" },
            ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--cursor)" },
            "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
              { backgroundColor: "var(--selection)" },
          }),
        ],
      }),
      parent: hostRef.current,
    });
    viewRef.current = view;
    view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [text]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      // Backdrop click cancels, but only a click that started there (same
      // rule as ConfirmDialog): a drag out of the editor must not eat edits.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="flex max-h-[85vh] w-full max-w-5xl flex-col rounded-lg border bg-background p-4 shadow-xl"
      >
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold">Settings</h2>
          <span className="font-mono text-[11px] text-muted-foreground">settings.jsonc</span>
        </div>

        <div className="mt-3 min-h-0 flex-1 overflow-hidden rounded-md border border-input">
          {text === null ? (
            <p className="p-3 text-[12px] text-muted-foreground">Loading…</p>
          ) : (
            <div ref={hostRef} className="h-[55vh] overflow-y-auto [&_.cm-editor]:h-full" />
          )}
        </div>

        {problems.length > 0 && (
          <ul className="mt-2 max-h-24 space-y-0.5 overflow-y-auto text-[12px] leading-snug text-destructive">
            {problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        )}

        <div className="mt-3 flex items-center justify-between">
          <p className="text-[12px] text-muted-foreground">Changes apply the next time Ledge launches.</p>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" disabled={text === null} onClick={() => void save()}>
              Save
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
