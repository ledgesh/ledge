# Running Code

This is what Ledge is for. Any fenced code block whose language is runnable gets a Run button, and the shell behind it belongs to the note it sits in. This page covers what runs where, and how to bend both.

## Two ways to run

⌘↩ runs the block under the caret inline: output streams into a panel right beneath the block and stays until you dismiss it. Hovering a block shows the same Run button plus Copy, a running block's button turns into a stop, and the output panel offers Copy Output and Dismiss.

⇧⌘↩ sends the block to the note's terminal drawer instead (⌃` toggles the drawer). The block lands in a real terminal where you can keep typing after it has finished, which the inline panel does not offer: an inline run is over when the command is.

## Answering a run

An inline run can ask you things. When one prints its first output it takes the keyboard, so a `sudo` password prompt or a `[y/N]` is answered by just typing: the panel lights up and its header says "typing here" while your keys are going to the program, and focus returns to the note when the command finishes. If you pressed ⌘↩ and carried on writing, the run leaves you alone, however loud it gets: your caret moved on, so your typing stays in the note.

To step out of a running command yourself, press Escape twice (the first one goes to the program, in case it wanted it) or ⌘Escape. While a full-screen program like `vim` has the panel, every Escape belongs to it and ⌘Escape is the way out.

## Shell blocks share a shell

Shell blocks (`sh`, `bash`, `zsh`) are fed to the note's persistent inline shell: one shell per note, so a `cd`, an exported variable, or an activated virtualenv carries into the next run.

```sh
count=$((${count:-0} + 1))
echo "run number $count"
```

Run that twice and the number climbs, because it is the same shell both times.

The terminal drawer is a separate shell from the inline one, but both belong to this note alone, and both start where the note's frontmatter points them (`cwd`, `env` and friends: see [[Frontmatter and Environments]]). Frontmatter changes apply to freshly spawned shells, so after editing it, run "Restart Note Shell" from the palette: it kills the note's shells and lets them respawn clean. The same command is the escape hatch when an experiment leaves the environment weird.

## Interpreted languages

Languages with an interpreter mapping (`python`, `node`, `ruby`, `ts`, `php` and friends) run as a file handed to that interpreter, one fresh process per run, so no state carries between their runs.

```python
import platform
print(f"hello from Python {platform.python_version()}")
```

TypeScript is special-cased to the Bun runtime bundled with the app, so `ts` blocks run without anything installed.

## Redis and Valkey

A `redis` block is a list of commands, fed to `redis-cli` one line at a time.

```redis
PING
INFO server
```

With nothing configured it talks to a server on this machine. Set `REDIS_URL` in the note's frontmatter `env`, or in a [[Frontmatter and Environments]] profile when the URL carries a password, and the same block points at staging instead. Because the target is a note-level fact, two notes can hold the same commands aimed at different servers. Valkey speaks the same protocol, so `redis-cli` drives a Valkey server too; if `valkey-cli` is the binary you have installed, name it in settings (below) and the fences keep working.

## Make more languages runnable

Settings (⌘,) owns both lists: `blocks.runnable` names the fence languages that get a Run button, and `blocks.interpreters` maps a language to the command that runs it. Interpreter values may carry flags (`"python3 -u"`), and `blocks.hostInterpreters` overrides them per machine for runs a note sends over ssh ([[Remote Hosts]]).

SQL is the example worth walking through, because it is the one most people want next. Add `"sql"` to `runnable` and this to `interpreters`:

```json
"sql": "psql \"$DATABASE_URL\" -f"
```

Relaunch, and `sql` fences run against whatever `DATABASE_URL` the note's frontmatter names, exactly like `REDIS_URL` above.

```sql
select count(*) from orders where created_at > now() - interval '1 day';
```

There is deliberately no default for `sql`, because the word does not say which engine you mean: put `mysql`, `sqlite3 mydb.db <`, or `duckdb` there instead to match your engine of choice. Two things to expect from a database fence: Client tools page their output, so a wide result opens the pager inside the block and waits for you to quit it (you can type into a running block). And a query with no `limit` prints every row it gets, so keep the limits you would keep in a terminal.

One more fence worth knowing about: a `prompt` block sends its text to an AI agent (Claude Code by default) with the note's own context attached. [[Agents and Ledge]] has the full story.
