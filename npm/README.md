# ledge-server

The server half of [Ledge](https://ledge.sh), the Markdown notebook that runs
code. Install it on a machine whose notes and shells you want to reach from
the Ledge app on a Mac or an iPhone. The machine keeps the notes, runs the
commands, and holds the vault. The app is the window onto it.

The package installs one command, `ledge`. Its server verbs are what the apps
run over ssh, and its other verbs read the notes from that machine's own
shell.

## Install

Signed in as the account Ledge should use:

```sh
curl -fsSL https://ledge.sh/server.sh | sh
```

This puts the package and a private copy of Bun under `~/.ledge/.server`. It
needs no `sudo`, opens no port, and starts no service: Ledge starts the server
over ssh when a device connects, and it exits on its own a minute after the
last device leaves.

Then print a pairing code. The full path is because the installer's PATH line
reaches only new terminals:

```sh
~/.ledge/.server/bin/ledge pair
```

It lists the machine's addresses, with what each one reaches, and asks which
one your other devices should use. Scan the code with Ledge on a phone, or paste the
link under it into the Mac app's Add Server form. The code carries the
address, the account, and the host key.

If the machine already has Bun, the same package installs with it. On Linux,
Bun has to live in `/usr/local` so that an incoming ssh finds both commands:

```sh
curl -fsSL https://bun.sh/install | sudo BUN_INSTALL=/usr/local bash
sudo BUN_INSTALL=/usr/local bun add -g ledge-server
```

On a Mac, install Bun for the account and add its directory to `~/.zshenv`,
which zsh reads for commands run over ssh:

```sh
curl -fsSL https://bun.sh/install | bash
echo 'export PATH="$HOME/.bun/bin:$PATH"' >> ~/.zshenv
source ~/.zshenv
bun add -g ledge-server
```

The server runs on macOS and Linux, arm64 or x64. Linux needs glibc 2.29 or
newer: Debian 11, Ubuntu 20.04, RHEL 9, or anything later. Alpine and other
musl systems are not supported.

## Connect

In the Ledge app, run "Notes On…" from the command palette, choose Add, and
give the machine's ssh destination, or paste a pairing code. The app then
opens the connection with your own ssh credentials by running:

```sh
ssh you@machine 'PATH=$HOME/.ledge/.server/bin:$PATH ledge serve'
```

The machine's own sshd is the only thing listening, and the key or password
you already use is the credential. Ledge speaks its protocol over ssh's stdin
and stdout.

To check that an incoming ssh can find the command, run the same thing from
your Mac with `command -v ledge` in place of `ledge serve`. One path printed
means the machine is ready. Nothing printed means the install landed
somewhere ssh does not look, which happens with a `bun add -g` into a
per-user Bun. Link both commands into a system directory to fix it:

```sh
sudo ln -s "$(bun pm bin -g)/ledge" /usr/local/bin/ledge
sudo ln -s "$(command -v bun)" /usr/local/bin/bun
```

## The verbs

| Verb | What it does |
| --- | --- |
| `ledge serve` | The protocol on stdin and stdout, attached to this machine's daemon. Starts the daemon if nothing answers. What a client runs. |
| `ledge daemon` | Be this machine's server. Holds the notes, the shells, and the watchers, and runs until stopped. |
| `ledge pair` | Print a pairing code for this machine, after asking which of its addresses your other devices should use. `--user`, `--host`, and `--port` override what it describes. |
| `ledge backup` | Back this machine up to an S3-compatible bucket: `setup`, `now`, `status`, `snapshots`, `restore`, `paths`, `restic`. |
| `ledge mcp` | The Ledge MCP server on stdin and stdout, for an agent running on this machine. |
| `ledge ls`, `ledge cat`, `ledge search`, ... | Notes from this machine's own shell. `ledge help` lists them all. |

The daemon outlives the connections to it. A build keeps running after your
laptop closes, and a reconnecting client picks the output back up.

## Restrict the key

A key in that machine's `~/.ssh/authorized_keys` can be limited to Ledge's
protocol and nothing else:

```
restrict,command="PATH=$HOME/.ledge/.server/bin:$PATH ledge serve" ssh-ed25519 AAAA... ledge@laptop
```

That key cannot forward a port, run `scp`, or open a shell. It can still run
every block in every note, because running them is what the protocol does.
A phone's key arrives with this prefix already on its line.

Keep your usual key on the machine as well if you also ssh to it from a
terminal. The restricted line is for Ledge alone.

## Where the data lives

The notes, the workspace registry, the vault, the layout, and the logs sit
under `~/.ledge`. `LEDGE_NOTES_ROOT` moves that directory. Two things live
outside it: profiles, at `~/.config/ledge/profiles`, so secrets stay out of
the folder people sync; and any workspace folder attached from elsewhere on
the machine.

## Back it up

`ledge backup setup` asks for an S3-compatible bucket and its key, then keeps
an encrypted copy of all of the above there: every hour while the server is
up, and once more before it exits. `ledge backup status` reports on it, and
`ledge backup restore` brings files back. See
[Back Up Your Notes to S3](https://ledge.sh/docs/tutorial-back-up-your-notes-to-s3).

## Documentation

- [Keep Notes on a Remote Server](https://ledge.sh/docs/keep-notes-on-a-remote-server):
  the reference for connections, sharing a server, and what a dropped
  connection does.
- [Set Up a Ledge Server](https://ledge.sh/docs/tutorial-set-up-a-ledge-server):
  a fresh Linux VPS, from a new account to a hardened sshd.
- [Ledge on Your Phone](https://ledge.sh/docs/ledge-on-your-phone): pairing
  and what a phone does with a server.

## License

[Apache-2.0](https://github.com/ledgesh/ledge/blob/main/LICENSE)
