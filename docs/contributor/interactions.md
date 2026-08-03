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
blank is optional. A finger has four of these six columns unavailable to it;
§1a is where each one lands instead.

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

## 1a. Touch

**A touch client has no hotkey, no hover, no right-click and no double-click**
— four of §1's six columns, including the one every high-frequency action is
required to have. What survives is the palette and the context menu, and R1 and
R6 already require both to carry everything. So touch needs a way to *reach*
those two surfaces, not a grammar of its own, and that is the whole of this
section.

| Desktop affordance | Touch |
| ------------------ | ----- |
| Hotkey | the palette entry R1 already requires |
| Hover-revealed button | the row's menu, per R2 — and the button is ABSENT, not transparent |
| Right-click | a long press on the row |
| Double-click rename | the menu's Rename item, which R3 already calls the discoverable path |
| ↑/↓ roving focus (R5) | a tap; the tapped row is the focused row |
| Bare-key row verbs | the row's menu |
| ⌘P / ⇧⌘P / ⌥⌘P | the magnifier in the header, which opens the overlay |
| ⌘B / ⌘I / ⌘K, Tab / ⇧Tab, `[[` | the keyboard accessory bar, on the clients that have one (ios.md §7) |
| ⌘V of a picture | Insert Image…, on the bar and in the palette: a phone has no ⌘V and nothing on its pasteboard got there by being copied |
| Nothing dismisses the keyboard | the bar's own last button, apart from the verbs |

- **The long press is 500 ms, and belongs to touch and pen only**
  (`lib/useRowMenu.ts`). A mouse is excluded deliberately: it has the right
  button already, and a held left button is how the strips reorder (R4). The
  press cancels once the finger travels more than 10 px, because the gesture it
  loses to is the list's own scroll. It opens the same menu the right-click
  opens, at the same point, from the same callback — two inputs, one
  implementation, and no second place for a row kind's verbs to be forgotten.
- **The press focuses its row first.** Focus stops being invisible state when
  no hover ever hinted at it: the ring is the whole answer to "what is this menu
  about", and it is what R5's verbs address afterwards.
- **The click that follows a press is swallowed.** WebKit sends one after every
  touch, and a press that opened a menu must not also run the row's primary
  action — the row was the question, not the instruction.
- **No hover style may apply on a touch client, and this is a correctness rule
  rather than a cosmetic one.** iOS sends a synthetic mousemove ahead of the
  click of every tap, and WebKit's ContentChangeObserver WITHHOLDS that click
  when the mousemove changed the rendering: the tap is spent painting the hover,
  and it takes a second tap to act. Switching notes on a phone cost two taps for
  exactly this reason, the tab strip's close ✕ fading in on `group-hover`. Every
  `hover:` and `group-hover:` utility is therefore inside `@media (hover: hover)`
  (`tailwind.config.js`, `future.hoverOnlyWhenSupported`), which is a no-op on a
  Mac and the whole fix on a phone.
- **A control the hover REVEALED is absent on touch, not transparent.** Gating
  the variant stops the reveal but leaves a resting `opacity-0` button in the
  layout, still taking every tap that lands on it — an invisible 16-point close
  target at the end of every tab. `hidden hoverable:flex` removes it instead
  (`hoverable:` is `@media (hover: hover)`; the desktop reveal keeps its
  reserved space, so nothing reflows on hover). The verb is not lost: it is in
  the row's own menu, which is what the table above already says.
- **A read-only page is not a text field where the keyboard is on screen.** The
  documentation editor stays focusable on a Mac deliberately — find, ⌘C and ⌘↩
  on the manual's own runnable blocks all need it — and every one of those is a
  chord a phone does not have, while the focus itself costs half the page. So
  `softKeyboard` (`lib/shell.ts`) turns `EditorView.editable` off there and iOS
  selects and copies the text natively instead.
- **The overlay's control is chrome, not a menu item.** ⌘P, ⇧⌘P and ⌥⌘P are
  chords, and a client with no keyboard would otherwise have no way at all to
  the one surface that carries every command. One button for all three modes:
  it opens quick-open, whose own placeholder teaches the `>` and `#` that cross
  to the other two (§3).
- **The editor's chords go on the accessory bar, which is the keyboard's own
  chrome.** The palette can reach any of them, but a formatting verb used mid
  sentence should not cost a trip through a modal surface that covers the
  sentence. The bar names command ids and nothing else, so it is a sixth way in
  to the registry rather than a second implementation of anything (ios.md §7).
  Indent and outdent had to BECOME commands for this: they were keymap
  bindings, and the iPhone software keyboard has no Tab key, so they failed the
  rule below without anyone noticing — the registry test could not see them
  because they were never in the registry.
- **The bar appears over the editor and nowhere else.** It hangs off the web
  view's first responder, and one responder serves every text field in the page,
  so without a signal it decorates the search box and the passphrase prompt too
  — offering Bold, which would act on the note behind the overlay. The page
  tells the shell which it is (ios.md §7).
- **No verb behind a chord alone.** Every command is in the palette, or in a row
  menu, or has a control that runs it. `registry.test.ts` enforces that, and
  holds the exceptions as a named list rather than inferring them — a
  `palette: false` command with no menu item is exactly the bug it exists to
  catch.
- **Destructive verbs keep their confirmation and lose their accelerator**
  (§4). ⌫ on a focused row has no touch form and does not get one; the menu
  item in front of the existing confirm is the entire path.
- **A menu fits the screen it opens on** (`lib/menuPlacement.ts`): below the
  press where there is room, flipped above it where there is not, never past an
  edge. A menu item you cannot see is a verb the user does not have.

None of this is reachable in the shipping Mac app, where every pointer is a
mouse; it is the affordance layer the iOS client stands on (`ios.md` §6, §14
phase 2). It is exercised at 390x844 by `e2e/phone.spec.ts` in the `phone`
project (testing.md §5).

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
- **⌘L** — Lock Notes: relock the vault now, the walking-away gesture
  (`locking.md` §7 owns the full lock-command grammar — unlock is
  interposed, the per-note pair is palette-only two-faces). L is the lock
  mnemonic, and ⌥⌘L backlinks is unrelated.
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
| Documentation         | — (palette; the header's help button) | opens the built-in docs as a HIDDEN READ-ONLY workspace (architecture.md §3b): never a strip row, absent from ⌘1…9 (the numbers index what the strip shows — and stay the way back), landing on Getting Started. Pages are ordinary notes to every read surface — browser, ⌘P, ⌥⌘P, outline, wikilinks — and their fenced blocks still run (the docs' shell demos are live); everything mutating is gated view-side (New Note hidden, Delete/lock absent from the row menu, the editor drops keystrokes) and refused Bun-side regardless. The header button is lit while the docs workspace is selected, since no row can show that, and it TOGGLES: pressing it again selects the workspace the manual was opened from, leaving its tabs where they were. Being no strip row is exactly what leaves the manual without a row to click away from, and on a phone the strip is inside the drawer the manual covers, so the lit button is the only door. Closing the workspace (palette) is arrangement only; the button reopens it. No chord: docs are a sometimes destination |
| Restart Note Shell    | — (palette)               | kills the current note's shells; its frontmatter params apply at respawn (architecture.md §6a) |
| Add / Edit Frontmatter | ⌥⌘,                      | one command with a live title (a keyed command cannot be a two-faces pair — the dispatcher ignores `when`): with no block it inserts empty fences at the top with the caret on the body line between (Add); with one it moves the caret into the block (Edit). The block is still hand-edited text — the command only spares the scroll-up-and-type-fences gesture. A line the parser REFUSES says so where it sits: the message drawn after the line's text, the line marked down its left edge (`editor/frontmatter.ts`, from `parseFrontmatter`'s own per-line problems, so what is reported and what is ignored cannot drift). The settings dialog's stance in the place frontmatter is actually edited (architecture.md §6): advisory only — nothing blocks a keystroke, gates the save, or refuses to spawn, and the message clears the moment the line parses. A widget rather than a hover tooltip, because this is news rather than a label on an affordance, and a touch client has no hover to spend. Inside the block, completion teaches the grammar (editor/frontmatterComplete.ts, part of the one appCompletion): the seven params keys with one-line hints at line start (accepting writes the colon too; keys already declared are not re-offered), `template:` values (true / daily / false, explained), `tags:` values (the workspace's tags, the `#` picker's vocabulary), `host:` offers the reserved "local" |
| Paste / Paste as Plain Text | ⌘V / ⇧⌘V (editor-internal, not commands) | ⌘V pastes the pasteboard's text — translated to Markdown when the pasteboard ALSO carries formatted HTML that says more than its text flavor does (editor/htmlPaste.ts): headings, emphasis, links, lists and tasks, tables, quotes, code blocks with their language, and images whose URL a note can resolve. Formatting spelled as a style declaration counts too (`font-weight: 700` is how Google Docs and Apple Notes ship bold, with no `<b>` anywhere). ⇧⌘V is the same paste with the translation left out — macOS's own "Paste and Match Style" slot, and where every other Markdown editor puts it. THE PLAIN TEXT WINS BY DEFAULT: HTML holding no formatting element at all is span-and-div soup, which is what a copy out of a terminal, VS Code, or DevTools puts up beside its text — converting it would double-space a copied stack of lines and gain nothing, so `hasFormatting` declines, as does a conversion that comes out saying what the text already said. A paste into a fenced block, a code span, or the frontmatter is verbatim regardless: there the bytes are the point. Inside the app the question never arises — the copy path is pbcopy, which writes text alone. Not registry commands for the reason ⌘C/⌘X are not: the chords are bound at `Prec.highest` inside CodeMirror because the views:// scheme is not a secure context and the clipboard has to go through Bun (§10 lists both as inner-owned, so the menu bar cannot claim them) |
| Indent / Outdent      | ⇥ / ⇧⇥ (typed, not a command) | indents the caret's line, or every line the selection touches (setup.ts's `indentKeymap` over CodeMirror's `indentMore`/`indentLess`). On a list item the marker moves with the line, which is what nests it; in prose it is the ordinary indent. Bound because WKWebView's default for an unclaimed Tab is to move focus OUT of the editor — never what the key means in a document you type Markdown into. The tradeoff is the standard one (Tab no longer walks focus), affordable here because every destination in Ledge is a chord: ⌥⌘B, ⌃\`, ⌘1…9, ⌃Tab. While the `[[`/`#`/frontmatter picker is open, Tab takes its highlighted row first — `acceptCompletion` declines with no popup up, so indent is the fallthrough, not a special case |
| List continuation     | ⇧↩ (typed, not a command) | Shift+Enter inside a list item opens a line indented to the item's CONTENT column — past the bullet or number, but NOT past a `[ ]`: the checkbox is the item's content, not its marker, and the rendered box is pinned to the same 1ch advance as the `- ` it stands in for (index.css `.ledge-task`), so column 2 is where a bullet's text, a task's label, and both their continuations all line up (editor/lists.ts). CodeMirror's own soft newline reindents to the line's indentation, which for `- foo` is column 0: the new line falls outside the item, so the list stops continuing on the next Enter and an ordered item's continuation is deleted outright. Outside a list item, in a fenced block, and in a quote or table nested inside an item, ⇧↩ stays the ordinary soft newline. Enter is bound on the item's continuation lines only — its first line stays upstream's, since that Enter means "next item" and owes you the marker. On an indent-only line it clears the line and stays on it, the one-press exit editor/quotes.ts gives an empty `> ` line (upstream would push the whitespace below the caret instead); on a continuation line with text it adds another at the same indent, which upstream gets right for every item EXCEPT a task, where it measures emptiness from past the `[ ]` and so deletes the item's text |
| Tight lists           | ↩ (typed, not a command)  | Enter never inserts a blank line between items — `tightLists()` rebinds upstream's own Enter with both of its looseness rules off (editor/lists.ts). One is config (`nonTightLists: false`): Enter on an empty `- ` always LEAVES the list, where upstream instead pushes the marker down to make a two-item tight list loose — the shape the end of a note gives you, which is why that stray blank line appeared only there. The other has no config, so the command's own output is trimmed: given an already-loose list it prefixes each new item with a blank line, so one blank line (how you leave a list and start a new one) makes every list written under an earlier one double-spaced forever. The insertion is always `\n` + blank line + `\n` + marker, so keeping it from its LAST break drops the blank and leaves marker choice, nesting indent, and ordered renumbering upstream's. Costs nothing that renders: looseness is a property of the whole list, so the HTML is unchanged either way and live preview draws neither differently. Sits behind `fenceClose()` in the extension order and ahead of `markdown()`: a ``` opener inside a list item is the fence's Enter, and this command would otherwise answer it first |
| Pending Setext        | — (typed, not a command)  | A lone `-` under a paragraph is a real Setext underline, so CommonMark reads the pair as an H2 — and opening a bullet list under prose restyles that prose as a big bold heading until enough of the item is typed to stop looking like one. While the caret is ON that dash, the heading styling is withheld from both lines (editor/setext.ts): the document is untouched, nothing is hidden, and moving the caret off lets the heading draw, because at that point an H2 is what the file says (live preview's reveal-under-caret honesty). Narrow on purpose — `--`, `---`, and `=` are underlines nobody reaches by accident on the way to a list. Not gated by the livePreview setting: raw markdown styles its headings too and lurches identically. The cancelling CSS is why `tags.strong` is the one HighlightStyle entry carrying a fixed `class` (setup.ts): CodeMirror emits heading-and-strong as ONE flat span, so without a name to exempt, cancelling heading weight would take real bold with it |
| Fence auto-close      | — (typed, not a command)  | A fence closes itself as it is written (editor/fences.ts), in two halves. ON THE THIRD MARK: the backtick or tilde that completes a bare opener plants the matching closer on the next line and leaves the caret where it was, so the info string is still typed normally — bracket-autoclose semantics, and what makes the unterminated state unreachable by typing at all. A fourth or later mark grows the planted closer with it, since a closer shorter than its opener stops closing it. ON ENTER: the same insertion, caret on the empty line between, for the openers typing never sees — a paste, a note opened mid-block, a closer deleted — plus line 1's `---`, which typing must not answer (three dashes are a thematic break or a Setext rule everywhere else, so only the Enter that commits the line can read them as frontmatter). Whether a closer below already answers the opener is read from the FIRST fence-shaped line below, never from any closer anywhere in the note: a block further down owns a closer of its own, and pairing with that one is not "already closed", it is swallowing the block in between — which is exactly what a fence written ABOVE an existing block used to do, since that block's closer made the new opener look answered. A line that opens but cannot close (it carries an info string, or the other mark character) is another block beginning, so this fence still needs its own closer; a bare fence line is both shapes at once and is read as the closer, as CommonMark reads it too. Inside a still-open fence neither half fires: there the mark and the Enter belong to the block being closed. On the opener of an already-closed block, mid-line, or on a closing fence, Enter is an ordinary newline |
| Edit Note Profile…    | — (palette; edit button on the block, hover/caret-revealed like block controls; ⌘-click the name as accelerator) | opens the profile the note's frontmatter names in Ledge's key/value dialog (macOS binds no app to .env), created seeded if new; hidden when it names none. The button is primary — it lives in the overlay layer where the pointer cursor works; ⌘-click (not click: a plain click is a caret move on editable text) goes solid-underline while ⌘ is held |
| Lock Notes            | ⌘L (also a locked row's menu while the vault is unlocked) | relocks the vault now (locking.md §3: the view flushes dirty locked buffers first, then Bun drops the keys; open locked tabs swap to placeholder faces and every decrypted copy — text, undo history, image cache — is evicted). No-op while nothing is unlocked |
| Unlock Notes…         | — (palette; the locked placeholder's button; a locked row's menu while the vault is shut; interposed on opening a locked note) | the passphrase dialog (unlock face, or first-time setup with the no-recovery sentence when no vault exists). Wrong passphrase shakes and stays; the field clears either way |
| Lock This Note… / Remove Lock… | — (palette / note row menu) | two faces, exactly one visible per the note's live locked flag (the template-marker move). Target-scoped like Delete: the sidebar row's menu acts on the row's note, the palette on the focused tab. Lock sweeps the note's images (sealed in place; shared ones surfaced as a notice) and runs vault setup/unlock first when needed, completing the lock as the follow-up. Remove Lock sits behind one confirm — not §4-destructive (nothing is destroyed), but the consequence is silent exposure: sync and agent scans see the body again. Both live in locking.md §7 |
| Change Vault Passphrase… | — (palette, unlocked only) | rewraps every locked note's header and sealed image's key wrap under the new passphrase (bodies untouched); reports the count |
| Delete Note           | ⌘⌫                        | page focus only; in the editor CodeMirror's delete-to-line-start wins |
| Save                  | ⌘S                        | notes autosave; this skips the debounce |
| Find / Replace        | ⌘F / ⌥⌘F (fallback ⇧⌘F)   | editor only; ⌥⌘F may be swallowed by cmux |
| Find Next / Previous  | ⌘G / ⇧⌘G (also F3 / ⇧F3)  | editor only |
| Run Block Inline      | ⌘↩                        | cursor inside a runnable block whose fence is CLOSED (§4c: an unterminated one has no agreed body, draws no run pair, and answers the chord with a notice); the run takes the keyboard when it first prints, and gives it back when it ends (§6a) |
| Run Block in Terminal | ⇧⌘↩                       | |
| Bold / Italic         | ⌘B / ⌘I                   | editor only (editor/formatting.ts); toggles `**`/`*` around the selection or the word at the caret — a bare caret drops an empty marker pair to type into. Run-based so the chords compose: ⌘I on `**bold**` stacks to `***both***` and ⌘I again peels only its own star |
| Insert Link           | ⌘K                        | editor only; wraps the selection as `[text](url)` — a selected URL becomes the destination with the caret in the empty label, any other selection (or the word at the caret) becomes the label with the caret in the empty destination |
| Open Link             | — (palette; click the rendered link as accelerator) | follows the link under the caret (editor/livePreview.ts) — a URL leaves the app, a `[[wikilink]]` opens the note it names. A RENDERED link (syntax concealed, including inside a rendered table and bare URLs the caret is outside) opens on plain click — while concealed it is a widget, not editable text, same reasoning as the checkbox. A REVEALED link is raw text being edited: plain click is a caret move, ⌘-click opens (same grammar as the profile name above; the underline goes solid while ⌘ is held). Mouse-editing a rendered link: click adjacent text or arrow in, which reveals it. Schemes are allowlisted (shared/links.ts) and re-checked Bun-side |
| Indent / Outdent      | Tab / ⇧Tab (also palette; the accessory bar on a phone) | editor only; CodeMirror's own `indentMore`/`indentLess`. Commands as well as keys because the iPhone software keyboard has no Tab key at all, so on a touch client these were not awkward, they were unreachable (ios.md §7). The keys are unchanged and remain the accelerator |
| Link to Note (`[[`)   | typed, or the command (palette; the accessory bar on a phone) | `[[` in the editor pops the note-title picker (editor/wikilinks.ts; Enter accepts and closes the `]]`, Escape closes the popup only). `[[Title]]` resolves by title, case-insensitive exact, against the note's OWN workspace — resolved renders link-styled and opens on the Open Link grammar above; DANGLING renders muted with no hand cursor, and a plain click is the ordinary caret move that reveals it for fixing (a dead "open" affordance on a link that goes nowhere would be worse). `[[Title#Heading]]` opens with that ATX heading revealed, degrading to the top of the note when the heading is gone |
| Insert Image…         | — (palette; the accessory bar on a phone) | asks the DEVICE for a picture and embeds it: the file dialog on a Mac, the photo library on a phone (ios.md §11). No chord, because ⌘V is already the desktop's way in for the pasteboard and this is the other source — and on a phone, which has neither ⌘V nor anything on its pasteboard, it is the only way in. A cancelled picker inserts nothing and says nothing: cancelling is the common outcome, not a failure. The caret ends up below the image's line, so it renders straight away — the same insert ⌘V does |
| Toggle Checkbox       | — (palette; click the rendered box as accelerator) | toggles the `[ ]`/`[x]` on the caret's line (editor/livePreview.ts). The box is a widget, not editable text, so a plain click may act — the caret-move grammar protects text, and the box is not text |
| Rename Workspace…     | `r` (also menu / palette / double-click) | |
| Change Icon…          | `i` (also menu / palette) | opens the icon grid on the workspace's row |
| Move Workspace Folder… | — (palette; workspace row menu) | relocates the workspace's folder on disk: a destination parent is chosen, then Bun renames the folder into it — same volume only, everything inside travels (notes, `.ledge-trash`, `.ledge-assets`). How the destination is asked depends on where the folder is. Managed (under the hidden `~/.ledge`): straight to the native picker, Bun-side (the view names no path, attach's move) — the cloud-backup gesture, since a managed folder moved into iCloud Drive or Dropbox keeps every note and becomes an external workspace (its notes' shells now anchor there, architecture.md §6a). External: an in-app chooser first (`MoveWorkspaceDialog`) with two destinations — "Move to ~/.ledge" (the return trip, managed again, no picker: the native dialog cannot reasonably navigate into a hidden folder) or "Choose Another Location…" (that same native picker). Either way the workspace keeps its name, icon, and strip position; open tabs close — their paths named the old location — which is arrangement loss, not data loss (§4), so no confirm. Picking the folder's current parent is a no-op. No chord and no bare key: a rare, deliberate act |
| Close Workspace       | `⌫` (also menu / hover ✕) | detaches the folder from the registry; every note stays on disk, re-attachable |
| Copy Path             | `c` (also note context menu) | |
| Empty Trash…          | — (button / palette, confirmed) | |

Row verbs, by row kind. Each fires only while a row of that kind has focus
(§2), and each has a context-menu item carrying the same chip:

| Row       | Enter             | `d` / `⌫`                  | other |
| --------- | ----------------- | -------------------------- | ----- |
| Note      | Open              | Delete (to trash, undoable) | `c` Copy Path; menu: the lock faces + the state-matching vault verb (locking.md §7) |
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

## 4-1. Switching connections (which machine holds the notes)

A connection is the widest scope in the app: the workspace registry, the notes,
the trash, the tags, the shells and the vault all belong to one server
(remote.md §8), and there is exactly one at a time. The verb is
**`connection.switch`, titled "Notes On…"**, and its whole grammar follows from
the failure it prevents, which is running a command on the wrong box.

- **The indicator is persistent chrome, not a menu item.** `ConnectionBar`
  sits above the workspace strip — above what it scopes — and names the
  machine at all times. A fact you have to go looking for prevents nothing. It
  is deliberately distinct from the drawer's `host:` badge (§4a): that says
  where a *block* will run, this says where the *note lives*.
- **No chord.** Switching is a rare, deliberate act that closes every tab, so
  it earns no key: the bar is the everyday surface, and the palette and the
  File menu carry it. This is §2's "a chord is for what you do many times a
  day" applied to the least frequent verb there is.
- **The chooser opens on the connection in use**, like the host picker: Enter
  means stay, and moving somewhere else costs a deliberate arrow. `⌫` on a row
  removes that connection, the same row verb the workspace strip uses.
- **No confirmation, by §4's arrangement-loss rule.** Nothing is destroyed:
  the tabs are on the other machine and come back when you switch back. What
  the dialog does instead is *say so* before the click ("Switching closes every
  tab and reopens this machine's").
- **Adding a server is two steps, and the second one is not a confirmation.**
  Ledge fetches the host key, shows its fingerprint, and pins only after
  someone says it is the key they expected (remote.md §4). There is
  deliberately no "connect anyway": that button is the thing pinning exists to
  prevent, and an app that offers it has taught the click-through §4 warns
  about.
- **Two refusals keep the app somewhere it can work from**: the local server
  cannot be removed, and neither can the connection currently being served.
- **A connection that will not open costs nothing.** The new server is reached
  *before* the old one is torn down, so a typo or a sleeping laptop leaves the
  session exactly where it was, with the reason in the dialog. At boot the
  same failure falls back to the local server and the indicator says
  "not reachable" rather than silently naming the wrong machine.

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
  buttons' tooltips carry ": on <host>" so the target is visible before the
  click (joined with ", asks first" when §4b applies: where a run lands and
  whether it will stop to ask are the two things worth knowing *before* the
  click). Zero hosts is exactly the pre-host behavior.
- **The terminal drawer asks only at spawn.** The drawer is one shell with
  one host for its whole life, so opening it (or sending a block to it) on a
  multi-host note asks only when the shell is not already alive; afterward
  the header badge names the machine, loudly, for as long as the drawer is
  open. Moving it is Restart Note Shell, then reopen and pick again.
- The picker is the allowlist's UI, not its enforcement — Bun re-validates
  every requested host against the note's declared list
  (architecture.md §6a).

## 4b. The run confirmation (`confirm`)

§4 governs what the *app* destroys. A code block destroys whatever its author
wrote, which the app cannot classify — `rm -rf ./cache` and `ls` are the same
shape to us. So the judgement is the note author's, declared **on the fence**:

````markdown
```sh confirm
rm -rf ./cache
```

```sh confirm="Wipe the production cache?"
redis-cli -n 0 flushdb
```
````

- **The grammar is the fence's info string** (`editor/fenceInfo.ts`), because
  CommonMark leaves everything past the language word free and every other
  renderer keeps highlighting off that first word alone: a marked block is
  still a highlighted `sh` block on GitHub, and the marker travels with the
  block when it is copied. Attribute names we do not know are **ignored, never
  reported** — mdBook's `no_run`, Docusaurus's `title=`, and line-range
  `{1,3}` all live in this slot, and a note carried in from one of them must
  not stop running. `confirm=no` is the off switch; any other value is the
  question to ask.
- **A note-wide stance is frontmatter** (`confirm: true`), for a runbook whose
  blocks are all consequential; the per-block attribute wins in both
  directions, so one harmless block opts out with `confirm=no`.
- **The confirmation is the run's first step**, §4's rule: `runBlock` opens the
  dialog instead of executing, so the chord, the palette, and the run button
  cannot diverge into an unconfirmed path. Focus lands on Cancel.
- **After the host picker, never before.** On a multi-host note the frightening
  part of "run this" is *which machine*, so the question has to be able to name
  it. Past a live drawer shell the dialog claims no host at all — the badge is
  what says where that shell is.
- **Always-ask, no "don't ask again."** §4a's reasoning exactly: a remembered
  yes is the state the marker exists to prevent. Cancelling remembers nothing.
- **The dialog shows the block's code.** A custom `confirm="…"` is a headline,
  not a substitute for reading what runs.
- **It is a speedbump, not a boundary.** Whoever can edit the note can delete
  the word; nothing Bun-side enforces it. It guards against muscle memory,
  which is the failure it was built for. (e2e/run-confirm.spec.ts states the
  policy executably.)

## 4c. Unterminated fences do not run

A code block whose fence has no closing line offers no way to run it: no run
pair on the card, and the chords answer with a notice instead of executing
(`editor/blocks.ts`, `fenceClosed`). Only the copy button remains.

- **There is no body to run.** Lezer gives an unclosed block a `FencedCode`
  node like any other, ending on the last BODY line rather than on a closer,
  so the body read from it was one line short — and for a one-line block, that
  is the whole thing. What reached the shell was an empty temp file, which
  `source`d cleanly and reported a 724 ms exit 0 having run nothing at all.
  Silence and success are the two worst things a run can report together.
- **What the block contains is not yet decided.** The next closer typed
  anywhere below it will pair with this opener, and everything up to that line
  becomes its content. A run button on a block with no agreed end is offering
  to execute a guess.
- **Absent, not disabled** — the one case that departs from §5's grey-button
  grammar. A missing control is normally a mystery worth avoiding, but a block
  reaches this state only part-written, and a run pair blinking onto a fence
  line mid-keystroke is noise. It appears when the block does.
- **The chord still answers.** ⌘↩ and ⇧⌘↩ surface the reason rather than
  returning false: a key that does nothing reads as a broken key (the same
  move as the sealed prompt fence). Bun re-validates nothing here — this one
  is the view's, since only the view has the syntax tree.
- **Autoclose is the other half.** The mark that completes an opener plants its
  closer, and Enter does the same for an opener that arrived some other way, so
  writing a block never reaches this state (§3's Fence auto-close row). What is
  left for this section is what typing cannot catch: a paste, an agent's edit,
  a closer deleted. (e2e/fences.spec.ts states both halves executably.)

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
2. Dialogs: confirm, the profile editor, and the vault passphrase dialog
   (locking.md §7)
3. Palette / quick-open overlay
4. Editor find panel, and the `[[` completion popup (both CodeMirror-internal,
   editor focus only; the popup's Escape is consumed by its keymap before the
   window ever sees it, per the §7 consume rule)
5. Terminal drawer (terminal focus only — documented tradeoff: full-screen
   TUIs in the drawer can't receive a bare Escape)

While a layer of kind menu/dialog/overlay is open, the window keymap
dispatcher is fully suppressed. New modals must register with `pushLayer`
rather than adding their own capture-phase listeners.

**The inline terminal is not a layer** (`editor/inlineTerm.ts`): a focused live
run pushes nothing and suppresses nothing — it is a place focus can *be*, not
a surface over the app. Its Escape rule is local, sits below every layer here,
and lives in §6a.

## 6a. Who owns the keyboard while a block runs

An inline run is answerable: `sudo` asks for a password, an installer asks
`[y/N]`. Before this the answer went into the *note* — for a password, a
secret written to a synced file — because focus never moved.

- **A run claims the keyboard when it first prints**, not when it starts: the
  first byte is where the question appears (and an unrevealed panel cannot
  hold focus anyway).
- **The claim lapses if the user moved on** — honored only while that editor
  still has DOM focus *and* the caret has not moved since ⌘↩ (`blocks.ts`
  startInlineRun → `claimFocus`). ⌘↩ and carry on writing is an ordinary
  flow; a build that speaks a minute later must not swallow the sentence.
- **The panel says so while it holds focus**: lit border, header line naming
  the state and the way out, both `:focus-within` so they cannot drift from
  where focus is. Focusing never scrolls (`preventScroll`).
- **Focus returns by itself** when the run ends (a frozen panel is read-only)
  and when it is dismissed, and on demand (`escapeLeaves`, unit-tested):
  - **⌘Escape** always, the one form no program can claim.
  - **Escape twice** (within 600 ms), *except* while a full-screen program
    owns the panel (the alternate buffer, the same signal that pins the
    grid) — vim users double-tap Escape by reflex.
  - Neither is withheld from the program: the bare exit acts on the second
    tap, so the first has already gone through. The drawer (§6 layer 5) does
    take Escape from its shell; the inline panel is where full-screen
    programs actually get run, so it cannot afford that tradeoff.
- **A focused run is the `terminal` domain**, not `editor`, though the panel
  lives inside `.cm-editor`: the shell owns Ctrl here as in the drawer
  (`domainOf` asks `.xterm` first).

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
- The **menu bar** (§10) is the surface a first-time user scans before they
  know the palette exists. Its structure is a derived view of the registry,
  not a second list of features.
- **A verb that cannot work on this client is absent, not present and
  failing.** `when` already hides what does not apply to the target; two
  registry-wide facts do the same for what does not apply to the CLIENT
  (`mainview/lib/shell.ts`). `runsCommands` is the shell's own answer about
  itself and withholds the terminal, the two run verbs and the profile editor
  where they were cut (ios.md §8); `canPickFolder` is the SERVER's and
  withholds Attach Folder and Move Workspace Folder wherever nobody is sitting
  at the machine that holds the notes — a headless server, which a Mac can be
  connected to as easily as a phone.

  Both default to the desktop app's answer, so a shell that says nothing keeps
  every verb: the failure mode of a forgotten call is a phone with a terminal
  button, not a Mac without one. And the point is discoverability rather than
  enforcement — the server refuses these calls regardless (remote.md §10). A
  palette full of entries that answer with an error strip teaches the user that
  the palette lies, which costs more than the missing row does.

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

## 10. The menu bar

macOS gives every app a menu bar whether it fills one or not, and an app that
leaves it empty has no ⌘Q, no Services, and nothing for a first-time user to
read. Ledge fills it from the registry: `commands/menu.ts` holds the spec
(which command sits where), `buildMenu` turns it into the wire shape, and Bun
hands that to AppKit through `menuSet`. Bun never learns what a command id
means — a clicked item comes back as its `action` string and the view execs it
through the same dispatcher the palette uses.

- **Nothing appears in the bar that is not a command**, and nothing appears
  twice under two names. The one exception is `role` items: native AppKit
  selectors (undo, cut, quit, minimize) that the responder chain answers
  without the view ever seeing them. They are how a WKWebView gets real
  editing behavior, and they are the only items with a label the registry did
  not write.
- **Row verbs stay out.** The bar has no focused row to point at, so a verb
  whose `when` only passes with a target could appear only greyed. Its
  canonical home is the context menu (R2/R6). `menu.test.ts` enforces this by
  the flip: a command whose `when` turns true only when handed a target is
  refused.
- **An accelerator is a claim, not a label.** AppKit's key-equivalent pass
  runs *before* the key reaches the WebView, so declaring a chord here takes
  it from CodeMirror and xterm permanently. That is fine — often an
  improvement — where the registry's version of the command does the same
  thing to the focused editor as the editor's own binding would (⌘S, ⌘F,
  ⌘↩, ⌘B). It is a bug where an inner handler owns the chord for a
  *different* meaning:
  - ⌘⌫ is delete-to-line-start in the editor, which is the whole reason
    `note.deleteCurrent` is page-focus-only. The menu item carries no key.
  - ⌘A/⌘C/⌘X/⌘V belong to the editor and the terminal, which route the
    clipboard through the Bun process (the views:// scheme is not a secure
    context) and on ⌘V additionally translate formatted HTML to Markdown and
    embed a pasteboard image. The Edit menu shows Cut/Copy/Paste as roles so
    they are discoverable and clickable, and claims no key equivalents. ⇧⌘V
    (paste without the translation) is inner-owned for the same reason plus
    one more: AppKit binds no role to it, so an accelerator would have nothing
    to point at and would still fire in the terminal, where the shell owns the
    paste.
  - ⌃ chords belong to the shell (§2). A key equivalent fires regardless of
    focus, which is exactly the window-level Ctrl dispatch the policy forbids,
    so ⌃` is left to the editor keymap and the xterm handler that already
    route it.

  ⌘Z is the deliberate counter-example: WebKit turns the native undo selector
  into a `beforeinput` of type `historyUndo`, which `@codemirror/commands`
  maps onto its own history, so the menu and the editor mean the same thing by
  it. The hazard list lives in `menu.ts` as `INNER_OWNED_CHORDS`, and adding
  to it is how the next author records "something already owns this."
- **Enablement is a snapshot.** The bar is installed from Bun, so it cannot
  ask a `when` anything at the moment the user pulls it down; the view
  re-pushes whenever the document model, the selected workspace, or the vault
  moves. A `when` that reads the live note text (the template marker's two
  faces) therefore lags until autosave refreshes the note list — accepted, in
  exchange for not rebuilding the menu on every keystroke.
- **Refused stays visible, paired hides.** A disabled command greys, because a
  bar that drops what it cannot do right now teaches nobody it exists. The
  exceptions are the two-faces pairs (Lock/Remove Lock, the template marker,
  the daily template) and the generated workspace slots, which set
  `hideWhenDisabled`: exactly one face is ever live, and a row of dimmed twins
  says less than one live item.
- Bun sets a **minimal fallback menu at boot** (Quit, the edit roles) so a
  view that fails to load still leaves a way out. The first push replaces it
  wholesale.
