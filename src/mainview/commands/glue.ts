// The registry's effectful edges, kept out of registry.ts so its unit tests
// never import the editor stack or the RPC channel.
//
// uiHooks mirrors the editor bridge's configureBridge pattern: each owner
// registers the capabilities it holds (Shell the chrome toggles, Sidebar the
// rename field, NoteBrowser the delete-with-undo strip and the empty-trash
// confirmation), and commands reach them through ctx.ui without the registry
// importing any component.
import { openSearchPanel } from "@codemirror/search";
import { EditorView } from "@codemirror/view";
import { focusEditor, getEditorView, requestReveal } from "@/workspace/editorPool";
import { revealSelection } from "@/workspace/reveal";
import { openReplace } from "@/editor/find";
import { runBlock } from "@/editor/blocks";
import { openLinkAtCursor, toggleTaskAt } from "@/editor/livePreview";
import { insertLink, toggleBold, toggleItalic } from "@/editor/formatting";
import { saveNow } from "@/notes/store";
import { copyText } from "@/lib/clipboard";
import { installCli } from "@/lib/cli";
import { openSettingsFile } from "@/lib/settings";
import { restartSession } from "@/terminal/channel";
import { attachWorkspace, closeWorkspace, createWorkspace } from "@/workspace/actions";
import type { RegistryDeps, UiHooks } from "./types";

// Enough of a note to parse its frontmatter — mirrors HEAD_BYTES in
// bun/notes.ts, and the same accepted edge: a >4KB frontmatter block is
// somebody's art project, not a params bug.
const HEAD_BYTES = 4096;

export const uiHooks: Partial<UiHooks> = {};

export function configureUi(fns: Partial<UiHooks>): void {
  Object.assign(uiHooks, fns);
}

// Palette-invoked editor commands land here with focus still in the palette;
// refocus the note's editor first so the command acts where the user expects
// and the caret is where the panel/run needs it.
function withView(docId: string, fn: (view: NonNullable<ReturnType<typeof getEditorView>>) => void) {
  const view = getEditorView(docId);
  if (!view) return;
  focusEditor(docId);
  fn(view);
}

export const registryDeps: RegistryDeps = {
  copyText,
  openSettings: openSettingsFile,
  installCli,
  createWorkspace,
  attachWorkspace,
  closeWorkspace,
  restartSession,
  // Open-at-the-link for a Backlinks row: the raw [[...]] text is the reveal
  // query, re-found on the line (workspace/reveal.ts) so a file that has
  // moved on still lands on the link.
  revealBacklink: (path, line, raw) => requestReveal(path, line, raw),
  // Jump to an Outline row's heading in the note's own live editor. The
  // heading text is the reveal query (revealSelection re-finds it on the
  // line, so a doc that shifted still lands right); y "start" rather than the
  // cross-note reveal's center, because a TOC jump means "show me this
  // section" and the section is below the heading. withView focuses first —
  // a jump is "take me there", like every reveal.
  jumpToHeading: (docId, line, text) =>
    withView(docId, (view) => {
      const sel = revealSelection(view.state.doc, line, text);
      view.dispatch({
        selection: { anchor: sel.anchor, head: sel.head },
        effects: EditorView.scrollIntoView(sel.anchor, { y: "start" }),
      });
    }),
  noteHead: (docId) => {
    const view = getEditorView(docId);
    if (!view) return null;
    return view.state.sliceDoc(0, Math.min(HEAD_BYTES, view.state.doc.length));
  },
  editor: {
    find: (docId) => withView(docId, (view) => openSearchPanel(view)),
    replace: (docId) => withView(docId, (view) => openReplace(view)),
    save: (docId) => void saveNow(docId),
    runInline: (docId) =>
      withView(docId, (view) => runBlock(view, view.state.selection.main.head, "inline")),
    runInTerminal: (docId) =>
      withView(docId, (view) => runBlock(view, view.state.selection.main.head, "terminal")),
    openLink: (docId) => withView(docId, (view) => openLinkAtCursor(view)),
    toggleTask: (docId) =>
      withView(docId, (view) => toggleTaskAt(view, view.state.selection.main.head)),
    bold: (docId) => withView(docId, (view) => toggleBold(view)),
    italic: (docId) => withView(docId, (view) => toggleItalic(view)),
    insertLink: (docId) => withView(docId, (view) => insertLink(view)),
  },
};
