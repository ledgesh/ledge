# Frontmatter and Environments

A note can declare how its shells spawn: which directory they start in, which environment variables they carry, and which machine they run on. Those declarations live in a frontmatter block at the top of the note.

This page covers the block itself and the directory and environment keys. Secrets have their own page ([[Profiles and Secrets]]), as does running on other machines ([[Remote Hosts]]).

## The frontmatter block

Frontmatter sits at the very top of a note: a `---` line, your `key: value` lines, then a closing `---` line. Press ⌥⌘, on any note to jump into its block, or to create one if the note has none. Completion inside the block offers every key with a one-line hint at the start of a line.

```
---
cwd: ~/Projects/my-app
envFile: .env
env:
  NODE_ENV: development
  PORT: "3000"
---
```

The grammar is small: flat `key: value` lines, plus one indented map under `env:`. Full-line `#` comments and blank lines are allowed, and a value with spaces can be quoted, as in `cwd: "~/My Notes"`.

A bad line costs only itself, never the rest of the block, and an unknown key is reported as a probable misspelling rather than ignored.

## cwd: where shells start

`cwd:` sets the working directory for every shell the note spawns, both the inline shell and the terminal drawer. `~` expands to your home folder, and a relative path resolves against it. If the directory does not exist, the shell spawns in your home folder instead.

Notes in an attached project workspace use that project folder as their `cwd`, so they usually need no frontmatter. Notes in a managed workspace default to your home folder.

Here is where this note's shells start:

```sh
echo "this note's shells start in $PWD"
```

## env and envFile: environment variables

Three keys feed the environment, layered in this order, with later layers overriding earlier ones:

1. `envFile:` names a dotenv file, resolved against the note's `cwd`. So `envFile: .env` picks up the project's own env file when `cwd` points at the project. A missing file is skipped and the shell spawns anyway.
2. The note's profile, if it names one ([[Profiles and Secrets]]).
3. `env:` sets values inline in the note.

`env:` is for plain, non-secret values. They sit in the note in the open, which suits `NODE_ENV` and does not suit an API key. Secrets belong in a profile: a named env file kept outside your notes folder, so syncing or sharing notes never carries credentials.

`TERM` is protected. A layer that sets it is overridden back, because the built-in terminal is the terminal whatever the note claims.

## When changes apply

Frontmatter is read when a shell spawns, and a note's running shells keep the settings they started with.

After editing the block, run "Restart Note Shell" from the command palette (⇧⌘P). It kills the note's shells, and the next run or drawer visit respawns them with the current frontmatter. Use the same command when an experiment leaves a shell in a strange state.

## Every key

| Key | What it does |
| --- | --- |
| `cwd:` | Working directory for the note's shells. |
| `env:` | Environment variables, set inline. |
| `envFile:` | Dotenv file to load, resolved against `cwd`. |
| `profile:` | Named env file outside the notes folder, for secrets. See [[Profiles and Secrets]]. |
| `host:` | Machines the note's blocks run on. See [[Remote Hosts]]. |
| `tags:` | Tags, the same vocabulary as inline `#hashtags`. See [[Finding Things]]. |
| `template:` | `true` lists the note in the New Note from Template picker; `daily` makes it the daily template. See [[Daily Notes and Templates]]. |
| `confirm:` | `true` makes every runnable block in the note ask before running. A single block opts out with `confirm=no` on its fence. See [[Running Code]]. |
| `locked:` | Written by "Lock This Note…" to mark an encrypted note. You never type it. See [[Note Locking]]. |
