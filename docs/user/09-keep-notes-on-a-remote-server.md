# Keep Notes on a Remote Server

Ledge can keep your notes on a server and run this app as the window onto it. The server holds the notes, spawns the shells, and keeps them running; this app draws them. The transport is ssh, so there is no account to make and no service to sign up for.

One server at a time per window. The connection bar above the workspace strip always names the one you are typing into, and a server can serve several of your devices at once.

Ledge has two ways to involve a remote machine, and they answer different questions.

| | The note | Its blocks |
| --- | --- | --- |
| A `host:` line in the note ([[Run Code on Remote Hosts]]) | Stays where it is | Run over ssh on the host it names |
| A server connection ([[Keep Notes on a Remote Server]]) | Lives on the server | Run on the server |
| Both | Lives on the server | Run on the host, which the server dials |

This page is the second row. [[Run Code on Remote Hosts]] is the first, and the two compose: a note kept on your VPS can carry `host: prod`, and the VPS makes that outbound ssh connection, so this app never holds credentials for prod.

## Add a server

Click the connection bar, or run "Notes On…" from the palette or the File menu. Choose Add, then fill in the fields.

| Field | What it takes |
| --- | --- |
| Name | Anything you want to see in the bar. |
| SSH destination | `user@host`, a bare hostname, or a name from your `~/.ssh/config`. |
| Port | Blank unless sshd listens somewhere other than 22. |
| Sign in with | A key or a password. |
| Key | A private key to offer, or blank to let your ssh config decide. |

The port goes in its own field, not in the address: write `ledge@vps`, not `ledge@vps:2222`.

Leave it blank whenever you can. Blank means your ssh config decides, so an alias from `~/.ssh/config` keeps whatever `Port` it already sets.

Ledge then fetches that machine's host key and shows you its fingerprint. Compare it against what the machine reports for itself, in a shell on that machine:

```sh norun
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

Choose "It Matches, Add" only when the two agree. Ledge pins the key and refuses any future connection that presents a different one. There is no "connect anyway".

The pinned keys live in `~/.ledge/.client/known_hosts`, separate from your own `~/.ssh/known_hosts` so you can read and revoke them on their own. Your existing entries still work: a host you already trust needs no second pin.

A pinned key belongs to one address and one port. Change either and Ledge asks for the fingerprint again, because two sshd instances on one machine can offer different keys.

Add as many as you like. The list is this app's own and lives on this machine, so nothing about it is stored on any server.

## Edit or remove a server

Every row in the picker carries two controls: a pencil to change it and a bin to remove it. Press ⌫ on a focused row to remove it without reaching for either.

Editing opens the same form. A rename, or a change of account on the same machine, saves in one step, because neither changes which machine the pinned key belongs to.

Changing the address to a different machine does not. The button reads "Continue" instead of "Save", Ledge asks that machine for its host key, and you compare the fingerprint again before anything is stored. A key pinned for one machine says nothing about another, and carrying it across would refuse every later connection with a warning about a changed host key.

Use "Check Key Again" when a server you already have has legitimately rotated its host key. It is the same fingerprint step, on a connection you keep.

This Mac cannot be removed or edited, and neither can the connection you are currently using: switch somewhere else first.

## Sign in with a password

Choose "A password" in the form and type the password for that account on that machine. Ledge stores it and offers it on every connection, including the reconnects it makes by itself.

Use it when the machine has no key on it yet. A fresh VPS with a password is a machine you can reach today, and setting up a key afterwards is a change you make once. Keys are the better long-term answer, and switching a connection over to one later is one edit.

Ledge keeps the password in your Mac's keychain and never in `~/.ledge`. When ssh asks for it, ssh reads it from the keychain itself, so the password does not pass through Ledge on its way out.

Anything running as you on this Mac can read that keychain item. That is the same reach a private key file in `~/.ssh` gives, so a password here is neither safer nor less safe than the key it stands in for.

Removing the connection removes the password with it. So does switching that connection back to a key.

The password field is blank when you edit an existing connection, and blank means keep the one that is stored. Type a new one only when you want to replace it. If the new one does not work, Ledge puts the old one back and tells you the connection could not be reached.

Some servers do not allow passwords at all. If the machine reports "Permission denied", check `PasswordAuthentication` in its `/etc/ssh/sshd_config` before checking what you typed.

Restricting a key to Ledge does not apply to a password. That restriction is a line in `authorized_keys`, which is a file about keys.

## Switch servers

The picker opens on the connection in use, so Enter means stay and moving somewhere else takes an arrow key first.

Switching closes every tab and opens that machine's instead. Nothing is lost: the tabs are on the other machine and come back when you switch back.

A connection that will not open costs you nothing. Ledge reaches the new machine before it lets go of the old one, so a typo or a sleeping laptop leaves you exactly where you were with the reason on screen. If the failure happens at launch, Ledge opens on this Mac and the bar reads "not reachable".

## Two machines at once

New Window in the File menu opens a second window, and each window is on its own machine. Switching moves one window; a second window is how you have a build box and a VPS open side by side.

A new window opens on this Mac. Switch it wherever you like from inside it.

Each window is titled after the machine it is on, so the title bar reads "This Mac" or the name you gave the connection. That is the name in the Window menu too, and on a window's tab when macOS merges your windows into tabs.

The manual's window is the exception, titled "Documentation". It reads the copy of the manual that ships with this app, so it stays on this Mac whichever machine the window you opened it from is on.

Each window keeps its own tabs and panes, and the server remembers them: switch a window back to a machine you used before and its arrangement comes back. Ledge reopens every window you left open at the next launch, each on the machine it was pointed at.

Two windows on the same machine are the exception. Only one of them can be that machine's arrangement, so the second opens empty and does not overwrite the first.

Closing the last window quits Ledge.

## Install the server

The other machine needs `ledge-server` on the PATH an incoming ssh gets. It is a package, so two commands install it.

The server runs on Bun, and where Bun goes decides where the server goes, because Bun puts global commands beside itself. On that machine, install Bun into `/usr/local` and both names land in `/usr/local/bin`, which is where the short PATH of an ssh command looks:

```sh norun
curl -fsSL https://bun.sh/install | sudo BUN_INSTALL=/usr/local bash
```

Then the server, into the same place:

```sh norun
sudo BUN_INSTALL=/usr/local bun add -g ledge-server
```

The variable on the second command is not optional. Without it the package installs into the home directory of whoever ran it, which is not a directory an incoming ssh searches.

macOS and Linux are supported, on arm64 or x64. On Linux the floor is glibc 2.29, which means Debian 11, Ubuntu 20.04, RHEL 9, or anything newer. Alpine and other musl systems are not supported.

Nothing else has to be installed and no port is opened. Ledge speaks its protocol over ssh's stdin and stdout.

Blocks need zsh or bash on that machine. Ledge spawns the account's login shell when it is one of those, and otherwise the first of the two it finds, so an ordinary Linux install needs nothing extra. Where neither exists, a run refuses and names the shell it looked for instead of appearing to do nothing.

## Check that ssh can find the server

Worth doing once, because Ledge reports the failure it catches as a server that is not installed. A remote shell that cannot find a command says only that, so that is all the app has to go on.

Ledge starts the server by running `ledge-server serve` over ssh. A command run that way gets a short PATH and reads no shell profile, so both `ledge-server` and the `bun` its first line names have to be on that PATH already. From your Mac's own terminal:

```sh norun
ssh you@machine 'command -v ledge-server; command -v bun'
```

Two paths printed means the machine is ready to add.

Nothing printed means Bun is installed for one user rather than system-wide, which is what a machine that already had Bun before you started usually has. Its global commands are then in `~/.bun/bin`, which an incoming ssh does not search, and `bun pm bin -g` on that machine confirms where they went. Linking both names into a system directory, on that machine, fixes it without reinstalling anything:

```sh norun
sudo ln -s "$(bun pm bin -g)/ledge-server" /usr/local/bin/ledge-server
sudo ln -s "$(command -v bun)" /usr/local/bin/bun
```

## Build the server from a checkout

Only if you want a build of your own. The package is the ordinary way. From a checkout of the repository:

```sh norun
bun run build:native
bun build src/bun/serve.ts --compile --outfile ledge-server
```

Copy `ledge-server` and `dist-native/libledge_pty.so` to the server, side by side, somewhere on the PATH. Build it on a machine of the same architecture as the one that will run it, since a compiled binary is one architecture and the package is the thing that carries all of them.

The `.so` holds two C functions the terminal needs. Without it beside the binary, resizing a terminal does nothing and a shell that stops reading can stall the server.

## Run the server in Docker

The repository ships a `Dockerfile`. Build and run it from a checkout on the machine that will host the container:

```sh norun
docker build -t ledge-server .
docker run -d --name ledge --restart unless-stopped -v ledge-data:/data -v ledge-home:/home/ledge ledge-server
```

Mount both volumes. `/data` holds the notes, the workspace registry, the vault, and the logs. `/home/ledge` holds the account: your profiles and their secrets live in `~/.config/ledge/profiles`, and the keys `host:` frontmatter dials out with live in `~/.ssh`.

Neither directory is the whole story on its own, and `docker rm` takes whatever you did not mount. Run `ledge-server backup-paths` in the container to see both, resolved. "Back up the server" below is what to do with them.

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

Optional, and worth doing on a server you care about. Ledge connects with an ordinary key either way and never edits this file for you.

Restricting gives the server a key that can speak Ledge's protocol and nothing else. In that machine's `~/.ssh/authorized_keys`:

```
restrict,command="/usr/local/bin/ledge-server serve" ssh-ed25519 AAAA... ledge@laptop
```

Use the absolute path that `command -v ledge-server` printed above. sshd runs this line instead of whatever the client asked for, so naming the file outright settles where it is. It does not settle where Bun is, which is the other half of the check.

For the Docker deployment, the forced command reaches into the container instead:

```
restrict,command="docker exec -i ledge ledge-server serve" ssh-ed25519 AAAA... ledge@laptop
```

That key cannot forward a port, run `scp`, or open a shell over ssh. What it limits is what the key is good for if it is ever stolen: no route into the network behind that server, and no file copying.

It does not limit Ledge. Blocks in your notes still run, because running them is what the protocol does, so anyone holding that key can run code on that machine. Restricting narrows what else they could do with it.

If you also want to use ssh directly to that machine from a terminal, keep your usual key there as well. The restricted line is for Ledge alone.

A phone's key arrives already restricted. The line its pairing screen hands you carries this prefix ([[Ledge on Your Phone]]).

## Expose ssh carefully

A Ledge server executes the code in your notes. Anyone who can authenticate to it can run anything you could.

On a VPS, bind sshd to a private interface rather than to the public internet. In `/etc/ssh/sshd_config`:

```
ListenAddress 100.x.y.z
PasswordAuthentication no
```

Use the address your VPN or tailnet gives the machine. A Ledge server on `0.0.0.0` is a box on the public internet whose purpose is running code.

`PasswordAuthentication no` and Ledge's password sign-in are the same setting seen from two ends, and the order to do them in is: use a password to reach the machine, put your key on it, then turn passwords off. A box reachable from the internet should not be answering password attempts from it.

On a Mac, the server needs Remote Login turned on in System Settings, under General then Sharing. Restrict it to specific users while you are there.

## What lives on the server

| On the server | On this Mac |
| --- | --- |
| Notes, images, and the trash | Theme, font sizes, and live preview |
| Workspaces | Window size and position |
| The vault and locked notes | The clipboard |
| Profiles and their secrets | Which connections exist, their pinned keys, and any stored passwords |
| Shells, running blocks, and scrollback | |
| The shell, interpreter, and trash settings | |

Settings (⌘,) shows both files. The appearance half follows you between machines; the behavior half describes the machine it is on, because a VPS's shell is not your laptop's.

Profile values never cross the connection. A note names a profile and the server reads the file at spawn, so the secrets exist only where the commands run ([[Profiles and Secrets]]).

Unlocking a locked note sends the passphrase to the server, which is the only machine that can use it ([[Note Locking]]). The vault and its idle relock timer stay there.

## Back up the server

Ledge backs nothing up. `ledge-server backup-paths` prints the paths a backup has to cover, and you point a backup tool at them.

Run it as the account the server runs as, on the machine the server runs on:

```sh norun
ledge-server backup-paths
```

One absolute path per line: the app home, every workspace folder you attached from elsewhere on the machine, and the profiles directory. Only the server can answer this, because only its registry knows where you attached those folders.

| Flag | What it prints |
| --- | --- |
| none | The paths to back up. |
| `--exclude` | What to skip inside them: the daemon's socket and pidfile, the logs, and the copy of this manual. |
| `--no-secrets` | The same list without the profiles directory. |
| `--json` | Both lists, plus any registered folder that is not on disk. |

A registered folder that is missing right now is left out, with a line on stderr saying so. Naming a path that is not there fails the whole backup run, and dropping it without a word is how a workspace stops being backed up until you notice at a restore.

Everything on this page works the same whether the server is a package on a VPS, a build of your own, or the image. The paths differ, so ask the machine rather than assuming them. On a VPS they are all under the account's home. In the image the app home is `/data` and the profiles are under `/home/ledge`, which is why that deployment mounts two volumes.

Ask the container for the image deployment, from its host:

```sh norun
docker exec ledge ledge-server backup-paths
```

## Back up to an S3-compatible bucket

restic reads both lists and encrypts on the server before anything leaves it. Any S3-compatible bucket works: S3, R2, B2, Wasabi, MinIO.

On the server, install it, then write the repository and its credentials to a file only that account can read:

```sh norun
sudo apt-get install -y restic
install -m 600 /dev/null ~/.config/ledge/profiles/backup.env
```

```ini
RESTIC_REPOSITORY=s3:https://ACCOUNT.r2.cloudflarestorage.com/ledge
RESTIC_PASSWORD=a long random string
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
```

That path is a profile, so a note can also use it by name ([[Profiles and Secrets]]). Keep values unquoted: systemd reads the same file below and does not strip quotes the way a shell does.

Credentials do not belong in `settings.jsonc`, which is inside the app home and therefore inside the backup.

## Back up on a schedule

A backup you have to remember is not a backup. On a VPS, that means a systemd timer.

`/etc/systemd/system/ledge-backup.service`, with `User` and `EnvironmentFile` naming the account the server runs as:

```ini
[Unit]
Description=Ledge backup

[Service]
Type=oneshot
User=ledge
EnvironmentFile=/home/ledge/.config/ledge/profiles/backup.env
ExecStart=/bin/bash -c 'restic backup --files-from <(ledge-server backup-paths) --exclude-file <(ledge-server backup-paths --exclude)'
```

`ExecStart` names `/bin/bash` because systemd runs no shell of its own, and the two `<(...)` substitutions need one.

`/etc/systemd/system/ledge-backup.timer`:

```ini
[Unit]
Description=Ledge backup, hourly

[Timer]
OnCalendar=hourly
Persistent=true

[Install]
WantedBy=timers.target
```

`Persistent=true` runs a backup that was missed while the machine was off. Then start the timer:

```sh norun
sudo systemctl enable --now ledge-backup.timer
```

## Run a backup now

Give a note of your own `profile: backup` in its frontmatter and put the same command in a block there:

```sh norun
restic backup --files-from <(ledge-server backup-paths) --exclude-file <(ledge-server backup-paths --exclude)
```

The block runs on the server, so the note is a button for a backup of the machine it lives on. Use it before an upgrade, or to check the timer's work. It is not a substitute for the timer.

Restore one note without restoring the machine, from a shell that has the same profile loaded:

```sh norun
restic restore latest --target /tmp/restored --include '*/shipping-notes.md'
```

Three things to know before you rely on it:

- Keep `RESTIC_PASSWORD` somewhere other than this server. A restore starts on a machine that has nothing on it, and a password stored only inside the backup is a backup you cannot open.
- The backup holds secrets in plain text. Profile values are plain text and so are unlocked notes, so the tool has to encrypt. restic does. `aws s3 sync` and `rclone sync` do not, unless you configure them to.
- Locked notes and the vault travel together or not at all. `.vault.json` is inside the app home, so the printed list already does this. A hand-written list that takes the notes and leaves the vault restores notes Ledge refuses to open ([[Note Locking]]).

## What a provider snapshot does not do

Most hosts offer whole-server backups. Run both if you like: a snapshot restores a machine, and the backup above restores your notes.

| | Provider snapshot | The backup above |
| --- | --- | --- |
| Smallest thing you can restore | The whole server | One note, one version |
| Where the copy lives | The account that holds the server | Any bucket you choose |
| Moves to another host | No | Yes |

A snapshot also lives in the account that pays for the server, so a lost login or a lapsed card takes the notes and the copy together.

## Several devices on one server

A server serves every device that connects to it. Your Mac and your phone can both be on the same server at once, reading the same notes and running commands ([[Ledge on Your Phone]]).

Each device keeps its own tabs and panes. The server files them under the device that arranged them, so a phone does not open into a Mac's three-pane layout.

A second Ledge window counts as another device here. Point two windows at one server and each is listed in the other's connection bar, and a note's terminal has one owner between them, exactly as a Mac and a phone would.

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

A machine that has been asleep is asked about at once rather than after the usual twenty seconds, because a lid that opens usually opens onto a connection that ended hours ago.

A drop the network does not announce takes twenty to twenty-five seconds to notice. A connection that closes tells Ledge straight away. A network that simply goes away, such as wifi dropping or a laptop moving between networks, sends nothing at all, so Ledge asks the server every 5 seconds and treats three unanswered asks as a lost wire. The same goes for a server that stops answering while the network is fine. The bar still reads as connected until then, and anything you send in that window is held and sent again once the connection is back.

Anything running keeps running. Shells belong to the server and survive a wire dropping, so a build carries on while you are on a train and its output is waiting when you come back.

An open terminal stops taking what you type once the bar reads "disconnected", and covers itself with a notice saying so. Nothing typed at a machine Ledge cannot reach would get there, and a terminal that does not echo looks exactly like one waiting on a slow command, so the notice is what tells the two apart. The last output stays readable underneath it and can still be selected and copied. While the bar reads "reconnecting…" the terminal takes your typing as usual, and it lands when the connection does.

A terminal that was open the whole time fills in its own gap. Ledge asks that shell for its history the moment the connection is back and redraws it, so what printed while you were away is on screen with everything that came before it. The last 256 KB is what a shell keeps, on a reconnect exactly as on any other reattach.

Two other things can have become of that shell while you were away, and the terminal tells you which. Another device may have taken it, which reads the same as it always does: the notice, and the Take This Shell button. Or it may have ended, and the terminal closes rather than reopening on a fresh prompt with none of your work in it.

A block's output panel is the exception, and only across a restart. The panel lives in the page rather than on the server, so a wire that drops and comes back finds it still there with the run still going.

Once the bar reads "disconnected" that panel reads "Disconnected" too, rather than "Running". Ledge cannot see the machine, so it neither claims the block finished nor claims it is still going. The output that already arrived stays on screen and the word says why no more is appearing. When the connection returns the panel goes back to "Running" if the server still has that run, and finishes if it does not.

The block underneath it will not run again meanwhile. It may still be executing over there, and a second copy of a deploy is worse than a wait.

That panel stops taking what you type at it too. A block that was waiting on a password is the case worth getting right: the answer would go nowhere, and nothing would say it had. The line beside the header that reads "typing here" reads "not connected" instead. The caret stays in the panel rather than jumping back to the note, because the connection may be back in seconds, and the panel takes your typing again the moment it is.

What the block printed while you were away arrives when the connection does. The server holds it for you, in the order the shell said it, and the panel adds it to what was already there. A block that finished while you were away comes back finished, with its exit status, rather than closed out blank.

Two limits on that. The last 256 KB is what is held, so a very long outage over a very chatty build loses the middle and keeps the end. And the twenty seconds or so before Ledge notices the connection has gone are lost too: nothing can be held back until something knows there is a reason to.

You cannot start a run at all once the bar reads "disconnected". Every block's Run and terminal buttons go gray, hovering one names the machine that cannot be reached, and ⌘↩ answers with the same sentence. While the bar still reads "reconnecting…" they stay live, and a block run there really does run: the request waits for the connection like any other and goes as soon as it is back. This is the only thing Ledge refuses outright instead of trying and telling you what came back. A run is the one request with no answer to report: Ledge sends it and then listens for output, so a block sent to a machine that is not there would open a panel reading "Running" that nothing would ever correct.

A Ledge that has relaunched has no panel, and no way to show that run or stop it. So blocks left running on a server are stopped the next time Ledge connects to it, which includes switching to another connection and back. A terminal is not affected, because reattaching finds its shell where you left it.

This reaches only the blocks that device started. A server can be carrying runs for more than one of your devices, and a phone connecting does not stop what your Mac left running.

A save that was in flight when the wire dropped is retried once the connection is back, and applied once, even if the first attempt had already landed.

Notes that changed on the server while you were away are re-read as soon as the connection is back. Another device saving, a checkout in a terminal, an agent writing to a note: none of that reaches you while the wire is down, so Ledge asks every open workspace for its list again and re-reads the notes you have open. A note somebody added appears in the sidebar, and an open note you had not touched pours in the newer text.

A note you were editing across a brief drop keeps exactly what you typed. If that note also changed on the server, the two are settled on your next save the same way any two devices editing at once are (see above): your version is saved, and the one it displaced goes to the workspace trash with a notice naming the note.

After a real outage it goes the other way, and it is worth knowing which way before it happens. Once the bar has read "disconnected", Ledge stops trying to save and holds what you type in the tab, with a red dot on it saying so. When the connection comes back, a note nobody else touched is simply saved. A note that did change on the server takes the server's version, and what you had typed goes to that workspace trash with a notice naming the note.

The reason it flips is that the argument for keeping your version is that you are the one at the keyboard, which is exactly what an outage undoes: a laptop shut in a bag for a day, while the same note is edited from a phone, has the older text and the emptier claim to it. Neither version is thrown away either way, and restoring from the trash puts the copy next to the live note rather than over it, so you can merge the two yourself.

Locked notes relock while you are away, and Ledge catches up the moment the connection is back. The vault belongs to the server and shuts itself after 15 minutes with nothing to do ([[Note Locking]]), and a connection that is down is 15 quiet minutes. So a locked note you had open goes back to its placeholder on the reconnect, exactly as if you had pressed ⌘L, and unlocking again pours it back. Unlocking on another machine reaches you the same way: a note sitting behind its placeholder opens as soon as the connection is back.

Anything you typed into a locked note during the outage goes with it. That text could not have reached the disk either way, because writing a locked note needs the vault open, so copy it somewhere else before you reconnect if you want to keep it.

If the re-dialling runs out, the bar reads "disconnected" and Ledge stops accepting work for a machine it cannot reach. It keeps trying underneath, every thirty seconds, for as long as the window is open, so a laptop that wakes up on a working network reconnects itself with nothing for you to do. Clicking the bar tries immediately instead of waiting for the next attempt.

Ledge also tries the moment your machine wakes and the moment your operating system says the network is back, which are the two times a connection that has been failing for hours suddenly works.

Reconnecting to a server that has restarted meanwhile works too, and it is what usually happens after a long sleep: a server with nobody connected shuts itself down after a minute, and connecting starts a fresh one. Your notes are on its disk and are all there. What does not survive is anything that was only in the old server's memory, so shells and running blocks are gone, and the terminal and any output panels say so rather than showing you a prompt that is not there.

A short absence keeps them. Ledge asks every server it connects to hold its shells for five minutes after the connection ends, which covers a lift, a lid closed for a meeting, or a walk between buildings.

Ledge also stops when the server hangs up on purpose rather than the wire failing, and hovering the bar says why. One reason is the server shutting down. The other is a second copy of Ledge on this same device connecting to it: the server keeps the newer connection and tells the older one, which stops instead of the two taking the server off each other in a loop. Another device connecting is not a reason (see above).

## Limits

- One connection per window. Search, tags, backlinks, and wikilinks all stay within the machine that window is on. Open a second window for a second machine (see above).
- One device at a time in a note's terminal. Everything else on a server is shared by every device connected to it (see above).
- No moving a note between servers from inside the app. Use `rsync` or `git`; the notes are ordinary files ([[Tutorial: Keep Notes Synced]]).
- No offline editing. The server has to be reachable to open a note.
