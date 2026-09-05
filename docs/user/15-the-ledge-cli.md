# The ledge CLI

The `ledge` command lists, reads, searches, creates, and appends to notes from any terminal. The running app follows along live, because a CLI write is an ordinary file change.

## Install

Run "Install Shell Command (ledge)" from the command palette, or `ledge install` if you already have the binary somewhere.

It writes a small shim onto your PATH (Homebrew's bin, `/usr/local/bin`, or `~/.local/bin`, whichever works) pointing at this copy of Ledge. If you move the app, run it again.

The palette offers this only while your notes are on this Mac. `ledge` ships with the app and a server carries no copy of it, so the command is absent whenever Ledge is pointed at a remote server ([[Keep Notes on a Remote Server]]).

## The verbs

`ledge help` prints the full usage.

| Verb | What it does |
| --- | --- |
| `ledge ls` | Lists notes. |
| `ledge search <query>` | Prints `path:line: match` rows like grep, and exits nonzero on no hits. |
| `ledge cat <title>` | Prints a note's Markdown. |
| `ledge tags` | Lists the workspace's tags with counts. `ledge tags <name>` lists the notes bearing one. |
| `ledge workspaces` | Lists the workspace roots. |
| `ledge new <title>` | Creates a note, with the body piped on stdin or stamped from `--template`, in the folder you are standing in or the one `-f` names. |
| `ledge append <title>` | Appends to a note, or to one heading's section with `--heading`. |
| `ledge today` | Opens today's daily note in the app. |
| `ledge <title>` | Opens the app at that note. `ledge` alone just opens the app. |

In a terminal, once the shim is on your PATH:

```sh norun
ledge ls
ledge search "spawn params"
ledge cat "Shipping Notes"
```

Notes are addressed by title. An argument ending in `.md` is treated as a path instead.

```
ledge new "Standup" --template "Meeting"
git log --oneline -5 | ledge append "Release Notes" --heading "Shipped"
```

`--template` stamps the usual `{{tokens}}` (see [[Daily Notes and Templates]]). Titles never clobber: a duplicate gets a numbered file, the same as in the app.

## Scope: workspace, folder, and note

Run `ledge` from inside a workspace folder and it scopes itself there. `ls` and `search` cover that workspace, and `new` creates in it.

Stand in a folder inside the workspace and it narrows one more step, the way any other shell command works on the directory you are in:

```sh norun
cd ~/Notes/projects
ledge ls                     # only the notes in projects, and below it
ledge search "rate limit"    # only that folder
ledge new "API Rollout"      # creates ~/Notes/projects/api-rollout.md
```

`-f <folder>` says it outright, from anywhere. `ledge ls -f admin` lists that folder, and `ledge new "Expenses" -f admin/2026` creates the folder if it is new. See [[Notes and Workspaces]] for folders in the app.

`-f` is also how you say which of two notes sharing a title you mean: `ledge cat "Plan" -f projects`. The folder you are standing in never does that, only `-f`, so a title always reaches the whole workspace no matter where you run it from.

`ledge today` is the one exception. It takes `-f`, but it ignores the folder you are standing in, because today's note is found by its date and where it lives should not depend on where you happened to be when you first ran it.

Inside a note's terminal drawer it also knows the note, so a bare `ledge append -m "TODO: check the logs"` appends to the note the terminal belongs to.

Three flags override the scope: `-w <workspace>` targets a specific workspace, `-f <folder>` targets a folder, and `--all` widens `ls` and `search` to every workspace.

## Piping and JSON output

Results go to stdout and everything conversational to stderr, so pipes stay clean. `--json` switches any verb to machine-readable output.

The CLI dispatches through the same handlers as the MCP tools ([[Agents and Ledge]]), so it follows the same rules: titles resolve the same way, locked notes refuse their bodies, and there is no delete verb.

That makes it an agent surface in its own right. An agent that can run shell commands can work your notes with `ledge` alone, with no MCP setup.
