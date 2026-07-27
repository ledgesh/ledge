# Tutorial: A Daily Workflow

Set up a daily rhythm: one keystroke opens today, today links to yesterday, and nothing you jot down goes missing.

This builds on [[Daily Notes and Templates]].

## 1. Write a daily template

Run "New Daily Template" from the command palette, or "Edit Daily Template" if you already have one. Give it the shape you want every morning to start with:

````
---
template: daily
---
# Daily Template

← [[{{yesterday}}]]

## Plan

## Log

## Done
````

That is the whole setup. From now on ⌘J opens today's note, stamped from this template: the H1 becomes today's date, `{{yesterday}}` becomes a link to the day before, and the headings are ready.

The arrow link lets you walk backward through your days. The backlinks panel (⌥⌘L) on any day shows the day after, so the chain works in both directions.

## 2. Capture through the day

Press ⌘J any time, from any workspace, and you land in today. Jot into Log as things happen.

When a thought belongs to a project rather than the day, put a `#tag` or a `[[wikilink]]` on its line. The daily note stays a chronological stream, and the tags panel (⌥⌘T) or the linked note's backlinks reassemble the thread by topic later.

You can also capture without switching to the app, using [[The ledge CLI]]:

```
ledge append 2026-07-19 -m "- deploy went out at 14:10" --heading Log
```

That works from any terminal, addressing today's note by its date title. Inside any note's terminal drawer, a bare `ledge append -m "…"` appends to that note.

## 3. Close the day

At the end of the day, move what mattered from Log to Done and carry the rest into tomorrow's Plan, one ⌘J away after midnight.

To have an agent do the remembering, add a `prompt` fence to your template:

```
Read the note [[{{yesterday}}]] and reply with a three-bullet summary: what got done, what is still open, what looked risky.
```

Give that fence the `prompt` language and each morning's briefing is one ⌘↩ away ([[Agents and Ledge]]).

## Finding it again

Weeks later, the date titles carry the when, full-text search (⌥⌘P) carries the what, and the yesterday-links carry the story in between.
