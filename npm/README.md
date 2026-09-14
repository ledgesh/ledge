# ledge-server

The server half of [Ledge](https://github.com/ledgesh/ledge), the macOS notebook for developers and DevOps.

Install this on a machine whose notes and shells you want to reach from the Ledge app on your Mac or iPhone. The machine keeps the notes, runs the commands, and holds the vault. Your client keeps nothing but the window.

The package installs one command, `ledge`. Its server verbs are what the apps run over ssh, and its other verbs are your notes from that machine's own shell.

## Install

The server runs on [Bun](https://bun.sh), and where Bun goes decides where the server goes: Bun puts global commands beside itself. Installing Bun into `/usr/local` puts both names in `/usr/local/bin`, which is where the short PATH of an ssh command looks.

```sh
curl -fsSL https://bun.sh/install | sudo BUN_INSTALL=/usr/local bash
```

Then the server itself, into the same place:

```sh
sudo BUN_INSTALL=/usr/local bun add -g ledge-server
```

The variable on the second command is not optional. Without it the package installs into the home directory of whoever ran it, where an incoming ssh will not find it.

macOS and Linux, on arm64 or x64. On Linux the floor is glibc 2.29, which means Debian 11, Ubuntu 20.04, RHEL 9, or anything newer. Alpine and other musl systems are not supported.

## Check that an incoming ssh can find it

This is the one step worth not skipping, because Ledge reports what it catches as a server that is not installed: a remote shell that cannot find a command says only that. Ledge starts the server by running `ledge serve` over ssh, and a command run that way gets a short PATH and no shell profile. Both `ledge` and the `bun` its shebang names have to be on that PATH.

From your Mac:

```sh
ssh you@machine 'command -v ledge; command -v bun'
```

Two paths printed means you are done. Nothing printed means the install landed somewhere an incoming ssh does not look, which is what a machine with a per-user Bun on it already gives you. Bun puts global commands beside itself, so `bun pm bin -g` on that machine says where they went, and linking both into a system directory fixes it without reinstalling:

```sh
sudo ln -s "$(bun pm bin -g)/ledge" /usr/local/bin/ledge
sudo ln -s "$(command -v bun)" /usr/local/bin/bun
```

## Use

You do not normally run this yourself. Add the machine in the Ledge app under Servers, and the app opens a connection with your own ssh credentials:

```sh
ssh you@machine ledge serve
```

No port is opened and no daemon is installed. Ledge speaks its protocol over ssh's stdin and stdout, so the machine's own sshd is the only thing listening, and the key you already use is the credential.

The verbs, if you want them:

| Verb | What it does |
| --- | --- |
| `ledge serve` | Move the protocol between stdin, stdout, and this machine's daemon. Starts the daemon if nothing answers. |
| `ledge daemon` | Be this machine's server. Holds the notes, the shells, and the watchers, and runs until stopped. |
| `ledge backup` | Back this machine up to an S3-compatible bucket: `setup`, `now`, `status`, `snapshots`, `restore`, `paths`, `restic`. |
| `ledge pair` | Print a pairing code a phone scans to add this server. |
| `ledge mcp` | The Ledge MCP server on stdin and stdout, for an agent running on this machine. |
| `ledge ls`, `ledge cat`, ... | Notes from this machine's own shell. `ledge help` lists them. |

The daemon outlives the connections to it, which is what lets a build keep running after your laptop closes and lets a reconnecting client pick the output back up.

## Restrict the key

Optional, and worth doing on a server you care about. In that machine's `~/.ssh/authorized_keys`:

```
restrict,command="/usr/local/bin/ledge serve" ssh-ed25519 AAAA... ledge@laptop
```

That key can then speak Ledge's protocol and nothing else. No shell, no port forwarding, no file transfer.

An absolute path here settles half of the PATH question above, since sshd runs this string instead of whatever the client asked for. The other half stays: the file it names begins `#!/usr/bin/env bun`, so `bun` still has to be findable.

## Where the data lives

Most of what the server owns sits under one directory: the notes, the workspace registry, the vault, the layout, and the logs. It is `~/.ledge` by default, and `LEDGE_NOTES_ROOT` moves it. Two things live outside it: the profiles, at `~/.config/ledge/profiles`, so credentials stay out of the folder people sync; and any workspace folder attached from elsewhere on the machine.

## Back it up

`ledge backup setup` asks for an S3-compatible bucket and its key, then keeps an encrypted copy of all of the above there: every hour while the server is up, and once more before it exits. `ledge backup status` says how it is going, and `ledge backup restore` brings files back. See [Back Up Your Notes to S3](https://github.com/ledgesh/ledge/blob/main/docs/user/21-tutorial-back-up-your-notes-to-s3.md) in the manual.

## License

Apache-2.0
