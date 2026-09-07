// The registry's effectful edges, kept out of registry.ts so its unit tests
// never import the editor stack or the RPC channel. uiHooks follows the editor
// bridge's configureBridge pattern: Shell registers the chrome toggles, Sidebar
// the rename field, NoteBrowser the delete-with-undo strip and the empty-trash
// confirmation. Commands reach them through ctx.ui, not by importing one.
import { openSearchPanel } from "@codemirror/search";
import { startCompletion } from "@codemirror/autocomplete";
import { indentLess, indentMore, selectAll } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { focusEditor, getEditorView, requestReveal, requestTitleCaret } from "@/workspace/editorPool";
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
import { favoriteNoteNow } from "@/notes/actions";
import { lockNoteAndRefresh, lockVault, removeLockAndRefresh, vaultState } from "@/vault/channel";
import { expandFolder, isExpanded, toggleFolder } from "@/notes/expansion";
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

// Enough of a note's text to parse its frontmatter. Matches HEAD_BYTES in
// bun/notes.ts (bytes there, document positions here), and accepts the same
// edge: a frontmatter block past 4KB is truncated, so the params below that
// point are never parsed. That is the accepted edge, not a params bug.
const HEAD_BYTES = 4096;

export const uiHooks: Partial<UiHooks> = {};

export function configureUi(fns: Partial<UiHooks>): void {
  Object.assign(uiHooks, fns);
}

// Run an editor command against a note's pooled view, focusing that editor
// first. A palette or menu invocation arrives with the focus elsewhere, and a
// find panel or a run needs the caret in the editor.
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
  // Create or open today's note, then feed Bun's ExternalOpenInfo to the
  // CLI-open subscriber (App.tsx, via notes/channel.ts dispatchExternalOpen).
  // That subscriber is the one place this path selects the workspace and then
  // opens the note. Do not grow a second copy of that pair here.
  openDailyNote: async (folder) => {
    try {
      const r = await rpcOpenDaily(folder);
      // Place the title caret only when this call created the note. Reopening
      // today's note reuses the pooled editor and the caret the user left in
      // it (workspace/editorPool.ts acquire). The `false` leaves the title
      // unselected: it is the date, and a keystroke over a selected title
      // would rename the note (workspace/reveal.ts revealTitle).
      if (r.created) requestTitleCaret(r.open.path, false);
      dispatchExternalOpen(r.open);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  },
  newNoteFromTemplate: (folder, templatePath) => createNoteFromTemplate(folder, templatePath, null),
  createNote: (folder, text, subfolder) => rpcCreateNote(folder, text, subfolder),
  folderExpanded: isExpanded,
  toggleFolder,
  expandFolder,
  // The daily.workspace setting as resolved at boot (workspace/channel.ts).
  // Used only to label the Edit/New Daily Template faces: Bun re-resolves it
  // on every ⌘J.
  dailyRoot: dailyWorkspaceRoot,
  // Open a note that may live outside the selected workspace, through the
  // same external-open subscriber the CLI and ⌘J use, rather than a second
  // select-then-open written here. Selecting the already-selected workspace
  // is a no-op.
  openNoteIn: (root, note) => dispatchExternalOpen({ ...note, root }),
  // Open a Backlinks row at its link. The raw [[...]] text is the reveal
  // query, re-found on the line (workspace/reveal.ts revealSelection), so an
  // edit that moved the link along its line still lands on it. An edit that
  // moved the line itself lands on whatever that line number now holds.
  revealBacklink: (path, line, raw) => requestReveal(path, line, raw),
  // The caret a just-created note opens with: inside its H1, which is the
  // rename field, with the placeholder title selected so the first keystroke
  // names the note (workspace/reveal.ts revealTitle). Callers here create a
  // note titled "Untitled". ⌘J's date title takes requestTitleCaret
  // unselected, above.
  revealTitle: (path) => requestTitleCaret(path, true),
  // Jump to an Outline row's heading in the note's own live editor. The
  // heading text is the reveal query, re-found on the line
  // (workspace/reveal.ts revealSelection). Scrolls with y "start", not the
  // cross-note reveal's "center", so the section under the heading is what
  // shows. withView focuses the editor first, as every reveal does.
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
  // This one reads the view without going through withView: it only asks a
  // question, and focusing the editor would take the focus off the menu or
  // palette that asked.
  hasSelection: (docId) => {
    const view = getEditorView(docId);
    return !!view && hasSelection(view);
  },
  vaultState,
  // Flush, then drop the key, awaited in that order (locking.md §3): a dirty
  // locked buffer must reach disk encrypted while Bun still holds the key.
  // Evicting the decrypted views is not this call's work: lockVault moves the
  // vault state to locked, and editorPool's onVaultChanged subscription
  // evicts on that change.
  lockVaultNow: () => {
    void flushAllNow().then(() => lockVault());
  },
  lockNoteNow: lockNoteAndRefresh,
  removeLockNow: removeLockAndRefresh,
  favoriteNoteNow: (folder, path, on, docIds) => favoriteNoteNow(path, on, folder, docIds),
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
    // CodeMirror's own indent commands, the ones Tab and ⇧Tab run
    // (editor/setup.ts). The accessory bar's Indent and Outdent buttons and
    // those two keys therefore make the same edit and share one undo history.
    indent: (docId) => withView(docId, (view) => void indentMore(view)),
    outdent: (docId) => withView(docId, (view) => void indentLess(view)),
    // Insert the `[[`, then ask for the popup. `startCompletion` is needed
    // because a dispatched insert is not a keystroke: the source matches on
    // the text before the caret (editor/wikilinks.ts), but nothing would have
    // asked it to look.
    wikiLink: (docId) =>
      withView(docId, (view) => {
        view.dispatch(view.state.replaceSelection("[["));
        startCompletion(view);
      }),
    // Plant a fenced block rather than type one: the typing path is closeFence
    // in editor/fences.ts. A selection is wrapped whole, and a bare caret on a
    // line with text gets the block after that line. insertCodeBlock dispatches
    // nothing where a block cannot go (inside another block, on a fence line,
    // in the frontmatter), just as Open Link does nothing off a link.
    codeBlock: (docId) => withView(docId, (view) => void insertCodeBlock(view)),
    // The same embed the editor's ⌘V does, from the device's picture picker
    // instead of its pasteboard (lib/assets.ts pickImageAsset). Not awaited:
    // the picker stays open until the user answers it, and awaiting would hold
    // the command dispatcher open that long.
    insertImage: (docId) => withView(docId, (view) => void embedImage(view, pickImageAsset)),
    toggleTemplate: (docId) => withView(docId, (view) => toggleTemplateFlag(view)),
    editFrontmatter: (docId) => withView(docId, (view) => editFrontmatter(view)),
    // The same clipboard commands the chords run (editor/clipboard.ts), so a
    // menu item and ⌘C run the same code. withView focuses first, as it does
    // for every editor command: the menu took the focus when its item was
    // clicked, and an edit that lands in an unfocused editor leaves the caret
    // invisible.
    cut: (docId) => withView(docId, (view) => void cutSelection(view)),
    copy: (docId) => withView(docId, (view) => void copySelection(view)),
    paste: (docId) => withView(docId, (view) => void pasteHere(view)),
    pastePlain: (docId) => withView(docId, (view) => void pastePlain(view)),
    selectAll: (docId) => withView(docId, (view) => void selectAll(view)),
  },
};
