// Shapes for the command registry. A Command is defined once and rendered by
// every surface: the window keymap dispatcher (keys/domains), context menus
// (title/icon/destructive/when), tooltips (via format.ts), and the palette
// (palette/when/title).
import type { ComponentType } from "react";
import type { Action, AppState } from "@/workspace/store";
import type { Workspace } from "@/workspace/tree";
import type { NoteMeta, TrashMeta, VaultState } from "../../shared/rpc-schema";
import type { FocusDomain } from "./keymap";

// What to run once the vault dialog succeeds (unlock or first-time setup):
// the command that was waiting on the passphrase. App.tsx runs the follow-up.
// The dialog only collects the passphrase.
export interface VaultFollowUp {
  lock?: { path: string; title: string; folder: string };
  removeLock?: { path: string; title: string; folder: string };
  // Not a follow-up: opens the dialog in its change-passphrase face, which
  // asks for the new passphrase twice. The command's `when` allows it only
  // while the vault is unlocked.
  changePassphrase?: true;
}

// What a context-menu invocation, or a bare key on a focused list row, acts
// on. Absent for hotkey and palette invocations, which act on the focused or
// selected object. A "note" is live in the notes root; a "trash" is a deleted
// one. They are separate kinds because the verbs differ (Restore, Delete
// Permanently) and mixing them would delete the wrong file.
export type CommandTarget =
  | { kind: "workspace"; id: string }
  | { kind: "note"; path: string }
  | { kind: "trash"; path: string }
  // A folder row in the note browser's tree: a root-relative folder of the
  // selected workspace ("projects/api"), never a path. A separate kind from
  // "note" because the verbs differ. A folder opens by disclosing what is in
  // it, and it is the only row a new note can be filed into.
  | { kind: "folder"; folder: string }
  // A row in the Backlinks panel: the linking note, plus where its link sits.
  // `line` is 1-based, and `raw` is the `[[...]]` text as written, which is
  // the reveal query (workspace/reveal.ts re-finds it on the line). A separate
  // kind from "note" because the verb differs: Enter opens the note at its
  // link, not where the editor last was.
  | { kind: "backlink"; path: string; line: number; raw: string }
  // A row in the Outline panel: one heading of the active tab's live doc.
  // Keyed by docId, not path, because the outline follows the focused tab and
  // an unsaved scratch note has headings before it has a file. `text` is also
  // the reveal query: the jump re-finds it on the line, so a doc that shifted
  // since the row rendered still lands on the heading.
  | { kind: "heading"; docId: string; line: number; text: string }
  // A row in the Tags panel's directory, a tag row in the overlay, or a
  // rendered #tag in the editor: one tag of the selected workspace. The tag
  // carries the spelling as displayed. Bun folds case when matching.
  | { kind: "tag"; tag: string }
  // A row in the Tags panel's drill-in: the note bearing the tag, plus where
  // the tag sits. Backlink's shape, for backlink's open-at-the-place verb.
  | { kind: "tagnote"; path: string; line: number; raw: string }
  | { kind: "tab"; paneId: string; tabId: string }
  | { kind: "pane"; paneId: string };

// Component-owned capabilities the registry calls, following the editor
// bridge's configureBridge pattern: each owner registers its own hooks (Shell
// the chrome toggles, Sidebar the rename field, NoteBrowser the
// delete-with-undo strip), so the registry imports no component.
export interface UiHooks {
  toggleTerminal(): void;
  closeTerminal(): void;
  toggleSidebar(): void;
  toggleBacklinks(): void;
  toggleOutline(): void;
  toggleTags(): void;
  // Open the right panel on the Tags face, drilled into one tag. Every tag
  // click lands here: a panel directory row, an overlay tag row, and a
  // rendered #tag in the editor (which arrives via the bridge).
  showTag(tag: string): void;
  // `query` seeds the input as filter text, never parsed for a sigil. It is
  // how note.fromTemplate lands in the palette pre-filtered to its entries.
  // `folder` scopes the overlay to one folder of the selected workspace, both
  // its note list and its text search. "" or absent means the whole workspace.
  openOverlay(mode: "notes" | "commands" | "search", opts?: { query?: string; folder?: string }): void;
  beginRenameWorkspace(id: string): void;
  // Put the inline rename field on a folder row of the note browser, the same
  // gesture the workspace strip uses. The browser owns it because the field
  // replaces a row, and only the list knows which row that is.
  beginRenameFolder(folder: string): void;
  // Open the icon picker on a workspace, anchored to its row in the strip.
  pickWorkspaceIcon(id: string): void;
  // Open the move-destination chooser (Sidebar's dialog) on an external
  // workspace: back to ~/.ledge, or on to the native picker. workspace.move
  // sends managed workspaces straight to the picker without this stop.
  pickMoveDestination(id: string): void;
  // Trash the note and offer the Undo strip. The same path as the note list's
  // Delete, so ⌘⌫ and the menu item behave alike.
  deleteNoteWithUndo(note: NoteMeta): void;
  // Open the folder chooser (components/FolderPicker.tsx), the destination
  // question both Move to Folder… and New Folder… ask. The browser owns it
  // because it also owns the tree the answer changes: a note filed into a
  // collapsed folder still has to end up visible.
  pickFolder(request: FolderRequest): void;
  // Open the confirmation for deleting a folder, which deletes the notes in
  // it. The delete is reversible: every note lands in the trash and the Undo
  // strip follows. It is confirmed because a collapsed row does not say how
  // many notes are under it and the dialog does (interactions.md §4).
  confirmDeleteFolder(folder: string): void;
  // Bring a trashed note back. The same operation Undo uses.
  restoreTrashed(path: string): void;
  // Open the Empty Trash confirmation.
  confirmEmptyTrash(): void;
  // Open the confirmation for unlinking one trashed note. Irreversible, so it
  // is a confirm rather than an undo (interactions.md §4).
  confirmDeleteTrashed(item: TrashMeta): void;
  // Open the profile editor dialog on one named profile. This is the in-app
  // UI for profile files: macOS binds no app to ".env", so it has no editor
  // to open them with.
  openProfileEditor(name: string): void;
  // Open the settings editor dialog: settings.jsonc in an in-app CodeMirror
  // (components/SettingsEditor.tsx). The file itself is still the settings
  // UI. Ledge only supplies the editor.
  openSettingsEditor(): void;
  // Open the connection chooser, which picks the machine that holds the notes
  // (components/ConnectionPicker.tsx, remote.md §8). A dialog rather than an
  // anchored menu: switching rebuilds the whole session, and adding a server
  // means reading a host-key fingerprint before anything is pinned.
  openConnectionPicker(): void;
  // Open the vault passphrase dialog (components/VaultDialog.tsx): the unlock
  // face when a vault exists, and when none does the create face, which says
  // there is no recovery. `then` carries the command that was waiting on it.
  openVaultDialog(then?: VaultFollowUp): void;
  // Open the Remove Lock confirmation. Not destructive under interactions.md
  // §4: the note decrypts, and nothing is destroyed. It is confirmed anyway
  // because the body becomes readable and nothing else marks it. The next
  // sync or agent scan sees the plain text.
  confirmRemoveLock(note: { path: string; title: string; folder: string }): void;
  // Open the Lock confirmation. Nothing is destroyed and nothing is exposed,
  // so this is not an interactions.md §4 confirm: it is the one place Ledge
  // can say that encrypting a note now does not retract the plaintext copies
  // a sync service, a backup, or a git history already holds (locking.md §1).
  confirmLock(note: { path: string; title: string; folder: string }): void;
  // Show an error under the note list (the browser's error strip). A failed
  // workspace create or attach reports here, on the same surface a failed
  // delete uses.
  showError(message: string): void;
  // The same strip in a neutral tone, for outcomes that are answers rather
  // than failures (where the CLI shim landed). The strip clears itself after
  // a timeout, on the same clock as the Undo offer.
  showNotice(message: string): void;
}

/** What the folder chooser was opened for: filing a note that exists, or
 * naming a folder for one that does not yet. `parent` seeds the field, so New
 * Folder… on a folder row starts inside it. */
export type FolderRequest =
  | { kind: "move"; note: NoteMeta }
  | { kind: "new"; parent: string };

export interface CommandCtx {
  state: AppState;
  selected: Workspace;
  dispatch(a: Action): void;
  ui: Partial<UiHooks>;
  target?: CommandTarget;
}

// Effectful capabilities injected into buildCommands so the registry itself
// stays free of editor/RPC imports (and its tests can stub them).
export interface RegistryDeps {
  copyText(text: string): void;
  // Write the `ledge` CLI shim onto the PATH. Resolves to the outcome to
  // surface: Bun composes the message, and `ok` picks the strip's tone.
  installCli(): Promise<{ ok: boolean; message: string }>;
  // Show the session log in Finder. Returns nothing: the Finder window it
  // opens is the feedback.
  revealLog(): void;
  // Ask the update server for a newer build. Returns nothing: the answer and
  // its notice arrive through the update mirror (lib/updates.ts).
  checkForUpdates(): void;
  // Quit and relaunch into the downloaded update. Resolves to the notice to
  // show when the install did not start.
  installUpdate(): Promise<{ tone: "notice" | "error"; message: string } | null>;
  // Open another window, which is another client of another server (remote.md
  // §8a). Returns nothing: the new window is the feedback.
  newWindow(): void;
  // Workspace lifecycle (workspace/actions.ts). Each needs a Bun round trip
  // (create a folder, open the native picker, detach the registry entry), so
  // the reducer cannot do it alone. The two async ones resolve to an error
  // message to surface, or null.
  createWorkspace(state: AppState, dispatch: (a: Action) => void): Promise<string | null>;
  attachWorkspace(dispatch: (a: Action) => void): Promise<string | null>;
  closeWorkspace(id: string, state: AppState, dispatch: (a: Action) => void): void;
  // Relocate a workspace's folder on disk. The native destination picker and
  // the rename are both Bun-side. `home` skips the picker and targets the app
  // home. Resolves to an error message to surface, or null.
  moveWorkspace(id: string, state: AppState, dispatch: (a: Action) => void, home?: boolean): Promise<string | null>;
  // The recorded kind of a workspace folder, mirrored view-side from what Bun
  // derives. It gates the Move Home face to external workspaces, and gates
  // every verb the read-only docs workspace does not allow.
  workspaceKind(folder: string): "managed" | "external" | "docs" | null;
  // The built-in documentation's folder handle, null when Bun reported none.
  // The docs.toggle command hides while it is null. openDocs below selects
  // the Documentation workspace, adding it over that folder first if needed
  // (workspace/actions.ts).
  docsFolder(): string | null;
  // `page` opens one page by title instead of the manual's front page. Help >
  // Third-Party Licenses passes one.
  openDocs(state: AppState, dispatch: (a: Action) => void, page?: string): Promise<void>;
  // Show the manual in a window of its own, which the shell opens or raises
  // (lib/windows.ts). lib/shell.ts's multiWindow decides which path
  // docs.toggle takes: a client with a single window calls openDocs and
  // closeDocs instead (ios.md §11).
  openDocsWindow(page: string): void;
  // The other half of the toggle: select the workspace the manual was opened
  // from, leaving the Documentation workspace open behind it. Nothing closes:
  // the only change is which workspace is selected.
  closeDocs(state: AppState, dispatch: (a: Action) => void): void;
  // Kill a note's shells so the next run respawns them with its current
  // frontmatter params.
  restartSession(docId: string): void;
  // Queue "open with this line's link selected" (editorPool requestReveal).
  // Called before the openNote dispatch, the same order Overlay.tsx uses: the
  // open's render is what attaches the editor the reveal lands in. A dep
  // rather than an import, because requestReveal lives in the editor stack
  // and the registry must stay importable by pure unit tests.
  revealBacklink(path: string, line: number, raw: string): void;
  // Queue "open with the placeholder title selected" (editorPool
  // requestTitleCaret) for a note the command just created. Called before the
  // open, like revealBacklink, and a dep for the same reason. Every caller
  // creates an "Untitled", so the first keystroke names the note. Only
  // creation calls it: an open of an existing note must not move the caret.
  revealTitle(path: string): void;
  // Move the caret to an Outline row's heading in the note's own live editor.
  // No open is involved: the outline always describes the focused tab. A dep
  // for the same reason as revealBacklink, since the view lookup lives in the
  // editor stack (editorPool), which the registry must not import.
  jumpToHeading(docId: string, line: number, text: string): void;
  // Create or open today's daily note. `folder` is the selected workspace,
  // the fallback Bun uses when the daily.workspace setting pins none. The open
  // goes through the external-open subscriber (glue passes Bun's answer to
  // dispatchExternalOpen), so the command dispatches no openNote itself.
  // Resolves to an error message to surface, or null, as createWorkspace does.
  openDailyNote(folder: string): Promise<string | null>;
  // Instantiate a template note into `folder`, titled "Untitled": the H1 is
  // the rename UI, so there is no title prompt. `templatePath` is the picker
  // row's pick from the live note lists. Resolves to the created note, for an
  // ordinary openNote dispatch. Which notes are templates is not a dep: the
  // registry reads NoteMeta.template from ctx.state, which keeps the
  // note.fromTemplate palette entries live without a rebuild.
  newNoteFromTemplate(folder: string, templatePath: string): Promise<NoteMeta>;
  // Create a note from literal text in `folder`, which is how the starter
  // template is written (registry.ts holds the text). The same createNote
  // channel every first save uses, so naming and collision behavior match.
  createNote(folder: string, text: string, subfolder?: string | null): Promise<NoteMeta>;
  // Which folders the browser's tree has open, and the toggle for one
  // (notes/expansion.ts). Both take the workspace root first: expansion is per
  // workspace, so two workspaces sharing a folder name do not share an answer.
  // A dep rather than an import, so registry tests do not read a live
  // module-level set. Like vaultState below, it is cheap enough for a `when`
  // or a title to ask per render.
  folderExpanded(root: string, folder: string): boolean;
  toggleFolder(root: string, folder: string): void;
  // Open a folder and its ancestors, so a note the command just put there is
  // on screen where it landed rather than behind a closed disclosure.
  expandFolder(root: string, folder: string): void;
  // The daily.workspace setting resolved to a registered root at boot, null
  // when unset or stale, mirrored from Bun with the workspace registry. The
  // Edit and New Daily Template faces read it so they act in the workspace ⌘J
  // acts in, not merely the selected one. A dep rather than ctx.state because
  // it is frozen at boot like every setting, not live view state.
  dailyRoot(): string | null;
  // Open a note that may live outside the selected workspace, by its root and
  // meta. Goes through the external-open subscriber, which holds the only
  // select-workspace-then-open path.
  openNoteIn(root: string, note: NoteMeta): void;
  // The head of a note's live document, enough of it to parse frontmatter, or
  // null when no editor holds that doc. Not the whole text: `when` runs on
  // every menu and palette render. A note carrying a pasted blob would
  // otherwise be serialized in full just to ask whether it names a profile.
  noteHead(docId: string): string | null;
  // Whether that editor holds a non-empty selection, which is what greys Cut
  // and Copy in the editor's context menu. It checks the selection ranges
  // rather than reading the doc, so unlike noteHead it is cheap per render.
  hasSelection(docId: string): boolean;
  // The vault (note locking, locking.md). vaultState reads the view's
  // mirrored copy (vault/channel.ts), cheap enough for `when` to ask per
  // render. The two note ops resolve to an error message to surface, or null,
  // as createWorkspace does. Both refresh the note lists themselves.
  vaultState(): VaultState;
  lockVaultNow(): void;
  // Lock resolves to what to surface: an error, or a notice that the sweep
  // sealed images other notes also show (locking.md §5). Both are null on a
  // quiet success.
  lockNoteNow(folder: string, path: string): Promise<{ error: string | null; notice: string | null }>;
  removeLockNow(folder: string, path: string): Promise<string | null>;
  // Put the note's `favorite: true` marker on or take it off, and refresh the
  // folder's list. Resolves to an error message to surface, or null, like the
  // two note ops above. `docIds` is every open tab on the note, which the
  // action saves before the marker lands (notes/actions.ts favoriteNoteNow).
  favoriteNoteNow(folder: string, path: string, on: boolean, docIds: string[]): Promise<string | null>;
  editor: {
    find(docId: string): void;
    replace(docId: string): void;
    save(docId: string): void;
    runInline(docId: string): void;
    runInTerminal(docId: string): void;
    // Follow the link under the caret (livePreview.ts); no-op when the caret
    // is not on one.
    openLink(docId: string): void;
    // Toggle the task checkbox on the caret's line (livePreview.ts); no-op
    // when the line has none.
    toggleTask(docId: string): void;
    // Markdown formatting (formatting.ts): toggle **strong**/*emphasis*
    // around the selection or the word at the caret; wrap the selection as a
    // [text](url) link.
    bold(docId: string): void;
    italic(docId: string): void;
    insertLink(docId: string): void;
    // CodeMirror's own indentMore and indentLess, plus the `[[` picker opened
    // rather than typed. Named here because a phone has no keyboard that
    // reaches them (ios.md §7).
    indent(docId: string): void;
    outdent(docId: string): void;
    wikiLink(docId: string): void;
    // Insert a fenced block at the caret, or wrap the selection in one
    // (editor/fences.ts). The same block typing ``` opens, for a keyboard
    // with no backtick on it.
    codeBlock(docId: string): void;
    // Ask the device for a picture and embed it. Async all the way down,
    // since the picker waits for a person. The command does not wait on it:
    // the result arrives as an edit, not as a return value.
    insertImage(docId: string): void;
    // Add or remove the note's `template: true` frontmatter line in its live
    // editor (editor/templateFlag.ts). An ordinary undoable edit, so autosave
    // and the watcher-driven list refresh carry the change everywhere else.
    toggleTemplate(docId: string): void;
    // Put the caret inside the note's frontmatter block, creating empty
    // fences at the top when there is none (editor/frontmatterEdit.ts). An
    // ordinary undoable edit, like toggleTemplate.
    editFrontmatter(docId: string): void;
    // The clipboard (editor/clipboard.ts), which goes through the Bun process
    // because views:// is not a secure context. The same four the chords run,
    // so a menu item and a chord make one edit with one undo entry. Cut and
    // Copy do nothing with an empty selection. paste translates formatted HTML
    // to Markdown; pastePlain leaves the translation out.
    cut(docId: string): void;
    copy(docId: string): void;
    paste(docId: string): void;
    pastePlain(docId: string): void;
    // CodeMirror's own selectAll, the ⌘A its defaultKeymap already binds.
    // Named here so the context menu has something to render.
    selectAll(docId: string): void;
  };
}

export interface Command {
  // A CommandId from keys.ts, or a generated id like "workspace.select.3".
  id: string;
  title: string | ((ctx: CommandCtx) => string);
  icon?: ComponentType<{ className?: string }>;
  // CodeMirror-spelling bindings ("Mod-Shift-w"); first is the advertised one.
  keys?: readonly string[];
  // Bare keys ("d", "Enter") that fire only while a matching list row has
  // focus. Advertised as a chip like any other key.
  listKeys?: readonly string[];
  // Where the window dispatcher fires this (default: page+editor+terminal;
  // page widens into list). Editor-internal commands bound in CodeMirror use
  // domains: [] so the window layer never double-fires them.
  domains?: readonly FocusDomain[];
  // The row kind this acts on. Set it on anything targeting a specific object:
  // it gates the bare keys to the right row and keeps `r` unambiguous between
  // Rename Workspace and Restore.
  targetKind?: CommandTarget["kind"];
  // Enablement: menus disable, the palette hides, the dispatcher ignores.
  when?(ctx: CommandCtx): boolean;
  // Shown in the command palette (default true).
  palette?: boolean;
  destructive?: boolean;
  run(ctx: CommandCtx): void;
}

export type { FocusDomain };
