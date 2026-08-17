// The registry's effectful edges, kept out of registry.ts so its unit tests
// never import the editor stack or the RPC channel.
//
// uiHooks mirrors the editor bridge's configureBridge pattern: each owner
// registers the capabilities it holds (Shell the chrome toggles, Sidebar the
// rename field, NoteBrowser the delete-with-undo strip and the empty-trash
// confirmation), and commands reach them through ctx.ui without the registry
// importing any component.
import { openSearchPanel } from "@codemirror/search";
import { startCompletion } from "@codemirror/autocomplete";
import { indentLess, indentMore, selectAll } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { focusEditor, getEditorView, requestReveal } from "@/workspace/editorPool";
import { revealSelection } from "@/workspace/reveal";
import { openReplace } from "@/editor/find";
import { runBlock } from "@/editor/blocks";
import { openLinkAtCursor, toggleTaskAt } from "@/editor/livePreview";
import { insertCodeBlock } from "@/editor/fences";
import { insertLink, toggleBold, toggleItalic } from "@/editor/formatting";
import { editFrontmatter } from "@/editor/frontmatterEdit";
import { toggleTemplateFlag } from "@/editor/templateFlag";
import { embedImage } from "@/editor/images";
import {
  copySelection,
  cutSelection,
  hasSelection,
  pasteHere,
  pastePlain,
} from "@/editor/clipboard";
import { pickImageAsset } from "@/lib/assets";
import { flushAllNow, saveNow } from "@/notes/store";
import { lockNoteAndRefresh, lockVault, removeLockAndRefresh, vaultState } from "@/vault/channel";
import {
  createNote as rpcCreateNote,
  createNoteFromTemplate,
  dispatchExternalOpen,
  openDailyNote as rpcOpenDaily,
} from "@/notes/channel";
import { copyText } from "@/lib/clipboard";
import { installCli } from "@/lib/cli";
import { revealLog } from "@/lib/log";
import { openDocsWindow, openWindow } from "@/lib/windows";
import { restartSession } from "@/terminal/channel";
import { attachWorkspace, closeDocs, closeWorkspace, createWorkspace, moveWorkspace, openDocs } from "@/workspace/actions";
import { dailyWorkspaceRoot, docsFolder, workspaceKind } from "@/workspace/channel";
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
  installCli,
  revealLog,
  newWindow: openWindow,
  createWorkspace,
  attachWorkspace,
  closeWorkspace,
  moveWorkspace,
  workspaceKind,
  docsFolder,
  openDocs,
  openDocsWindow,
  closeDocs,
  restartSession,
  // Create-or-open today's note, then feed Bun's ExternalOpenInfo to the
  // CLI-open subscriber (App.tsx): select-workspace-then-open has ONE
  // definition, and this path must not grow a second.
  openDailyNote: async (folder) => {
    try {
      const r = await rpcOpenDaily(folder);
      dispatchExternalOpen(r.open);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  },
  newNoteFromTemplate: (folder, templatePath) => createNoteFromTemplate(folder, templatePath, null),
  createNote: (folder, text) => rpcCreateNote(folder, text),
  // The boot-recorded resolution of daily.workspace (workspace/channel.ts) —
  // display truth for the Edit/New Daily Template faces; Bun re-resolves on
  // every actual ⌘J.
  dailyRoot: dailyWorkspaceRoot,
  // Open a note that may live outside the selected workspace: the same
  // external-open subscriber the CLI and ⌘J ride (select-then-open has ONE
  // definition; selecting the already-selected workspace is a no-op).
  openNoteIn: (root, note) => dispatchExternalOpen({ ...note, root }),
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
  // No withView: this only asks a question, and focusing the editor to answer
  // one would move the caret out of whatever surface is doing the asking.
  hasSelection: (docId) => {
    const view = getEditorView(docId);
    return !!view && hasSelection(view);
  },
  vaultState,
  // Flush THEN drop, awaited in that order (locking.md §3): a dirty
  // locked buffer must reach disk encrypted while Bun still holds the key.
  // The eviction of decrypted views rides the vaultChanged push this ends in
  // (editorPool's subscription), not this call.
  lockVaultNow: () => {
    void flushAllNow().then(() => lockVault());
  },
  lockNoteNow: lockNoteAndRefresh,
  removeLockNow: removeLockAndRefresh,
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
    // CodeMirror's own, so a bar button and the Tab key are the same act with
    // the same undo history — not a second implementation of indentation.
    indent: (docId) => withView(docId, (view) => void indentMore(view)),
    outdent: (docId) => withView(docId, (view) => void indentLess(view)),
    // Type the `[[` and then ask for the popup. `startCompletion` is needed
    // because an inserted bracket is not a keystroke: the source matches on
    // the text before the caret (editor/wikilinks.ts) but nothing would have
    // asked it to look.
    wikiLink: (docId) =>
      withView(docId, (view) => {
        view.dispatch(view.state.replaceSelection("[["));
        startCompletion(view);
      }),
    // The fence, planted rather than typed (editor/fences.ts). Nothing is
    // dispatched where a block cannot go — inside another one, or inside the
    // frontmatter — which is the same silence Open Link answers a caret that is
    // not on a link with.
    codeBlock: (docId) => withView(docId, (view) => void insertCodeBlock(view)),
    // The same embed the editor's ⌘V does, from the device's picker instead of
    // its pasteboard (lib/assets.ts pickImageAsset). Fire and forget: the
    // picker is on screen for as long as a person takes, and a command that
    // awaited it would hold the dispatcher open for a minute.
    insertImage: (docId) => withView(docId, (view) => void embedImage(view, pickImageAsset)),
    toggleTemplate: (docId) => withView(docId, (view) => toggleTemplateFlag(view)),
    editFrontmatter: (docId) => withView(docId, (view) => editFrontmatter(view)),
    // The clipboard: the very commands the chords run (editor/clipboard.ts),
    // so a menu item and ⌘C cannot come to differ. withView focuses first, as
    // it does for every editor command — the menu took the focus when its item
    // was clicked, and an edit that lands in an unfocused editor leaves the
    // caret invisible.
    cut: (docId) => withView(docId, (view) => void cutSelection(view)),
    copy: (docId) => withView(docId, (view) => void copySelection(view)),
    paste: (docId) => withView(docId, (view) => void pasteHere(view)),
    pastePlain: (docId) => withView(docId, (view) => void pastePlain(view)),
    selectAll: (docId) => withView(docId, (view) => void selectAll(view)),
  },
};
