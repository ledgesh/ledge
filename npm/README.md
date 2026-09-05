# ledge-server

The server half of [Ledge](https://github.com/ledgesh/ledge), the macOS notebook for developers and DevOps.

Install this on a machine whose notes and shells you want to reach from the Ledge app on your Mac or iPhone. The machine keeps the notes, runs the commands, and holds the vault. Your client keeps nothing but the window.

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

This is the one step worth not skipping, because Ledge reports what it catches as a server that is not installed: a remote shell that cannot find a command says only that. Ledge starts the server by running `ledge-server serve` over ssh, and a command run that way gets a short PATH and no shell profile. Both `ledge-server` and the `bun` its shebang names have to be on that PATH.

From your Mac:

```sh
ssh you@machine 'command -v ledge-server; command -v bun'
```

Two paths printed means you are done. Nothing printed means the install landed somewhere an incoming ssh does not look, which is what a machine with a per-user Bun on it already gives you. Bun puts global commands beside itself, so `bun pm bin -g` on that machine says where they went, and linking both into a system directory fixes it without reinstalling:

```sh
sudo ln -s "$(bun pm bin -g)/ledge-server" /usr/local/bin/ledge-server
sudo ln -s "$(command -v bun)" /usr/local/bin/bun
```

## Use

You do not normally run this yourself. Add the machine in the Ledge app under Servers, and the app opens a connection with your own ssh credentials:

```sh
ssh you@machine ledge-server serve
```

No port is opened and no daemon is installed. Ledge speaks its protocol over ssh's stdin and stdout, so the machine's own sshd is the only thing listening, and the key you already use is the credential.

Two verbs exist if you want them:

| Verb | What it does |
| --- | --- |
| `ledge-server serve` | Move the protocol between stdin, stdout, and this machine's daemon. Starts the daemon if nothing answers. |
| `ledge-server daemon` | Be this machine's server. Holds the notes, the shells, and the watchers, and runs until stopped. |

The daemon outlives the connections to it, which is what lets a build keep running after your laptop closes and lets a reconnecting client pick the output back up.

## Restrict the key

Optional, and worth doing on a server you care about. In that machine's `~/.ssh/authorized_keys`:

```
restrict,command="/usr/local/bin/ledge-server serve" ssh-ed25519 AAAA... ledge@laptop
```

That key can then speak Ledge's protocol and nothing else. No shell, no port forwarding, no file transfer.

An absolute path here settles half of the PATH question above, since sshd runs this string instead of whatever the client asked for. The other half stays: the file it names begins `#!/usr/bin/env bun`, so `bun` still has to be findable.

## Where the data lives

Everything the server owns sits under one directory: the notes, the workspace registry, the vault, the layout, and the logs. It is `~/.ledge` by default, and `LEDGE_NOTES_ROOT` moves it. That directory is the whole backup.

## Docker

The Ledge repository ships a `Dockerfile` for the container deployment, where the image's PID 1 is the daemon and the host's sshd reaches in with `docker exec`. See [Keep Notes on a Remote Server](https://github.com/ledgesh/ledge/blob/main/docs/user/09-keep-notes-on-a-remote-server.md) in the manual.

## License

Apache-2.0
