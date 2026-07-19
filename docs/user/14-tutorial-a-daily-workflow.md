# Tutorial: A Daily Workflow

This tutorial sets up a day-to-day rhythm on top of [[Daily Notes and Templates]]: one keystroke opens today, today links to yesterday, and nothing you jot down goes missing.

## Shape your day once

Run "New Daily Template" from the command palette (or "Edit Daily Template" if you already have one). Give it the shape you want every morning to start with, for example:

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

That is the whole setup. From now on, ⌘J opens today's note, stamped from this template: the H1 becomes today's date, `{{yesterday}}` becomes a link to the day before, and the headings are waiting. The arrow link means you can walk backward through your days indefinitely, and the backlinks panel (⌥⌘L) on any day shows the day after, so the chain works in both directions.

## Through the day

⌘J is idempotent: press it any time, from any workspace, and you land in today. Jot into Log as things happen. When a thought belongs to a project rather than the day, give it a `#tag` or a `[[wikilink]]` on its line: the daily note stays a chronological stream, and the tags panel (⌥⌘T) or the linked note's backlinks reassemble the thread by topic later.

Two ways to capture without even switching to the app, both from [[The ledge CLI]]:

```
ledge append 2026-07-19 -m "- deploy went out at 14:10" --heading Log
```

works from any terminal (address today's note by its date title), and inside any note's terminal drawer a bare `ledge append -m "…"` appends to that note.

## Closing the loop

At the end of the day, move what mattered from Log to Done and carry the rest into tomorrow's Plan (which is one ⌘J away after midnight). If you want the machine to do the remembering, add a `prompt` fence to the template, so every fresh day starts with an agent's summary of the last one:

```
Read the note [[{{yesterday}}]] and reply with a three-bullet summary: what got done, what is still open, what looked risky.
```

Give that fence the `prompt` language in your template and each morning's briefing is one ⌘↩ away ([[Agents and Ledge]]).

And when you need to find something weeks later, the date titles carry the when, full-text search (⌥⌘P) carries the what, and the yesterday-links carry the story between.
