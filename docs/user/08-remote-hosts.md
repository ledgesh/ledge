# Remote Hosts

A note can run its blocks on another machine. Add a `host:` line to the frontmatter and every run, inline and in the terminal drawer, happens over ssh on that host. The note itself stays here.

## Declare hosts

`host:` takes one or more ssh destinations on a single line, separated by spaces or commas. A destination is anything ssh accepts: `user@machine`, a bare hostname, or an alias from your `~/.ssh/config`. The reserved word `local` means this machine.

```
---
host: deploy@prod
---
```

With one host declared, every run goes there.

```
---
host: staging, deploy@prod, local
---
```

With more than one, Ledge asks on every run. A "Run on" menu appears at the block with your last pick focused, so Enter repeats it and a different machine takes an arrow key first. Ledge asks every time rather than remembering a default, because prod and staging sit next to each other in the same note.

## Authentication

Ledge runs your own `ssh` on a real terminal. Keys, agents, and everything in `~/.ssh/config` work as they do in any terminal, and passphrase prompts, host-key confirmations, and 2FA challenges appear where you answer them directly.

In the terminal drawer they appear as they come. Inline runs hold them for a few seconds first, because a healthy connection has started the block by then and its own output is what you want to see. So the first run against a new machine pauses, then shows you ssh asking whether to trust the host key. Answer it in the output panel and the block carries on.

Ledge does not manage connections. If they feel slow to start, use `ControlMaster` in your ssh config for connection reuse.

## What travels to the host

Two things, and no more:

- The note's `cwd` becomes a `cd` on the far side. `~` means the remote home folder, and a missing directory falls back to the remote home with a message.
- The inline `env:` lines are exported there.

`profile:` and `envFile:` stay local and are skipped with a warning. A secret sent along an ssh command line would sit in the remote machine's process table for anyone to read ([[Profiles and Secrets]]). If a remote run needs configuration, put it on the remote machine.

## What runs on the host

Shell blocks from inline runs land in a `bash -l` login shell, so bash must exist on the host. The terminal drawer gets your own remote login shell, with your prompt and rc files intact.

Interpreted blocks (`python`, `node`, and others, per [[Running Code]]) work remotely too. The block's body travels with the run, and the interpreter is resolved from the remote machine's PATH.

Two differences from local runs:

- `ts` blocks use the remote machine's own `bun`, not the one bundled with the app, so the host needs bun installed for TypeScript.
- When a machine needs a different interpreter command than your default, such as `python3.11` instead of `python3`, set the override in `blocks.hostInterpreters` in Settings (⌘,).
