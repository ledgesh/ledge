# Daily Notes and Templates

A template is an ordinary note marked `template: true` in its frontmatter, ready to be stamped into new notes. Daily notes build on that: ⌘J opens today's note, creating it from your daily template if you have one.

## Create a template

Run "New Template" from the command palette (⇧⌘P). You get a pre-marked note whose body is its own cheatsheet: the marker line, the tokens, and what carries over.

To convert a note you already have, run "Make This Note a Template". "Remove Template Marker" reverses it. Exactly one of the two shows for a given note.

The marker is one frontmatter line (see [[Frontmatter and Environments]]):

```
---
template: true
---
```

A template is still a normal note. It lives in your workspace, you edit it like anything else, and its H1 is its name in the picker.

## Create a note from a template

⌥⌘N opens New Note from Template: the command palette filtered to one entry per marked note, current workspace's templates first, other workspaces' labeled with their name. Pick one and a new note opens in the current workspace.

Three things change on the way in:

- The `template:` line is stripped, so the new note is not itself a template.
- The `{{tokens}}` are substituted.
- The H1 is set to the new note's title, so it does not inherit the template's name.

Everything else carries over: frontmatter such as `cwd` and `tags`, the body, code blocks, and links. Substitution reaches inside fences, so a `prompt` block reading `Summarize [[{{yesterday}}]]` becomes a real link when the note is stamped.

## The tokens

Write these anywhere in a template:

| Token | Becomes |
| --- | --- |
| `{{date}}` | The creation date, local `YYYY-MM-DD`. |
| `{{time}}` | The creation time, local `HH:MM`. |
| `{{title}}` | The new note's title. |
| `{{yesterday}}` | The previous calendar date. |
| `{{tomorrow}}` | The next calendar date. |

Anything else in doubled braces is left as written, so shell syntax and unrelated `{{placeholders}}` in code blocks survive untouched.

## Daily notes

⌘J opens today's note, titled with today's local date, such as `2026-07-19`. If it exists, it opens; if not, it is created. Press ⌘J as often as you like.

The date is local wall-clock time, so a note started at 11pm belongs to today, not tomorrow.

By default the daily note lives in the selected workspace. To send every day to one place, set `daily.workspace` in Settings (⌘,) and ⌘J goes there from anywhere.

## The daily template

Mark one note in the daily workspace with `template: daily` and every fresh daily note is stamped from it, tokens included. A template with `[[{{yesterday}}]]` near the top gives every morning a link to the day before.

The daily role is per-workspace. A workspace with no daily template gets a bare dated note. "Edit Daily Template" in the palette opens the right note, or "New Daily Template" if none exists yet.

In the sidebar, templates show a layout glyph in place of the file icon, and the daily template shows a calendar.

From a terminal, `ledge today` opens the same daily note. See [[The ledge CLI]].
