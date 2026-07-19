# Running Code

Any fenced code block whose language is runnable gets a Run button. This page covers what runs where, and how to bend both.

## Two ways to run

⌘↩ runs the block under the caret inline: output streams into a panel right beneath the block and stays until you dismiss it. Hovering a block shows the same Run button plus Copy, a running block's button turns into a stop, and the output panel offers Copy Output and Dismiss.

⇧⌘↩ sends the block to the note's terminal drawer instead (⌃` toggles the drawer). That is the interactive route: the block lands in a real terminal where you can keep typing after it.

## Shell blocks share a shell

Shell blocks (`sh`, `bash`, `zsh`) are fed to the note's persistent inline shell: one shell per note, so a `cd`, an exported variable, or an activated virtualenv carries into the next run.

```sh
count=$((${count:-0} + 1))
echo "run number $count"
```

Run that twice and the number climbs, because it is the same shell both times.

The terminal drawer is a separate shell from the inline one, but both belong to this note alone, and both start where the note's frontmatter points them (`cwd`, `env` and friends: see [[Getting Started]]). Frontmatter changes apply to freshly spawned shells, so after editing it, run "Restart Note Shell" from the palette: it kills the note's shells and lets them respawn clean. The same command is the escape hatch when an experiment leaves the environment weird.

## Interpreted languages

Languages with an interpreter mapping (`python`, `node`, `ruby`, `ts`, `php` and friends) run as a file handed to that interpreter, one fresh process per run, so no state carries between their runs.

```python
import platform
print(f"hello from Python {platform.python_version()}")
```

TypeScript is special-cased to the Bun runtime bundled with the app, so `ts` blocks run without anything installed.

## Make more languages runnable

Settings (⌘,) owns both lists: `blocks.runnable` names the fence languages that get a Run button, and `blocks.interpreters` maps a language to the command that runs it. Add `"lua"` to the first and `"lua": "lua"` to the second, relaunch, and lua fences run. Interpreter values may carry flags (`"python3 -u"`), and `blocks.hostInterpreters` overrides them per machine for runs a note sends over ssh.

One more fence worth knowing about: a `prompt` block sends its text to an AI agent (Claude Code by default) with the note's own context attached. More on that later in this manual.
