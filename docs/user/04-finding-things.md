# Finding Things

Four ways back to what you wrote: quick open, full-text search, links, and tags. All of them are scoped to the selected workspace.

## The overlay

⌘P opens a note by title, fuzzy matched. From there, the first character you type can switch modes: `#` turns it into full-text search, `>` into the command palette. The direct chords land in a mode straight away: ⌥⌘P is search, ⇧⌘P is commands.

A search hit opens the note with the matched line revealed and selected, so you land where the words are, not at the top of the file.

## Wikilinks

`[[Note Title]]` links to a note by its title, and `[[Note Title#Heading]]` targets a heading inside it. Typing `[[` pops a picker over the workspace's notes. Links address the title, never the filename, so the file renames that follow a retitle can never leave a stale path behind, and nothing ever rewrites your other notes to keep links working. A link whose title matches nothing is styled as dangling and edits like plain text.

Click a rendered link to follow it (when the caret is inside one and the raw text shows, ⌘-click). Try it: [[Running Code]].

## Backlinks and outline

⌥⌘L opens the Backlinks panel: every note that links to the current one, with Enter opening the linking note at its link line. ⌥⌘O is the Outline panel: the current note's headings, live as you type, where Enter jumps the caret to a heading and `c` copies that heading's wikilink, ready to paste into another note. The panels share the right-hand slot, so opening one closes another.

## Tags

Tag a note with inline `#hashtags` anywhere in the body, or with a frontmatter `tags:` line. ⌥⌘T opens the Tags panel: every tag in the workspace with its count, and Enter drills into the notes bearing one. Rendered tags in the editor are clickable, typing `#` in a note completes against the workspace's existing tags, and a `#`-leading query in the search overlay surfaces matching tags as rows too.

## Find in the note

⌘F finds within the current note, ⇧⌘F is find-and-replace, and ⌘G / ⇧⌘G step through the matches.
