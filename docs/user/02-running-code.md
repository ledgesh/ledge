# Running Code

Any fenced code block whose language is runnable gets a Run button, and the shell behind it belongs to the note it sits in. This page covers what runs where, and how to change both.

## Run a block inline or in the terminal

⌘↩ runs the block under the caret inline. Output streams into the lower half of the block's own card, below a divider, and stays until you dismiss it. Hovering a block shows Run and Copy, and the output half offers Copy Output and Dismiss. A running block's Run button is gray until its run ends, since one block runs one thing at a time. Dismiss is also how you stop a run that is still going: the panel is the only thing that can show it or stop it, so putting the panel away ends the command behind it.

On a touch device the buttons do not wait to be hovered. Every block wears Run and Copy in its top right corner, sized for a finger, and one tap on Run starts it. The card leaves them a lane of their own, so they never sit over the code they run.

⇧⌘↩ sends the block to the note's terminal drawer instead (⌃` toggles the drawer). There you can keep typing after the command finishes. An inline run ends when its command does.

A block offers to run only once its fence is closed. While the closing ``` is still missing there is no Run button, because what the block contains is not settled: the next closing fence you type anywhere below it becomes this block's end. The third backtick writes the closing line for you, so a block is closed before you have typed a word of it, and a block written above another one never swallows it. Pressing Enter at the end of a fence opener does the same for an opener that arrived some other way, such as a paste.

A block on a note kept on another machine also needs that machine reachable. Once the connection bar reads "disconnected" the Run and terminal buttons are gray and say which machine cannot be reached, and a run that was already going says "Disconnected" until Ledge can ask about it again. A block run while the bar still reads "reconnecting…" goes as soon as the connection is back. See [[Notes on Another Machine]].

On a phone the backtick is not on the letter keyboard, so the block is a verb instead: the code button on the bar above the keyboard, or "Code Block" in the command palette. It writes both fences and the language `sh`, and leaves the caret in the body, so the next thing you type is the command. Type over the `sh` to run something else.

The same verb wraps a selection in a block, and selects the language for you, since the code is already written and `sh` is a guess about it.

## Answer a prompt from a running block

An inline run can ask you things. When it prints its first output it takes the keyboard, so you answer a `sudo` password prompt or a `[y/N]` by typing. The panel header reads "typing here" while your keys go to the program, and focus returns to the note when the command finishes.

If you pressed ⌘↩ and carried on writing, the run does not take the keyboard. Your caret moved on, so your typing stays in the note.

If the connection to that machine drops, the panel stops taking your typing and the line reads "not connected" instead. It takes typing again as soon as the connection is back ([[Notes on Another Machine]]).

To leave a running command, press Escape twice (the first Escape goes to the program, in case it wanted it) or ⌘Escape. While a full-screen program such as `vim` holds the panel, every Escape belongs to it, and ⌘Escape is the way out.

On a phone a run never takes the keyboard by itself, because taking it would raise one over half the screen you just asked to look at. While a run is going and your keys are still in the note, its header carries a Tap to type button, which is how you answer a password prompt or a `[y/N]` there. Tapping the output does the same thing.

On a touch device the header shows a Back to note button instead, for as long as the run holds the keyboard. Leaving does not stop the command: the run carries on, and tapping the output puts you back in it.

The bar above the keyboard changes while the run holds it. In place of the writing verbs it carries the keys a software keyboard has not got: `^C`, `^D`, Escape, and the four arrows. That is how you interrupt a command, end one that is reading input, quit a pager, or move around in `vim`, `less` or `htop` from a phone.

Back to note is the last button on that bar as well as in the panel's header, because a full screen program can push the header off the top of the screen.

Everywhere else that last button hides the keyboard, which on a phone is the only way to put one away: the note fills the screen, so there is no blank space to tap.

## Confirm before running

Add `confirm` after the language on the fence and Ledge asks before running the block:

````markdown
```sh confirm
rm -rf ./cache
```
````

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

## Keep a block from running

Add `norun` after the language and the block gets no Run button. ⌘↩ on it says so instead of running:

````markdown
```sh norun
sudo systemctl enable --now ledge-backup.timer
```
````

Use it for a command that belongs on some other machine, or in some other directory, than the note's shell: an install step for a server, a line for a project's terminal, a command you are quoting rather than keeping. The block still highlights as `sh`, and Copy still copies it.

`norun=no` turns it back off, the same way `confirm=no` does. Like `confirm`, the word lives in the fence's info string, so other renderers ignore it and it travels with the block.

The manual's own blocks are all marked this way, which is why none of them has a Run button.

## Shell blocks share one shell

Shell blocks (`sh`, `bash`, `zsh`) run in the note's persistent inline shell. There is one per note, so a `cd`, an exported variable, or an activated virtualenv carries into the next run.

```sh norun
count=$((${count:-0} + 1))
echo "run number $count"
```

The first run prints `run number 1` and the second `run number 2`, because both ran in the same shell.

The terminal drawer is a separate shell from the inline one. Both belong to this note alone, and both start where the note's frontmatter points them (`cwd`, `env`, and the rest: see [[Frontmatter and Environments]]).

Comments mean the same thing on both chords. A `#` line inside a shell block is a comment whether you run the block inline or send it to the drawer, so you can annotate a block without breaking it.

Frontmatter applies to newly spawned shells, so after editing it run "Restart Note Shell" from the palette. It kills the note's shells and lets them respawn. Use the same command when an experiment leaves a shell in a strange state.

## Change the shell

Ledge spawns your own login shell with `-i` for every inline shell and every terminal drawer, as long as that shell is zsh or bash. Set `shell.path` and `shell.args` in Settings (⌘,) to use a different one:

```json
"shell": {
  "path": "/opt/homebrew/bin/bash",
  "args": ["-i"]
}
```

Relaunch to apply. Keep an interactive flag in `args`, usually `-i`, so your rc files run and blocks get the aliases and PATH you expect.

zsh and bash are the two shells Ledge can read block output from. It marks where a block's output starts and stops with a hook that only those two provide. Any other shell runs the terminal drawer normally, and its inline runs show no output and no exit code. Ledge warns about that in the launch log rather than overriding what you set.

A shell that is not installed refuses the run and names the path it could not find. Nothing quietly falls back to a different shell, because a different shell is not the one you asked for.

When the shell is zsh, Ledge spawns it with `-o interactive_comments` on top of your `args`. That is what makes a `#` line a comment in the terminal drawer, where the block is typed into the shell rather than sourced from a file. zsh leaves the option off by default, so without it the drawer answers a comment line with `command not found: #`. Put `+o interactive_comments` in `args` to keep zsh's own behavior.

This setting is about shells on the machine holding the notes, so a remote workspace reads the copy on its own server. A note with a `host:` line runs its blocks in the host's own shell instead ([[Remote Hosts]]).

## Interpreted languages

Languages with an interpreter mapping (`python`, `node`, `ruby`, `ts`, `php`, and others) run as a file handed to that interpreter, one fresh process per run. No state carries between runs.

```python norun
import platform
print(f"hello from Python {platform.python_version()}")
```

TypeScript uses the Bun runtime bundled with the app, so `ts` blocks run with nothing installed.

That runtime is the app's, not a server's. A note kept on another machine runs its `ts` blocks on whatever `bun` that machine has, and says `command not found` when it has none ([[Notes on Another Machine]]).

## Redis and Valkey

A `redis` block is a list of commands, fed to `redis-cli` one line at a time.

```redis norun
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

```sql norun
select count(*) from orders where created_at > now() - interval '1 day';
```

There is no default for `sql`, because the word does not say which engine you mean. Use `mysql`, `sqlite3 mydb.db <`, or `duckdb` to match yours.

Two things to expect from a database fence:

- Client tools page their output, so a wide result opens the pager inside the block and waits for you to quit it. You can type into a running block.
- A query with no `limit` prints every row it gets. Keep the limits you would keep in a terminal.

One more fence: a `prompt` block sends its text to an AI agent (Claude Code by default) with the note's context attached. See [[Agents and Ledge]].
