# Running Code

Any fenced code block whose language is runnable gets a Run button, and the shell behind it belongs to the note it sits in. This page covers what runs where, and how to change both.

## Run a block inline or in the terminal

⌘↩ runs the block under the caret inline. Output streams into the lower half of the block's own card, below a divider, and stays until you dismiss it. Hovering a block shows Run and Copy, a running block's Run button becomes Stop, and the output half offers Copy Output and Dismiss.

⇧⌘↩ sends the block to the note's terminal drawer instead (⌃` toggles the drawer). There you can keep typing after the command finishes. An inline run ends when its command does.

A block offers to run only once its fence is closed. While the closing ``` is still missing there is no Run button, because what the block contains is not settled: the next closing fence you type anywhere below it becomes this block's end. The third backtick writes the closing line for you, so a block is closed before you have typed a word of it, and a block written above another one never swallows it. Pressing Enter at the end of a fence opener does the same for an opener that arrived some other way, such as a paste.

## Answer a prompt from a running block

An inline run can ask you things. When it prints its first output it takes the keyboard, so you answer a `sudo` password prompt or a `[y/N]` by typing. The panel header reads "typing here" while your keys go to the program, and focus returns to the note when the command finishes.

If you pressed ⌘↩ and carried on writing, the run does not take the keyboard. Your caret moved on, so your typing stays in the note.

To leave a running command, press Escape twice (the first Escape goes to the program, in case it wanted it) or ⌘Escape. While a full-screen program such as `vim` holds the panel, every Escape belongs to it, and ⌘Escape is the way out.

## Confirm before running

Add `confirm` after the language on the fence and Ledge asks before running the block:

````markdown
```sh confirm
rm -rf ./cache
```
````

Here is a live one, harmless. Press Run, or ⌘↩ with the caret inside it:

```sh confirm
echo "this one asked first"
```

The dialog shows the block's code, names where it is about to run, and opens with Cancel focused, so a stray Return does nothing. Nothing runs while the dialog is up. Cancelling remembers nothing, and the next ⌘↩ asks again. There is no "don't ask again".

Four ways to set it:

| Where | What it does |
| --- | --- |
| `confirm` on the fence | That block asks. |
| `confirm="Wipe the production cache?"` on the fence | That block asks, using your wording. |
| `confirm: true` in the note's frontmatter | Every runnable block in the note asks. |
| `confirm=no` on the fence | That block never asks, even under `confirm: true`. |

Use the custom message when the code alone does not say enough:

````markdown
```sh confirm="Wipe the production cache?"
redis-cli -n 0 flushdb
```
````

On a note that declares several machines ([[Remote Hosts]]) you pick the machine first, and the question names it. The last thing you read before running is which machine you are running on.

`confirm` lives in the fence's info string, which other Markdown renderers ignore. The block still highlights as `sh` on GitHub and in any editor, and the marker travels with the block when you copy it into another note.

This is a speedbump against muscle memory, not a lock. Anyone who can edit the note can delete the word.

## Shell blocks share one shell

Shell blocks (`sh`, `bash`, `zsh`) run in the note's persistent inline shell. There is one per note, so a `cd`, an exported variable, or an activated virtualenv carries into the next run.

```sh
count=$((${count:-0} + 1))
echo "run number $count"
```

Run that twice and the number climbs, because it is the same shell both times.

The terminal drawer is a separate shell from the inline one. Both belong to this note alone, and both start where the note's frontmatter points them (`cwd`, `env`, and the rest: see [[Frontmatter and Environments]]).

Frontmatter applies to newly spawned shells, so after editing it run "Restart Note Shell" from the palette. It kills the note's shells and lets them respawn. Use the same command when an experiment leaves a shell in a strange state.

## Change the shell

Ledge spawns `/bin/zsh -i` for every inline shell and every terminal drawer. Set `shell.path` and `shell.args` in Settings (⌘,) to use a different one:

```json
"shell": {
  "path": "/opt/homebrew/bin/fish",
  "args": ["-i"]
}
```

Relaunch to apply. Keep an interactive flag in `args`, usually `-i`, so your rc files run and blocks get the aliases and PATH you expect.

This setting is about shells on this Mac. A note with a `host:` line runs its blocks in the host's own shell instead ([[Remote Hosts]]).

## Interpreted languages

Languages with an interpreter mapping (`python`, `node`, `ruby`, `ts`, `php`, and others) run as a file handed to that interpreter, one fresh process per run. No state carries between runs.

```python
import platform
print(f"hello from Python {platform.python_version()}")
```

TypeScript uses the Bun runtime bundled with the app, so `ts` blocks run with nothing installed.

## Redis and Valkey

A `redis` block is a list of commands, fed to `redis-cli` one line at a time.

```redis
PING
INFO server
```

With nothing configured it talks to a server on this machine. Set `REDIS_URL` in the note's frontmatter `env`, or in a profile when the URL carries a password ([[Profiles and Secrets]]), and the same block points at staging instead. The target is a note-level fact, so two notes can hold the same commands aimed at different servers.

Valkey speaks the same protocol, so `redis-cli` drives a Valkey server too. If `valkey-cli` is the binary you have installed, name it in `blocks.interpreters` (below).

## Add a language

Settings (⌘,) holds both lists:

- `blocks.runnable` names the fence languages that get a Run button.
- `blocks.interpreters` maps a language to the command that runs it. Values may carry flags, such as `"python3 -u"`.
- `blocks.hostInterpreters` overrides interpreters per machine, for runs a note sends over ssh ([[Remote Hosts]]).

SQL is the common case. Add `"sql"` to `runnable` and this to `interpreters`:

```json
"sql": "psql \"$DATABASE_URL\" -f"
```

Relaunch, and `sql` fences run against whatever `DATABASE_URL` the note's frontmatter names, the same way `REDIS_URL` works above.

```sql
select count(*) from orders where created_at > now() - interval '1 day';
```

There is no default for `sql`, because the word does not say which engine you mean. Use `mysql`, `sqlite3 mydb.db <`, or `duckdb` to match yours.

Two things to expect from a database fence:

- Client tools page their output, so a wide result opens the pager inside the block and waits for you to quit it. You can type into a running block.
- A query with no `limit` prints every row it gets. Keep the limits you would keep in a terminal.

One more fence: a `prompt` block sends its text to an AI agent (Claude Code by default) with the note's context attached. See [[Agents and Ledge]].
