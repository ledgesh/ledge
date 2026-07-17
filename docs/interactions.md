# Ledge interaction spec

Normative rules for how actions are exposed to the user. Every user-facing
action in Ledge is a **command**, defined once in `src/mainview/commands/`
(`keys.ts` for identity, `registry.ts` for behavior). Hotkeys, context menus,
icon buttons, tooltips, and the command palette all derive from that single
definition. If a surface disagrees with the registry, the surface is wrong.

Sibling standards: `architecture.md` (boundaries, invariants, state
ownership), `testing.md` (what gets tested, and how behavior is verified).

## 1. Affordance matrix

Which affordances each class of action gets. "✓" is required, "–" is forbidden,
blank is optional.

| Action class                                                    | Hotkey                      | Icon button          | Context menu       | Palette          | Double-click      | Drag   |
| --------------------------------------------------------------- | --------------------------- | -------------------- | ------------------ | ---------------- | ----------------- | ------ |
| High-frequency create/navigate (new note, go to note, switch)   | ✓                           | where an anchor exists | –                | ✓                | –                 | –      |
| Layout (split, close pane, toggle sidebar/terminal)             | ✓                           | ✓ in-situ            | pane/tab menu      | ✓                | –                 | resize |
| Object-scoped ops (rename/close workspace, delete note, close tab) | focused object only      | hover-revealed       | ✓ *canonical home* | ✓ on current     | rename accelerator | reorder |
| **Row verbs** (open/delete a note, restore/purge a trashed one, rename/close a workspace) | ✓ bare key on the focused row | hover-revealed | ✓ *canonical home* | ✓ on current, if one exists | rename accelerator | reorder |
| Destructive-irreversible (empty trash, delete permanently)      | – never a chord; ✓ row verb behind a confirm | button in owning section | ✓ | ✓ (confirmed) | – | – |
| Editor-internal (find, run block, save)                         | ✓ CodeMirror keymap         | hover block buttons  | –                  | ✓ (refocuses editor) | –             | –      |
| Pointer gestures (resize, drag-reorder)                         | –                           | –                    | –                  | not commands     | –                 | ✓      |

Rules:

- **R1.** Every command appears in the command palette unless flagged
  `palette: false`. Indexed jumps (⌘1…9) collapse into dynamic
  "Switch to Workspace: …" entries.
- **R2.** A hover-revealed control is an accelerator, never the only path: a
  context-menu or palette equivalent must exist.
- **R3.** Double-click rename stays, but the context-menu "Rename" item is the
  discoverable path.
- **R4.** Pointer gestures (resize dividers, drag-reorder) are not commands and
  do not appear in the palette; their affordance is the cursor and the drop
  marker.
- **R5.** Every list of objects is keyboard-navigable: ↑/↓/Home/End move a
  focused row (roving tabindex, `lib/useListNav.ts`), and the focused row is
  what the row verbs act on. A list you can only reach with the pointer is a
  bug, not a style — the verbs have nothing to address without a focused row.
  Clicking a row **focuses it explicitly** (WebKit will not focus a tabindex'd
  div on its own) and nothing may take that focus away: opening a note from
  the sidebar shows it, but leaves focus on the row, so the verbs still work.
  Clicking into the editor is the gesture that says you want to type
  (`PaneTree.tsx` skips its auto-focus while a row has focus).
- **R6.** Every row kind gets the same grammar: **Enter** is its primary
  action, **⌫** its destructive one, and a mnemonic letter (`d`, `r`) may
  double up for either. A row kind with a verb missing from its context menu is
  a bug: the menu is the canonical home (R2) and the only place the verb is
  discoverable.
- **R7.** Lists select exactly one row, and a verb acts on the focused row —
  deliberately, not for want of the feature. Multi-select would force every row
  verb to answer "focused row, or the selection?", and answering it wrong once
  means `d` deletes five notes when you meant one. The verbs that would want it
  are few (delete notes, restore/purge trashed ones) and are already served by
  Undo and Empty Trash. If it is ever added, selection splits from focus in
  `useListNav` (an anchor for ⇧-click, a set for ⌘-click), rows publish
  `data-selected` for the dispatcher to collect the way it already collects
  `data-target-kind`, and commands opt in explicitly — a verb without the flag
  keeps acting on one row.

## 2. Hotkey allocation policy

- **⌘ (Mod)** — application commands. ⌘ and ⌃ are *not* interchangeable;
  the old `metaKey || ctrlKey` aliasing is gone.
- **⌃ (Ctrl)** — the terminal and intra-pane domain: ⌃` (terminal),
  ⌃1…9 (tab jump), ⌃Tab (tab cycle). Ctrl chords are never dispatched at the
  window level while the terminal has focus — the shell owns Ctrl.
- **⇧ (Shift)** — the "bigger scope" variant of the unshifted key:
  ⌘W tab → ⇧⌘W pane · ⌘D split right → ⇧⌘D split down · ⌘N note → ⇧⌘N
  workspace · ⌘P notes → ⇧⌘P commands · ⌘↩ inline run → ⇧⌘↩ terminal run ·
  ⌘G next → ⇧⌘G previous.
- **⌥ (Alt)** — secondary/rare variants: ⌥⌘F replace, ⌥⌘B sidebar.
- **Bare keys** — the verbs of a focused list row, and *only* those. They live
  in `listKeys`, never `keys`, and the resolver consults them solely in the
  `list` focus domain: anywhere else an unmodified key is typing, and the one
  thing worse than an undiscoverable delete is a delete bound to a letter you
  meant to type. A bare key must be paired with a `targetKind`, which is what
  lets `r` mean Rename on a workspace row and Restore on a trashed one; two
  commands may never claim the same bare key on the same row kind
  (`registry.test.ts` enforces both). A text field inside a row (the inline
  rename) is typing, not a row — the dispatcher checks for one first.
- **Reserved (unbound on purpose):** ⌘B, ⌘I, ⌘K are held for future Markdown
  formatting — which is why the sidebar is ⌥⌘B, not VS Code's ⌘B. ⌘D is the
  split key (iTerm/cmux muscle memory); `editor/find.ts` deliberately omits
  Mod-d select-next-occurrence for the same reason.

## 3. Keymap

The full table lives in code as `src/mainview/commands/keys.ts`; this is the
human-readable mirror. Domains: where the *window* dispatcher fires the
command (`page` | `editor` | `terminal` | `list`, by focus). `list` is a
focused row and sits inside `page`, so page commands fire there too — focusing
a note row must not cost you ⌘N. Editor-internal commands are bound inside
CodeMirror and never at the window level.

| Command               | Key                       | Notes |
| --------------------- | ------------------------- | ----- |
| New Note              | ⌘N (alias ⌘T)             | |
| Close Tab             | ⌘W                        | closes the focused pane's active tab |
| Next / Previous Tab   | ⌃Tab / ⌃⇧Tab (alias ⇧⌘] / ⇧⌘[) | |
| Go to Tab N           | ⌃1…9                      | focused pane; badge shows while ⌃ held |
| Split Right           | ⌘D                        | |
| Split Down            | ⇧⌘D                       | |
| Close Pane            | ⇧⌘W                       | |
| New Workspace         | ⇧⌘N                       | |
| Switch to Workspace N | ⌘1…9                      | badge shows while ⌘ held |
| Go to Note…           | ⌘P                        | |
| Command Palette…      | ⇧⌘P                       | also: type `>` as the first character in ⌘P |
| Toggle Terminal       | ⌃`                        | from terminal focus it closes the drawer |
| Toggle Sidebar        | ⌥⌘B                       | |
| Settings…             | ⌘,                        | opens settings.json in the OS editor (architecture.md §6: the file is the UI) |
| Restart Note Shell    | — (palette)               | kills the current note's shells; its frontmatter params apply at respawn (architecture.md §6a) |
| Edit Note Profile…    | — (palette; edit button on the block, hover/caret-revealed like block controls; ⌘-click the name as accelerator) | opens the profile the note's frontmatter names in Ledge's key/value dialog (macOS binds no app to .env), created seeded if new; hidden when it names none. The button is primary — it lives in the overlay layer where the pointer cursor works; ⌘-click (not click: a plain click is a caret move on editable text) goes solid-underline while ⌘ is held |
| Delete Note           | ⌘⌫                        | page focus only; in the editor CodeMirror's delete-to-line-start wins |
| Save                  | ⌘S                        | notes autosave; this skips the debounce |
| Find / Replace        | ⌘F / ⌥⌘F (fallback ⇧⌘F)   | editor only; ⌥⌘F may be swallowed by cmux |
| Find Next / Previous  | ⌘G / ⇧⌘G (also F3 / ⇧F3)  | editor only |
| Run Block Inline      | ⌘↩                        | cursor inside a runnable block |
| Run Block in Terminal | ⇧⌘↩                       | |
| Rename Workspace…     | `r` (also menu / palette / double-click) | |
| Change Icon…          | `i` (also menu / palette) | opens the icon grid on the workspace's row |
| Close Workspace       | `⌫` (also menu / hover ✕) | |
| Copy Path             | `c` (also note context menu) | |
| Empty Trash…          | — (button / palette, confirmed) | |

Row verbs, by row kind. Each fires only while a row of that kind has focus
(§2), and each has a context-menu item carrying the same chip:

| Row       | Enter             | `d` / `⌫`                  | other |
| --------- | ----------------- | -------------------------- | ----- |
| Note      | Open              | Delete (to trash, undoable) | `c` Copy Path |
| Trash     | —                 | Delete Permanently… (confirmed) | `r` Restore |
| Workspace | Switch to it      | Close Workspace            | `r` Rename, `i` Change Icon |

## 4. Destructive actions

- **Reversible destruction → no confirmation, provide undo.** Deleting a note
  moves it to `~/.ledge/.trash` and shows the Undo strip; a prompt in front of
  an undoable action teaches people to click through prompts.
- **Irreversible destruction → modal confirmation, focus on Cancel.** Two such
  actions exist, both in the Trash section: **Empty Trash** and **Delete
  Permanently** (one row). The confirmation *is* the command's behavior — the
  command opens the dialog rather than deleting, so the row verb (`d`), the
  menu item, and the button cannot diverge into an unconfirmed path. Anything
  that unlinks a file, rather than moving it aside, joins this list.
- **Arrangement loss (close tab / pane / workspace, restart a note's shells)
  → neither.** No data is destroyed; notes stay on disk. Restart Note Shell
  sits here deliberately: closing a tab already kills the same shells
  unconfirmed, and a confirm on the command whose whole point is "apply my
  frontmatter now" would be friction teaching click-through.
- Destructive menu items are styled destructive and never sit directly
  adjacent to their non-destructive sibling without a separator or ordering
  gap.

## 5. Tooltips

Every icon-only button's `title` is generated by `tooltip(commandId)` from
`commands/format.ts` — `"<Title> (<Key>)"`, or just the title when unbound.
Hand-written tooltip strings are forbidden on any control that runs a command:
the advertised-but-unbound ⌘W bug happened because a tooltip and a binding
were maintained separately. Affordances that are not commands — R4's pointer
gestures ("Drag to resize"), informational labels — have no binding to drift
from and may say what they like. Buttons
with visible text labels may omit the tooltip unless they have a key. Menu
items render the key as a right-aligned chip.

## 6. Escape and modal layering

One LIFO layer stack (`commands/layers.ts`); Escape always addresses the
topmost layer only:

1. Context menu, and the popovers that behave like one (the workspace icon
   picker: anchored, dismissed by a pick or a press outside)
2. Dialogs: confirm, and the profile editor
3. Palette / quick-open overlay
4. Editor find panel (CodeMirror-internal, editor focus only)
5. Terminal drawer (terminal focus only — documented tradeoff: full-screen
   TUIs in the drawer can't receive a bare Escape)

While a layer of kind menu/dialog/overlay is open, the window keymap
dispatcher is fully suppressed. New modals must register with `pushLayer`
rather than adding their own capture-phase listeners.

## 7. Key dispatch contract

- The window has exactly **one command-dispatching** keydown listener
  (`CommandProvider`), bubble phase. It skips events with `defaultPrevented`
  set. Two other window-level key listeners exist and are the sanctioned
  exceptions: the layer stack's capture-phase Escape (§6, `layers.ts`), and
  `useCmdHeld`'s modifier tracker, which only observes ⌘/⌃ state for the
  held-modifier badges and never consumes an event. Anything else key-shaped
  is an inner handler and follows the consume rule below.
- **Any inner handler that consumes a chord must `preventDefault()`.** That is
  the entire anti-double-fire contract: CodeMirror keymaps return `true`
  (which prevents default), xterm handlers call `preventDefault()` and return
  `false`. The window layer only sees leftovers.
- Editor-domain keys stay bound inside CodeMirror at `Prec.highest` and must
  keep returning `true` even when the action is a no-op (⌘S), because an
  unhandled ⌘-chord reaches AppKit's key-equivalent path and rings the system
  alert.
- Key strings live only in `commands/keys.ts`; CodeMirror keymaps, xterm
  handlers, and the window dispatcher all import from it.
- A list consumes only the pure navigation keys (↑/↓/Home/End) locally; every
  other key, row verbs included, falls through to the window dispatcher. Lists
  do not run commands — they publish which row is focused (as data attributes,
  read back by `commands/target.ts`) and let the one dispatcher decide.
- One exception to "unmatched keys fall through untouched": a bare ⌫ in the
  list domain is always consumed, even when its verb is refused (⌫ on the
  last workspace). Some WebKit builds treat an unhandled Backspace outside a
  text field as history-back, and a focused row must never navigate the app
  away (caught by `e2e/workspace-rows.spec.ts`).

## 8. Discoverability

- Every command is reachable from the palette (R1) with its key chip shown.
- Every bound key is rendered in its button tooltip or menu chip. Row verbs
  chip as the bare glyph (`D`, `R`, `⌫`), which is how a right-click teaches
  the keyboard path: you go looking for Delete once, and the menu tells you
  never to come back. A command with both a chord and a row verb advertises the
  chord — it works from anywhere, while the verb needs the row focused.
- The ⌘N / ⌃N held-modifier badges on workspaces and tabs stay, and their
  semantics are pinned to `keys.ts` by test.
