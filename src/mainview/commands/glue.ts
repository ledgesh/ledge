// The registry's effectful edges, kept out of registry.ts so its unit tests
// never import the editor stack or the RPC channel.
//
// uiHooks mirrors the editor bridge's configureBridge pattern: each owner
// registers the capabilities it holds (Shell the chrome toggles, Sidebar the
// rename field, NoteBrowser the delete-with-undo strip and the empty-trash
// confirmation), and commands reach them through ctx.ui without the registry
// importing any component.
import { openSearchPanel } from "@codemirror/search";
import { focusEditor, getEditorView } from "@/workspace/editorPool";
import { openReplace } from "@/editor/find";
import { runBlock } from "@/editor/blocks";
import { openLinkAtCursor, toggleTaskAt } from "@/editor/livePreview";
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
  },
};
