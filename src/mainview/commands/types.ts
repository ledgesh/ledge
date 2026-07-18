// Shapes for the command registry. A Command is defined once and rendered by
// every surface: the window keymap dispatcher (keys/domains), context menus
// (title/icon/destructive/when), tooltips (via format.ts), and the palette
// (palette/when/title).
import type { ComponentType } from "react";
import type { Action, AppState } from "@/workspace/store";
import type { Workspace } from "@/workspace/tree";
import type { NoteMeta, TrashMeta } from "../../shared/rpc-schema";
import type { FocusDomain } from "./keymap";

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
  openOverlay(mode: "notes" | "commands" | "search"): void;
  beginRenameWorkspace(id: string): void;
  // Open the icon picker on a workspace, anchored to its row in the strip.
  pickWorkspaceIcon(id: string): void;
  // Trash the note and offer the Undo strip — the same path as the note list's
  // Delete, so ⌘⌫ and the menu item are one behavior.
  deleteNoteWithUndo(note: NoteMeta): void;
  // Bring a trashed note back — the same operation Undo uses.
  restoreTrashed(path: string): void;
  // Open the Empty Trash confirmation.
  confirmEmptyTrash(): void;
  // Open the confirmation for unlinking ONE trashed note. Irreversible, so it
  // is a confirm rather than an undo (docs/interactions.md §4).
  confirmDeleteTrashed(item: TrashMeta): void;
  // Open the profile editor dialog on one named profile (the in-app UI for
  // profile files; macOS binds no app to ".env", so there is no OS-editor
  // path to reach them by).
  openProfileEditor(name: string): void;
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
  // Open settings.json in the OS editor (an RPC edge, like copyText).
  openSettings(): void;
  // Write the `ledge` CLI shim onto the PATH. Resolves to the outcome to
  // surface — Bun composes the message; ok picks the strip's tone.
  installCli(): Promise<{ ok: boolean; message: string }>;
  // Workspace lifecycle (workspace/actions.ts): each needs a Bun round trip
  // (create a folder / open the native picker / detach the registry entry),
  // so the reducer cannot do it alone. Each resolves to an error message to
  // surface, or null.
  createWorkspace(state: AppState, dispatch: (a: Action) => void): Promise<string | null>;
  attachWorkspace(dispatch: (a: Action) => void): Promise<string | null>;
  closeWorkspace(id: string, state: AppState, dispatch: (a: Action) => void): void;
  // Kill a note's shells so the next run respawns them with its current
  // frontmatter params.
  restartSession(docId: string): void;
  // Queue "open with this line's link selected" (editorPool requestReveal) —
  // called BEFORE the openNote dispatch, the search overlay's pattern: the
  // open's render is what attaches the editor the reveal lands in. A dep, not
  // inline, because requestReveal lives in the editor stack and the registry
  // must stay importable by pure unit tests.
  revealBacklink(path: string, line: number, raw: string): void;
  // The head of a note's live document — enough of it to parse frontmatter —
  // or null when no editor holds that doc. A head, not the whole text: `when`
  // runs on every menu/palette render, and a note carrying a pasted blob
  // should not be serialized just to ask whether it names a profile.
  noteHead(docId: string): string | null;
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
