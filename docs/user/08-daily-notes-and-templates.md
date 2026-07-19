# Daily Notes and Templates

A template is an ordinary note marked `template: true` in its frontmatter, ready to be stamped into new notes. Daily notes build on top: ⌘J opens today's note, creating it from your daily template if you have one.

## Making a template

Run "New Template" from the command palette (⇧⌘P) and you get a pre-marked note whose body is its own cheatsheet: the marker line, the tokens, what carries over. Or take any existing note and run "Make This Note a Template"; "Remove Template Marker" is the way back, and exactly one of the two shows for a given note.

The marker is one frontmatter line (see [[Frontmatter and Environments]]):

```
---
template: true
---
```

A template is still a normal note: it lives in your workspace, you edit it like anything else, and its own H1 is its name in the picker.

## Using one

⌥⌘N opens New Note from Template: the command palette pre-filtered to one entry per marked note, current workspace's templates first, other workspaces' labeled with their name. Pick one and a new note opens in the current workspace, built from the template.

Three things happen on the way in. The `template:` line is stripped, so instances are not templates themselves. The `{{tokens}}` are substituted. And the H1 is forced to the new note's title, so the instance never inherits the template's own name.

Everything else carries: frontmatter like `cwd` and `tags`, the body, code blocks, links. Substitution reaches inside fences too, so a `prompt` block saying `Summarize [[{{yesterday}}]]` becomes a real link when the note is stamped.

## The tokens

Five words, written as `{{date}}` style tokens anywhere in the template:

- `{{date}}` and `{{time}}`: the moment of creation, as local `YYYY-MM-DD` and `HH:MM`
- `{{title}}`: the new note's title
- `{{yesterday}}` and `{{tomorrow}}`: the adjacent calendar dates, handy as wikilinks in a daily template

Anything else in doubled braces is left exactly as written, so shell syntax and unrelated `{{placeholders}}` in code blocks survive untouched.

## Daily notes

⌘J opens today's note: a note titled with today's local date, like `2026-07-19`. If it exists it opens; if not it is created, so ⌘J is safe to lean on all day. The date is local wall-clock time on purpose: a note started at 11pm belongs to today, not tomorrow.

By default the daily note lives in the selected workspace. If your days should always land in one place, set `daily.workspace` in Settings (⌘,) and ⌘J goes there from anywhere.

To give your days a shape, mark one note in that workspace with `template: daily`. It claims the daily role: every fresh daily note is stamped from it, tokens and all. A template with `[[{{yesterday}}]]` near the top gives every morning a link to the day before. The role is strictly per-workspace, so a workspace without a claimant just gets a bare dated note, and the palette's "Edit Daily Template" (or "New Daily Template" if none exists yet) takes you to the right note.

In the sidebar, templates wear a layout glyph in place of the file icon, and the daily template a calendar, so the special roles are visible at a glance. And if you live in the terminal, `ledge today` lands in the same daily note; see [[The ledge CLI]].
