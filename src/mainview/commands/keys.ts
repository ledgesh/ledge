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
// The dispatch contract (interactions.md §7): any handler that consumes a
// chord must preventDefault, and the window dispatcher only sees leftovers.

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
  // The daily note: create-or-open today's local YYYY-MM-DD note in the daily
  // workspace (settings daily.workspace, else the selected one). J — the
  // journal key: of the free ⌘ letters (E J L O R U Y), J is the only one
  // with a mnemonic, and ⌘O stays held for a literal "Open…" someday. The ⇧
  // slot (⇧⌘J) stays free for a future bigger-scope variant.
  "daily.open": { title: "Open Today's Daily Note", keys: ["Mod-j"] },
  // The ⌥-tier variant of ⌘N (§2: secondary form of the base key): a new
  // note, but from a template — any note whose frontmatter declares
  // `template: true`. Opens the command palette pre-filtered to the
  // per-template entries — the palette is the picker, the workspace.select
  // dynamic-entry move. Always visible: with no templates yet it lands on
  // New Template instead, so the feature explains itself at the
  // moment someone reaches for it.
  "note.fromTemplate": { title: "New Note from Template…", keys: ["Alt-Mod-n"] },
  // The empty state's exit, and the "new template" verb thereafter: creates a
  // pre-marked note whose BODY is the cheatsheet ({{tokens}}, the marker, the
  // carry rules), so the documentation is the thing itself. Named in the
  // New Note / New Workspace grammar — "Starter Template" was rejected
  // because it reads as a second concept beside "template". Palette-only —
  // once-in-a-while acts earn no chord.
  "template.starter": { title: "New Template" },
  // The marker's two verbs, on the current note: exactly one shows at a time
  // (the `when`s read the note's live frontmatter, profile.open's move), so
  // the visible title always says what will happen. Palette-only, like the
  // other frontmatter verbs.
  "note.templateOn": { title: "Make This Note a Template" },
  "note.templateOff": { title: "Remove Template Marker" },
  // The daily role's verb, two faces of one act (exactly one visible, like
  // the marker verbs): open the `template: daily` note ⌘J instantiates, or —
  // when its workspace has none — create a pre-marked starter so nobody
  // hand-writes the role. Both act in the workspace ⌘J acts in
  // (daily.workspace resolved at boot, else the selected one — the role is
  // per-workspace, so pointing anywhere else would edit a template ⌘J
  // ignores). Palette-only: editing your daily template is a
  // once-in-a-while act, and ⇧⌘J stays reserved for a bigger-scope ⌘J.
  "daily.templateEdit": { title: "Edit Daily Template" },
  "daily.templateNew": { title: "New Daily Template" },
  // The built-in documentation, opened as a hidden read-only workspace: never
  // a strip row, absent from ⌘1…9, every mutating verb gated (and refused
  // Bun-side regardless). Selecting any workspace is still a way back, but
  // this is the reliable one — being no strip row is exactly what leaves the
  // manual without one of its own, so the button that opened it closes it. No
  // chord: docs are a sometimes destination, so the palette and the header's
  // help button carry it.
  "docs.toggle": { title: "Documentation" },
  "docs.licenses": { title: "Third-Party Licenses" },
  "palette.notes": { title: "Go to Note…", keys: ["Mod-p"] },
  "palette.commands": { title: "Command Palette…", keys: ["Mod-Shift-p"] },
  // Full-text search across note bodies, in the same overlay (typing "#" first
  // in ⌘P is the sigil route, like ">" for commands). ⌥⌘P as the ⌥-variant of
  // quick-open: the shift-scope rule would want ⇧⌘F (find, but across notes),
  // but ⇧⌘F is the editor's working replace fallback under cmux (see
  // editor.replace below) and search must stay reachable from editor focus.
  "palette.search": { title: "Search Notes…", keys: ["Alt-Mod-p"] },

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
  // No chord (not frequent enough to spend one): lives in the palette and in
  // the + button's dropdown (Sidebar.tsx). Opens the native folder picker;
  // the chosen directory becomes a workspace whose notes live where they
  // already are.
  "workspace.attach": { title: "Attach Folder as Workspace…" },
  "workspace.open": { title: "Switch to Workspace", listKeys: ["Enter"] },
  "workspace.rename": { title: "Rename Workspace…", listKeys: ["r"] },
  "workspace.icon": { title: "Change Icon…", listKeys: ["i"] },
  // No chord and no bare key — moving a folder is a rare, deliberate act; the
  // row's context menu is the canonical home, the palette carries it too.
  // Managed: straight to the native destination picker, Bun-side like attach.
  // External: an in-app chooser first (back to ~/.ledge, or that picker),
  // because the native dialog cannot reasonably navigate into hidden ~/.ledge.
  "workspace.move": { title: "Move Workspace Folder…" },
  "workspace.close": { title: "Close Workspace", listKeys: ["Backspace"] },

  // Chrome. ⌘, is the macOS settings convention; it opens settings.jsonc in
  // Ledge's own editor dialog (there is no settings panel — the file is the
  // UI, its comments the documentation, and edits apply at the next launch;
  // architecture.md "Settings").
  "sidebar.toggle": { title: "Toggle Sidebar", keys: ["Alt-Mod-b"] },
  // The right-hand Backlinks panel: which notes [[link]] to the current one.
  // ⌥⌘L is the sidebar's ⌥-tier move with the letter the sidebar couldn't
  // give it: B is taken (⌘B is Bold, ⌥⌘B the sidebar), so L — links —
  // carries it.
  "backlinks.toggle": { title: "Toggle Backlinks", keys: ["Alt-Mod-l"] },
  // The right panel's other face: the active note's headings, live. Same
  // ⌥-tier as its sibling toggles; O for outline (⌘O itself stays free).
  // The two right-panel toggles are radio-with-off — opening one closes the
  // other, since they share the one slot.
  "outline.toggle": { title: "Toggle Outline", keys: ["Alt-Mod-o"] },
  // The right panel's third face: the workspace's tag directory (every #tag
  // its notes carry, with counts), drilling into the notes bearing one. Same
  // ⌥-tier as its sibling toggles; T — ⌘T itself is the New Note alias, but
  // the ⌥⌘T slot was free.
  "tags.toggle": { title: "Toggle Tags", keys: ["Alt-Mod-t"] },
  "terminal.toggle": { title: "Toggle Terminal", keys: ["Ctrl-`"] },
  "terminal.close": { title: "Close Terminal" },
  "settings.open": { title: "Settings…", keys: ["Mod-,"] },
  // Which machine holds the notes (remote.md §8). No chord: switching servers
  // tears the whole session down and rebuilds it, which is a deliberate act,
  // not a toggle — and the persistent indicator above the workspace strip is
  // the everyday surface, with this as the palette's and the menu's way in.
  // Ellipsis because it opens a chooser rather than switching to anything.
  "connection.switch": { title: "Notes On…" },
  // Try the server again, now. No chord: it is one click on the indicator that
  // is already saying the connection is down, and the app is trying on its own
  // anyway (shared/transport.ts) — this is impatience made pressable, not a
  // step anybody has to know about. No ellipsis: it acts.
  "connection.reconnect": { title: "Reconnect" },
  // Another window, which is another client of another server (remote.md §8a).
  // No chord, because the N family is spent: ⌘N is New Note, ⇧⌘N New Workspace,
  // ⌥⌘N New Note From Template. A window is a bigger scope than a workspace, so
  // the shift rule would want ⇧⌘N and the scope below it has it. A notebook
  // spending N on notes rather than on windows is the allocation, not an
  // oversight (§2).
  "window.new": { title: "New Window" },
  // Palette-only (a once-per-machine act earns no chord): writes the `ledge`
  // shim so the notes are reachable from any terminal (bun/cliShim.ts).
  "cli.install": { title: "Install Shell Command (ledge)" },
  // Opens the log FOLDER, so the previous session's copy is visible next to
  // the current one — after a crash that is the one worth sending. Titled
  // "Reveal" because it lands in Finder, not in Ledge: the log is not a note
  // and opening it in the editor would suggest it is.
  "log.reveal": { title: "Reveal Log in Finder" },

  // Per-note params (frontmatter). Both palette/menu-only: neither is frequent
  // enough to spend a chord on. Restart is the escape hatch for restart-applies
  // params — kill the note's shells, keep its params, respawn lazily; no
  // confirm, because closing a tab already tears shells down unconfirmed and
  // this is the same class of loss (interactions.md §4, arrangement loss).
  // Edit Note Profile opens the CURRENT note's profile in Ledge's own editor
  // dialog (components/ProfileEditor.tsx) — the same in-app move as settings,
  // with masked KEY=value rows instead of raw text because profiles hold
  // secrets.
  "session.restart": { title: "Restart Note Shell" },
  "profile.open": { title: "Edit Note Profile…" },
  // The block itself: put the caret inside the note's frontmatter, creating
  // empty fences first when there is none (the registry retitles it "Add
  // Frontmatter" then — one command, or the chord would fire the wrong face:
  // the dispatcher ignores `when`). ⌥⌘, is the ⌥-tier variant of ⌘, (§2):
  // Settings, but the NOTE's — frontmatter is the per-note settings block,
  // same file-is-the-UI stance, and the chord says so.
  "frontmatter.edit": { title: "Edit Frontmatter", keys: ["Alt-Mod-,"] },

  // Note locking (locking.md §7). ⌘L is the walking-away gesture — the
  // one lock command frequent enough to earn a chord: of the free ⌘ letters,
  // L is the mnemonic one (Lock; ⌥⌘L backlinks is unrelated and stays).
  // Unlock earns no chord: it is INTERPOSED — opening a locked note prompts
  // in place, the host-picker move — and the palette entry is the proactive
  // spelling. The per-note pair is two faces of one act (exactly one shows,
  // per the note's live locked flag — the template-marker move): rare acts,
  // palette-only.
  "vault.lock": { title: "Lock Notes", keys: ["Mod-l"] },
  "vault.unlock": { title: "Unlock Notes…" },
  "note.lockOn": { title: "Lock This Note…" },
  "note.lockOff": { title: "Remove Lock…" },
  "vault.changePassphrase": { title: "Change Vault Passphrase…" },

  // Notes. note.delete is the row form (context menu, and `d`/⌫ on a focused
  // row); note.deleteCurrent is the ⌘⌫ / palette form acting on the focused
  // note. Both land in the trash with Undo (interactions.md §4). ⌘⌫ fires
  // from page focus only: inside the editor, CodeMirror's Mod-Backspace
  // (delete-to-line-start) wins by the preventDefault contract.
  "note.open": { title: "Open", listKeys: ["Enter"] },
  // A Backlinks-panel row: opens the LINKING note with its [[link]] line
  // revealed and selected — the search overlay's open-at-the-hit, as a row
  // verb. Its own command (not note.open) because the target kind differs and
  // the behavior is open-at-a-place, not just open.
  "backlink.open": { title: "Open", listKeys: ["Enter"] },
  // Outline-panel rows: Jump moves the caret to that heading in the note's
  // OWN editor — no note open involved, the outline always describes the
  // active tab. Copy Link puts the heading's wikilink on the clipboard
  // ([[Title#Heading]]), ready to paste into another note; `c` is the same
  // row verb note rows spend on Copy Path.
  "outline.jump": { title: "Jump to Heading", listKeys: ["Enter"] },
  "outline.copyLink": { title: "Copy Link", listKeys: ["c"] },
  // Tags-panel rows. A directory row's Enter drills into its tag — the same
  // verb a rendered #tag in the editor or a tag row in the overlay runs. An
  // occurrence row's Enter opens the bearing note with the tag's line
  // revealed and selected — backlink.open's behavior with a tag target.
  "tag.open": { title: "Show Notes", listKeys: ["Enter"] },
  "tag.openNote": { title: "Open", listKeys: ["Enter"] },
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
  // The clipboard, and the selection it acts on. Editor-internal like the rest
  // of this group: ⌘C/⌘X/⌘V/⇧⌘V are bound inside CodeMirror at Prec.highest
  // (the views:// scheme is not a secure context, so the pasteboard goes
  // through Bun — editor/clipboard.ts), ⌘A is CodeMirror's own selectAll, and
  // the window dispatcher fires none of them (domains: []).
  //
  // They are commands at all because the editor's context menu renders from
  // the registry like every other menu (interactions.md §11), and a menu item
  // may not advertise a chip nobody derived. The menu BAR keeps AppKit `role`
  // items for the same four verbs on purpose (§10): a role goes through the
  // responder chain, so it means the terminal's clipboard while the terminal
  // has focus, and a bar installed from Bun cannot know where focus is. These
  // mean the focused NOTE's editor, always, which is exactly right for a menu
  // opened by right-clicking that editor.
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
  // Markdown formatting (editor/formatting.ts) — the chords that were held in
  // RESERVED_KEYS until they could mean exactly this. Bold/italic toggle the
  // markers around the selection or the word at the caret; ⌘K wraps the
  // selection as a [text](url) link with the caret in the missing half.
  "format.bold": { title: "Bold", keys: ["Mod-b"] },
  "format.italic": { title: "Italic", keys: ["Mod-i"] },
  "format.link": { title: "Insert Link", keys: ["Mod-k"] },
  // Indent, outdent and the note picker: three acts a desktop reaches by
  // typing (Tab, ⇧Tab, `[[`) and a phone cannot, because the iPhone software
  // keyboard has no Tab key at all. They carry no chord of their own — Tab
  // inside the editor is still the accelerator and is not going anywhere
  // (editor/setup.ts indentKeymap) — but they are commands now so that the
  // accessory bar has something to name and the palette has something to
  // offer (ios.md §7).
  "format.indent": { title: "Indent" },
  "format.outdent": { title: "Outdent" },
  "format.wikiLink": { title: "Link to Note" },
  // The fourth of the same kind, and the sharpest: ``` is three trips through
  // the iPhone keyboard's numeric page with a long press each, for the one
  // construct this app is FOR (editor/fences.ts). No chord either — typing the
  // marks is the desktop's accelerator and it costs one key there.
  "format.codeBlock": { title: "Code Block" },
  // The picture, from wherever this device keeps pictures: the file dialog on a
  // Mac, the photo library on a phone (ios.md §11). No chord, because ⌘V is
  // already the desktop's way in and this is the OTHER source — and because on
  // the client that has no ⌘V, a chord would be no way in at all.
  "image.insert": { title: "Insert Image…" },
  // Palette-only: ⌘-click on the link itself is the accelerator
  // (editor/livePreview.ts), same grammar as the frontmatter profile name.
  // No chord: not frequent enough to spend one, and ⌘K is Insert Link above.
  "link.open": { title: "Open Link" },
  // Palette-only: clicking the rendered checkbox is the accelerator
  // (editor/livePreview.ts TaskWidget); this is the keyboard path for a
  // caret already on the task's line.
  "task.toggle": { title: "Toggle Checkbox" },

  // Per-block hover buttons (editor/blocks.ts). Not palette commands — they
  // act on the hovered block — but their tooltips derive from here like every
  // other icon button.
  "block.copy": { title: "Copy" },
  "block.copyOutput": { title: "Copy Output" },
  "block.dismissOutput": { title: "Dismiss" },
} as const satisfies Record<string, KeySpec>;

export type CommandId = keyof typeof COMMANDS;

// Keys deliberately left unbound (interactions.md §2). Currently empty:
// ⌘B/⌘I/⌘K sat here until formatting spent them (format.* above). The list
// stays — with its keys.test.ts guard — so the next hold has somewhere
// enforceable to live. Mod-d select-next-occurrence is a different kind of
// unbound: editor/find.ts omits it because ⌘D is the split key.
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
// chord wins over a row verb: ⌘⌫ works from anywhere in the page, while `⌫`
// needs the row focused, so the chord is the more honest thing to advertise
// when a command has both.
export function keyOf(id: CommandId): string | null {
  return keysOf(id)[0] ?? listKeysOf(id)[0] ?? null;
}

export function titleOf(id: CommandId): string {
  return COMMANDS[id].title;
}
