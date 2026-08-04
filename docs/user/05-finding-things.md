# Finding Things

Four ways back to what you wrote: quick open, full-text search, links, and tags. All of them are scoped to the selected workspace.

## Quick open, search, and the command palette

⌘P opens a note by title, fuzzy matched. From there the first character you type switches modes: `#` for full-text search, `>` for the command palette. Two chords land in a mode directly: ⌥⌘P for search, ⇧⌘P for commands.

Three chips under the field do the same thing without the punctuation: Notes, Commands, Text. The one you are in is lit, and switching keeps what you have typed, so a title that turns up nothing becomes a text search in one tap.

The magnifier in the header opens the same thing, so all three modes are one click away when you would rather not reach for a chord.

When a title search matches nothing, the list offers to search the text of every note for the same words. Tap it, or press Enter.

A search hit opens the note with the matched line revealed and selected, so you land on the words rather than at the top of the file.

## Wikilinks

`[[Note Title]]` links to a note by its title, and `[[Note Title#Heading]]` targets a heading inside it. Typing `[[` opens a picker over the workspace's notes.

Links address the title, never the filename. A retitle renames the file without leaving a stale path behind, and nothing rewrites your other notes to keep links working. A link whose title matches nothing is styled as dangling and edits like plain text.

Click a rendered link to follow it. When the caret is inside a link and the raw text shows, ⌘-click instead. Try it: [[Running Code]].

## Backlinks and outline

⌥⌘L opens the Backlinks panel: every note that links to the current one. Enter opens the linking note at its link line.

⌥⌘O opens the Outline panel: the current note's headings, updated as you type. Enter jumps the caret to a heading, and `c` copies that heading's wikilink for pasting into another note.

The panels share the right-hand slot, so opening one closes the other.

## Tags

Tag a note with inline `#hashtags` anywhere in the body, or with a frontmatter `tags:` line.

The `tags:` line takes one list on one line, separated by commas or spaces, with or without square brackets. `tags: ops, runbook` and `tags: [ops, runbook]` declare the same two tags. A leading `#` on an entry is allowed and comes off, so you can spell tags the way the body does. The indented `- ops` form is not read, so keep the list on the `tags:` line.

A tag is letters, digits, `_`, `-` and `/`, and needs at least one letter or `_`. That is why `#2024` and `#123` stay plain text: a year and an issue number are not tags. An entry Ledge cannot read as a tag is named beside the line, and the entries beside it still count. See [[Frontmatter and Environments]] for the rest of the block.

⌥⌘T opens the Tags panel: every tag in the workspace with its count, where Enter drills into the notes bearing one. Rendered tags in the editor are clickable, typing `#` in a note completes against the workspace's existing tags, and a query starting with `#` in the search overlay lists matching tags as rows.

## Find and replace in a note

⌘F finds within the current note, ⇧⌘F finds and replaces, and ⌘G and ⇧⌘G step through the matches.

The panel opens above the note with its field focused. The arrows step through the matches, All selects all of them at once, and the three small toggles are match case, regular expression, and whole word. The chevron at the left end opens the replace row, where Replace rewrites the next match and Replace All rewrites every one.

Escape closes the panel, and so does the × at its top right.

On a phone the panel takes two rows: the field and the × on the first, the arrows and the toggles on the second. There is no Escape key to press there, so the × is the way out.
