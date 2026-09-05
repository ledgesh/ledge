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
| Editor-internal (find, run block, save)                         | ✓ CodeMirror keymap         | hover block buttons  | the note's own menu, §11 | ✓ (refocuses editor) | –       | –      |
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
- **R6a.** A right-click has a canonical home too, and for a long time the
  editor was the one object in the app without one: every row kind had a menu
  and the document you spend the day inside had nothing. The row menus carry a
  row's verbs, which is why they are per row kind; the editor's carries what
  the POINTER landed on, which is why it is decided per click rather than
  listed (§11).
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
| Hover-revealed button | the row's menu, per R2 — and the button is ABSENT, not transparent. Unless the verb has no equally direct path: then it is LIT and 44 points, which is the fence's ▶ |
| Right-click | a long press on the row |
| Double-click rename | the menu's Rename item, which R3 already calls the discoverable path |
| ↑/↓ roving focus (R5) | a tap; the tapped row is the focused row |
| Bare-key row verbs | the row's menu |
| ⌘P / ⇧⌘P / ⌥⌘P | the magnifier in the header, which opens the overlay |
| `>` / `#`, which cross between the overlay's three modes | the three mode chips under its field |
| ⌘B / ⌘I / ⌘K, Tab / ⇧Tab, `[[`, ``` | the keyboard accessory bar, on the clients that have one (ios.md §7) |
| ⌘V of a picture | Insert Image…, on the bar and in the palette: a phone has no ⌘V and nothing on its pasteboard got there by being copied |
| Ctrl-C, Ctrl-D, Escape, the arrows, at a running block | the same bar wearing its other face, which is a keyboard rather than a menu (§6a) |
| ⌘Escape / Escape Escape out of a running block | a Back to note button in the run's own header, and the last key on that face (§6a) |
| Nothing dismisses the keyboard | the bar's own last button, apart from the verbs, and on every face that is not a run's |
| A run taking the keyboard on its own | a tap on its panel, or on the Tap to type button in its header — raising a software keyboard should cost a deliberate touch (§6a) |

- **The long press is 500 ms, and belongs to touch and pen only**
  (`lib/useRowMenu.ts`). A mouse is excluded deliberately: it has the right
  button already, and a held left button is how the strips reorder (R4). The
  press cancels once the finger travels more than 10 px, because the gesture it
  loses to is the list's own scroll. It opens the same menu the right-click
  opens, at the same point, from the same callback — two inputs, one
  implementation, and no second place for a row kind's verbs to be forgotten.
- **The editor's own menu (§11) is the exception, and takes no long press.**
  Inside text, the gesture a finger would spend here is the one iOS spends on
  selecting, and the callout it raises already carries cut, copy, paste, and
  define — a press that opened ours instead would take the selection gesture
  away and hand back less. Nothing is stranded: the menu names no verb that is
  not also in the palette or on the accessory bar (§1a's table), which is
  exactly the test the row menus fail and why they get the press.
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
- **The other answer is LIT, and the verb picks between the two.** Absent works
  because the menu or the palette is just as direct. Where it is not, the
  control stays, is visible without being asked for, and is 44 points. A code
  block's ▶ is the case: `block.runInline` is in the palette, but it acts on the
  block the CARET is in, so the palette form of one tap is a tap in the block,
  a tap on the magnifier, a typed `>`, and a choice — and running a block is
  what a note is for. Same layer, opposite answer, one line apart: the
  frontmatter profile chip is `display: none` on touch, because `profile.open`
  (Edit Note Profile…) is note-scoped and its palette entry needs nothing
  pointed at first. Both of the chip's desktop paths — the chip and ⌘-clicking
  the name — are a pointer's, so nothing is left behind on a phone that was
  reachable before.
- **A card grows a lane for a control rather than the control growing over its
  contents.** The block chrome is 22 points taller on touch and would have
  covered the first line of the code it runs. So `.cm-line.ledge-code-top` gets
  22 more points of top padding and the group is lifted by the same 22
  (`index.css`), which puts it back where the small one ended: at the opening
  fence, clear of the code. `editor/blocks.ts` still anchors it to that fence's
  glyph and knows nothing about either number — the pair belongs next to each
  other in one file, not one of them in a measurement.
- **A control that stops floating over things stops needing the box that says
  so.** The same group draws a filled, bordered box around its buttons on a
  pointer client, where it is what holds two 22-point glyphs apart from the code
  underneath them. In a lane of its own it holds them apart from nothing, and
  the box is a 50-point empty panel with a speck in it — which is what a device
  showed. Transparent on touch rather than removed: the padding and border are
  load-bearing for where the glyph column lands, and only the paint was the
  problem.
- **A reserved width that can shrink is not reserved.** Chrome drawn in the
  body overlay (`editor/blocks.ts`) is invisible to the flexbox under it, so the
  layout holds space for it with an empty element. At 44 points that space is a
  third of the run panel's header, flex took it back, and the ✕ that interrupts
  a run landed on top of the button that gives the keyboard back. `flex: 0 0` on
  the reserved element, so it cannot; what gives instead is the spacer, which is
  what a spacer is for.
- **A read-only page is not a text field where the keyboard is on screen.** The
  documentation editor stays focusable on a Mac deliberately — find and ⌘C
  need it — and both are chords a phone does not have, while the focus itself
  costs half the page. So
  `softKeyboard` (`lib/shell.ts`) turns `EditorView.editable` off there and iOS
  selects and copies the text natively instead.
- **The overlay's control is chrome, not a menu item.** ⌘P, ⇧⌘P and ⌥⌘P are
  chords, and a client with no keyboard would otherwise have no way at all to
  the one surface that carries every command. One button for all three modes:
  it opens quick-open, and the chips below the field are how you get to the
  other two (§3).
- **A punctuation accelerator is a chord on a software keyboard, and needs the
  same treatment.** The button above reached the overlay and stopped there:
  crossing to commands or to full-text was typing `>` or `#`, and on the iPhone
  keyboard BOTH are on the third plane (`123`, then `#+=`) — two plane switches
  to reach one character, a third tap to get back to letters, for a grammar
  whose only teacher was a placeholder you erase by typing. So the three modes
  are three chips under the field (`commands/Overlay.tsx`), 44 points each,
  which is the discoverable path R1 asks for; the sigils and the chords stay
  exactly as they were, as the accelerator. Two things fell out that a Mac
  wanted too. The mode had been INVISIBLE STATE — derived from the query and
  shown nowhere — and a lit chip is the first thing on screen that says which
  of three lists you are looking at. And a crossing now CARRIES THE QUERY,
  because on a client where the keyboard is on screen retyping is the expensive
  act; the sigil is stripped on the way back to notes, where it would be read as
  a sigil again and bounce you straight out.
- **Where a mode runs out, offer the next one instead of reporting the
  emptiness.** A title search that matches nothing, with something typed to
  search for, ends in a row rather than in "No notes match": *Search “…” in note
  text*, which crosses on a tap or on Enter. It is the one path across that
  needs no prior knowledge of a chip, a sigil or a chord, and it appears at the
  moment the want does — in the list, where the answer was expected to be. The
  test is whether the empty state knows what you would do next; if it does, it
  should offer it rather than name what it did not find.
- **An accelerator the client cannot press is not printed.** The chips name
  their sigil on a pointer client and drop it where `softKeyboard()` is true
  (`lib/shell.ts`) — absent, not muted, which is the same rule as the
  hover-revealed control above. What is withheld is the ADVICE and never the
  verb: the chip beside it does what the character would have. Same reason the
  field stopped saying "(> commands · # in text)" and went back to saying what
  it is for.
- **The editor's chords go on the accessory bar, which is the keyboard's own
  chrome.** The palette can reach any of them, but a formatting verb used mid
  sentence should not cost a trip through a modal surface that covers the
  sentence. The bar names command ids and nothing else, so it is a sixth way in
  to the registry rather than a second implementation of anything (ios.md §7).
  Indent and outdent had to BECOME commands for this: they were keymap
  bindings, and the iPhone software keyboard has no Tab key, so they failed the
  rule below without anyone noticing — the registry test could not see them
  because they were never in the registry. Code Block is the fourth of the same
  kind and the one with the widest gap under it: ``` is three trips through the
  numeric page with a long press each, for the construct this app is FOR. It
  writes a language, because the ▶ comes from the info string and a bare fence
  is the one block a phone cannot then use (`editor/fences.ts`).
- **The bar appears over the editor and nowhere else.** It hangs off the web
  view's first responder, and one responder serves every text field in the page,
  so without a signal it decorates the search box and the passphrase prompt too
  — offering Bold, which would act on the note behind the overlay. The page
  tells the shell which it is (ios.md §7).
- **And a running block is a different keyboard, not more verbs.** The panel a
  run draws is a block widget INSIDE `.cm-content`, so the rule above reads it
  as the note and offered Bold to a program waiting for a password. It gets its
  own face instead: Ctrl-C, Ctrl-D, Escape and the four arrows, which are what a
  software keyboard has no key for at all (§6a). The two faces are named the
  same way and mean different things — a verb is a command id for the registry,
  a key is a name for the focused panel (`editor/inlineTerm.ts` RUN_KEYS) — and
  neither is a byte or a behavior on the native side. The palette is deliberately
  not the answer here: opening it takes the focus the key was meant for.
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
- **Nothing in a note may be wider than the note.** The editor scrolls
  sideways to whatever its widest thing is, and on a 390-point screen that
  scroll takes the chrome of every panel off the right edge with it. The one
  that did was the inline run's: an xterm opens at 80 columns, so it pushed the
  content out to 80 columns and the re-fit then measured the overflow it had
  caused and agreed with it — a stable wrong answer, harmless at 1005 points
  and the whole panel at 370. Anything with an intrinsic width inside the
  document has to start smaller than the space it will be given and grow into
  it (`editor/inlineTerm.ts` opens at 2 columns and 1 row for exactly this).
- **A control a finger chooses BETWEEN is at least 44 points tall.** Not every
  control: a lone button can be missed and pressed again, and the app is full of
  16-point glyphs that are fine because nothing sits against them. The rule is
  for adjacent alternatives, where the miss does not land on nothing — it lands
  on the neighbour and runs it. **Order the group by what a miss costs.** The ✕
  dismisses a RUNNING block by interrupting it, which is the most expensive miss
  in the app, so it is the far end of its row with Copy Output between it and
  the button next door. **Write it in pixels.** The document's root is `font:
  14px`, so every rem-based Tailwind size is 0.875 of its name and `min-h-11`
  silently means 38.5 — a touch target is a physical measurement and must not
  ride the app's typographic scale. `touch:` is `@media (hover: none)`, the
  complement of `hoverable:` above and the same media feature, so the two
  variants cannot come to disagree about one device.
- **Almost everything the chrome is made of qualifies, and the app shipped
  believing four things did.** The rule arrived with a named list — the host
  picker's rows, the run confirmation's Cancel/Run pair, the fence's ▶ beside
  its Copy, the run panel's Back to note — and every one of them was a control
  someone had just been looking at. Measuring instead turned up a 38-point
  header of seven 25-point buttons seven points apart, 26-point note rows and
  27-point tabs with no gap at all between them, a 21-point machine switcher, a
  13-point Trash disclosure, a 28-point icon grid three points apart, and a
  connection row whose third adjacent alternative deletes a server. The list was
  never the rule; it was the part of the rule someone had walked through.
- **So put the size on the control, not at the call site.** `MenuItem` and the
  shadcn `Button` variants (`sm`, `default`, `lg`, `icon`) carry `touch:` sizes
  themselves, which is what covers the dialog written next year: every dialog's
  action pair is `size="sm"`, and Cancel beside Save at 28 points is the same
  defect in six files. Where a control is one of a kind the size goes on it —
  `ROW_CLASS` for the note lists, the tab strip's own height, the connection
  row's Edit and Remove.
- **Height comes from the box the children stretch into, not the box you
  named.** The tab strip at `h-[44px]` with a `border-b` gives its tabs 43: the
  border is inside the border box and `items-stretch` fills the content box. It
  is 45. The run panel's header learned the same thing at 48 (§6a), and both
  numbers are a border's, not a margin of comfort.
- **The other answer stays available, and the two splits take it.** Split Right
  and Split Down sat with Close Pane in three 21-point buttons half a point
  apart, and growing them would have spent 132 of a phone's 390 points on an
  arrangement it cannot use — a split at this width is two 195-point editors.
  Both are pane-scoped verbs in the palette and in a tab's menu, acting with
  nothing to point at first, which is the test the frontmatter chip passed and
  the fence's ▶ failed. `touch:hidden`, and both surfaces keep them: a split
  someone asks for by name is still a split they get.
- **Absent applies to the way in, never to the way out.** Close Pane went with
  its two neighbours on the argument above, and that argument does not cover
  it: it is not the arrangement, it is the exit from one. Nothing withdrew the
  two ways IN — the palette and the tab menu both still split — so a phone could
  reach a two-pane layout it had no visible way to leave, and the only way out
  was knowing to type `>close pane` into an overlay meant for finding notes. The
  ✕ stays at 44 on touch. It costs nothing in the state a phone lives in,
  because `canClosePane` withholds it until a second pane exists, and Close Pane
  joins the two splits in the tab menu so the menu that makes the arrangement
  can also unmake it. Before hiding a control on touch, ask which of the two it
  is; if a state is reachable, leaving it must be reachable the same way.
- **A surface the utility layer does not reach gets none of this for free.** The
  find panel is built as DOM by hand (`editor/find.ts`) and sized by a JS style
  object handed to `EditorView.theme` (`editor/setup.ts`), so Tailwind has never
  seen it and no `touch:` rule has ever applied to it. It stayed a 26-point row
  at every width — 508 points of fixed widths in a 390-point viewport, with the
  × that closes it past the right edge of a container that does not scroll, and
  Escape, which this client cannot press, as the only other exit. Opened on a
  phone, it could not be closed. The theme carries its own `@media (hover: none)`
  and `@media (hover: hover)` blocks now, the same two media features the
  variants use, and it needed BOTH: the panel's `:hover` rules were ungated,
  which is the two-tap defect above and showed up as a chevron wearing its hover
  background with nothing hovering it. Anything styled outside the utility layer
  has to state its touch sizes and gate its hovers where it is styled, because
  nothing else states them for it. **And gating a hover is only half of it,
  where the hover was the affordance.** The chevron, the × and the three
  checkboxes had no border on purpose: a pointer finds the edges of a control by
  moving over it, so the box could wait until it was asked for. Gate that and
  nothing asks, and the row reads as three buttons with three specks floating
  beside them. They take the border at rest on touch. Before gating a hover, ask
  what it was doing: hiding a control, or drawing one.
- **Two rows stated beat two rows that happened.** The first version of that
  layout let flex wrap where the arithmetic fell, which was the intended two
  rows at 390 points and, at a 430-point phone, a × stranded mid-row between the
  field and the arrows with the checkboxes orphaned below. A wrap point is a sum
  of every fixed width in the row, so it moves when the screen moves and when
  anyone adds a button. The break is an element now — one box around the options
  at `flex-basis: 100%`, ordered after the × — so the arrangement is the same at
  320 points and at 1024, and the field takes whatever is left rather than
  whatever the buttons did not want. Where a layout must hold at more than one
  size, assert it at more than one size: `phone.spec.ts` runs the panel's specs
  at 390 and 430, and 390 alone could not see this.
- **The spec measures rather than remembers** (`phone.spec.ts`, "every target a
  finger chooses between"). It walks the states a phone can reach, asks the DOM
  for every interactive element in each, and fails on any under 44 in either
  direction. It names no control, which is the point — a list of remembered
  selectors is what produced the four-group list above. What it does not do is
  find the states: it measures the ones someone thought to open, and the find
  panel is one the registry could produce all along and no test had opened, which
  is how a 26-point row survived an audit that measured everything else. Two
  exemptions, both properties of the box rather than of the control: a zero-sized
  element is not a small target but no target, and a control its own `<label>`
  wraps is not a target either, because the tap lands on the label — the panel's
  checkboxes are 12 points inside a 44-point pill. The one control it would have
  caught unfairly is the inline rename field, which covers its whole row and has
  no neighbour to miss onto; it takes the 44 anyway rather than earn an
  exception, and its row grows to hold it.

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
- **New Window takes no chord**, because the N family is spent: ⌘N is New
  Note, ⇧⌘N New Workspace, ⌥⌘N New Note From Template. A window is a bigger
  scope than a workspace, so the shift rule would want ⇧⌘N, and it is taken by
  the scope below it. `window.new` is a menu item and a palette entry only,
  which R1 already satisfies, and it sits in File beside Switch Connection
  rather than with the other News: choosing a window is choosing a machine.
  A notebook spending N on notes rather than on windows is the allocation and
  not an oversight; `remote.md` §8a is what the verb does.
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
| New Note              | ⌘N (alias ⌘T)             | opens a seeded `# Untitled` tab with the caret ON the title, the placeholder word SELECTED (`workspace/reveal.ts` revealTitle), so the first keystroke names the note and the H1 rename does the rest. Every create-then-open verb below does the same, through `editorPool.requestTitleCaret` — queued before the open, because a note read back from disk has no text to place a caret in until the read lands. A title the app COMPUTED is the exception: ⌘J's date gets the caret unselected, since a stray keystroke must not rename the day. An open of a note that already exists moves nobody's caret |
| Open Today's Daily Note | ⌘J                      | create-or-open, idempotent: today's LOCAL YYYY-MM-DD note, resolved by title in the daily workspace (settings `daily.workspace`, else the selected one), created from that workspace's OWN note whose frontmatter says `template: daily` when one exists (`{{date}}`/`{{time}}`/`{{title}}`/`{{yesterday}}`/`{{tomorrow}}` substituted, prompt fences carried inert, marker stripped; several claimants resolve newest-first warned). Strictly per-workspace: another workspace's daily template is never borrowed — a daily note materializes unasked, so a template you cannot see from where you sit must not shape it; a workspace with no claimant gets the bare dated note. A corpus marker, not a setting — picked up live, no restart. Lands via the CLI-open path: workspace selected, tab focused; a note it CREATED opens with the caret in its title, nothing selected (New Note above) |
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
| Go to Note…           | ⌘P                        | the overlay's first mode, and the one every crossing is measured from. Three chips under the field switch between the three (Notes / Commands / Text): a chip carries the typed query across with it, strips the sigil on the way back to notes, and is lit for the mode showing — including the mode a SIGIL put you in, so the row doubles as the indicator the overlay never had. On a client with a software keyboard the chips are the only way across (§1a) and they stop printing the sigils they name |
| Command Palette…      | ⇧⌘P                       | also: the Commands chip, or type `>` as the first character in ⌘P. A filtered query ranks by match quality with chorded commands one notch up (CHORD_BOOST, notes/fuzzy.ts): the §2 policy allocates chords to the frequent acts, so the chord doubles as the ranking signal — "daily" surfaces ⌘J's Open Today's Daily Note above the unchorded template verbs whose titles merely match earlier. The boost decides between comparable matches only; it never beats a tighter match ("edit daily" still leads with Edit Daily Template). An empty query keeps the registry's semantic order |
| Search Notes…         | ⌥⌘P                       | full-text over note bodies (one case-insensitive substring — shared/search.ts owns the grammar); also: the Text chip, or type `#` as the first character in ⌘P. And from the other end: a ⌘P query that matches no TITLE offers *Search “…” in note text* as its only row, on a tap or on Enter, which is the crossing that needs no prior knowledge of any of the above. Enter opens the note with the matched line revealed and selected. A `#`-leading query additionally surfaces the workspace's matching tags as rows ABOVE the text hits (a #tag is text too, so its occurrences still list below); Enter on a tag row lands in the Tags panel drilled into it |
| Toggle Terminal       | ⌃`                        | from terminal focus it closes the drawer |
| Toggle Sidebar        | ⌥⌘B                       | |
| Toggle Backlinks      | ⌥⌘L                       | right-hand panel: the notes whose `[[wikilinks]]` point at the current note (the same scan agents get from the MCP `backlinks` tool). Rows are the standard keyboard list; Enter/click opens the linking note with the link's line revealed and selected, the search overlay's open-at-the-hit |
| Toggle Outline        | ⌥⌘O                       | the right panel's second face: the active note's headings, derived live from the editor doc (`headingsOf` — the fence-aware scan shared with the MCP appender and the heading reveal). The right-panel toggles are radio-with-off: opening one closes the others, since they share the one slot. Enter/click moves the caret to the heading in the note's own editor |
| Toggle Tags           | ⌥⌘T                       | the right panel's third face: the workspace's tag directory — every tag its notes carry (inline `#hashtags` and frontmatter `tags:` lines, shared/tags.ts owns the grammar; the same scan agents get from the MCP `tags` tool), alphabetical with per-NOTE counts. Enter/click on a tag drills into its occurrences; Enter/click on an occurrence opens the bearing note with the tag's line revealed (the backlink grammar). Clicking a rendered `#tag` in the editor, a `#`-query tag row in the overlay, or ⌘-clicking a frontmatter `tags:` token all land in the same drill-in. Rendered tags open on plain click (they are pills, not editable text — the checkbox reasoning); a tag under the caret is revealed text: plain click moves the caret, ⌘-click follows. Typing `#` plus a character in the editor pops the tag picker (the workspace's own tags; a bare `#` stays quiet — headings start that way) |
| Settings…             | ⌘,                        | opens settings.jsonc in Ledge's own editor dialog — raw JSONC, comments as the documentation, launch-time problems previewed live but never blocking Save (architecture.md §6: the file is the UI; edits apply at the next launch) |
| Documentation         | — (palette; the header's help button) | opens the built-in docs IN A WINDOW OF THEIR OWN (`remote.md` §8a): a window titled Documentation, on this Mac's own server whatever the window that asked was looking at, holding one read-only workspace and nothing else. One per app — asking again raises the window that is open rather than growing a second copy of the same fixed pages — and the workspace you were in is left exactly as it was, which is the whole point of the window. Pages are ordinary notes to every read surface (browser, ⌘P, ⌥⌘P, outline, wikilinks), and every fence in a runnable language is marked `norun` (§4e), so none of them runs; the welcome note a fresh start opens (`workspace/seeds.ts`) is where the same examples are live. Everything mutating is gated view-side (New Note hidden, Delete/lock absent from the row menu, the editor drops keystrokes) and refused Bun-side regardless (architecture.md §3b). IN THAT WINDOW the chrome that switches between workspaces or machines is gone — no strip (it would be an empty list: the docs workspace is never a row), no connection bar, no New Workspace / Attach Folder / Notes On… / ⌘J, and no help button, since the button that opens a window has nothing to say inside it. Third-Party Licenses stays, meaning "turn to that page". The way out is the window's own close button, and the way back to your notes is the window still sitting behind it; the manual's window saves no layout and is not reopened at the next launch. ON A CLIENT WITH ONE WINDOW AND NO WAY TO HAVE TWO (a phone, `ios.md` §4) it stays what it was: the docs open as a HIDDEN READ-ONLY workspace in that window — never a strip row, absent from ⌘1…9 — landing on Getting Started, and the header button is lit while it is selected and TOGGLES, selecting the workspace the manual was opened from and leaving its tabs where they were. Being no strip row is exactly what leaves the manual without a row to click away from, and there the strip is inside the drawer the manual covers, so the lit button is the only door. No chord either way: docs are a sometimes destination |
| Restart Note Shell    | — (palette)               | kills the current note's shells; its frontmatter params apply at respawn (architecture.md §6a) |
| Add / Edit Frontmatter | ⌥⌘,                      | one command with a live title (a keyed command cannot be a two-faces pair — the dispatcher ignores `when`): with no block it inserts empty fences at the top with the caret on the body line between (Add); with one it moves the caret into the block (Edit). The block is still hand-edited text — the command only spares the scroll-up-and-type-fences gesture. A line the parser REFUSES says so where it sits: the message drawn after the line's text, the line marked down its left edge (`editor/frontmatter.ts`, from `parseFrontmatter`'s own per-line problems, so what is reported and what is ignored cannot drift). The settings dialog's stance in the place frontmatter is actually edited (architecture.md §6): advisory only — nothing blocks a keystroke, gates the save, or refuses to spawn, and the message clears the moment the line parses. A widget rather than a hover tooltip, because this is news rather than a label on an affordance, and a touch client has no hover to spend. Inside the block, completion teaches the grammar (editor/frontmatterComplete.ts, part of the one appCompletion): the seven params keys with one-line hints at line start (accepting writes the colon too; keys already declared are not re-offered), `template:` values (true / daily / false, explained), `tags:` values (the workspace's tags, the `#` picker's vocabulary), `host:` offers the reserved "local" |
| Cut / Copy / Paste / Paste as Plain Text / Select All | ⌘X / ⌘C / ⌘V / ⇧⌘V / ⌘A | ⌘V pastes the pasteboard's text — translated to Markdown when the pasteboard ALSO carries formatted HTML that says more than its text flavor does (editor/htmlPaste.ts): headings, emphasis, links, lists and tasks, tables, quotes, code blocks with their language, and images whose URL a note can resolve. Formatting spelled as a style declaration counts too (`font-weight: 700` is how Google Docs and Apple Notes ship bold, with no `<b>` anywhere). ⇧⌘V is the same paste with the translation left out — macOS's own "Paste and Match Style" slot, and where every other Markdown editor puts it. THE PLAIN TEXT WINS BY DEFAULT: HTML holding no formatting element at all is span-and-div soup, which is what a copy out of a terminal, VS Code, or DevTools puts up beside its text — converting it would double-space a copied stack of lines and gain nothing, so `hasFormatting` declines, as does a conversion that comes out saying what the text already said. A paste into a fenced block, a code span, or the frontmatter is verbatim regardless: there the bytes are the point. Inside the app the question never arises — the copy path is pbcopy, which writes text alone. All five are registry commands with `domains: []` and `palette: false` — the chords stay bound at `Prec.highest` inside CodeMirror (⌘A is CodeMirror's own selectAll) because the views:// scheme is not a secure context and the clipboard has to go through Bun, so the window dispatcher fires none of them and §10 still lists them as inner-owned, keeping them off the menu BAR's key equivalents. They are commands so the editor's context menu can render them from the registry like every other menu item (§11); the bar keeps AppKit `role` items for the same five, because a role goes through the responder chain and therefore means the TERMINAL's clipboard while the terminal has focus, which a bar installed from Bun cannot know. Same verb, two mechanisms, two scopes: the role means "whatever has focus", the command means "the focused note's editor", and a menu opened by right-clicking that editor wants the second |
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
- **It also says who else is on that machine, and only when somebody is.** One
  other device is named; past that it counts, with the names in the hover
  (remote.md §7). Nothing at all is drawn while you are alone, which is nearly
  always — a strip that said "1 device" every time you opened the app would be
  noise in the one place that has to stay readable at a glance. The device named
  here is the one §4-2's rules are about.
- **No chord.** Switching is a rare, deliberate act that closes every tab, so
  it earns no key: the bar is the everyday surface, and the palette and the
  File menu carry it. This is §2's "a chord is for what you do many times a
  day" applied to the least frequent verb there is.
- **The chooser opens on the connection in use**, like the host picker: Enter
  means stay, and moving somewhere else costs a deliberate arrow. `⌫` on a row
  removes that connection, the same row verb the workspace strip uses.
- **Edit and Remove are controls on the row, present at rest.** §1a says a
  hover-revealed control is a control a touch client does not have and a bare
  row verb has no touch form, and this dialog is the only surface either verb
  appears on — there is no palette entry for "rename the VPS". So the two
  controls sit at the end of every row that is a record, in the tab order beside
  it, and the local server's row has neither because there is nothing about the
  server in this process to change.
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
- **Editing is the same form, and the same second step when it is earned.** A
  pin belongs to one host, so moving an address onto another one asks the
  fingerprint question again and the primary button says "Continue" rather than
  "Save" before it is pressed. A rename, or a change of account on the same
  host, saves in one step. A server that rotated its key legitimately would
  otherwise cost a delete and a re-add, so the form carries "Check Key Again"
  for exactly that.
- **Three refusals keep the app somewhere it can work from**: the local server
  cannot be removed, and neither can the connection currently being served. A
  phone has no local server to fall back to, so there the second refusal holds
  only while another server exists — removing the last one returns it to the
  pairing screen, which is the only way a phone can forget an address it typed
  wrong (ios.md §4).
- **A switch will not run over unsaved writing.** The switch reloads the page,
  so text that never reached the server it belongs to is gone afterwards and is
  in no trash anyone could be sent to (remote.md §7). Every dirty note is
  flushed before anything is torn down, and if any of them are still unsaved
  when that settles, the switch is refused with the count and the machine
  named. §4 calls that class irreversible destruction, and this is the third of
  the refusals above rather than a confirmation: there is nothing about the
  switch worth deciding, and everything about the unsaved text worth handling
  first, so a prompt here would only teach the click-through §4 warns about.
- **The indicator's click has a second verb, for when the link is down.**
  `connection.reconnect`, titled "Reconnect", tells this client's wire to dial
  now instead of waiting for its next beat (remote.md §7). The bar means it
  whenever the link is not live and means the switcher otherwise, because the
  switcher is the wrong offer at exactly that moment: it reloads the page, so
  the refusal above can be the only thing it has to say, and a chooser that
  opens in order to say no would be the app's entire visible answer to being
  disconnected. It is offered nowhere while the link is fine, since a Reconnect
  that is present and inert on a working connection teaches nobody anything
  (§8). It takes no chord: the app is already dialling on its own, so this is
  impatience made pressable rather than a step anybody needs to know. Nothing is
  awaited — the dial's outcome arrives as a link state like any other — so the
  press answers for itself with a notice naming the machine, or it would read as
  a dead button every time the server was still unreachable.
- **A connection that will not open costs nothing.** The new server is reached
  *before* the old one is torn down, so a typo or a sleeping laptop leaves the
  session exactly where it was, with the reason in the dialog. At boot the
  same failure falls back to the local server and the indicator says
  "not reachable" rather than silently naming the wrong machine.
- **A boot that is waiting says what it is waiting for.** Both shells start on
  an empty `#root` and fill it once there is a server to render against, and
  over a network that gap is seconds: a phone dialling a machine that is not
  there waits out the whole dial timeout, fifteen of them. That was a black
  rectangle with nothing in it and nothing to press, and the refusal at the end
  of it was the first thing the app said — so a slow connection and a hung app
  looked identical for as long as it took. `mainview/lib/booting.ts` fills it:
  a spinner and "Connecting to `user@host`…", raised before the waits and
  removed by the first render. Three rules shape it.
  - **The reveals are delays, not timers**, the same idiom as the inline
    terminal's waiting line: the panel fades in at 600ms and a second line
    arrives at 4s, so a boot against a server in this process — every local
    launch — paints none of it and costs no flash. What is asserted in the
    suite is the delays, not a race against them (`e2e/booting.spec.ts`).
  - **A way out only where there is somewhere to go.** On a phone the button
    hands the window back to the shell's own server list, which is the screen a
    failed boot ends on anyway, and it says "Choose a Different Server" rather
    than "Cancel" or "Retry": a dial this slow is a machine that moved or went
    away, and dialling it again is the answer that has already been tried. On a
    Mac the wire is open before a view boots and the wait is the prefetch behind
    it, so there is nothing a button could stop and none is drawn. It is out of
    the tab order — `visibility: hidden`, not `opacity: 0` — until its delay is
    up, so a Tab cannot land on a control nobody can see.
  - **It is a button and not a command**, and so is outside §1 along with the
    refusal page's two (`mainview/ios.tsx`). §1's matrix is about the app's
    verbs; the registry that holds them is built by `CommandProvider`, which is
    downstream of everything this screen is waiting for. A verb that cannot
    exist yet cannot carry the only control on the screen.
- **A refusal and a rejection both end as a sentence.** Every action here sets
  a busy flag before it asks, and Bun can fail to answer as well as answer no:
  the view gives a request thirty seconds (`maxRequestTime`, `main.tsx`) and
  then rejects it. That flag gates every control in the dialog *and* the guard
  that drops repeat clicks, so a rejection that nothing catches is an app hung
  on this window with nothing on screen to explain it — which is what it did.
  Both paths clear the flag and write to the same line of red text. The one
  case that stays busy is a switch that SUCCEEDED, because the page is about to
  reload and the list must not become clickable in between.
- **No explanatory prose under the form's fields.** The labels carry what a
  destination and a port are, and what the far machine needs installed on it is
  reported by the connection that failed, in the words of the machine that
  refused it (remote.md §8). A paragraph under the fields is read by everyone
  every time to be useful to somebody once, and it crowds the fields it sits
  under. Where a password is kept is `docs/user/18`.

## 4-2. Two devices on one server

One server serves every client at once (remote.md §7), and almost nothing about
that needed a grammar: a note is a note whoever opened it, and both devices see
the same lists because the lists are the server's. **The terminal drawer is the
exception, because a shell has one keyboard and one screen size.** The rules
below are that exception; the one other thing two devices genuinely contend
for, a note both of them are editing, needs no exception but does need
reporting, and that is the last two bullets.

- **Attaching takes the drawer, and taking never asks.** Opening a note's
  terminal on the second device moves the shell there: its output, its
  keystrokes, its winsize. There is no confirmation, because the scrollback
  arrives with the attach — the device doing the taking has the whole session on
  screen the moment it opens — and because a prompt would be a dialog on the
  device nobody is holding.
- **The device it was taken from is told, in place of the shell.** A notice
  covers the terminal ("iPhone took this shell."), and what it covers stays
  readable underneath: the last thing that shell said here is still the useful
  thing on that screen. A terminal that simply stops mid-line, with no
  explanation, is indistinguishable from a hung app.
- **It is named, when the device gave a name.** Each device tells the server what
  it calls itself — a hostname on a Mac, a device name on a phone — and every
  other client is pushed that list (remote.md §7). Which machine has your shell
  is the first thing worth knowing about a shell that is somewhere else. The name
  is fixed at the moment it was taken rather than re-read afterwards: a notice
  that reworded itself because the other device has since disconnected would be
  describing the wrong moment. "Another device" is what is left for a client that
  gave no name.
- **Take This Shell is a button on that notice, not a command.** The verb exists
  only while the notice is on screen and only for the drawer it covers, which is
  the class §4-1's row controls and the locked placeholder's Unlock are already
  in: a palette entry gated on a condition that has already put a button in front
  of you adds nothing to reach for. §1a is satisfied by the button itself, which
  is lit and 44 points on touch. Pressing it attaches again, which is the same
  taking seen from the other side, scrollback included.
- **Typing stops before the notice explains anything.** The window keeps its
  focus when the shell moves, so the keystrokes have to stop at the drawer, and
  Bun refuses them as well (`ok: false`) because the client is the
  least-trusted end of this rule as it is of every other.
- **What is about the NOTE stays open to every device**: sending a block to the
  drawer, closing the tab, and Restart Note Shell. None of them is about whose
  screen the drawer is on, and refusing them would mean a phone could not close
  a note because a Mac was holding its terminal.
- **A note both devices are editing converges on its own, or is arbitrated and
  reported.** A note open but UNEDITED on the second device follows its file on
  the `notesChanged` push (rpc-schema), which is what makes reading here and
  writing there silent rather than contentious. Two DIRTY buffers cannot be
  converged, so the divergence guard decides it exactly as it decides an agent's
  write or a `git checkout`: the save that lands second keeps the live path and
  the version it displaced moves to that workspace's trash, whoever wrote it.
  Nothing is refused, nothing is lost, and there is nothing for the user to
  answer.
- **The displaced version is announced on the notice strip, not in the log.**
  The strip names the note and says the other version is in the Trash
  (`mainview/notes/store.ts`). It was a `console.warn` for as long as the other
  writer had to be a program on this machine, which is defensible for a `git
  checkout` once a month and wrong when the other writer is your own phone: a
  save that silently trashes half of what you wrote cannot be told apart from
  the app losing it. The notice expires like every other one, because the
  Trash section is the durable half and the strip is only the pointer to it.

A phone has no drawer yet (ios.md §8), so today the two devices in this section
are two desktops on one server. The rules are written for the client, not for
the platform, so lifting that cut adds nothing here. Two windows on one Mac are
a third way to reach the same arrangement, and the cheapest to sit in front of
(`remote.md` §8a).

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
- **On touch the preselection is marked, not merely focused.** A finger has no
  Enter to make repeating cheap and no arrow to make leaving deliberate: every
  row costs one tap, so the focus ring is carrying a fact — which machine ran
  last — that nothing else on screen says. The preferred row therefore shows a
  check, on every client, and §1a's 44 points are what keep two adjacent
  machine names apart once the keyboard's economy is gone. The dismissal that
  replaces Escape is the outside press the popover already had.
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
- **On touch, size carries what focus was carrying.** Focus lands on Cancel on
  every client, and on a phone that stops meaning anything: there is no Return
  for it to disarm. What is left is a destructive button beside a safe one, so
  both grow to §1a's 44 points and the gap between them doubles. Cancel is also
  the Escape a software keyboard does not have — the backdrop press is the
  other one, and it was there already.
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

## 4d. A run needs the machine it runs on

Once this client has given up on the notes machine (`lost`, `remote.md` §7),
the run pair on every card is grayed with the reason on it, and ⌘↩ / ⇧⌘↩
answer with the same sentence: `Not connected to <name>, so there is nowhere to
run this.`

- **It is a gate, and it is the only one.** Every other verb that needs the
  server is left alone and reports what came back — a rejected request has a
  message, and showing it is both honest and self-maintaining. A run has no
  reply to hold a panel open against: the view sends it with a `void` and then
  waits for output, so a run asked for at a machine that is not there rejects
  into nothing and leaves a panel reading "Running" that nothing will correct.
  Predicting the failure is the only way to tell the truth about this one.
- **`lost` and not `reconnecting`.** Mid-ladder a request is held and replayed,
  so a run asked for there really does start, seconds late; and if the ladder
  runs out instead, the `lost` that ends it marks that panel unknown on the way
  past. Both endings are already honest, so gating the ladder would refuse a
  run that was going to work — and would put this verb out of step with
  everything else the view does while reconnecting.
- **It names the machine.** The bar a foot away says the same name, and a
  tooltip that said "the server" would leave the reader to work out that the
  two are one fact. On a client with three servers, which one went is the
  useful half of the sentence.
- **Grayed, not absent** — §4c's exception does not extend here. An unclosed
  fence is a block being written and the controls arrive with it; an outage is
  a condition that ends, and a run pair that vanished and came back would read
  as the feature having broken. §8's rule is about what this client CANNOT do,
  which is permanent and is a different thing.
- **A run already going is not stopped, and not declared over.** It goes to
  `unknown` and the panel says "Disconnected" (`remote.md` §7). The block stays
  gated behind it, because the program may still be executing over there and a
  second run would make two.
- **Neither terminal is typed into while `lost`.** A panel on `unknown` and an
  open terminal drawer both stop sending keystrokes, and both say why: the
  panel's focus hint reads "not connected" in place of "typing here", and the
  drawer covers its terminal with a notice. `inlineInput` and `terminalInput`
  are `void` calls like the run, so a keystroke sent at a machine that is not
  there is dropped without a word — and a terminal that does not echo is what
  waiting on a slow shell looks like too. The case that earns the gate is the
  one a run asks for by name: a password, typed into a terminal that quietly
  discards it.
- **Refusing input is not freezing.** A frozen panel is finished output and
  will never take a key again; these take one the moment the wire returns.
  Nothing is torn down on the way out and focus is not moved, because the
  outage may be over in seconds and pulling the caret back into the prose
  mid-sentence would be worse than the wait.

## 4e. Marked fences do not run (`norun`)

A fence marked `norun` in its info string offers no way to run it: no run pair
on the card, no Run Block Inline in the context menu, and the chords and the
palette answer with a notice instead of executing (`editor/fenceInfo.ts`
`noRun`, `editor/blocks.ts`). Only the copy button remains.

````markdown
```sh norun
sudo systemctl enable --now ledge-backup.timer
```
````

- **The block is in the note to be read, not run from it.** A note is also a
  document, and half of what a document quotes is a command for some other
  machine or directory: an install step for a server, a line for a project's
  terminal. Without the mark, every such block is a live button whose target
  is wherever this note's shell happens to be. The manual is the first user:
  every runnable-language fence in `docs/user/` is marked (writing.md §10,
  enforced by `bun/docsContent.test.ts`), because a manual page's shell is
  `$HOME` on whichever machine shows it — this Mac, or a phone's server — and
  the reader cannot see which. `curl … | sudo bash` and `git add -A` in the
  wrong `$HOME` are the shapes it was built for.
- **The grammar is §4b's**, the same slot as `confirm` and read by the same
  parser: `norun` or an on-word marks the block, `norun=no` is the off switch,
  and any other value keeps the mark (a word that is there is a typo'd yes
  before it is a no). Per block only — a note none of whose blocks should run
  is a note without runnable languages, so there is no frontmatter form.
- **Absent, not disabled**, §4c's departure from §5's grey-button grammar,
  for a plainer reason than the unclosed case: the author said this block is
  not for running here, and a grey button offering to would contradict the
  note. The pair leaves the moment the word is typed and returns when it is
  deleted (the control signature carries the flag).
- **The chord still answers**, as in §4c: `This block is marked norun: it is
  here to read or copy, not to run from this note.` The sentence explains the
  mark rather than just naming it, because the person pressing ⌘↩ on a marked
  block is usually reading a note someone else wrote — the manual, say — and
  has never seen the word.
- **It is a speedbump, not a boundary**, exactly as `confirm` is: whoever can
  edit the note can delete the word, and Bun enforces nothing. (e2e/fences.spec.ts
  states the policy executably.)

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

**The stacking order says the same thing in pixels, and it is written in one
place.** Two of this app's layers are parented to `<body>` rather than to the
pane they cover — the block chrome and the link hotspots, both for the
WKWebView reason in `index.css` — so their z-index competes with the React
tree's at the root rather than with the note's. The whole ladder is therefore
declared together, above `.ledge-linklayer`:

| z | Layer |
| --- | --- |
| 10 | `.ledge-linklayer`: hotspots over rendered links and checkboxes |
| 20 | `.ledge-overlay`: a block's run / terminal / copy / dismiss controls |
| 30 | The drawer's scrim (`App.tsx`) |
| 40 | The drawer itself (`App.tsx`) |
| 50 | Every modal above: dialogs, menus, pickers, the palette (`z-50`) |

The two body-parented layers were 90 and 100, which put them above everything
the stack here can open. That is the failure mode of a ladder written in two
files: the logical stack said the dialog was on top and the pixels said the
block's ▶ was. On a pointer client it showed as a glyph painted over a dialog;
on a touch client those buttons are 44 points square and take pointer events
(§1a), so the tap aimed at the dialog ran the block behind it. Every modal
covers the viewport with its own backdrop, so ordering the ladder correctly is
the whole fix — nothing has to consult React state to know it is covered.

A menu is the exception, and deliberately: it has no backdrop, and it dismisses
on the press that lands outside it. Anything positioned added later belongs on
this ladder, named in that comment. `e2e/phone.spec.ts` proves it by asking
`elementFromPoint` what a tap would actually hit, not by reading the numbers
back.

**Being parented to `<body>` is also an obligation to leave.** Neither layer is
a child of the pane it covers, so neither goes away when its editor's host is
unparented — a background tab's editor is detached and kept alive
(`workspace/editorPool.ts`), and its layer stays in `<body>` holding the
rectangles it last measured, in viewport coordinates, over whatever editor came
to the front. The pool dispatches a bare effect on every attach and detach
(`pingOverlay`), and **both** plugins have to count a transaction carrying
effects as a reason to re-measure: that transaction changes no document, no
selection, no viewport and no geometry, so a plugin watching only those four
never hears it, and a detached view has none of them left to change on its own.
The block chrome had that clause and the hotspots did not, which left invisible
`pointer-events: auto` targets carrying another note's links parked over the
note in front — a click meant to place the caret opened somebody else's note.
Collapsing is not destroying: the same ping on re-attach is what brings the
layer back, so a fix that only removes is the same bug with the sign flipped,
and `e2e/wikilinks.spec.ts` asserts both directions.

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
- **There is no claim at all where the keyboard is on screen**
  (`softKeyboard()`), and the test above is why. It asks whether the EDITOR has
  focus, which on a Mac means "the user is typing here" and on a phone means
  almost nothing: the editor takes DOM focus when a pane opens and takes it
  back after every run ends, both with no keyboard up. So the claim was always
  true there, and honoring it focused a text field, which is how iOS is asked
  to RAISE the keyboard — over the output the finger had just asked to see,
  with the note's own way out (tapping the prose) behind it. A run on that
  client moves the keyboard neither in nor out; the panel takes it when it is
  tapped, and offers **Tap to type** while it is live and has not been.
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
- **On touch the exit is a control in the header, because neither key exists.**
  A phone has no ⌘, and its software keyboard has no Escape at all. That leaves
  the exit a Mac never has to think about — clicking the prose — and a
  full-screen program is precisely what takes that one away: pinned to 24 rows
  with the keyboard up, the panel can be everything on screen. So the header
  carries a **Back to note** button, on the same `:focus-within` gate as the
  hint. It stands in for ⌘Escape rather than for the double tap, a button being
  the one form no program can swallow, so it has no `pinned` case and one
  label. That label is not "Done": the run is not done, and the ✕ a little to
  its right is the control that interrupts one. It is 44 points (§1a), which is
  what the header grows to on touch.
- **The disclosure is the button on touch, and the sentence on a pointer
  client** — one or the other, never both. "typing here · esc esc to exit" and
  the button are picked between by `@media (hover: …)` in `index.css`, each
  query only adding, so no client can end up with both or with neither. The
  button says the same thing by existing: "Back to note" means nothing to
  someone who is already in the note. It is also all that fits. At 390 points
  the header holds the state, the exit, and the 44-point pair that copies and
  interrupts, and the sentence is what the width has to spend.

  The touch client has the *inverse* state to disclose as well, and it is the
  one the sentence's slot is free for: with no claim, a live run that has not
  been tapped is a program that may be waiting on an answer nothing announced.
  So **Tap to type** sits there until the panel has the keyboard (the exit
  replaces it) or the run ends (a frozen panel is output, and typing at it
  would be typing at nothing). Both are pure CSS off `:focus-within` and a
  `ledge-term-live` class, for the same reason the rest of this is: a header
  that tracked focus in JavaScript would eventually disagree with where focus
  actually went.

  **And that one is a button too, because an instruction beside a terminal gets
  aimed at.** It began as a line of text, and words telling a finger to tap
  read as a label ON something tappable: the eye finds the sentence, the thumb
  goes to the sentence, and nothing happens there. So the sentence is the
  target. Tapping the output is untouched and is still what most people do —
  this is the second way in, not the replacement — and the two share one path
  (`focusTerm`), which is also the honored claim's, so a phone cannot end up
  with a way in that scrolls the note differently from the other.
- **A focused run is the `terminal` domain**, not `editor`, though the panel
  lives inside `.cm-editor`: the shell owns Ctrl here as in the drawer
  (`domainOf` asks `.xterm` first).
- **On touch the keys the program wants come from the accessory bar's second
  face.** Answering a run by typing already worked — a password, a `[y/N]`, a
  pager's `q` — and everything a program asks for with a control key did not
  exist on the client at all: no Ctrl, no Escape, no arrows. So while a run
  holds the keyboard the bar carries `^C ^D esc ↑ ↓ ← →` and, in place of Hide
  Keyboard, **Back to note** — the same act as the header's button, on the bar
  because the header rides the note's scroller and a run pinned to 24 rows can
  put it off the top of the screen. Seven keys and no sticky Ctrl: an armed
  modifier is state the page holds and a native button has to draw, and the two
  would part company the first time a run ended while it was held. What is not
  on it (Tab, Ctrl-anything-else) stays unreachable on a phone, deliberately —
  §14's list is what a phone could not do at all, and the bar is that list.
- **An arrow is not one byte.** `ESC [ A` outside DECCKM and `ESC O A` inside
  it, which is the mode every full-screen program sets while it owns the screen
  — so the bytes are chosen against the live terminal's mode
  (`inlineTerm.runKeyBytes`, unit-tested both ways). Sending the wrong form is
  not a crash: it is an arrow that does nothing, in the one place arrows are the
  whole interface.

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
  failing.** This is about what is permanently true of a client, not about
  what is momentarily true of its connection: a dropped wire leaves every verb
  in place and lets it report (§4d), because a palette that shrinks for forty
  seconds and regrows is its own kind of untruth. `when` already hides what
  does not apply to the target;
  registry-wide facts do the same for what does not apply to the CLIENT
  (`mainview/lib/shell.ts`). Four of them, two the shell's own answers about
  itself and two the notes machine's:

  | Fact | Whose | Withholds |
  | ---- | ----- | --------- |
  | `runsBlocks` | shell | Run Block Inline and its chord, the ▶ on every runnable fence, the profile editor |
  | `hasTerminal` | shell | Toggle Terminal, Close Terminal, the chrome's button, Run Block in Terminal and its chord |
  | `canPickFolder` | server | Attach Folder as Workspace…, Move Workspace Folder… |
  | `canInstallCli` | server | Install Shell Command (ledge) |

  Running a block and having a drawer are separate surfaces, which is why they
  are separate facts: a phone runs blocks inline before it has a terminal
  (ios.md §14), and inline output is a panel under the fence where a drawer is
  a second arrangement and a keyboard grammar. Run Block in Terminal is the one
  verb that needs both answers, because it takes a block out of the note and
  puts it in the drawer. Restart Note Shell needs either, because both surfaces
  spawn the shells it kills. `canPickFolder` is false wherever nobody is sitting
  at the machine that holds the notes — a headless server, which a Mac can be
  connected to as easily as a phone.

  The server's two arrive together, on `workspaceList`'s first round trip, and
  they are two because a machine can have a person at it and still have nothing
  to install. `canInstallCli` is the notes machine's answer rather than the
  client's for the same reason `canPickFolder` is: the install writes a file
  over there, and the `ledge` it writes reads the notes over there. A compiled
  `ledge-server` has no CLI beside it to exec (`bun/cliShim.ts`), so the verb is
  absent on every connection to one.

  All four default to the desktop app's answer, so a shell that says nothing
  keeps every verb: the failure mode of a forgotten call is a phone with a
  terminal button, not a Mac without one. And the point is discoverability
  rather than enforcement — the server refuses these calls regardless
  (remote.md §10). A palette full of entries that answer with an error strip
  teaches the user that the palette lies, which costs more than the missing row
  does.

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
- **One bar, and the focused window fills it.** macOS gives an application a
  single menu bar, so with a second window open (`remote.md` §8a) two views
  push into one bar and the pushes have to be arbitrated rather than merged.
  Bun remembers every window's last push, applies only the focused window's,
  re-applies it when focus moves, and routes `menuCommand` back to the focused
  window alone. It is why New Window is more work than a second
  `BrowserWindow`: the bar is the one piece of the app no window owns.
- **Refused stays visible, paired hides.** A disabled command greys, because a
  bar that drops what it cannot do right now teaches nobody it exists. The
  exceptions are the two-faces pairs (Lock/Remove Lock, the template marker,
  the daily template) and the generated workspace slots, which set
  `hideWhenDisabled`: exactly one face is ever live, and a row of dimmed twins
  says less than one live item.
- Bun sets a **minimal fallback menu at boot** (Quit, the edit roles) so a
  view that fails to load still leaves a way out. The first push replaces it
  wholesale.

## 11. The note editor's context menu

Every object in Ledge has had a right-click menu except the one the user is
inside all day. A note row, a tab, a workspace, an outline heading, a backlink,
a tag: all of them answer the second button, and the document answered nothing
at all, because `App.tsx` suppresses the WebView's native menu app-wide (it
offers Reload and Inspect Element) and nothing replaced it. R2 and R6a say the
menu is a verb's canonical home; this is the surface that makes that true of
the editor's verbs too.

- **The menu is a function of the click, not a list.** A row menu carries its
  row kind's verbs and can be written as JSX with its conditionals inline. This
  one carries what the POINTER landed on — a link, a task, a runnable fence —
  so which verbs it holds is decided per click, and a decision belongs
  somewhere a unit test can call it: `commands/editorMenu.ts` is the spec and
  the builder, `commands/editorMenu.test.ts` is the proof, and
  `workspace/EditorMenu.tsx` renders whatever it is handed through the same
  `CommandMenuItem` every other menu uses. The component decides nothing. This
  is `menu.ts`'s move for the menu bar, with the difference that the bar is one
  fixed list (it has no pointer and nothing to point at) and this is one fixed
  list per click.
- **Three groups, in the order a pointer meets them.** What you clicked on
  (Open Link, Toggle Checkbox, the two run verbs), the clipboard (Cut, Copy,
  Paste, Paste as Plain Text, Select All), then the writing verbs (Bold,
  Italic, Insert Link, Link to Note, Code Block, Insert Image…). The first
  group is usually empty, so ordinary prose reads as a macOS text menu, and
  when it is not empty the item the click was about sits nearest the pointer.
  A group that comes back empty takes its separator with it — `buildMenu`'s
  rule, for `buildMenu`'s reason.
- **The contextual group is contextual, or it teaches that menus lie.**
  `link.open` and `task.toggle` are always visible in the palette and no-op off
  target, which is the right contract there: the palette cannot see the caret
  and a hidden entry would be a search that fails. A menu can see it — it was
  opened AT a point — so it withholds instead. The probe asks the same
  functions the verbs use (`followableAt`, `taskMarkerAt`, `runnableBlockAt`),
  never a copy of their logic, so a menu that offers a verb cannot then find
  nothing to do. An unterminated fence is offered no run, for §4c's reason.
- **The click places the caret first, unless it lands in the selection.** The
  platform's rule, and load-bearing rather than polite: Cut, Bold and Paste act
  on the selection, so a menu opened somewhere the caret is not would act
  somewhere the user is not looking. Both edges of a selection count as inside
  it, an empty selection is not a selection, and every range counts, not just
  the main one — Find's "All" selects a dozen and right-clicking one of them
  must not collapse the rest (`keepsSelection`, pure and tested).
- **The listener is on the window, and that is forced.** The hotspots that give
  rendered links and checkboxes their hand cursor are `pointer-events: auto`
  divs parented to the BODY (`livePreview.ts`, because the WKWebView will not
  honour `cursor` inside the editing context). So a right-click on a link, a
  wikilink, a tag or a checkbox has a target outside the editor's subtree
  entirely, and a React `onContextMenu` on the pane would never hear the four
  clicks the menu has the most to say about. Each pane hears every right-click
  and answers only the ones inside its own host, looking through the link layer
  with `elementsFromPoint` to find what the pointer is really over; the same
  handler focuses the pane, because that body-parented target means
  `LeafView`'s `onMouseDownCapture` did not fire either and the verbs act on
  the focused pane's note.
- **In the editor is not the same question as in the note.** A run's output
  panel is a block widget inside `.cm-content`, so it passes every "is this the
  editor" test and is not the document: a Copy there would copy the note's
  selection while the user was looking at a terminal. `barFaceOf`
  (`lib/nativeBridge.ts`) already draws exactly this line for the accessory bar
  and draws it here, which is one rule with two callers rather than two rules
  that agree today. A block's own run and copy buttons are aimed at
  deliberately and keep their own gesture; the link layer is the only thing
  looked through.
- **A read-only page loses the writing verbs rather than greying them.** In the
  built-in manual the menu is Copy and Select All, which is the note row menu's
  stance in the same workspace: a verb that can never apply to anything here is
  noise, not discoverability. The run verbs are absent too, because every one
  of the manual's blocks is marked `norun` (§4e).
- **No touch form** (§1a): a long press in text is the selection gesture, and
  every verb in this menu is in the palette or on the accessory bar already.
