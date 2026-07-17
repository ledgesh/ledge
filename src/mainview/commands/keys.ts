// The single source of truth for every user-facing command's identity: its
// title and its key bindings. Pure data — no imports from app code — so the
// editor's CodeMirror keymaps, the terminals' xterm handlers, the window
// dispatcher, tooltips, menu chips, and the palette can all read from it
// without dragging React or the store into pure modules.
//
// Key strings use CodeMirror's spelling ("Mod-Shift-w", "Ctrl-`"); Mod is ⌘
// (this is a macOS-only app). The first key in a list is the one advertised in
// tooltips and menu chips; the rest are live aliases.
//
// The dispatch contract (docs/interactions.md §7): any handler that consumes a
// chord must preventDefault, and the window dispatcher only sees leftovers.

export interface KeySpec {
  title: string;
  keys?: readonly string[];
  // Bare keys that fire only while a matching list row has focus (the note
  // list, the trash, the workspace strip). Kept apart from `keys` because they
  // are not chords: they are typing anywhere else, and the resolver only
  // consults them in the list domain (docs/interactions.md §2).
  listKeys?: readonly string[];
}

export const COMMANDS = {
  // High-frequency create / navigate. ⌘T is the legacy alias for New Note:
  // the action has always been "new tab", and the tab-bar + button still says
  // so, but the thing a tab holds is a note.
  "note.new": { title: "New Note", keys: ["Mod-n", "Mod-t"] },
  "palette.notes": { title: "Go to Note…", keys: ["Mod-p"] },
  "palette.commands": { title: "Command Palette…", keys: ["Mod-Shift-p"] },

  // Tabs. ⌘W closes the focused pane's active tab; ⇧⌘W is the pane (the
  // "bigger scope" shift rule).
  "tab.close": { title: "Close Tab", keys: ["Mod-w"] },
  "tab.closeOthers": { title: "Close Other Tabs" },
  "tab.next": { title: "Next Tab", keys: ["Ctrl-Tab", "Mod-Shift-]"] },
  "tab.prev": { title: "Previous Tab", keys: ["Ctrl-Shift-Tab", "Mod-Shift-["] },

  // Panes.
  "pane.splitRight": { title: "Split Right", keys: ["Mod-d"] },
  "pane.splitDown": { title: "Split Down", keys: ["Mod-Shift-d"] },
  "pane.close": { title: "Close Pane", keys: ["Mod-Shift-w"] },

  // Workspaces. Rename/close are menu-and-palette commands acting on a target
  // (or the selected workspace); the indexed jumps are generated per workspace
  // (workspaceSelectKey below). The bare keys are the row verbs: they fire
  // only on a focused workspace row, which is why `r` can also mean Restore on
  // a trashed note without colliding.
  "workspace.new": { title: "New Workspace", keys: ["Mod-Shift-n"] },
  "workspace.open": { title: "Switch to Workspace", listKeys: ["Enter"] },
  "workspace.rename": { title: "Rename Workspace…", listKeys: ["r"] },
  "workspace.icon": { title: "Change Icon…", listKeys: ["i"] },
  "workspace.close": { title: "Close Workspace", listKeys: ["Backspace"] },

  // Chrome. ⌘, is the macOS settings convention; it opens settings.json in
  // the OS editor (there is no settings panel — the file is the UI, and edits
  // apply at the next launch; docs/architecture.md "Settings").
  "sidebar.toggle": { title: "Toggle Sidebar", keys: ["Alt-Mod-b"] },
  "terminal.toggle": { title: "Toggle Terminal", keys: ["Ctrl-`"] },
  "terminal.close": { title: "Close Terminal" },
  "settings.open": { title: "Settings…", keys: ["Mod-,"] },

  // Per-note params (frontmatter). Both palette/menu-only: neither is frequent
  // enough to spend a chord on. Restart is the escape hatch for restart-applies
  // params — kill the note's shells, keep its params, respawn lazily; no
  // confirm, because closing a tab already tears shells down unconfirmed and
  // this is the same class of loss (interactions.md §4, arrangement loss).
  // Edit Note Profile opens the CURRENT note's profile in Ledge's own editor
  // dialog — not the OS editor like settings.json, because macOS binds no
  // application to ".env" and `open` dead-ends (components/ProfileEditor.tsx).
  "session.restart": { title: "Restart Note Shell" },
  "profile.open": { title: "Edit Note Profile…" },

  // Notes. note.delete is the row form (context menu, and `d`/⌫ on a focused
  // row); note.deleteCurrent is the ⌘⌫ / palette form acting on the focused
  // note. Both land in the trash with Undo (docs/interactions.md §4). ⌘⌫ fires
  // from page focus only: inside the editor, CodeMirror's Mod-Backspace
  // (delete-to-line-start) wins by the preventDefault contract.
  "note.open": { title: "Open", listKeys: ["Enter"] },
  "note.delete": { title: "Delete", listKeys: ["d", "Backspace"] },
  "note.deleteCurrent": { title: "Delete Note", keys: ["Mod-Backspace"] },
  "note.copyPath": { title: "Copy Path", listKeys: ["c"] },

  // Trash rows get the same grammar as note rows, with the verbs the trash has:
  // `r` restores, `d`/⌫ unlinks after a confirm. trash.delete is the second
  // irreversible action in the app (the first being trash.empty), and the only
  // per-note one.
  "note.restore": { title: "Restore", listKeys: ["r"] },
  "trash.delete": { title: "Delete Permanently…", listKeys: ["d", "Backspace"] },
  "trash.empty": { title: "Empty Trash…" },

  // Editor-internal: bound inside CodeMirror (Prec.highest), never dispatched
  // at the window level. Listed here so tooltips, the palette, and the CM
  // keymaps share one spelling. ⌥⌘F is the macOS find-and-replace convention
  // but cmux swallows it as a system-global hotkey; ⇧⌘F is the working
  // fallback (see editor/find.ts).
  "editor.save": { title: "Save", keys: ["Mod-s"] },
  "editor.find": { title: "Find", keys: ["Mod-f"] },
  "editor.replace": { title: "Find and Replace", keys: ["Mod-Alt-f", "Mod-Shift-f"] },
  "editor.findNext": { title: "Find Next", keys: ["Mod-g", "F3"] },
  "editor.findPrev": { title: "Find Previous", keys: ["Mod-Shift-g", "Shift-F3"] },
  "block.runInline": { title: "Run Block Inline", keys: ["Mod-Enter"] },
  "block.runInTerminal": { title: "Run Block in Terminal", keys: ["Mod-Shift-Enter"] },

  // Per-block hover buttons (editor/blocks.ts). Not palette commands — they
  // act on the hovered block — but their tooltips derive from here like every
  // other icon button.
  "block.copy": { title: "Copy" },
  "block.copyOutput": { title: "Copy Output" },
  "block.dismissOutput": { title: "Dismiss" },
} as const satisfies Record<string, KeySpec>;

export type CommandId = keyof typeof COMMANDS;

// Keys deliberately left unbound (docs/interactions.md §2): ⌘B/⌘I/⌘K are
// reserved for future Markdown formatting, and Mod-d select-next-occurrence
// stays out of the editor keymap because ⌘D is the split key.
export const RESERVED_KEYS = ["Mod-b", "Mod-i", "Mod-k"] as const;

// The indexed quick-jumps, generated per item rather than listed above:
// ⌘1…9 switches workspace, ⌃1…9 selects a tab in the focused pane. The
// held-modifier badges (lib/useCmdHeld.ts) advertise exactly these.
export function workspaceSelectKey(n: number): string {
  return `Mod-${n}`;
}

export function tabSelectKey(n: number): string {
  return `Ctrl-${n}`;
}

// Every binding for a command; empty when it is menu-only. (The lookup goes
// through KeySpec because COMMANDS is a literal union and not every entry
// carries a keys field.)
export function keysOf(id: CommandId): readonly string[] {
  return (COMMANDS[id] as KeySpec).keys ?? [];
}

// Every bare row verb for a command; empty when it has none.
export function listKeysOf(id: CommandId): readonly string[] {
  return (COMMANDS[id] as KeySpec).listKeys ?? [];
}

// The advertised (primary) key for a command, or null when it is menu-only. A
// chord wins over a row verb: ⌘⌫ works from anywhere in the page, while `⌫`
// needs the row focused, so the chord is the more honest thing to advertise
// when a command has both.
export function keyOf(id: CommandId): string | null {
  return keysOf(id)[0] ?? listKeysOf(id)[0] ?? null;
}

export function titleOf(id: CommandId): string {
  return COMMANDS[id].title;
}
