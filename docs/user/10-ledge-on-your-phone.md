# Ledge on Your Phone

Ledge runs on an iPhone or iPad as a window onto a server. The phone holds no notes: it reaches a server over ssh, the way a Mac does in [[Keep Notes on a Remote Server]], and shows you what is there.

Get Ledge for iPhone from the App Store. It runs on iOS and iPadOS 17 or newer, and it needs a server to connect to before it shows anything.

A server that already serves your Mac needs nothing more. A machine without one needs the server installed first, as "Install the server" on that page describes, and the phone shows the same commands ("Set up a server" below).

## The first screen

The first launch opens on "Connect to your Ledge server", which offers three ways to add a server:

| Control | Use it when |
| --- | --- |
| Scan a pairing code | The server can show a code with `ledge pair`, or a Mac that already has the server can show one ("Pair with a code") |
| I don't have a server yet | You have a Mac or Linux machine with ssh, and Ledge is not installed on it ("Set up a server") |
| Add an existing server | Ledge is already installed on the server, and you would rather type its account and address ("Pair by address") |

## Pair with a code

A pairing code names a server and its host keys, so the phone can add it without anyone typing an address or comparing a fingerprint. On the server, run:

```sh norun
ledge pair
```

On a terminal, it first lists every address the machine has, with a note on which devices reach each one: its tailnet name and address, the address your ssh session reached, its public address when it runs in a cloud, its other network addresses, and its name. Type a number to pick one, or an address of your own as `host` or `host:port`, or press Return for the first. It then prints the code as a QR code, then the account, host, port, and host keys it holds, then the same code as a link. Without a terminal, it takes the first address and lists the rest under the code, and `--host` names one on the next run. `ledge pair --help` lists the other flags.

A Mac that already has the server in its list can show the same code without a terminal: the QR code icon on the server's row in Notes On… ("Show a pairing code for a server" on [[Keep Notes on a Remote Server]]). The same link pastes into the Mac app's Add Server form ("Add a server from a pairing code" on that page).

The code names one address, and the reader connects to exactly that, so pick the one your other devices reach from where they will be. A tailnet name works from anywhere a device is on the tailnet. A home network address works from a device on that network. A cloud machine's public address works from anywhere, when its sshd is reachable from outside. A machine behind a router's port forward has an outside address no source knows: type it at the menu with its port, or give them with `--host` and `--port`. A Mac's code names the address the Mac dials, with the same reach.

On the phone, tap Scan a pairing code on the first screen, or in Add Server… inside the app ("More than one server" below), and point the camera at the QR code. Scan it from Ledge rather than the Camera app, which opens the code in Safari. Ledge shows what the code names and connects only when you tap Connect. Choose how to sign in first, the same way as in "Pair by address": with a key, whose line still has to be in the server's `authorized_keys`, or with a password. Ledge signs in only if the server offers one of the host keys in the code, so there is no fingerprint to check by eye.

The code holds no password and no key. Someone who photographs it learns where the server is and which account to try, and nothing that signs them in.

Opening a `ledge://pair` link on the phone shows the same screen, with a warning. A link can come from anyone, including someone running a server that only looks like yours, so connect only if the link came from your own server.

A code never replaces a host key the phone already has. When Ledge has a different key pinned for the same address, it refuses the code and keeps that key. If the server's key really changed, connect to it from the Servers list, where Ledge shows you the new key to check.

## Set up a server

I don't have a server yet opens "Set up a server", which shows the commands that make a machine a Ledge server. Choose Linux or Mac above them. On Linux:

```sh norun
curl -fsSL https://bun.sh/install | sudo BUN_INSTALL=/usr/local bash
sudo BUN_INSTALL=/usr/local bun add -g ledge-server
ledge pair
```

On a Mac:

```sh norun
curl -fsSL https://bun.sh/install | bash
echo 'export PATH="$HOME/.bun/bin:$PATH"' >> ~/.zshenv
source ~/.zshenv
bun add -g ledge-server
ledge pair
```

Run them in a terminal on that machine, signed in as the account the phone should use. They install Bun and the server where a command run over ssh can find them, which on Linux needs `sudo` and on a Mac needs the `~/.zshenv` line instead. The last command prints a pairing code for that account, and Scan the pairing code on the same screen reads it.

Copy commands puts them on the phone's pasteboard. Share commands hands them to AirDrop, Messages, or any app that can carry them to a computer with a terminal open on that machine.

On a Mac, turn on Remote Login first, in System Settings under General, then Sharing. A Mac that runs the Ledge app needs only "Install Shell Command (ledge)" from the app's command palette in place of the first four commands: it puts `ledge` where the phone's ssh looks, pointing at the app's own copy, so the phone sees the same notes the app shows. `ledge pair` in a new terminal then prints the code.

The machine needs sshd running and an address the phone can reach. [[Keep Notes on a Remote Server]] has the details of the install, including a machine that already has Bun, and [[Tutorial: Set Up a Ledge Server]] walks through a fresh VPS.

If you already have a server, Add an existing server at the bottom of the screen opens the form from "Pair by address", and Back from there returns to the first screen.

## Pair by address

Add an existing server opens "Pair with a server", a form with three parts. The same form opens from Add a server in the Servers list, with Scan a pairing code at its top.

The first part is the machine: `user@host`, and a port when sshd is not on 22. A phone reads no `~/.ssh/config`, so write the address out.

The second is how to sign in. With A key, the default, the form shows a key line. On its first launch the phone makes a key of its own in the Secure Enclave, and that key never leaves the phone: there is no file to copy in or out. What leaves is the public half, as one line for the server's `~/.ssh/authorized_keys`:

```
restrict,command="PATH=$HOME/.ledge/.server/bin:$PATH ledge serve" ecdsa-sha2-nistp256 AAAA... ledge-iphone-3f2a91c0
```

Copy line puts it on the phone's pasteboard. Share line hands it to AirDrop, Messages, or any app that can carry it to a machine with a shell on the server, which is where the pasteboard on a phone falls short. Add it to `~/.ssh/authorized_keys` there. The comment at the end names the phone, so the line is easy to find again when you want to revoke it.

The line arrives already restricted, in the way "Restrict the key to Ledge" on [[Keep Notes on a Remote Server]] describes: the phone's key can speak Ledge's protocol and nothing else. It looks for `ledge` in `~/.ledge/.server/bin` first and then on the PATH an incoming ssh gets, so a server installed in either place starts ("Check that ssh can find the server" on the same page).

The third is Connect. The phone dials the server, shows its host key fingerprint, and asks "Is this the server?" alongside the command that prints the same fingerprint on the server. Trust pins the key, and a server that later presents a different one is refused, the same as on a Mac.

Ledge adds the server only once `ledge serve` answers there. On a machine where ssh cannot find it, Connect says "Ledge's server is not installed" and adds nothing. Install it, then tap Connect again.

## Sign in with a password instead

Choose "A password" under Sign in with and type the password for that account. The phone keeps it in its own keychain, and no key line has to be installed.

The trade-off is the one described on [[Keep Notes on a Remote Server]]: a password reaches a fresh machine today, and a key is the better long-term answer. A server with `PasswordAuthentication no` refuses it.

## When the phone cannot reach its server

A server slow to answer shows "Connecting to user@host…" and, after a few seconds, a Choose a Different Server button.

A server that cannot be reached shows "Ledge could not reach a server." with the reason, then Try again and Choose a server. Try again comes first because the usual cause is the phone having moved networks, not the server having moved. Choose a server opens the Servers list, where you pick another one or add one.

A host key that has changed, or a key or password the server no longer accepts, lands you back on the pairing form with the address filled in. Retrying cannot fix either, so the pin is dropped and you compare the fingerprint again.

Removing the last server returns the phone to the first screen. Deleting the app deletes its key with it, so a reinstalled phone is a new device to every server and needs its line installed again.

## More than one server

Inside the app the connection bar works as on a Mac: tap it to add, edit, remove, or switch servers, with the same fingerprint step ([[Keep Notes on a Remote Server]]). The form shows the phone's key line where a Mac's shows a key path, with Share Line beside Copy Line.

Add Server… starts with Scan a pairing code, where a Mac's form has a field for the pasted link. It opens the camera, then the same "Pair with a server" screen as the first launch, and the app reopens on the new server once you tap Connect there. Cancel returns you to the form, where you can type the address instead. Editing a server has no scan: a code never replaces a host key the phone already has.

A phone and a Mac can be on one server at once. Each keeps its own tabs, and a note's terminal has one owner between them.

## What a phone does

| On a phone | Not on a phone |
| --- | --- |
| Reading, editing, and creating notes, with live preview | The terminal drawer |
| Quick open, full-text search, tags, backlinks, the outline | |
| Daily notes, templates, wikilinks | |
| Attaching a folder on the server as a workspace, by typing its path | |
| Images, added from the photo library, the camera, or Files | |
| Running a block inline, with the host picker and the confirmation | |
| Editing a note's profile | |
| Unlocking locked notes | |
| The trash | |
| Switching workspaces and servers | |

The pages for those features say how each works on a touch screen: Run on every block, the Code Block button, and the control keys above the keyboard in [[Running Code]], adding a picture in [[Images]], the mode chips under the search field in [[Finding Things]], and splits in [[Panes and Tabs]].

Tapping through the tree reuses one tab rather than filling the strip, since a note you tap opens as an italic preview ([[Panes and Tabs]]). A long press on the tab holds Keep Tab Open, which is what makes it stay, and so does typing in the note. It matters more here than on a Mac: there is no ⌘W, so a strip that filled up would take a long press and a menu item per tab to empty.

A block keeps running on the server while the app is in the background, and what it printed is waiting when you come back. A program that needs a whole terminal belongs in a Mac's drawer on the same server.

Unlocking a locked note asks for the passphrase every time. The phone stores none of it, and Face ID does not stand in for it. The relock timer is the server's, so a phone put away for an hour finds its locked notes closed again ([[Note Locking]]).

The manual a phone shows is the connected server's copy, so it describes the version of Ledge that server runs.
