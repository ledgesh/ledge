# Profiles and Secrets

A profile is a named file of environment variables that lives outside your notes folder and is injected into the shells of any note that names it.

Use one for secrets. Notes get synced, backed up, shared, and read by agents, so an API key written in an `env:` line travels everywhere the note does. With a profile, the note carries only a name.

## Declare a profile

Add one line of frontmatter (see [[Frontmatter and Environments]] for the block itself):

```
---
profile: deploy
---
```

Profile names may contain letters, digits, `-`, and `_`. The name resolves to a file under `~/.config/ledge/profiles/`, here `deploy.env`, created for you the first time you open it for editing.

A note names at most one profile, and any number of notes can share one. Every deploy-related note can say `profile: deploy` and pick up the same credentials.

## Edit a profile

Click the profile name in the frontmatter block, or run "Edit Note Profile…" from the command palette. The command appears whenever the current note names a profile.

On a touch device the palette command is the whole of it. The small key button beside the name is a pointer control and is not drawn there, and the command asks for nothing to be pointed at: it follows the note you are in.

Either way you get Ledge's profile editor: KEY=value rows with the values masked.

On disk the profile is a plain dotenv file: `KEY=value` per line, `#` comments, and an optional `export ` prefix. Ledge creates it readable only by you. Hand edits and editor edits coexist, and saves from the editor preserve your comments.

```
# deploy.env
API_TOKEN=abc123
DEPLOY_REGION=eu-west-1
```

## How profiles layer

Profile variables merge into the shell environment at spawn, above the note's `envFile` and below its inline `env:` lines. An `env:` line can therefore override a profile value for one note without editing the shared file.

A `profile:` line naming a file that does not exist is skipped, and the shell spawns without it.

A profile edit applies to newly spawned shells, like every frontmatter change. Run "Restart Note Shell" after changing one.

## Profiles stay on this machine

When a note runs its blocks on a remote host over ssh, Ledge does not send the profile ([[Remote Hosts]]). A secret passed on a remote command line would be visible in that machine's process table to anyone who can list processes. If a remote run needs credentials, put them on the remote machine.
