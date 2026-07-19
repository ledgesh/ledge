# Remote Hosts

A note can run its blocks on another machine. Add a `host:` line to the frontmatter and every run (inline, and the terminal drawer too) happens over ssh on that host, while the note itself stays right here.

## Declaring hosts

`host:` takes one or more ssh destinations on a single line, separated by spaces or commas. A destination is anything ssh itself accepts: `user@machine`, a bare hostname, or an alias from your `~/.ssh/config`. The reserved word `local` means this machine.

```
---
host: deploy@prod
---
```

With one host declared, every run simply goes there. With more than one, Ledge asks on every run:

```
---
host: staging, deploy@prod, local
---
```

A small "Run on" menu appears at the block, with your last pick focused so Enter repeats it and a different machine takes a deliberate arrow first. Asking every time is intentional: with prod sitting next to staging in the same note, no run should ever land on a remembered default you did not look at.

## Auth is just ssh

Ledge runs your actual `ssh`, on a real terminal. Keys, agents, and everything in `~/.ssh/config` work as they do in any terminal, and passphrase prompts, host-key confirmations, and 2FA challenges appear in the run's output where you can answer them directly. If connections feel slow to start, `ControlMaster` in your ssh config gives you connection reuse; Ledge does not manage connections itself.

## What travels with a run

Deliberately little. The note's `cwd` becomes a `cd` on the far side (where `~` means the remote home folder, and a missing directory degrades to the remote home with a message). The inline `env:` lines are exported over there. That is all.

`profile:` and `envFile:` stay local and are skipped with a warning: profiles are the secrets story, and a secret sent along an ssh command line would sit in the remote machine's process table for anyone to read. If a remote run needs configuration, put it on the remote machine.

## What runs over there

Shell blocks from inline runs land in a `bash -l` login shell on the remote host, so bash needs to exist there (it almost always does). The terminal drawer gets your own remote login shell, prompt and rc files intact.

Interpreted blocks (`python`, `node`, and friends, per [[Running Code]]) work remotely too: the block's body travels with the run, and the interpreter is resolved from the remote machine's PATH. One difference from local runs: `ts` blocks use the remote machine's own `bun`, not the one bundled with the app, so the remote host needs bun installed for TypeScript. When a machine needs a different interpreter command than your default (say `python3.11` instead of `python3`), the `blocks.hostInterpreters` setting maps overrides per host.
