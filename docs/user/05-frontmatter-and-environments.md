# Frontmatter and Environments

A note can declare how its shells spawn: which directory they start in, which environment variables they carry, even which machine they run on. Those declarations live in a frontmatter block at the top of the note, and this page covers the block itself plus the directory and environment keys. Secrets have their own page ([[Profiles and Secrets]]), and so does running on other machines ([[Remote Hosts]]).

## The block

Frontmatter is a fenced block at the very top of a note: a `---` line first, your `key: value` lines, then a closing `---` line. Press ⌥⌘, on any note to jump into its block, or to create one if the note has none. Inside the block, completion knows the grammar: at the start of a line it offers every key with a one-line hint, so you rarely need this page open while typing.

```
---
cwd: ~/Projects/my-app
envFile: .env
env:
  NODE_ENV: development
  PORT: "3000"
---
```

The grammar is deliberately small: flat `key: value` lines, plus one indented map under `env:`. Full-line `#` comments and blank lines are fine, and a value with spaces can be quoted (`cwd: "~/My Notes"`). Typos degrade gently: a bad line costs only itself, never the rest of the block, and an unknown key is treated as the misspelling it probably is rather than silently ignored.

## Where shells start

`cwd:` sets the working directory for every shell the note spawns: the persistent inline shell, the terminal drawer, all of them. `~` expands to your home folder, and a relative path resolves against it. If the directory does not exist, the shell still spawns (in your home folder) rather than dying at birth.

Notes in an attached project workspace get that project folder as their default `cwd`, so they usually need no frontmatter at all. Notes in a managed workspace default to your home folder.

Here is where this note's shells start:

```sh
echo "this note's shells start in $PWD"
```

## Environment variables

Three keys feed the environment, layered in a fixed order: `envFile` first, then the note's profile, then the inline `env:` map, with later layers overriding earlier ones. (`TERM` is protected: a layer that sets it is overridden back, because the built-in terminal is the terminal whatever the note claims.)

`env:` is for plain, non-secret values: they sit in the note in the open, which is exactly right for a `NODE_ENV` and exactly wrong for an API key.

`envFile:` names a dotenv file, resolved against the note's `cwd`, so `envFile: .env` picks up the project's own env file when `cwd` points at the project. A missing file is skipped, and the shell spawns anyway.

Secrets belong in a profile: a named env file kept outside your notes folder entirely, so syncing or sharing notes never carries credentials along. [[Profiles and Secrets]] has the full story.

## When changes apply

Frontmatter is read when a shell spawns, and the note's persistent shells keep the parameters they were born with. After editing the block, run "Restart Note Shell" from the command palette (⇧⌘P): it kills the note's shells, and the next run or drawer visit respawns them with the current frontmatter. The same command is the escape hatch whenever an experiment leaves a shell's state weird.

## The other keys

The block holds a few keys that have nothing to do with shells, because a note has exactly one frontmatter grammar:

- `host:` names the machines the note's blocks run on. See [[Remote Hosts]].
- `tags:` declares tags, same vocabulary as inline `#hashtags`. See [[Finding Things]].
- `template: true` puts the note in the New Note from Template picker, and `template: daily` marks it as the template for daily notes. See [[Daily Notes and Templates]].
- `confirm: true` makes every runnable block in the note ask before it runs, for a runbook where all of them are consequential. Any single block can still opt out with `confirm=no` on its fence. See [[Running Code]].
- `locked:` is machine-written by "Lock This Note…" and marks an encrypted note. You never type it yourself. See [[Note Locking]].
