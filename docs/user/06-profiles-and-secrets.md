# Profiles and Secrets

A profile is a named file of environment variables that lives outside your notes folder and gets injected into the shells of any note that asks for it. It exists for one reason: secrets do not belong in notes. Notes get synced, backed up, shared, and read by agents; an API key written in an `env:` line travels everywhere the note does. A profile keeps the note carrying only a name, never the values.

## Declaring one

One line of frontmatter (see [[Frontmatter and Environments]] for the block itself):

```
---
profile: deploy
---
```

Profile names are letters, digits, `-` and `_`. The name resolves to a file under `~/.config/ledge/profiles/` (here, `deploy.env`), which is created for you the first time you open it for editing. A note names at most one profile, but any number of notes can share one: every deploy-flavored note can say `profile: deploy` and pick up the same credentials.

## Editing one

Click the profile name right in the frontmatter block, or run "Edit Note Profile…" from the command palette (the command appears whenever the current note names a profile). Either way you get Ledge's profile editor: KEY=value rows with the values masked, since the whole point of the file is that its contents are secrets.

On disk the profile is a plain dotenv file: `KEY=value` per line, `#` comments, an `export ` prefix tolerated. It is created private to you, hand edits and editor edits coexist, and the editor's saves preserve your comments.

```
# deploy.env
API_TOKEN=abc123
DEPLOY_REGION=eu-west-1
```

## How it layers

Profile variables are merged into the shell environment at spawn, above the note's `envFile` and below its inline `env:` lines, so an `env:` line can override a profile value for one note without editing the shared file. A `profile:` line naming a file that does not exist yet is simply skipped, and the shell spawns without it.

Like every frontmatter change, a profile edit applies to freshly spawned shells: run "Restart Note Shell" after changing one, and the next run picks it up.

One boundary worth knowing in advance: profiles never leave this machine. When a note runs its blocks on a remote host over ssh, the profile is deliberately not sent (see [[Remote Hosts]]), because a secret on a remote command line would be visible to anyone on that machine who can list processes.
