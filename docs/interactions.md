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
- **⌥ (Alt)** — secondary/rare variants: ⌥⌘F replace, ⌥⌘B sidebar, ⌥⌘L
  backlinks (the sidebar's right-hand mirror, on the letter the sidebar
  couldn't give it: B is taken, so L — links), ⌥⌘O outline (the right
  panel's other face; O for outline, and ⌘O itself stays free), ⌥⌘T tags
  (the right panel's third face; ⌘T itself is the New Note alias, but the
  ⌥⌘T slot was free), ⌥⌘P full-text search (the ⌥-variant of ⌘P quick-open;
  the shift-scope rule would want ⇧⌘F — find, but across notes — but ⇧⌘F is
  the editor's working replace fallback under cmux, and search must stay
  reachable from editor focus), ⌥⌘N new note from template (the ⌥-variant
  of ⌘N: the same act, parameterized by a template — a note whose
  frontmatter declares `template: true`), ⌥⌘, frontmatter (the ⌥-variant
  of ⌘,: Settings, but the NOTE's — frontmatter is the per-note settings
  block, same file-is-the-UI stance).
- **⌘J** — Open Today's Daily Note. J is the journal key: of the ⌘ letters
  still free (E J L O R U Y), it is the only mnemonic one, and ⌘O stays
  held for a literal "Open…" someday. ⇧⌘J stays free for a future
  bigger-scope variant.
- **⌘L** — spoken for: Lock Notes, the note-locking design's walking-away
  gesture (`docs/locking.md` §7 — design accepted, unimplemented; the
  keymap row lands here with the feature). L is the lock mnemonic, and
  ⌥⌘L backlinks is unrelated.
- **Bare keys** — the verbs of a focused list row, and *only* those. They live
  in `listKeys`, never `keys`, and the resolver consults them solely in the
  `list` focus domain: anywhere else an unmodified key is typing, and the one
  thing worse than an undiscoverable delete is a delete bound to a letter you
  meant to type. A bare key must be paired with a `targetKind`, which is what
  lets `r` mean Rename on a workspace row and Restore on a trashed one; two
  commands may never claim the same bare key on the same row kind
  (`registry.test.ts` enforces both). A text field inside a row (the inline
  rename) is typing, not a row — the dispatcher checks for one first.
- **Formatting chords:** ⌘B, ⌘I, ⌘K are the Markdown formatting trio
  (Bold / Italic / Insert Link) — they sat in `RESERVED_KEYS` until they could
  mean exactly this, which is why the sidebar is ⌥⌘B, not VS Code's ⌘B.
  `RESERVED_KEYS` (now empty) and its `keys.test.ts` guard remain the
  mechanism for holding a chord on purpose. ⌘D is the split key (iTerm/cmux
  muscle memory); `editor/find.ts` deliberately omits Mod-d
  select-next-occurrence for the same reason.

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
| Open Today's Daily Note | ⌘J                      | create-or-open, idempotent: today's LOCAL YYYY-MM-DD note, resolved by title in the daily workspace (settings `daily.workspace`, else the selected one), created from that workspace's OWN note whose frontmatter says `template: daily` when one exists (`{{date}}`/`{{time}}`/`{{title}}`/`{{yesterday}}`/`{{tomorrow}}` substituted, prompt fences carried inert, marker stripped; several claimants resolve newest-first warned). Strictly per-workspace: another workspace's daily template is never borrowed — a daily note materializes unasked, so a template you cannot see from where you sit must not shape it; a workspace with no claimant gets the bare dated note. A corpus marker, not a setting — picked up live, no restart. Lands via the CLI-open path: workspace selected, tab focused |
| New Note from Template… | ⌥⌘N                     | opens the command palette pre-filtered to one generated entry per template — every note whose frontmatter declares `template: true`, read LIVE from the note lists (the palette IS the picker — the workspace.select dynamic-entry move; the selected workspace's templates lead, other workspaces' entries name their home). The pick instantiates that exact note as an "Untitled" note in the selected workspace, marker stripped — typing the H1 is the rename. Always visible: with no template anywhere it pre-filters to New Template instead, so the empty state teaches the feature |
| New Template          | — (palette)               | creates a pre-marked note ("Untitled Template" — the H1 is the rename UI) whose body IS the how-to (the `{{token}}` vocabulary written literally, the marker line, the carry rules) and opens it for editing — the empty state's exit, and the make-a-template verb thereafter. Named in the New Note / New Workspace grammar; "Starter Template" was rejected as a second concept beside "template" |
| Edit Daily Template / New Daily Template | — (palette) | one verb, two faces (exactly one shows, so the title says what will happen): opens the `template: daily` note ⌘J instantiates, or — when its workspace has none — creates a pre-marked starter (H1 + a `[[{{yesterday}}]]` carry-over line; spare on purpose, every line lands in each day's note) and opens it. Both act in the workspace ⌘J acts in (`daily.workspace` as resolved at boot and mirrored view-side off `workspaceList`, else the selected one — the role is per-workspace, so pointing anywhere else would touch a template ⌘J ignores), riding the external-open path so a pinned daily workspace gets selected first. Palette-only: a once-in-a-while act earns no chord, and ⇧⌘J stays reserved |
| Make This Note a Template / Remove Template Marker | — (palette) | adds/removes `template: true` in the current note's frontmatter, in its own editor (undoable; autosave + the watcher refresh carry it into the picker). Exactly one of the pair shows, per the note's live frontmatter — profile.open's move. Marked notes wear the LayoutTemplate glyph in the sidebar and the ⌘P rows — and the `template: daily` note wears ⌘J's own CalendarDays, so the icon column reads file = note, layout = template, calendar = what seeds each day (icons, not badges: same object, different kind; tabs stay plain — the marker line is on screen there). `ledge ls` appends `(template)` / `(daily template)`; `list_notes` carries the value |
| Close Tab             | ⌘W                        | closes the focused pane's active tab |
| Next / Previous Tab   | ⌃Tab / ⌃⇧Tab (alias ⇧⌘] / ⇧⌘[) | |
| Go to Tab N           | ⌃1…9                      | focused pane; badge shows while ⌃ held |
| Split Right           | ⌘D                        | |
| Split Down            | ⇧⌘D                       | |
| Close Pane            | ⇧⌘W                       | |
| New Workspace         | ⇧⌘N                       | creates a managed folder under ~/.ledge (Bun slugs the name) |
| Attach Folder as Workspace… | — (palette, + menu) | native folder picker (Bun-side; the view never names a path); the chosen directory's .md files become the workspace's notes. Picking an already-attached folder switches to it. Also in the New Workspace split button's dropdown (the strip's + row) |
| Switch to Workspace N | ⌘1…9                      | badge shows while ⌘ held |
| Go to Note…           | ⌘P                        | |
| Command Palette…      | ⇧⌘P                       | also: type `>` as the first character in ⌘P. A filtered query ranks by match quality with chorded commands one notch up (CHORD_BOOST, notes/fuzzy.ts): the §2 policy allocates chords to the frequent acts, so the chord doubles as the ranking signal — "daily" surfaces ⌘J's Open Today's Daily Note above the unchorded template verbs whose titles merely match earlier. The boost decides between comparable matches only; it never beats a tighter match ("edit daily" still leads with Edit Daily Template). An empty query keeps the registry's semantic order |
| Search Notes…         | ⌥⌘P                       | full-text over note bodies (one case-insensitive substring — shared/search.ts owns the grammar); also: type `#` as the first character in ⌘P. Enter opens the note with the matched line revealed and selected. A `#`-leading query additionally surfaces the workspace's matching tags as rows ABOVE the text hits (a #tag is text too, so its occurrences still list below); Enter on a tag row lands in the Tags panel drilled into it |
| Toggle Terminal       | ⌃`                        | from terminal focus it closes the drawer |
| Toggle Sidebar        | ⌥⌘B                       | |
| Toggle Backlinks      | ⌥⌘L                       | right-hand panel: the notes whose `[[wikilinks]]` point at the current note (the same scan agents get from the MCP `backlinks` tool). Rows are the standard keyboard list; Enter/click opens the linking note with the link's line revealed and selected, the search overlay's open-at-the-hit |
| Toggle Outline        | ⌥⌘O                       | the right panel's second face: the active note's headings, derived live from the editor doc (`headingsOf` — the fence-aware scan shared with the MCP appender and the heading reveal). The right-panel toggles are radio-with-off: opening one closes the others, since they share the one slot. Enter/click moves the caret to the heading in the note's own editor |
| Toggle Tags           | ⌥⌘T                       | the right panel's third face: the workspace's tag directory — every tag its notes carry (inline `#hashtags` and frontmatter `tags:` lines, shared/tags.ts owns the grammar; the same scan agents get from the MCP `tags` tool), alphabetical with per-NOTE counts. Enter/click on a tag drills into its occurrences; Enter/click on an occurrence opens the bearing note with the tag's line revealed (the backlink grammar). Clicking a rendered `#tag` in the editor, a `#`-query tag row in the overlay, or ⌘-clicking a frontmatter `tags:` token all land in the same drill-in. Rendered tags open on plain click (they are pills, not editable text — the checkbox reasoning); a tag under the caret is revealed text: plain click moves the caret, ⌘-click follows. Typing `#` plus a character in the editor pops the tag picker (the workspace's own tags; a bare `#` stays quiet — headings start that way) |
| Settings…             | ⌘,                        | opens settings.jsonc in Ledge's own editor dialog — raw JSONC, comments as the documentation, launch-time problems previewed live but never blocking Save (architecture.md §6: the file is the UI; edits apply at the next launch) |
| Restart Note Shell    | — (palette)               | kills the current note's shells; its frontmatter params apply at respawn (architecture.md §6a) |
| Add / Edit Frontmatter | ⌥⌘,                      | one command with a live title (a keyed command cannot be a two-faces pair — the dispatcher ignores `when`): with no block it inserts empty fences at the top with the caret on the body line between (Add); with one it moves the caret into the block (Edit). The block is still hand-edited text — the command only spares the scroll-up-and-type-fences gesture. Inside the block, completion teaches the grammar (editor/frontmatterComplete.ts, part of the one appCompletion): the seven params keys with one-line hints at line start (accepting writes the colon too; keys already declared are not re-offered), `template:` values (true / daily / false, explained), `tags:` values (the workspace's tags, the `#` picker's vocabulary), `host:` offers the reserved "local" |
| Fence auto-close      | — (typed, not a command)  | Enter at the end of an unterminated fence opener inserts the closer with the caret on the empty line between (editor/fences.ts): `---` on line 1 when no closing fence answers it (the block otherwise renders as an hr mid-gesture), and a ```/~~~ code-fence opener no later line closes (everything below would restyle as code until the closer exists). Enter on the opener of an already-closed block, mid-line, or on a closing fence is an ordinary newline |
| Edit Note Profile…    | — (palette; edit button on the block, hover/caret-revealed like block controls; ⌘-click the name as accelerator) | opens the profile the note's frontmatter names in Ledge's key/value dialog (macOS binds no app to .env), created seeded if new; hidden when it names none. The button is primary — it lives in the overlay layer where the pointer cursor works; ⌘-click (not click: a plain click is a caret move on editable text) goes solid-underline while ⌘ is held |
| Delete Note           | ⌘⌫                        | page focus only; in the editor CodeMirror's delete-to-line-start wins |
| Save                  | ⌘S                        | notes autosave; this skips the debounce |
| Find / Replace        | ⌘F / ⌥⌘F (fallback ⇧⌘F)   | editor only; ⌥⌘F may be swallowed by cmux |
| Find Next / Previous  | ⌘G / ⇧⌘G (also F3 / ⇧F3)  | editor only |
| Run Block Inline      | ⌘↩                        | cursor inside a runnable block |
| Run Block in Terminal | ⇧⌘↩                       | |
| Bold / Italic         | ⌘B / ⌘I                   | editor only (editor/formatting.ts); toggles `**`/`*` around the selection or the word at the caret — a bare caret drops an empty marker pair to type into. Run-based so the chords compose: ⌘I on `**bold**` stacks to `***both***` and ⌘I again peels only its own star |
| Insert Link           | ⌘K                        | editor only; wraps the selection as `[text](url)` — a selected URL becomes the destination with the caret in the empty label, any other selection (or the word at the caret) becomes the label with the caret in the empty destination |
| Open Link             | — (palette; click the rendered link as accelerator) | follows the link under the caret (editor/livePreview.ts) — a URL leaves the app, a `[[wikilink]]` opens the note it names. A RENDERED link (syntax concealed, including inside a rendered table and bare URLs the caret is outside) opens on plain click — while concealed it is a widget, not editable text, same reasoning as the checkbox. A REVEALED link is raw text being edited: plain click is a caret move, ⌘-click opens (same grammar as the profile name above; the underline goes solid while ⌘ is held). Mouse-editing a rendered link: click adjacent text or arrow in, which reveals it. Schemes are allowlisted (shared/links.ts) and re-checked Bun-side |
| Link to Note (`[[`)   | — (typed, not a command)  | `[[` in the editor pops the note-title picker (editor/wikilinks.ts; Enter accepts and closes the `]]`, Escape closes the popup only). `[[Title]]` resolves by title, case-insensitive exact, against the note's OWN workspace — resolved renders link-styled and opens on the Open Link grammar above; DANGLING renders muted with no hand cursor, and a plain click is the ordinary caret move that reveals it for fixing (a dead "open" affordance on a link that goes nowhere would be worse). `[[Title#Heading]]` opens with that ATX heading revealed, degrading to the top of the note when the heading is gone |
| Toggle Checkbox       | — (palette; click the rendered box as accelerator) | toggles the `[ ]`/`[x]` on the caret's line (editor/livePreview.ts). The box is a widget, not editable text, so a plain click may act — the caret-move grammar protects text, and the box is not text |
| Rename Workspace…     | `r` (also menu / palette / double-click) | |
| Change Icon…          | `i` (also menu / palette) | opens the icon grid on the workspace's row |
| Close Workspace       | `⌫` (also menu / hover ✕) | detaches the folder from the registry; every note stays on disk, re-attachable |
| Copy Path             | `c` (also note context menu) | |
| Empty Trash…          | — (button / palette, confirmed) | |

Row verbs, by row kind. Each fires only while a row of that kind has focus
(§2), and each has a context-menu item carrying the same chip:

| Row       | Enter             | `d` / `⌫`                  | other |
| --------- | ----------------- | -------------------------- | ----- |
| Note      | Open              | Delete (to trash, undoable) | `c` Copy Path |
| Trash     | —                 | Delete Permanently… (confirmed) | `r` Restore |
| Workspace | Switch to it      | Close Workspace            | `r` Rename, `i` Change Icon |
| Backlink  | Open at the link  | —                          | menu: Copy Path (the note-row command on the linking note) |
| Heading   | Jump to Heading   | —                          | `c` Copy Link — the heading's `[[Title#Heading]]` (plain `[[Title]]` when the row is the H1) |
| Tag       | Show Notes (drill in) | —                      | the same `tag.open` verb every tag click runs |
| Tag note  | Open at the tag   | —                          | menu: Copy Path (the note-row command on the bearing note) |

## 4. Destructive actions

- **Reversible destruction → no confirmation, provide undo.** Deleting a note
  moves it to its workspace folder's `.ledge-trash` and shows the Undo strip; a
  prompt in front of an undoable action teaches people to click through
  prompts.
- **Irreversible destruction → modal confirmation, focus on Cancel.** Two such
  actions exist, both in the Trash section: **Empty Trash** and **Delete
  Permanently** (one row). The confirmation *is* the command's behavior — the
  command opens the dialog rather than deleting, so the row verb (`d`), the
  menu item, and the button cannot diverge into an unconfirmed path. Anything
  that unlinks a file, rather than moving it aside, joins this list.
- **Arrangement loss (close tab / pane / workspace, restart a note's shells)
  → neither.** No data is destroyed; notes stay on disk. Closing a workspace
  detaches its folder from the registry but unlinks nothing — the folder is
  re-attachable with everything in it, which is what keeps it in this class
  rather than the confirmed one. Restart Note Shell sits here deliberately:
  closing a tab already kills the same shells unconfirmed, and a confirm on
  the command whose whole point is "apply my frontmatter now" would be
  friction teaching click-through.
- Destructive menu items are styled destructive and never sit directly
  adjacent to their non-destructive sibling without a separator or ordering
  gap.

## 4a. The host picker (multi-host notes)

A note whose frontmatter declares more than one `host:` must never execute a
block on a merely-remembered machine: **every run interposes the picker**
(`components/HostPicker.tsx` — a menu-layer popover, Escape/outside-press
dismisses per §6), because the realistic list is `staging prod` and the cost
of a misfire is asymmetric. The rules:

- **Always-ask, cheap-to-confirm.** The picker opens with the session's
  last pick focused: repeating the same machine is ⌘↵ then Enter; a
  *different* machine takes a deliberate arrow first. Dismissal runs
  nothing. (e2e/host-picker.spec.ts states each of these executably.)
- **One declared host asks nothing** — it runs there silently, and the run
  buttons' tooltips carry "— on <host>" so the target is visible before the
  click. Zero hosts is exactly the pre-host behavior.
- **The terminal drawer asks only at spawn.** The drawer is one shell with
  one host for its whole life, so opening it (or sending a block to it) on a
  multi-host note asks only when the shell is not already alive; afterward
  the header badge names the machine, loudly, for as long as the drawer is
  open. Moving it is Restart Note Shell, then reopen and pick again.
- The picker is the allowlist's UI, not its enforcement — Bun re-validates
  every requested host against the note's declared list
  (architecture.md §6a).

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
   picker and the host picker: anchored, dismissed by a pick or a press
   outside)
2. Dialogs: confirm, and the profile editor
3. Palette / quick-open overlay
4. Editor find panel, and the `[[` completion popup (both CodeMirror-internal,
   editor focus only; the popup's Escape is consumed by its keymap before the
   window ever sees it, per the §7 consume rule)
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

## 9. The CLI (`ledge`)

The one user-facing surface that is not a command in the registry: a shell
verb table (`src/bun/cli.ts`), governed here so it stays coherent with the
app rather than growing its own dialect.

- **Verbs are unix-shaped and few**: `ls`, `cat`, `search`, `tags`, `new`,
  `today`, `append`, `workspaces`, `open`, `install`, `mcp`, `help`. A bare
  `ledge` opens the app; a bare non-verb argument is a title to open
  (`ledge open <title>` is the spelled-out escape for a note titled like a
  verb — including one literally titled "today"). New verbs argue for
  themselves the way new commands do (§1): every verb is surface users must
  learn and help text must carry. `ledge tags` prints the directory
  (`#tag  count` rows); `ledge tags <tag>` prints occurrences grep-shaped
  like `search` (path:line: text, hitless = exit 1), scoped by the same cwd
  chain. `ledge today` is ⌘J from the shell — the daily_note handler
  create-or-opens today's note (the `daily.workspace` setting honored, cwd
  deixis the fallback; the target workspace's own `template: daily` note
  seeds it when one exists — never another workspace's), prints its path (`$EDITOR $(ledge today)` just works), and
  lands the app on it via the open-request file.
  `ledge new --template <note> <title...>` instantiates a template note as
  the body (the create_note handler's template mode; piping a second body
  alongside it is refused). The name may be ANY note's title — the
  `template: true` frontmatter marker is discovery (it fills the app's ⌥⌘N
  picker and flags rows in `ledge ls`/list_notes), not permission.
- **Semantics come from the MCP tool handlers, never beside them.** A verb
  that reads or writes notes dispatches through `bun/mcpTools.ts`, so title
  resolution, workspace deixis, naming, and the divergence guard cannot
  drift from what agents (and the app) get. Error guidance is the handlers'
  text with tool names translated to CLI verbs (`humanize` in cli.ts).
- **"Here" is the cwd.** A cwd inside a registered root scopes `ls`/`search`
  (`--all` widens), anchors `new`, and tie-breaks title resolution — folded
  into the same `$LEDGE_WORKSPACE` chain a note terminal's shells already
  ride, not a parallel rule. `$LEDGE_NOTE` works too: `ledge append -m …`
  in a note's terminal targets that note.
- **stdout is for results, stderr for talk.** Raw markdown from `cat`, rows
  from lists, the created path from `new`, handler JSON under `--json`;
  confirmations, errors, and truncation notes go to stderr. Exit codes:
  0 ok, 1 failure (including a hitless `search`, grep's contract), 2 usage.
- **Install Shell Command (ledge)** is the palette entry that writes the
  shim (bun/cliShim.ts); its outcome always surfaces — success in the
  browser's notice strip, failure in the error strip (§4's surface, neutral
  tone). `ledge install [dir]` is the same act from a terminal.
