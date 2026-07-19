# The ledge CLI

Your notes are reachable from any terminal. The `ledge` command lists, reads, searches, creates, and appends to notes from a shell prompt, and the running app follows along live, since a CLI write is just an ordinary file change to it.

## Install

Run "Install Shell Command (ledge)" from the command palette, or `ledge install` if you already have it somewhere. It writes a small shim onto your PATH (Homebrew's bin, `/usr/local/bin`, or `~/.local/bin`, whichever works), pointing at this copy of Ledge. If you move the app, run it again.

## The verbs

`ledge help` prints the full usage. The daily drivers:

```sh
ledge ls
ledge search "spawn params"
ledge cat "Shipping Notes"
```

`ls` lists notes, `search` prints `path:line: match` rows like grep (and exits nonzero on no hits, so it scripts like grep too), `cat` prints a note's markdown. Notes are addressed by title; an argument ending in `.md` is taken as a path instead. `ledge tags` lists the workspace's tags with counts, `ledge tags <name>` the notes bearing one, and `ledge workspaces` the roots.

Writing:

```
ledge new "Standup" --template "Meeting"
git log --oneline -5 | ledge append "Release Notes" --heading "Shipped"
```

`new` creates a note (body piped on stdin, or stamped from a template with the usual `{{tokens}}`; see [[Daily Notes and Templates]]), and `append` adds to the end of a note, or to the end of one heading's section with `--heading`. Titles never clobber: a duplicate gets a numbered file, same as in the app.

And for jumping into the app: `ledge` alone opens Ledge, `ledge <title>` opens it at that note, and `ledge today` lands in today's daily note.

## The CLI knows where you are

Run `ledge` from inside a workspace folder and it scopes itself there: `ls` and `search` cover that workspace, `new` creates in it. Inside a note's terminal drawer it goes one step further and knows the note itself, so a bare `ledge append -m "TODO: check the logs"` appends to the note the terminal belongs to. An explicit `-w <workspace>` overrides all of that, and `--all` widens `ls` and `search` to every workspace.

## Made for pipes and agents

Results go to stdout, everything conversational to stderr, so pipes stay clean; `--json` switches any verb to machine-readable output. The CLI dispatches through exactly the same handlers as the MCP tools (see [[Agents and Ledge]]), so it obeys the same rules: titles resolve the same way, locked notes refuse their bodies, and there is no delete verb. Which also makes it a fine agent surface in its own right: an agent that can run shell commands can work your notes with `ledge` alone, no MCP setup required.
