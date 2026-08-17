// Shapes for the command registry. A Command is defined once and rendered by
// every surface: the window keymap dispatcher (keys/domains), context menus
// (title/icon/destructive/when), tooltips (via format.ts), and the palette
// (palette/when/title).
import type { ComponentType } from "react";
import type { Action, AppState } from "@/workspace/store";
import type { Workspace } from "@/workspace/tree";
import type { NoteMeta, TrashMeta, VaultState } from "../../shared/rpc-schema";
import type { FocusDomain } from "./keymap";

// What should happen once the vault dialog succeeds (unlock or first-time
// setup): the act the user was actually reaching for when the passphrase got
// in the way. App orchestrates the follow-up; the dialog stays a passphrase
// prompt and nothing more.
export interface VaultFollowUp {
  lock?: { path: string; folder: string };
  removeLock?: { path: string; title: string; folder: string };
  // Not a follow-up but a FACE: open the dialog in its change-passphrase
  // form (new passphrase twice; unlocked only — the command gates).
  changePassphrase?: true;
}

// What a context-menu invocation — or a bare key on a focused list row — acts
// on. Absent for hotkey/palette invocations, which act on the focused/selected
// object. A "note" is live in the notes root; a "trash" is a deleted one,
// which is a different kind because the verbs are different (Restore, Delete
// Permanently) and confusing the two would delete the wrong file.
export type CommandTarget =
  | { kind: "workspace"; id: string }
  | { kind: "note"; path: string }
  | { kind: "trash"; path: string }
  // A row in the Backlinks panel: the LINKING note, plus where its link sits —
  // the 1-based line and the `[[...]]` text as written, which is the reveal
  // query (workspace/reveal.ts re-finds it on the line). A distinct kind from
  // "note" because the verb is different: Enter opens the note AT ITS LINK,
  // not at wherever the editor last was.
  | { kind: "backlink"; path: string; line: number; raw: string }
  // A row in the Outline panel: one heading of the ACTIVE tab's live doc.
  // Keyed by docId, not path, because the outline follows the focused tab and
  // an unsaved scratch note has headings before it has a file. `text` doubles
  // as the reveal query: the jump re-finds it on the line, so a doc that
  // shifted since the row rendered still lands on the heading.
  | { kind: "heading"; docId: string; line: number; text: string }
  // A row in the Tags panel's directory (or a tag row in the overlay, or a
  // rendered #tag in the editor): one tag of the selected workspace. The
  // spelling rides as displayed; matching folds case Bun-side.
  | { kind: "tag"; tag: string }
  // A row in the Tags panel's drill-in: the note BEARING the tag, plus where
  // the tag sits — backlink's shape, for backlink's open-at-the-place verb.
  | { kind: "tagnote"; path: string; line: number; raw: string }
  | { kind: "tab"; paneId: string; tabId: string }
  | { kind: "pane"; paneId: string };

// Component-owned capabilities the registry reaches through, mirroring the
// editor bridge's configureBridge pattern: each owner registers its own hooks
// (Shell the chrome toggles, Sidebar the rename field, NoteBrowser the
// delete-with-undo strip) without the registry importing any component.
export interface UiHooks {
  toggleTerminal(): void;
  closeTerminal(): void;
  toggleSidebar(): void;
  toggleBacklinks(): void;
  toggleOutline(): void;
  toggleTags(): void;
  // Open the right panel on the Tags face, drilled into one tag — where every
  // tag click lands (a panel directory row, an overlay tag row, a rendered
  // #tag in the editor via the bridge).
  showTag(tag: string): void;
  // `initialQuery` seeds the input (filter text only, never sigil-parsed):
  // how note.fromTemplate lands in the palette pre-filtered to its entries.
  openOverlay(mode: "notes" | "commands" | "search", initialQuery?: string): void;
  beginRenameWorkspace(id: string): void;
  // Open the icon picker on a workspace, anchored to its row in the strip.
  pickWorkspaceIcon(id: string): void;
  // Open the move-destination chooser (Sidebar's dialog) on an EXTERNAL
  // workspace: back to ~/.ledge, or the native picker. workspace.move sends
  // managed workspaces straight to the picker without this stop.
  pickMoveDestination(id: string): void;
  // Trash the note and offer the Undo strip — the same path as the note list's
  // Delete, so ⌘⌫ and the menu item are one behavior.
  deleteNoteWithUndo(note: NoteMeta): void;
  // Bring a trashed note back — the same operation Undo uses.
  restoreTrashed(path: string): void;
  // Open the Empty Trash confirmation.
  confirmEmptyTrash(): void;
  // Open the confirmation for unlinking ONE trashed note. Irreversible, so it
  // is a confirm rather than an undo (interactions.md §4).
  confirmDeleteTrashed(item: TrashMeta): void;
  // Open the profile editor dialog on one named profile (the in-app UI for
  // profile files; macOS binds no app to ".env", so there is no OS-editor
  // path to reach them by).
  openProfileEditor(name: string): void;
  // Open the settings editor dialog — settings.jsonc in an in-app CodeMirror
  // (components/SettingsEditor.tsx). The file is still the UI; Ledge is just
  // the editor it opens in now.
  openSettingsEditor(): void;
  // Open the connection chooser — which machine holds the notes
  // (components/ConnectionPicker.tsx, remote.md §8). A dialog rather than an
  // anchored menu: switching rebuilds the whole session, and adding a server
  // means reading a host-key fingerprint before anything is pinned.
  openConnectionPicker(): void;
  // Open the vault passphrase dialog (components/VaultDialog.tsx): the
  // unlock face when a vault exists, the create-with-no-recovery-sentence
  // face when none does. `then` carries the act that was waiting on it.
  openVaultDialog(then?: VaultFollowUp): void;
  // Open the Remove Lock confirmation: not §4-destructive (nothing is
  // destroyed — the note decrypts), but the consequence is silent EXPOSURE
  // (the next sync or agent scan sees the body), which earns the one confirm.
  confirmRemoveLock(note: { path: string; title: string; folder: string }): void;
  // Show an error under the note list (the browser's error strip): where a
  // failed workspace create/attach reports, same surface as a failed delete.
  showError(message: string): void;
  // The same strip in a neutral tone, for outcomes that are answers rather
  // than failures (where the CLI shim landed). Expires on its own — a
  // confirmation that never leaves becomes chrome.
  showNotice(message: string): void;
}

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
  // surface — Bun composes the message; ok picks the strip's tone.
  installCli(): Promise<{ ok: boolean; message: string }>;
  // Show the session log in Finder. Fire-and-forget: the outcome is a Finder
  // window, which is its own feedback.
  revealLog(): void;
  // Open another window, which is another client of another server (remote.md
  // §8a). Fire-and-forget: the outcome is a window, which is its own feedback.
  newWindow(): void;
  // Workspace lifecycle (workspace/actions.ts): each needs a Bun round trip
  // (create a folder / open the native picker / detach the registry entry),
  // so the reducer cannot do it alone. Each resolves to an error message to
  // surface, or null.
  createWorkspace(state: AppState, dispatch: (a: Action) => void): Promise<string | null>;
  attachWorkspace(dispatch: (a: Action) => void): Promise<string | null>;
  closeWorkspace(id: string, state: AppState, dispatch: (a: Action) => void): void;
  // Relocate a workspace's folder on disk (native destination picker + rename,
  // both Bun-side; `home` skips the picker and targets the app home — the
  // return trip). Resolves to an error message to surface, or null.
  moveWorkspace(id: string, state: AppState, dispatch: (a: Action) => void, home?: boolean): Promise<string | null>;
  // The recorded kind of a workspace folder (view-side mirror of Bun's
  // derived truth) — what gates the Move Home face to external workspaces
  // and every read-only verb to the docs workspace.
  workspaceKind(folder: string): "managed" | "external" | "docs" | null;
  // The built-in documentation's folder handle (null when Bun reported none —
  // the docs.toggle command hides then), and the open itself: select the
  // Documentation workspace, adding it over that folder first if needed
  // (workspace/actions.ts openDocs).
  docsFolder(): string | null;
  // `page` lands on one page by title instead of the manual's front (Help >
  // Third-Party Licenses).
  openDocs(state: AppState, dispatch: (a: Action) => void, page?: string): Promise<void>;
  // The other half of the toggle: select the workspace the manual was opened
  // from, leaving it open behind. Nothing closes — a workspace switch is what
  // this is.
  closeDocs(state: AppState, dispatch: (a: Action) => void): void;
  // Kill a note's shells so the next run respawns them with its current
  // frontmatter params.
  restartSession(docId: string): void;
  // Queue "open with this line's link selected" (editorPool requestReveal) —
  // called BEFORE the openNote dispatch, the search overlay's pattern: the
  // open's render is what attaches the editor the reveal lands in. A dep, not
  // inline, because requestReveal lives in the editor stack and the registry
  // must stay importable by pure unit tests.
  revealBacklink(path: string, line: number, raw: string): void;
  // Move the caret to an Outline row's heading in the note's own live editor.
  // No open involved — the outline always describes the focused tab. A dep
  // for the same reason as revealBacklink: the view lookup lives in the
  // editor stack (editorPool), which the registry must not import.
  jumpToHeading(docId: string, line: number, text: string): void;
  // Create-or-open today's daily note. `folder` is the selected workspace —
  // the fallback when the daily.workspace setting pins none; Bun decides.
  // The open itself rides the external-open subscriber (glue feeds Bun's
  // answer to dispatchExternalOpen), so the command never dispatches an
  // openNote of its own. Resolves to an error message to surface, or null —
  // the createWorkspace contract.
  openDailyNote(folder: string): Promise<string | null>;
  // Instantiate a template note — `templatePath` is the picker row's concrete
  // pick from the live note lists — into `folder`, titled "Untitled": the H1
  // is the rename UI, so there is no title prompt. Resolves to the created
  // note, for an ordinary openNote dispatch. (Which notes ARE templates is
  // not a dep: the registry reads NoteMeta.template from ctx.state itself,
  // which is what keeps the ⌥⌘N entries live without a rebuild.)
  newNoteFromTemplate(folder: string, templatePath: string): Promise<NoteMeta>;
  // Create a note from literal text in `folder` — the starter template's
  // birth (registry.ts owns the text). The same channel createNote every
  // first save uses, so naming and collision behavior cannot differ.
  createNote(folder: string, text: string): Promise<NoteMeta>;
  // The daily.workspace setting resolved to a registered root at boot (null =
  // unset/stale), mirrored from Bun with the workspace registry. The Edit/New
  // Daily Template faces read it so they act in the workspace ⌘J will act in,
  // not merely the selected one. A dep, not ctx.state: it is boot-frozen
  // like every setting, not live view state.
  dailyRoot(): string | null;
  // Open a note that may live outside the selected workspace, by its root and
  // meta — glued to the external-open subscriber, whose select-then-open is
  // the one definition of that move.
  openNoteIn(root: string, note: NoteMeta): void;
  // The head of a note's live document — enough of it to parse frontmatter —
  // or null when no editor holds that doc. A head, not the whole text: `when`
  // runs on every menu/palette render, and a note carrying a pasted blob
  // should not be serialized just to ask whether it names a profile.
  noteHead(docId: string): string | null;
  // Whether that editor holds a non-empty selection — what greys Cut and Copy
  // in the editor's context menu. A range comparison rather than a doc read,
  // so unlike noteHead above this costs nothing to ask on every menu render.
  hasSelection(docId: string): boolean;
  // The vault (note locking, locking.md). State is the view's mirrored
  // copy (vault/channel.ts) — cheap enough for `when` to read per render.
  // The two note ops resolve to an error message to surface, or null (the
  // createWorkspace contract); both refresh the note lists themselves.
  vaultState(): VaultState;
  lockVaultNow(): void;
  // Lock resolves to what to SURFACE: an error, or a notice (the sweep
  // sealed images other notes also show — proceed-and-say, locking.md
  // §5); both null on a quiet success.
  lockNoteNow(folder: string, path: string): Promise<{ error: string | null; notice: string | null }>;
  removeLockNow(folder: string, path: string): Promise<string | null>;
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
    // CodeMirror's own indentMore/indentLess, and the `[[` picker opened
    // rather than typed. Named here because the keyboard that would otherwise
    // reach them does not exist on a phone (ios.md §7).
    indent(docId: string): void;
    outdent(docId: string): void;
    wikiLink(docId: string): void;
    // A fenced block where the caret is, or the selection wrapped in one
    // (editor/fences.ts): the same block typing ``` opens, for the keyboard
    // that has no backtick on it.
    codeBlock(docId: string): void;
    // Ask the device for a picture and embed it. Async all the way down (a
    // picker waits for a person), and the command does not wait on it: what
    // comes back is an edit, not an answer.
    insertImage(docId: string): void;
    // Add or remove the note's `template: true` frontmatter line in its LIVE
    // editor (editor/templateFlag.ts): an ordinary undoable edit, so autosave
    // and the watcher-driven list refresh carry the change everywhere else.
    toggleTemplate(docId: string): void;
    // Put the caret inside the note's frontmatter block, creating empty
    // fences at the top when there is none (editor/frontmatterEdit.ts) —
    // the same ordinary-undoable-edit stance as toggleTemplate.
    editFrontmatter(docId: string): void;
    // The clipboard (editor/clipboard.ts), which goes through the Bun process
    // because views:// is not a secure context. The same four the chords run,
    // so a menu item and a chord are one act with one undo entry. Cut and Copy
    // do nothing with an empty selection; paste translates formatted HTML to
    // Markdown, and pastePlain is that paste with the translation left out.
    cut(docId: string): void;
    copy(docId: string): void;
    paste(docId: string): void;
    pastePlain(docId: string): void;
    // CodeMirror's own selectAll — the ⌘A its defaultKeymap already binds,
    // named here so the context menu has something to render.
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
