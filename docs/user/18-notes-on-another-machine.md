# Notes on Another Machine

Ledge can keep your notes on a different machine and run this app as the window onto it. The other machine holds the notes, spawns the shells, and keeps them running; this one draws them. The transport is ssh, so there is no account to make and no service to sign up for.

One machine at a time from this app. The connection bar above the workspace strip always names the one you are typing into. A machine can serve several of your devices at once.

This is a different feature from [[Remote Hosts]], and the difference matters. `host:` frontmatter says where a *block* runs. A connection says where the *note lives*. They compose: a note stored on your VPS can carry `host: prod`, and the VPS makes that outbound ssh connection, so this app never holds credentials for prod.

## Add a server

Click the connection bar, or run "Notes On…" from the palette or the File menu. Choose Add, then fill in three fields.

| Field | What it takes |
| --- | --- |
| Name | Anything you want to see in the bar. |
| SSH destination | `user@host`, a bare hostname, or a name from your `~/.ssh/config`. |
| Key | A private key to offer, or blank to let your ssh config decide. |

Ledge then fetches that machine's host key and shows you its fingerprint. Compare it against what the machine reports for itself:

```sh
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

Choose "It Matches, Add" only when the two agree. Ledge pins the key and refuses any future connection that presents a different one. There is no "connect anyway".

The pinned keys live in `~/.ledge/.client/known_hosts`, separate from your own `~/.ssh/known_hosts` so you can read and revoke them on their own. Your existing entries still work: a host you already trust needs no second pin.

Add as many as you like. The list is this app's own and lives on this machine, so nothing about it is stored on any server.

## Edit or remove a server

Every row in the picker carries two controls: a pencil to change it and a bin to remove it. Press ⌫ on a focused row to remove it without reaching for either.

Editing opens the same form. A rename, or a change of account on the same machine, saves in one step, because neither changes which machine the pinned key belongs to.

Changing the address to a different machine does not. The button reads "Continue" instead of "Save", Ledge asks that machine for its host key, and you compare the fingerprint again before anything is stored. A key pinned for one machine says nothing about another, and carrying it across would refuse every later connection with a warning about a changed host key.

Use "Check Key Again" when a server you already have has legitimately rotated its host key. It is the same fingerprint step, on a connection you keep.

This Mac cannot be removed or edited, and neither can the connection you are currently using: switch somewhere else first.

## Switch servers

The picker opens on the connection in use, so Enter means stay and moving somewhere else takes an arrow key first.

Switching closes every tab and opens that machine's instead. Nothing is lost: the tabs are on the other machine and come back when you switch back.

A connection that will not open costs you nothing. Ledge reaches the new machine before it lets go of the old one, so a typo or a sleeping laptop leaves you exactly where you were with the reason on screen. If the failure happens at launch, Ledge opens on this Mac and the bar reads "not reachable".

## Install the server

The other machine needs `ledge-server` on its PATH. Build it from a checkout of Ledge, on a machine of the same architecture as the one that will run it:

```sh
bun run build:native
bun build src/bun/serve.ts --compile --outfile ledge-server
```

Copy `ledge-server` and `dist-native/libledge_pty.so` to the server, side by side, somewhere on the PATH. The `.so` holds two C functions the terminal needs, and without it beside the binary you get shells that run commands but ignore Ctrl-C.

macOS arm64 and Linux x64/arm64 are supported. On Linux the floor is glibc 2.29, which means Debian 11, Ubuntu 20.04, RHEL 9, or anything newer. Alpine and other musl systems are not supported.

Nothing else has to be installed and no port is opened. Ledge speaks its protocol over ssh's stdin and stdout.

## Run the server in Docker

The repository ships a `Dockerfile`. Build and run it:

```sh
docker build -t ledge-server .
docker run -d --name ledge --restart unless-stopped -v ledge-data:/data ledge-server
```

Everything the server owns lives in `/data`: the notes, the workspace registry, the vault, and the logs. That volume is the whole backup.

The image has no ssh daemon in it. The machine's own sshd is the one that answers, and it reaches into the container (see below). Running a second sshd inside a container means a second set of host keys and a second published port, for nothing.

The image carries zsh, `ssh`, and nothing else your notes might want. Add what you need in an image of your own:

```dockerfile
FROM ledge-server
USER root
RUN apt-get update && apt-get install -y --no-install-recommends git python3
COPY --from=oven/bun:1-debian /usr/local/bin/bun /usr/local/bin/bun
USER ledge
```

The `bun` line is there for `ts` blocks. The app carries its own copy of that runtime and a server carries none ([[Running Code]]).

## Restrict the key to Ledge

Give the server a key that can speak Ledge's protocol and nothing else. In that machine's `~/.ssh/authorized_keys`:

```
restrict,command="ledge-server serve" ssh-ed25519 AAAA... ledge@laptop
```

For the Docker deployment, the forced command reaches into the container instead:

```
restrict,command="docker exec -i ledge ledge-server serve" ssh-ed25519 AAAA... ledge@laptop
```

That key cannot open a shell, forward a port, or run `scp`. Blocks in your notes still run, because they run through the protocol the forced command already permits.

If you also want a client to run arbitrary commands on that machine, add a second unrestricted key as a separate act. Most connections never need one.

## Expose ssh carefully

A Ledge server executes the code in your notes. Anyone who can authenticate to it can run anything you could.

On a VPS, bind sshd to a private interface rather than to the public internet. In `/etc/ssh/sshd_config`:

```
ListenAddress 100.x.y.z
PasswordAuthentication no
```

Use the address your VPN or tailnet gives the machine. A Ledge server on `0.0.0.0` is a box on the public internet whose purpose is running code.

On a Mac, the server needs Remote Login turned on in System Settings, under General then Sharing. Restrict it to specific users while you are there.

## What lives on the server

| On the server | On this Mac |
| --- | --- |
| Notes, images, and the trash | Theme, font sizes, and live preview |
| Workspaces | Window size and position |
| The vault and locked notes | The clipboard |
| Profiles and their secrets | Which connections exist, and their pinned keys |
| Shells, running blocks, and scrollback | |
| The shell, interpreter, and trash settings | |

Settings (⌘,) shows both files. The appearance half follows you between machines; the behavior half describes the machine it is on, because a VPS's shell is not your laptop's.

Profile values never cross the connection. A note names a profile and the server reads the file at spawn, so the secrets exist only where the commands run ([[Profiles and Secrets]]).

Unlocking a locked note sends the passphrase to the server, which is the only machine that can use it ([[Note Locking]]). The vault and its idle relock timer stay there.

## Several devices on one server

A server serves every device that connects to it. Your Mac and your phone can both be on the same server at once, reading the same notes and running commands.

Each device keeps its own tabs and panes. The server files them under the device that arranged them, so a phone does not open into a Mac's three-pane layout.

The connection bar shows who else is connected: one other device by name, more than one as a count. Hover it for the full list. Names come from the devices themselves, so a Mac uses its computer name, and a device that gives no name reads as "another device".

Nothing appears there when you are the only one connected, and nothing ever appears while your notes are on this Mac.

A note saved on one device appears on the other without a refresh. Everything else a server owns is shared the same way: the same workspaces, the same trash, the same tags and backlinks, the same vault.

The one thing two devices cannot share is a note's terminal.

## Take a shell from another device

Opening a note's terminal on a second device moves the shell there, output and typing together. A shell has one keyboard: two devices typing into the same one would interleave their keystrokes on a single line.

The device that had it keeps the last of the output on screen behind a notice, which names the device that took the shell and offers a Take This Shell button. Press it and the shell comes back, along with everything it printed while it was away.

The shell is unaffected either way. It runs on the server throughout, so a build keeps building while the two devices take turns watching it.

Blocks are different: a block runs for the device that started it, and only that device sees its output panel or can stop it ([[Running Code]]).

## Edit the same note on two devices

An open note you are not editing follows its file. Save that note on one device and the other device's copy updates on screen, with no refresh and no prompt.

A note being edited on both devices is settled when they save. The second save wins the file and the version it displaced goes to the workspace trash, so nothing is overwritten. The device that displaced it shows a notice in the sidebar naming the note, and the other version is in the trash until you empty it.

This is the same arbitration a note gets from any other writer, including an agent in the terminal, a `git checkout`, or a sync service ([[Tutorial: Keep Notes Synced]]).

## When the connection drops

The bar reads "reconnecting…" and Ledge re-dials for about thirty seconds. Requests made in the meantime wait rather than fail.

Anything running keeps running. Shells belong to the server and survive a wire dropping, so a build carries on while you are on a train and its output is waiting when you come back. Reattaching replays the last 256 KB of each terminal.

A block's output panel is the exception, and only across a restart. The panel lives in the page rather than on the server, so a wire that drops and comes back finds it still there with the run still going.

A Ledge that has relaunched has no panel, and no way to show that run or stop it. So blocks left running on a server are stopped the next time Ledge connects to it, which includes switching to another connection and back. A terminal is not affected, because reattaching finds its shell where you left it.

This reaches only the blocks that device started. A server can be carrying runs for more than one of your devices, and a phone connecting does not stop what your Mac left running.

A save that was in flight when the wire dropped is retried once the connection is back, and applied once, even if the first attempt had already landed.

If the reconnect runs out, the bar reads "disconnected" and Ledge stops accepting work for a machine it cannot reach. Choose the connection again from the picker to start over.

Ledge also stops when the server hangs up on purpose rather than the wire failing, and hovering the bar says why. One reason is the server shutting down. The other is a second copy of Ledge on this same device connecting to it: the server keeps the newer connection and tells the older one, which stops instead of the two taking the server off each other in a loop. Another device connecting is not a reason (see above).

## Limits

- One connection at a time. Search, tags, backlinks, and wikilinks all stay within the machine you are on.
- One device at a time in a note's terminal. Everything else on a server is shared by every device connected to it (see above).
- No moving a note between servers from inside the app. Use `rsync` or `git`; the notes are ordinary files ([[Tutorial: Keep Notes Synced]]).
- No offline editing. The server has to be reachable to open a note.
