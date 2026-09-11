// Every user-facing command's identity lives here: its title and its key
// bindings. Pure data, with no imports from app code, so the editor's
// CodeMirror keymaps, the terminals' xterm handlers, the window dispatcher,
// tooltips, menu chips, and the palette can all read it without pulling React
// or the store into pure modules.
//
// Key strings use CodeMirror's spelling ("Mod-Shift-w", "Ctrl-`"). Mod is ⌘,
// since this is a macOS-only app. The first key in a list is the one shown in
// tooltips and menu chips. The rest are live aliases.
//
// The dispatch contract (interactions.md §7): a handler that consumes a chord
// must call preventDefault, and the window dispatcher only sees leftovers.

export interface KeySpec {
  title: string;
  keys?: readonly string[];
  // Bare keys that fire only while a matching list row has focus (the note
  // list, the trash, the workspace strip). Kept apart from `keys` because they
  // are not chords: they are typing anywhere else, and the resolver only
  // consults them in the list domain (interactions.md §2).
  listKeys?: readonly string[];
}

export const COMMANDS = {
  // High-frequency create / navigate. ⌘T is the legacy alias for New Note:
  // the action has always been "new tab", and the tab-bar + button still says
  // so, but the thing a tab holds is a note.
  "note.new": { title: "New Note", keys: ["Mod-n", "Mod-t"] },
  // Creates or opens today's local YYYY-MM-DD note in the daily workspace
  // (settings daily.workspace, else the selected one). J stands for journal:
  // of the free ⌘ letters (E J L O R U Y) it is the only mnemonic one, and ⌘O
  // stays held for a literal "Open…" someday. ⇧⌘J stays free for a future
  // bigger-scope variant.
  "daily.open": { title: "Open Today's Daily Note", keys: ["Mod-j"] },
  // A new note from a template: any note whose frontmatter declares
  // `template: true`. ⌥⌘N is the secondary form of ⌘N (interactions.md §2).
  // The command palette is the picker: it opens pre-filtered to one entry per
  // template, the way workspace.select puts one entry per workspace in the
  // palette. Always visible: with no templates it lands on New Template.
  "note.fromTemplate": { title: "New Note from Template…", keys: ["Alt-Mod-n"] },
  // Creates a pre-marked note whose body is the cheatsheet ({{tokens}}, the
  // marker, the carry rules): the empty state's exit, and the "new template"
  // verb thereafter. Palette-only, since making one is a once-in-a-while act.
  // The title follows the New Note / New Workspace grammar. "Starter Template"
  // was rejected as a name, because it reads as a second concept beside
  // "template".
  "template.starter": { title: "New Template" },
  // The template marker's two verbs, acting on the current note. Exactly one
  // shows at a time, so the visible title says what will happen. The `when`s
  // read the note's live frontmatter, as profile.open's does. Palette-only,
  // like the other frontmatter verbs.
  "note.templateOn": { title: "Make This Note a Template" },
  "note.templateOff": { title: "Remove Template Marker" },
  // Edit and New are two faces of one act, and only one shows at a time, like
  // the marker verbs. Edit opens the `template: daily` note ⌘J instantiates.
  // New creates a pre-marked starter when that workspace has none, so nobody
  // hand-writes the role. Both act in the workspace ⌘J acts in
  // (daily.workspace resolved at boot, else the selected one), and the daily
  // role is per-workspace: a template in another workspace is one ⌘J will not
  // use. Palette-only, since editing a daily template is a once-in-a-while
  // act, and ⇧⌘J stays reserved for a bigger-scope ⌘J.
  "daily.templateEdit": { title: "Edit Daily Template" },
  "daily.templateNew": { title: "New Daily Template" },
  // The built-in documentation, a hidden read-only workspace (architecture.md
  // §3b): never a strip row, absent from ⌘1…9, every mutating verb gated (and
  // refused Bun-side regardless). Having no strip row leaves no way back from
  // the strip, so on a one-window client the button that opened the manual
  // closes it (registry.ts). No chord, since the docs are an occasional
  // destination: the palette and the header's help button carry it.
  "docs.toggle": { title: "Documentation" },
  "docs.licenses": { title: "Third-Party Licenses" },
  "palette.notes": { title: "Go to Note…", keys: ["Mod-p"] },
  "palette.commands": { title: "Command Palette…", keys: ["Mod-Shift-p"] },
  // Full-text search across note bodies, in the same overlay (typing "#" first
  // in ⌘P is the sigil route, like ">" for commands). ⌥⌘P is the ⌥-variant of
  // quick-open. The shift-scope rule would want ⇧⌘F (find, across notes), but
  // ⇧⌘F is the editor's working replace fallback under cmux (editor.replace
  // below) and search must stay reachable from editor focus.
  "palette.search": { title: "Search Notes…", keys: ["Alt-Mod-p"] },

  // Tabs. ⌘W closes the focused pane's active tab; ⇧⌘W is the pane (the
  // "bigger scope" shift rule).
  "tab.close": { title: "Close Tab", keys: ["Mod-w"] },
  "tab.closeOthers": { title: "Close Other Tabs" },
  // Promotes a preview tab, the italic one a navigation opened
  // (interactions.md §1b). No chord: it is the rare half of the pair, since
  // typing in the note does the same thing and is what usually happens next.
  // Double-clicking the tab is the accelerator, the way double-clicking a
  // workspace row renames it (R3), and the menu entry is the discoverable
  // path — and the only one on a client with no double-click.
  "tab.keep": { title: "Keep Tab Open" },
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
  // Opens the native folder picker; the chosen directory becomes a workspace
  // whose notes stay where they already are. No chord, since attaching a
  // folder is not frequent enough to spend one. The command lives in the
  // palette and in the + button's dropdown (Sidebar.tsx).
  "workspace.attach": { title: "Attach Folder as Workspace…" },
  "workspace.open": { title: "Switch to Workspace", listKeys: ["Enter"] },
  "workspace.rename": { title: "Rename Workspace…", listKeys: ["r"] },
  "workspace.icon": { title: "Change Icon…", listKeys: ["i"] },
  // No chord and no bare key: moving a folder is rare. The row's context menu
  // is its main home, and the palette carries it too. A managed workspace goes
  // straight to the native destination picker, Bun-side like attach. An
  // external one gets an in-app chooser first (back to ~/.ledge, or that
  // picker), because the native dialog cannot easily reach hidden ~/.ledge.
  "workspace.move": { title: "Move Workspace Folder…" },
  "workspace.close": { title: "Close Workspace", listKeys: ["Backspace"] },

  // Chrome. ⌘, is the macOS settings convention. It opens settings.jsonc in
  // Ledge's own editor dialog. There is no settings panel: the file is the UI
  // and its comments are the documentation. Edits apply at the next launch
  // (architecture.md §6).
  "sidebar.toggle": { title: "Toggle Sidebar", keys: ["Alt-Mod-b"] },
  // The right-hand Backlinks panel: which notes [[link]] to the current one.
  // ⌥⌘L follows the sidebar's ⌥-tier pattern with a different letter, since B
  // is taken (⌘B is Bold, ⌥⌘B the sidebar). L stands for links.
  "backlinks.toggle": { title: "Toggle Backlinks", keys: ["Alt-Mod-l"] },
  // The right panel's other face: the active note's headings, live. Same
  // ⌥-tier as its sibling toggles, with O for outline (⌘O itself stays free).
  // The right panel holds one face at a time, so the toggles are
  // radio-with-off: opening one closes whichever was open.
  "outline.toggle": { title: "Toggle Outline", keys: ["Alt-Mod-o"] },
  // The right panel's third face: the workspace's tag directory (every #tag
  // its notes carry, with counts), drilling into the notes bearing one. Same
  // ⌥-tier as its sibling toggles, with T for tags: ⌘T is the New Note alias,
  // but the ⌥⌘T slot was free.
  "tags.toggle": { title: "Toggle Tags", keys: ["Alt-Mod-t"] },
  "terminal.toggle": { title: "Toggle Terminal", keys: ["Ctrl-`"] },
  "terminal.close": { title: "Close Terminal" },
  "settings.open": { title: "Settings…", keys: ["Mod-,"] },
  // Which machine holds the notes (remote.md §8). No chord: switching servers
  // tears the whole session down and rebuilds it, so it is not a toggle. The
  // persistent indicator above the workspace strip is the everyday surface,
  // and this is the palette's and the menu's way in. The ellipsis says it
  // opens a chooser rather than switching to anything.
  "connection.switch": { title: "Notes On…" },
  // Tries the server again immediately. No chord: it is one click on the
  // indicator that already says the connection is down, and the app retries on
  // its own anyway (shared/transport.ts). No ellipsis, because it acts rather
  // than opening anything.
  "connection.reconnect": { title: "Reconnect" },
  // Another window, which is another client of another server (remote.md §8a).
  // No chord, because the N family is spent: ⌘N is New Note, ⇧⌘N New
  // Workspace, ⌥⌘N New Note from Template. A window is a bigger scope than a
  // workspace, so the shift rule would want ⇧⌘N, but the smaller scope holds
  // it. N goes to notes here rather than to windows (interactions.md §2).
  "window.new": { title: "New Window" },
  // Writes the `ledge` shim so the notes are reachable from any terminal
  // (bun/cliShim.ts). Palette-only: a once-per-machine act earns no chord.
  "cli.install": { title: "Install Shell Command (ledge)" },
  // Opens the log folder, so the previous session's copy sits next to the
  // current one. After a crash the previous one is the copy worth sending.
  // Titled "Reveal" because it lands in Finder, not in Ledge: the log is not a
  // note, and opening it in the editor would suggest it is.
  "log.reveal": { title: "Reveal Log in Finder" },

  // Per-note params (frontmatter). Both verbs are palette and menu only, since
  // neither is frequent enough to spend a chord on. Restart kills the note's
  // shells, keeps its params, and respawns lazily: the escape hatch for params
  // that apply at restart. No confirm, because closing a tab already tears
  // shells down unconfirmed and this is the same class of loss
  // (interactions.md §4, arrangement loss).
  "session.restart": { title: "Restart Note Shell" },
  // Opens the current note's profile in Ledge's own editor dialog
  // (components/ProfileEditor.tsx), the same in-app move as settings. The rows
  // are masked KEY=value pairs rather than raw text, because profiles hold
  // secrets.
  "profile.open": { title: "Edit Note Profile…" },
  // Puts the caret inside the note's frontmatter, creating empty fences first
  // when there is none. The registry retitles it "Add Frontmatter" then. It is
  // one command rather than two because the dispatcher ignores `when`, so a
  // chord would fire the wrong face. ⌥⌘, is the ⌥-tier variant of ⌘,
  // (interactions.md §2): the same file-is-the-UI settings idea, for one note.
  "frontmatter.edit": { title: "Edit Frontmatter", keys: ["Alt-Mod-,"] },

  // Note locking (locking.md §7). ⌘L is the lock-on-walking-away gesture, the
  // one lock command frequent enough to earn a chord: of the free ⌘ letters, L
  // is the mnemonic one (⌥⌘L for backlinks is unrelated and stays). Unlock
  // gets no chord because it is interposed: opening a locked note prompts in
  // place, the host-picker move, and the palette entry is the proactive form.
  "vault.lock": { title: "Lock Notes", keys: ["Mod-l"] },
  "vault.unlock": { title: "Unlock Notes…" },
  // The per-note pair works like the template marker's two verbs: exactly one
  // shows, per the note's live locked flag. Rare acts, so palette-only.
  "note.lockOn": { title: "Lock This Note…" },
  "note.lockOff": { title: "Remove Lock…" },
  "vault.changePassphrase": { title: "Change Vault Passphrase…" },

  // Notes. note.delete is the row form (context menu, and `d`/⌫ on a focused
  // row); note.deleteCurrent is the ⌘⌫ / palette form acting on the focused
  // note. Both land in the trash with Undo (interactions.md §4). ⌘⌫ fires
  // from page focus only: inside the editor, CodeMirror's Mod-Backspace
  // (delete-to-line-start) wins by the preventDefault contract.
  "note.open": { title: "Open", listKeys: ["Enter"] },
  // A Backlinks-panel row: opens the linking note with its [[link]] line
  // revealed and selected, the search overlay's open-at-the-hit as a row verb.
  // It is its own command rather than note.open because the target kind
  // differs and the behavior is open-at-a-place, not just open.
  "backlink.open": { title: "Open", listKeys: ["Enter"] },
  // Outline-panel rows. Jump moves the caret to that heading in the note's own
  // editor, with no note opened: the outline always describes the active tab.
  // Copy Link puts the heading's wikilink ([[Title#Heading]]) on the clipboard,
  // ready to paste into another note. `c` is the same row verb note rows spend
  // on Copy Path.
  "outline.jump": { title: "Jump to Heading", listKeys: ["Enter"] },
  "outline.copyLink": { title: "Copy Link", listKeys: ["c"] },
  // Tags-panel rows. A directory row's Enter drills into its tag, the same
  // verb a rendered #tag in the editor or a tag row in the overlay runs. An
  // occurrence row's Enter opens the bearing note with the tag's line revealed
  // and selected, which is backlink.open's behavior with a tag target.
  "tag.open": { title: "Show Notes", listKeys: ["Enter"] },
  "tag.openNote": { title: "Open", listKeys: ["Enter"] },
  "note.delete": { title: "Delete", listKeys: ["d", "Backspace"] },
  "note.deleteCurrent": { title: "Delete Note", keys: ["Mod-Backspace"] },
  "note.copyPath": { title: "Copy Path", listKeys: ["c"] },
  // The favorite marker, which puts a note in the browser's Favorites section
  // as well as its folder. One command that toggles, not the two faces the
  // template and lock markers use: those are palette-only, and this one holds
  // a bare key, which the dispatcher resolves without consulting `when`
  // (commands/keymap.ts). Two faces sharing `f` would leave whichever
  // registered first swallowing the key on every row the other face owns. The
  // registry retitles it "Unfavorite" on a marked note, as frontmatter.edit
  // retitles itself. `f` is the note row's spare mnemonic beside `m`, and
  // favoriting is a row act above all: the note you want at the top is one you
  // are usually looking at in the list. No chord, since the ⌘ letters are
  // spent (interactions.md §2) and the section is a click away.
  "note.favorite": { title: "Favorite", listKeys: ["f"] },
  // Filing. No chord for any of the three: putting a note somewhere is a
  // once-in-a-while act, and the N family is already spent (interactions.md
  // §2). `m` is the note row's spare mnemonic. The folder row's Enter is its
  // disclosure, because a folder's primary action is showing what is in it.
  "note.move": { title: "Move to Folder…", listKeys: ["m"] },
  "note.newInFolder": { title: "New Note in Folder" },
  "folder.new": { title: "New Folder…" },
  "folder.toggle": { title: "Expand", listKeys: ["Enter"] },
  // The one folder verb that earns a bare key. `/` is the search key
  // list-shaped programs already spell it with. The folder row kind has only
  // Enter spent on it, and narrowing a search is a frequent folder act. The
  // CLI's `-f` and the MCP tools' `folder` have scoped this way since agents
  // got folders; this is the same scope for the person at the keyboard.
  "folder.search": { title: "Search in Folder", listKeys: ["/"] },
  // `r` is the rename key one register down: it already means Rename on a
  // workspace row, and a bare key is paired with a row kind, so the folder row
  // is free to spell it the same way. Nothing else on that row wanted it.
  "folder.rename": { title: "Rename Folder…", listKeys: ["r"] },
  // The note row's destructive pair, on the folder row: a bare key is paired
  // with a row kind, so `d`/⌫ can mean Delete on both without either shadowing
  // the other. The ellipsis matches trash.delete for a weaker reason. Its
  // dialog says how many notes sit under a collapsed row, not that the delete
  // is irreversible (interactions.md §4).
  "folder.delete": { title: "Delete Folder…", listKeys: ["d", "Backspace"] },

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
  // The clipboard, and the selection it acts on. Editor-internal like the rest
  // of this group: ⌘C/⌘X/⌘V/⇧⌘V are bound inside CodeMirror at Prec.highest
  // (the views:// scheme is not a secure context, so the pasteboard goes
  // through Bun, editor/clipboard.ts), ⌘A is CodeMirror's own selectAll, and
  // the window dispatcher fires none of them (domains: []).
  //
  // They are commands because the editor's context menu renders from the
  // registry like every other menu (interactions.md §11), and a menu item
  // cannot advertise a chip nobody derived. They always mean the focused
  // note's editor. The menu bar spells the same four verbs as AppKit `role`
  // items, which follow focus through the responder chain (interactions.md §10).
  "editor.cut": { title: "Cut", keys: ["Mod-x"] },
  "editor.copy": { title: "Copy", keys: ["Mod-c"] },
  "editor.paste": { title: "Paste", keys: ["Mod-v"] },
  "editor.pastePlain": { title: "Paste as Plain Text", keys: ["Mod-Shift-v"] },
  "editor.selectAll": { title: "Select All", keys: ["Mod-a"] },
  "editor.find": { title: "Find", keys: ["Mod-f"] },
  "editor.replace": { title: "Find and Replace", keys: ["Mod-Alt-f", "Mod-Shift-f"] },
  "editor.findNext": { title: "Find Next", keys: ["Mod-g", "F3"] },
  "editor.findPrev": { title: "Find Previous", keys: ["Mod-Shift-g", "Shift-F3"] },
  "block.runInline": { title: "Run Block Inline", keys: ["Mod-Enter"] },
  "block.runInTerminal": { title: "Run Block in Terminal", keys: ["Mod-Shift-Enter"] },
  // Markdown formatting (editor/formatting.ts). RESERVED_KEYS held these
  // chords until there was something for them to mean. Bold and italic toggle
  // the markers around the selection or the word at the caret. ⌘K wraps the
  // selection as a [text](url) link with the caret in the missing half.
  "format.bold": { title: "Bold", keys: ["Mod-b"] },
  "format.italic": { title: "Italic", keys: ["Mod-i"] },
  "format.link": { title: "Insert Link", keys: ["Mod-k"] },
  // Indent, outdent and the note picker: three acts a desktop reaches by
  // typing (Tab, ⇧Tab, `[[`) and a phone cannot, since the iPhone software
  // keyboard has no Tab key. They carry no chord; Tab inside the editor stays
  // the accelerator (editor/setup.ts indentKeymap). They are commands so the
  // accessory bar can name them and the palette can offer them (ios.md §7).
  "format.indent": { title: "Indent" },
  "format.outdent": { title: "Outdent" },
  "format.wikiLink": { title: "Link to Note" },
  // A fourth act of the same kind (editor/fences.ts). Typing ``` on an iPhone
  // costs three trips through the keyboard's numeric page, one long press
  // each, and a code block is the construct this app is built around. No chord
  // here either, since typing the marks is the desktop's accelerator and costs
  // one key there.
  "format.codeBlock": { title: "Code Block" },
  // A picture, from wherever this device keeps pictures: the file dialog on a
  // Mac; the photo library, the camera or Files on a phone (ios.md §11). No
  // chord: ⌘V is already
  // the desktop's way in and this is the other source, and on the client with
  // no ⌘V a chord would be no way in at all.
  "image.insert": { title: "Insert Image…" },
  // Palette-only: ⌘-click on the link itself is the accelerator
  // (editor/livePreview.ts), same grammar as the frontmatter profile name.
  // No chord: not frequent enough to spend one, and ⌘K is Insert Link above.
  "link.open": { title: "Open Link" },
  // Palette-only: clicking the rendered checkbox is the accelerator
  // (editor/livePreview.ts TaskWidget); this is the keyboard path for a
  // caret already on the task's line.
  "task.toggle": { title: "Toggle Checkbox" },

  // Per-block hover buttons (editor/blocks.ts). They act on the hovered block,
  // so they are not palette commands, but their tooltips derive from here like
  // every other icon button.
  "block.copy": { title: "Copy" },
  "block.copyOutput": { title: "Copy Output" },
  "block.dismissOutput": { title: "Dismiss" },
} as const satisfies Record<string, KeySpec>;

export type CommandId = keyof typeof COMMANDS;

// Keys held back from binding (interactions.md §2). Currently empty: ⌘B/⌘I/⌘K
// sat here until formatting spent them (format.* above). The list and its
// keys.test.ts guard stay, so the next hold has somewhere enforceable to live.
// CodeMirror's selectNextOccurrence is unbound for a different reason:
// editor/find.ts drops its stock Mod-d binding because ⌘D is Split Right.
export const RESERVED_KEYS: readonly string[] = [];

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
// chord wins over a row verb: ⌘⌫ works from anywhere in the page while `⌫`
// needs the row focused, so the chord is the one to advertise when a command
// has both.
export function keyOf(id: CommandId): string | null {
  return keysOf(id)[0] ?? listKeysOf(id)[0] ?? null;
}

export function titleOf(id: CommandId): string {
  return COMMANDS[id].title;
}
